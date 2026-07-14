import { hashCanonical, LawApiClient, normalizeOrdinance } from "@honor/core";
import type { OrdinanceRecord, OrdinanceSearchPage } from "@honor/core";
import type { ScheduledEvent } from "aws-lambda";
import type { AppRepository, Clock, DatasetStorage } from "../shared/contracts.js";
import { persistIngestion } from "../shared/ingestion.js";
import { datasetStorage, nonEmpty, repository, systemClock } from "../shared/runtime.js";

const MAX_UNIQUE_ORDINANCES = 2_000;
const DETAIL_CONCURRENCY = 5;
const EXECUTION_BUDGET_MS = 7 * 60 * 1_000;

export interface OrdinanceClient {
  searchOrdinances(query?: string, page?: number, display?: number, search?: 1 | 2): Promise<OrdinanceSearchPage>;
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
    const rawRecordsByScope: Record<1 | 2, number> = { 1: 0, 2: 0 };
    for (const search of [1, 2] as const) {
      const expectedSection = search === 1 ? "ordinNm" : "bdyText";
      const pageFingerprints = new Set<string>();
      const recordFingerprints = new Set<string>();
      let expectedTotal: number | undefined;
      let totalPages = 1;
      let rawRecordCount = 0;

      for (let requestedPage = 1; requestedPage <= totalPages; requestedPage += 1) {
        const result = await deps.client.searchOrdinances("병역명문가", requestedPage, 100, search);
        validateSearchPage(result, search, requestedPage, expectedSection, expectedTotal);
        const pageTotal = expectedTotal ?? result.totalCount;
        if (expectedTotal === undefined) {
          expectedTotal = pageTotal;
          totalPages = Math.ceil(pageTotal / 100);
          if (totalPages > 50) {
            throw new Error(`law.go.kr search scope ${search} exceeded the 50 page safety limit`);
          }
        }

        const expectedPageSize = Math.min(100, pageTotal - ((requestedPage - 1) * 100));
        if (result.rowCount !== expectedPageSize || result.records.length !== expectedPageSize) {
          throw new Error(
            `law.go.kr search scope ${search} page ${requestedPage} was incomplete: expected ${expectedPageSize} records, metadata reported ${result.rowCount}, parsed ${result.records.length}`,
          );
        }

        const fingerprint = pageFingerprint(result.records);
        if (pageFingerprints.has(fingerprint)) {
          throw new Error(`law.go.kr search scope ${search} repeated page content at page ${requestedPage}`);
        }
        pageFingerprints.add(fingerprint);
        rawRecordCount += result.records.length;

        for (const record of result.records) {
          const recordFingerprint = hashCanonical(record);
          if (recordFingerprints.has(recordFingerprint)) {
            throw new Error(`law.go.kr search scope ${search} repeated record content at page ${requestedPage}`);
          }
          recordFingerprints.add(recordFingerprint);

          recordsById.set(record.id, preferOrdinance(recordsById.get(record.id), record));
          if (recordsById.size > MAX_UNIQUE_ORDINANCES) {
            throw new Error("law.go.kr search exceeded the 2,000 unique record safety limit");
          }
        }
      }

      if (rawRecordCount !== expectedTotal) {
        throw new Error(`law.go.kr search scope ${search} returned ${rawRecordCount} raw records, expected ${expectedTotal}`);
      }
      rawRecordsByScope[search] = rawRecordCount;
    }

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
      rawBody: JSON.stringify({ query: "병역명문가", searchScopes: [1, 2], rawRecordsByScope, records: enriched }),
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

function validateSearchPage(
  result: OrdinanceSearchPage,
  search: 1 | 2,
  requestedPage: number,
  expectedSection: "ordinNm" | "bdyText",
  expectedTotal: number | undefined,
): void {
  if (result.page !== requestedPage) {
    throw new Error(`law.go.kr search scope ${search} page mismatch: expected ${requestedPage}, received ${result.page}`);
  }
  if (result.target !== "ordin") {
    throw new Error(`law.go.kr search scope ${search} returned unexpected target ${result.target}`);
  }
  if (result.section !== expectedSection) {
    throw new Error(`law.go.kr search scope ${search} returned unexpected section ${result.section}`);
  }
  if (!Number.isSafeInteger(result.totalCount) || result.totalCount <= 0) {
    throw new Error(`law.go.kr search scope ${search} returned no ordinance records`);
  }
  if (expectedTotal !== undefined && result.totalCount !== expectedTotal) {
    throw new Error(`law.go.kr search scope ${search} total changed from ${expectedTotal} to ${result.totalCount}`);
  }
}

function pageFingerprint(records: readonly OrdinanceRecord[]): string {
  const semanticRecords = records
    .map((record) => ({ id: record.id, hash: hashCanonical(record) }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.hash.localeCompare(right.hash));
  return hashCanonical(semanticRecords);
}

function preferOrdinance(current: OrdinanceRecord | undefined, candidate: OrdinanceRecord): OrdinanceRecord {
  if (!current) return candidate;
  const currentTimestamp = newestOrdinanceTimestamp(current);
  const candidateTimestamp = newestOrdinanceTimestamp(candidate);
  if (candidateTimestamp !== currentTimestamp) return candidateTimestamp > currentTimestamp ? candidate : current;
  return hashCanonical(candidate) > hashCanonical(current) ? candidate : current;
}

function newestOrdinanceTimestamp(record: OrdinanceRecord): number {
  const timestamps = [record.updatedAt, record.promulgatedAt, record.effectiveAt]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
}
