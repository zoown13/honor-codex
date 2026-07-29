import { normalizeMmaFacility, normalizeOrdinance } from "@honor/core";
import type { SQSEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createOrdinanceSummaryControlHandler } from "../src/handlers/ordinance-summary-control.js";
import { createOrdinanceSummaryWorker } from "../src/handlers/ordinance-summary-worker.js";
import { createPublishControlHandler } from "../src/handlers/publish-control.js";
import {
  applyOrdinanceSummary,
  estimateOrdinanceSummaryCost,
  parseOrdinanceSummaryOutput,
  selectOrdinanceSummarySample,
  summaryCandidateKey,
} from "../src/shared/ordinance-summary.js";
import { preserveReviewedAiSummaries } from "../src/shared/ingestion.js";
import { FakeRepository, FakeStorage, httpEvent } from "./fakes.js";

const now = "2026-07-26T08:30:00.000Z";
const ordinance = normalizeOrdinance({
  id: "ordinance-1",
  title: "병역명문가 예우 조례",
  localGovernment: "서울특별시",
  url: "https://www.law.go.kr/LSW/ordinInfoP.do?ordinSeq=1",
  matchingArticles: ["병역명문가에게 공공시설 사용료의 100분의 50을 감면한다."],
}, now);

function pilotEvent(path: string, method: string, body?: unknown) {
  return httpEvent(path, method, body, {
    headers: { "x-honor-pilot-admin": "pilot-admin-token-1234567890" },
  });
}

function sqsEvent(messageId: string, body: unknown): SQSEvent {
  return {
    Records: [{
      messageId,
      receiptHandle: "receipt",
      body: JSON.stringify(body),
      attributes: {
        ApproximateReceiveCount: "1",
        SentTimestamp: "0",
        SenderId: "test",
        ApproximateFirstReceiveTimestamp: "0",
      },
      messageAttributes: {},
      md5OfBody: "test",
      eventSource: "aws:sqs",
      eventSourceARN: "arn:aws:sqs:ap-northeast-2:123456789012:test",
      awsRegion: "ap-northeast-2",
    }],
  };
}

describe("admin publishing control", () => {
  it("creates a PREPARING operation and returns immediately after an IAM-scoped async invoke", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const facility = normalizeMmaFacility({ mmgudgigwan_cd: "1", udae_ggm: "시설", udsangse_cn: "10% 할인" }, now);
    repository.changes.push({
      id: "chg-approved",
      benefitId: facility.id,
      action: "ADD",
      risk: "HIGH",
      status: "APPROVED",
      changedFields: ["created"],
      after: facility,
      source: "MMA_FACILITIES",
      detectedAt: now,
    });
    const invoke = vi.fn(async () => undefined);
    const handler = createPublishControlHandler({
      repository,
      storage,
      invoker: { invoke },
      clock: { now: () => new Date(now) },
    }, { PILOT_ADMIN_TOKEN: "pilot-admin-token-1234567890" });

    const status = await handler(pilotEvent("/v1/pilot-admin/publish", "GET"));
    expect(JSON.parse(status.body)).toMatchObject({ approvedCount: 1, confirmationPhrase: "PUBLISH 1" });

    const started = await handler(pilotEvent("/v1/pilot-admin/publish", "POST", {
      sources: ["MMA_FACILITIES"],
      confirmation: "PUBLISH 1",
    }));
    expect(started.statusCode).toBe(202);
    expect(repository.publicationOperation).toMatchObject({ status: "PREPARING", changeIds: ["chg-approved"] });
    expect(invoke).toHaveBeenCalledWith(["MMA_FACILITIES"]);
  });
});

describe("ordinance AI summary", () => {
  it("selects the same municipality-spread sample regardless of input order", () => {
    const candidates = Array.from({ length: 25 }, (_, index) => normalizeOrdinance({
      id: `ordinance-${index + 1}`,
      title: `병역명문가 예우 조례 ${index + 1}`,
      localGovernment: `테스트시 ${index + 1}`,
      url: `https://www.law.go.kr/LSW/ordinInfoP.do?ordinSeq=${index + 1}`,
      matchingArticles: [`제${index + 1}조 병역명문가 예우`],
    }, now));

    const selected = selectOrdinanceSummarySample(candidates, 10);
    const reversed = selectOrdinanceSummarySample([...candidates].reverse(), 10);

    expect(selected).toHaveLength(10);
    expect(reversed.map(({ id }) => id)).toEqual(selected.map(({ id }) => id));
    expect(new Set(selected.map(({ provider }) => provider))).toHaveLength(10);
    expect(new Set(selected.map(summaryCandidateKey))).toHaveLength(10);
  });

  it("validates structured JSON, estimates a bounded cost, and preserves AI provenance", () => {
    const value = parseOrdinanceSummaryOutput(JSON.stringify({
      summary: "병역명문가는 공공시설 사용료를 50% 감면받습니다.",
      eligibility: ["병역명문가"],
      benefitKind: "DISCOUNT",
      amount: "사용료 50% 감면",
      requiredProof: ["공식 문서에 명시되지 않음—시설 또는 담당부서 확인 필요"],
      howToUse: ["시설 이용 시 감면 신청"],
      constraints: ["대상 시설은 담당부서 확인 필요"],
    }));
    const estimate = estimateOrdinanceSummaryCost([ordinance]);
    const summarized = applyOrdinanceSummary(
      ordinance,
      value,
      "global.amazon.nova-2-lite-v1:0",
      now,
      900,
      120,
    );

    expect(() => applyOrdinanceSummary(
      ordinance,
      { ...value, summary: "공공시설 사용료를 감면합니다.", eligibility: ["국가유공자"] },
      "global.amazon.nova-2-lite-v1:0",
      now,
      900,
      120,
    )).toThrow("AI summary omitted the honorable-family target");
    expect(estimate.itemCount).toBe(1);
    expect(estimate.estimatedCostUsd).toBeGreaterThan(0);
    expect(summarized).toMatchObject({
      summary: "병역명문가는 공공시설 사용료를 50% 감면받습니다.",
      benefitKind: "DISCOUNT",
      amount: "사용료 50% 감면",
      reviewState: "SOURCE_ONLY",
      summaryProvenance: {
        kind: "AI",
        sourceContentHash: ordinance.source.contentHash,
        inputTokens: 900,
        outputTokens: 120,
      },
    });

    const refreshed = {
      ...ordinance,
      source: { ...ordinance.source, retrievedAt: "2026-08-02T00:00:00.000Z" },
      validity: { ...ordinance.validity, checkedAt: "2026-08-02T00:00:00.000Z" },
    };
    const [preserved] = preserveReviewedAiSummaries([summarized], [refreshed]);
    expect(preserved?.summary).toBe(summarized.summary);
    expect(preserved?.summaryProvenance).toEqual(summarized.summaryProvenance);
    const [changedSource] = preserveReviewedAiSummaries([summarized], [{
      ...refreshed,
      source: { ...refreshed.source, contentHash: "changed-source-hash" },
    }]);
    expect(changedSource?.summaryProvenance).toBeUndefined();
  });

  it("requires a cost acknowledgement, queues one dispatch, and converts results into pending review changes", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.benefits = [ordinance];
    const dispatch = vi.fn(async () => undefined);
    const control = createOrdinanceSummaryControlHandler({
      repository,
      storage,
      dispatch: { dispatch },
      clock: { now: () => new Date(now) },
    }, { PILOT_ADMIN_TOKEN: "pilot-admin-token-1234567890", AI_SUMMARY_MAX_JOB_USD: "5" });

    const preview = JSON.parse((await control(pilotEvent("/v1/pilot-admin/ordinance-summaries", "GET"))).body);
    expect(preview).toMatchObject({
      candidatePoolCount: 1,
      sampleSize: 1,
      estimate: { itemCount: 1 },
    });
    const started = await control(pilotEvent("/v1/pilot-admin/ordinance-summaries", "POST", {
      confirmation: preview.confirmationPhrase,
      maxCostUsd: preview.estimate.estimatedCostUsd,
    }));
    expect(started.statusCode).toBe(202);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(JSON.parse(started.body).job).not.toHaveProperty("candidateKeys");
    expect(repository.ordinanceSummaryJob).toMatchObject({
      candidatePoolCount: 1,
      candidateKeys: [summaryCandidateKey(ordinance)],
      total: 1,
    });

    const queued: (typeof ordinance)[] = [];
    const summarize = vi.fn(async () => ({
      value: {
        summary: "병역명문가는 공공시설 사용료를 50% 감면받습니다.",
        eligibility: ["병역명문가"],
        benefitKind: "DISCOUNT" as const,
        amount: "사용료 50% 감면",
        requiredProof: ["공식 문서에 명시되지 않음—시설 또는 담당부서 확인 필요"],
        howToUse: ["시설에 감면 신청"],
        constraints: ["대상 시설 확인 필요"],
      },
      inputTokens: 900,
      outputTokens: 120,
    }));
    const worker = createOrdinanceSummaryWorker({
      repository,
      storage,
      summarizer: { summarize },
      queue: { send: async (_jobId, benefits) => { queued.push(...benefits); return benefits.length; } },
      clock: { now: () => new Date(now) },
    });
    const job = repository.ordinanceSummaryJob!;
    expect((await worker(sqsEvent("dispatch-1", { type: "DISPATCH", jobId: job.id }))).batchItemFailures).toEqual([]);
    expect(queued).toHaveLength(1);
    expect((await worker(sqsEvent("item-1", { type: "SUMMARIZE", jobId: job.id, benefit: queued[0] }))).batchItemFailures).toEqual([]);

    expect(repository.changes).toHaveLength(1);
    expect(repository.changes[0]).toMatchObject({ status: "PENDING", risk: "HIGH", source: "LAW_ORDINANCES" });
    expect(repository.ordinanceSummaryJob).toMatchObject({ status: "COMPLETED", succeededCount: 1, inputTokens: 900, outputTokens: 120 });
    expect(repository.ordinanceSummaryCache.size).toBe(1);
  });

  it("repairs a fully processed active job when status is read", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    repository.ordinanceSummaryJob = {
      id: "aisum:repair",
      fingerprint: "a".repeat(64),
      modelId: "global.amazon.nova-2-lite-v1:0",
      candidatePoolCount: 1_432,
      candidateKeys: [],
      status: "RUNNING",
      total: 10,
      queuedCount: 10,
      processedCount: 10,
      succeededCount: 8,
      failedCount: 2,
      inputTokens: 7_977,
      outputTokens: 2_226,
      estimatedCostUsd: 0.03,
      createdAt: now,
      updatedAt: now,
    };
    const control = createOrdinanceSummaryControlHandler({
      repository,
      storage,
      dispatch: { dispatch: vi.fn(async () => undefined) },
      clock: { now: () => new Date(now) },
    }, { PILOT_ADMIN_TOKEN: "pilot-admin-token-1234567890" });

    const response = await control(pilotEvent("/v1/pilot-admin/ordinance-summaries", "GET"));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).job).toMatchObject({
      status: "COMPLETED_WITH_ERRORS",
      processedCount: 10,
      succeededCount: 8,
      failedCount: 2,
    });
  });

  it("limits a job to the configured ten-item sample before dispatch", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.benefits = Array.from({ length: 15 }, (_, index) => normalizeOrdinance({
      id: `sample-${index + 1}`,
      title: `병역명문가 표본 조례 ${index + 1}`,
      localGovernment: `표본시 ${index + 1}`,
      url: `https://www.law.go.kr/LSW/ordinInfoP.do?ordinSeq=${100 + index}`,
      matchingArticles: [`제${index + 1}조 병역명문가 표본 혜택`],
    }, now));
    const dispatch = vi.fn(async () => undefined);
    const control = createOrdinanceSummaryControlHandler({
      repository,
      storage,
      dispatch: { dispatch },
      clock: { now: () => new Date(now) },
    }, {
      PILOT_ADMIN_TOKEN: "pilot-admin-token-1234567890",
      AI_SUMMARY_MAX_JOB_USD: "5",
      AI_SUMMARY_SAMPLE_SIZE: "10",
    });

    const preview = JSON.parse((await control(pilotEvent("/v1/pilot-admin/ordinance-summaries", "GET"))).body);
    expect(preview).toMatchObject({
      candidatePoolCount: 15,
      sampleSize: 10,
      confirmationPhrase: "SUMMARIZE 10",
      estimate: { itemCount: 10 },
    });
    await control(pilotEvent("/v1/pilot-admin/ordinance-summaries", "POST", {
      confirmation: preview.confirmationPhrase,
      maxCostUsd: preview.estimate.estimatedCostUsd,
    }));

    const queued: (typeof ordinance)[] = [];
    const worker = createOrdinanceSummaryWorker({
      repository,
      storage,
      summarizer: {
        summarize: vi.fn(async () => {
          throw new Error("dispatch test must not invoke the model");
        }),
      },
      queue: { send: async (_jobId, benefits) => { queued.push(...benefits); return benefits.length; } },
      clock: { now: () => new Date(now) },
    });
    const job = repository.ordinanceSummaryJob!;
    expect(job).toMatchObject({ total: 10, candidatePoolCount: 15 });
    expect(job.candidateKeys).toHaveLength(10);
    expect((await worker(sqsEvent("dispatch-10", { type: "DISPATCH", jobId: job.id }))).batchItemFailures).toEqual([]);
    expect(queued).toHaveLength(10);
    expect(new Set(queued.map(({ provider }) => provider))).toHaveLength(10);
  });
});
