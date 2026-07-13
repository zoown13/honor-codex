import { hashCanonical } from "./canonical.ts";
import { MMA_BENEFIT_KIND, MMA_CATEGORY_NAMES, MMA_REGION_CODES, UNKNOWN_OFFICIAL_DETAIL } from "./constants.ts";
import { isCoordinateInKorea } from "./search.ts";
import type { Benefit, BenefitContact, BenefitValidity, RawMmaFacility } from "./types.ts";

const MMA_LIST_URL = "https://www.mma.go.kr/hall/listsearch.do?mc=mma0003390";

export function normalizeMmaFacility(raw: RawMmaFacility, retrievedAt: string): Benefit {
  const sourceId = clean(raw.mmgudgigwan_cd);
  const title = clean(raw.udae_ggm);
  if (!sourceId || !title) throw new Error("MMA facility is missing its id or name");

  const detail = clean(raw.udsangse_cn) || UNKNOWN_OFFICIAL_DETAIL;
  const address = clean(raw.addr);
  const displayAddress = clean(raw.displayaddr);
  const regionCode = clean(raw.udjiyeok_cd);
  const categoryCode = clean(raw.udggeopjong_gbcd);
  const benefitKind = MMA_BENEFIT_KIND[clean(raw.udae_gbcd)] ?? "OTHER";
  const location = coordinate(raw.wido_vl, raw.gyeongdo_vl);
  const phone = clean(raw.udgigwan_telno);
  const website = normalizeWebsite(clean(raw.hmpg_addr));
  const contact: BenefitContact | undefined = phone || website
    ? { ...(phone ? { phone } : {}), ...(website ? { website } : {}) }
    : undefined;
  const startsAt = normalizeDate(raw.hyjeokyong_sjdt);
  const endsAt = normalizeDate(raw.hyjeokyong_jrdt || raw.udgghaeje_dt);
  const validity: BenefitValidity = {
    checkedAt: retrievedAt,
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
  const activeCode = clean(raw.udgigwan_yhcd);
  const status = activeCode && activeCode !== "01" ? "ENDED" : "ACTIVE";
  const sourceHash = hashCanonical(raw);
  const category = MMA_CATEGORY_NAMES[categoryCode] ?? (categoryCode ? `미분류(${categoryCode})` : "미분류");
  const amount = clean(raw.udhmgagyeok_cn);
  const searchText = [title, category, address, displayAddress, detail, phone]
    .filter(Boolean).join(" ").toLocaleLowerCase("ko-KR");

  return {
    id: `fac:${sourceId}`,
    type: "FACILITY",
    scope: regionCode === "11" ? "NATIONAL" : "VENUE",
    title,
    provider: title,
    category,
    benefitKind,
    summary: detail,
    eligibility: [UNKNOWN_OFFICIAL_DETAIL],
    ...(amount ? { amount } : {}),
    requiredProof: [UNKNOWN_OFFICIAL_DETAIL],
    howToUse: [UNKNOWN_OFFICIAL_DETAIL],
    constraints: [UNKNOWN_OFFICIAL_DETAIL],
    ...(address ? { address } : {}),
    ...(displayAddress ? { displayAddress } : {}),
    regionCodes: regionCode ? (MMA_REGION_CODES[regionCode] ?? [regionCode]) : [],
    ...(location ? { location } : {}),
    ...(contact ? { contact } : {}),
    validity,
    status,
    source: {
      system: "MMA",
      id: sourceId,
      url: MMA_LIST_URL,
      retrievedAt,
      contentHash: sourceHash,
    },
    evidence: [{
      label: "병무청 병역명문가 우대시설",
      sourceUrl: MMA_LIST_URL,
      sourceId,
      ...(detail === UNKNOWN_OFFICIAL_DETAIL ? {} : { excerpt: detail.slice(0, 240) }),
    }],
    reviewState: "SOURCE_ONLY",
    updatedAt: retrievedAt,
    searchText,
  };
}

export function normalizeMmaFacilities(raw: readonly RawMmaFacility[], retrievedAt: string): Benefit[] {
  const seen = new Set<string>();
  return raw.map((item) => normalizeMmaFacility(item, retrievedAt)).filter((item) => {
    if (seen.has(item.id)) throw new Error(`Duplicate MMA facility id: ${item.id}`);
    seen.add(item.id);
    return true;
  });
}

function coordinate(latitudeValue: unknown, longitudeValue: unknown): Benefit["location"] | undefined {
  const latitude = Number(clean(latitudeValue));
  const longitude = Number(clean(longitudeValue));
  return isCoordinateInKorea({ latitude, longitude }) ? { latitude, longitude, provenance: "MMA" } : undefined;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeDate(value: unknown): string | undefined {
  const digits = clean(value).replace(/\D/g, "");
  if (digits.length < 8) return undefined;
  const result = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  return Number.isNaN(Date.parse(`${result}T00:00:00Z`)) ? undefined : result;
}

function normalizeWebsite(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
