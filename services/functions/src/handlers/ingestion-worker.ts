import type { ScheduledEvent } from "aws-lambda";
import { DynamoJobStore, parseSource, type IngestionJob, type JobStore } from "./ingestion-control.js";
import { handler as facilities } from "./ingest-mma-facilities.js";
import { handler as notices } from "./ingest-mma-notices.js";
import { handler as ordinances } from "./ingest-ordinances.js";

export function createIngestionWorker(store: JobStore, collect: (source: IngestionJob["source"]) => Promise<unknown>) {
  return async (event: IngestionJob) => {
    const source = parseSource(event.source);
    const job = await store.get(source);
    if (!job || job.id !== event.id || job.status !== "QUEUED" || job.expiresAt <= Date.now()) return;
    const running: IngestionJob = { ...job, status: "RUNNING", updatedAt: new Date().toISOString() };
    if (!await store.update(running, "QUEUED")) return;
    try {
      const result = await collect(source);
      const skipped = typeof result === "object" && result !== null && "skipped" in result && result.skipped;
      await store.update({ ...running, status: skipped ? "FAILED" : "COMPLETED", updatedAt: new Date().toISOString(),
        message: skipped ? "원천 수집 설정을 확인해 주세요." : "수집이 완료되었습니다. 변경사항을 검수한 뒤 게시해 주세요." }, "RUNNING");
    } catch (error) {
      console.error("Manual ingestion failed", { source, jobId: job.id }, error);
      await store.update({ ...running, status: "FAILED", updatedAt: new Date().toISOString(), message: "수집에 실패했습니다. 원천 연결 상태를 확인한 뒤 다시 시도해 주세요." }, "RUNNING");
      throw error;
    }
  };
}
export const handler = (event: IngestionJob) => createIngestionWorker(new DynamoJobStore(), async (source) => {
  const scheduled = { source: "honor-manual-ingestion", detail: {} } as ScheduledEvent<unknown>;
  if (source === "MMA_FACILITIES") return facilities(scheduled);
  if (source === "MMA_NOTICES") return notices(scheduled);
  return ordinances(scheduled);
})(event);
