import {
  clearSession,
  createSubscription,
  getSession,
  listSubscriptions,
  removeSubscription,
  startOtp,
  verifyOtp
} from "../lib/api";

describe("mock subscription adapter", () => {
  beforeEach(() => localStorage.clear());

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
});
