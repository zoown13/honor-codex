import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { BenefitChange, DatasetManifest, PushSubscriptionRecord } from "@honor/core";
import { BulkReviewConflictError, PublicationConflictError } from "./contracts.js";
import type {
  AppRepository,
  BeginPublicationResult,
  BulkReviewChunkResult,
  BulkReviewOperation,
  DeliveryReservation,
  PublicationOperation,
  StoredSubscription,
} from "./contracts.js";
import { reviewSourceIdentity } from "./ingestion.js";

interface RepositoryOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoAppRepository implements AppRepository {
  readonly #tableName: string;
  readonly #client: DynamoDBDocumentClient;

  constructor(options: RepositoryOptions) {
    if (!options.tableName.trim()) throw new Error("TABLE_NAME is required");
    this.#tableName = options.tableName;
    this.#client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async listSubscriptions(userId: string): Promise<StoredSubscription[]> {
    return (await this.#queryPartition(userPk(userId), "SUB#")).map((item) => fromItem<StoredSubscription>(item));
  }

  async putSubscription(value: StoredSubscription): Promise<void> {
    await this.#client.send(new PutCommand({
      TableName: this.#tableName,
      Item: { pk: userPk(value.userId), sk: `SUB#${value.id}`, entityType: "SUBSCRIPTION", ...value },
    }));
  }

  async deleteSubscription(userId: string, subscriptionId: string): Promise<boolean> {
    const result = await this.#client.send(new DeleteCommand({
      TableName: this.#tableName,
      Key: { pk: userPk(userId), sk: `SUB#${subscriptionId}` },
      ReturnValues: "ALL_OLD",
    }));
    return result.Attributes !== undefined;
  }

  async listAllSubscriptions(): Promise<StoredSubscription[]> {
    return (await this.#scanEntity("SUBSCRIPTION")).map((item) => fromItem<StoredSubscription>(item));
  }

  async putPushSubscription(value: PushSubscriptionRecord): Promise<void> {
    await this.#client.send(new PutCommand({
      TableName: this.#tableName,
      Item: { pk: userPk(value.userId), sk: `PUSH#${value.id}`, entityType: "PUSH_SUBSCRIPTION", ...value },
    }));
  }

  async listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    return (await this.#queryPartition(userPk(userId), "PUSH#")).map((item) => fromItem<PushSubscriptionRecord>(item));
  }

  async deletePushSubscription(userId: string, pushId: string): Promise<boolean> {
    const result = await this.#client.send(new DeleteCommand({
      TableName: this.#tableName,
      Key: { pk: userPk(userId), sk: `PUSH#${pushId}` },
      ReturnValues: "ALL_OLD",
    }));
    return result.Attributes !== undefined;
  }

  async deleteUserData(userId: string): Promise<number> {
    const items = [
      ...await this.#queryPartition(userPk(userId)),
      ...await this.#queryPartition(`DELIVERY#${userId}`),
    ];
    for (let index = 0; index < items.length; index += 25) {
      let requests = items.slice(index, index + 25).map((item) => ({
        DeleteRequest: { Key: { pk: item.pk, sk: item.sk } },
      }));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await this.#client.send(new BatchWriteCommand({
          RequestItems: { [this.#tableName]: requests },
        }));
        requests = (result.UnprocessedItems?.[this.#tableName] ?? []) as typeof requests;
        if (!requests.length) break;
        if (attempt === 4) throw new Error("DynamoDB did not process all account deletions");
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
    return items.length;
  }

  async putChanges(changes: readonly BenefitChange[]): Promise<number> {
    let inserted = 0;
    for (const change of changes) {
      try {
        await this.#client.send(new PutCommand({
          TableName: this.#tableName,
          Item: { pk: "CHANGE", sk: `CHG#${change.id}`, entityType: "BENEFIT_CHANGE", ...change },
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }));
        inserted += 1;
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
      }
    }
    return inserted;
  }

  async listChanges(statuses?: readonly BenefitChange["status"][]): Promise<BenefitChange[]> {
    const values: BenefitChange[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": "CHANGE", ":prefix": "CHG#" },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      values.push(...(result.Items ?? []).map((item) => fromItem<BenefitChange>(item)));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return values
      .filter((item) => !statuses?.length || statuses.includes(item.status))
      .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  async getChange(changeId: string): Promise<BenefitChange | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: "CHANGE", sk: `CHG#${changeId}` },
      ConsistentRead: true,
    }));
    return result.Item ? fromItem<BenefitChange>(result.Item) : undefined;
  }

  async reviewChange(
    changeId: string,
    decision: "APPROVED" | "REJECTED",
    reviewer: string,
    at: string,
  ): Promise<BenefitChange> {
    try {
      const result = await this.#client.send(new UpdateCommand({
        TableName: this.#tableName,
        Key: { pk: "CHANGE", sk: `CHG#${changeId}` },
        UpdateExpression: "SET #status = :decision, reviewedAt = :at, reviewedBy = :reviewer",
        ConditionExpression: "attribute_exists(pk) AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":decision": decision, ":at": at, ":reviewer": reviewer, ":pending": "PENDING" },
        ReturnValues: "ALL_NEW",
      }));
      if (!result.Attributes) throw new Error("Review update returned no item");
      return fromItem<BenefitChange>(result.Attributes);
    } catch (error) {
      if (isConditionalFailure(error)) throw new Error("Change was not found or is no longer pending");
      throw error;
    }
  }

  async getBulkReviewOperation(operationId: string): Promise<BulkReviewOperation | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: "REVIEW_OPERATION", sk: `OP#${operationId}` },
      ConsistentRead: true,
    }));
    return result.Item ? fromItem<BulkReviewOperation>(result.Item) : undefined;
  }

  async putBulkReviewOperation(value: BulkReviewOperation): Promise<BulkReviewOperation> {
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#tableName,
        Item: {
          pk: "REVIEW_OPERATION",
          sk: `OP#${value.id}`,
          entityType: "BULK_REVIEW_OPERATION",
          ...value,
        },
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }));
      return value;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const existing = await this.getBulkReviewOperation(value.id);
      if (!existing) throw new BulkReviewConflictError("Review operation was created concurrently but could not be loaded");
      return existing;
    }
  }

  async approveBulkReviewChunk(
    operationId: string,
    at: string,
    maxChanges: number,
  ): Promise<BulkReviewChunkResult> {
    if (!Number.isInteger(maxChanges) || maxChanges < 1 || maxChanges > 100) {
      throw new Error("Bulk review chunk size must be between 1 and 100");
    }
    const operation = await this.getBulkReviewOperation(operationId);
    if (!operation) throw new BulkReviewConflictError("Bulk review operation was not found");
    if (operation.status === "COMPLETED") return { operation, processedCount: 0 };
    if (operation.approvedCount < 0 || operation.approvedCount >= operation.expectedCount) {
      throw new BulkReviewConflictError("Bulk review operation progress is invalid");
    }

    // DynamoDB transactions allow 100 actions; one is reserved for atomic operation progress.
    const chunkSize = Math.min(maxChanges, 99);
    const changeIds = operation.changeIds.slice(operation.approvedCount, operation.approvedCount + chunkSize);
    if (!changeIds.length) throw new BulkReviewConflictError("Bulk review operation has no remaining change IDs");
    const nextApprovedCount = operation.approvedCount + changeIds.length;
    const complete = nextApprovedCount === operation.expectedCount;
    const identity = reviewSourceIdentity(operation.source);

    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.#tableName,
              Key: { pk: "REVIEW_OPERATION", sk: `OP#${operation.id}` },
              UpdateExpression: complete
                ? "SET approvedCount = :next, updatedAt = :at, #status = :completed, completedAt = :at"
                : "SET approvedCount = :next, updatedAt = :at",
              ConditionExpression: "#status = :inProgress AND approvedCount = :current",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":next": nextApprovedCount,
                ":at": at,
                ":inProgress": "IN_PROGRESS",
                ":current": operation.approvedCount,
                ...(complete ? { ":completed": "COMPLETED" } : {}),
              },
            },
          },
          ...changeIds.map((changeId) => ({
            Update: {
              TableName: this.#tableName,
              Key: { pk: "CHANGE", sk: `CHG#${changeId}` },
              UpdateExpression: [
                "SET #status = :approved",
                "reviewedAt = :at",
                "reviewedBy = :reviewer",
                "reviewOperationId = :operationId",
                "reviewReason = :reason",
                "#changeSource = :reviewSource",
              ].join(", "),
              ConditionExpression: [
                "#status = :pending",
                "risk = :high",
                "#action = :add",
                "attribute_not_exists(#before)",
                "attribute_exists(#after)",
                "detectedAt = :detectedAt",
                "(#changeSource = :reviewSource OR (attribute_not_exists(#changeSource)",
                "begins_with(benefitId, :benefitIdPrefix)",
                "#after.#type = :benefitType",
                "#after.#benefitSource.#system = :sourceSystem))",
              ].join(" AND "),
              ExpressionAttributeNames: {
                "#status": "status",
                "#action": "action",
                "#before": "before",
                "#after": "after",
                "#type": "type",
                "#benefitSource": "source",
                "#system": "system",
                "#changeSource": "source",
              },
              ExpressionAttributeValues: {
                ":approved": "APPROVED",
                ":pending": "PENDING",
                ":high": "HIGH",
                ":add": "ADD",
                ":at": at,
                ":reviewer": operation.reviewer,
                ":operationId": operation.id,
                ":reason": operation.reason,
                ":reviewSource": operation.source,
                ":detectedAt": operation.detectedAt,
                ":benefitIdPrefix": identity.benefitIdPrefix,
                ":benefitType": identity.benefitType,
                ":sourceSystem": identity.sourceSystem,
              },
            },
          })),
        ],
      }));
    } catch (error) {
      const current = await this.getBulkReviewOperation(operation.id);
      if (current && (current.approvedCount > operation.approvedCount || current.status === "COMPLETED")) {
        return { operation: current, processedCount: 0 };
      }
      if (isTransactionConflict(error)) throw new BulkReviewConflictError();
      throw error;
    }

    return {
      processedCount: changeIds.length,
      operation: {
        ...operation,
        approvedCount: nextApprovedCount,
        updatedAt: at,
        ...(complete ? { status: "COMPLETED", completedAt: at } : {}),
      },
    };
  }

  async getPublicationOperation(): Promise<PublicationOperation | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: "PUBLICATION", sk: "ACTIVE" },
      ConsistentRead: true,
    }));
    return result.Item ? fromItem<PublicationOperation>(result.Item) : undefined;
  }

  async beginPublication(value: PublicationOperation): Promise<BeginPublicationResult> {
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#tableName,
        Item: {
          pk: "PUBLICATION",
          sk: "ACTIVE",
          entityType: "PUBLICATION_OPERATION",
          ...value,
        },
        ConditionExpression: "attribute_not_exists(pk) OR #status IN (:completed, :failed)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":completed": "COMPLETED", ":failed": "FAILED" },
      }));
      return { operation: value, created: true };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.getPublicationOperation();
      if (current?.id === value.id && current.fingerprint === value.fingerprint) {
        return { operation: current, created: false };
      }
      throw new PublicationConflictError();
    }
  }

  async stagePublication(
    operationId: string,
    manifest: DatasetManifest,
    at: string,
  ): Promise<PublicationOperation> {
    const result = await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "PUBLICATION", sk: "ACTIVE" },
      UpdateExpression: "SET #status = :staged, manifest = :manifest, updatedAt = :at",
      ConditionExpression: "id = :id AND #status = :preparing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":id": operationId,
        ":preparing": "PREPARING",
        ":staged": "STAGED",
        ":manifest": manifest,
        ":at": at,
      },
      ReturnValues: "ALL_NEW",
    }));
    return fromItem<PublicationOperation>(result.Attributes ?? {});
  }

  async recordPublicationJob(
    operationId: string,
    jobId: string,
    at: string,
  ): Promise<PublicationOperation> {
    const result = await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "PUBLICATION", sk: "ACTIVE" },
      UpdateExpression: "SET #status = :deploying, deploymentJobId = :jobId, updatedAt = :at",
      ConditionExpression: [
        "id = :id",
        "(#status = :staged OR (#status = :deploying AND deploymentJobId = :jobId))",
      ].join(" AND "),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":id": operationId,
        ":staged": "STAGED",
        ":deploying": "DEPLOYING",
        ":jobId": jobId,
        ":at": at,
      },
      ReturnValues: "ALL_NEW",
    }));
    return fromItem<PublicationOperation>(result.Attributes ?? {});
  }

  async markPublicationDeployed(
    operationId: string,
    jobId: string,
    at: string,
  ): Promise<PublicationOperation> {
    const result = await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "PUBLICATION", sk: "ACTIVE" },
      UpdateExpression: [
        "SET #status = :deployed",
        "deployedAt = if_not_exists(deployedAt, :at)",
        "updatedAt = :at",
      ].join(", "),
      ConditionExpression: [
        "id = :id",
        "deploymentJobId = :jobId",
        "#status IN (:deploying, :deployed)",
      ].join(" AND "),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":id": operationId,
        ":jobId": jobId,
        ":deploying": "DEPLOYING",
        ":deployed": "DEPLOYED",
        ":at": at,
      },
      ReturnValues: "ALL_NEW",
    }));
    return fromItem<PublicationOperation>(result.Attributes ?? {});
  }

  async completePublication(operationId: string, at: string): Promise<PublicationOperation> {
    const result = await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "PUBLICATION", sk: "ACTIVE" },
      UpdateExpression: [
        "SET #status = :completed",
        "completedAt = if_not_exists(completedAt, :at)",
        "updatedAt = :at",
      ].join(", "),
      ConditionExpression: "id = :id AND #status IN (:deployed, :completed)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":id": operationId,
        ":deployed": "DEPLOYED",
        ":completed": "COMPLETED",
        ":at": at,
      },
      ReturnValues: "ALL_NEW",
    }));
    return fromItem<PublicationOperation>(result.Attributes ?? {});
  }

  async failPublication(operationId: string, at: string, error: string): Promise<void> {
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "PUBLICATION", sk: "ACTIVE" },
      UpdateExpression: "SET #status = :failed, failedAt = :at, updatedAt = :at, #error = :error",
      ConditionExpression: "id = :id AND #status IN (:preparing, :staged, :deploying)",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: {
        ":id": operationId,
        ":preparing": "PREPARING",
        ":staged": "STAGED",
        ":deploying": "DEPLOYING",
        ":failed": "FAILED",
        ":at": at,
        ":error": error.slice(0, 500),
      },
    }));
  }

  async markChangesPublished(
    changeIds: readonly string[],
    at: string,
    operationId: string,
  ): Promise<void> {
    const ids = [...new Set(changeIds)];
    for (let index = 0; index < ids.length; index += 100) {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: ids.slice(index, index + 100).map((id) => ({
          Update: {
            TableName: this.#tableName,
            Key: { pk: "CHANGE", sk: `CHG#${id}` },
            UpdateExpression: [
              "SET #status = :published",
              "publishedAt = if_not_exists(publishedAt, :at)",
              "publishOperationId = if_not_exists(publishOperationId, :operationId)",
            ].join(", "),
            ConditionExpression: [
              "#status IN (:approved, :auto)",
              "OR (#status = :published AND publishOperationId = :operationId)",
            ].join(" "),
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":published": "PUBLISHED",
              ":at": at,
              ":operationId": operationId,
              ":approved": "APPROVED",
              ":auto": "AUTO_APPROVED",
            },
          },
        })),
      }));
    }
  }

  async reserveDelivery(value: DeliveryReservation): Promise<boolean> {
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#tableName,
        Item: {
          pk: `DELIVERY#${value.userId}`,
          sk: `DELIVERY#${value.idempotencyKey}`,
          entityType: "DELIVERY",
          ...value,
        },
        ConditionExpression: "attribute_not_exists(pk) OR #status = :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":failed": "FAILED" },
      }));
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async finishDelivery(
    userId: string,
    key: string,
    status: "SENT" | "FAILED",
    at: string,
    error?: string,
  ): Promise<void> {
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: `DELIVERY#${userId}`, sk: `DELIVERY#${key}` },
      UpdateExpression: error
        ? "SET #status = :status, updatedAt = :at, #error = :error"
        : "SET #status = :status, updatedAt = :at REMOVE #error",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: {
        ":status": status,
        ":at": at,
        ...(error ? { ":error": error.slice(0, 500) } : {}),
      },
    }));
  }

  async #queryPartition(pk: string, prefix?: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: prefix ? "pk = :pk AND begins_with(sk, :prefix)" : "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk, ...(prefix ? { ":prefix": prefix } : {}) },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      output.push(...((result.Items ?? []) as Record<string, unknown>[]));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return output;
  }

  async #scanEntity(entityType: string): Promise<Record<string, unknown>[]> {
    const output: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new ScanCommand({
        TableName: this.#tableName,
        FilterExpression: "entityType = :entityType",
        ExpressionAttributeValues: { ":entityType": entityType },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      output.push(...((result.Items ?? []) as Record<string, unknown>[]));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return output;
  }
}

function userPk(userId: string): string {
  return `USER#${userId}`;
}

function fromItem<T>(item: Record<string, unknown>): T {
  const { pk: _pk, sk: _sk, entityType: _entityType, ...value } = item;
  return value as T;
}

function isConditionalFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error
    && (error as { name?: string }).name === "ConditionalCheckFailedException";
}

function isTransactionConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)
    || (error as { name?: string }).name !== "TransactionCanceledException") return false;
  const reasons = "CancellationReasons" in error
    ? (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons
    : undefined;
  return reasons === undefined || reasons.some((reason) =>
    reason.Code === "ConditionalCheckFailed" || reason.Code === "TransactionConflict");
}
