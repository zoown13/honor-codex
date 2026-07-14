import { diffBenefitSets } from "@honor/core";
import type { Benefit, BenefitChange, BenefitChangeSource, BenefitType } from "@honor/core";
import type { AppRepository, DatasetStorage } from "./contracts.js";

export interface IngestionInput {
  sourceName: string;
  benefitType: BenefitType;
  benefitIdPrefix: string;
  allowDeletes?: boolean;
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

const SOURCE_IDENTITIES: Readonly<Record<BenefitChangeSource, {
  sourceName: string;
  benefitIdPrefix: string;
  benefitType: BenefitType;
  sourceSystem: Benefit["source"]["system"];
}>> = {
  MMA_FACILITIES: {
    sourceName: "mma-facilities",
    benefitIdPrefix: "fac:",
    benefitType: "FACILITY",
    sourceSystem: "MMA",
  },
  MMA_NOTICES: {
    sourceName: "mma-notices",
    benefitIdPrefix: "nat:",
    benefitType: "NATIONAL",
    sourceSystem: "MMA",
  },
  LAW_ORDINANCES: {
    sourceName: "law-ordinances",
    benefitIdPrefix: "ord:",
    benefitType: "ORDINANCE",
    sourceSystem: "LAW_GO_KR",
  },
};

export function reviewSourceIdentity(source: BenefitChangeSource): (typeof SOURCE_IDENTITIES)[BenefitChangeSource] {
  return SOURCE_IDENTITIES[source];
}

export function ingestionReviewSource(input: Pick<IngestionInput, "sourceName" | "benefitIdPrefix" | "benefitType">): BenefitChangeSource {
  const match = (Object.entries(SOURCE_IDENTITIES) as Array<[
    BenefitChangeSource,
    (typeof SOURCE_IDENTITIES)[BenefitChangeSource],
  ]>).find(([, identity]) => identity.sourceName === input.sourceName
    && identity.benefitIdPrefix === input.benefitIdPrefix
    && identity.benefitType === input.benefitType);
  if (!match) throw new Error("Unsupported ingestion source identity");
  return match[0];
}

/**
 * Legacy change records predate the top-level source field. They are accepted only
 * when the ID prefix, benefit type and official source system all identify the same
 * one of the three pilot ingestion sources.
 */
export function inferReviewSource(change: BenefitChange): BenefitChangeSource | undefined {
  const benefit = change.after ?? change.before;
  if (!benefit) return undefined;
  const inferred = (Object.entries(SOURCE_IDENTITIES) as Array<[
    BenefitChangeSource,
    (typeof SOURCE_IDENTITIES)[BenefitChangeSource],
  ]>).find(([, identity]) => change.benefitId.startsWith(identity.benefitIdPrefix)
    && benefit.id.startsWith(identity.benefitIdPrefix)
    && benefit.type === identity.benefitType
    && benefit.source.system === identity.sourceSystem)?.[0];
  if (!inferred) return undefined;
  return change.source === undefined || change.source === inferred ? inferred : undefined;
}

export async function persistIngestion(
  repository: AppRepository,
  storage: DatasetStorage,
  input: IngestionInput,
): Promise<IngestionResult> {
  const snapshotKey = await storage.saveSnapshot(input.sourceName, input.retrievedAt, input.rawBody);
  const reviewSource = ingestionReviewSource(input);
  const current = (await storage.loadBenefits()).filter(
    (item) => item.type === input.benefitType && item.id.startsWith(input.benefitIdPrefix)
  );
  const allDetected = diffBenefitSets(current, input.benefits, input.retrievedAt);
  const detected = input.allowDeletes === false
    ? allDetected.filter((change) => change.action !== "DELETE")
    : allDetected;
  const deletionCount = detected.filter((change) => change.action === "DELETE").length;
  const firstBaselineGuardTriggered = current.length < 20 && detected.length > 0;
  const batchGuardTriggered = firstBaselineGuardTriggered || (
    current.length >= 20 && (
      Math.abs(input.benefits.length - current.length) / current.length > 0.05
      || deletionCount / current.length > 0.01
    )
  );
  const changes = batchGuardTriggered
    ? detected.map((change) => ({ ...change, source: reviewSource, risk: "HIGH" as const, status: "PENDING" as const }))
    : detected.map((change) => ({ ...change, source: reviewSource }));
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
