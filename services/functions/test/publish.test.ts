import { describe, expect, it, vi } from "vitest";
import { normalizeMmaFacility } from "@honor/core";
import { createPublishHandler } from "../src/handlers/publish.js";
import { FakeRepository, FakeStorage, httpEvent } from "./fakes.js";

const now = "2026-07-12T00:00:00.000Z";
const benefit = normalizeMmaFacility({
  mmgudgigwan_cd: "1", udae_ggm: "테스트 시설", udsangse_cn: "10% 할인",
  udjiyeok_cd: "09", udggeopjong_gbcd: "05", udae_gbcd: "02",
}, now);

function approvedChange(id = "chg-approved") {
  return {
    id,
    benefitId: benefit.id,
    action: "ADD" as const,
    risk: "HIGH" as const,
    status: "APPROVED" as const,
    changedFields: ["created"],
    after: benefit,
    detectedAt: now,
  };
}

describe("publish success gate", () => {
  it("fails closed before reading or writing publish state unless explicitly enabled", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const listChanges = vi.spyOn(repository, "listChanges");
    const publish = vi.spyOn(storage, "publish");
    const start = vi.fn(async () => "job-1");
    const immediate = vi.fn(async () => undefined);
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(503);
    expect(listChanges).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(immediate).not.toHaveBeenCalled();
  });

  it("refuses to publish while any review remains pending", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const start = vi.fn(async () => "job-1");
    repository.changes.push(
      approvedChange(),
      { ...approvedChange("chg-pending"), status: "PENDING" },
    );
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start },
      notifications: { immediate: vi.fn(async () => undefined) },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({ error: "검수 대기 변경 1건을 모두 처리한 뒤 게시해 주세요." });
    expect(start).not.toHaveBeenCalled();
    expect(storage.benefits).toEqual([]);
    expect(repository.changes[0]?.status).toBe("APPROVED");
  });

  it("waits for deployment success, publishes the initial baseline, and suppresses notifications", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const immediate = vi.fn(async () => undefined);
    repository.changes.push(approvedChange());
    const start = vi.fn(async () => {
      expect(repository.changes[0]?.status).toBe("APPROVED");
      return "job-1";
    });
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      publishedChanges: 1,
      deploymentJobId: "job-1",
      deploymentStatus: "SUCCEED",
      notificationsSuppressed: true,
    });
    expect(start).toHaveBeenCalledOnce();
    expect(immediate).not.toHaveBeenCalled();
    expect(repository.changes[0]).toMatchObject({ status: "PUBLISHED", publishedAt: now });
    expect(storage.benefits).toEqual([expect.objectContaining({ id: benefit.id })]);
  });

  it("notifies followers after a successful non-baseline deployment", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.benefits = [{ ...benefit, id: "fac:existing" }];
    const immediate = vi.fn(async () => undefined);
    repository.changes.push(approvedChange());
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start: vi.fn(async () => "job-2") },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(200);
    expect(immediate).toHaveBeenCalledWith(["chg-approved"]);
    expect(storage.benefits).toHaveLength(2);
  });

  it("rolls back the staged manifest and preserves APPROVED state when deployment fails", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const immediate = vi.fn(async () => undefined);
    repository.changes.push(approvedChange());
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start: vi.fn(async () => { throw new Error("build failed"); }) },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(500);
    expect(storage.benefits).toEqual([]);
    expect(repository.changes[0]?.status).toBe("APPROVED");
    expect(immediate).not.toHaveBeenCalled();
  });
});
