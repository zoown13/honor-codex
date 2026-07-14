import { LawApiClient, normalizeOrdinance } from "@honor/core";
import type { OrdinanceRecord } from "@honor/core";
import type { ScheduledEvent } from "aws-lambda";
import type { AppRepository, Clock, DatasetStorage } from "../shared/contracts.js";
import { persistIngestion } from "../shared/ingestion.js";
import { datasetStorage, nonEmpty, repository, systemClock } from "../shared/runtime.js";

const MAX_UNIQUE_ORDINANCES = 2_000;
const DETAIL_CONCURRENCY = 5;
const EXECUTION_BUDGET_MS = 7 * 60 * 1_000;

export interface OrdinanceClient {
  searchOrdinances(query?: string, page?: number, display?: number, search?: 1 | 2): Promise<OrdinanceRecord[]>;
  getMatchingArticles(id: string): Promise<string[]>;
}

export interface OrdinanceIngestDeps {
  repository: AppRepository;
  storage: DatasetStorage;
  client: OrdinanceClient;
  clock?: Clock;
  monotonicNow?: () => number;
}

export function createOrdinanceIngestHandler(deps: OrdinanceIngestDeps) {
  return async (_event: ScheduledEvent<unknown>): Promise<unknown> => {
    const now = (deps.clock ?? systemClock).now().toISOString();
    const monotonicNow = deps.monotonicNow ?? Date.now;
    const deadline = monotonicNow() + EXECUTION_BUDGET_MS;
    const recordsById = new Map<string, OrdinanceRecord>();
    for (const search of [1, 2] as const) {
      for (let page = 1; page <= 50; page += 1) {
        const pageRecords = await deps.client.searchOrdinances("병역명문가", page, 100, search);
        for (const record of pageRecords) {
          recordsById.set(record.id, record);
          if (recordsById.size > MAX_UNIQUE_ORDINANCES) {
            throw new Error("law.go.kr search exceeded the 2,000 unique record safety limit");
          }
        }
        if (pageRecords.length < 100) break;
        if (page === 50) throw new Error(`law.go.kr search scope ${search} exceeded the 5,000 item safety limit`);
      }
    }

    if (recordsById.size === 0) throw new Error("law.go.kr search returned no ordinance records");

    const records = [...recordsById.values()];
    const enriched = new Array<OrdinanceRecord>(records.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, records.length) }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= records.length) return;
        if (monotonicNow() >= deadline) {
          throw new Error("law.go.kr ingestion exceeded its execution safety budget");
        }
        const record = records[index];
        if (!record) return;
        const matchingArticles = await deps.client.getMatchingArticles(record.id);
        if (monotonicNow() >= deadline) {
          throw new Error("law.go.kr ingestion exceeded its execution safety budget");
        }
        enriched[index] = { ...record, matchingArticles };
      }
    });
    await Promise.all(workers);
    const benefits = enriched.map((record) => normalizeOrdinance(record, now));
    return persistIngestion(deps.repository, deps.storage, {
      sourceName: "law-ordinances",
      benefitType: "ORDINANCE",
      benefitIdPrefix: "ord:",
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
