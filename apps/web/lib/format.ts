import type { BenefitKind, BenefitStatus, BenefitType } from "@honor/core";

export const TYPE_LABEL: Record<BenefitType, string> = {
  FACILITY: "예우시설",
  NATIONAL: "전국 혜택",
  ORDINANCE: "지자체 조례"
};

export const KIND_LABEL: Record<BenefitKind, string> = {
  FREE: "무료",
  DISCOUNT: "할인",
  OTHER: "기타"
};

export const STATUS_LABEL: Record<BenefitStatus, string> = {
  ACTIVE: "이용 가능",
  PENDING_REVIEW: "검수 대기",
  ENDED: "종료",
  NEEDS_CONFIRMATION: "이용 전 확인"
};

export function formatDistance(value: number | undefined) {
  if (value === undefined) return "거리 확인 불가";
  if (value < 1) return `${Math.round(value * 1_000)}m`;
  return `${value.toFixed(value < 10 ? 1 : 0)}km`;
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}
