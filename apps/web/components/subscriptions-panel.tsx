"use client";

import { KOREA_REGION_OPTIONS, type Benefit, type Subscription, type SubscriptionTargetType } from "@honor/core";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  clearSession,
  createSubscription,
  deleteAccount,
  getSession,
  listSubscriptions,
  removeSubscription,
  savePushSubscription,
  startOtp,
  verifyOtp,
  type AuthSession
} from "../lib/api";
import { IS_MOCK_API, VAPID_PUBLIC_KEY } from "../lib/config";

const REGION_OPTIONS = KOREA_REGION_OPTIONS;

function targetLabel(subscription: Subscription, benefits: readonly Benefit[]) {
  if (subscription.targetType === "BENEFIT") {
    return benefits.find((item) => item.id === subscription.targetId)?.title ?? subscription.targetId;
  }
  if (subscription.targetType === "REGION") {
    return REGION_OPTIONS.find(([code]) => code === subscription.targetId)?.[1] ?? subscription.targetId;
  }
  return subscription.targetId;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

interface SubscriptionsPanelProps {
  pendingBenefit?: Benefit;
  benefits: readonly Benefit[];
  onPendingConsumed: () => void;
  onSessionChange: (session: AuthSession | null) => void;
}

export function SubscriptionsPanel({
  pendingBenefit,
  onPendingConsumed,
  benefits,
  onSessionChange
}: SubscriptionsPanelProps) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [targetType, setTargetType] = useState<SubscriptionTargetType>("REGION");
  const [targetId, setTargetId] = useState("SEOUL");
  const [cadence, setCadence] = useState<"WEEKLY" | "IMMEDIATE">("WEEKLY");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pushEnabled, setPushEnabled] = useState(false);

  const categories = useMemo(
    () => [...new Set(benefits.map((item) => item.category))].sort((a, b) => a.localeCompare(b, "ko")),
    [benefits]
  );

  useEffect(() => {
    const current = getSession();
    queueMicrotask(() => {
      setSession(current);
      onSessionChange(current);
      setReady(true);
      if (current) void listSubscriptions().then(setSubscriptions).catch(() => setError("구독 목록을 불러오지 못했습니다."));
    });
  }, [onSessionChange]);

  useEffect(() => {
    if (!pendingBenefit) return;
    queueMicrotask(() => {
      setTargetType("BENEFIT");
      setTargetId(pendingBenefit.id);
      setCadence("IMMEDIATE");
    });
  }, [pendingBenefit]);

  async function handleStartOtp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const challenge = await startOtp(email.trim());
      setChallengeId(challenge.challengeId);
      setMessage(`${challenge.destinationHint} 주소로 인증번호를 보냈습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "인증번호를 보내지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const authenticated = await verifyOtp(email.trim(), code.trim(), challengeId);
      setSession(authenticated);
      onSessionChange(authenticated);
      setSubscriptions(await listSubscriptions());
      setMessage("이메일 확인이 완료되었습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "인증을 완료하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const created = await createSubscription({
        targetType,
        targetId,
        cadence: targetType === "BENEFIT" ? cadence : "WEEKLY",
        channels: pushEnabled ? ["EMAIL", "WEB_PUSH"] : ["EMAIL"]
      });
      setSubscriptions((current) => [
        created,
        ...current.filter(
          (item) => !(item.targetType === created.targetType && item.targetId === created.targetId)
        )
      ]);
      setMessage("알림 설정을 저장했습니다.");
      onPendingConsumed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "알림 설정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    setBusy(true);
    setError("");
    try {
      await removeSubscription(id);
      setSubscriptions((current) => current.filter((item) => item.id !== id));
      setMessage("알림을 해제했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "알림을 해제하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePush() {
    setError("");
    if (IS_MOCK_API) {
      setPushEnabled(true);
      setMessage("이 기기의 웹 푸시를 켰습니다. (파일럿 모의 연동)");
      return;
    }
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !VAPID_PUBLIC_KEY) {
      setError("이 브라우저에서는 웹 푸시를 설정할 수 없습니다.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setError("브라우저 알림 권한이 필요합니다.");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    await savePushSubscription(subscription.toJSON());
    setPushEnabled(true);
    setMessage("이 기기의 웹 푸시를 켰습니다.");
  }

  async function handleDeleteAccount() {
    if (!window.confirm("구독과 파일럿 계정을 모두 삭제할까요?")) return;
    await deleteAccount();
    setSession(null);
    setSubscriptions([]);
    onSessionChange(null);
    setMessage("계정과 구독 정보를 삭제했습니다.");
  }

  if (!ready) return <div className="panel-loading">알림 설정을 불러오는 중…</div>;

  if (!session) {
    return (
      <section className="settings-panel" aria-labelledby="follow-title">
        <div className="section-heading section-heading--stacked">
          <span className="eyebrow">원하는 변화만</span>
          <h2 id="follow-title">혜택 변경을 놓치지 마세요</h2>
          <p>조회는 로그인 없이 가능해요. 알림을 받을 때만 이메일을 한 번 확인합니다.</p>
        </div>
        <div className="auth-card">
          <div className="auth-card__badge" aria-hidden="true">@</div>
          {!challengeId ? (
            <form onSubmit={handleStartOtp}>
              <label htmlFor="follow-email">알림 받을 이메일</label>
              <div className="input-action-row">
                <input
                  id="follow-email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="name@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <button className="primary-button" disabled={busy} type="submit">인증번호 받기</button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleVerify}>
              <label htmlFor="otp-code">이메일 인증번호</label>
              <div className="input-action-row">
                <input
                  id="otp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6,8}"
                  maxLength={8}
                  required
                  placeholder="6~8자리 번호"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                />
                <button className="primary-button" disabled={busy} type="submit">확인</button>
              </div>
              <button className="link-button" type="button" onClick={() => setChallengeId("")}>
                이메일 다시 입력하기
              </button>
            </form>
          )}
          {IS_MOCK_API && challengeId ? (
            <p className="mock-hint">로컬 파일럿 인증번호: <strong>123456</strong> · 소유자 데모: owner@example.com</p>
          ) : null}
          {message ? <p className="form-message" role="status">{message}</p> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <div className="privacy-note">
          <span aria-hidden="true">✓</span>
          이메일은 알림 전송과 계정 확인에만 사용합니다. 정확한 위치는 저장하지 않습니다.
        </div>
      </section>
    );
  }

  const options =
    targetType === "BENEFIT"
      ? benefits.map((item) => [item.id, item.title] as const)
      : targetType === "REGION"
        ? REGION_OPTIONS
        : categories.map((category) => [category, category] as const);

  return (
    <section className="settings-panel" aria-labelledby="follow-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">알림 설정</span>
          <h2 id="follow-title">팔로우 중인 혜택</h2>
          <p className="account-email">{session.email}</p>
        </div>
        <span className="result-count">{subscriptions.length}개</span>
      </div>

      {pendingBenefit ? (
        <div className="pending-follow">
          <span>선택한 혜택</span>
          <strong>{pendingBenefit.title}</strong>
        </div>
      ) : null}

      <form className="subscription-form" onSubmit={handleCreate}>
        <div className="segmented-control" aria-label="알림 대상 유형">
          {(["BENEFIT", "REGION", "CATEGORY"] as const).map((type) => (
            <button
              key={type}
              type="button"
              className={targetType === type ? "is-active" : ""}
              onClick={() => {
                setTargetType(type);
                const first = type === "BENEFIT" ? benefits[0]?.id : type === "REGION" ? "SEOUL" : categories[0];
                setTargetId(first ?? "");
                if (type !== "BENEFIT") setCadence("WEEKLY");
              }}
            >
              {type === "BENEFIT" ? "개별 혜택" : type === "REGION" ? "지역" : "분류"}
            </button>
          ))}
        </div>
        <label htmlFor="follow-target">알림 대상</label>
        <select id="follow-target" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          {options.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        {targetType === "BENEFIT" ? (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={cadence === "IMMEDIATE"}
              onChange={(event) => setCadence(event.target.checked ? "IMMEDIATE" : "WEEKLY")}
            />
            <span><strong>중요 변경은 바로 받기</strong><small>그 외 변경은 주간 요약에 포함됩니다.</small></span>
          </label>
        ) : null}
        <button className="primary-button primary-button--wide" disabled={busy || !targetId} type="submit">
          이메일 알림 추가
        </button>
      </form>

      <div className="push-card">
        <div><strong>웹 푸시</strong><span>개별 혜택의 중요한 변경만 빠르게 알려드려요.</span></div>
        <button className="secondary-button" type="button" onClick={handlePush} disabled={pushEnabled}>
          {pushEnabled ? "켜짐" : "이 기기에서 켜기"}
        </button>
      </div>

      {message ? <p className="form-message" role="status">{message}</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="subscription-list">
        {subscriptions.length ? subscriptions.map((subscription) => (
          <article key={subscription.id}>
            <span className="subscription-list__icon" aria-hidden="true">⌁</span>
            <div>
              <strong>{targetLabel(subscription, benefits)}</strong>
              <span>{subscription.cadence === "IMMEDIATE" ? "중요 변경 즉시 + 주간 요약" : "매주 한 번 요약"}</span>
            </div>
            <button type="button" onClick={() => handleRemove(subscription.id)} disabled={busy}>해제</button>
          </article>
        )) : <div className="empty-mini">아직 팔로우한 혜택이 없습니다.</div>}
      </div>

      <footer className="account-actions">
        <button type="button" onClick={() => { clearSession(); setSession(null); onSessionChange(null); }}>로그아웃</button>
        <button type="button" onClick={handleDeleteAccount}>계정·구독 삭제</button>
      </footer>
    </section>
  );
}
