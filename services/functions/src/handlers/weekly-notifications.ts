import { sha256Hex } from "@honor/core";
import type { Benefit, BenefitChange, NotificationChannel } from "@honor/core";
import type { ScheduledEvent } from "aws-lambda";
import type {
  AppRepository,
  Clock,
  Mailer,
  PushSender,
  StoredSubscription,
} from "../shared/contracts.js";
import { mailer, pushSender, repository, systemClock } from "../shared/runtime.js";

export interface ImmediateNotificationEvent {
  mode: "IMMEDIATE";
  changeIds: string[];
}

export type NotificationEvent = ScheduledEvent<unknown> | ImmediateNotificationEvent;

export interface WeeklyNotificationDeps {
  repository: AppRepository;
  mailer: Mailer;
  pushSender?: PushSender;
  clock?: Clock;
}

export function createWeeklyNotificationHandler(
  deps: WeeklyNotificationDeps,
  env: NodeJS.ProcessEnv = process.env,
) {
  return async (event: NotificationEvent): Promise<unknown> => {
    const nowDate = (deps.clock ?? systemClock).now();
    if (isImmediateEvent(event)) return sendImmediate(deps, event, env, nowDate);
    return sendWeekly(deps, env, nowDate);
  };
}

async function sendWeekly(
  deps: WeeklyNotificationDeps,
  env: NodeJS.ProcessEnv,
  nowDate: Date,
): Promise<Record<string, unknown>> {
  const now = nowDate.toISOString();
  const cutoff = new Date(nowDate.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const window = seoulIsoWeek(nowDate);
  const changes = (await deps.repository.listChanges(["PUBLISHED"]))
    .filter((change) => change.publishedAt !== undefined && change.publishedAt >= cutoff);
  const subscriptions = (await deps.repository.listAllSubscriptions())
    .filter((subscription) => subscription.cadence === "WEEKLY");
  const byUser = groupSubscriptions(subscriptions);

  let sent = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const [userId, userSubscriptions] of byUser) {
    const emailChanges = changesForChannel(changes, userSubscriptions, "EMAIL");
    if (emailChanges.length) {
      const email = userSubscriptions[0]?.recipientEmail;
      if (email) {
        const key = deliveryKey(userId, window, "EMAIL", emailChanges);
        if (await reserve(deps.repository, userId, key, "EMAIL", now)) {
          try {
            await deps.mailer.send(emailMessage(email, emailChanges, env));
            await deps.repository.finishDelivery(userId, key, "SENT", now);
            sent += 1;
          } catch (error) {
            const message = errorMessage(error);
            await deps.repository.finishDelivery(userId, key, "FAILED", now, message);
            failures.push(`EMAIL:${userId}:${message}`);
          }
        } else skipped += 1;
      }
    }

    const pushChanges = changesForChannel(changes, userSubscriptions, "WEB_PUSH");
    if (pushChanges.length) {
      if (!deps.pushSender) {
        skipped += 1;
      } else {
        const pushes = await deps.repository.listPushSubscriptions(userId);
        for (const push of pushes) {
          const key = deliveryKey(userId, window, `WEB_PUSH:${push.id}`, pushChanges);
          if (!await reserve(deps.repository, userId, key, "WEB_PUSH", now)) { skipped += 1; continue; }
          try {
            await deps.pushSender.send({
              subscription: push,
              title: "병역명문가 혜택 변경 알림",
              body: `${pushChanges.length}건의 팔로우 혜택이 변경되었습니다.`,
              url: appUrl(env),
            });
            await deps.repository.finishDelivery(userId, key, "SENT", now);
            sent += 1;
          } catch (error) {
            const message = errorMessage(error);
            await deps.repository.finishDelivery(userId, key, "FAILED", now, message);
            failures.push(`WEB_PUSH:${userId}:${message}`);
          }
        }
      }
    }
  }

  if (failures.length) throw new Error(`Notification delivery failed (${failures.length}): ${failures.join("; ")}`);
  return { mode: "WEEKLY", window, publishedChanges: changes.length, users: byUser.size, sent, skipped };
}

async function sendImmediate(
  deps: WeeklyNotificationDeps,
  event: ImmediateNotificationEvent,
  env: NodeJS.ProcessEnv,
  nowDate: Date,
): Promise<Record<string, unknown>> {
  const ids = [...new Set(event.changeIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128))];
  if (!ids.length || ids.length > 5_000) throw new Error("Immediate notification changeIds are invalid");
  const subscriptions = (await deps.repository.listAllSubscriptions()).filter((subscription) =>
    subscription.cadence === "IMMEDIATE"
    && subscription.targetType === "BENEFIT"
    && subscription.channels.includes("WEB_PUSH"));
  const byUser = groupSubscriptions(subscriptions);
  if (!byUser.size) return { mode: "IMMEDIATE", changes: ids.length, users: 0, sent: 0, skipped: 0 };
  if (!deps.pushSender) return { mode: "IMMEDIATE", changes: ids.length, users: byUser.size, sent: 0, skipped: byUser.size };

  const idSet = new Set(ids);
  const changes = uniqueChanges((await deps.repository.listChanges()).filter((change) => idSet.has(change.id)));
  const now = nowDate.toISOString();
  let sent = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const [userId, userSubscriptions] of byUser) {
    const matched = uniqueChanges(changes.filter((change) =>
      userSubscriptions.some((subscription) => matches(subscription, change))));
    if (!matched.length) continue;
    const pushes = await deps.repository.listPushSubscriptions(userId);
    for (const change of matched) {
      const benefit = change.after ?? change.before;
      if (!benefit) continue;
      for (const push of pushes) {
        const key = deliveryKey(userId, "IMMEDIATE", `WEB_PUSH:${push.id}`, [change]);
        if (!await reserve(deps.repository, userId, key, "WEB_PUSH", now)) { skipped += 1; continue; }
        try {
          await deps.pushSender.send({
            subscription: push,
            title: "병역명문가 혜택 변경 알림",
            body: `${benefit.title} 혜택이 변경되었습니다.`,
            url: appUrl(env),
          });
          await deps.repository.finishDelivery(userId, key, "SENT", now);
          sent += 1;
        } catch (error) {
          const message = errorMessage(error);
          await deps.repository.finishDelivery(userId, key, "FAILED", now, message);
          failures.push(`WEB_PUSH:${userId}:${change.id}:${message}`);
        }
      }
    }
  }

  if (failures.length) throw new Error(`Immediate notification failed (${failures.length}): ${failures.join("; ")}`);
  return { mode: "IMMEDIATE", changes: changes.length, users: byUser.size, sent, skipped };
}

export const handler = (event: NotificationEvent): Promise<unknown> => {
  const sender = pushSender();
  return createWeeklyNotificationHandler({
    repository: repository(),
    mailer: mailer(),
    ...(sender ? { pushSender: sender } : {}),
  })(event);
};

function isImmediateEvent(event: NotificationEvent): event is ImmediateNotificationEvent {
  return "mode" in event && event.mode === "IMMEDIATE" && Array.isArray(event.changeIds);
}

function groupSubscriptions(subscriptions: readonly StoredSubscription[]): Map<string, StoredSubscription[]> {
  const byUser = new Map<string, StoredSubscription[]>();
  for (const subscription of subscriptions) {
    const current = byUser.get(subscription.userId) ?? [];
    current.push(subscription);
    byUser.set(subscription.userId, current);
  }
  return byUser;
}

function changesForChannel(
  changes: readonly BenefitChange[],
  subscriptions: readonly StoredSubscription[],
  channel: NotificationChannel,
): BenefitChange[] {
  return uniqueChanges(changes.filter((change) => subscriptions.some((subscription) =>
    subscription.channels.includes(channel) && matches(subscription, change))));
}

function matches(subscription: StoredSubscription, change: BenefitChange): boolean {
  const benefit: Benefit | undefined = change.after ?? change.before;
  if (!benefit) return false;
  if (subscription.targetType === "BENEFIT") return benefit.id === subscription.targetId;
  if (subscription.targetType === "CATEGORY") return benefit.category === subscription.targetId;
  return benefit.regionCodes.includes(subscription.targetId);
}

function uniqueChanges(changes: readonly BenefitChange[]): BenefitChange[] {
  return [...new Map(changes.map((change) => [change.id, change])).values()]
    .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt));
}

function deliveryKey(userId: string, window: string, channel: string, changes: readonly BenefitChange[]): string {
  return sha256Hex(`${userId}\0${window}\0${channel}\0${changes.map((change) => change.id).sort().join(",")}`);
}

function reserve(
  repository: AppRepository,
  userId: string,
  idempotencyKey: string,
  channel: NotificationChannel,
  at: string,
): Promise<boolean> {
  return repository.reserveDelivery({
    userId, idempotencyKey, channel, status: "PENDING", createdAt: at, updatedAt: at,
  });
}

function emailMessage(to: string, changes: readonly BenefitChange[], env: NodeJS.ProcessEnv) {
  const lines = changes.map((change) => {
    const benefit = change.after ?? change.before;
    return `- ${benefit?.title ?? change.benefitId}: ${change.action} (${change.changedFields.join(", ")})`;
  });
  const text = [
    "팔로우한 병역명문가 혜택의 최근 변경사항입니다.",
    "", ...lines, "", `확인: ${appUrl(env)}`,
    "", "이 서비스는 병무청 공식 서비스가 아닌 독립 정보서비스입니다.",
  ].join("\n");
  return {
    to,
    subject: `[병역명문가 혜택찾기] 이번 주 변경 ${changes.length}건`,
    text,
    html: `<p>팔로우한 혜택의 최근 변경사항입니다.</p><ul>${changes.map((change) => {
      const benefit = change.after ?? change.before;
      return `<li>${escapeHtml(benefit?.title ?? change.benefitId)}: ${escapeHtml(change.action)}</li>`;
    }).join("")}</ul><p><a href="${escapeHtml(appUrl(env))}">혜택 확인</a></p>`,
  };
}

function appUrl(env: NodeJS.ProcessEnv): string {
  const base = (env.PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  const slug = env.PILOT_SLUG?.trim();
  return slug ? `${base}/pilot/${encodeURIComponent(slug)}` : base;
}

function seoulIsoWeek(date: Date): string {
  const seoul = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const day = (seoul.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(seoul.getUTCFullYear(), seoul.getUTCMonth(), seoul.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
