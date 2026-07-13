import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { sha256Hex } from "@honor/core";
import type { PushSubscriptionRecord } from "@honor/core";
import type { AppRepository, Clock } from "../shared/contracts.js";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import {
  HttpError,
  identity,
  isRecord,
  method,
  parseBody,
  stringField,
  withHttpErrors,
} from "../shared/http.js";
import { repository, required, systemClock } from "../shared/runtime.js";

export interface AccountDeleter {
  delete(username: string): Promise<void>;
}

export class CognitoAccountDeleter implements AccountDeleter {
  constructor(
    private readonly userPoolId: string,
    private readonly client = new CognitoIdentityProviderClient({}),
  ) {}

  async delete(username: string): Promise<void> {
    await this.client.send(new AdminDeleteUserCommand({
      UserPoolId: this.userPoolId,
      Username: username,
    }));
  }
}

export function createPushSubscriptionsHandler(deps: {
  repository: AppRepository;
  accountDeleter: AccountDeleter;
  clock?: Clock;
}) {
  return (event: HttpEvent): Promise<HttpResult> => withHttpErrors(async () => {
    const user = identity(event);
    if (event.rawPath.endsWith("/me/account") && method(event) === "DELETE") {
      await deps.repository.deleteUserData(user.userId);
      await deps.accountDeleter.delete(user.email);
      return { statusCode: 204, headers: { "cache-control": "no-store" } };
    }

    if (method(event) === "POST") {
      const body = parseBody(event);
      const endpoint = stringField(body, "endpoint", 4096);
      if (!endpoint.startsWith("https://")) throw new HttpError(400, "푸시 endpoint는 HTTPS여야 합니다.");
      if (!isRecord(body.keys)) throw new HttpError(400, "푸시 암호화 키가 필요합니다.");
      const p256dh = stringField(body.keys, "p256dh", 512);
      const auth = stringField(body.keys, "auth", 128);
      if (!isBase64Url(p256dh) || !isBase64Url(auth)) throw new HttpError(400, "푸시 암호화 키 형식이 올바르지 않습니다.");
      const now = (deps.clock ?? systemClock).now().toISOString();
      const value: PushSubscriptionRecord = {
        id: sha256Hex(endpoint).slice(0, 24),
        userId: user.userId,
        endpoint,
        keys: { p256dh, auth },
        createdAt: now,
        updatedAt: now,
      };
      await deps.repository.putPushSubscription(value);
      return { statusCode: 204, headers: { "cache-control": "no-store" } };
    }

    if (method(event) === "DELETE") {
      const body = event.body ? parseBody(event) : {};
      const id = event.pathParameters?.id || event.queryStringParameters?.pushId
        || (typeof body.id === "string" ? body.id : undefined)
        || (typeof body.endpoint === "string" ? sha256Hex(body.endpoint).slice(0, 24) : undefined);
      if (!id) throw new HttpError(400, "pushId 또는 endpoint가 필요합니다.");
      const deleted = await deps.repository.deletePushSubscription(user.userId, id);
      if (!deleted) throw new HttpError(404, "푸시 구독을 찾을 수 없습니다.");
      return { statusCode: 204, headers: { "cache-control": "no-store" } };
    }

    throw new HttpError(405, "허용되지 않은 요청입니다.");
  });
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createPushSubscriptionsHandler({
    repository: repository(),
    accountDeleter: new CognitoAccountDeleter(required(process.env, "USER_POOL_ID")),
  })(event);

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+={0,2}$/.test(value);
}
