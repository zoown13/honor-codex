import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { InitiateAuthCommandOutput, RespondToAuthChallengeCommandOutput } from "@aws-sdk/client-cognito-identity-provider";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import { HttpError, json, parseBody, stringField, withHttpErrors } from "../shared/http.js";
import { required } from "../shared/runtime.js";

export interface OtpStartResult {
  session: string;
  destinationHint: string;
}

export interface OtpVerifyResult {
  accessToken: string;
  idToken: string;
  userId: string;
  email: string;
  isAdmin: boolean;
}

export interface OtpProvider {
  start(email: string, clientId: string, userPoolId: string, isAdmin: boolean): Promise<OtpStartResult>;
  verify(email: string, code: string, session: string, clientId: string): Promise<Omit<OtpVerifyResult, "isAdmin">>;
}

export class CognitoOtpProvider implements OtpProvider {
  constructor(private readonly client = new CognitoIdentityProviderClient({})) {}

  async start(email: string, clientId: string, userPoolId: string, isAdmin: boolean): Promise<OtpStartResult> {
    let result: InitiateAuthCommandOutput | undefined;
    try {
      result = await this.#initiate(email, clientId);
    } catch (error) {
      if (errorName(error) !== "UserNotFoundException") throw error;
      await this.client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
        ],
      }));
    }

    if (isAdmin) {
      await this.client.send(new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: email,
        GroupName: "ADMIN",
      }));
    }
    result ??= await this.#initiate(email, clientId);

    if (result.ChallengeName !== "EMAIL_OTP" || !result.Session) {
      throw new Error(`Unexpected Cognito challenge: ${result.ChallengeName ?? "none"}`);
    }
    const destination = result.ChallengeParameters?.CODE_DELIVERY_DESTINATION;
    return { session: result.Session, destinationHint: destination || maskEmail(email) };
  }

  async #initiate(email: string, clientId: string): Promise<InitiateAuthCommandOutput> {
    return this.client.send(new InitiateAuthCommand({
      AuthFlow: "USER_AUTH",
      ClientId: clientId,
      AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" },
    }));
  }

  async verify(email: string, code: string, session: string, clientId: string): Promise<Omit<OtpVerifyResult, "isAdmin">> {
    const result: RespondToAuthChallengeCommandOutput = await this.client.send(new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "EMAIL_OTP",
      Session: session,
      ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code },
    }));
    const accessToken = result.AuthenticationResult?.AccessToken;
    const idToken = result.AuthenticationResult?.IdToken;
    if (!accessToken || !idToken) throw new Error("Cognito did not return complete tokens");
    const user = await this.client.send(new GetUserCommand({ AccessToken: accessToken }));
    const attributes = Object.fromEntries((user.UserAttributes ?? []).flatMap((attribute) =>
      attribute.Name && attribute.Value ? [[attribute.Name, attribute.Value]] : []));
    return {
      accessToken,
      idToken,
      userId: attributes.sub || user.Username || email,
      email: (attributes.email || email).toLocaleLowerCase("en-US"),
    };
  }
}

export function createAuthOtpHandler(
  provider: OtpProvider,
  env: NodeJS.ProcessEnv = process.env,
): (event: HttpEvent) => Promise<HttpResult> {
  return (event) => withHttpErrors(async () => {
    if (event.requestContext.http.method !== "POST") throw new HttpError(405, "허용되지 않은 요청입니다.");
    const body = parseBody(event);
    const email = normalizeEmail(stringField(body, "email", 320));
    assertAllowedEmail(email, env);
    const clientId = required(env, "USER_POOL_CLIENT_ID");
    const isAdmin = emailList(env.ADMIN_EMAILS).includes(email);

    try {
      if (event.rawPath.endsWith("/start")) {
        const result = await provider.start(email, clientId, required(env, "USER_POOL_ID"), isAdmin);
        return json(200, { challengeId: result.session, destinationHint: result.destinationHint });
      }
      if (event.rawPath.endsWith("/verify")) {
        const code = stringField(body, "code", 12);
        if (!/^\d{6,8}$/.test(code)) throw new HttpError(400, "인증번호 형식이 올바르지 않습니다.");
        const challengeId = stringField(body, "challengeId", 8192);
        const result = await provider.verify(email, code, challengeId, clientId);
        return json(200, { ...result, isAdmin });
      }
      throw new HttpError(404, "인증 경로를 찾을 수 없습니다.");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const name = errorName(error);
      if (name === "TooManyRequestsException" || name === "LimitExceededException") {
        throw new HttpError(429, "잠시 후 다시 시도해 주세요.");
      }
      if (["NotAuthorizedException", "CodeMismatchException", "ExpiredCodeException"].includes(name)) {
        throw new HttpError(400, "인증번호가 올바르지 않거나 만료되었습니다.");
      }
      throw error;
    }
  });
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createAuthOtpHandler(new CognitoOtpProvider())(event);

function normalizeEmail(value: string): string {
  const email = value.toLocaleLowerCase("en-US");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "이메일 형식이 올바르지 않습니다.");
  return email;
}

function assertAllowedEmail(email: string, env: NodeJS.ProcessEnv): void {
  const allowed = emailList(env.PILOT_ALLOWED_EMAILS);
  if (!allowed.includes(email)) throw new HttpError(403, "파일럿 초대 대상 이메일이 아닙니다.");
}

function emailList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim().toLocaleLowerCase("en-US")).filter(Boolean);
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: string }).name) : "";
}
