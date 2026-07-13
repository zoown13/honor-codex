"use client";

import type { BenefitChange } from "@honor/core";
import { useCallback, useEffect, useState } from "react";
import { getSession, listPendingChanges, publishApprovedChanges, reviewChange, type AuthSession } from "../lib/api";
import { formatDate } from "../lib/format";

interface AdminPanelProps {
  session: AuthSession | null;
  onOpenLogin: () => void;
}

export function AdminPanel({ session, onOpenLogin }: AdminPanelProps) {
  const [changes, setChanges] = useState<BenefitChange[]>([]);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState("");

  const loadChanges = useCallback(async () => {
    try {
      setChanges(await listPendingChanges());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "검수함을 불러오지 못했습니다.");
    }
  }, []);

  useEffect(() => {
    if (!(session ?? getSession())?.isAdmin) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void loadChanges();
    });
    return () => {
      active = false;
    };
  }, [loadChanges, session]);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    setError("");
    try {
      await reviewChange(id, decision);
      setChanges((current) => current.filter((change) => change.id !== id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "검수 결과를 저장하지 못했습니다.");
    } finally {
      setBusyId("");
    }
  }

  async function publish() {
    setPublishing(true);
    setError("");
    setNotice("");
    try {
      const result = await publishApprovedChanges();
      setNotice(
        result.deploymentJobId
          ? `${result.publishedChanges}건 게시를 시작했습니다. 배포 작업: ${result.deploymentJobId}`
          : `${result.publishedChanges}건을 게시 처리했습니다.`
      );
      await loadChanges();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "게시를 시작하지 못했습니다.");
    } finally {
      setPublishing(false);
    }
  }

  if (!session?.isAdmin) {
    return (
      <section className="admin-gate" aria-labelledby="admin-title">
        <div className="admin-gate__symbol" aria-hidden="true">검수</div>
        <span className="eyebrow">소유자 전용</span>
        <h2 id="admin-title">혜택 변경 검수함</h2>
        <p>삭제·할인율·대상·증빙처럼 중요한 변경은 게시 전에 소유자가 직접 확인합니다.</p>
        <button className="primary-button" type="button" onClick={onOpenLogin}>이메일로 소유자 확인</button>
        <small>로컬 데모에서는 owner@example.com과 인증번호 123456을 사용하세요.</small>
      </section>
    );
  }

  return (
    <section className="admin-panel" aria-labelledby="admin-title">
      <div className="section-heading">
        <div><span className="eyebrow">오늘의 검수함</span><h2 id="admin-title">중요 변경 {changes.length}건</h2></div>
        <div className="admin-actions">
          <button className="secondary-button" type="button" onClick={loadChanges}>새로고침</button>
          <button className="primary-button" type="button" disabled={publishing} onClick={publish}>{publishing ? "게시 시작 중…" : "승인 항목 게시"}</button>
        </div>
      </div>
      <div className="admin-rule">
        <strong>자동 게시하지 않아요</strong>
        <span>할인율·대상·증빙·종료·조례 본문 변경은 원문을 확인한 뒤 승인합니다.</span>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-success" role="status">{notice}</p> : null}
      <div className="change-list">
        {changes.map((change) => {
          const current = change.after ?? change.before;
          return (
            <article className="change-card" key={change.id}>
              <header>
                <div className="tag-row"><span className="tag tag--danger">중요</span><span className="tag">{change.action === "DELETE" ? "삭제" : "수정"}</span></div>
                <time dateTime={change.detectedAt}>{formatDate(change.detectedAt)}</time>
              </header>
              <h3>{current?.title ?? change.benefitId}</h3>
              <p>{current?.provider}</p>
              <div className="changed-fields">
                <span>변경 항목</span>
                {change.changedFields.map((field) => <code key={field}>{field}</code>)}
              </div>
              {change.before?.amount || change.after?.amount ? (
                <div className="diff-box">
                  <div><span>이전</span><p>{change.before?.amount ?? "명시 없음"}</p></div>
                  <div><span>변경</span><p>{change.after?.amount ?? "명시 없음"}</p></div>
                </div>
              ) : null}
              <a href={current?.source.url} target="_blank" rel="noreferrer">공식 원문 확인 <span aria-hidden="true">↗</span></a>
              <footer>
                <button className="reject-button" type="button" disabled={busyId === change.id} onClick={() => decide(change.id, "reject")}>거절</button>
                <button className="approve-button" type="button" disabled={busyId === change.id} onClick={() => decide(change.id, "approve")}>확인 후 승인</button>
              </footer>
            </article>
          );
        })}
        {!changes.length ? <div className="empty-state"><span aria-hidden="true">✓</span><strong>검수할 중요 변경이 없습니다</strong><p>새 변경이 발견되면 여기에 표시됩니다.</p></div> : null}
      </div>
    </section>
  );
}
