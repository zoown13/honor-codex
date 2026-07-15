import { describe, expect, it, vi } from "vitest";
import {
  normalizeMmaFacility,
  normalizeMmaNotice,
  normalizeOrdinance,
} from "@honor/core";
import { createPublishHandler } from "../src/handlers/publish.js";
import { DeploymentOutcomeUnknownError } from "../src/shared/contracts.js";
import { FakeRepository, FakeStorage, httpEvent } from "./fakes.js";

const now = "2026-07-12T00:00:00.000Z";
const benefit = normalizeMmaFacility({
  mmgudgigwan_cd: "1", udae_ggm: "테스트 시설", udsangse_cn: "10% 할인",
  udjiyeok_cd: "09", udggeopjong_gbcd: "05", udae_gbcd: "02",
}, now);
const noticeBenefit = normalizeMmaNotice({
  gsgeul_no: "100",
  title: "전국 혜택 공지",
  url: "https://www.mma.go.kr/hall/board/boardView.do?gsgeul_no=100",
}, now);
const ordinanceBenefit = normalizeOrdinance({
  id: "200",
  title: "테스트 병역명문가 예우 조례",
  localGovernment: "서울특별시",
  url: "https://www.law.go.kr/LSW/ordinInfoP.do?ordinSeq=200",
  matchingArticles: ["병역명문가를 예우한다."],
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

function deployment(options: {
  start?: () => Promise<string | undefined>;
  wait?: (jobId: string) => Promise<void>;
} = {}) {
  return {
    start: options.start ?? vi.fn(async () => "job-1"),
    wait: options.wait ?? vi.fn(async () => undefined),
  };
}

describe("publish success gate", () => {
  it("fails closed before reading or writing publish state unless explicitly enabled", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const listChanges = vi.spyOn(repository, "listChanges");
    const publish = vi.spyOn(storage, "publish");
    const start = vi.fn(async () => "job-1");
    const wait = vi.fn(async () => undefined);
    const immediate = vi.fn(async () => undefined);
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start, wait },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(503);
    expect(listChanges).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
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
      deployment: deployment({ start }),
      notifications: { immediate: vi.fn(async () => undefined) },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toEqual({
      error: "선택한 원천에 검수 대기 변경 1건이 있습니다. 승인 후 게시해 주세요.",
    });
    expect(start).not.toHaveBeenCalled();
    expect(storage.benefits).toEqual([]);
    expect(repository.changes[0]?.status).toBe("APPROVED");
  });

  it("publishes approved facilities and notices while leaving pending ordinances untouched", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    repository.changes.push(
      { ...approvedChange("chg-facility"), source: "MMA_FACILITIES" },
      {
        ...approvedChange("chg-notice"),
        benefitId: noticeBenefit.id,
        after: noticeBenefit,
        source: "MMA_NOTICES",
      },
      {
        ...approvedChange("chg-ordinance"),
        benefitId: ordinanceBenefit.id,
        after: ordinanceBenefit,
        source: "LAW_ORDINANCES",
        status: "PENDING",
      },
    );
    const immediate = vi.fn(async () => undefined);
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: deployment(),
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST", {
      sources: ["MMA_FACILITIES", "MMA_NOTICES"],
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      publishedChanges: 2,
      publishSources: ["MMA_FACILITIES", "MMA_NOTICES"],
      notificationsSuppressed: true,
    });
    expect(repository.changes.map((change) => change.status)).toEqual([
      "PUBLISHED",
      "PUBLISHED",
      "PENDING",
    ]);
    expect(storage.benefits.map((item) => item.id).sort()).toEqual([
      benefit.id,
      noticeBenefit.id,
    ].sort());
    expect(immediate).not.toHaveBeenCalled();
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
    const wait = vi.fn(async (jobId: string) => {
      expect(jobId).toBe("job-1");
      expect(repository.publicationOperation?.status).toBe("DEPLOYING");
    });
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start, wait },
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
    expect(wait).toHaveBeenCalledOnce();
    expect(immediate).not.toHaveBeenCalled();
    expect(repository.changes[0]).toMatchObject({
      status: "PUBLISHED",
      publishedAt: now,
      publishOperationId: expect.stringMatching(/^pub:/),
    });
    expect(repository.publicationOperation?.status).toBe("COMPLETED");
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
      deployment: deployment({ start: vi.fn(async () => "job-2") }),
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(200);
    expect(immediate).toHaveBeenCalledWith(["chg-approved"]);
    expect(storage.benefits).toHaveLength(2);
  });

  it("rolls back the exact staged manifest and preserves APPROVED state on terminal deployment failure", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const immediate = vi.fn(async () => undefined);
    repository.changes.push(approvedChange());
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: deployment({ wait: vi.fn(async () => { throw new Error("build failed"); }) }),
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const result = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(result.statusCode).toBe(500);
    expect(storage.benefits).toEqual([]);
    expect(storage.rollbacks).toEqual(["manifest-version-1"]);
    expect(repository.changes[0]?.status).toBe("APPROVED");
    expect(repository.publicationOperation?.status).toBe("FAILED");
    expect(immediate).not.toHaveBeenCalled();
  });

  it("keeps the staged manifest and resumes the same job when deployment outcome is unknown", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    repository.changes.push(approvedChange());
    const start = vi.fn(async () => "job-unknown");
    const wait = vi.fn()
      .mockRejectedValueOnce(new DeploymentOutcomeUnknownError("job-unknown"))
      .mockResolvedValueOnce(undefined);
    const immediate = vi.fn(async () => undefined);
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start, wait },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const first = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(first.statusCode).toBe(500);
    expect(repository.publicationOperation).toMatchObject({
      status: "DEPLOYING",
      deploymentJobId: "job-unknown",
    });
    expect(storage.rollbacks).toEqual([]);

    const second = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(second.statusCode).toBe(200);
    expect(start).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledTimes(2);
    expect(repository.publicationOperation?.status).toBe("COMPLETED");
    expect(immediate).not.toHaveBeenCalled();
  });

  it("resumes partial DynamoDB finalization without sending baseline notifications", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    repository.changes.push(approvedChange("chg-1"), approvedChange("chg-2"));
    const originalMark = repository.markChangesPublished.bind(repository);
    let firstAttempt = true;
    vi.spyOn(repository, "markChangesPublished").mockImplementation(async (ids, at, operationId) => {
      if (firstAttempt) {
        firstAttempt = false;
        await originalMark(ids.slice(0, 1), at, operationId);
        throw new Error("simulated partial finalization");
      }
      await originalMark(ids, at, operationId);
    });
    const start = vi.fn(async () => "job-finalize");
    const wait = vi.fn(async () => undefined);
    const immediate = vi.fn(async () => undefined);
    const handler = createPublishHandler({
      repository,
      storage,
      deployment: { start, wait },
      notifications: { immediate },
      clock: { now: () => new Date(now) },
    }, { ADMIN_EMAILS: "pilot@example.com", PUBLISH_ENABLED: "true" });

    const first = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(first.statusCode).toBe(500);
    expect(repository.changes.map((change) => change.status)).toEqual(["PUBLISHED", "APPROVED"]);
    expect(repository.publicationOperation?.status).toBe("DEPLOYED");
    expect(immediate).not.toHaveBeenCalled();

    const second = await handler(httpEvent("/v1/admin/publish", "POST"));
    expect(second.statusCode).toBe(200);
    expect(repository.changes.every((change) => change.status === "PUBLISHED")).toBe(true);
    expect(repository.publicationOperation?.status).toBe("COMPLETED");
    expect(start).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
    expect(immediate).not.toHaveBeenCalled();
  });
});
