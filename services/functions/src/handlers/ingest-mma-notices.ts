import { normalizeMmaNotices, parseMmaNotices } from "@honor/core";
import type { ScheduledEvent } from "aws-lambda";
import type { AppRepository, Clock, DatasetStorage } from "../shared/contracts.js";
import { fetchText, persistIngestion } from "../shared/ingestion.js";
import { datasetStorage, liveMmaEnabled, nonEmpty, repository, systemClock } from "../shared/runtime.js";

const DEFAULT_URL = "https://www.mma.go.kr/hall/board/boardList.do?mc=mma0003487&gesipan_id=517";

export interface MmaNoticeIngestDeps {
  repository: AppRepository;
  storage: DatasetStorage;
  fetcher?: typeof fetch;
  clock?: Clock;
}

export function createMmaNoticeIngestHandler(deps: MmaNoticeIngestDeps, env: NodeJS.ProcessEnv = process.env) {
  return async (_event: ScheduledEvent<unknown>): Promise<unknown> => {
    if (!liveMmaEnabled(env)) return { skipped: true, reason: "MMA live ingestion is disabled" };
    const now = (deps.clock ?? systemClock).now().toISOString();
    const url = new URL(nonEmpty(env.MMA_NOTICES_URL) || DEFAULT_URL);
    const body = await fetchText(url, deps.fetcher ?? fetch, 5 * 1024 * 1024);
    const benefits = normalizeMmaNotices(parseMmaNotices(body), now);
    return persistIngestion(deps.repository, deps.storage, {
      sourceName: "mma-notices", benefitType: "NATIONAL", rawBody: body, benefits, retrievedAt: now,
    });
  };
}

export const handler = async (event: ScheduledEvent<unknown>): Promise<unknown> => {
  if (!liveMmaEnabled()) return { skipped: true, reason: "MMA live ingestion is disabled" };
  return createMmaNoticeIngestHandler({ repository: repository(), storage: datasetStorage() })(event);
};
