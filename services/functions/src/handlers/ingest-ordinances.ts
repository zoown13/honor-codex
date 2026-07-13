import { LawApiClient, normalizeOrdinance } from "@honor/core";
import type { OrdinanceRecord } from "@honor/core";
import type { ScheduledEvent } from "aws-lambda";
import type { AppRepository, Clock, DatasetStorage } from "../shared/contracts.js";
import { persistIngestion } from "../shared/ingestion.js";
import { datasetStorage, nonEmpty, repository, systemClock } from "../shared/runtime.js";

export interface OrdinanceClient {
  searchOrdinances(query?: string, page?: number, display?: number, search?: 1 | 2): Promise<OrdinanceRecord[]>;
  getMatchingArticles(id: string): Promise<string[]>;
}

export interface OrdinanceIngestDeps {
  repository: AppRepository;
  storage: DatasetStorage;
  client: OrdinanceClient;
  clock?: Clock;
}

export function createOrdinanceIngestHandler(deps: OrdinanceIngestDeps) {
  return async (_event: ScheduledEvent<unknown>): Promise<unknown> => {
    const now = (deps.clock ?? systemClock).now().toISOString();
    const recordsById = new Map<string, OrdinanceRecord>();
    for (const search of [1, 2] as const) {
      for (let page = 1; page <= 50; page += 1) {
        const pageRecords = await deps.client.searchOrdinances("병역명문가", page, 100, search);
        pageRecords.forEach((record) => recordsById.set(record.id, record));
        if (pageRecords.length < 100) break;
        if (page === 50) throw new Error(`law.go.kr search scope ${search} exceeded the 5,000 item safety limit`);
      }
    }

    const enriched: OrdinanceRecord[] = [];
    for (const record of recordsById.values()) {
      const matchingArticles = await deps.client.getMatchingArticles(record.id);
      enriched.push({ ...record, matchingArticles });
    }
    const benefits = enriched.map((record) => normalizeOrdinance(record, now));
    return persistIngestion(deps.repository, deps.storage, {
      sourceName: "law-ordinances",
      benefitType: "ORDINANCE",
      rawBody: JSON.stringify({ query: "병역명문가", searchScopes: [1, 2], records: enriched }),
      benefits,
      retrievedAt: now,
    });
  };
}

export const handler = async (event: ScheduledEvent<unknown>): Promise<unknown> => {
  const oc = nonEmpty(process.env.LAW_API_OC);
  if (!oc) return { skipped: true, reason: "LAW_API_OC is not configured" };
  const client = new LawApiClient({
    oc,
    baseUrl: nonEmpty(process.env.LAW_API_BASE_URL) || "https://www.law.go.kr/DRF",
  });
  return createOrdinanceIngestHandler({ repository: repository(), storage: datasetStorage(), client })(event);
};
