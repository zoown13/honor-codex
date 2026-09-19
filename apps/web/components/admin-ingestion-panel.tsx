"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getIngestionStatus, startIngestion, REVIEW_SOURCES, type IngestionJob, type ReviewSource } from "../lib/api";

const LABELS: Record<ReviewSource, string> = { MMA_FACILITIES: "예우시설", MMA_NOTICES: "혜택 공지", LAW_ORDINANCES: "지자체 조례" };
const STATUS = { QUEUED: "수집 대기", RUNNING: "수집 중", COMPLETED: "수집 완료", FAILED: "수집 실패" };
export function AdminIngestionPanel({ onCompleted }: { onCompleted: () => void }) {
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [busy, setBusy] = useState<ReviewSource | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const completed = useRef(new Set<string>());
  const callback = useRef(onCompleted);
  useEffect(() => { callback.current = onCompleted; }, [onCompleted]);
  const load = useCallback(async () => {
    try {
      const result = await getIngestionStatus();
      setJobs(result.jobs);
      setError("");
      for (const job of result.jobs) {
        if (job.status === "COMPLETED" && !completed.current.has(job.id)) {
          completed.current.add(job.id);
          callback.current();
        }
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "수집 상태를 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);
  useEffect(() => {
    if (!jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING")) return;
    const poll = window.setTimeout(() => void load(), 10_000);
    return () => window.clearTimeout(poll);
  }, [jobs, load]);
  async function start(source: ReviewSource) {
    setBusy(source);
    setError("");
    try {
      const { job } = await startIngestion(source);
      setJobs((current) => [...current.filter((item) => item.source !== source), job]);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "수집을 시작하지 못했습니다."); }
    finally { setBusy(null); }
  }
  return <section className="admin-operation-card" aria-labelledby="manual-ingestion-title">
    <div className="admin-operation-card__heading">
      <h3 id="manual-ingestion-title">데이터 수동 업데이트</h3>
      <button type="button" className="secondary-button" onClick={() => void load()}>상태 새로고침</button>
    </div>
    <p>원천의 최신 정보를 가져옵니다. 수집 후 변경사항을 검수·승인하고 게시하면 서비스에 반영됩니다. 조례 수집은 수 분 걸릴 수 있으며 화면을 닫아도 계속됩니다.</p>
    {REVIEW_SOURCES.map((source) => {
      const job = jobs.find((item) => item.source === source);
      const active = job?.status === "QUEUED" || job?.status === "RUNNING";
      return <div key={source} className="admin-operation-card">
        <strong>{LABELS[source]}</strong>
        <p role="status">{job ? STATUS[job.status] + " · " + new Date(job.updatedAt).toLocaleString("ko-KR") : "수동 수집 이력 없음"}</p>
        {job?.message ? <p>{job.message}</p> : null}
        <button type="button" className="secondary-button" disabled={loading || !!error || busy !== null || active} onClick={() => void start(source)}>
          {LABELS[source]} {active || busy === source ? "수집 중…" : "지금 수집"}
        </button>
      </div>;
    })}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}
