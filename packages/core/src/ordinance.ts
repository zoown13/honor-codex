import { hashCanonical } from "./canonical.ts";
import { UNKNOWN_OFFICIAL_DETAIL } from "./constants.ts";
import { regionCodesForLocalGovernment } from "./regions.ts";
import type { Benefit, OrdinanceRecord } from "./types.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "text">>;

export interface LawApiClientOptions {
  oc: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export class LawApiClient {
  readonly #oc: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(options: LawApiClientOptions) {
    if (!options.oc.trim()) throw new Error("law.go.kr OC is required");
    this.#oc = options.oc.trim();
    this.#baseUrl = (options.baseUrl?.trim() || "https://www.law.go.kr/DRF").replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
  }

  async searchOrdinances(query = "병역명문가", page = 1, display = 100, search: 1 | 2 = 1): Promise<OrdinanceRecord[]> {
    const url = new URL(`${this.#baseUrl}/lawSearch.do`);
    url.search = new URLSearchParams({
      OC: this.#oc, target: "ordin", type: "JSON", query,
      page: String(page), display: String(Math.min(Math.max(display, 1), 100)),
      nw: "1", search: String(search),
    }).toString();
    const response = await this.#fetch(url);
    if (!response.ok) throw new Error(`law.go.kr search failed: HTTP ${response.status}`);
    return parseOrdinanceSearch(await response.text());
  }

  async getMatchingArticles(id: string): Promise<string[]> {
    const url = new URL(`${this.#baseUrl}/lawService.do`);
    url.search = new URLSearchParams({ OC: this.#oc, target: "ordin", type: "JSON", ID: id }).toString();
    const response = await this.#fetch(url);
    if (!response.ok) throw new Error(`law.go.kr detail failed: HTTP ${response.status}`);
    return parseMatchingArticles(await response.text());
  }
}

export function parseOrdinanceSearch(input: string): OrdinanceRecord[] {
  const text = input.replace(/^\uFEFF/, "").trim();
  const rows = text.startsWith("<") ? parseXmlRows(text) : findOrdinanceRows(JSON.parse(text) as unknown);
  return rows.map(normalizeOrdinanceRow).filter((item): item is OrdinanceRecord => item !== undefined);
}

export function parseMatchingArticles(input: string): string[] {
  const text = input.replace(/^\uFEFF/, "").trim();
  const values: string[] = [];
  if (text.startsWith("<")) {
    for (const match of text.matchAll(/<(?:조문내용|항내용|호내용|articleContent)\b[^>]*>([\s\S]*?)<\/[^>]+>/gi)) {
      values.push(stripMarkup(match[1] ?? ""));
    }
  } else {
    collectArticleValues(JSON.parse(text) as unknown, values);
  }
  return [...new Set(values.filter((value) => value.includes("병역명문가")))];
}

export function normalizeOrdinance(record: OrdinanceRecord, retrievedAt: string): Benefit {
  const summary = record.matchingArticles[0] || UNKNOWN_OFFICIAL_DETAIL;
  return {
    id: `ord:${record.id}`,
    type: "ORDINANCE",
    scope: "REGION",
    title: record.title,
    provider: record.localGovernment || "지방자치단체",
    category: "지자체 조례",
    benefitKind: "OTHER",
    summary,
    eligibility: [UNKNOWN_OFFICIAL_DETAIL],
    requiredProof: [UNKNOWN_OFFICIAL_DETAIL],
    howToUse: [UNKNOWN_OFFICIAL_DETAIL],
    constraints: [UNKNOWN_OFFICIAL_DETAIL],
    regionCodes: regionCodesForLocalGovernment(record.localGovernment),
    validity: { checkedAt: retrievedAt, ...(record.effectiveAt ? { startsAt: record.effectiveAt } : {}) },
    status: "PENDING_REVIEW",
    source: { system: "LAW_GO_KR", id: record.id, url: record.url, retrievedAt, contentHash: hashCanonical(record) },
    evidence: record.matchingArticles.length
      ? record.matchingArticles.map((article, index) => ({
          label: `${record.title} 근거 ${index + 1}`,
          sourceUrl: record.url, sourceId: record.id, excerpt: article.slice(0, 240),
        }))
      : [{ label: "국가법령정보센터 자치법규", sourceUrl: record.url, sourceId: record.id }],
    reviewState: "SOURCE_ONLY",
    updatedAt: record.updatedAt || record.promulgatedAt || retrievedAt,
    searchText: `${record.title} ${record.localGovernment} ${summary} 병역명문가 조례`.toLocaleLowerCase("ko-KR"),
  };
}

function findOrdinanceRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["ordin", "Ordin", "items", "list"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) return [candidate];
  }
  for (const candidate of Object.values(value)) {
    const found = findOrdinanceRows(candidate);
    if (found.length) return found;
  }
  return [];
}

function parseXmlRows(xml: string): Record<string, unknown>[] {
  if (xml.length > 5 * 1024 * 1024) throw new Error("law.go.kr XML is too large");
  const rows: Record<string, unknown>[] = [];
  for (const block of xml.matchAll(/<(?:ordin|자치법규)\b[^>]*>([\s\S]*?)<\/(?:ordin|자치법규)>/gi)) {
    const row: Record<string, unknown> = {};
    for (const tag of (block[1] ?? "").matchAll(/<([^\s/>]+)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
      if (tag[1]) row[tag[1]] = stripMarkup(tag[2] ?? "");
    }
    rows.push(row);
  }
  return rows;
}

function normalizeOrdinanceRow(row: Record<string, unknown>): OrdinanceRecord | undefined {
  const id = pick(row, "자치법규ID", "ordinId", "ID", "id");
  const title = pick(row, "자치법규명", "ordinNm", "법규명", "title");
  if (!id || !title) return undefined;
  const localGovernment = pick(row, "지자체기관명", "자치단체명", "orgName", "localGovernment");
  const url = pick(row, "자치법규상세링크", "법령상세링크", "url")
    || `https://www.law.go.kr/자치법규/${encodeURIComponent(title)}/(${encodeURIComponent(id)})`;
  const optional = (key: string, ...aliases: string[]): string => pick(row, key, ...aliases);
  const promulgatedAt = normalizeLawDate(optional("공포일자", "promulgatedAt"));
  const effectiveAt = normalizeLawDate(optional("시행일자", "effectiveAt"));
  const updatedAt = normalizeLawDate(optional("수정일자", "updatedAt"));
  const kind = optional("자치법규종류", "kind");
  const revisionType = optional("제개정구분명", "revisionType");
  return {
    id, title, localGovernment, url, matchingArticles: [],
    ...(promulgatedAt ? { promulgatedAt } : {}),
    ...(effectiveAt ? { effectiveAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(kind ? { kind } : {}),
    ...(revisionType ? { revisionType } : {}),
  };
}

function collectArticleValues(value: unknown, output: string[]): void {
  if (Array.isArray(value)) { value.forEach((item) => collectArticleValues(item, output)); return; }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /조문내용|항내용|호내용|articleContent/i.test(key)) output.push(stripMarkup(child));
    else collectArticleValues(child, output);
  }
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

function normalizeLawDate(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) return undefined;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function stripMarkup(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
