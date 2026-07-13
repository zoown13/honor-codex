import type { BenefitChange, ChangeStatus } from "@honor/core";
import type { AppRepository, Clock } from "../shared/contracts.js";
import type { HttpEvent, HttpResult } from "../shared/http.js";
import {
  HttpError,
  json,
  method,
  parseBody,
  requireAdmin,
  withHttpErrors,
} from "../shared/http.js";
import { repository, systemClock } from "../shared/runtime.js";

const STATUSES = new Set<ChangeStatus>(["AUTO_APPROVED", "PENDING", "APPROVED", "REJECTED", "PUBLISHED"]);

export function createAdminReviewsHandler(
  deps: { repository: AppRepository; clock?: Clock },
  env: NodeJS.ProcessEnv = process.env,
) {
  return (event: HttpEvent): Promise<HttpResult> => withHttpErrors(async () => {
    const admin = requireAdmin(event, env);
    if (method(event) === "GET") {
      const requested = event.queryStringParameters?.status;
      if (requested && !STATUSES.has(requested as ChangeStatus)) throw new HttpError(400, "status가 올바르지 않습니다.");
      const statuses = requested ? [requested as ChangeStatus] : ["PENDING" as const];
      const items = await deps.repository.listChanges(statuses);
      return json(200, { items });
    }

    if (method(event) === "POST") {
      const body = event.body ? parseBody(event) : {};
      const changeId = event.pathParameters?.reviewId || event.pathParameters?.id;
      if (!changeId) throw new HttpError(400, "reviewId가 필요합니다.");
      const pathDecision = event.rawPath.endsWith("/approve") ? "APPROVED"
        : event.rawPath.endsWith("/reject") ? "REJECTED" : undefined;
      const rawDecision = typeof body.decision === "string" ? body.decision.toUpperCase() : undefined;
      const decision = pathDecision || (rawDecision === "APPROVE" ? "APPROVED" : rawDecision === "REJECT" ? "REJECTED" : rawDecision);
      if (decision !== "APPROVED" && decision !== "REJECTED") {
        throw new HttpError(400, "decision은 APPROVED 또는 REJECTED여야 합니다.");
      }
      try {
        const reviewed: BenefitChange = await deps.repository.reviewChange(
          changeId,
          decision,
          admin.email,
          (deps.clock ?? systemClock).now().toISOString(),
        );
        return json(200, reviewed);
      } catch (error) {
        if (error instanceof Error && error.message.includes("no longer pending")) {
          throw new HttpError(409, "이미 처리되었거나 찾을 수 없는 변경입니다.");
        }
        throw error;
      }
    }

    throw new HttpError(405, "허용되지 않은 요청입니다.");
  });
}

export const handler = (event: HttpEvent): Promise<HttpResult> =>
  createAdminReviewsHandler({ repository: repository() })(event);
