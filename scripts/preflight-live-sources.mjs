#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  hashCanonical,
  LawApiClient,
  normalizeMmaFacilities,
  normalizeMmaNotices,
  parseMmaFacilityPayload,
  parseMmaNotices,
} from "../packages/core/src/index.ts";

const FACILITIES_URL = "https://open.mma.go.kr/caisGGGS/bymmgListAjaxJsonCall.json";
const NOTICES_URL = "https://www.mma.go.kr/hall/board/boardList.do?mc=mma0003395&gesipan_id=217";
const LAW_URL = "https://www.law.go.kr/DRF";
const PILOT_ORIGIN = "https://main.d23uh0qxg7a3z7.amplifyapp.com";
const CALLBACK = "honorPilot";

const secrets = [];

try {
  const env = parseEnv(await readFile(new URL("../.env.deploy.local", import.meta.url), "utf8"));
  const kakaoKey = required(env, "NEXT_PUBLIC_KAKAO_MAP_APP_KEY");
  const lawOc = required(env, "LAW_API_OC");
  secrets.push(kakaoKey, lawOc, encodeURIComponent(kakaoKey), encodeURIComponent(lawOc));
  if (env.MMA_LIVE_INGESTION_ENABLED?.toLowerCase() !== "true") {
    throw new Error("MMA_LIVE_INGESTION_ENABLED must be true for live preflight");
  }

  const facilityUrl = new URL(env.MMA_FACILITIES_URL || FACILITIES_URL);
  facilityUrl.searchParams.set("callback", CALLBACK);
  const facilityBody = await fetchText(facilityUrl, 8 * 1024 * 1024);
  const facilityPayload = parseMmaFacilityPayload(facilityBody, CALLBACK);
  const facilities = normalizeMmaFacilities(facilityPayload.list, new Date().toISOString());
  const facilityIds = new Set(facilities.map((item) => item.id));
  if (facilities.length < 100 || facilityIds.size !== facilities.length) {
    throw new Error("MMA facility count or identifier uniqueness is outside the safe baseline");
  }

  const noticeBody = await fetchText(new URL(env.MMA_NOTICES_URL || NOTICES_URL), 5 * 1024 * 1024);
  const rawNotices = parseMmaNotices(noticeBody);
  const notices = normalizeMmaNotices(rawNotices, new Date().toISOString());
  const noticeIds = new Set(notices.map((item) => item.id));
  if (!notices.length || noticeIds.size !== notices.length) {
    throw new Error("MMA notice preflight returned zero or duplicate identifiers");
  }

  const lawFetch = async (input, init) => {
    const body = await fetchText(new URL(input), 5 * 1024 * 1024, init);
    return { ok: true, status: 200, text: async () => body };
  };
  const law = new LawApiClient({
    oc: lawOc,
    baseUrl: env.LAW_API_BASE_URL || LAW_URL,
    fetch: lawFetch,
  });
  const recordsById = new Map();
  const searchCounts = {};
  for (const scope of [1, 2]) {
    const expectedSection = scope === 1 ? "ordinNm" : "bdyText";
    const pageFingerprints = new Set();
    const recordFingerprints = new Set();
    let expectedTotal;
    let totalPages = 1;
    let rawRecordCount = 0;

    for (let requestedPage = 1; requestedPage <= totalPages; requestedPage += 1) {
      const result = await law.searchOrdinances(undefined, requestedPage, 100, scope);
      validateLawSearchPage(result, scope, requestedPage, expectedSection, expectedTotal);
      if (expectedTotal === undefined) {
        expectedTotal = result.totalCount;
        totalPages = Math.ceil(expectedTotal / 100);
        if (totalPages > 50) throw new Error("law.go.kr preflight exceeded the 50 page safety limit");
      }

      const expectedPageSize = Math.min(100, expectedTotal - ((requestedPage - 1) * 100));
      if (result.rowCount !== expectedPageSize || result.records.length !== expectedPageSize) {
        throw new Error(
          `law.go.kr preflight scope ${scope} page ${requestedPage} was incomplete: expected ${expectedPageSize} records, metadata reported ${result.rowCount}, parsed ${result.records.length}`,
        );
      }

      const fingerprint = lawPageFingerprint(result.records);
      if (pageFingerprints.has(fingerprint)) {
        throw new Error(`law.go.kr preflight scope ${scope} repeated page content at page ${requestedPage}`);
      }
      pageFingerprints.add(fingerprint);
      rawRecordCount += result.records.length;

      for (const record of result.records) {
        const recordFingerprint = hashCanonical(record);
        if (recordFingerprints.has(recordFingerprint)) {
          throw new Error(`law.go.kr preflight scope ${scope} repeated record content at page ${requestedPage}`);
        }
        recordFingerprints.add(recordFingerprint);

        recordsById.set(record.id, preferLawOrdinance(recordsById.get(record.id), record));
        if (recordsById.size > 2_000) {
          throw new Error("law.go.kr preflight exceeded the 2,000 unique record safety limit");
        }
      }
    }

    if (rawRecordCount !== expectedTotal) {
      throw new Error(`law.go.kr preflight scope ${scope} returned ${rawRecordCount} raw records, expected ${expectedTotal}`);
    }
    searchCounts[scope] = rawRecordCount;
  }
  const detailSamples = [];
  for (const record of [...recordsById.values()].slice(0, 3)) {
    const articles = await law.getMatchingArticles(record.id);
    detailSamples.push({ id: record.id, title: record.title, matchingArticles: articles.length });
  }

  if (!/^[A-Za-z0-9_-]{20,128}$/.test(kakaoKey)) {
    throw new Error("Kakao JavaScript key format is unexpected");
  }
  const kakaoUrl = new URL("https://dapi.kakao.com/v2/maps/sdk.js");
  kakaoUrl.searchParams.set("appkey", kakaoKey);
  kakaoUrl.searchParams.set("autoload", "false");
  const kakaoScript = await fetchText(kakaoUrl, 2 * 1024 * 1024, {
    headers: { Referer: env.KAKAO_ALLOWED_ORIGIN || PILOT_ORIGIN },
  });
  if (!/kakao\.maps/i.test(kakaoScript)) {
    throw new Error("Kakao SDK response did not contain the expected maps namespace");
  }

  console.log(JSON.stringify({
    writesPerformed: false,
    mmaFacilities: {
      count: facilities.length,
      uniqueIds: facilityIds.size,
      missingCoordinates: facilities.filter((item) => !item.location).length,
    },
    mmaNotices: {
      count: notices.length,
      uniqueIds: noticeIds.size,
      samples: notices.slice(0, 3).map((item) => ({ id: item.id, title: item.title })),
    },
    lawOrdinances: {
      recordsBySearchScope: searchCounts,
      uniqueRecords: recordsById.size,
      detailSamples,
    },
    kakaoSdk: { ok: true, bytes: Buffer.byteLength(kakaoScript, "utf8") },
  }, null, 2));
} catch (error) {
  let message = error instanceof Error ? (error.stack || error.message) : String(error);
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  console.error(message);
  process.exitCode = 1;
}

function parseEnv(input) {
  const values = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("Invalid .env.deploy.local line");
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(key + " is required in .env.deploy.local");
  return value;
}

async function fetchText(url, maxBytes, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json, text/javascript, text/html;q=0.8",
      "user-agent": "honor-benefits-pilot-preflight/0.1",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("Source preflight failed with HTTP " + response.status);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Source preflight response is too large");
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Source preflight response is too large");
  return body;
}

function validateLawSearchPage(result, scope, requestedPage, expectedSection, expectedTotal) {
  if (result.page !== requestedPage) {
    throw new Error(`law.go.kr preflight scope ${scope} page mismatch: expected ${requestedPage}, received ${result.page}`);
  }
  if (result.target !== "ordin") {
    throw new Error(`law.go.kr preflight scope ${scope} returned unexpected target ${result.target}`);
  }
  if (result.section !== expectedSection) {
    throw new Error(`law.go.kr preflight scope ${scope} returned unexpected section ${result.section}`);
  }
  if (!Number.isSafeInteger(result.totalCount) || result.totalCount <= 0) {
    throw new Error(`law.go.kr preflight scope ${scope} returned no ordinance records`);
  }
  if (expectedTotal !== undefined && result.totalCount !== expectedTotal) {
    throw new Error(`law.go.kr preflight scope ${scope} total changed from ${expectedTotal} to ${result.totalCount}`);
  }
}

function lawPageFingerprint(records) {
  const semanticRecords = records
    .map((record) => ({ id: record.id, hash: hashCanonical(record) }))
    .sort((left, right) => left.id.localeCompare(right.id) || left.hash.localeCompare(right.hash));
  return hashCanonical(semanticRecords);
}

function preferLawOrdinance(current, candidate) {
  if (!current) return candidate;
  const currentTimestamp = newestLawOrdinanceTimestamp(current);
  const candidateTimestamp = newestLawOrdinanceTimestamp(candidate);
  if (candidateTimestamp !== currentTimestamp) return candidateTimestamp > currentTimestamp ? candidate : current;
  return hashCanonical(candidate) > hashCanonical(current) ? candidate : current;
}

function newestLawOrdinanceTimestamp(record) {
  const timestamps = [record.updatedAt, record.promulgatedAt, record.effectiveAt]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
}
