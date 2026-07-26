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
import { sha256Hex } from "@honor/core";
import type { BenefitChange, DatasetManifest, PushSubscriptionRecord } from "@honor/core";
import { BulkReviewConflictError, PublicationConflictError } from "./contracts.js";
import type {
  AppRepository,
  BeginPublicationResult,
  BulkReviewChunkResult,
  BulkReviewOperation,
  ChangeBatchPage,
  ChangeBatchPageRequest,
  DeliveryReservation,
  PublicationOperation,
  OrdinanceSummaryCache,
  OrdinanceSummaryItemResult,
  OrdinanceSummaryJob,
  StoredSubscription,
} from "./contracts.js";
import { reviewSourceIdentity } from "./ingestion.js";

interface RepositoryOptions {
  tableName: string;
  client?: DynamoDBDocumentClient;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export class DynamoAppRepository implements AppRepository {
  readonly #tableName: string;
  readonly #client: DynamoDBDocumentClient;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options: RepositoryOptions) {
    if (!options.tableName.trim()) throw new Error("TABLE_NAME is required");
    this.#tableName = options.tableName;
    this.#client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    this.#random = options.random ?? Math.random;
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

  async listReviewSummaryChanges(): Promise<BenefitChange[]> {
    const values: BenefitChange[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ProjectionExpression: [
          "#id",
          "#benefitId",
          "#action",
          "#risk",
          "#status",
          "#detectedAt",
          "#changedFields",
          "#changeSource",
          "#before.#id",
          "#before.#type",
          "#before.#title",
          "#before.#provider",
          "#before.#benefitSource",
          "#after.#id",
          "#after.#type",
          "#after.#title",
          "#after.#provider",
          "#after.#benefitSource",
          "#after.#summaryProvenance",
          "#after.#reviewState",
        ].join(", "),
        ExpressionAttributeNames: {
          "#id": "id",
          "#benefitId": "benefitId",
          "#action": "action",
          "#risk": "risk",
          "#status": "status",
          "#detectedAt": "detectedAt",
          "#changedFields": "changedFields",
          "#changeSource": "source",
          "#before": "before",
          "#after": "after",
          "#type": "type",
          "#title": "title",
          "#provider": "provider",
          "#benefitSource": "source",
          "#summaryProvenance": "summaryProvenance",
          "#reviewState": "reviewState",
        },
        ExpressionAttributeValues: { ":pk": "CHANGE", ":prefix": "CHG#" },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      values.push(...(result.Items ?? []).map((item) => fromItem<BenefitChange>(item)));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return values.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  }

  async listChangeBatchPage(request: ChangeBatchPageRequest): Promise<ChangeBatchPage> {
    const identity = reviewSourceIdentity(request.source);
    const targetCount = request.limit + 1;
    const values: BenefitChange[] = [];
    let startKey: Record<string, unknown> | undefined = request.cursor
      ? { pk: "CHANGE", sk: `CHG#${request.cursor}` }
      : undefined;

    do {
      const result = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        FilterExpression: [
          "#status = :status AND",
          "detectedAt = :detectedAt AND",
          "(#changeSource = :source OR (",
          "attribute_not_exists(#changeSource)",
          "AND begins_with(benefitId, :benefitIdPrefix)",
          "AND ((attribute_exists(#after)",
          "AND begins_with(#after.#id, :benefitIdPrefix)",
          "AND #after.#type = :benefitType",
          "AND #after.#benefitSource.#system = :sourceSystem)",
          "OR (attribute_not_exists(#after)",
          "AND attribute_exists(#before)",
          "AND begins_with(#before.#id, :benefitIdPrefix)",
          "AND #before.#type = :benefitType",
          "AND #before.#benefitSource.#system = :sourceSystem))))",
        ].join(" "),
        ExpressionAttributeNames: {
          "#status": "status",
          "#changeSource": "source",
          "#after": "after",
          "#before": "before",
          "#id": "id",
          "#type": "type",
          "#benefitSource": "source",
          "#system": "system",
        },
        ExpressionAttributeValues: {
          ":pk": "CHANGE",
          ":prefix": "CHG#",
          ":status": request.status,
          ":source": request.source,
          ":detectedAt": request.detectedAt,
          ":benefitIdPrefix": identity.benefitIdPrefix,
          ":benefitType": identity.benefitType,
          ":sourceSystem": identity.sourceSystem,
        },
        Limit: targetCount,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }));
      values.push(...(result.Items ?? []).map((item) => fromItem<BenefitChange>(item)));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey && values.length < targetCount);

    const items = values.slice(0, request.limit);
    const nextCursor = values.length > request.limit ? items.at(-1)?.id : undefined;
    return {
      items,
      ...(nextCursor ? { nextCursor } : {}),
    };
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
    const aiSummaryReview = operation.reason === "AI_ORDINANCE_SUMMARY_BULK_APPROVAL";
    if (!aiSummaryReview && operation.reason !== "INITIAL_BASELINE_BULK_APPROVAL") {
      throw new BulkReviewConflictError("Bulk review operation reason is unsupported");
    }
    const sourceIdentityCondition = [
      "(#changeSource = :reviewSource OR (attribute_not_exists(#changeSource)",
      "begins_with(benefitId, :benefitIdPrefix)",
      "#after.#type = :benefitType",
      "#after.#benefitSource.#system = :sourceSystem))",
    ];
    const changeConditionExpression = [
      "#status = :pending",
      "risk = :high",
      ...(aiSummaryReview ? [
        "#action = :update",
        "attribute_exists(#before)",
        "attribute_exists(#after)",
        "#after.#summaryProvenance.#kind = :ai",
        "#after.#summaryProvenance.#sourceContentHash = #after.#benefitSource.#contentHash",
        "#before.#benefitSource.#contentHash = #after.#benefitSource.#contentHash",
        "#after.#reviewState = :sourceOnly",
      ] : [
        "#action = :add",
        "attribute_not_exists(#before)",
        "attribute_exists(#after)",
      ]),
      "detectedAt = :detectedAt",
      ...sourceIdentityCondition,
    ].join(" AND ");
    const changeExpressionAttributeNames = {
      "#status": "status",
      "#action": "action",
      "#before": "before",
      "#after": "after",
      "#type": "type",
      "#benefitSource": "source",
      "#system": "system",
      "#changeSource": "source",
      ...(aiSummaryReview ? {
        "#summaryProvenance": "summaryProvenance",
        "#kind": "kind",
        "#sourceContentHash": "sourceContentHash",
        "#contentHash": "contentHash",
        "#reviewState": "reviewState",
      } : {}),
    };
    const changeExpressionAttributeValues = {
      ":approved": "APPROVED",
      ":pending": "PENDING",
      ":high": "HIGH",
      ":at": at,
      ":reviewer": operation.reviewer,
      ":operationId": operation.id,
      ":reason": operation.reason,
      ":reviewSource": operation.source,
      ":detectedAt": operation.detectedAt,
      ":benefitIdPrefix": identity.benefitIdPrefix,
      ":benefitType": identity.benefitType,
      ":sourceSystem": identity.sourceSystem,
      ...(aiSummaryReview ? {
        ":update": "UPDATE",
        ":ai": "AI",
        ":sourceOnly": "SOURCE_ONLY",
      } : { ":add": "ADD" }),
    };

    const transaction = new TransactWriteCommand(
      {
        ClientRequestToken: sha256Hex(`${operation.id}\n${operation.approvedCount}\n${at}`).slice(0, 36),
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
              ConditionExpression: changeConditionExpression,
              ExpressionAttributeNames: changeExpressionAttributeNames,
              ExpressionAttributeValues: changeExpressionAttributeValues,
            },
          })),
        ],
      },
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#client.send(transaction);
        break;
      } catch (error) {
        // A DynamoDB transaction can commit even when its response is lost. A
        // consistent progress read prevents a committed chunk from surfacing as
        // a false 500, while the request token makes same-invocation retries safe.
        const current = await this.getBulkReviewOperation(operation.id);
        if (current && (current.approvedCount > operation.approvedCount || current.status === "COMPLETED")) {
          return { operation: current, processedCount: 0 };
        }
        if (!isBulkReviewRetryable(error) || attempt >= BULK_REVIEW_MAX_ATTEMPTS - 1) {
          if (isTransactionConflict(error)) throw new BulkReviewConflictError();
          throw error;
        }
        const ceiling = Math.min(
          BULK_REVIEW_RETRY_CAP_MS,
          BULK_REVIEW_RETRY_BASE_MS * 2 ** attempt,
        );
        await this.#sleep(Math.floor(this.#random() * ceiling));
      }
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
    manifestRollbackToken: string,
    at: string,
  ): Promise<PublicationOperation> {
    const result = await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "PUBLICATION", sk: "ACTIVE" },
      UpdateExpression: [
        "SET #status = :staged",
        "manifest = :manifest",
        "manifestRollbackToken = :manifestRollbackToken",
        "updatedAt = :at",
      ].join(", "),
      ConditionExpression: "id = :id AND #status = :preparing",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":id": operationId,
        ":preparing": "PREPARING",
        ":staged": "STAGED",
        ":manifest": manifest,
        ":manifestRollbackToken": manifestRollbackToken,
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
    for (let index = 0; index < ids.length; index += PUBLICATION_TRANSACTION_SIZE) {
      const chunk = ids.slice(index, index + PUBLICATION_TRANSACTION_SIZE);
      const input = {
        ClientRequestToken: sha256Hex(`${operationId}\n${chunk.join("\n")}`).slice(0, 36),
        TransactItems: chunk.map((id) => ({
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
      };
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.#client.send(new TransactWriteCommand(input));
          break;
        } catch (error) {
          if (!isPublicationThrottle(error) || attempt >= PUBLICATION_MAX_ATTEMPTS - 1) {
            throw error;
          }
          const ceiling = Math.min(
            PUBLICATION_RETRY_CAP_MS,
            PUBLICATION_RETRY_BASE_MS * 2 ** attempt,
          );
          await this.#sleep(Math.floor(this.#random() * ceiling));
        }
      }
      if (index + PUBLICATION_TRANSACTION_SIZE < ids.length) {
        await this.#sleep(PUBLICATION_CHUNK_INTERVAL_MS);
      }
    }
  }

  async getOrdinanceSummaryJob(): Promise<OrdinanceSummaryJob | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: "ORDINANCE_SUMMARY", sk: "ACTIVE" },
      ConsistentRead: true,
    }));
    return result.Item ? fromItem<OrdinanceSummaryJob>(result.Item) : undefined;
  }

  async beginOrdinanceSummaryJob(value: OrdinanceSummaryJob): Promise<OrdinanceSummaryJob> {
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#tableName,
        Item: {
          pk: "ORDINANCE_SUMMARY",
          sk: "ACTIVE",
          entityType: "ORDINANCE_SUMMARY_JOB",
          ...value,
        },
        ConditionExpression: "attribute_not_exists(pk) OR #status IN (:completed, :completedWithErrors, :failed)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":completed": "COMPLETED",
          ":completedWithErrors": "COMPLETED_WITH_ERRORS",
          ":failed": "FAILED",
        },
      }));
      return value;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.getOrdinanceSummaryJob();
      if (current?.id === value.id && current.fingerprint === value.fingerprint) return current;
      throw new PublicationConflictError("Another ordinance summary job is already active");
    }
  }

  async markOrdinanceSummaryJobRunning(
    jobId: string,
    queuedCount: number,
    at: string,
  ): Promise<OrdinanceSummaryJob> {
    const result = await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "ORDINANCE_SUMMARY", sk: "ACTIVE" },
      UpdateExpression: [
        "SET #status = :running",
        "queuedCount = :queuedCount",
        "startedAt = if_not_exists(startedAt, :at)",
        "updatedAt = :at",
      ].join(", "),
      ConditionExpression: "id = :id AND #status IN (:queued, :running)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":id": jobId,
        ":queued": "QUEUED",
        ":running": "RUNNING",
        ":queuedCount": queuedCount,
        ":at": at,
      },
      ReturnValues: "ALL_NEW",
    }));
    return fromItem<OrdinanceSummaryJob>(result.Attributes ?? {});
  }

  async failOrdinanceSummaryJob(jobId: string, at: string, error: string): Promise<void> {
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName,
      Key: { pk: "ORDINANCE_SUMMARY", sk: "ACTIVE" },
      UpdateExpression: "SET #status = :failed, failedAt = :at, updatedAt = :at, #error = :error",
      ConditionExpression: "id = :id AND #status IN (:queued, :running)",
      ExpressionAttributeNames: { "#status": "status", "#error": "error" },
      ExpressionAttributeValues: {
        ":id": jobId,
        ":queued": "QUEUED",
        ":running": "RUNNING",
        ":failed": "FAILED",
        ":at": at,
        ":error": error.slice(0, 500),
      },
    }));
  }

  async getOrdinanceSummaryCache(cacheKey: string): Promise<OrdinanceSummaryCache | undefined> {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: "ORDINANCE_SUMMARY_CACHE", sk: cacheKey },
      ConsistentRead: true,
    }));
    return result.Item ? fromItem<OrdinanceSummaryCache>(result.Item) : undefined;
  }

  async putOrdinanceSummaryCache(value: OrdinanceSummaryCache): Promise<void> {
    await this.#client.send(new PutCommand({
      TableName: this.#tableName,
      Item: {
        pk: "ORDINANCE_SUMMARY_CACHE",
        sk: value.cacheKey,
        entityType: "ORDINANCE_SUMMARY_CACHE",
        ...value,
      },
    }));
  }

  async recordOrdinanceSummaryItem(
    jobId: string,
    result: OrdinanceSummaryItemResult,
    at: string,
  ): Promise<OrdinanceSummaryJob> {
    try {
      await this.#client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#tableName,
              Item: {
                pk: `ORDINANCE_SUMMARY_JOB#${jobId}`,
                sk: `ITEM#${result.benefitId}`,
                entityType: "ORDINANCE_SUMMARY_ITEM",
                jobId,
                ...result,
                createdAt: at,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: this.#tableName,
              Key: { pk: "ORDINANCE_SUMMARY", sk: "ACTIVE" },
              UpdateExpression: [
                "SET updatedAt = :at",
                "ADD processedCount :one,",
                "succeededCount :succeeded,",
                "failedCount :failed,",
                "inputTokens :inputTokens,",
                "outputTokens :outputTokens",
              ].join(" "),
              ConditionExpression: "id = :id AND #status IN (:queued, :running)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":id": jobId,
                ":queued": "QUEUED",
                ":running": "RUNNING",
                ":at": at,
                ":one": 1,
                ":succeeded": result.status === "SUCCEEDED" ? 1 : 0,
                ":failed": result.status === "FAILED" ? 1 : 0,
                ":inputTokens": result.inputTokens,
                ":outputTokens": result.outputTokens,
              },
            },
          },
        ],
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    let job = await this.getOrdinanceSummaryJob();
    if (!job || job.id !== jobId) throw new Error("Ordinance summary job was not found");
    if (job.processedCount >= job.total && (job.status === "QUEUED" || job.status === "RUNNING")) {
      const completedStatus = job.failedCount > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
      try {
        const completed = await this.#client.send(new UpdateCommand({
          TableName: this.#tableName,
          Key: { pk: "ORDINANCE_SUMMARY", sk: "ACTIVE" },
          UpdateExpression: "SET #status = :status, completedAt = if_not_exists(completedAt, :at), updatedAt = :at",
          ConditionExpression: "id = :id AND processedCount >= total AND #status IN (:queued, :running)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":id": jobId,
            ":queued": "QUEUED",
            ":running": "RUNNING",
            ":status": completedStatus,
            ":at": at,
          },
          ReturnValues: "ALL_NEW",
        }));
        job = fromItem<OrdinanceSummaryJob>(completed.Attributes ?? {});
      } catch (error) {
        if (!isConditionalFailure(error)) throw error;
        const current = await this.getOrdinanceSummaryJob();
        if (!current || current.id !== jobId
          || (current.status !== "COMPLETED" && current.status !== "COMPLETED_WITH_ERRORS")) {
          throw error;
        }
        job = current;
      }
    }
    return job;
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

const BULK_REVIEW_MAX_ATTEMPTS = 5;
const BULK_REVIEW_RETRY_BASE_MS = 100;
const BULK_REVIEW_RETRY_CAP_MS = 2_000;
const BULK_REVIEW_RETRYABLE_ERROR_NAMES = new Set([
  "InternalServerError",
  "InternalServerErrorException",
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "TransactionInProgressException",
  "TimeoutError",
]);
const BULK_REVIEW_RETRYABLE_CANCELLATION_CODES = new Set([
  "TransactionConflict",
  "ProvisionedThroughputExceeded",
  "ThrottlingError",
]);

function isBulkReviewRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = "name" in error ? (error as { name?: string }).name : undefined;
  if (name && BULK_REVIEW_RETRYABLE_ERROR_NAMES.has(name)) return true;
  const statusCode = "$metadata" in error
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined;
  if (statusCode !== undefined && statusCode >= 500) return true;
  if (name !== "TransactionCanceledException" || !("CancellationReasons" in error)) return false;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  if (!reasons?.length) return false;
  const codes = reasons.map((reason) => reason.Code).filter((code): code is string => code !== undefined);
  return codes.some((code) => BULK_REVIEW_RETRYABLE_CANCELLATION_CODES.has(code))
    && codes.every((code) => code === "None" || BULK_REVIEW_RETRYABLE_CANCELLATION_CODES.has(code));
}

const PUBLICATION_TRANSACTION_SIZE = 25;
const PUBLICATION_CHUNK_INTERVAL_MS = 200;
const PUBLICATION_MAX_ATTEMPTS = 8;
const PUBLICATION_RETRY_BASE_MS = 100;
const PUBLICATION_RETRY_CAP_MS = 5_000;
const PUBLICATION_RETRYABLE_ERROR_NAMES = new Set([
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "TransactionInProgressException",
]);
const PUBLICATION_RETRYABLE_CANCELLATION_CODES = new Set([
  "TransactionConflict",
  "ProvisionedThroughputExceeded",
  "ThrottlingError",
]);

function isPublicationThrottle(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = (error as { name?: string }).name;
  if (name && PUBLICATION_RETRYABLE_ERROR_NAMES.has(name)) return true;
  if (name !== "TransactionCanceledException" || !("CancellationReasons" in error)) return false;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  if (!reasons?.length) return false;
  const codes = reasons.map((reason) => reason.Code).filter((code): code is string => code !== undefined);
  return codes.some((code) => PUBLICATION_RETRYABLE_CANCELLATION_CODES.has(code))
    && codes.every((code) => code === "None" || PUBLICATION_RETRYABLE_CANCELLATION_CODES.has(code));
}
