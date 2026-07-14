import type {
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

export interface ReviewSummaryGroup {
  source: ReviewSource;
  label: string;
  detectedAt: string;
  batchId: string;
  count: number;
  fingerprint: string;
  eligible: boolean;
  ineligibleReason?: string;
  confirmationPhrase: string;
  actionCounts: Record<ChangeAction, number>;
  riskCounts: Record<ChangeRisk, number>;
  samples: BenefitChange[];
}

export interface ReviewSummaryResponse {
  groups: ReviewSummaryGroup[];
  unclassifiedCount: number;
  generatedAt?: string;
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
  if (!IS_MOCK_API) return apiRequest<ReviewSummaryResponse>("/v1/admin/review-batches");
  return mockReviewSummary();
}

interface MockReviewOperation {
  input: BulkReviewInput;
  approvedCount: number;
  complete: boolean;
}

export async function approveReviewChunk(input: BulkReviewInput): Promise<BulkReviewProgress> {
  if (!IS_MOCK_API) {
    return apiRequest<BulkReviewProgress>(`/v1/admin/review-batches/${encodeURIComponent(input.batchId)}/approve`, {
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
    const response = await apiRequest<BenefitChange[] | { items: BenefitChange[] }>(
      "/v1/admin/reviews?status=PENDING&limit=25"
    );
    return Array.isArray(response) ? response : response.items;
  }
  return storedChanges().filter((change) => change.status === "PENDING");
}

export async function reviewChange(id: string, decision: "approve" | "reject") {
  if (!IS_MOCK_API) {
    return apiRequest<BenefitChange>(`/v1/admin/reviews/${encodeURIComponent(id)}`, {
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
