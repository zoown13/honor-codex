"use client";

import { UNKNOWN_OFFICIAL_DETAIL, type Benefit } from "@honor/core";
import { useEffect, useRef } from "react";
import { formatDate, KIND_LABEL, STATUS_LABEL, TYPE_LABEL } from "../lib/format";

interface BenefitDetailProps {
  benefit: Benefit;
  onClose: () => void;
  onFollow: (benefit: Benefit) => void;
}

function DetailSection({
  title,
  items,
  fallback = UNKNOWN_OFFICIAL_DETAIL
}: {
  title: string;
  items: string[];
  fallback?: string;
}) {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="detail-fallback">{fallback}</p>
      )}
    </section>
  );
}

export function BenefitDetail({ benefit, onClose, onFollow }: BenefitDetailProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  const contactItems = [
    benefit.contact?.department,
    benefit.contact?.phone,
    benefit.contact?.website
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="detail-overlay" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <article
        className="detail-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="benefit-detail-title"
      >
        <header className="detail-sheet__header">
          <button ref={closeRef} className="icon-button" type="button" onClick={onClose}>
            <span aria-hidden="true">←</span>
            <span>닫기</span>
          </button>
          <button className="follow-button" type="button" onClick={() => onFollow(benefit)}>
            + 변경 알림
          </button>
        </header>

        <div className="detail-sheet__hero">
          <div className="tag-row">
            <span className={`tag tag--${benefit.type.toLocaleLowerCase()}`}>
              {TYPE_LABEL[benefit.type]}
            </span>
            <span className={`tag tag--kind-${benefit.benefitKind.toLocaleLowerCase()}`}>
              {KIND_LABEL[benefit.benefitKind]}
            </span>
          </div>
          <h2 id="benefit-detail-title">{benefit.title}</h2>
          <p>{benefit.summary}</p>
          <div className="detail-sheet__quickfacts">
            <span>{benefit.provider}</span>
            <span>{benefit.displayAddress ?? "전국"}</span>
            <span>{STATUS_LABEL[benefit.status]}</span>
          </div>
        </div>

        <div className="detail-sheet__content">
          <DetailSection title="누가 받을 수 있나요" items={benefit.eligibility} />
          <DetailSection
            title="혜택"
            items={benefit.amount ? [benefit.amount] : [benefit.summary]}
          />
          <DetailSection title="준비물" items={benefit.requiredProof} />
          <DetailSection title="이용 방법" items={benefit.howToUse} />
          <DetailSection title="주의사항" items={benefit.constraints} />

          <section className="detail-section">
            <h3>문의처</h3>
            {contactItems.length ? (
              <div className="contact-list">
                {benefit.contact?.department ? <p>{benefit.contact.department}</p> : null}
                {benefit.contact?.phone ? (
                  <a href={`tel:${benefit.contact.phone.replace(/[^0-9+]/g, "")}`}>
                    {benefit.contact.phone} 전화하기
                  </a>
                ) : null}
                {benefit.contact?.website ? (
                  <a href={benefit.contact.website} target="_blank" rel="noreferrer">
                    공식 홈페이지 열기 <span aria-hidden="true">↗</span>
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="detail-fallback">{UNKNOWN_OFFICIAL_DETAIL}</p>
            )}
          </section>

          <section className="detail-section detail-source">
            <h3>공식 원문</h3>
            <a href={benefit.source.url} target="_blank" rel="noreferrer">
              {benefit.evidence[0]?.label ?? "공식 출처에서 확인"} <span aria-hidden="true">↗</span>
            </a>
            {benefit.evidence.map((evidence) => (
              <div className="evidence" key={`${evidence.sourceId}-${evidence.article ?? "source"}`}>
                {evidence.article ? <strong>{evidence.article}</strong> : null}
                {evidence.excerpt ? <p>{evidence.excerpt}</p> : null}
              </div>
            ))}
            <p className="source-disclaimer">
              이 서비스의 요약보다 공식 원문과 시설 안내가 우선합니다.
            </p>
          </section>

          <section className="detail-section checked-date">
            <h3>최종 확인일</h3>
            <p>{formatDate(benefit.validity.checkedAt)}</p>
            <span>{benefit.reviewState === "REVIEWED" ? "운영자 확인 완료" : "원천 데이터 기준"}</span>
          </section>
        </div>
      </article>
    </div>
  );
}
