import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppRepository, Clock, DatasetStorage, OrdinanceSummaryJob } from "../shared/contracts.js";
import { PublicationConflictError } from "../shared/contracts.js";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import { HttpError, json, method, parseBody, requireAdmin, requirePilotAdmin, withHttpErrors } from "../shared/http.js";
import { inferReviewSource } from "../shared/ingestion.js";
import {
  DEFAULT_SUMMARY_MODEL_ID,
  DEFAULT_SUMMARY_SAMPLE_SIZE,
  ORDINANCE_SUMMARY_PROMPT_VERSION,
  actualSummaryCostUsd,
  estimateOrdinanceSummaryCost,
  ordinanceSummaryCandidates,
  selectOrdinanceSummarySample,
  summaryCandidateKey,
  summaryJobFingerprint,
} from "../shared/ordinance-summary.js";
import { datasetStorage, nonEmpty, repository, required, systemClock } from "../shared/runtime.js";

export interface SummaryDispatch {
  dispatch(jobId: string): Promise<void>;
}

export function createOrdinanceSummaryControlHandler(
  deps: {
    repository: AppRepository;
    storage: DatasetStorage;
    dispatch: SummaryDispatch;
    clock?: Clock;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  return (event: HttpEvent): Promise<HttpResult> => withHttpErrors(async () => {
    if (event.rawPath.startsWith("/v1/pilot-admin/")) requirePilotAdmin(event, env);
    else requireAdmin(event, env);
    if (method(event) !== "GET" && method(event) !== "POST") {
      throw new HttpError(405, "허용되지 않은 요청입니다.");
    }

    const modelId = nonEmpty(env.BEDROCK_SUMMARY_MODEL_ID) || DEFAULT_SUMMARY_MODEL_ID;
    const maxJobCostUsd = positiveNumber(env.AI_SUMMARY_MAX_JOB_USD, 5);
    const configuredSampleSize = positiveInteger(env.AI_SUMMARY_SAMPLE_SIZE, DEFAULT_SUMMARY_SAMPLE_SIZE, 2_500);
    const inputPrice = positiveNumber(env.AI_SUMMARY_INPUT_USD_PER_MILLION, 0.30);
    const outputPrice = positiveNumber(env.AI_SUMMARY_OUTPUT_USD_PER_MILLION, 2.50);
    let job = await deps.repository.getOrdinanceSummaryJob();
    if (job && (job.status === "QUEUED" || job.status === "RUNNING") && job.processedCount >= job.total) {
      job = await deps.repository.reconcileOrdinanceSummaryJob(
        job.id,
        (deps.clock ?? systemClock).now().toISOString(),
      );
    }
    const changes = await deps.repository.listReviewSummaryChanges();
    const ordinanceChangesAwaitingPublish = changes.filter((change) =>
      inferReviewSource(change) === "LAW_ORDINANCES"
      && (change.status === "PENDING" || change.status === "APPROVED" || change.status === "AUTO_APPROVED")
    ).length;

    if (job && (job.status === "QUEUED" || job.status === "RUNNING")) {
      if (method(event) === "POST") throw new HttpError(409, "조례 AI 정제 작업이 이미 진행 중입니다.");
      return json(200, summaryResponse(job, ordinanceChangesAwaitingPublish, maxJobCostUsd, inputPrice, outputPrice));
    }

    const benefits = await deps.storage.loadBenefits();
    const candidatePool = ordinanceSummaryCandidates(benefits);
    const candidates = selectOrdinanceSummarySample(candidatePool, configuredSampleSize);
    const estimate = estimateOrdinanceSummaryCost(candidates, inputPrice, outputPrice);
    const confirmationPhrase = `SUMMARIZE ${estimate.itemCount}`;
    const canStart = estimate.itemCount > 0
      && ordinanceChangesAwaitingPublish === 0
      && estimate.estimatedCostUsd <= maxJobCostUsd;

    if (method(event) === "GET") {
      return json(200, {
        modelId,
        ...(job ? { job: summaryJobView(job) } : {}),
        estimate,
        candidatePoolCount: candidatePool.length,
        sampleSize: candidates.length,
        actualCostUsd: job ? actualSummaryCostUsd(job.inputTokens, job.outputTokens, inputPrice, outputPrice) : 0,
        confirmationPhrase,
        ordinanceChangesAwaitingPublish,
        maxJobCostUsd,
        canStart,
      });
    }

    if (ordinanceChangesAwaitingPublish > 0) {
      throw new HttpError(409, "검수 또는 게시를 기다리는 조례 변경이 있습니다. 먼저 기존 변경을 처리해 주세요.");
    }
    if (!estimate.itemCount) throw new HttpError(409, "AI로 정제할 조례가 없습니다.");
    if (estimate.estimatedCostUsd > maxJobCostUsd) {
      throw new HttpError(409, `예상 비용이 작업 상한 $${maxJobCostUsd.toFixed(2)}를 초과했습니다.`);
    }
    const body = event.body ? parseBody(event) : {};
    if (body.confirmation !== confirmationPhrase) {
      throw new HttpError(400, `확인 문구가 일치하지 않습니다. ${confirmationPhrase}을 입력해 주세요.`);
    }
    const acceptedMaxCost = typeof body.maxCostUsd === "number" ? body.maxCostUsd : Number.NaN;
    if (!Number.isFinite(acceptedMaxCost)
      || acceptedMaxCost < estimate.estimatedCostUsd
      || acceptedMaxCost > maxJobCostUsd) {
      throw new HttpError(400, "승인한 최대 비용이 예상 비용 이상이면서 서버 상한 이하여야 합니다.");
    }

    const now = (deps.clock ?? systemClock).now().toISOString();
    const fingerprint = summaryJobFingerprint(modelId, candidates, ORDINANCE_SUMMARY_PROMPT_VERSION);
    const proposed: OrdinanceSummaryJob = {
      id: `aisum:${fingerprint.slice(0, 32)}`,
      fingerprint,
      modelId,
      promptVersion: ORDINANCE_SUMMARY_PROMPT_VERSION,
      candidatePoolCount: candidatePool.length,
      candidateKeys: candidates.map(summaryCandidateKey),
      status: "QUEUED",
      total: candidates.length,
      queuedCount: 0,
      processedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: estimate.estimatedCostUsd,
      createdAt: now,
      updatedAt: now,
    };
    let created: OrdinanceSummaryJob;
    try {
      created = await deps.repository.beginOrdinanceSummaryJob(proposed);
    } catch (error) {
      if (error instanceof PublicationConflictError) {
        throw new HttpError(409, "다른 조례 AI 정제 작업이 이미 진행 중입니다.");
      }
      throw error;
    }
    try {
      await deps.dispatch.dispatch(created.id);
    } catch (error) {
      await deps.repository.failOrdinanceSummaryJob(
        created.id,
        now,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return json(202, {
      message: "조례 AI 정제 작업을 대기열에 등록했습니다.",
      job: summaryJobView(created),
      estimate,
    });
  });
}

function summaryResponse(
  job: OrdinanceSummaryJob,
  ordinanceChangesAwaitingPublish: number,
  maxJobCostUsd: number,
  inputPrice: number,
  outputPrice: number,
) {
  return {
    modelId: job.modelId,
    job: summaryJobView(job),
    estimate: {
      itemCount: job.total,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: job.estimatedCostUsd,
    },
    candidatePoolCount: job.candidatePoolCount ?? job.total,
    sampleSize: job.total,
    actualCostUsd: actualSummaryCostUsd(job.inputTokens, job.outputTokens, inputPrice, outputPrice),
    confirmationPhrase: `SUMMARIZE ${job.total}`,
    ordinanceChangesAwaitingPublish,
    maxJobCostUsd,
    canStart: false,
  };
}

function summaryJobView(job: OrdinanceSummaryJob) {
  const { candidateKeys: _candidateKeys, ...view } = job;
  return view;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("AI summary price configuration is invalid");
  return parsed;
}

function positiveInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error("AI summary sample size configuration is invalid");
  }
  return parsed;
}

class SqsSummaryDispatch implements SummaryDispatch {
  readonly #client = new SQSClient({});
  readonly #queueUrl: string;

  constructor(queueUrl: string) {
    this.#queueUrl = queueUrl;
  }

  async dispatch(jobId: string): Promise<void> {
    await this.#client.send(new SendMessageCommand({
      QueueUrl: this.#queueUrl,
      MessageBody: JSON.stringify({ type: "DISPATCH", jobId }),
    }));
  }
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createOrdinanceSummaryControlHandler({
    repository: repository(),
    storage: datasetStorage(),
    dispatch: new SqsSummaryDispatch(required(process.env, "ORDINANCE_SUMMARY_QUEUE_URL")),
  })(event);
