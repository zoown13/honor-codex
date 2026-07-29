"use client";

import type { BenefitChange } from "@honor/core";
import { UNKNOWN_OFFICIAL_DETAIL } from "@honor/core";

function SummaryList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h4>{title}</h4>
      <ul>{(items.length ? items : [UNKNOWN_OFFICIAL_DETAIL]).map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

export function AdminReviewDetail({ change, onClose }: { change: BenefitChange; onClose: () => void }) {
  const benefit = change.after ?? change.before;
  if (!benefit) return null;
  const ai = benefit.summaryProvenance;
  return (
    <div className="review-dialog-backdrop review-detail-backdrop">
      <section className="review-dialog review-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="review-detail-title">
        <button className="review-dialog__close" type="button" aria-label="핵심 정제 내용 닫기" onClick={onClose}>×</button>
        <span className="eyebrow">{ai ? "Bedrock AI 정제 결과" : "원천 데이터"}</span>
        <h3 id="review-detail-title">{benefit.title}</h3>
        <p>{benefit.provider} · {change.action === "ADD" ? "신규" : change.action === "UPDATE" ? "수정" : "삭제"}</p>

        {ai ? (
          <>
            <div className="review-ai-note" role="note">
              <strong>AI 요약은 검수 보조 자료입니다.</strong>
              <span>원문에 없는 조건이 추가되지 않았는지 확인한 뒤 승인하세요.</span>
            </div>
            <section className="review-detail-summary">
              <h4>핵심 혜택</h4>
              <p>{benefit.summary}</p>
              {benefit.amount ? <strong>{benefit.amount}</strong> : null}
            </section>
            <div className="review-detail-grid">
              <SummaryList title="대상" items={benefit.eligibility} />
              <SummaryList title="준비물" items={benefit.requiredProof} />
              <SummaryList title="이용 방법" items={benefit.howToUse} />
              <SummaryList title="주의사항" items={benefit.constraints} />
            </div>
            <small>모델 {ai.modelId} · 입력 {ai.inputTokens?.toLocaleString("ko-KR") ?? 0} · 출력 {ai.outputTokens?.toLocaleString("ko-KR") ?? 0} 토큰</small>
          </>
        ) : (
          <div className="review-ai-note" role="note">
            <strong>아직 핵심 정제 전입니다.</strong>
            <span>긴 조문을 이 화면에 반복 노출하지 않습니다. 공식 원문에서 직접 확인하거나 AI 정제 작업 후 다시 검수하세요.</span>
          </div>
        )}

        <div className="review-detail-actions">
          <a className="secondary-button" href={benefit.source.url} target="_blank" rel="noreferrer">공식 원문 열기 ↗</a>
          <button className="primary-button" type="button" onClick={onClose}>목록으로 돌아가기</button>
        </div>
      </section>
    </div>
  );
}
