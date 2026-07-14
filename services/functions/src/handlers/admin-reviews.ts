import { sha256Hex } from "@honor/core";
import type { BenefitChange, BenefitChangeSource, ChangeStatus } from "@honor/core";
import { BulkReviewConflictError } from "../shared/contracts.js";
import type {
  AppRepository,
  BulkReviewOperation,
  Clock,
} from "../shared/contracts.js";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import {
  HttpError,
  json,
  method,
  parseBody,
  requireAdmin,
  withHttpErrors,
} from "../shared/http.js";
import { inferReviewSource } from "../shared/ingestion.js";
import { repository, systemClock } from "../shared/runtime.js";

const STATUSES = new Set<ChangeStatus>(["AUTO_APPROVED", "PENDING", "APPROVED", "REJECTED", "PUBLISHED"]);
const REVIEW_SOURCES = new Set<BenefitChangeSource>(["MMA_FACILITIES", "MMA_NOTICES", "LAW_ORDINANCES"]);
const SOURCE_LABELS: Readonly<Record<BenefitChangeSource, string>> = {
  MMA_FACILITIES: "병무청 예우시설",
  MMA_NOTICES: "병무청 전국 혜택 공지",
  LAW_ORDINANCES: "법제처 지자체 조례",
};
const MAX_PAGE_SIZE = 25;
const MAX_BULK_COUNT = 2_500;
const MAX_BULK_CHUNK = 100;
const BULK_REVIEW_REASON = "INITIAL_BASELINE_BULK_APPROVAL";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function createAdminReviewsHandler(
  deps: { repository: AppRepository; clock?: Clock },
  env: NodeJS.ProcessEnv = process.env,
) {
  return (event: HttpEvent): Promise<HttpResult> => withHttpErrors(async () => {
    const admin = requireAdmin(event, env);
    if (method(event) === "GET") {
      if (event.rawPath.startsWith("/v1/admin/review-batches")) {
        const allChanges = await deps.repository.listChanges();
        const pending = allChanges.filter((change) => change.status === "PENDING");
        const groups = summarizePendingGroups(allChanges);
        const batchId = event.pathParameters?.batchId;
        if (batchId !== undefined) {
          if (!SHA256_PATTERN.test(batchId)) throw new HttpError(400, "batchId가 올바르지 않습니다.");
          const batch = groups.find((group) => group.batchId === batchId);
          if (!batch) throw new HttpError(404, "검수 배치를 찾을 수 없습니다.");
          const changes = pending
            .filter((change) => inferReviewSource(change) === batch.source && change.detectedAt === batch.detectedAt)
            .sort((a, b) => a.id.localeCompare(b.id));
          const limit = pageLimit(event.queryStringParameters?.limit);
          const cursor = event.queryStringParameters?.cursor;
          const cursorIndex = cursor === undefined ? -1 : changes.findIndex((change) => change.id === cursor);
          if (cursor !== undefined && cursorIndex < 0) throw new HttpError(400, "cursor가 현재 검수 배치에 없습니다.");
          const offset = cursorIndex + 1;
          const items = changes.slice(offset, offset + limit);
          const nextCursor = offset + items.length < changes.length ? items.at(-1)?.id : undefined;
          return json(200, { batch, items, total: changes.length, ...(nextCursor ? { nextCursor } : {}) });
        }
        return json(200, {
          groups,
          unclassifiedCount: pending.filter((change) => inferReviewSource(change) === undefined).length,
          generatedAt: (deps.clock ?? systemClock).now().toISOString(),
        });
      }
      const requested = event.queryStringParameters?.status;
      if (requested && !STATUSES.has(requested as ChangeStatus)) throw new HttpError(400, "status가 올바르지 않습니다.");
      const statuses = requested ? [requested as ChangeStatus] : ["PENDING" as const];
      const sorted = (await deps.repository.listChanges(statuses)).sort(compareChanges);
      const limit = pageLimit(event.queryStringParameters?.limit);
      const cursor = event.queryStringParameters?.cursor;
      const cursorIndex = cursor === undefined ? -1 : sorted.findIndex((change) => change.id === cursor);
      if (cursor !== undefined && cursorIndex < 0) throw new HttpError(400, "cursor가 현재 조회 결과에 없습니다.");
      const offset = cursorIndex + 1;
      const items = sorted.slice(offset, offset + limit);
      const nextCursor = offset + items.length < sorted.length ? items.at(-1)?.id : undefined;
      return json(200, { items, total: sorted.length, ...(nextCursor ? { nextCursor } : {}) });
    }

    if (method(event) === "POST") {
      const body = event.body ? parseBody(event) : {};
      if (event.rawPath.startsWith("/v1/admin/review-batches")) {
        if (!event.rawPath.endsWith("/approve")) throw new HttpError(405, "허용되지 않은 요청입니다.");
        const batchId = event.pathParameters?.batchId;
        if (!batchId) throw new HttpError(400, "batchId가 필요합니다.");
        return reviewBulkGroup(deps.repository, admin.email, batchId, body, (deps.clock ?? systemClock).now().toISOString());
      }
      const changeId = event.pathParameters?.reviewId || event.pathParameters?.id;
      if (!changeId) throw new HttpError(400, "reviewId가 필요합니다.");
      const pathDecision = event.rawPath.endsWith("/approve") ? "APPROVED"
        : event.rawPath.endsWith("/reject") ? "REJECTED" : undefined;
      const rawDecision = typeof body.decision === "string" ? body.decision.toUpperCase() : undefined;
      const decision = pathDecision || (rawDecision === "APPROVE" ? "APPROVED" : rawDecision === "REJECT" ? "REJECTED" : rawDecision);
      if (decision !== "APPROVED" && decision !== "REJECTED") {
        throw new HttpError(400, "decision은 APPROVED 또는 REJECTED여야 합니다.");
      }
      try {
        const reviewed: BenefitChange = await deps.repository.reviewChange(
          changeId,
          decision,
          admin.email,
          (deps.clock ?? systemClock).now().toISOString(),
        );
        return json(200, reviewed);
      } catch (error) {
        if (error instanceof Error && error.message.includes("no longer pending")) {
          throw new HttpError(409, "이미 처리되었거나 찾을 수 없는 변경입니다.");
        }
        throw error;
      }
    }

    throw new HttpError(405, "허용되지 않은 요청입니다.");
  });
}

interface ReviewGroupSummary {
  source: BenefitChangeSource;
  batchId: string;
  label: string;
  detectedAt: string;
  count: number;
  fingerprint: string;
  eligible: boolean;
  ineligibleReason?: string;
  confirmationPhrase: string;
  actionCounts: Record<BenefitChange["action"], number>;
  riskCounts: Record<BenefitChange["risk"], number>;
  samples: BenefitChange[];
}

interface BulkReviewRequest {
  source: BenefitChangeSource;
  detectedAt: string;
  expectedCount: number;
  fingerprint: string;
  confirmation: string;
  operationId: string;
}

export function summarizePendingGroups(changes: readonly BenefitChange[]): ReviewGroupSummary[] {
  const grouped = new Map<string, { source: BenefitChangeSource; detectedAt: string; items: BenefitChange[] }>();
  const detectedAtBySource = new Map<BenefitChangeSource, Set<string>>();
  for (const change of changes) {
    const source = inferReviewSource(change);
    if (!source) continue;
    const timestamps = detectedAtBySource.get(source) ?? new Set<string>();
    timestamps.add(change.detectedAt);
    detectedAtBySource.set(source, timestamps);
  }
  for (const change of changes) {
    if (change.status !== "PENDING") continue;
    const source = inferReviewSource(change);
    if (!source) continue;
    const key = `${source}\u0000${change.detectedAt}`;
    const group = grouped.get(key) ?? { source, detectedAt: change.detectedAt, items: [] };
    group.items.push(change);
    grouped.set(key, group);
  }

  return [...grouped.values()].map(({ source, detectedAt, items }) => {
    const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const count = sorted.length;
    const baselineEligible = sorted.every((change) => isEligibleBaselineChange(change, source, detectedAt));
    const onlyDetectedAtForSource = detectedAtBySource.get(source)?.size === 1
      && detectedAtBySource.get(source)?.has(detectedAt) === true;
    const eligible = count <= MAX_BULK_COUNT && baselineEligible && onlyDetectedAtForSource;
    const ineligibleReason = count > MAX_BULK_COUNT
      ? `한 번에 승인할 수 있는 최대 ${MAX_BULK_COUNT}건을 초과했습니다.`
      : !baselineEligible
        ? "같은 수집 시각의 변경에 초기 ADD가 아닌 항목이 섞여 있습니다."
        : !onlyDetectedAtForSource
          ? "이 원천에 다른 수집 시각의 변경 이력이 있어 초기 기준선으로 일괄 승인할 수 없습니다."
        : undefined;
    const fingerprint = fingerprintChangeIds(sorted.map((change) => change.id));
    return {
      source,
      batchId: fingerprint,
      label: SOURCE_LABELS[source],
      detectedAt,
      count,
      fingerprint,
      eligible,
      ...(ineligibleReason ? { ineligibleReason } : {}),
      confirmationPhrase: `APPROVE ${source} ${count}`,
      actionCounts: {
        ADD: sorted.filter((change) => change.action === "ADD").length,
        UPDATE: sorted.filter((change) => change.action === "UPDATE").length,
        DELETE: sorted.filter((change) => change.action === "DELETE").length,
      },
      riskCounts: {
        LOW: sorted.filter((change) => change.risk === "LOW").length,
        HIGH: sorted.filter((change) => change.risk === "HIGH").length,
      },
      samples: sorted.slice(0, 5),
    };
  }).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt) || a.source.localeCompare(b.source));
}

export function fingerprintChangeIds(changeIds: readonly string[]): string {
  return sha256Hex([...changeIds].sort().join("\n"));
}

async function reviewBulkGroup(
  repository: AppRepository,
  reviewer: string,
  batchId: string,
  body: Record<string, unknown>,
  at: string,
): Promise<HttpResult> {
  if (!SHA256_PATTERN.test(batchId)) throw new HttpError(400, "batchId가 올바르지 않습니다.");
  const request = parseBulkReviewRequest(body);
  if (request.fingerprint !== batchId) throw new HttpError(409, "batchId와 fingerprint가 일치하지 않습니다.");
  let operation = await repository.getBulkReviewOperation(request.operationId);

  if (operation) {
    assertMatchingOperation(operation, request, reviewer);
  } else {
    const allChanges = await repository.listChanges();
    const summary = summarizePendingGroups(allChanges).find((group) => group.batchId === batchId);
    if (!summary) {
      throw new HttpError(409, "검수 배치가 미리보기 이후 변경되었거나 더 이상 대기 중이 아닙니다.");
    }
    if (summary.source !== request.source
      || summary.detectedAt !== request.detectedAt
      || summary.count !== request.expectedCount
      || summary.fingerprint !== request.fingerprint) {
      throw new HttpError(409, "검수 배치 정보가 미리보기 이후 변경되었습니다. 새로고침 후 다시 확인해 주세요.");
    }
    if (!summary.eligible) {
      throw new HttpError(409, summary.ineligibleReason ?? "선택한 그룹은 안전한 초기 일괄 승인 조건을 충족하지 않습니다.");
    }
    const group = allChanges
      .filter((change) => change.status === "PENDING"
        && inferReviewSource(change) === summary.source
        && change.detectedAt === summary.detectedAt)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (group.length !== request.expectedCount) {
      throw new HttpError(409, "대기 건수가 미리보기 이후 변경되었습니다. 새로고침 후 다시 확인해 주세요.");
    }
    if (!group.length || group.length > MAX_BULK_COUNT) {
      throw new HttpError(409, `일괄 승인은 1건 이상 ${MAX_BULK_COUNT}건 이하만 가능합니다.`);
    }
    if (!group.every((change) => isEligibleBaselineChange(change, request.source, request.detectedAt))) {
      throw new HttpError(409, "선택한 그룹은 안전한 초기 일괄 승인 조건을 충족하지 않습니다.");
    }
    if (fingerprintChangeIds(group.map((change) => change.id)) !== request.fingerprint) {
      throw new HttpError(409, "변경 목록이 미리보기 이후 달라졌습니다. 새로고침 후 다시 확인해 주세요.");
    }
    operation = await repository.putBulkReviewOperation({
      id: request.operationId,
      source: request.source,
      detectedAt: request.detectedAt,
      fingerprint: request.fingerprint,
      expectedCount: request.expectedCount,
      changeIds: group.map((change) => change.id),
      reviewer,
      reason: BULK_REVIEW_REASON,
      status: "IN_PROGRESS",
      approvedCount: 0,
      createdAt: at,
      updatedAt: at,
    });
    assertMatchingOperation(operation, request, reviewer);
  }

  try {
    const result = await repository.approveBulkReviewChunk(operation.id, at, MAX_BULK_CHUNK);
    const remainingCount = result.operation.expectedCount - result.operation.approvedCount;
    return json(200, {
      operationId: result.operation.id,
      batchId: result.operation.fingerprint,
      source: result.operation.source,
      detectedAt: result.operation.detectedAt,
      expectedCount: result.operation.expectedCount,
      approvedCount: result.operation.approvedCount,
      processedCount: result.processedCount,
      remainingCount,
      complete: result.operation.status === "COMPLETED",
    });
  } catch (error) {
    if (error instanceof BulkReviewConflictError) {
      throw new HttpError(409, "일괄 승인 중 변경 상태가 달라졌습니다. 검수함을 새로고침해 현재 상태를 확인해 주세요.");
    }
    throw error;
  }
}

function parseBulkReviewRequest(body: Record<string, unknown>): BulkReviewRequest {
  const source = requiredString(body, "source", 32) as BenefitChangeSource;
  if (!REVIEW_SOURCES.has(source)) throw new HttpError(400, "source가 올바르지 않습니다.");
  const detectedAt = requiredString(body, "detectedAt", 40);
  if (!isExactIsoTimestamp(detectedAt)) throw new HttpError(400, "detectedAt이 올바른 ISO 시각이 아닙니다.");
  const expectedCount = body.expectedCount;
  if (!Number.isInteger(expectedCount) || (expectedCount as number) < 1 || (expectedCount as number) > MAX_BULK_COUNT) {
    throw new HttpError(400, `expectedCount는 1 이상 ${MAX_BULK_COUNT} 이하의 정수여야 합니다.`);
  }
  const fingerprint = requiredString(body, "fingerprint", 64);
  if (!SHA256_PATTERN.test(fingerprint)) throw new HttpError(400, "fingerprint가 올바르지 않습니다.");
  const operationId = requiredString(body, "operationId", 36);
  if (!UUID_PATTERN.test(operationId)) throw new HttpError(400, "operationId는 UUID여야 합니다.");
  const confirmation = requiredString(body, "confirmation", 80);
  const requiredConfirmation = `APPROVE ${source} ${expectedCount as number}`;
  if (confirmation !== requiredConfirmation) throw new HttpError(400, "확인 문구가 일치하지 않습니다.");
  return {
    source,
    detectedAt,
    expectedCount: expectedCount as number,
    fingerprint,
    operationId,
    confirmation,
  };
}

function assertMatchingOperation(
  operation: BulkReviewOperation,
  request: BulkReviewRequest,
  reviewer: string,
): void {
  if (operation.source !== request.source
    || operation.detectedAt !== request.detectedAt
    || operation.expectedCount !== request.expectedCount
    || operation.fingerprint !== request.fingerprint
    || operation.reviewer !== reviewer
    || operation.reason !== BULK_REVIEW_REASON) {
    throw new HttpError(409, "operationId가 다른 일괄 승인 요청에 이미 사용되었습니다.");
  }
  if (operation.changeIds.length !== operation.expectedCount
    || fingerprintChangeIds(operation.changeIds) !== operation.fingerprint) {
    throw new HttpError(409, "저장된 일괄 승인 작업의 무결성 검증에 실패했습니다.");
  }
}

function isEligibleBaselineChange(
  change: BenefitChange,
  source: BenefitChangeSource,
  detectedAt: string,
): boolean {
  return change.status === "PENDING"
    && change.risk === "HIGH"
    && change.action === "ADD"
    && change.before === undefined
    && change.after !== undefined
    && change.detectedAt === detectedAt
    && inferReviewSource(change) === source;
}

function compareChanges(a: BenefitChange, b: BenefitChange): number {
  return b.detectedAt.localeCompare(a.detectedAt) || a.id.localeCompare(b.id);
}

function pageLimit(value: string | undefined): number {
  if (value === undefined) return MAX_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new HttpError(400, `limit은 1 이상 ${MAX_PAGE_SIZE} 이하의 정수여야 합니다.`);
  }
  return parsed;
}

function requiredString(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HttpError(400, `${key} 값이 올바르지 않습니다.`);
  }
  return value.trim();
}

function isExactIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createAdminReviewsHandler({ repository: repository() })(event);
