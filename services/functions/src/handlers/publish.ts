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

    const changes = (await deps.repository.listChanges(["AUTO_APPROVED", "APPROVED"]))
      .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.id.localeCompare(b.id));
    if (!changes.length) throw new HttpError(409, "게시할 승인 변경이 없습니다.");
    const current = await deps.storage.loadBenefits();
    const items = applyChanges(current, changes);
    const now = (deps.clock ?? systemClock).now().toISOString();
    const manifest = await deps.storage.publish(items, now);
    const changeIds = changes.map((change) => change.id);
    const deploymentJobId = await deps.deployment.start();
    await deps.repository.markChangesPublished(changeIds, now);
    await deps.notifications.immediate(changeIds);
    return json(202, {
      manifest,
      publishedChanges: changes.length,
      ...(deploymentJobId ? { deploymentJobId } : { deploymentSkipped: true }),
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
