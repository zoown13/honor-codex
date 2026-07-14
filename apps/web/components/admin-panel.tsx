"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  REVIEW_SOURCES,
  approveReviewChunk,
  clearActiveReviewOperation,
  clearSession,
  createReviewOperationId,
  getActiveReviewOperation,
  getReviewSummary,
  isApiError,
  saveActiveReviewOperation,
  type ActiveReviewOperation,
  type AuthSession,
  type ReviewSource,
  type ReviewSummaryGroup
} from "../lib/api";
import { formatDate } from "../lib/format";

const SOURCE_META: Record<ReviewSource, { label: string; description: string; symbol: string }> = {
  MMA_FACILITIES: {
    label: "병무청 예우시설",
    description: "병무청 예우시설 검색에서 수집한 시설 기본정보",
    symbol: "施"
  },
  MMA_NOTICES: {
    label: "병무청 전국 혜택 공지",
    description: "병무청 공지에서 확인한 전국 단위 혜택",
    symbol: "全"
  },
  LAW_ORDINANCES: {
    label: "법제처 지자체 조례",
    description: "국가법령정보센터 OPEN API에서 확인한 자치법규",
    symbol: "法"
  }
};

interface AdminPanelProps {
  session: AuthSession | null;
  onOpenLogin: () => void;
  onSessionExpired: () => void;
}

function currentBenefit(change: ReviewSummaryGroup["samples"][number]) {
  return change.after ?? change.before;
}

function progressPercent(operation: ActiveReviewOperation) {
  if (!operation.expectedCount) return 0;
  return Math.min(100, Math.round((operation.approvedCount / operation.expectedCount) * 100));
}

export function AdminPanel({ session, onOpenLogin, onSessionExpired }: AdminPanelProps) {
  const [groups, setGroups] = useState<ReviewSummaryGroup[]>([]);
  const [unclassifiedCount, setUnclassifiedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [dialogGroup, setDialogGroup] = useState<ReviewSummaryGroup | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [activeOperation, setActiveOperation] = useState<ActiveReviewOperation | null>(null);
  const [busyOperationId, setBusyOperationId] = useState("");

  const expireSession = useCallback(() => {
    clearSession();
    setSessionExpired(true);
    onSessionExpired();
  }, [onSessionExpired]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await getReviewSummary();
      setGroups(response.groups);
      setUnclassifiedCount(response.unclassifiedCount);
    } catch (caught) {
      if (isApiError(caught, 401)) {
        expireSession();
        return;
      }
      setError(caught instanceof Error ? caught.message : "검수 집계를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [expireSession]);

  useEffect(() => {
    if (!session?.isAdmin) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSessionExpired(false);
      setActiveOperation(getActiveReviewOperation());
      void loadSummary();
    });
    return () => {
      active = false;
    };
  }, [loadSummary, session]);

  useEffect(() => {
    if (!dialogGroup) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyOperationId) setDialogGroup(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busyOperationId, dialogGroup]);

  const totalPending = useMemo(
    () => unclassifiedCount + groups.reduce((total, group) => total + group.count, 0),
    [groups, unclassifiedCount]
  );

  function openConfirmation(group: ReviewSummaryGroup) {
    setDialogGroup(group);
    setAcknowledged(false);
    setConfirmation("");
    setError("");
    setNotice("");
  }

  async function runOperation(operation: ActiveReviewOperation) {
    setBusyOperationId(operation.operationId);
    setError("");
    setNotice("");
    let current = operation;

    try {
      while (true) {
        const result = await approveReviewChunk({
          source: current.source,
          batchId: current.batchId,
          detectedAt: current.detectedAt,
          expectedCount: current.expectedCount,
          fingerprint: current.fingerprint,
          confirmation: current.confirmation,
          operationId: current.operationId
        });
        current = {
          ...current,
          approvedCount: result.approvedCount,
          remainingCount: result.remainingCount
        };
        saveActiveReviewOperation(current);
        setActiveOperation(current);

        if (result.complete) {
          clearActiveReviewOperation();
          setActiveOperation(null);
          setNotice(`${current.label} ${result.approvedCount.toLocaleString("ko-KR")}건 승인을 완료했습니다.`);
          await loadSummary();
          return;
        }
        if (result.processedCount <= 0) {
          throw new Error("승인 작업이 진행되지 않았습니다. 잠시 후 같은 작업으로 다시 시도해 주세요.");
        }
      }
    } catch (caught) {
      if (isApiError(caught, 401)) {
        expireSession();
        return;
      }
      if (caught instanceof ApiError && caught.status === 409) {
        clearActiveReviewOperation();
        setActiveOperation(null);
        await loadSummary();
        setError(`검수 집계가 달라져 작업을 중단하고 최신 상태로 갱신했습니다. ${caught.message}`);
        return;
      }
      setError(
        `${caught instanceof Error ? caught.message : "일괄 승인 요청을 완료하지 못했습니다."} ` +
        "진행 기록은 이 기기에 보관했습니다. 아래 ‘같은 작업으로 계속’ 버튼으로 안전하게 재개할 수 있습니다."
      );
    } finally {
      setBusyOperationId("");
    }
  }

  async function beginBulkReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialogGroup || !acknowledged || confirmation !== dialogGroup.confirmationPhrase) return;

    const operation: ActiveReviewOperation = {
      source: dialogGroup.source,
      batchId: dialogGroup.batchId,
      detectedAt: dialogGroup.detectedAt,
      expectedCount: dialogGroup.count,
      fingerprint: dialogGroup.fingerprint,
      confirmation,
      operationId: createReviewOperationId(),
      label: dialogGroup.label,
      confirmationPhrase: dialogGroup.confirmationPhrase,
      approvedCount: 0,
      remainingCount: dialogGroup.count,
      startedAt: new Date().toISOString()
    };
    saveActiveReviewOperation(operation);
    setActiveOperation(operation);
    setDialogGroup(null);
    await runOperation(operation);
  }

  if (!session?.isAdmin) {
    return (
      <section className="admin-gate" aria-labelledby="admin-title">
        <div className="admin-gate__symbol" aria-hidden="true">검수</div>
        <span className="eyebrow">소유자 전용</span>
        <h2 id="admin-title">혜택 변경 검수함</h2>
        {sessionExpired ? (
          <p className="form-error" role="alert">보안을 위해 로그인 시간이 만료되었습니다. 이메일 인증 후 진행 중 작업을 이어갈 수 있습니다.</p>
        ) : (
          <p>삭제·할인율·대상·증빙처럼 중요한 변경은 게시 전에 소유자가 직접 확인합니다.</p>
        )}
        <button className="primary-button" type="button" onClick={onOpenLogin}>이메일로 소유자 확인</button>
        <small>로컬 데모에서는 owner@example.com과 인증번호 123456을 사용하세요.</small>
      </section>
    );
  }

  return (
    <section className="admin-panel" aria-labelledby="admin-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">원천별 안전 검수</span>
          <h2 id="admin-title">승인 대기 {totalPending.toLocaleString("ko-KR")}건</h2>
        </div>
        <button className="secondary-button" type="button" disabled={loading || Boolean(busyOperationId)} onClick={() => void loadSummary()}>
          {loading ? "집계 확인 중…" : "집계 새로고침"}
        </button>
      </div>

      <div className="admin-rule admin-rule--locked" role="note">
        <strong>승인과 게시는 분리되어 있습니다</strong>
        <span>여기서는 검수 상태만 승인합니다. 게시 기능은 잠겨 있으며 별도 확인 단계 전에는 실제 서비스 데이터가 바뀌지 않습니다.</span>
      </div>

      {activeOperation ? (
        <section className="review-operation" aria-labelledby="review-operation-title">
          <div className="review-operation__heading">
            <div>
              <span className="tag">작업 UUID 유지</span>
              <strong id="review-operation-title">{activeOperation.label} 일괄 승인</strong>
            </div>
            <span>{progressPercent(activeOperation)}%</span>
          </div>
          <progress max={activeOperation.expectedCount} value={activeOperation.approvedCount}>
            {progressPercent(activeOperation)}%
          </progress>
          <p aria-live="polite">
            {activeOperation.approvedCount.toLocaleString("ko-KR")}건 승인 · {activeOperation.remainingCount.toLocaleString("ko-KR")}건 남음
          </p>
          <button
            className="primary-button"
            type="button"
            disabled={busyOperationId === activeOperation.operationId}
            onClick={() => void runOperation(activeOperation)}
          >
            {busyOperationId === activeOperation.operationId ? "100건씩 안전하게 처리 중…" : "같은 작업으로 계속"}
          </button>
        </section>
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-message" role="status">{notice}</p> : null}
      {unclassifiedCount > 0 ? (
        <p className="review-ineligible" role="alert">
          원천을 안전하게 분류하지 못한 변경 {unclassifiedCount.toLocaleString("ko-KR")}건은 일괄 승인에서 제외했습니다. 단건 검수가 필요합니다.
        </p>
      ) : null}

      <div className="review-source-list" aria-busy={loading}>
        {REVIEW_SOURCES.map((source) => {
          const sourceGroups = groups.filter((group) => group.source === source);
          const sourceCount = sourceGroups.reduce((total, group) => total + group.count, 0);
          const meta = SOURCE_META[source];
          return (
            <article className="review-source-card" key={source} aria-labelledby={`review-source-${source}`}>
              <header className="review-source-card__header">
                <span className="review-source-card__symbol" aria-hidden="true">{meta.symbol}</span>
                <div>
                  <h3 id={`review-source-${source}`}>{meta.label}</h3>
                  <p>{meta.description}</p>
                </div>
                <strong>{sourceCount.toLocaleString("ko-KR")}건</strong>
              </header>

              {sourceGroups.length ? (
                <div className="review-batch-list">
                  {sourceGroups.map((group) => (
                    <section className="review-batch" key={`${group.source}-${group.detectedAt}-${group.fingerprint}`}>
                      <div className="review-batch__heading">
                        <div>
                          <span>수집 기준</span>
                          <time dateTime={group.detectedAt}>{formatDate(group.detectedAt)}</time>
                        </div>
                        <span className={`tag ${group.eligible ? "tag--safe" : "tag--danger"}`}>
                          {group.eligible ? "초기 신규 데이터" : "개별 검수 필요"}
                        </span>
                      </div>

                      <dl className="review-counts">
                        <div><dt>신규</dt><dd>{group.actionCounts.ADD.toLocaleString("ko-KR")}</dd></div>
                        <div><dt>수정</dt><dd>{group.actionCounts.UPDATE.toLocaleString("ko-KR")}</dd></div>
                        <div><dt>삭제</dt><dd>{group.actionCounts.DELETE.toLocaleString("ko-KR")}</dd></div>
                        <div><dt>고위험</dt><dd>{group.riskCounts.HIGH.toLocaleString("ko-KR")}</dd></div>
                        <div><dt>저위험</dt><dd>{group.riskCounts.LOW.toLocaleString("ko-KR")}</dd></div>
                      </dl>

                      <div className="review-samples" aria-label={`${group.label} 표본 ${group.samples.length}건`}>
                        <strong>승인 전 표본</strong>
                        {group.samples.map((change) => {
                          const benefit = currentBenefit(change);
                          return (
                            <article key={change.id}>
                              <div>
                                <span>{change.action === "ADD" ? "신규" : change.action === "UPDATE" ? "수정" : "삭제"}</span>
                                <strong>{benefit?.title ?? change.benefitId}</strong>
                                <small>{benefit?.provider ?? "제공기관 미상"}</small>
                              </div>
                              {benefit?.source.url ? (
                                <a href={benefit.source.url} target="_blank" rel="noreferrer" aria-label={`${benefit.title} 공식 원문 새 창에서 확인`}>
                                  원문 ↗
                                </a>
                              ) : <span>원문 없음</span>}
                            </article>
                          );
                        })}
                      </div>

                      {group.eligible ? (
                        <button
                          className="approve-button review-batch__approve"
                          type="button"
                          disabled={Boolean(activeOperation) || Boolean(busyOperationId)}
                          onClick={() => openConfirmation(group)}
                        >
                          {group.label} {group.count.toLocaleString("ko-KR")}건 일괄 승인
                        </button>
                      ) : (
                        <p className="review-ineligible" role="note">{group.ineligibleReason ?? "이 그룹은 일괄 승인할 수 없습니다."}</p>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <div className="review-source-card__empty">
                  <span aria-hidden="true">✓</span>
                  <p><strong>대기 중인 변경 없음</strong>이 원천의 다음 수집 결과를 기다리고 있습니다.</p>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {dialogGroup ? (
        <div className="review-dialog-backdrop">
          <section
            className="review-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-dialog-title"
            aria-describedby="review-dialog-description"
          >
            <button className="review-dialog__close" type="button" aria-label="일괄 승인 창 닫기" onClick={() => setDialogGroup(null)}>×</button>
            <span className="eyebrow">되돌리기 전 재검수 필요</span>
            <h3 id="review-dialog-title">{dialogGroup.label} {dialogGroup.count.toLocaleString("ko-KR")}건 승인</h3>
            <p id="review-dialog-description">
              서버가 원천·수집시각·건수·지문을 다시 확인한 뒤 100건씩 처리합니다. 이 승인은 게시를 시작하지 않습니다.
            </p>
            <form onSubmit={beginBulkReview}>
              <label className="review-acknowledgement">
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>표본과 집계를 확인했으며, 이 원천의 초기 신규 데이터 전체를 같은 기준으로 승인함을 이해했습니다.</span>
              </label>
              <label className="review-confirmation" htmlFor="review-confirmation-input">
                <span>아래 문구를 정확히 입력하세요.</span>
                <code>{dialogGroup.confirmationPhrase}</code>
                <input
                  id="review-confirmation-input"
                  aria-label="확인 문구 입력"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              </label>
              <div className="review-dialog__actions">
                <button className="secondary-button" type="button" onClick={() => setDialogGroup(null)}>취소</button>
                <button
                  className="approve-button"
                  type="submit"
                  disabled={!acknowledged || confirmation !== dialogGroup.confirmationPhrase}
                >
                  {dialogGroup.count.toLocaleString("ko-KR")}건 승인 시작
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}
