import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";
import { diffBenefitSets, sha256Hex } from "@honor/core";
import type { Benefit, BenefitChange } from "@honor/core";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import type {
  AppRepository,
  Clock,
  DatasetStorage,
  OrdinanceSummary,
} from "../shared/contracts.js";
import {
  DEFAULT_MAX_SUMMARY_OUTPUT_TOKENS,
  applyOrdinanceSummary,
  assertHonorableFamilySummary,
  buildOrdinanceSummaryPrompt,
  ordinanceSummaryCandidates,
  selectOrdinanceSummarySample,
  summaryCandidateKey,
  summaryJobFingerprint,
  parseOrdinanceSummaryOutput,
} from "../shared/ordinance-summary.js";
import { datasetStorage, repository, required, systemClock } from "../shared/runtime.js";

interface DispatchMessage {
  type: "DISPATCH";
  jobId: string;
}

interface SummarizeMessage {
  type: "SUMMARIZE";
  jobId: string;
  benefit: Benefit;
}

type SummaryQueueMessage = DispatchMessage | SummarizeMessage;

export interface ModelSummaryResult {
  value: OrdinanceSummary;
  inputTokens: number;
  outputTokens: number;
}

export interface OrdinanceSummarizer {
  summarize(benefit: Benefit, modelId: string): Promise<ModelSummaryResult>;
}

export interface SummaryQueueSender {
  send(jobId: string, benefits: readonly Benefit[]): Promise<number>;
}

export function createOrdinanceSummaryWorker(
  deps: {
    repository: AppRepository;
    storage: DatasetStorage;
    summarizer: OrdinanceSummarizer;
    queue: SummaryQueueSender;
    clock?: Clock;
  },
) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const failures: SQSBatchResponse["batchItemFailures"] = [];
    for (const record of event.Records) {
      try {
        const message = parseMessage(record.body);
        if (message.type === "DISPATCH") await dispatchJob(deps, message);
        else await summarizeItem(deps, message);
      } catch (error) {
        console.error("Ordinance summary queue item failed", {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        await recordTerminalFailure(deps, record, error);
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}

async function dispatchJob(
  deps: {
    repository: AppRepository;
    storage: DatasetStorage;
    queue: SummaryQueueSender;
    clock?: Clock;
  },
  message: DispatchMessage,
): Promise<void> {
  const job = await deps.repository.getOrdinanceSummaryJob();
  if (!job || job.id !== message.jobId) throw new Error("Ordinance summary job does not match dispatch message");
  if (job.status === "COMPLETED" || job.status === "COMPLETED_WITH_ERRORS") return;
  if (job.status === "FAILED") throw new Error("Ordinance summary job is already failed");
  const candidatePool = ordinanceSummaryCandidates(await deps.storage.loadBenefits());
  if (job.candidatePoolCount !== undefined && candidatePool.length !== job.candidatePoolCount) {
    throw new Error(
      `Ordinance summary candidate pool changed: expected ${job.candidatePoolCount}, received ${candidatePool.length}`,
    );
  }
  const candidateKeys = job.candidateKeys?.length
    ? job.candidateKeys
    : selectOrdinanceSummarySample(candidatePool, job.total).map(summaryCandidateKey);
  if (candidateKeys.length !== job.total || new Set(candidateKeys).size !== job.total) {
    throw new Error("Ordinance summary job candidate keys are invalid");
  }
  const candidatesByKey = new Map(candidatePool.map((benefit) => [summaryCandidateKey(benefit), benefit]));
  const selected = candidateKeys.map((key) => candidatesByKey.get(key));
  if (selected.some((benefit) => benefit === undefined)) {
    throw new Error("An ordinance summary sample changed after owner confirmation");
  }
  const benefits = selected as Benefit[];
  if (summaryJobFingerprint(job.modelId, benefits) !== job.fingerprint) {
    throw new Error("Ordinance summary job fingerprint no longer matches the selected sample");
  }
  const queuedCount = await deps.queue.send(job.id, benefits);
  if (queuedCount !== job.total) throw new Error("Not all ordinance summary items were queued");
  await deps.repository.markOrdinanceSummaryJobRunning(
    job.id,
    queuedCount,
    (deps.clock ?? systemClock).now().toISOString(),
  );
}

async function summarizeItem(
  deps: {
    repository: AppRepository;
    summarizer: OrdinanceSummarizer;
    clock?: Clock;
  },
  message: SummarizeMessage,
): Promise<void> {
  const job = await deps.repository.getOrdinanceSummaryJob();
  if (!job || job.id !== message.jobId) throw new Error("Ordinance summary job does not match item message");
  if (job.status === "COMPLETED" || job.status === "COMPLETED_WITH_ERRORS") return;
  if (job.status === "FAILED") throw new Error("Ordinance summary job is already failed");
  if (message.benefit.type !== "ORDINANCE") throw new Error("Summary queue item is not an ordinance");

  const cacheKey = `v1:${sha256Hex(`${job.modelId}\n${message.benefit.source.contentHash}`)}`;
  let cached = await deps.repository.getOrdinanceSummaryCache(cacheKey);
  if (!cached) {
    const generated = await deps.summarizer.summarize(message.benefit, job.modelId);
    cached = {
      cacheKey,
      modelId: job.modelId,
      sourceContentHash: message.benefit.source.contentHash,
      value: generated.value,
      inputTokens: generated.inputTokens,
      outputTokens: generated.outputTokens,
      createdAt: (deps.clock ?? systemClock).now().toISOString(),
    };
    await deps.repository.putOrdinanceSummaryCache(cached);
  }

  const summarized = applyOrdinanceSummary(
    message.benefit,
    cached.value,
    cached.modelId,
    job.createdAt,
    cached.inputTokens,
    cached.outputTokens,
  );
  const detected = diffBenefitSets([message.benefit], [summarized], job.createdAt)[0];
  let change: BenefitChange | undefined;
  if (detected) {
    change = {
      ...detected,
      source: "LAW_ORDINANCES",
      risk: "HIGH",
      status: "PENDING",
    };
    await deps.repository.putChanges([change]);
  }
  await deps.repository.recordOrdinanceSummaryItem(job.id, {
    benefitId: message.benefit.id,
    status: "SUCCEEDED",
    inputTokens: cached.inputTokens,
    outputTokens: cached.outputTokens,
    ...(change ? { changeId: change.id } : {}),
  }, (deps.clock ?? systemClock).now().toISOString());
}

async function recordTerminalFailure(
  deps: { repository: AppRepository; clock?: Clock },
  record: SQSRecord,
  error: unknown,
): Promise<void> {
  const attempts = Number(record.attributes.ApproximateReceiveCount ?? "1");
  if (attempts < 3) return;
  let message: SummaryQueueMessage;
  try {
    message = parseMessage(record.body);
  } catch {
    return;
  }
  const now = (deps.clock ?? systemClock).now().toISOString();
  if (message.type === "DISPATCH") {
    await deps.repository.failOrdinanceSummaryJob(
      message.jobId,
      now,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  await deps.repository.recordOrdinanceSummaryItem(message.jobId, {
    benefitId: message.benefit.id,
    status: "FAILED",
    inputTokens: 0,
    outputTokens: 0,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  }, now);
}

function parseMessage(body: string): SummaryQueueMessage {
  const value = JSON.parse(body) as Partial<SummaryQueueMessage>;
  if (value.type === "DISPATCH" && typeof value.jobId === "string" && value.jobId.startsWith("aisum:")) {
    return value as DispatchMessage;
  }
  if (value.type === "SUMMARIZE"
    && typeof value.jobId === "string"
    && value.jobId.startsWith("aisum:")
    && value.benefit
    && typeof value.benefit === "object") {
    return value as SummarizeMessage;
  }
  throw new Error("Ordinance summary queue message is invalid");
}

class BedrockOrdinanceSummarizer implements OrdinanceSummarizer {
  readonly #client = new BedrockRuntimeClient({});

  async summarize(benefit: Benefit, modelId: string): Promise<ModelSummaryResult> {
    const response = await this.#client.send(new ConverseCommand({
      modelId,
      messages: [{ role: "user", content: [{ text: buildOrdinanceSummaryPrompt(benefit) }] }],
      inferenceConfig: {
        maxTokens: DEFAULT_MAX_SUMMARY_OUTPUT_TOKENS,
        temperature: 0,
        topP: 0.1,
      },
    }));
    const text = response.output?.message?.content
      ?.map((content) => "text" in content ? content.text : "")
      .join("")
      .trim();
    if (!text) throw new Error("Bedrock returned an empty ordinance summary");
    const value = parseOrdinanceSummaryOutput(text);
    assertHonorableFamilySummary(benefit, value);
    return {
      value,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  }
}

class SqsSummaryQueueSender implements SummaryQueueSender {
  readonly #client = new SQSClient({});
  readonly #queueUrl: string;

  constructor(queueUrl: string) {
    this.#queueUrl = queueUrl;
  }

  async send(jobId: string, benefits: readonly Benefit[]): Promise<number> {
    let queued = 0;
    for (let offset = 0; offset < benefits.length; offset += 10) {
      const chunk = benefits.slice(offset, offset + 10);
      const result = await this.#client.send(new SendMessageBatchCommand({
        QueueUrl: this.#queueUrl,
        Entries: chunk.map((benefit, index) => ({
          Id: `item-${offset + index}`,
          MessageBody: JSON.stringify({ type: "SUMMARIZE", jobId, benefit }),
        })),
      }));
      if (result.Failed?.length) {
        throw new Error(`Failed to queue ${result.Failed.length} ordinance summary items`);
      }
      queued += result.Successful?.length ?? 0;
    }
    return queued;
  }
}

export const handler = (event: SQSEvent): Promise<SQSBatchResponse> =>
  createOrdinanceSummaryWorker({
    repository: repository(),
    storage: datasetStorage(),
    summarizer: new BedrockOrdinanceSummarizer(),
    queue: new SqsSummaryQueueSender(required(process.env, "ORDINANCE_SUMMARY_QUEUE_URL")),
  })(event);
