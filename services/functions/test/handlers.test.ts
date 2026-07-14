import { describe, expect, it, vi } from "vitest";
import { normalizeMmaFacility } from "@honor/core";
import { createAdminReviewsHandler } from "../src/handlers/admin-reviews.js";
import { createAuthOtpHandler } from "../src/handlers/auth-otp.js";
import { createMmaFacilityIngestHandler } from "../src/handlers/ingest-mma-facilities.js";
import { createMmaNoticeIngestHandler } from "../src/handlers/ingest-mma-notices.js";
import { createOrdinanceIngestHandler } from "../src/handlers/ingest-ordinances.js";
import { createPushSubscriptionsHandler } from "../src/handlers/push-subscriptions.js";
import { createSubscriptionsHandler } from "../src/handlers/subscriptions.js";
import { createWeeklyNotificationHandler } from "../src/handlers/weekly-notifications.js";
import type { OtpProvider } from "../src/handlers/auth-otp.js";
import type { Mailer } from "../src/shared/contracts.js";
import { FakeRepository, FakeStorage, httpEvent, scheduleEvent } from "./fakes.js";

const fixedClock = { now: () => new Date("2026-07-12T00:00:00.000Z") };
const benefit = normalizeMmaFacility({
  mmgudgigwan_cd: "2689",
  udae_ggm: "강촌레일파크",
  udsangse_cn: "레일바이크 이용료 20% 할인",
  udjiyeok_cd: "02",
  udggeopjong_gbcd: "09",
  udae_gbcd: "02",
  wido_vl: "37.818336",
  gyeongdo_vl: "127.711765",
}, "2026-07-10T00:00:00.000Z");

describe("authenticated APIs", () => {
  it("creates deterministic subscriptions from JWT identity and never stores coordinates", async () => {
    const repo = new FakeRepository();
    const handler = createSubscriptionsHandler({ repository: repo, clock: fixedClock });
    const event = httpEvent("/v1/me/subscriptions", "PUT", {
      targetType: "BENEFIT",
      targetId: benefit.id,
      cadence: "WEEKLY",
      channels: ["EMAIL"],
      origin: { latitude: 37.5, longitude: 127 },
    });
    const first = await handler(event);
    const second = await handler(event);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(repo.subscriptions).toHaveLength(1);
    expect(repo.subscriptions[0]).not.toHaveProperty("origin");
    expect(repo.subscriptions[0]).toMatchObject({ userId: "user-1", recipientEmail: "pilot@example.com" });
  });

  it("rejects immediate region subscriptions", async () => {
    const handler = createSubscriptionsHandler({ repository: new FakeRepository(), clock: fixedClock });
    const result = await handler(httpEvent("/v1/me/subscriptions", "PUT", {
      targetType: "REGION", targetId: "02", cadence: "IMMEDIATE", channels: ["EMAIL"],
    }));
    expect(result.statusCode).toBe(400);
  });

  it("stores valid push keys and deletes all account data", async () => {
    const repo = new FakeRepository();
    const deleteAccount = vi.fn(async () => undefined);
    const handler = createPushSubscriptionsHandler({ repository: repo, accountDeleter: { delete: deleteAccount }, clock: fixedClock });
    const created = await handler(httpEvent("/v1/me/push-subscriptions", "POST", {
      endpoint: "https://push.example.test/subscription/1",
      keys: { p256dh: "Abcd_1234", auth: "Efgh_5678" },
    }));
    expect(created.statusCode).toBe(204);
    expect(repo.pushes).toHaveLength(1);
    await repo.reserveDelivery({ userId: "user-1", idempotencyKey: "old", channel: "EMAIL",
      status: "SENT", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" });
    expect(repo.deliveries.size).toBe(1);
    const deleted = await handler(httpEvent("/v1/me/account", "DELETE"));
    expect(deleted.statusCode).toBe(204);
    expect(repo.pushes).toHaveLength(0);
    expect(deleteAccount).toHaveBeenCalledWith("pilot@example.com");
    expect(repo.deliveries.size).toBe(0);
  });

  it("requires admin claims and performs a single pending review transition", async () => {
    const repo = new FakeRepository();
    repo.changes.push({
      id: "chg-1", benefitId: benefit.id, action: "UPDATE", risk: "HIGH", status: "PENDING",
      changedFields: ["summary"], before: benefit, after: { ...benefit, summary: "30% 할인" },
      detectedAt: "2026-07-11T00:00:00.000Z",
    });
    const handler = createAdminReviewsHandler({ repository: repo, clock: fixedClock }, { ADMIN_EMAILS: "pilot@example.com" });
    const event = httpEvent("/v1/admin/reviews/chg-1", "POST", { decision: "APPROVED" }, {
      pathParameters: { reviewId: "chg-1" },
    });
    expect((await handler(event)).statusCode).toBe(200);
    expect((await handler(event)).statusCode).toBe(409);
  });
});

describe("ingestion and notification safety", () => {
  it("does not fetch MMA when the explicit live gate is false", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const handler = createMmaFacilityIngestHandler({
      repository: new FakeRepository(), storage: new FakeStorage(), fetcher, clock: fixedClock,
    }, { MMA_LIVE_INGESTION_ENABLED: "false" });
    const result = await handler(scheduleEvent());
    expect(result).toMatchObject({ skipped: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a partial MMA facility response before persistence", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const body = `honorPilot(${JSON.stringify({
      success: true,
      list: [{ mmgudgigwan_cd: "1", udae_ggm: "부분 응답 시설" }]
    })});`;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    const handler = createMmaFacilityIngestHandler(
      { repository, storage, fetcher, clock: fixedClock },
      { MMA_LIVE_INGESTION_ENABLED: "true" }
    );

    await expect(handler(scheduleEvent())).rejects.toThrow(
      "MMA facility parsing returned fewer than 100 benefits"
    );
    expect(repository.changes).toHaveLength(0);
    expect(storage.snapshots).toHaveLength(0);
    expect(storage.candidates).toHaveLength(0);
  });

  it("rejects an MMA notice response that parses to no benefits before persistence", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("<html><body>maintenance</body></html>")
    );
    const handler = createMmaNoticeIngestHandler(
      { repository, storage, fetcher, clock: fixedClock },
      { MMA_LIVE_INGESTION_ENABLED: "true" }
    );

    await expect(handler(scheduleEvent())).rejects.toThrow("MMA notice parsing returned no benefits");
    expect(repository.changes).toHaveLength(0);
    expect(storage.snapshots).toHaveLength(0);
    expect(storage.candidates).toHaveLength(0);
  });

  it("rejects an empty ordinance search before persistence", async () => {
    const storage = new FakeStorage();
    const getMatchingArticles = vi.fn(async () => [] as string[]);
    const handler = createOrdinanceIngestHandler({
      repository: new FakeRepository(),
      storage,
      clock: fixedClock,
      client: {
        searchOrdinances: vi.fn(async () => []),
        getMatchingArticles
      }
    });

    await expect(handler(scheduleEvent())).rejects.toThrow(
      "law.go.kr search returned no ordinance records"
    );
    expect(getMatchingArticles).not.toHaveBeenCalled();
    expect(storage.snapshots).toHaveLength(0);
    expect(storage.candidates).toHaveLength(0);
  });

  it("stops ordinance detail enrichment before the execution safety budget expires", async () => {
    const getMatchingArticles = vi.fn(async () => [] as string[]);
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(8 * 60 * 1_000);
    const handler = createOrdinanceIngestHandler({
      repository: new FakeRepository(),
      storage: new FakeStorage(),
      clock: fixedClock,
      monotonicNow,
      client: {
        searchOrdinances: vi.fn(async () => [{
          id: "ordinance-1",
          title: "테스트 조례",
          localGovernment: "테스트시",
          url: "https://www.law.go.kr/ordinance/1",
          matchingArticles: []
        }]),
        getMatchingArticles
      }
    });

    await expect(handler(scheduleEvent())).rejects.toThrow(
      "law.go.kr ingestion exceeded its execution safety budget"
    );
    expect(getMatchingArticles).not.toHaveBeenCalled();
  });

  it("rejects more than 1,000 unique ordinances before detail enrichment", async () => {
    const getMatchingArticles = vi.fn(async () => [] as string[]);
    const searchOrdinances = vi.fn(async (_query?: string, page = 1) =>
      Array.from({ length: 100 }, (_, index) => ({
        id: `ordinance-${page}-${index}`,
        title: `테스트 조례 ${page}-${index}`,
        localGovernment: "테스트시",
        url: `https://www.law.go.kr/ordinance/${page}-${index}`,
        matchingArticles: []
      }))
    );
    const handler = createOrdinanceIngestHandler({
      repository: new FakeRepository(),
      storage: new FakeStorage(),
      clock: fixedClock,
      client: { searchOrdinances, getMatchingArticles }
    });

    await expect(handler(scheduleEvent())).rejects.toThrow(
      "law.go.kr search exceeded the 1,000 unique record safety limit"
    );
    expect(searchOrdinances).toHaveBeenCalledTimes(11);
    expect(getMatchingArticles).not.toHaveBeenCalled();
  });

  it("reserves weekly deliveries before sending and suppresses duplicate invocation", async () => {
    const repo = new FakeRepository();
    repo.subscriptions.push({
      id: "sub-1", userId: "user-1", recipientEmail: "pilot@example.com",
      targetType: "BENEFIT", targetId: benefit.id, cadence: "WEEKLY", channels: ["EMAIL"],
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    });
    repo.changes.push({
      id: "chg-published", benefitId: benefit.id, action: "UPDATE", risk: "HIGH", status: "PUBLISHED",
      changedFields: ["summary"], before: benefit, after: { ...benefit, summary: "30% 할인" },
      detectedAt: "2026-07-10T00:00:00.000Z", publishedAt: "2026-07-11T00:00:00.000Z",
    });
    const send = vi.fn(async () => undefined);
    const mailer: Mailer = { send };
    const handler = createWeeklyNotificationHandler({ repository: repo, mailer, clock: fixedClock }, {
      PUBLIC_APP_URL: "https://pilot.example.test", PILOT_SLUG: "secret",
    });
    await handler(scheduleEvent());
    await handler(scheduleEvent());
    expect(send).toHaveBeenCalledTimes(1);
    expect(repo.deliveries.size).toBe(1);
  });

  it("sends only individual immediate web pushes once per change and endpoint", async () => {
    const repo = new FakeRepository();
    repo.subscriptions.push({
      id: "sub-immediate", userId: "user-1", recipientEmail: "pilot@example.com",
      targetType: "BENEFIT", targetId: benefit.id, cadence: "IMMEDIATE", channels: ["WEB_PUSH"],
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    });
    repo.pushes.push({
      id: "push-1", userId: "user-1", endpoint: "https://push.example.test/1",
      keys: { p256dh: "key", auth: "auth" },
      createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z",
    });
    repo.changes.push({
      id: "chg-immediate", benefitId: benefit.id, action: "UPDATE", risk: "HIGH", status: "PUBLISHED",
      changedFields: ["summary"], before: benefit, after: { ...benefit, summary: "30% 할인" },
      detectedAt: "2026-07-12T00:00:00.000Z", publishedAt: "2026-07-12T00:00:00.000Z",
    });
    const sendPush = vi.fn(async () => undefined);
    const handler = createWeeklyNotificationHandler({
      repository: repo,
      mailer: { send: vi.fn(async () => undefined) },
      pushSender: { send: sendPush },
      clock: fixedClock,
    }, { PUBLIC_APP_URL: "https://pilot.example.test", PILOT_SLUG: "secret" });
    const event = { mode: "IMMEDIATE" as const, changeIds: ["chg-immediate"] };
    await handler(event);
    await handler(event);
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(repo.deliveries.size).toBe(1);
  });
});

describe("email OTP", () => {
  it("enforces the pilot allowlist and maps the provider session", async () => {
    const start = vi.fn(async () => ({ session: "opaque-session", destinationHint: "p•••@example.com" }));
    const provider: OtpProvider = {
      start,
      verify: vi.fn(async (email) => ({ accessToken: "access-token", idToken: "id-token", userId: "sub-1", email })),
    };
    const handler = createAuthOtpHandler(provider, {
      USER_POOL_CLIENT_ID: "client", USER_POOL_ID: "pool", PILOT_ALLOWED_EMAILS: "pilot@example.com", ADMIN_EMAILS: "pilot@example.com",
    });
    const started = await handler(httpEvent("/v1/auth/otp/start", "POST", { email: "PILOT@example.com" }));
    expect(JSON.parse(started.body ?? "{}")).toMatchObject({ challengeId: "opaque-session" });
    expect(start).toHaveBeenCalledWith("pilot@example.com", "client", "pool", true);
    const verified = await handler(httpEvent("/v1/auth/otp/verify", "POST", {
      email: "pilot@example.com", code: "123456", challengeId: "opaque-session",
    }));
    expect(JSON.parse(verified.body ?? "{}")).toEqual({
      accessToken: "access-token", idToken: "id-token", userId: "sub-1", email: "pilot@example.com", isAdmin: true,
    });
    const denied = await handler(httpEvent("/v1/auth/otp/start", "POST", { email: "other@example.com" }));
    expect(denied.statusCode).toBe(403);
  });
});
