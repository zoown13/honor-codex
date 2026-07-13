import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

export type HttpEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type HttpResult = APIGatewayProxyStructuredResultV2;

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

export function parseBody(event: HttpEvent): Record<string, unknown> {
  if (!event.body) throw new HttpError(400, "요청 본문이 필요합니다.");
  const encoded = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(encoded, "utf8") > 32 * 1024) throw new HttpError(413, "요청 본문이 너무 큽니다.");
  try {
    const value = JSON.parse(encoded) as unknown;
    if (!isRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new HttpError(400, "올바른 JSON 객체가 아닙니다.");
  }
}

export function identity(event: HttpEvent): { userId: string; email: string; groups: string[] } {
  const claims = event.requestContext.authorizer.jwt.claims;
  const userId = stringClaim(claims.sub);
  const email = stringClaim(claims.email);
  if (!userId || !email) throw new HttpError(401, "인증 정보가 없습니다.");
  const rawGroups = claims["cognito:groups"];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.map(String)
    : typeof rawGroups === "string" ? rawGroups.replace(/^\[|\]$/g, "").split(",").map((v) => v.trim()).filter(Boolean) : [];
  return { userId, email: email.toLocaleLowerCase("en-US"), groups };
}

export function requireAdmin(event: HttpEvent, env: NodeJS.ProcessEnv = process.env): { userId: string; email: string } {
  const user = identity(event);
  const allowed = (env.ADMIN_EMAILS ?? "").split(",").map((v) => v.trim().toLocaleLowerCase("en-US")).filter(Boolean);
  if (!user.groups.includes("ADMIN") && !allowed.includes(user.email)) throw new HttpError(403, "관리자 권한이 필요합니다.");
  return user;
}

export function withHttpErrors(fn: () => Promise<HttpResult>): Promise<HttpResult> {
  return fn().catch((error: unknown) => {
    if (error instanceof HttpError) return json(error.statusCode, { error: error.message });
    console.error("Unhandled request error", error);
    return json(500, { error: "요청을 처리하지 못했습니다." });
  });
}

export function method(event: HttpEvent): string {
  return event.requestContext.http.method.toUpperCase();
}

export function stringField(record: Record<string, unknown>, key: string, max = 2048): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `${key} 값이 올바르지 않습니다.`);
  return value.trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
