import {
  approveReviewChunk,
  clearActiveReviewOperation,
  clearSession,
  createReviewOperationId,
  createSubscription,
  getActiveReviewOperation,
  getReviewSummary,
  getSession,
  listSubscriptions,
  removeSubscription,
  saveActiveReviewOperation,
  startOtp,
  verifyOtp,
  type ActiveReviewOperation
} from "../lib/api";
import { API_BASE_URL, IS_MOCK_API } from "../lib/config";

describe("mock subscription adapter", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("never uses the deployed API during unit tests", async () => {
    expect(API_BASE_URL).toBe("");
    expect(IS_MOCK_API).toBe(true);
    await startOtp("pilot@example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires the pilot OTP and persists a session", async () => {
    const challenge = await startOtp("pilot@example.com");
    await expect(verifyOtp("pilot@example.com", "000000", challenge.challengeId)).rejects.toThrow();
    const session = await verifyOtp("pilot@example.com", "123456", challenge.challengeId);
    expect(getSession()).toEqual(session);
    clearSession();
    expect(getSession()).toBeNull();
  });

  it("creates, replaces, and removes an idempotent target subscription", async () => {
    const challenge = await startOtp("pilot@example.com");
    await verifyOtp("pilot@example.com", "123456", challenge.challengeId);
    const first = await createSubscription({
      targetType: "REGION",
      targetId: "SEOUL",
      cadence: "WEEKLY",
      channels: ["EMAIL"]
    });
    await createSubscription({
      targetType: "REGION",
      targetId: "SEOUL",
      cadence: "WEEKLY",
      channels: ["EMAIL"]
    });
    expect(await listSubscriptions()).toHaveLength(1);
    await removeSubscription((await listSubscriptions())[0]!.id);
    expect(await listSubscriptions()).toEqual([]);
    expect(first.targetId).toBe("SEOUL");
  });

  it("summarizes small source samples and idempotently approves one source batch", async () => {
    const session = await verifyOtp("owner@example.com", "123456", "mock-owner-challenge");
    expect(session.isAdmin).toBe(true);

    const summary = await getReviewSummary();
    expect(summary.groups.map((group) => group.source)).toEqual([
      "MMA_FACILITIES",
      "MMA_NOTICES",
      "LAW_ORDINANCES"
    ]);
    expect(summary.groups.every((group) => group.samples.length <= 5)).toBe(true);

    const group = summary.groups[0]!;
    expect(group.batchId).toMatch(/^[0-9a-f]{64}$/);
    expect(group.fingerprint).toBe(group.batchId);
    const operationId = createReviewOperationId();
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/i);
    const input = {
      source: group.source,
      batchId: group.batchId,
      detectedAt: group.detectedAt,
      expectedCount: group.count,
      fingerprint: group.fingerprint,
      confirmation: group.confirmationPhrase,
      operationId
    };
    const active: ActiveReviewOperation = {
      ...input,
      label: group.label,
      confirmationPhrase: group.confirmationPhrase,
      approvedCount: 0,
      remainingCount: group.count,
      startedAt: "2026-07-14T03:01:00.000Z"
    };
    saveActiveReviewOperation(active);
    expect(getActiveReviewOperation()?.operationId).toBe(operationId);

    const first = await approveReviewChunk(input);
    expect(first).toMatchObject({ approvedCount: 1, remainingCount: 0, complete: true });
    const replay = await approveReviewChunk(input);
    expect(replay).toMatchObject({ approvedCount: 1, processedCount: 0, complete: true });
    expect((await getReviewSummary()).groups.some((item) => item.source === group.source)).toBe(false);

    clearActiveReviewOperation();
    expect(getActiveReviewOperation()).toBeNull();
  });
});
