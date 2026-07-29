import { UNKNOWN_OFFICIAL_DETAIL, sha256Hex } from "@honor/core";
import type { Benefit } from "@honor/core";
import type { OrdinanceSummary } from "./contracts.js";

export const DEFAULT_SUMMARY_MODEL_ID = "global.amazon.nova-2-lite-v1:0";
export const DEFAULT_SUMMARY_SAMPLE_SIZE = 10;
export const NOVA_2_LITE_INPUT_USD_PER_MILLION = 0.30;
export const NOVA_2_LITE_OUTPUT_USD_PER_MILLION = 2.50;
export const DEFAULT_MAX_SUMMARY_INPUT_CHARS = 24_000;
export const DEFAULT_MAX_SUMMARY_OUTPUT_TOKENS = 700;

export interface SummaryCostEstimate {
  itemCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

export function ordinanceSummaryCandidates(benefits: readonly Benefit[]): Benefit[] {
  return benefits.filter((benefit) => benefit.type === "ORDINANCE"
    && benefit.summaryProvenance?.kind !== "AI"
    && ordinanceSummarySourceText(benefit).includes("병역명문가"));
}

export function summaryCandidateKey(benefit: Benefit): string {
  return `${benefit.id}:${benefit.source.contentHash}`;
}

export function selectOrdinanceSummarySample(
  benefits: readonly Benefit[],
  sampleSize = DEFAULT_SUMMARY_SAMPLE_SIZE,
): Benefit[] {
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > 2_500) {
    throw new Error("Ordinance summary sample size must be between 1 and 2500");
  }
  const groups = new Map<string, Benefit[]>();
  for (const benefit of ordinanceSummaryCandidates(benefits)) {
    const groupKey = benefit.provider.trim() || benefit.id;
    const group = groups.get(groupKey) ?? [];
    group.push(benefit);
    groups.set(groupKey, group);
  }
  const rankedGroups = [...groups.entries()]
    .map(([provider, group]) => ({
      provider,
      rank: sha256Hex(`honor-pilot-ordinance-provider-v1\n${provider}`),
      benefits: group.sort((left, right) =>
        sampleRank(left).localeCompare(sampleRank(right)) || left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.provider.localeCompare(right.provider));
  const selected: Benefit[] = [];
  for (let depth = 0; selected.length < sampleSize; depth += 1) {
    let added = 0;
    for (const group of rankedGroups) {
      const benefit = group.benefits[depth];
      if (!benefit) continue;
      selected.push(benefit);
      added += 1;
      if (selected.length === sampleSize) break;
    }
    if (!added) break;
  }
  return selected;
}

export function summaryJobFingerprint(modelId: string, benefits: readonly Benefit[]): string {
  return sha256Hex([
    modelId,
    ...benefits.map(summaryCandidateKey).sort(),
  ].join("\n"));
}

export function estimateOrdinanceSummaryCost(
  benefits: readonly Benefit[],
  inputUsdPerMillion = NOVA_2_LITE_INPUT_USD_PER_MILLION,
  outputUsdPerMillion = NOVA_2_LITE_OUTPUT_USD_PER_MILLION,
): SummaryCostEstimate {
  const candidates = ordinanceSummaryCandidates(benefits);
  const estimatedInputTokens = candidates.reduce((total, benefit) => {
    const sourceBytes = Buffer.byteLength(ordinanceSummarySourceText(benefit), "utf8");
    return total + Math.ceil(sourceBytes / 2) + 550;
  }, 0);
  const estimatedOutputTokens = candidates.length * 600;
  const estimatedCostUsd = roundUsd(
    (estimatedInputTokens * inputUsdPerMillion + estimatedOutputTokens * outputUsdPerMillion) / 1_000_000,
  );
  return { itemCount: candidates.length, estimatedInputTokens, estimatedOutputTokens, estimatedCostUsd };
}

export function actualSummaryCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMillion = NOVA_2_LITE_INPUT_USD_PER_MILLION,
  outputUsdPerMillion = NOVA_2_LITE_OUTPUT_USD_PER_MILLION,
): number {
  return roundUsd((inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000);
}

export function ordinanceSummarySourceText(
  benefit: Benefit,
  maxChars = DEFAULT_MAX_SUMMARY_INPUT_CHARS,
): string {
  const evidence = benefit.evidence
    .map((item) => [item.article, item.excerpt].filter(Boolean).join(" "))
    .filter(Boolean);
  return [...new Set([benefit.summary, ...evidence])].join("\n\n").slice(0, maxChars);
}

export function buildOrdinanceSummaryPrompt(benefit: Benefit): string {
  return [
    "당신은 대한민국 자치법규를 시민이 이해하기 쉽게 구조화하는 검수 보조자입니다.",
    "아래 원문에 명시된 내용만 사용하세요. 추론하거나 일반 상식을 보충하지 마세요.",
    "여러 감면 대상 중 병역명문가와 그 가족에게 적용되는 대상·혜택·증빙·절차·제한만 추출하세요.",
    "다른 국가유공자·장애인·수급자 등의 조건은 병역명문가 조건을 설명하는 데 직접 필요하지 않으면 제외하세요.",
    "summary와 eligibility에는 반드시 '병역명문가'라는 말을 포함하세요.",
    `명시되지 않은 필드는 정확히 '${UNKNOWN_OFFICIAL_DETAIL}' 한 항목으로 반환하세요.`,
    "summary는 2문장 이내, 각 배열은 중복 없이 최대 6개 항목으로 작성하세요.",
    "benefitKind는 FREE, DISCOUNT, OTHER 중 하나입니다.",
    "amount는 할인율·면제 범위·금액이 명시된 경우에만 넣고, 아니면 생략하세요.",
    "마크다운이나 설명 없이 다음 키만 가진 JSON 객체를 반환하세요:",
    '{"summary":"string","eligibility":["string"],"benefitKind":"OTHER","amount":"optional string","requiredProof":["string"],"howToUse":["string"],"constraints":["string"]}',
    `조례명: ${benefit.title}`,
    `지방자치단체: ${benefit.provider}`,
    "관련 원문:",
    ordinanceSummarySourceText(benefit),
  ].join("\n");
}

export function parseOrdinanceSummaryOutput(text: string): OrdinanceSummary {
  const value = parseJsonObject(text);
  const benefitKind = value.benefitKind;
  if (benefitKind !== "FREE" && benefitKind !== "DISCOUNT" && benefitKind !== "OTHER") {
    throw new Error("AI summary benefitKind is invalid");
  }
  const amount = optionalText(value.amount, 300);
  return {
    summary: requiredText(value.summary, "summary", 600),
    eligibility: stringList(value.eligibility, "eligibility"),
    benefitKind,
    ...(amount ? { amount } : {}),
    requiredProof: stringList(value.requiredProof, "requiredProof"),
    howToUse: stringList(value.howToUse, "howToUse"),
    constraints: stringList(value.constraints, "constraints"),
  };
}

export function applyOrdinanceSummary(
  benefit: Benefit,
  summary: OrdinanceSummary,
  modelId: string,
  generatedAt: string,
  inputTokens: number,
  outputTokens: number,
): Benefit {
  assertHonorableFamilySummary(benefit, summary);
  const amount = summary.amount?.trim();
  const next: Benefit = {
    ...benefit,
    summary: summary.summary,
    eligibility: summary.eligibility,
    benefitKind: summary.benefitKind,
    ...(amount ? { amount } : {}),
    requiredProof: summary.requiredProof,
    howToUse: summary.howToUse,
    constraints: summary.constraints,
    reviewState: "SOURCE_ONLY",
    summaryProvenance: {
      kind: "AI",
      modelId,
      generatedAt,
      sourceContentHash: benefit.source.contentHash,
      inputTokens,
      outputTokens,
    },
    updatedAt: generatedAt,
  };
  if (!amount) delete next.amount;
  next.searchText = [
    next.title,
    next.provider,
    next.summary,
    ...next.eligibility,
    ...next.requiredProof,
    ...next.howToUse,
    ...next.constraints,
    "병역명문가 조례",
  ].join(" ").toLocaleLowerCase("ko-KR");
  return next;
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI summary did not return a JSON object");
  const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI summary JSON must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`AI summary ${field} is invalid`);
  }
  return value.trim();
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, "amount", maxLength);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new Error(`AI summary ${field} must contain 1 to 6 items`);
  }
  return [...new Set(value.map((item) => requiredText(item, field, 300)))];
}

export function assertHonorableFamilySummary(benefit: Benefit, summary: OrdinanceSummary): void {
  if (benefit.type !== "ORDINANCE") throw new Error("Only ordinance benefits can be AI summarized");
  if (!ordinanceSummarySourceText(benefit).includes("병역명문가")) {
    throw new Error("Ordinance source does not contain honorable-family evidence");
  }
  if (!summary.summary.includes("병역명문가")
    || !summary.eligibility.some((item) => item.includes("병역명문가"))) {
    throw new Error("AI summary omitted the honorable-family target");
  }
}

function sampleRank(benefit: Benefit): string {
  return sha256Hex(`honor-pilot-ordinance-sample-v1\n${summaryCandidateKey(benefit)}`);
}

function roundUsd(value: number): number {
  return Math.ceil(value * 100) / 100;
}
