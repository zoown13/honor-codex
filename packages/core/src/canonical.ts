import { sha256 } from "./sha256.ts";
import type { Benefit, BenefitChange, ChangeAction, ChangeRisk } from "./types.ts";

export function canonicalStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalized = normalize(value, seen);
  if (normalized === undefined) throw new TypeError("Cannot canonicalize undefined");
  return JSON.stringify(normalized);
}

export function sha256Hex(value: string | Uint8Array): string {
  return sha256(value);
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Unsupported canonical value: ${typeof value}`);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("Cannot canonicalize a cyclic value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => normalize(entry, seen) ?? null);
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = normalize(record[key], seen);
      if (child !== undefined) result[key] = child;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

const VOLATILE_FIELDS = new Set<keyof Benefit>(["updatedAt", "searchText"]);
const HIGH_RISK_FIELDS = new Set<keyof Benefit>([
  "type", "scope", "title", "provider", "benefitKind", "summary", "eligibility", "amount", "requiredProof",
  "howToUse", "constraints", "address", "displayAddress", "location", "regionCodes", "validity", "status", "evidence",
]);

export function changedBenefitFields(before: Benefit, after: Benefit): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof Benefit)[]);
  return [...keys]
    .filter((key) => !VOLATILE_FIELDS.has(key))
    .filter((key) => {
      if (key === "source") return hashCanonical(stableSource(before.source)) !== hashCanonical(stableSource(after.source));
      if (key === "validity") return hashCanonical(stableValidity(before.validity))
        !== hashCanonical(stableValidity(after.validity));

      return hashCanonicalOrUndefined(before[key]) !== hashCanonicalOrUndefined(after[key]);
    })
    .sort();
}

export function classifyChangeRisk(action: ChangeAction, changedFields: string[]): ChangeRisk {
  if (action === "DELETE") return "HIGH";
  if (action === "ADD") return "LOW";
  return changedFields.some((field) => HIGH_RISK_FIELDS.has(field as keyof Benefit)) ? "HIGH" : "LOW";
}

export function diffBenefitSets(
  beforeItems: readonly Benefit[],
  afterItems: readonly Benefit[],
  detectedAt: string,
): BenefitChange[] {
  const before = new Map(beforeItems.map((item) => [item.id, item]));
  const after = new Map(afterItems.map((item) => [item.id, item]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: BenefitChange[] = [];

  for (const benefitId of ids) {
    const previous = before.get(benefitId);
    const next = after.get(benefitId);
    const action: ChangeAction = previous === undefined ? "ADD" : next === undefined ? "DELETE" : "UPDATE";
    const changedFields = previous !== undefined && next !== undefined
      ? changedBenefitFields(previous, next)
      : [previous === undefined ? "created" : "deleted"];
    if (action === "UPDATE" && changedFields.length === 0) continue;
    const risk = action === "ADD" && next?.type !== "FACILITY"
      ? "HIGH" : classifyChangeRisk(action, changedFields);
    const id = `chg:${sha256Hex(canonicalStringify({
      benefitId, action, changedFields,
      before: previous === undefined ? null : semanticBenefit(previous),
      after: next === undefined ? null : semanticBenefit(next),
    })).slice(0, 24)}`;
    changes.push({
      id, benefitId, action, risk,
      status: risk === "LOW" ? "AUTO_APPROVED" : "PENDING",
      changedFields,
      ...(previous === undefined ? {} : { before: previous }),
      ...(next === undefined ? {} : { after: next }),
      detectedAt,
    });
  }
  return changes;
}

function stableSource(source: Benefit["source"]): Omit<Benefit["source"], "retrievedAt"> {
  const { retrievedAt: _retrievedAt, ...stable } = source;
  return stable;
}

function stableValidity(validity: Benefit["validity"]): Omit<Benefit["validity"], "checkedAt"> {
  const { checkedAt: _checkedAt, ...stable } = validity;
  return stable;
}

function semanticBenefit(benefit: Benefit): Record<string, unknown> {
  const { updatedAt: _updatedAt, searchText: _searchText, source, validity, ...stable } = benefit;
  return { ...stable, validity: stableValidity(validity), source: stableSource(source) };
}

function hashCanonicalOrUndefined(value: unknown): string {
  return value === undefined ? "undefined" : hashCanonical(value);
}
