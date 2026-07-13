import { describe, expect, it, vi } from "vitest";
import { normalizeMmaFacility } from "@honor/core";
import { createPublishHandler } from "../src/handlers/publish.js";
import { FakeRepository, FakeStorage, httpEvent } from "./fakes.js";

const now = "2026-07-12T00:00:00.000Z";
const benefit = normalizeMmaFacility({
  mmgudgigwan_cd: "1", udae_ggm: "테스트 시설", udsangse_cn: "10% 할인",
  udjiyeok_cd: "09", udggeopjong_gbcd: "05", udae_gbcd: "02",
}, now);

describe("publish notification trigger", () => {
  it("invokes the immediate notification Lambda with published change ids", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const immediate = vi.fn(async () => undefined);
    repository.changes.push({
      id: "chg-approved", benefitId: benefit.id, action: "ADD", risk: "LOW", status: "AUTO_APPROVED",
      changedFields: ["created"], after: benefit, detectedAt: now,
    });
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start: vi.fn(async () => "job-1") },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(202);
    expect(immediate).toHaveBeenCalledWith(["chg-approved"]);
    expect(repository.changes[0]).toMatchObject({ status: "PUBLISHED", publishedAt: now });
    expect(storage.benefits).toEqual([expect.objectContaining({ id: benefit.id })]);
  });
});
