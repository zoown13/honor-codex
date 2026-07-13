"use client";

import type { SearchResult } from "@honor/core";
import { formatDistance, KIND_LABEL, STATUS_LABEL, TYPE_LABEL } from "../lib/format";

interface BenefitCardProps {
  benefit: SearchResult;
  onSelect: (benefit: SearchResult) => void;
  onFollow: (benefit: SearchResult) => void;
  compact?: boolean;
}

export function BenefitCard({ benefit, onSelect, onFollow, compact = false }: BenefitCardProps) {
  return (
    <article className={`benefit-card${compact ? " benefit-card--compact" : ""}`}>
      <div className="benefit-card__topline">
        <div className="tag-row" aria-label="혜택 분류">
          <span className={`tag tag--${benefit.type.toLocaleLowerCase()}`}>
            {TYPE_LABEL[benefit.type]}
          </span>
          <span className={`tag tag--kind-${benefit.benefitKind.toLocaleLowerCase()}`}>
            {KIND_LABEL[benefit.benefitKind]}
          </span>
        </div>
        {benefit.type === "FACILITY" ? (
          <span className="distance-label">{formatDistance(benefit.distanceKm)}</span>
        ) : null}
      </div>

      <button className="benefit-card__main" type="button" onClick={() => onSelect(benefit)}>
        <span className="benefit-card__title">{benefit.title}</span>
        <span className="benefit-card__summary">{benefit.summary}</span>
        <span className="benefit-card__meta">
          <span>{benefit.provider}</span>
          {benefit.displayAddress ? <span>{benefit.displayAddress}</span> : null}
        </span>
      </button>

      <footer className="benefit-card__footer">
        <span className={`status status--${benefit.status.toLocaleLowerCase()}`}>
          <span className="status__dot" aria-hidden="true" />
          {STATUS_LABEL[benefit.status]}
        </span>
        <div className="benefit-card__actions">
          <button
            className="text-action"
            type="button"
            onClick={() => onFollow(benefit)}
            aria-label={`${benefit.title} 변경 알림 받기`}
          >
            + 알림
          </button>
          <button className="detail-action" type="button" onClick={() => onSelect(benefit)}>
            자세히 <span aria-hidden="true">›</span>
          </button>
        </div>
      </footer>
    </article>
  );
}
