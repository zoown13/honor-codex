import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type { HttpEvent } from "../shared/http.js";
import { HttpError, json, method, parseBody, requireAdmin, requirePilotAdmin, withHttpErrors } from "../shared/http.js";
import { required } from "../shared/runtime.js";

export const SOURCES = ["MMA_FACILITIES", "MMA_NOTICES", "LAW_ORDINANCES"] as const;
export type Source = typeof SOURCES[number];
export interface IngestionJob {
  source: Source;
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: string;
  updatedAt: string;
  expiresAt: number;
  message?: string;
}
export interface JobStore {
  get(source: Source): Promise<IngestionJob | null>;
  begin(job: IngestionJob): Promise<boolean>;
  update(job: IngestionJob, expectedStatus: IngestionJob["status"]): Promise<boolean>;
}
export function parseSource(value: unknown): Source {
  if (!SOURCES.includes(value as Source)) throw new HttpError(400, "지원하지 않는 수집 원천입니다.");
  return value as Source;
}
export function createIngestionControl(deps: { store: JobStore; enqueue(job: IngestionJob): Promise<void> }, env = process.env) {
  return (event: HttpEvent) => withHttpErrors(async () => {
    if (event.rawPath.startsWith("/v1/pilot-admin/")) requirePilotAdmin(event, env);
    else requireAdmin(event, env);
    if (method(event) === "GET") {
      const jobs = await Promise.all(SOURCES.map((source) => deps.store.get(source)));
      return json(200, { jobs: jobs.filter(Boolean).map((job) => {
        if (job && ["QUEUED", "RUNNING"].includes(job.status) && job.expiresAt <= Date.now()) {
          return { ...job, status: "FAILED", message: "작업 시간이 초과되었습니다. 검수함을 확인한 뒤 다시 수집해 주세요." };
        }
        return job;
      }) });
    }
    if (method(event) !== "POST") throw new HttpError(405, "허용되지 않은 요청입니다.");
    const source = parseSource(parseBody(event).source);
    if (source === "LAW_ORDINANCES" ? env.LAW_INGESTION_AVAILABLE !== "true" : env.MMA_LIVE_INGESTION_ENABLED !== "true") {
      throw new HttpError(409, "이 원천의 실데이터 수집 설정이 활성화되지 않았습니다.");
    }
    const now = new Date().toISOString();
    const job: IngestionJob = { source, id: randomUUID(), status: "QUEUED", startedAt: now, updatedAt: now, expiresAt: Date.now() + 20 * 60_000 };
    if (!await deps.store.begin(job)) throw new HttpError(409, "이 원천은 이미 수집 중입니다. 상태를 확인해 주세요.");
    try { await deps.enqueue(job); }
    catch (error) {
      await deps.store.update({ ...job, status: "FAILED", message: "수집 요청을 전달하지 못했습니다. 다시 시도해 주세요." }, "QUEUED");
      throw error;
    }
    return json(202, { job });
  });
}

export class DynamoJobStore implements JobStore {
  private readonly client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  private readonly table = required(process.env, "TABLE_NAME");
  private key(source: Source) { return { pk: "MANUAL_INGESTION", sk: source }; }
  async get(source: Source): Promise<IngestionJob | null> {
    const response = await this.client.send(new GetCommand({ TableName: this.table, Key: this.key(source), ConsistentRead: true }));
    return response.Item?.job as IngestionJob ?? null;
  }
  async begin(job: IngestionJob) {
    try {
      await this.client.send(new PutCommand({ TableName: this.table, Item: { ...this.key(job.source), job },
        ConditionExpression: "attribute_not_exists(pk) OR #job.#status IN (:completed, :failed) OR #job.expiresAt <= :now",
        ExpressionAttributeNames: { "#job": "job", "#status": "status" },
        ExpressionAttributeValues: { ":completed": "COMPLETED", ":failed": "FAILED", ":now": Date.now() } }));
      return true;
    } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
  }
  async update(job: IngestionJob, expectedStatus: IngestionJob["status"]) {
    try {
      await this.client.send(new UpdateCommand({ TableName: this.table, Key: this.key(job.source),
        UpdateExpression: "SET #job = :job", ConditionExpression: "#job.id = :id AND #job.#status = :expected",
        ExpressionAttributeNames: { "#job": "job", "#status": "status" },
        ExpressionAttributeValues: { ":job": job, ":id": job.id, ":expected": expectedStatus } }));
      return true;
    } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false; throw error; }
  }
}
export const handler = (event: HttpEvent) => createIngestionControl({
  store: new DynamoJobStore(),
  async enqueue(job) {
    await new LambdaClient({}).send(new InvokeCommand({ FunctionName: required(process.env, "INGESTION_WORKER_NAME"), InvocationType: "Event", Payload: Buffer.from(JSON.stringify(job)) }));
  },
})(event);
