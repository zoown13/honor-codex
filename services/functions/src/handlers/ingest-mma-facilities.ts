import { normalizeMmaFacilities, parseMmaFacilityPayload } from "@honor/core";
import type { ScheduledEvent } from "aws-lambda";
import type { AppRepository, Clock, DatasetStorage } from "../shared/contracts.js";
import { fetchText, persistIngestion } from "../shared/ingestion.js";
import { datasetStorage, liveMmaEnabled, nonEmpty, repository, systemClock } from "../shared/runtime.js";

const DEFAULT_URL = "https://open.mma.go.kr/caisGGGS/bymmgListAjaxJsonCall.json";
const CALLBACK = "honorPilot";

export interface MmaFacilityIngestDeps {
  repository: AppRepository;
  storage: DatasetStorage;
  fetcher?: typeof fetch;
  clock?: Clock;
}

export function createMmaFacilityIngestHandler(
  deps: MmaFacilityIngestDeps,
  env: NodeJS.ProcessEnv = process.env,
) {
  return async (_event: ScheduledEvent<unknown>): Promise<unknown> => {
    if (!liveMmaEnabled(env)) return { skipped: true, reason: "MMA live ingestion is disabled" };
    const now = (deps.clock ?? systemClock).now().toISOString();
    const url = new URL(nonEmpty(env.MMA_FACILITIES_URL) || DEFAULT_URL);
    url.searchParams.set("callback", CALLBACK);
    const body = await fetchText(url, deps.fetcher ?? fetch);
    const payload = parseMmaFacilityPayload(body, CALLBACK);
    const benefits = normalizeMmaFacilities(payload.list, now);
    return persistIngestion(deps.repository, deps.storage, {
      sourceName: "mma-facilities", benefitType: "FACILITY", rawBody: body, benefits, retrievedAt: now,
    });
  };
}

export const handler = async (event: ScheduledEvent<unknown>): Promise<unknown> => {
  if (!liveMmaEnabled()) return { skipped: true, reason: "MMA live ingestion is disabled" };
  return createMmaFacilityIngestHandler({ repository: repository(), storage: datasetStorage() })(event);
};
