import { hashCanonical } from "./canonical.ts";
import { UNKNOWN_OFFICIAL_DETAIL } from "./constants.ts";
import { parseJsonp } from "./jsonp.ts";
import type { Benefit, RawMmaNotice } from "./types.ts";

const NOTICE_BOARD_URL = "https://www.mma.go.kr/hall/board/boardList.do?mc=mma0003487&gesipan_id=517";

export function parseMmaNotices(input: string): RawMmaNotice[] {
  const text = input.replace(/^\uFEFF/, "").trim();
  if (text.startsWith("<") || /<html|<table|<a\s/i.test(text)) return parseNoticeHtml(text);
  const value = parseJsonp<unknown>(text);
  const rows = findRecordArray(value);
  return rows.map(normalizeRawNotice).filter((item): item is RawMmaNotice => item !== undefined);
}

export function normalizeMmaNotice(raw: RawMmaNotice, retrievedAt: string): Benefit {
  const summary = raw.body?.trim() || UNKNOWN_OFFICIAL_DETAIL;
  return {
    id: `nat:${raw.gsgeul_no}`,
    type: "NATIONAL",
    scope: "NATIONAL",
    title: raw.title,
    provider: "병무청",
    category: "전국 혜택",
    benefitKind: "OTHER",
    summary,
    eligibility: [UNKNOWN_OFFICIAL_DETAIL],
    requiredProof: [UNKNOWN_OFFICIAL_DETAIL],
    howToUse: ["공식 원문과 문의처에서 적용 조건 확인"],
    constraints: [UNKNOWN_OFFICIAL_DETAIL],
    regionCodes: ["11"],
    validity: { checkedAt: retrievedAt },
    status: "PENDING_REVIEW",
    source: {
      system: "MMA", id: raw.gsgeul_no, url: raw.url, retrievedAt,
      contentHash: hashCanonical(raw),
    },
    evidence: [{
      label: "병무청 병역명문가 공지",
      sourceUrl: raw.url,
      sourceId: raw.gsgeul_no,
      ...(summary === UNKNOWN_OFFICIAL_DETAIL ? {} : { excerpt: summary.slice(0, 240) }),
    }],
    reviewState: "SOURCE_ONLY",
    updatedAt: raw.updatedAt || raw.publishedAt || retrievedAt,
    searchText: `${raw.title} ${summary} 병무청 전국 혜택`.toLocaleLowerCase("ko-KR"),
  };
}

export function normalizeMmaNotices(raw: readonly RawMmaNotice[], retrievedAt: string): Benefit[] {
  return raw.map((item) => normalizeMmaNotice(item, retrievedAt));
}

function parseNoticeHtml(html: string): RawMmaNotice[] {
  if (html.length > 5 * 1024 * 1024) throw new Error("MMA notice HTML is too large");
  const notices = new Map<string, RawMmaNotice>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? "";
    const combined = `${href} ${attributes}`;
    const id = /(?:gsgeul_no=|gsgeul_no[^0-9]+|goView\s*\(\s*["']?)(\d{1,20})/i.exec(combined)?.[1];
    const title = stripHtml(body);
    if (!id || !title) continue;
    const url = officialNoticeUrl(href);
    notices.set(id, { gsgeul_no: id, title, url });
  }
  return [...notices.values()];
}

function normalizeRawNotice(row: Record<string, unknown>): RawMmaNotice | undefined {
  const id = pick(row, "gsgeul_no", "nttId", "id");
  const title = pick(row, "sj", "title", "gsgeul_sj", "nttSj");
  if (!id || !title) return undefined;
  const providedUrl = pick(row, "url", "link");
  const url = providedUrl
    ? officialNoticeUrl(providedUrl)
    : `${NOTICE_BOARD_URL}&gsgeul_no=${encodeURIComponent(id)}`;
  const publishedAt = pick(row, "regdate", "frstRegisterPnttm", "publishedAt");
  const updatedAt = pick(row, "last_updt_pnttm", "lastUpdatePnttm", "updatedAt");
  const body = pick(row, "ntt_cn", "body", "content");
  return {
    gsgeul_no: id, title, url,
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(body ? { body: stripHtml(body) } : {}),
  };
}

function findRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) throw new Error("Invalid MMA notice payload");
  for (const key of ["list", "items", "results", "resultList"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  for (const candidate of Object.values(value)) {
    if (isRecord(candidate) || Array.isArray(candidate)) {
      try { return findRecordArray(candidate); } catch { /* continue */ }
    }
  }
  throw new Error("MMA notice list was not found");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      const result = String(value).trim();
      if (result) return result;
    }
  }
  return "";
}

function officialNoticeUrl(value: string): string {
  try {
    const url = new URL(decodeEntities(value || NOTICE_BOARD_URL), NOTICE_BOARD_URL);
    const officialHost = url.hostname === "mma.go.kr" || url.hostname.endsWith(".mma.go.kr");
    return officialHost && (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : NOTICE_BOARD_URL;
  } catch {
    return NOTICE_BOARD_URL;
  }
}
function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_all, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _all;
    }
    return named[entity.toLowerCase()] ?? _all;
  });
}
