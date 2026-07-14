import type {
  Benefit,
  BenefitChange,
  DatasetManifest,
  PushSubscriptionRecord,
} from "@honor/core";
import { BulkReviewConflictError } from "../src/shared/contracts.js";
import type {
  AppRepository,
  BulkReviewOperation,
  DatasetStorage,
  DeliveryReservation,
  StoredSubscription,
} from "../src/shared/contracts.js";
import type { HttpEvent } from "../src/shared/http.js";
import { inferReviewSource } from "../src/shared/ingestion.js";

export class FakeRepository implements AppRepository {
  subscriptions: StoredSubscription[] = [];
  pushes: PushSubscriptionRecord[] = [];
  changes: BenefitChange[] = [];
  deliveries = new Map<string, DeliveryReservation>();
  bulkReviewOperations = new Map<string, BulkReviewOperation>();

  async listSubscriptions(userId: string) { return this.subscriptions.filter((item) => item.userId === userId); }
  async putSubscription(value: StoredSubscription) {
    this.subscriptions = [...this.subscriptions.filter((item) => item.id !== value.id), value];
  }
  async deleteSubscription(userId: string, id: string) {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((item) => item.userId !== userId || item.id !== id);
    return before !== this.subscriptions.length;
  }
  async listAllSubscriptions() { return this.subscriptions; }
  async putPushSubscription(value: PushSubscriptionRecord) {
    this.pushes = [...this.pushes.filter((item) => item.id !== value.id), value];
  }
  async listPushSubscriptions(userId: string) { return this.pushes.filter((item) => item.userId === userId); }
  async deletePushSubscription(userId: string, id: string) {
    const before = this.pushes.length;
    this.pushes = this.pushes.filter((item) => item.userId !== userId || item.id !== id);
    return before !== this.pushes.length;
  }
  async deleteUserData(userId: string) {
    const deliveryKeys = [...this.deliveries.keys()].filter((key) => key.startsWith(`${userId}:`));
    const before = this.subscriptions.length + this.pushes.length + deliveryKeys.length;
    this.subscriptions = this.subscriptions.filter((item) => item.userId !== userId);
    this.pushes = this.pushes.filter((item) => item.userId !== userId);
    deliveryKeys.forEach((key) => this.deliveries.delete(key));
    return before - this.subscriptions.length - this.pushes.length - deliveryKeys.filter((key) => this.deliveries.has(key)).length;
  }
  async putChanges(changes: readonly BenefitChange[]) {
    let inserted = 0;
    for (const change of changes) {
      if (!this.changes.some((item) => item.id === change.id)) { this.changes.push(change); inserted += 1; }
    }
    return inserted;
  }
  async listChanges(statuses?: readonly BenefitChange["status"][]) {
    return this.changes.filter((item) => !statuses?.length || statuses.includes(item.status));
  }
  async getChange(id: string) { return this.changes.find((item) => item.id === id); }
  async reviewChange(id: string, decision: "APPROVED" | "REJECTED", reviewer: string, at: string) {
    const change = this.changes.find((item) => item.id === id && item.status === "PENDING");
    if (!change) throw new Error("Change was not found or is no longer pending");
    Object.assign(change, { status: decision, reviewedBy: reviewer, reviewedAt: at });
    return change;
  }
  async getBulkReviewOperation(operationId: string) {
    return this.bulkReviewOperations.get(operationId);
  }
  async putBulkReviewOperation(value: BulkReviewOperation) {
    const existing = this.bulkReviewOperations.get(value.id);
    if (existing) return existing;
    this.bulkReviewOperations.set(value.id, value);
    return value;
  }
  async approveBulkReviewChunk(operationId: string, at: string, maxChanges: number) {
    if (!Number.isInteger(maxChanges) || maxChanges < 1 || maxChanges > 100) {
      throw new Error("Bulk review chunk size must be between 1 and 100");
    }
    const operation = this.bulkReviewOperations.get(operationId);
    if (!operation) throw new BulkReviewConflictError("Bulk review operation was not found");
    if (operation.status === "COMPLETED") return { operation, processedCount: 0 };
    const ids = operation.changeIds.slice(operation.approvedCount, operation.approvedCount + Math.min(maxChanges, 99));
    const changes = ids.map((id) => this.changes.find((change) => change.id === id));
    if (!ids.length || changes.some((change) => change === undefined
      || change.status !== "PENDING"
      || change.risk !== "HIGH"
      || change.action !== "ADD"
      || change.before !== undefined
      || change.after === undefined
      || change.detectedAt !== operation.detectedAt
      || inferReviewSource(change) !== operation.source)) {
      throw new BulkReviewConflictError();
    }
    for (const change of changes as BenefitChange[]) {
      Object.assign(change, {
        source: operation.source,
        status: "APPROVED",
        reviewedAt: at,
        reviewedBy: operation.reviewer,
        reviewOperationId: operation.id,
        reviewReason: operation.reason,
      });
    }
    const approvedCount = operation.approvedCount + ids.length;
    const complete = approvedCount === operation.expectedCount;
    const updated: BulkReviewOperation = {
      ...operation,
      approvedCount,
      updatedAt: at,
      ...(complete ? { status: "COMPLETED", completedAt: at } : {}),
    };
    this.bulkReviewOperations.set(operationId, updated);
    return { operation: updated, processedCount: ids.length };
  }
  async markChangesPublished(ids: readonly string[], at: string) {
    for (const change of this.changes) if (ids.includes(change.id)) Object.assign(change, { status: "PUBLISHED", publishedAt: at });
  }
  async reserveDelivery(value: DeliveryReservation) {
    const key = `${value.userId}:${value.idempotencyKey}`;
    const previous = this.deliveries.get(key);
    if (previous && previous.status !== "FAILED") return false;
    this.deliveries.set(key, value);
    return true;
  }
  async finishDelivery(userId: string, key: string, status: "SENT" | "FAILED", at: string, error?: string) {
    const id = `${userId}:${key}`;
    const previous = this.deliveries.get(id);
    if (!previous) throw new Error("missing delivery");
    this.deliveries.set(id, { ...previous, status, updatedAt: at, ...(error ? { error } : {}) });
  }
}

export class FakeStorage implements DatasetStorage {
  benefits: Benefit[] = [];
  snapshots: string[] = [];
  candidates: Benefit[][] = [];
  async loadBenefits() { return this.benefits; }
  async saveSnapshot(source: string, _at: string, body: string) { this.snapshots.push(body); return `raw/${source}`; }
  async saveCandidate(source: string, _at: string, benefits: readonly Benefit[]) {
    this.candidates.push([...benefits]); return `candidate/${source}`;
  }
  async publish(benefits: readonly Benefit[], generatedAt: string): Promise<DatasetManifest> {
    this.benefits = [...benefits];
    return { schemaVersion: 1, datasetId: "test", generatedAt, indexUrl: "/data/test.json", sha256: "0".repeat(64), itemCount: benefits.length };
  }
}

export function httpEvent(
  path: string,
  method: string,
  body?: Record<string, unknown>,
  options: { query?: Record<string, string>; pathParameters?: Record<string, string>; groups?: string[] } = {},
): HttpEvent {
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    requestContext: {
      accountId: "test", apiId: "test", domainName: "test", domainPrefix: "test", requestId: "test",
      routeKey: `${method} ${path}`, stage: "$default", time: "", timeEpoch: 0,
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "vitest" },
      authorizer: { jwt: { claims: {
        sub: "user-1", email: "pilot@example.com",
        ...(options.groups ? { "cognito:groups": options.groups } : {}),
      }, scopes: [] } },
    },
    isBase64Encoded: false,
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(options.query ? { queryStringParameters: options.query } : {}),
    ...(options.pathParameters ? { pathParameters: options.pathParameters } : {}),
  };
}

export function scheduleEvent() {
  return {
    version: "0", id: "test", "detail-type": "Scheduled Event", source: "aws.events",
    account: "test", time: "2026-07-12T00:00:00Z", region: "ap-northeast-2", resources: [], detail: {},
  };
}
