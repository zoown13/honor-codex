import type {
  BenefitChange,
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
    const message = await response.text();
    throw new Error(message || `요청을 처리하지 못했습니다 (${response.status})`);
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
  const target = benefits[1];
  const ordinance = benefits.find((item) => item.type === "ORDINANCE");
  if (!target || !ordinance) return [];

  return [
    {
      id: "change-sample-001",
      benefitId: target.id,
      action: "UPDATE",
      risk: "HIGH",
      status: "PENDING",
      changedFields: ["amount", "constraints"],
      before: target,
      after: {
        ...target,
        amount: "기획공연별 10~30% 할인(원문 확인 필요)",
        constraints: ["공연별 대상 좌석이 다름", "대관공연 제외"]
      },
      detectedAt: "2026-07-12T01:30:00.000Z"
    },
    {
      id: "change-sample-002",

      benefitId: ordinance.id,
      action: "UPDATE",
      risk: "HIGH",
      status: "PENDING",
      changedFields: ["evidence", "validity"],
      before: ordinance,
      after: { ...ordinance, updatedAt: "2026-07-12T02:10:00.000Z" },
      detectedAt: "2026-07-12T02:10:00.000Z"
    }
  ];
}

export async function listPendingChanges(): Promise<BenefitChange[]> {
  if (!IS_MOCK_API) {
    const response = await apiRequest<BenefitChange[] | { items: BenefitChange[] }>(
      "/v1/admin/reviews?status=PENDING"
    );
    return Array.isArray(response) ? response : response.items;
  }

  const stored = readJson<BenefitChange[] | null>(CHANGES_KEY, null);
  if (stored) return stored;
  const changes = defaultChanges();
  writeJson(CHANGES_KEY, changes);
  return changes;
}

export async function reviewChange(id: string, decision: "approve" | "reject") {
  if (!IS_MOCK_API) {
    return apiRequest<BenefitChange>(`/v1/admin/reviews/${encodeURIComponent(id)}`, {
      method: "POST",
      body: JSON.stringify({ decision: decision === "approve" ? "APPROVED" : "REJECTED" })
    });
  }

  const now = new Date().toISOString();
  const reviewed = readJson<BenefitChange[]>(CHANGES_KEY, defaultChanges()).map((change) =>
    change.id === id
      ? {
          ...change,
          status: decision === "approve" ? ("APPROVED" as const) : ("REJECTED" as const),
          reviewedAt: now,
          reviewedBy: getSession()?.email ?? "owner"
        }
      : change
  );
  writeJson(CHANGES_KEY, reviewed);
  return reviewed.find((change) => change.id === id);
}

export async function publishApprovedChanges(): Promise<{
  publishedChanges: number;
  deploymentJobId?: string;
  deploymentSkipped?: boolean;
}> {
  if (!IS_MOCK_API) {
    return apiRequest("/v1/admin/publish", { method: "POST" });
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  const changes = readJson<BenefitChange[]>(CHANGES_KEY, defaultChanges());
  const approved = changes.filter((change) =>
    change.status === "APPROVED" || change.status === "AUTO_APPROVED");
  writeJson(
    CHANGES_KEY,
    changes.map((change) => approved.some((item) => item.id === change.id)
      ? { ...change, status: "PUBLISHED" as const, publishedAt: new Date().toISOString() }
      : change)
  );
  return { publishedChanges: approved.length, deploymentSkipped: true };
}
