#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  LawApiClient,
  normalizeMmaFacilities,
  normalizeMmaNotices,
  parseMmaFacilityPayload,
  parseMmaNotices,
} from "../packages/core/src/index.ts";

const FACILITIES_URL = "https://open.mma.go.kr/caisGGGS/bymmgListAjaxJsonCall.json";
const NOTICES_URL = "https://www.mma.go.kr/hall/board/boardList.do?mc=mma0003487&gesipan_id=517";
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
    let scopeCount = 0;
    for (let page = 1; page <= 50; page += 1) {
      const records = await law.searchOrdinances(undefined, page, 100, scope);
      scopeCount += records.length;
      for (const record of records) {
        recordsById.set(record.id, record);
        if (recordsById.size > 1_000) {
          throw new Error("law.go.kr preflight exceeded the 1,000 unique record safety limit");
        }
      }
      if (records.length < 100) break;
      if (page === 50) throw new Error("law.go.kr preflight exceeded the page safety limit");
    }
    searchCounts[scope] = scopeCount;
    if (scopeCount === 0) throw new Error("law.go.kr preflight returned zero ordinances for a search scope");
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
