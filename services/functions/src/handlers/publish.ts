import type { Benefit, BenefitChange } from "@honor/core";
import type {
  AppRepository,
  Clock,
  DatasetStorage,
  DeploymentTrigger,
  NotificationTrigger,
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

    const changes = (await deps.repository.listChanges(["AUTO_APPROVED", "APPROVED"]))
      .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));
    if (!changes.length) throw new HttpError(409, "게시할 승인 변경이 없습니다.");
    const pending = await deps.repository.listChanges(["PENDING"]);
    if (pending.length) {
      throw new HttpError(409, `검수 대기 변경 ${pending.length}건을 모두 처리한 뒤 게시해 주세요.`);
    }

    const current = await deps.storage.loadBenefits();
    const initialBaseline = current.length === 0;
    const items = applyChanges(current, changes);
    const now = (deps.clock ?? systemClock).now().toISOString();
    const publication = await deps.storage.publish(items, now);
    const changeIds = changes.map((change) => change.id);
    let deploymentJobId: string;
    try {
      const startedJobId = await deps.deployment.start();
      if (!startedJobId) throw new Error("Amplify deployment is not configured");
      deploymentJobId = startedJobId;
    } catch (deploymentError) {
      try {
        await publication.rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [deploymentError, rollbackError],
          "Amplify deployment failed and the manifest rollback also failed",
        );
      }
      throw deploymentError;
    }

    await deps.repository.markChangesPublished(changeIds, now);
    if (!initialBaseline) await deps.notifications.immediate(changeIds);
    return json(200, {
      manifest: publication.manifest,
      publishedChanges: changes.length,
      deploymentJobId,
      deploymentStatus: "SUCCEED",
      ...(initialBaseline ? { notificationsSuppressed: true } : {}),
    });
  });
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
