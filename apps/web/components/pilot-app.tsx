"use client";

import { KOREA_REGION_OPTIONS, type Benefit, type BenefitKind, type BenefitType, type SearchRequest, type SearchResult } from "@honor/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { benefits as fallbackBenefits, datasetManifest as fallbackManifest } from "../data/sample-benefits";
import type { AuthSession } from "../lib/api";
import { KIND_LABEL, TYPE_LABEL, formatDate } from "../lib/format";
import { useBenefitSearch } from "../lib/use-benefit-search";
import { useDataset } from "../lib/use-dataset";
import { AdminPanel } from "./admin-panel";
import { BenefitCard } from "./benefit-card";
import { BenefitDetail } from "./benefit-detail";
import { MapPanel } from "./map-panel";
import { SubscriptionsPanel } from "./subscriptions-panel";

type View = "nearby" | "all" | "map" | "national" | "ordinance" | "recent" | "follow" | "admin";
type LocationStatus = "idle" | "loading" | "granted" | "denied" | "error" | "manual";

interface Origin {
  latitude: number;
  longitude: number;
}

const REGION_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["", "지역 직접 선택"],
  ...KOREA_REGION_OPTIONS
];

const NAV_ITEMS: { id: View; label: string; shortLabel: string; symbol: string }[] = [
  { id: "nearby", label: "내 주변", shortLabel: "주변", symbol: "◎" },
  { id: "all", label: "전체 혜택", shortLabel: "전체", symbol: "≡" },
  { id: "map", label: "지도", shortLabel: "지도", symbol: "⌖" },
  { id: "national", label: "전국 혜택", shortLabel: "전국", symbol: "全" },
  { id: "ordinance", label: "지자체 조례", shortLabel: "조례", symbol: "法" },
  { id: "recent", label: "최근 변경", shortLabel: "변경", symbol: "↻" },
  { id: "follow", label: "알림 설정", shortLabel: "알림", symbol: "＋" },
  { id: "admin", label: "소유자 검수", shortLabel: "검수", symbol: "✓" }
];

const BOTTOM_VIEWS: View[] = ["nearby", "all", "map", "follow"];

interface PilotAppProps {
  slug: string;
}

export function PilotApp({ slug }: PilotAppProps) {
  const { items: benefits, manifest: datasetManifest, source: datasetSource, error: datasetError } =
    useDataset(fallbackBenefits, fallbackManifest);
  const benefitById = useMemo(() => new Map(benefits.map((item) => [item.id, item])), [benefits]);

  const [view, setView] = useState<View>("nearby");
  const [query, setQuery] = useState("");
  const [selectedRegion, setSelectedRegion] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedKinds, setSelectedKinds] = useState<BenefitKind[]>([]);
  const [selectedBenefit, setSelectedBenefit] = useState<Benefit | null>(null);
  const [pendingFollow, setPendingFollow] = useState<Benefit | undefined>(undefined);
  const [origin, setOrigin] = useState<Origin | undefined>(undefined);
  const [locationStatus, setLocationStatus] = useState<LocationStatus>("idle");
  const [locationMessage, setLocationMessage] = useState("");
  const [online, setOnline] = useState(true);
  const [session, setSession] = useState<AuthSession | null>(null);

  const categories = useMemo(
    () => [...new Set(benefits.map((item) => item.category))].sort((a, b) => a.localeCompare(b, "ko")),
    [benefits]
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setOnline(navigator.onLine);
      const benefitId = new URLSearchParams(window.location.search).get("benefit");
      if (benefitId) setSelectedBenefit(benefitById.get(benefitId) ?? null);
    });
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      active = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [benefitById]);

  const typesForView = useMemo<BenefitType[]>(() => {
    if (view === "nearby" || view === "map") return ["FACILITY"];
    if (view === "national") return ["NATIONAL"];
    if (view === "ordinance") return ["ORDINANCE"];
    return [];
  }, [view]);

  const searchRequest = useMemo<SearchRequest>(() => {
    const useFilters = view === "all";
    return {
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(typesForView.length ? { types: typesForView } : {}),
      ...(useFilters && selectedCategories.length ? { categories: selectedCategories } : {}),
      ...(useFilters && selectedKinds.length ? { benefitKinds: selectedKinds } : {}),
      ...(selectedRegion && (view === "nearby" || view === "map" || view === "ordinance")
        ? { regionCodes: [selectedRegion] }
        : {}),
      ...(origin && (view === "nearby" || view === "map") ? { origin } : {})
    };
  }, [origin, query, selectedCategories, selectedKinds, selectedRegion, typesForView, view]);

  const { results, elapsedMs, isSearching } = useBenefitSearch(benefits, searchRequest);

  const requestLocation = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setLocationStatus("error");
      setLocationMessage("이 브라우저에서는 위치를 사용할 수 없습니다. 지역을 직접 선택해 주세요.");
      return;
    }
    setLocationStatus("loading");
    setLocationMessage("");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setOrigin({ latitude: coords.latitude, longitude: coords.longitude });
        setSelectedRegion("");
        setLocationStatus("granted");
        setLocationMessage("현재 위치에서 가까운 순서로 정렬했어요.");
      },
      (error) => {
        setOrigin(undefined);
        setLocationStatus(error.code === error.PERMISSION_DENIED ? "denied" : "error");
        setLocationMessage(
          error.code === error.PERMISSION_DENIED
            ? "위치 권한이 꺼져 있어요. 아래에서 지역을 직접 골라도 같은 혜택을 볼 수 있습니다."
            : "현재 위치를 확인하지 못했습니다. 지역을 직접 선택해 주세요."
        );
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 300_000 }
    );
  }, []);

  const chooseRegion = useCallback((region: string) => {
    setSelectedRegion(region);
    setOrigin(undefined);
    setLocationStatus(region ? "manual" : "idle");
    setLocationMessage(region ? "선택한 지역의 혜택을 모았어요." : "");
  }, []);

  const openBenefit = useCallback((benefit: Benefit) => {
    setSelectedBenefit(benefit);
    const url = new URL(window.location.href);
    url.searchParams.set("benefit", benefit.id);
    window.history.replaceState(null, "", url);
  }, []);

  const closeBenefit = useCallback(() => {
    setSelectedBenefit(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("benefit");
    window.history.replaceState(null, "", url);
  }, []);

  const followBenefit = useCallback((benefit: Benefit) => {
    setPendingFollow(benefit);
    setSelectedBenefit(null);
    setView("follow");
    const url = new URL(window.location.href);
    url.searchParams.delete("benefit");
    window.history.replaceState(null, "", url);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const changeView = useCallback((nextView: View) => {
    setView(nextView);
    setQuery("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleSessionChange = useCallback((nextSession: AuthSession | null) => {
    setSession(nextSession);
  }, []);

  const toggleFilter = <T extends string>(value: T, current: T[], setter: (value: T[]) => void) => {
    setter(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const heading =
    view === "nearby" ? "내 주변 혜택" :
    view === "all" ? "모든 혜택" :
    view === "national" ? "전국 공통 혜택" :
    view === "ordinance" ? "우리 지역 조례" :
    view === "recent" ? "최근 확인된 변경" : "";

  return (
    <div className="app-shell" data-pilot-slug={slug}>
      <header className="top-header">
        <div className="top-header__inner">
          <button className="brand" type="button" onClick={() => changeView("nearby")} aria-label="병역명문가 혜택찾기 홈">
            <span className="brand__mark" aria-hidden="true">名</span>
            <span className="brand__copy"><strong>병역명문가</strong><small>혜택찾기</small></span>
          </button>
          <div className="header-status">
            <span className="pilot-pill">PRIVATE PILOT</span>
            <span className={`online-dot${online ? "" : " is-offline"}`} title={online ? "온라인" : "오프라인"}>
              <span aria-hidden="true" />{online ? "최신" : "오프라인"}
            </span>
          </div>
        </div>
      </header>

      <div className="sample-banner" role="note">
        <strong>{datasetManifest.datasetId.startsWith("pilot-sample") || datasetSource === "bundled" ? "화면 검증용 샘플 데이터" : "게시된 공공 원천 데이터"}</strong>
        <span>
          {datasetError
            ? `마지막 번들 버전을 표시합니다: ${datasetError}`
            : "이 서비스의 요약보다 각 혜택의 공식 원문과 현장 안내가 우선합니다."}
        </span>
      </div>

      <section className="hero">
        <div className="hero__texture" aria-hidden="true"><span>名</span><span>家</span></div>
        <div className="hero__content">
          <span className="eyebrow eyebrow--light">한 가문의 명예, 가까운 일상 혜택으로</span>
          <h1>병역명문가 혜택,<br /><em>찾기 쉽게 모았습니다.</em></h1>
          <p>내 주변 예우시설부터 전국 혜택과 지자체 조례까지 한 번에 확인하세요.</p>
          <div className="hero__stats">
            <div><strong>{benefits.filter((item) => item.type === "FACILITY").length}</strong><span>예우시설</span></div>
            <div><strong>{benefits.filter((item) => item.type === "NATIONAL").length}</strong><span>전국 혜택</span></div>
            <div><strong>{benefits.filter((item) => item.type === "ORDINANCE").length}</strong><span>조례 안내</span></div>
          </div>
        </div>
      </section>

      <div className="search-dock">
        <div className="search-box">
          <span aria-hidden="true">⌕</span>
          <label className="sr-only" htmlFor="benefit-search">혜택 검색</label>
          <input
            id="benefit-search"
            type="search"
            placeholder="시설명, 지역, 혜택을 검색하세요"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? <button type="button" onClick={() => setQuery("")} aria-label="검색어 지우기">×</button> : null}
        </div>
      </div>

      <nav className="view-tabs" aria-label="혜택 화면">
        <div className="view-tabs__inner">
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.id}
              className={view === item.id ? "is-active" : ""}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => changeView(item.id)}
            >
              <span aria-hidden="true">{item.symbol}</span>{item.label}
              {item.id === "admin" && session?.isAdmin ? <i className="notification-badge" aria-label="검수함 확인 필요">!</i> : null}
            </button>
          ))}
        </div>
      </nav>

      <main id="main-content" className="main-content">
        {view === "nearby" ? (
          <section className="nearby-control" aria-labelledby="nearby-control-title">
            <div className="nearby-control__copy">
              <span className="location-symbol" aria-hidden="true">⌖</span>
              <div><h2 id="nearby-control-title">가까운 혜택부터 볼까요?</h2><p>위치는 저장하지 않고 이 기기에서만 거리 계산에 사용해요.</p></div>
            </div>
            <button className="location-button" type="button" onClick={requestLocation} disabled={locationStatus === "loading"}>
              {locationStatus === "loading" ? "위치 확인 중…" : locationStatus === "granted" ? "위치 다시 확인" : "현재 위치 사용"}
            </button>
            <div className="manual-region">
              <span>또는</span>
              <label className="sr-only" htmlFor="manual-region">지역 직접 선택</label>
              <select id="manual-region" value={selectedRegion} onChange={(event) => chooseRegion(event.target.value)}>
                {REGION_OPTIONS.map(([value, label]) => <option value={value} key={value || "none"}>{label}</option>)}
              </select>
            </div>
            {locationMessage ? <p className={`location-message location-message--${locationStatus}`} role="status">{locationMessage}</p> : null}
          </section>
        ) : null}

        {view === "all" ? (
          <section className="filter-panel" aria-label="전체 혜택 필터">
            <div className="filter-group"><strong>혜택</strong><div className="chip-row">
              {(Object.keys(KIND_LABEL) as BenefitKind[]).map((kind) => <button type="button" key={kind} className={selectedKinds.includes(kind) ? "is-active" : ""} onClick={() => toggleFilter(kind, selectedKinds, setSelectedKinds)}>{KIND_LABEL[kind]}</button>)}
            </div></div>
            <div className="filter-group"><strong>분류</strong><div className="chip-row chip-row--scroll">
              {categories.map((category) => <button type="button" key={category} className={selectedCategories.includes(category) ? "is-active" : ""} onClick={() => toggleFilter(category, selectedCategories, setSelectedCategories)}>{category}</button>)}
            </div></div>
            {selectedCategories.length || selectedKinds.length ? <button className="reset-filter" type="button" onClick={() => { setSelectedCategories([]); setSelectedKinds([]); }}>필터 초기화</button> : null}
          </section>
        ) : null}

        {view === "national" ? <div className="feature-intro feature-intro--national"><span aria-hidden="true">全</span><div><strong>전국 어디서나 확인할 혜택</strong><p>기간과 대상 상품이 바뀔 수 있어 공식 공지 확인이 특히 중요해요.</p></div></div> : null}
        {view === "ordinance" ? <div className="feature-intro feature-intro--ordinance"><span aria-hidden="true">法</span><div><strong>조례 근거와 실제 시행을 함께 확인</strong><p>조례에 근거가 있어도 시설별 시행 시점·감면율은 다를 수 있습니다.</p></div><select aria-label="조례 지역 선택" value={selectedRegion} onChange={(event) => chooseRegion(event.target.value)}>{REGION_OPTIONS.map(([value, label]) => <option value={value} key={value || "all"}>{value ? label : "모든 지역"}</option>)}</select></div> : null}

        {view === "map" ? (
          <MapPanel items={results} onSelect={openBenefit} {...(origin ? { origin } : {})} />
        ) : view === "follow" ? (
          <SubscriptionsPanel benefits={benefits} onPendingConsumed={() => setPendingFollow(undefined)} onSessionChange={handleSessionChange} {...(pendingFollow ? { pendingBenefit: pendingFollow } : {})} />
        ) : view === "admin" ? (
          <AdminPanel session={session} onOpenLogin={() => changeView("follow")} />
        ) : (
          <section className="results-section" aria-labelledby="results-title">
            <div className="section-heading">
              <div><span className="eyebrow">{view === "recent" ? "지난 2주" : origin ? "거리순" : selectedRegion ? "선택 지역" : "추천 목록"}</span><h2 id="results-title">{heading}</h2></div>
              <div className="results-meta" aria-live="polite"><strong>{results.length}</strong>개<span>{isSearching ? "검색 중" : `${elapsedMs.toFixed(1)}ms`}</span></div>
            </div>
            {view === "recent" ? <div className="timeline-key"><span className="timeline-key__new" />신규·내용 변경을 최근 확인일 순으로 보여드려요.</div> : null}
            <div className="benefit-grid">
              {results.map((benefit: SearchResult) => (
                <div key={benefit.id} className={view === "recent" ? "recent-item" : ""}>
                  {view === "recent" ? <div className="recent-item__date"><strong>{formatDate(benefit.updatedAt)}</strong><span>{TYPE_LABEL[benefit.type]} 확인</span></div> : null}
                  <BenefitCard benefit={benefit} onSelect={openBenefit} onFollow={followBenefit} />
                </div>
              ))}
            </div>
            {!results.length ? <div className="empty-state"><span aria-hidden="true">⌕</span><strong>조건에 맞는 혜택이 없어요</strong><p>검색어 또는 필터를 바꿔 보세요.</p><button type="button" onClick={() => { setQuery(""); setSelectedCategories([]); setSelectedKinds([]); setSelectedRegion(""); }}>조건 초기화</button></div> : null}
          </section>
        )}

        <footer className="service-footer">
          <strong>병무청 공식 서비스가 아닌 독립 정보서비스입니다.</strong>
          <p>혜택은 변경될 수 있으므로 방문 전 공식 원문 또는 시설에 확인하세요. 정확한 현재 위치는 서버에 저장하지 않습니다.</p>
          <div><a href="https://www.mma.go.kr/hall/index.do" target="_blank" rel="noreferrer">병역명문가 포털 ↗</a><span>데이터 {datasetManifest.datasetId}</span></div>
        </footer>
      </main>

      <nav className="bottom-nav" aria-label="빠른 화면 이동">
        {BOTTOM_VIEWS.map((viewId) => {
          const item = NAV_ITEMS.find((navItem) => navItem.id === viewId)!;
          return <button type="button" key={viewId} className={view === viewId ? "is-active" : ""} aria-current={view === viewId ? "page" : undefined} onClick={() => changeView(viewId)}><span aria-hidden="true">{item.symbol}</span>{item.shortLabel}</button>;
        })}
      </nav>

      {selectedBenefit ? <BenefitDetail benefit={selectedBenefit} onClose={closeBenefit} onFollow={followBenefit} /> : null}
    </div>
  );
}
