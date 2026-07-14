import { describe, expect, it } from "vitest";
import { normalizeMmaFacility, normalizeMmaNotice } from "@honor/core";
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
  it("treats paged MMA notices as upserts and never deletes an older notice", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.benefits = [
      normalizeMmaNotice({
        gsgeul_no: "100",
        title: "기존 공지",
        url: "https://www.mma.go.kr/hall/board/boardView.do?gsgeul_no=100"
      }, now)
    ];
    const incoming = normalizeMmaNotice({
      gsgeul_no: "101",
      title: "신규 공지",
      url: "https://www.mma.go.kr/hall/board/boardView.do?gsgeul_no=101"
    }, now);

    await persistIngestion(repository, storage, {
      sourceName: "mma-notices",
      benefitType: "NATIONAL",
      benefitIdPrefix: "nat:",
      allowDeletes: false,
      rawBody: "fixture",
      benefits: [incoming],
      retrievedAt: now,
    });

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]).toMatchObject({
      benefitId: incoming.id,
      action: "ADD"
    });
  });

  it("guards a large first baseline when the current dataset is sparse", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.benefits = [facility(999)];

    const result = await persistIngestion(repository, storage, {
      sourceName: "mma-facilities",
      benefitType: "FACILITY",
      benefitIdPrefix: "fac:",
      rawBody: "fixture",
      benefits: Array.from({ length: 100 }, (_, index) => facility(index)),
      retrievedAt: now,
    });

    expect(result.batchGuardTriggered).toBe(true);
    expect(result.pendingReview).toBe(101);
    expect(result.autoApproved).toBe(0);
    expect(repository.changes).toHaveLength(101);
    expect(repository.changes.every(
      (change) => change.risk === "HIGH" && change.status === "PENDING"
    )).toBe(true);
  });

  it("keeps a smaller sparse baseline in manual review as well", async () => {
    const repository = new FakeRepository();
    const result = await persistIngestion(repository, new FakeStorage(), {
      sourceName: "mma-facilities",
      benefitType: "FACILITY",
      benefitIdPrefix: "fac:",
      rawBody: "fixture",
      benefits: Array.from({ length: 19 }, (_, index) => facility(index)),
      retrievedAt: now,
    });

    expect(result.batchGuardTriggered).toBe(true);
    expect(result.pendingReview).toBe(19);
    expect(result.autoApproved).toBe(0);
  });

  it("moves every change to review when total or deletion thresholds are exceeded", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.benefits = Array.from({ length: 25 }, (_, index) => facility(index));
    const after = storage.benefits.slice(0, 20).map((item, index) =>
      index === 0 ? { ...item, contact: { phone: "02-0000-0000" } } : item);

    const result = await persistIngestion(repository, storage, {
      sourceName: "mma-facilities",
      benefitType: "FACILITY",
      benefitIdPrefix: "fac:",
      rawBody: "fixture",
      benefits: after,
      retrievedAt: now,
    });

    expect(result.batchGuardTriggered).toBe(true);
    expect(repository.changes).toHaveLength(6);
    expect(repository.changes.every((change) => change.risk === "HIGH" && change.status === "PENDING")).toBe(true);
  });
});
