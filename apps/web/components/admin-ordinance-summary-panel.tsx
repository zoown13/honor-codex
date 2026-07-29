"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  getOrdinanceSummaryStatus,
  startOrdinanceSummary,
  type OrdinanceSummaryStatusResponse
} from "../lib/api";

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

export function AdminOrdinanceSummaryPanel({ onCompleted }: { onCompleted?: () => void }) {
  const [status, setStatus] = useState<OrdinanceSummaryStatusResponse | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await getOrdinanceSummaryStatus();
      setStatus(next);
      if (next.job?.status === "COMPLETED") {
        setNotice(`AI 정제 ${next.job.succeededCount.toLocaleString("ko-KR")}건을 완료했습니다. 검수함에서 확인 후 승인해 주세요.`);
        onCompleted?.();
      } else if (next.job?.status === "COMPLETED_WITH_ERRORS") {
        setNotice(`AI 정제 ${next.job.succeededCount.toLocaleString("ko-KR")}건 완료 · ${next.job.failedCount.toLocaleString("ko-KR")}건 실패`);
        onCompleted?.();
      } else if (next.job?.status === "FAILED") {
        setError(next.job.error || "AI 정제 작업이 실패했습니다.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 정제 상태를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [onCompleted]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);
  useEffect(() => {
    if (!status?.job || !ACTIVE_STATUSES.has(status.job.status)) return;
    const timer = window.setTimeout(() => void load(), 5_000);
    return () => window.clearTimeout(timer);
  }, [load, status?.job]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!status || !acknowledged || confirmation !== status.confirmationPhrase) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await startOrdinanceSummary(confirmation, status.estimate.estimatedCostUsd);
      setNotice(response.message);
      setStatus((current) => current ? { ...current, job: response.job, canStart: false } : current);
      setConfirmation("");
      setAcknowledged(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI 정제 작업을 시작하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  const active = Boolean(status?.job && ACTIVE_STATUSES.has(status.job.status));
  const progress = status?.job?.total
    ? Math.round((status.job.processedCount / status.job.total) * 100)
    : 0;

  return (
    <section className="admin-operation-card" aria-labelledby="ordinance-summary-title">
      <div className="admin-operation-card__heading">
        <div>
          <span className="eyebrow">Bedrock 검수 보조</span>
          <h3 id="ordinance-summary-title">조례 핵심 내용 AI 정제</h3>
        </div>
        <button className="secondary-button" type="button" disabled={loading || submitting} onClick={() => void load()}>
          {loading ? "계산 중…" : "비용·상태 새로고침"}
        </button>
      </div>
      <p>여러 지자체에 분산된 10건 표본을 먼저 대상, 혜택, 준비물, 이용 방법, 주의사항으로 정리합니다. AI 결과는 자동 게시하지 않고 다시 검수함으로 보냅니다.</p>

      {status ? (
        <>
          <dl className="admin-cost-grid">
            <div>
              <dt>테스트 표본</dt>
              <dd>{status.sampleSize.toLocaleString("ko-KR")}건 / 전체 {status.candidatePoolCount.toLocaleString("ko-KR")}건</dd>
            </div>
            <div><dt>예상 최대 비용</dt><dd>US ${status.estimate.estimatedCostUsd.toFixed(2)}</dd></div>
            <div><dt>작업 비용 상한</dt><dd>US ${status.maxJobCostUsd.toFixed(2)}</dd></div>
            <div><dt>현재 실비</dt><dd>US ${status.actualCostUsd.toFixed(2)}</dd></div>
          </dl>
          <small className="admin-model-id">모델: {status.modelId} · 실제 청구액은 Bedrock 토큰 사용량에 따라 달라집니다.</small>

          {active && status.job ? (
            <div className="admin-job-progress" role="status">
              <strong>AI 정제 {progress}%</strong>
              <progress max={status.job.total} value={status.job.processedCount}>{progress}%</progress>
              <span>{status.job.processedCount.toLocaleString("ko-KR")} / {status.job.total.toLocaleString("ko-KR")}건</span>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label className="review-acknowledgement">
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>예상 비용을 확인했으며, AI 결과가 원문과 일치하는지 승인 전에 검수하겠습니다.</span>
              </label>
              <label className="review-confirmation" htmlFor="summary-confirmation-input">
                <span>아래 문구를 정확히 입력하세요.</span>
                <code>{status.confirmationPhrase}</code>
                <input
                  id="summary-confirmation-input"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <button
                className="approve-button"
                type="submit"
                disabled={!status.canStart || submitting || !acknowledged || confirmation !== status.confirmationPhrase}
              >
                {submitting ? "작업 등록 중…" : `${status.sampleSize.toLocaleString("ko-KR")}건 표본 AI 정제 시작`}
              </button>
              {!status.canStart && status.ordinanceChangesAwaitingPublish > 0 ? (
                <p className="review-ineligible">기존 조례 변경 {status.ordinanceChangesAwaitingPublish.toLocaleString("ko-KR")}건을 검수·게시한 뒤 시작할 수 있습니다.</p>
              ) : null}
            </form>
          )}
        </>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-message" role="status">{notice}</p> : null}
    </section>
  );
}
