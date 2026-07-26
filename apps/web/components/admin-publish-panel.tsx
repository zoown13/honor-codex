"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  REVIEW_SOURCES,
  getPublishStatus,
  startPublish,
  type PublishStatusResponse,
  type ReviewSource
} from "../lib/api";

const SOURCE_LABEL: Record<ReviewSource, string> = {
  MMA_FACILITIES: "병무청 예우시설",
  MMA_NOTICES: "병무청 전국 혜택",
  LAW_ORDINANCES: "지자체 조례"
};

const ACTIVE_STATUSES = new Set(["PREPARING", "STAGED", "DEPLOYING", "DEPLOYED"]);

export function AdminPublishPanel({ onPublished }: { onPublished?: () => void }) {
  const [status, setStatus] = useState<PublishStatusResponse | null>(null);
  const [selected, setSelected] = useState<ReviewSource[]>([]);
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const next = await getPublishStatus();
      setStatus(next);
      setSelected((current) => current.length ? current.filter((source) => next.sources[source].approved > 0) :
        REVIEW_SOURCES.filter((source) => next.sources[source].approved > 0 && next.sources[source].pending === 0));
      if (next.operation?.status === "COMPLETED") setNotice("최근 게시와 Amplify 배포가 완료되었습니다.");
      if (next.operation?.status === "FAILED") setError(next.operation.error || "게시 작업이 실패했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "게시 상태를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);
  useEffect(() => {
    if (!status?.operation || !ACTIVE_STATUSES.has(status.operation.status)) return;
    const timer = window.setTimeout(() => void load(), 4_000);
    return () => window.clearTimeout(timer);
  }, [load, status?.operation]);

  const selectedApproved = useMemo(() => selected.reduce(
    (total, source) => total + (status?.sources[source].approved ?? 0), 0
  ), [selected, status]);
  const selectedPending = useMemo(() => selected.reduce(
    (total, source) => total + (status?.sources[source].pending ?? 0), 0
  ), [selected, status]);
  const phrase = `PUBLISH ${selectedApproved}`;
  const active = Boolean(status?.operation && ACTIVE_STATUSES.has(status.operation.status));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected.length || confirmation !== phrase) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await startPublish(selected, confirmation);
      setNotice(response.message);
      setStatus((current) => current ? { ...current, operation: response.operation } : current);
      setConfirmation("");
      onPublished?.();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "게시 작업을 시작하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="admin-operation-card" aria-labelledby="admin-publish-title">
      <div className="admin-operation-card__heading">
        <div>
          <span className="eyebrow">비동기 안전 게시</span>
          <h3 id="admin-publish-title">승인 데이터를 서비스에 게시</h3>
        </div>
        <button className="secondary-button" type="button" disabled={loading || submitting} onClick={() => void load()}>
          {loading ? "확인 중…" : "상태 새로고침"}
        </button>
      </div>
      <p>작업을 시작하면 서버가 데이터셋 생성, Amplify 배포, 활성 버전 전환을 백그라운드에서 처리합니다.</p>

      {status ? (
        <form onSubmit={submit}>
          <fieldset disabled={active || submitting}>
            <legend>게시할 승인 원천</legend>
            {REVIEW_SOURCES.map((source) => {
              const value = status.sources[source];
              const disabled = value.approved === 0 || value.pending > 0;
              return (
                <label className="admin-source-choice" key={source}>
                  <input
                    type="checkbox"
                    checked={selected.includes(source)}
                    disabled={disabled}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, source]
                      : current.filter((item) => item !== source))}
                  />
                  <span><strong>{SOURCE_LABEL[source]}</strong> 승인 {value.approved.toLocaleString("ko-KR")}건 · 대기 {value.pending.toLocaleString("ko-KR")}건</span>
                </label>
              );
            })}
          </fieldset>

          {active ? (
            <div className="admin-job-progress" role="status">
              <strong>게시 진행 중 · {status.operation?.status}</strong>
              <span>이 화면을 닫아도 서버 작업은 계속됩니다.</span>
            </div>
          ) : (
            <label className="review-confirmation" htmlFor="publish-confirmation-input">
              <span>선택한 승인 {selectedApproved.toLocaleString("ko-KR")}건을 게시하려면 아래 문구를 입력하세요.</span>
              <code>{phrase}</code>
              <input
                id="publish-confirmation-input"
                autoComplete="off"
                spellCheck={false}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          )}
          <button
            className="approve-button"
            type="submit"
            disabled={active || submitting || selectedApproved === 0 || selectedPending > 0 || confirmation !== phrase}
          >
            {submitting ? "게시 요청 중…" : `${selectedApproved.toLocaleString("ko-KR")}건 게시 시작`}
          </button>
        </form>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-message" role="status">{notice}</p> : null}
    </section>
  );
}
