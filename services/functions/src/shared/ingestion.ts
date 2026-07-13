import { diffBenefitSets } from "@honor/core";
import type { Benefit, BenefitType } from "@honor/core";
import type { AppRepository, DatasetStorage } from "./contracts.js";

export interface IngestionInput {
  sourceName: string;
  benefitType: BenefitType;
  rawBody: string;
  benefits: readonly Benefit[];
  retrievedAt: string;
}

export interface IngestionResult {
  source: string;
  received: number;
  changes: number;
  insertedChanges: number;
  pendingReview: number;
  batchGuardTriggered: boolean;
  autoApproved: number;
  snapshotKey: string;
  candidateKey: string;
}

export async function persistIngestion(
  repository: AppRepository,
  storage: DatasetStorage,
  input: IngestionInput,
): Promise<IngestionResult> {
  const snapshotKey = await storage.saveSnapshot(input.sourceName, input.retrievedAt, input.rawBody);
  const current = (await storage.loadBenefits()).filter((item) => item.type === input.benefitType);
  const detected = diffBenefitSets(current, input.benefits, input.retrievedAt);
  const deletionCount = detected.filter((change) => change.action === "DELETE").length;
  const batchGuardTriggered = current.length >= 20 && (
    Math.abs(input.benefits.length - current.length) / current.length > 0.05
    || deletionCount / current.length > 0.01
  );
  const changes = batchGuardTriggered
    ? detected.map((change) => ({ ...change, risk: "HIGH" as const, status: "PENDING" as const })) : detected;
  const insertedChanges = await repository.putChanges(changes);
  const candidateKey = await storage.saveCandidate(input.sourceName, input.retrievedAt, input.benefits);
  return {
    source: input.sourceName,
    received: input.benefits.length,
    changes: changes.length,
    insertedChanges,
    batchGuardTriggered,
    pendingReview: changes.filter((change) => change.status === "PENDING").length,
    autoApproved: changes.filter((change) => change.status === "AUTO_APPROVED").length,
    snapshotKey,
    candidateKey,
  };
}

export async function fetchText(
  url: URL,
  fetcher: typeof fetch,
  maxBytes = 8 * 1024 * 1024,
): Promise<string> {
  const response = await fetcher(url, {
    headers: { accept: "application/json, text/javascript, text/html;q=0.8" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Source request failed: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("Source response is too large");
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Source response is too large");
  return body;
}
