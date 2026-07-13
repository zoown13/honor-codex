import { describe, expect, it } from "vitest";
import { normalizeMmaFacility } from "@honor/core";
import { persistIngestion } from "../src/shared/ingestion.js";
import { FakeRepository, FakeStorage } from "./fakes.js";

const now = "2026-07-12T00:00:00.000Z";
const base = normalizeMmaFacility({
  mmgudgigwan_cd: "1",
  udae_ggm: "테스트 시설",
  udsangse_cn: "10% 할인",
  udjiyeok_cd: "09",
  udggeopjong_gbcd: "05",
  udae_gbcd: "02",
}, now);

function facility(index: number) {
  return {
    ...base,
    id: `fac:${index}`,
    title: `테스트 시설 ${index}`,
    provider: `테스트 시설 ${index}`,
    source: { ...base.source, id: String(index) },
    searchText: `테스트 시설 ${index}`,
  };
}

describe("ingestion batch guard", () => {
  it("moves every change to review when total or deletion thresholds are exceeded", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.benefits = Array.from({ length: 25 }, (_, index) => facility(index));
    const after = storage.benefits.slice(0, 20).map((item, index) =>
      index === 0 ? { ...item, contact: { phone: "02-0000-0000" } } : item);

    const result = await persistIngestion(repository, storage, {
      sourceName: "mma-facilities",
      benefitType: "FACILITY",
      rawBody: "fixture",
      benefits: after,
      retrievedAt: now,
    });

    expect(result.batchGuardTriggered).toBe(true);
    expect(repository.changes).toHaveLength(6);
    expect(repository.changes.every((change) => change.risk === "HIGH" && change.status === "PENDING")).toBe(true);
  });
});
