import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { sha256Hex } from "@honor/core";
import type { BenefitChange, BenefitChangeSource } from "@honor/core";
import type { AppRepository, Clock, DatasetStorage, PublicationOperation } from "../shared/contracts.js";
import { PublicationConflictError } from "../shared/contracts.js";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import { HttpError, json, method, parseBody, requireAdmin, requirePilotAdmin, withHttpErrors } from "../shared/http.js";
import { inferReviewSource } from "../shared/ingestion.js";
import { datasetStorage, repository, required, systemClock } from "../shared/runtime.js";

export const ALL_PUBLISH_SOURCES: readonly BenefitChangeSource[] = [
  "MMA_FACILITIES",
  "MMA_NOTICES",
  "LAW_ORDINANCES",
];
const SOURCE_SET = new Set<BenefitChangeSource>(ALL_PUBLISH_SOURCES);

export interface PublishWorkerInvoker {
  invoke(sources: readonly BenefitChangeSource[]): Promise<void>;
}

export function createPublishControlHandler(
  deps: {
    repository: AppRepository;
    storage: DatasetStorage;
    invoker: PublishWorkerInvoker;
    clock?: Clock;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  return (event: HttpEvent): Promise<HttpResult> => withHttpErrors(async () => {
    if (event.rawPath.startsWith("/v1/pilot-admin/")) requirePilotAdmin(event, env);
    else requireAdmin(event, env);

    const summaryChanges = await deps.repository.listReviewSummaryChanges();
    const overview = publishOverview(summaryChanges);
    const operation = await deps.repository.getPublicationOperation();
    if (method(event) === "GET") {
      return json(200, { ...overview, operation });
    }
    if (method(event) !== "POST") throw new HttpError(405, "허용되지 않은 요청입니다.");

    const body = event.body ? parseBody(event) : {};
    const sources = parseSources(body.sources);
    const selected = selectPublishable(summaryChanges, sources);
    const pendingCount = selected.filter((change) => change.status === "PENDING").length;
    const changes = selected
      .filter((change) => change.status === "APPROVED" || change.status === "AUTO_APPROVED")
      .sort((left, right) => left.detectedAt.localeCompare(right.detectedAt) || left.id.localeCompare(right.id));
    if (pendingCount > 0) {
      throw new HttpError(409, `선택한 원천에 검수 대기 변경 ${pendingCount}건이 있습니다. 승인 후 게시해 주세요.`);
    }
    if (!changes.length) throw new HttpError(409, "게시할 승인 변경이 없습니다.");
    const confirmationPhrase = `PUBLISH ${changes.length}`;
    if (body.confirmation !== confirmationPhrase) {
      throw new HttpError(400, `확인 문구가 일치하지 않습니다. ${confirmationPhrase}을 입력해 주세요.`);
    }

    let active = operation;
    if (!active || active.status === "COMPLETED" || active.status === "FAILED") {
      const now = (deps.clock ?? systemClock).now().toISOString();
      const changeIds = changes.map((change) => change.id);
      const fingerprint = sha256Hex([
        [...sources].sort().join(","),
        ...[...changeIds].sort(),
      ].join("\n"));
      const current = await deps.storage.loadBenefits();
      const proposed: PublicationOperation = {
        id: `pub:${fingerprint.slice(0, 32)}`,
        fingerprint,
        changeIds,
        publishSources: [...sources],
        initialBaseline: current.length === 0,
        status: "PREPARING",
        createdAt: now,
        updatedAt: now,
      };
      try {
        active = (await deps.repository.beginPublication(proposed)).operation;
      } catch (error) {
        if (error instanceof PublicationConflictError) {
          throw new HttpError(409, "다른 게시 작업이 이미 진행 중입니다.");
        }
        throw error;
      }
    } else if (!sameSources(active.publishSources, sources)) {
      throw new HttpError(409, "다른 원천 범위의 게시 작업이 진행 중입니다.");
    }

    await deps.invoker.invoke(active.publishSources);
    return json(202, {
      message: "게시 작업을 시작했습니다. 이 화면에서 배포 완료까지 상태를 확인할 수 있습니다.",
      operation: active,
    });
  });
}

export function publishOverview(changes: readonly BenefitChange[]) {
  const sources = Object.fromEntries(ALL_PUBLISH_SOURCES.map((source) => {
    const scoped = changes.filter((change) => inferReviewSource(change) === source);
    return [source, {
      pending: scoped.filter((change) => change.status === "PENDING").length,
      approved: scoped.filter((change) => change.status === "APPROVED" || change.status === "AUTO_APPROVED").length,
    }];
  })) as Record<BenefitChangeSource, { pending: number; approved: number }>;
  const approvedCount = Object.values(sources).reduce((total, item) => total + item.approved, 0);
  const pendingCount = Object.values(sources).reduce((total, item) => total + item.pending, 0);
  return {
    sources,
    approvedCount,
    pendingCount,
    confirmationPhrase: `PUBLISH ${approvedCount}`,
    canPublish: approvedCount > 0 && pendingCount === 0,
  };
}

function parseSources(value: unknown): BenefitChangeSource[] {
  if (value === undefined) return [...ALL_PUBLISH_SOURCES];
  if (!Array.isArray(value) || value.length < 1 || value.length > ALL_PUBLISH_SOURCES.length) {
    throw new HttpError(400, "sources는 1개 이상 3개 이하의 원천 배열이어야 합니다.");
  }
  const unique = new Set(value.map((source) => {
    if (typeof source !== "string" || !SOURCE_SET.has(source as BenefitChangeSource)) {
      throw new HttpError(400, "sources에 지원하지 않는 원천이 포함되어 있습니다.");
    }
    return source as BenefitChangeSource;
  }));
  return ALL_PUBLISH_SOURCES.filter((source) => unique.has(source));
}

function selectPublishable(changes: readonly BenefitChange[], sources: readonly BenefitChangeSource[]) {
  return changes.filter((change) => {
    const source = inferReviewSource(change);
    return source !== undefined && sources.includes(source);
  });
}

function sameSources(left: readonly BenefitChangeSource[], right: readonly BenefitChangeSource[]) {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

class LambdaPublishWorkerInvoker implements PublishWorkerInvoker {
  readonly #client = new LambdaClient({});
  readonly #functionName: string;

  constructor(functionName: string) {
    this.#functionName = functionName;
  }

  async invoke(sources: readonly BenefitChangeSource[]): Promise<void> {
    await this.#client.send(new InvokeCommand({
      FunctionName: this.#functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({
        source: "honor-pilot-publish-control",
        sources,
      })),
    }));
  }
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createPublishControlHandler({
    repository: repository(),
    storage: datasetStorage(),
    invoker: new LambdaPublishWorkerInvoker(required(process.env, "PUBLISH_FUNCTION_NAME")),
  })(event);
