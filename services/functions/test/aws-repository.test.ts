import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoAppRepository } from "../src/shared/aws-repository.js";

describe("DynamoAppRepository publication finalization", () => {
  it("deduplicates IDs, writes 25-item transactions, and paces successful chunks", async () => {
    const send = vi.fn(async (_command: unknown): Promise<unknown> => ({}));
    const sleep = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
    const repository = new DynamoAppRepository({
      tableName: "pilot-table",
      client: fakeClient(send),
      sleep,
      random: () => 0.5,
    });
    const ids = Array.from({ length: 52 }, (_, index) => `change-${index}`);

    await repository.markChangesPublished([...ids, ids[0]!], "2026-07-15T00:00:00Z", "pub:test");

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([command]) => transactionInput(command).TransactItems?.length))
      .toEqual([25, 25, 2]);
    expect(sleep.mock.calls).toEqual([[200], [200]]);
    const tokens = send.mock.calls.map(([command]) => transactionInput(command).ClientRequestToken);
    expect(tokens.every((token) => token?.length === 36)).toBe(true);
    expect(new Set(tokens).size).toBe(3);
  });

  it("retries a throttled transaction with the same idempotency token", async () => {
    const throttled = namedError("ThrottlingException");
    const send = vi.fn(async (_command: unknown): Promise<unknown> => ({}));
    send.mockRejectedValueOnce(throttled);
    const sleep = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
    const repository = new DynamoAppRepository({
      tableName: "pilot-table",
      client: fakeClient(send),
      sleep,
      random: () => 0.5,
    });

    await repository.markChangesPublished(["change-1"], "2026-07-15T00:00:00Z", "pub:test");

    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(50);
    expect(transactionInput(send.mock.calls[0]![0]).ClientRequestToken)
      .toBe(transactionInput(send.mock.calls[1]![0]).ClientRequestToken);
  });

  it("retries only retryable transaction cancellation reasons", async () => {
    const retryable = namedError("TransactionCanceledException", [
      { Code: "None" },
      { Code: "TransactionConflict" },
    ]);
    const retrySend = vi.fn(async (_command: unknown): Promise<unknown> => ({}));
    retrySend.mockRejectedValueOnce(retryable);
    const retrySleep = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
    const retryRepository = new DynamoAppRepository({
      tableName: "pilot-table",
      client: fakeClient(retrySend),
      sleep: retrySleep,
      random: () => 0,
    });

    await retryRepository.markChangesPublished(["change-1"], "2026-07-15T00:00:00Z", "pub:test");
    expect(retrySend).toHaveBeenCalledTimes(2);

    const conditional = namedError("TransactionCanceledException", [
      { Code: "ConditionalCheckFailed" },
      { Code: "ThrottlingError" },
    ]);
    const conditionalSend = vi.fn(async (_command: unknown): Promise<unknown> => ({}));
    conditionalSend.mockRejectedValueOnce(conditional);
    const conditionalRepository = new DynamoAppRepository({
      tableName: "pilot-table",
      client: fakeClient(conditionalSend),
      sleep: retrySleep,
    });

    await expect(conditionalRepository.markChangesPublished(
      ["change-1"],
      "2026-07-15T00:00:00Z",
      "pub:test",
    )).rejects.toBe(conditional);
    expect(conditionalSend).toHaveBeenCalledOnce();
  });

  it("stops after eight throttle attempts", async () => {
    const throttled = namedError("ProvisionedThroughputExceededException");
    const send = vi.fn(async (_command: unknown): Promise<unknown> => ({}));
    send.mockRejectedValue(throttled);
    const sleep = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
    const repository = new DynamoAppRepository({
      tableName: "pilot-table",
      client: fakeClient(send),
      sleep,
      random: () => 0.5,
    });

    await expect(repository.markChangesPublished(
      ["change-1"],
      "2026-07-15T00:00:00Z",
      "pub:test",
    )).rejects.toBe(throttled);
    expect(send).toHaveBeenCalledTimes(8);
    expect(sleep).toHaveBeenCalledTimes(7);
  });
});

function fakeClient(send: ReturnType<typeof vi.fn>): DynamoDBDocumentClient {
  return { send } as unknown as DynamoDBDocumentClient;
}

function transactionInput(command: unknown): TransactWriteCommand["input"] {
  expect(command).toBeInstanceOf(TransactWriteCommand);
  return (command as TransactWriteCommand).input;
}

function namedError(name: string, CancellationReasons?: Array<{ Code: string }>): Error {
  return Object.assign(new Error(name), { name, ...(CancellationReasons ? { CancellationReasons } : {}) });
}
