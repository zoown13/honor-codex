import { sha256Hex } from "@honor/core";
import type {
  NotificationChannel,
  Subscription,
  SubscriptionCadence,
  SubscriptionTargetType,
} from "@honor/core";
import type { AppRepository, Clock, StoredSubscription } from "../shared/contracts.js";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import {
  HttpError,
  identity,
  json,
  method,
  parseBody,
  stringField,
  withHttpErrors,
} from "../shared/http.js";
import { repository, systemClock } from "../shared/runtime.js";

const TARGET_TYPES = new Set<SubscriptionTargetType>(["BENEFIT", "REGION", "CATEGORY"]);
const CADENCES = new Set<SubscriptionCadence>(["WEEKLY", "IMMEDIATE"]);
const CHANNELS = new Set<NotificationChannel>(["EMAIL", "WEB_PUSH"]);

export function createSubscriptionsHandler(deps: { repository: AppRepository; clock?: Clock }) {
  return (event: HttpEvent): Promise<HttpResult> => withHttpErrors(async () => {
    const user = identity(event);
    if (method(event) === "GET") {
      const items = await deps.repository.listSubscriptions(user.userId);
      return json(200, { items: items.map(publicSubscription) });
    }

    if (method(event) === "PUT") {
      const body = parseBody(event);
      const targetType = enumField(body, "targetType", TARGET_TYPES);
      const targetId = stringField(body, "targetId", 256);
      const cadence = enumField(body, "cadence", CADENCES);
      const channels = channelList(body.channels);
      if (cadence === "IMMEDIATE" && targetType !== "BENEFIT") {
        throw new HttpError(400, "즉시 알림은 개별 혜택에만 설정할 수 있습니다.");
      }
      const now = (deps.clock ?? systemClock).now().toISOString();
      const id = sha256Hex(`${user.userId}\0${targetType}\0${targetId}`).slice(0, 24);
      const existing = (await deps.repository.listSubscriptions(user.userId)).find((item) => item.id === id);
      const value: StoredSubscription = {
        id,
        userId: user.userId,
        targetType,
        targetId,
        cadence,
        channels,
        recipientEmail: user.email,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await deps.repository.putSubscription(value);
      return json(existing ? 200 : 201, publicSubscription(value));
    }

    if (method(event) === "DELETE") {
      const id = event.pathParameters?.id || event.pathParameters?.subscriptionId
        || event.queryStringParameters?.subscriptionId;
      if (!id || id.length > 128) throw new HttpError(400, "subscriptionId가 필요합니다.");
      const deleted = await deps.repository.deleteSubscription(user.userId, id);
      if (!deleted) throw new HttpError(404, "팔로우를 찾을 수 없습니다.");
      return { statusCode: 204, headers: { "cache-control": "no-store" } };
    }

    throw new HttpError(405, "허용되지 않은 요청입니다.");
  });
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createSubscriptionsHandler({ repository: repository() })(event);

function enumField<T extends string>(record: Record<string, unknown>, key: string, allowed: Set<T>): T {
  const value = stringField(record, key, 64) as T;
  if (!allowed.has(value)) throw new HttpError(400, `${key} 값이 올바르지 않습니다.`);
  return value;
}

function channelList(value: unknown): NotificationChannel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new HttpError(400, "channels에는 하나 이상의 알림 채널이 필요합니다.");
  }
  const channels = [...new Set(value.map(String))] as NotificationChannel[];
  if (channels.some((channel) => !CHANNELS.has(channel))) throw new HttpError(400, "알림 채널이 올바르지 않습니다.");
  return channels;
}

function publicSubscription(value: StoredSubscription): Subscription {
  const { recipientEmail: _recipientEmail, ...subscription } = value;
  return subscription;
}
