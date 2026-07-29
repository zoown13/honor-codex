import type {
  Benefit,
  BenefitChange,
  ChangeAction,
  ChangeRisk,
  NotificationChannel,
  Subscription,
  SubscriptionCadence,
  SubscriptionTargetType
} from "@honor/core";
import { benefits } from "../data/sample-benefits";
import { API_BASE_URL, IS_MOCK_API } from "./config";

const SESSION_KEY = "honor-pilot-session";
const PILOT_ADMIN_ACCESS_KEY = "honor-pilot-admin-access";
const SUBSCRIPTIONS_KEY = "honor-pilot-subscriptions";
const CHANGES_KEY = "honor-pilot-review-changes";
const ACTIVE_REVIEW_OPERATION_KEY = "honor-pilot-active-review-operation";
const MOCK_REVIEW_OPERATIONS_KEY = "honor-pilot-mock-review-operations";

export const REVIEW_SOURCES = [
  "MMA_FACILITIES",
  "MMA_NOTICES",
  "LAW_ORDINANCES"
] as const;

export type ReviewSource = (typeof REVIEW_SOURCES)[number];

export interface AuthSession {
  accessToken: string;
  idToken: string;
  userId: string;
  email: string;
  isAdmin: boolean;
}

export interface OtpChallenge {
  challengeId: string;
  destinationHint: string;
}

export interface CreateSubscriptionInput {
  targetType: SubscriptionTargetType;
  targetId: string;
  cadence: SubscriptionCadence;
  channels: NotificationChannel[];
}

export type ReviewListBenefit = Pick<Benefit, "id" | "type" | "title" | "provider" | "source" | "summaryProvenance">;
export type ReviewListChange = Pick<
  BenefitChange,
  "id" | "benefitId" | "action" | "risk" | "status" | "detectedAt" | "source"
> & { before?: ReviewListBenefit; after?: ReviewListBenefit };

export interface ReviewSummaryGroup {
  source: ReviewSource;
  label: string;
  detectedAt: string;
  batchId: string;
  count: number;
  fingerprint: string;
  eligible: boolean;
  approvalKind?: "INITIAL_BASELINE" | "AI_SUMMARY";
  ineligibleReason?: string;
  confirmationPhrase: string;
  actionCounts: Record<ChangeAction, number>;
  riskCounts: Record<ChangeRisk, number>;
  samples: ReviewListChange[];
}

export interface ReviewSummaryResponse {
  groups: ReviewSummaryGroup[];
  unclassifiedCount: number;
  generatedAt?: string;
}

export interface ReviewBatchPage {
  batch?: ReviewSummaryGroup;
  items: ReviewListChange[];
  total: number;
  nextCursor?: string;
}

export interface BulkReviewInput {
  source: ReviewSource;
  batchId: string;
  detectedAt: string;
  expectedCount: number;
  fingerprint: string;
  confirmation: string;
  operationId: string;
}

export interface BulkReviewProgress {
  operationId: string;
  source: ReviewSource;
  detectedAt: string;
  expectedCount: number;
  approvedCount: number;
  processedCount: number;
  remainingCount: number;
  complete: boolean;
}

export interface ActiveReviewOperation extends BulkReviewInput {
  label: string;
  confirmationPhrase: string;
  approvedCount: number;
  remainingCount: number;
  startedAt: string;
}

export interface PublicationOperationView {
  id: string;
  publishSources: ReviewSource[];
  status: "PREPARING" | "STAGED" | "DEPLOYING" | "DEPLOYED" | "COMPLETED" | "FAILED";
  changeIds: string[];
  createdAt: string;
  updatedAt: string;
  deploymentJobId?: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
}

export interface PublishStatusResponse {
  sources: Record<ReviewSource, { pending: number; approved: number }>;
  approvedCount: number;
  pendingCount: number;
  confirmationPhrase: string;
  canPublish: boolean;
  operation?: PublicationOperationView;
}

export interface OrdinanceSummaryJobView {
  id: string;
  modelId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED";
  candidatePoolCount: number;
  total: number;
  queuedCount: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
  error?: string;
}

export interface OrdinanceSummaryStatusResponse {
  modelId: string;
  job?: OrdinanceSummaryJobView;
  estimate: {
    itemCount: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostUsd: number;
  };
  candidatePoolCount: number;
  sampleSize: number;
  actualCostUsd: number;
  confirmationPhrase: string;
  ordinanceChangesAwaitingPublish: number;
  maxJobCostUsd: number;
  canStart: boolean;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

function storageAvailable() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(key: string, fallback: T): T {
  if (!storageAvailable()) return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (storageAvailable()) window.localStorage.setItem(key, JSON.stringify(value));
}

function makeId(prefix: string) {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `${prefix}-${value}`;
}

function responseMessage(raw: string, status: number) {
  if (!raw) return `요청을 처리하지 못했습니다 (${status})`;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Plain-text error responses are already suitable for display.
  }
  return raw;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = getSession();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Authorization: `Bearer ${session.idToken || session.accessToken}` } : {}),
      ...init.headers
    }
  });

  if (!response.ok) {
    const message = responseMessage(await response.text(), response.status);
    if (response.status === 401) clearSession();
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function pilotAdminAccess() {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") return "";
  return window.sessionStorage.getItem(PILOT_ADMIN_ACCESS_KEY)?.trim() ?? "";
}

export function setPilotAdminAccess(value: string) {
  if (typeof window !== "undefined" && typeof window.sessionStorage !== "undefined") {
    window.sessionStorage.setItem(PILOT_ADMIN_ACCESS_KEY, value.trim());
  }
}

export function clearPilotAdminAccess() {
  if (typeof window !== "undefined" && typeof window.sessionStorage !== "undefined") {
    window.sessionStorage.removeItem(PILOT_ADMIN_ACCESS_KEY);
  }
}

async function pilotAdminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const access = pilotAdminAccess();
  if (!access) throw new ApiError(401, "관리자 암호를 입력해 주세요.");
  return apiRequest<T>(path, {
    ...init,
    headers: {
      "X-Honor-Pilot-Admin": access,
      ...init.headers
    }
  });
}

export function getSession() {
  return readJson<AuthSession | null>(SESSION_KEY, null);
}

export function clearSession() {
  if (storageAvailable()) window.localStorage.removeItem(SESSION_KEY);
}

export async function startOtp(email: string): Promise<OtpChallenge> {
  if (!IS_MOCK_API) {
    return apiRequest<OtpChallenge>("/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email })
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  return { challengeId: makeId("challenge"), destinationHint: email.replace(/(^.).*(@.*$)/, "$1•••$2") };
}

export async function verifyOtp(
  email: string,
  code: string,
  challengeId: string
): Promise<AuthSession> {
  let session: AuthSession;

  if (!IS_MOCK_API) {
    session = await apiRequest<AuthSession>("/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email, code, challengeId })
    });
  } else {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (code !== "123456") throw new Error("인증번호가 올바르지 않습니다.");
    session = {
      accessToken: `mock-token-${challengeId}`,
      idToken: `mock-id-token-${challengeId}`,
      userId: `mock:${email.toLocaleLowerCase()}`,
      email,
      isAdmin: email.toLocaleLowerCase() === "owner@example.com"
    };
  }

  writeJson(SESSION_KEY, session);
  return session;
}

export async function listSubscriptions(): Promise<Subscription[]> {
  if (!IS_MOCK_API) {
    const response = await apiRequest<Subscription[] | { items: Subscription[] }>(
      "/v1/me/subscriptions"
    );
    return Array.isArray(response) ? response : response.items;
  }
  return readJson<Subscription[]>(SUBSCRIPTIONS_KEY, []);
}

export async function createSubscription(
  input: CreateSubscriptionInput
): Promise<Subscription> {
  if (!IS_MOCK_API) {
    return apiRequest<Subscription>("/v1/me/subscriptions", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }

  const session = getSession();
  if (!session) throw new Error("이메일 인증이 필요합니다.");
  const now = new Date().toISOString();
  const subscription: Subscription = {
    id: makeId("subscription"),
    userId: session.userId,
    ...input,
    createdAt: now,
    updatedAt: now
  };
  const current = readJson<Subscription[]>(SUBSCRIPTIONS_KEY, []);
  const withoutDuplicate = current.filter(
    (item) => !(item.targetType === input.targetType && item.targetId === input.targetId)
  );
  writeJson(SUBSCRIPTIONS_KEY, [subscription, ...withoutDuplicate]);
  return subscription;
}

export async function removeSubscription(id: string) {
  if (!IS_MOCK_API) {
    await apiRequest<void>(`/v1/me/subscriptions/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
    return;
  }
  writeJson(
    SUBSCRIPTIONS_KEY,
    readJson<Subscription[]>(SUBSCRIPTIONS_KEY, []).filter((item) => item.id !== id)
  );
}

export async function savePushSubscription(subscription: PushSubscriptionJSON) {
  if (!IS_MOCK_API) {
    await apiRequest<void>("/v1/me/push-subscriptions", {
      method: "POST",
      body: JSON.stringify(subscription)
    });
  }
}

export async function deleteAccount() {
  if (!IS_MOCK_API) await apiRequest<void>("/v1/me/account", { method: "DELETE" });
  if (storageAvailable()) {
    window.localStorage.removeItem(SESSION_KEY);
    window.localStorage.removeItem(SUBSCRIPTIONS_KEY);
  }
}

function defaultChanges(): BenefitChange[] {
  const facility = benefits.find((item) => item.type === "FACILITY");
  const national = benefits.find((item) => item.type === "NATIONAL");
  const ordinance = benefits.find((item) => item.type === "ORDINANCE");
  if (!facility || !national || !ordinance) return [];

  return [facility, national, ordinance].map((benefit, index) => ({
    id: `change-sample-00${index + 1}`,
    benefitId: benefit.id,
    action: "ADD" as const,
    risk: "HIGH" as const,
    status: "PENDING" as const,
    changedFields: ["title", "provider", "amount", "source"],
    after: benefit,
    detectedAt: "2026-07-14T03:00:00.000Z"
  }));
}

function storedChanges() {
  const stored = readJson<BenefitChange[] | null>(CHANGES_KEY, null);
  if (stored) return stored;
  const changes = defaultChanges();
  writeJson(CHANGES_KEY, changes);
  return changes;
}

function reviewSource(change: BenefitChange): ReviewSource | undefined {
  const current = change.after ?? change.before;
  if (current?.type === "FACILITY") return "MMA_FACILITIES";
  if (current?.type === "NATIONAL") return "MMA_NOTICES";
  if (current?.type === "ORDINANCE") return "LAW_ORDINANCES";
  return undefined;
}

const REVIEW_SOURCE_LABEL: Record<ReviewSource, string> = {
  MMA_FACILITIES: "병무청 예우시설",
  MMA_NOTICES: "병무청 전국 혜택 공지",
  LAW_ORDINANCES: "법제처 지자체 조례"
};

function mockFingerprint(changes: readonly BenefitChange[]) {
  const source = [...changes].map((change) => change.id).sort().join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

function mockReviewSummary(): ReviewSummaryResponse {
  const pending = storedChanges().filter((change) => change.status === "PENDING");
  const grouped = new Map<string, BenefitChange[]>();

  for (const change of pending) {
    const source = reviewSource(change);
    if (!source) continue;
    const key = `${source}|${change.detectedAt}`;
    grouped.set(key, [...(grouped.get(key) ?? []), change]);
  }

  const groups = [...grouped.values()].map((changes): ReviewSummaryGroup => {
    const first = changes[0]!;
    const source = reviewSource(first)!;
    const actionCounts: Record<ChangeAction, number> = { ADD: 0, UPDATE: 0, DELETE: 0 };
    const riskCounts: Record<ChangeRisk, number> = { LOW: 0, HIGH: 0 };
    for (const change of changes) {
      actionCounts[change.action] += 1;
      riskCounts[change.risk] += 1;
    }
    const eligible = changes.length <= 2_500 && changes.every(
      (change) => change.status === "PENDING" && change.risk === "HIGH" &&
        change.action === "ADD" && !change.before && Boolean(change.after)
    );
    return {
      source,
      label: REVIEW_SOURCE_LABEL[source],
      detectedAt: first.detectedAt,
      count: changes.length,
      batchId: mockFingerprint(changes),
      fingerprint: mockFingerprint(changes),
      eligible,
      ...(!eligible ? { ineligibleReason: "안전한 초기 신규 데이터 조건을 충족하지 않습니다." } : {}),
      confirmationPhrase: `APPROVE ${source} ${changes.length}`,
      actionCounts,
      riskCounts,
      samples: changes.slice(0, 5)
    };
  });

  return {
    groups: groups.sort((left, right) => {
      const sourceOrder = REVIEW_SOURCES.indexOf(left.source) - REVIEW_SOURCES.indexOf(right.source);
      return sourceOrder || right.detectedAt.localeCompare(left.detectedAt);
    }),
    unclassifiedCount: pending.filter((change) => reviewSource(change) === undefined).length,
    generatedAt: new Date().toISOString()
  };
}

export async function getReviewSummary(): Promise<ReviewSummaryResponse> {
  if (!IS_MOCK_API) return pilotAdminRequest<ReviewSummaryResponse>("/v1/pilot-admin/review-batches");
  return mockReviewSummary();
}

export async function getReviewChange(changeId: string): Promise<BenefitChange> {
  if (!IS_MOCK_API) {
    return pilotAdminRequest<BenefitChange>(`/v1/pilot-admin/reviews/${encodeURIComponent(changeId)}`);
  }
  const change = storedChanges().find((item) => item.id === changeId);
  if (!change) throw new ApiError(404, "검수 변경을 찾을 수 없습니다.");
  return change;
}

export async function getReviewBatchPage(
  batch: Pick<ReviewSummaryGroup, "batchId" | "source" | "detectedAt" | "count">,
  cursor?: string,
  limit = 25,
): Promise<ReviewBatchPage> {
  if (!IS_MOCK_API) {
    const query = new URLSearchParams({
      limit: String(limit),
      source: batch.source,
      detectedAt: batch.detectedAt,
      total: String(batch.count),
    });
    if (cursor) query.set("cursor", cursor);
    return pilotAdminRequest<ReviewBatchPage>(
      `/v1/pilot-admin/review-batches/${encodeURIComponent(batch.batchId)}?${query.toString()}`,
    );
  }

  const mockBatch = mockReviewSummary().groups.find((group) => group.batchId === batch.batchId);
  if (!mockBatch) throw new ApiError(404, "검수 배치를 찾을 수 없습니다.");
  const changes = storedChanges()
    .filter((change) => change.status === "PENDING"
      && reviewSource(change) === mockBatch.source
      && change.detectedAt === mockBatch.detectedAt)
    .sort((left, right) => left.id.localeCompare(right.id));
  const cursorIndex = cursor === undefined ? -1 : changes.findIndex((change) => change.id === cursor);
  if (cursor !== undefined && cursorIndex < 0) throw new ApiError(400, "cursor가 현재 검수 배치에 없습니다.");
  const offset = cursorIndex + 1;
  const items = changes.slice(offset, offset + limit);
  const nextCursor = offset + items.length < changes.length ? items.at(-1)?.id : undefined;
  return { batch: mockBatch, items, total: changes.length, ...(nextCursor ? { nextCursor } : {}) };
}

interface MockReviewOperation {
  input: BulkReviewInput;
  approvedCount: number;
  complete: boolean;
}

export async function approveReviewChunk(input: BulkReviewInput): Promise<BulkReviewProgress> {
  if (!IS_MOCK_API) {
    return pilotAdminRequest<BulkReviewProgress>(`/v1/pilot-admin/review-batches/${encodeURIComponent(input.batchId)}/approve`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  const operations = readJson<Record<string, MockReviewOperation>>(MOCK_REVIEW_OPERATIONS_KEY, {});
  const storedOperation = operations[input.operationId];
  if (storedOperation?.complete) {
    return {
      operationId: input.operationId,
      source: input.source,
      detectedAt: input.detectedAt,
      expectedCount: input.expectedCount,
      approvedCount: storedOperation.approvedCount,
      processedCount: 0,
      remainingCount: 0,
      complete: true
    };
  }

  const matching = storedChanges().filter((change) =>
    change.status === "PENDING" && reviewSource(change) === input.source && change.detectedAt === input.detectedAt
  );
  if (!storedOperation) {
    const fingerprint = mockFingerprint(matching);
    const expectedPhrase = `APPROVE ${input.source} ${input.expectedCount}`;
    if (input.batchId !== fingerprint || matching.length !== input.expectedCount || fingerprint !== input.fingerprint) {
      throw new ApiError(409, "검수 집계가 변경되었습니다. 새로고침 후 다시 확인해 주세요.");
    }
    if (input.confirmation !== expectedPhrase) {
      throw new ApiError(400, "확인 문구가 일치하지 않습니다.");
    }
  }

  const batch = matching.slice(0, 100);
  const batchIds = new Set(batch.map((change) => change.id));
  const now = new Date().toISOString();
  writeJson(CHANGES_KEY, storedChanges().map((change) => batchIds.has(change.id) ? {
    ...change,
    status: "APPROVED" as const,
    reviewedAt: now,
    reviewedBy: getSession()?.email ?? "owner"
  } : change));

  const approvedCount = (storedOperation?.approvedCount ?? 0) + batch.length;
  const remainingCount = Math.max(0, input.expectedCount - approvedCount);
  const complete = remainingCount === 0;
  operations[input.operationId] = { input, approvedCount, complete };
  writeJson(MOCK_REVIEW_OPERATIONS_KEY, operations);

  return {
    operationId: input.operationId,
    source: input.source,
    detectedAt: input.detectedAt,
    expectedCount: input.expectedCount,
    approvedCount,
    processedCount: batch.length,
    remainingCount,
    complete
  };
}

export async function getPublishStatus(): Promise<PublishStatusResponse> {
  if (!IS_MOCK_API) return pilotAdminRequest<PublishStatusResponse>("/v1/pilot-admin/publish");
  const changes = storedChanges();
  const sources = Object.fromEntries(REVIEW_SOURCES.map((source) => {
    const scoped = changes.filter((change) => reviewSource(change) === source);
    return [source, {
      pending: scoped.filter((change) => change.status === "PENDING").length,
      approved: scoped.filter((change) => change.status === "APPROVED" || change.status === "AUTO_APPROVED").length
    }];
  })) as PublishStatusResponse["sources"];
  const approvedCount = Object.values(sources).reduce((total, value) => total + value.approved, 0);
  const pendingCount = Object.values(sources).reduce((total, value) => total + value.pending, 0);
  return {
    sources,
    approvedCount,
    pendingCount,
    confirmationPhrase: `PUBLISH ${approvedCount}`,
    canPublish: approvedCount > 0 && pendingCount === 0,
    ...readJson<{ operation?: PublicationOperationView }>("honor-pilot-publish-operation", {})
  };
}

export async function startPublish(
  sources: ReviewSource[],
  confirmation: string,
): Promise<{ message: string; operation: PublicationOperationView }> {
  if (!IS_MOCK_API) {
    return pilotAdminRequest("/v1/pilot-admin/publish", {
      method: "POST",
      body: JSON.stringify({ sources, confirmation })
    });
  }
  const selected = storedChanges().filter((change) => {
    const source = reviewSource(change);
    return source !== undefined && sources.includes(source)
      && (change.status === "APPROVED" || change.status === "AUTO_APPROVED");
  });
  if (confirmation !== `PUBLISH ${selected.length}`) throw new ApiError(400, "확인 문구가 일치하지 않습니다.");
  const now = new Date().toISOString();
  writeJson(CHANGES_KEY, storedChanges().map((change) => selected.some((item) => item.id === change.id)
    ? { ...change, status: "PUBLISHED" as const, publishedAt: now }
    : change));
  const operation: PublicationOperationView = {
    id: makeId("pub"),
    publishSources: sources,
    status: "COMPLETED",
    changeIds: selected.map((change) => change.id),
    createdAt: now,
    updatedAt: now,
    completedAt: now
  };
  writeJson("honor-pilot-publish-operation", { operation });
  return { message: "게시를 완료했습니다.", operation };
}

export async function getOrdinanceSummaryStatus(): Promise<OrdinanceSummaryStatusResponse> {
  if (!IS_MOCK_API) {
    return pilotAdminRequest<OrdinanceSummaryStatusResponse>("/v1/pilot-admin/ordinance-summaries");
  }
  const ordinances = benefits.filter((benefit) => benefit.type === "ORDINANCE" && !benefit.summaryProvenance);
  const sample = ordinances.slice(0, 10);
  const estimate = {
    itemCount: sample.length,
    estimatedInputTokens: sample.length * 1_000,
    estimatedOutputTokens: sample.length * 600,
    estimatedCostUsd: sample.length ? 0.03 : 0
  };
  const stored = readJson<{ job?: OrdinanceSummaryJobView }>("honor-pilot-summary-job", {});
  const ordinanceChangesAwaitingPublish = storedChanges().filter((change) =>
    reviewSource(change) === "LAW_ORDINANCES" && ["PENDING", "APPROVED", "AUTO_APPROVED"].includes(change.status)
  ).length;
  return {
    modelId: "global.amazon.nova-2-lite-v1:0",
    ...stored,
    estimate,
    candidatePoolCount: ordinances.length,
    sampleSize: sample.length,
    actualCostUsd: stored.job ? stored.job.estimatedCostUsd : 0,
    confirmationPhrase: `SUMMARIZE ${estimate.itemCount}`,
    ordinanceChangesAwaitingPublish,
    maxJobCostUsd: 5,
    canStart: estimate.itemCount > 0 && !stored.job && ordinanceChangesAwaitingPublish === 0
  };
}

export async function startOrdinanceSummary(
  confirmation: string,
  maxCostUsd: number,
): Promise<{ message: string; job: OrdinanceSummaryJobView }> {
  if (!IS_MOCK_API) {
    return pilotAdminRequest("/v1/pilot-admin/ordinance-summaries", {
      method: "POST",
      body: JSON.stringify({ confirmation, maxCostUsd })
    });
  }
  const status = await getOrdinanceSummaryStatus();
  if (confirmation !== status.confirmationPhrase) throw new ApiError(400, "확인 문구가 일치하지 않습니다.");
  const now = new Date().toISOString();
  const job: OrdinanceSummaryJobView = {
    id: makeId("aisum"),
    modelId: status.modelId,
    status: "COMPLETED",
    candidatePoolCount: status.candidatePoolCount,
    total: status.estimate.itemCount,
    queuedCount: status.estimate.itemCount,
    processedCount: status.estimate.itemCount,
    succeededCount: status.estimate.itemCount,
    failedCount: 0,
    inputTokens: status.estimate.estimatedInputTokens,
    outputTokens: status.estimate.estimatedOutputTokens,
    estimatedCostUsd: Math.min(maxCostUsd, status.estimate.estimatedCostUsd),
    createdAt: now,
    updatedAt: now,
    completedAt: now
  };
  writeJson("honor-pilot-summary-job", { job });
  return { message: "조례 AI 정제를 완료했습니다.", job };
}

export function createReviewOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getActiveReviewOperation() {
  return readJson<ActiveReviewOperation | null>(ACTIVE_REVIEW_OPERATION_KEY, null);
}

export function saveActiveReviewOperation(operation: ActiveReviewOperation) {
  writeJson(ACTIVE_REVIEW_OPERATION_KEY, operation);
}

export function clearActiveReviewOperation() {
  if (storageAvailable()) window.localStorage.removeItem(ACTIVE_REVIEW_OPERATION_KEY);
}

export async function listPendingChanges(): Promise<BenefitChange[]> {
  if (!IS_MOCK_API) {
    const response = await pilotAdminRequest<BenefitChange[] | { items: BenefitChange[] }>(
      "/v1/pilot-admin/reviews?status=PENDING&limit=100"
    );
    return Array.isArray(response) ? response : response.items;
  }
  return storedChanges().filter((change) => change.status === "PENDING");
}

export async function reviewChange(id: string, decision: "approve" | "reject") {
  if (!IS_MOCK_API) {
    return pilotAdminRequest<BenefitChange>(`/v1/pilot-admin/reviews/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision: decision === "approve" ? "APPROVED" : "REJECTED" })
    });
  }

  const now = new Date().toISOString();
  const reviewed = storedChanges().map((change) => change.id === id ? {
    ...change,
    status: decision === "approve" ? ("APPROVED" as const) : ("REJECTED" as const),
    reviewedAt: now,
    reviewedBy: getSession()?.email ?? "owner"
  } : change);
  writeJson(CHANGES_KEY, reviewed);
  return reviewed.find((change) => change.id === id);
}
