import { sha256Hex } from "@honor/core";
import type { Benefit, BenefitChange } from "@honor/core";
import type {
  AppRepository,
  Clock,
  DatasetStorage,
  DeploymentTrigger,
  NotificationTrigger,
  PublicationOperation,
} from "../shared/contracts.js";
import {
  DeploymentOutcomeUnknownError,
  PublicationConflictError,
} from "../shared/contracts.js";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import {
  HttpError,
  json,
  method,
  requireAdmin,
  withHttpErrors,
} from "../shared/http.js";
import {
  datasetStorage,
  deploymentTrigger,
  notificationTrigger,
  repository,
  systemClock,
} from "../shared/runtime.js";

export function createPublishHandler(
  deps: {
    repository: AppRepository;
    storage: DatasetStorage;
    deployment: DeploymentTrigger;
    notifications: NotificationTrigger;
    clock?: Clock;
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  return (event: HttpEvent): Promise<HttpResult> => withHttpErrors(async () => {
    requireAdmin(event, env);
    if (method(event) !== "POST") throw new HttpError(405, "허용되지 않은 요청입니다.");
    if (env.PUBLISH_ENABLED?.trim().toLocaleLowerCase("en-US") !== "true") {
      throw new HttpError(503, "게시 기능이 현재 비활성화되어 있습니다.");
    }

    const now = (deps.clock ?? systemClock).now().toISOString();
    let operation = await deps.repository.getPublicationOperation();
    if (!operation || operation.status === "COMPLETED" || operation.status === "FAILED") {
      const pending = await deps.repository.listChanges(["PENDING"]);
      if (pending.length) {
        throw new HttpError(409, `검수 대기 변경 ${pending.length}건을 모두 처리한 뒤 게시해 주세요.`);
      }
      const changes = (await deps.repository.listChanges(["AUTO_APPROVED", "APPROVED"]))
        .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));
      if (!changes.length) throw new HttpError(409, "게시할 승인 변경이 없습니다.");

      const current = await deps.storage.loadBenefits();
      const changeIds = changes.map((change) => change.id);
      const fingerprint = sha256Hex([...changeIds].sort().join("\n"));
      const proposed: PublicationOperation = {
        id: `pub:${fingerprint.slice(0, 32)}`,
        fingerprint,
        changeIds,
        initialBaseline: current.length === 0,
        status: "PREPARING",
        createdAt: now,
        updatedAt: now,
      };
      try {
        operation = (await deps.repository.beginPublication(proposed)).operation;
      } catch (error) {
        if (error instanceof PublicationConflictError) {
          throw new HttpError(409, "다른 게시 작업이 진행 중입니다.");
        }
        throw error;
      }
    }

    if (operation.status === "PREPARING") {
      const eligible = await deps.repository.listChanges(["AUTO_APPROVED", "APPROVED"]);
      const eligibleById = new Map(eligible.map((change) => [change.id, change]));
      const changes = operation.changeIds.map((id) => eligibleById.get(id));
      if (changes.some((change) => change === undefined)) {
        throw new HttpError(409, "게시 작업의 승인 변경 집합이 현재 상태와 일치하지 않습니다.");
      }
      const current = await deps.storage.loadBenefits();
      const publication = await deps.storage.publish(
        applyChanges(current, changes as BenefitChange[]),
        operation.createdAt,
      );
      try {
        operation = await deps.repository.stagePublication(
          operation.id,
          publication.manifest,
          publication.rollbackToken,
          now,
        );
      } catch (stageError) {
        const stored = await deps.repository.getPublicationOperation();
        if (stored?.id === operation.id
          && stored.status === "STAGED"
          && stored.manifest?.datasetId === publication.manifest.datasetId) {
          operation = stored;
        } else {
          await rollbackAndFail(
            deps,
            operation.id,
            publication.rollbackToken,
            now,
            stageError,
          );
          throw stageError;
        }
      }
    }

    if (operation.status === "STAGED") {
      // StartJob can be accepted by AWS even if the response is lost. Keep the
      // exact staged manifest and operation so a retry can safely deploy it again.
      const jobId = await deps.deployment.start();
      if (!jobId) throw new Error("Amplify deployment is not configured");
      try {
        operation = await deps.repository.recordPublicationJob(operation.id, jobId, now);
      } catch (_recordError) {
        const stored = await deps.repository.getPublicationOperation();
        if (stored?.id === operation.id
          && stored.status === "DEPLOYING"
          && stored.deploymentJobId === jobId) {
          operation = stored;
        } else {
          throw new DeploymentOutcomeUnknownError(
            jobId,
            `Amplify deployment ${jobId} started but its publication record could not be confirmed`,
          );
        }
      }
    }

    if (operation.status === "DEPLOYING") {
      const jobId = requiredPublicationField(operation.deploymentJobId, "deployment job ID");
      try {
        await deps.deployment.wait(jobId);
      } catch (deploymentError) {
        if (deploymentError instanceof DeploymentOutcomeUnknownError) throw deploymentError;
        const rollbackToken = requiredPublicationField(
          operation.manifestRollbackToken,
          "manifest rollback token",
        );
        await rollbackAndFail(deps, operation.id, rollbackToken, now, deploymentError);
        throw deploymentError;
      }
      try {
        operation = await deps.repository.markPublicationDeployed(operation.id, jobId, now);
      } catch (recordError) {
        const stored = await deps.repository.getPublicationOperation();
        if (stored?.id === operation.id && stored.status === "DEPLOYED") {
          operation = stored;
        } else {
          throw recordError;
        }
      }
    }

    if (operation.status !== "DEPLOYED") {
      throw new Error(`Publication operation ${operation.id} cannot be finalized from ${operation.status}`);
    }
    const manifest = operation.manifest;
    if (!manifest) throw new Error(`Publication operation ${operation.id} has no manifest`);
    const deploymentJobId = requiredPublicationField(operation.deploymentJobId, "deployment job ID");
    await deps.repository.markChangesPublished(
      operation.changeIds,
      operation.deployedAt ?? now,
      operation.id,
    );
    if (!operation.initialBaseline) {
      await deps.notifications.immediate(operation.changeIds);
    }
    await deps.repository.completePublication(operation.id, now);

    return json(200, {
      manifest,
      publishedChanges: operation.changeIds.length,
      deploymentJobId,
      deploymentStatus: "SUCCEED",
      ...(operation.initialBaseline ? { notificationsSuppressed: true } : {}),
    });
  });
}

async function rollbackAndFail(
  deps: {
    repository: AppRepository;
    storage: DatasetStorage;
  },
  operationId: string,
  rollbackToken: string,
  at: string,
  cause: unknown,
): Promise<void> {
  try {
    await deps.storage.rollback(rollbackToken);
    await deps.repository.failPublication(
      operationId,
      at,
      cause instanceof Error ? cause.message : String(cause),
    );
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "Publication failed and the manifest rollback also failed",
    );
  }
}

function requiredPublicationField(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Publication operation has no ${label}`);
  return value;
}

export function applyChanges(current: readonly Benefit[], changes: readonly BenefitChange[]): Benefit[] {
  const items = new Map(current.map((benefit) => [benefit.id, benefit]));
  for (const change of changes) {
    if (change.action === "DELETE") {
      items.delete(change.benefitId);
      continue;
    }
    if (!change.after) throw new Error(`Change ${change.id} has no after value`);
    items.set(change.benefitId, { ...change.after, reviewState: "REVIEWED" });
  }
  return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createPublishHandler({
    repository: repository(),
    storage: datasetStorage(),
    deployment: deploymentTrigger(),
    notifications: notificationTrigger(),
  })(event);
