import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { DynamoAppRepository } from "../src/shared/aws-repository.js";

describe("DynamoAppRepository review summaries", () => {
  it("projects only fields required to aggregate batches and follows DynamoDB pages", async () => {
    const item = (id: string, detectedAt: string) => ({
      pk: "CHANGE",
      sk: `CHG#${id}`,
      id,
      benefitId: `ord:${id}`,
      action: "ADD",
      risk: "HIGH",
      status: "PENDING",
      detectedAt,
      after: {
        id: `ord:${id}`,
        type: "ORDINANCE",
        title: `조례 ${id}`,
        provider: "테스트시",
        source: { id, system: "LAW_GO_KR", url: `https://law.go.kr/${id}` },
      },
    });
    const send = vi.fn()
      .mockResolvedValueOnce({
        Items: [item("later", "2026-07-16T00:00:00.000Z")],
        LastEvaluatedKey: { pk: "CHANGE", sk: "CHG#later" },
      })
      .mockResolvedValueOnce({ Items: [item("earlier", "2026-07-15T00:00:00.000Z")] });
    const repository = new DynamoAppRepository({ tableName: "pilot-table", client: fakeClient(send) });

    const changes = await repository.listReviewSummaryChanges();

    expect(changes.map(({ id }) => id)).toEqual(["later", "earlier"]);
    expect(send).toHaveBeenCalledTimes(2);
    const first = queryInput(send.mock.calls[0]![0]);
    const second = queryInput(send.mock.calls[1]![0]);
    expect(first.ProjectionExpression).toContain("#after.#benefitSource");
    expect(first.ProjectionExpression).toContain("#changedFields");
    expect(first.ProjectionExpression).toContain("#after.#summaryProvenance");
    expect(first.ProjectionExpression).toContain("#after.#reviewState");
    expect(first.ProjectionExpression).not.toMatch(/#(?:evidence|searchText|matchingArticles)\\b|#after\\.#summary(?:,|$)/);
    expect(second.ExclusiveStartKey).toEqual({ pk: "CHANGE", sk: "CHG#later" });
  });
});

describe("DynamoAppRepository review batch pages", () => {
  it("stops after collecting one item beyond the requested page", async () => {
    const detectedAt = "2026-07-15T00:00:00.000Z";
    const item = (id: string) => ({
      pk: "CHANGE",
      sk: `CHG#${id}`,
      id,
      benefitId: `fac:${id}`,
      action: "ADD",
      risk: "HIGH",
      status: "PENDING",
      changedFields: ["created"],
      detectedAt,
    });
    const send = vi.fn()
      .mockResolvedValueOnce({
        Items: [item("chg:1")],
        LastEvaluatedKey: { pk: "CHANGE", sk: "CHG#evaluated-1" },
      })
      .mockResolvedValueOnce({ Items: [item("chg:2"), item("chg:3")] });
    const repository = new DynamoAppRepository({
      tableName: "pilot-table",
      client: fakeClient(send),
    });

    const page = await repository.listChangeBatchPage({
      status: "PENDING",
      source: "MMA_FACILITIES",
      detectedAt,
      limit: 2,
      cursor: "chg:previous",
    });

    expect(page.items.map(({ id }) => id)).toEqual(["chg:1", "chg:2"]);
    expect(page.nextCursor).toBe("chg:2");
    expect(send).toHaveBeenCalledTimes(2);
    const first = queryInput(send.mock.calls[0]![0]);
    const second = queryInput(send.mock.calls[1]![0]);
    expect(first).toMatchObject({
      Limit: 3,
      ExclusiveStartKey: { pk: "CHANGE", sk: "CHG#chg:previous" },
      ExpressionAttributeValues: { ":status": "PENDING", ":source": "MMA_FACILITIES", ":detectedAt": detectedAt, ":benefitIdPrefix": "fac:", ":benefitType": "FACILITY", ":sourceSystem": "MMA" },
    });
    expect(second).toMatchObject({ Limit: 3, ExclusiveStartKey: { pk: "CHANGE", sk: "CHG#evaluated-1" } });
    expect(first.FilterExpression).toContain("attribute_not_exists(#changeSource)");
    expect(first.FilterExpression).toContain("#after.#benefitSource.#system = :sourceSystem");
  });
});

describe("DynamoAppRepository bulk review progress", () => {
  const operationItem = (
    approvedCount = 0,
    status: "IN_PROGRESS" | "COMPLETED" = "IN_PROGRESS",
    reason = "INITIAL_BASELINE_BULK_APPROVAL",
  ) => ({
    pk: "REVIEW_OPERATION",
    sk: "OP#11111111-1111-4111-8111-111111111111",
    entityType: "BULK_REVIEW_OPERATION",
    id: "11111111-1111-4111-8111-111111111111",
    source: "LAW_ORDINANCES",
    detectedAt: "2026-07-15T00:00:00.000Z",
    fingerprint: "a".repeat(64),
    expectedCount: 2,
    changeIds: ["chg:1", "chg:2"],
    reviewer: "pilot@example.com",
    reason,
    status,
    approvedCount,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...(status === "COMPLETED" ? { completedAt: "2026-07-16T00:00:01.000Z" } : {}),
  });

  it("retries a transient transaction with the same idempotency token", async () => {
    const transactions: TransactWriteCommand[] = [];
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof GetCommand) return { Item: operationItem() };
      if (command instanceof TransactWriteCommand) {
        transactions.push(command);
        if (transactions.length === 1) throw namedError("InternalServerError");
        return {};
      }
      throw new Error("Unexpected command");
    });
    const sleep = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
    const repository = new DynamoAppRepository({
      tableName: "pilot-table",
      client: fakeClient(send),
      sleep,
      random: () => 0.5,
    });

    const result = await repository.approveBulkReviewChunk(
      "11111111-1111-4111-8111-111111111111",
      "2026-07-16T00:00:01.000Z",
      100,
    );

    expect(result).toMatchObject({ processedCount: 2, operation: { approvedCount: 2, status: "COMPLETED" } });
    expect(transactions).toHaveLength(2);
    expect(transactions[0]?.input.ClientRequestToken).toHaveLength(36);
    expect(transactions[1]?.input.ClientRequestToken).toBe(transactions[0]?.input.ClientRequestToken);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("guards AI summary approval with immutable source hashes and AI provenance", async () => {
    const transactions: TransactWriteCommand[] = [];
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof GetCommand) {
        return { Item: operationItem(0, "IN_PROGRESS", "AI_ORDINANCE_SUMMARY_BULK_APPROVAL") };
      }
      if (command instanceof TransactWriteCommand) {
        transactions.push(command);
        return {};
      }
      throw new Error("Unexpected command");
    });
    const repository = new DynamoAppRepository({ tableName: "pilot-table", client: fakeClient(send) });

    const result = await repository.approveBulkReviewChunk(
      "11111111-1111-4111-8111-111111111111",
      "2026-07-16T00:00:01.000Z",
      100,
    );

    expect(result).toMatchObject({ processedCount: 2, operation: { status: "COMPLETED" } });
    const changeUpdate = transactions[0]?.input.TransactItems?.[1]?.Update;
    expect(changeUpdate?.ConditionExpression).toContain("#after.#summaryProvenance.#kind = :ai");
    expect(changeUpdate?.ConditionExpression).toContain(
      "#before.#benefitSource.#contentHash = #after.#benefitSource.#contentHash",
    );
    expect(changeUpdate?.ConditionExpression).toContain(
      "#after.#summaryProvenance.#sourceContentHash = #after.#benefitSource.#contentHash",
    );
    expect(changeUpdate?.ExpressionAttributeValues).toMatchObject({
      ":update": "UPDATE", ":ai": "AI", ":sourceOnly": "SOURCE_ONLY",
    });
    expect(changeUpdate?.ExpressionAttributeValues).not.toHaveProperty(":add");
  });

  it("returns committed progress when the transaction response is lost", async () => {
    let getCount = 0;
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof GetCommand) {
        getCount += 1;
        return { Item: getCount === 1 ? operationItem() : operationItem(2, "COMPLETED") };
      }
      if (command instanceof TransactWriteCommand) throw namedError("InternalServerError");
      throw new Error("Unexpected command");
    });
    const sleep = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
    const repository = new DynamoAppRepository({ tableName: "pilot-table", client: fakeClient(send), sleep });

    const result = await repository.approveBulkReviewChunk(
      "11111111-1111-4111-8111-111111111111",
      "2026-07-16T00:00:01.000Z",
      100,
    );

    expect(result).toMatchObject({ processedCount: 0, operation: { approvedCount: 2, status: "COMPLETED" } });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("DynamoAppRepository ordinance summary progress", () => {
  it("returns the terminal job when another worker wins the completion race", async () => {
    const running = {
      pk: "ORDINANCE_SUMMARY", sk: "ACTIVE", entityType: "ORDINANCE_SUMMARY_JOB",
      id: "aisum:test", fingerprint: "a".repeat(64), modelId: "global.amazon.nova-2-lite-v1:0",
      status: "RUNNING", total: 1, queuedCount: 1, processedCount: 1, succeededCount: 1,
      failedCount: 0, inputTokens: 900, outputTokens: 120, estimatedCostUsd: 0.01,
      createdAt: "2026-07-16T00:00:00.000Z", updatedAt: "2026-07-16T00:00:01.000Z",
    };
    const completed = {
      ...running, status: "COMPLETED", completedAt: "2026-07-16T00:00:02.000Z",
    };
    let getCount = 0;
    const send = vi.fn(async (command: unknown): Promise<unknown> => {
      if (command instanceof TransactWriteCommand) return {};
      if (command instanceof GetCommand) {
        getCount += 1;
        return { Item: getCount === 1 ? running : completed };
      }
      if (command instanceof UpdateCommand) throw namedError("ConditionalCheckFailedException");
      throw new Error("Unexpected command");
    });
    const repository = new DynamoAppRepository({ tableName: "pilot-table", client: fakeClient(send) });

    const result = await repository.recordOrdinanceSummaryItem(
      "aisum:test",
      {
        benefitId: "ord:1", status: "SUCCEEDED", inputTokens: 900, outputTokens: 120,
        changeId: "chg:1",
      },
      "2026-07-16T00:00:02.000Z",
    );

    expect(result).toMatchObject({ status: "COMPLETED", processedCount: 1, succeededCount: 1 });
    const transaction = transactionInput(send.mock.calls[0]![0]);
    const progressUpdate = transaction.TransactItems?.[1]?.Update;
    expect(progressUpdate?.UpdateExpression).toBe(
      "SET updatedAt = :at ADD processedCount :one, succeededCount :succeeded, failedCount :failed, inputTokens :inputTokens, outputTokens :outputTokens",
    );
    expect(getCount).toBe(2);
  });
});

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

function queryInput(command: unknown): QueryCommand["input"] {
  expect(command).toBeInstanceOf(QueryCommand);
  return (command as QueryCommand).input;
}

function transactionInput(command: unknown): TransactWriteCommand["input"] {
  expect(command).toBeInstanceOf(TransactWriteCommand);
  return (command as TransactWriteCommand).input;
}

function namedError(name: string, CancellationReasons?: Array<{ Code: string }>): Error {
  return Object.assign(new Error(name), { name, ...(CancellationReasons ? { CancellationReasons } : {}) });
}
