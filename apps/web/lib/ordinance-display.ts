import type { Benefit } from "@honor/core";

export interface OrdinanceContentDate {
  label: "수정일" | "시행일" | "확인일";
  value: string;
  timestamp: number;
}

function dateCandidate(
  value: string | undefined,
  label: OrdinanceContentDate["label"]
): OrdinanceContentDate | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? { label, value, timestamp } : undefined;
}

function isLegacyAiGeneratedUpdate(benefit: Benefit): boolean {
  const generatedAt = benefit.summaryProvenance?.generatedAt;
  if (!generatedAt) return false;
  if (generatedAt === benefit.updatedAt) return true;

  const generatedTimestamp = Date.parse(generatedAt);
  const updatedTimestamp = Date.parse(benefit.updatedAt);
  return Number.isFinite(generatedTimestamp)
    && Number.isFinite(updatedTimestamp)
    && generatedTimestamp === updatedTimestamp;
}

/**
 * Returns the best available date for judging how recent an ordinance's
 * official content is. Legacy pilot summaries created before source-date
 * preservation replaced that date with their AI generation time; those
 * legacy records fall back to the ordinance effective date instead.
 */
export function ordinanceContentDate(benefit: Benefit): OrdinanceContentDate | undefined {
  if (benefit.type !== "ORDINANCE") return undefined;

  if (isLegacyAiGeneratedUpdate(benefit)) {
    return dateCandidate(benefit.validity.startsAt, "시행일")
      ?? dateCandidate(benefit.validity.checkedAt, "확인일");
  }

  return dateCandidate(benefit.updatedAt, "수정일")
    ?? dateCandidate(benefit.validity.startsAt, "시행일")
    ?? dateCandidate(benefit.validity.checkedAt, "확인일");
}

export function compareOrdinancesByLatestContent(first: Benefit, second: Benefit): number {
  const dateDifference = (ordinanceContentDate(second)?.timestamp ?? 0)
    - (ordinanceContentDate(first)?.timestamp ?? 0);
  if (dateDifference) return dateDifference;

  const titleDifference = first.title.localeCompare(second.title, "ko-KR");
  return titleDifference || first.id.localeCompare(second.id, "ko-KR");
}
