"use client";

import { haversineKm, type SearchResult } from "@honor/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { KAKAO_MAP_APP_KEY } from "../lib/config";
import { formatDistance } from "../lib/format";

interface KakaoLatLng {
  getLat: () => number;
  getLng: () => number;
}

interface KakaoLatLngBounds {
  contain: (position: KakaoLatLng) => boolean;
}

interface KakaoMap {
  getBounds: () => KakaoLatLngBounds;
  getCenter: () => KakaoLatLng;
}

interface KakaoMarker {
  setMap: (map: KakaoMap | null) => void;
}

interface KakaoInfoWindow {
  open: (map: KakaoMap, marker: KakaoMarker) => void;
  close: () => void;
}

interface KakaoMapsApi {
  load: (callback: () => void) => void;
  LatLng: new (latitude: number, longitude: number) => KakaoLatLng;
  Map: new (element: HTMLElement, options: { center: KakaoLatLng; level: number }) => KakaoMap;
  Marker: new (options: { map: KakaoMap; position: KakaoLatLng; title?: string }) => KakaoMarker;
  InfoWindow: new (options: { content: HTMLElement; removable?: boolean; disableAutoPan?: boolean }) => KakaoInfoWindow;
  event: {
    addListener: (target: object, event: string, listener: () => void) => void;
    removeListener: (target: object, event: string, listener: () => void) => void;
  };
}

interface KakaoGlobal {
  maps: KakaoMapsApi;
}

function getKakao() {
  return (window as unknown as { kakao?: KakaoGlobal }).kakao;
}

interface MapPanelProps {
  items: SearchResult[];
  origin?: { latitude: number; longitude: number };
  onSelect: (benefit: SearchResult) => void;
}

interface RenderedMarker {
  marker: KakaoMarker;
  handleClick: () => void;
}

const MAX_VISIBLE_MARKERS = 120;
const MAX_LIST_ITEMS = 20;

export function MapPanel({ items, origin, onSelect }: MapPanelProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<KakaoMap | null>(null);
  const markersRef = useRef<RenderedMarker[]>([]);
  const infoWindowRef = useRef<KakaoInfoWindow | null>(null);
  const syncViewportRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [viewportItems, setViewportItems] = useState<SearchResult[]>([]);
  const mappableItems = useMemo(() => items.filter((item) => item.location), [items]);
  const itemsRef = useRef(mappableItems);
  const originRef = useRef(origin);
  const onSelectRef = useRef(onSelect);
  const canRenderMap = Boolean(KAKAO_MAP_APP_KEY && mappableItems.length > 0);

  useEffect(() => {
    itemsRef.current = mappableItems;
    syncViewportRef.current?.();
  }, [mappableItems]);

  useEffect(() => {
    originRef.current = origin;
  }, [origin]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!canRenderMap) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setViewportItems([]);
        setStatus("idle");
      });
      return () => { cancelled = true; };
    }
    if (!mapRef.current) return;
    let disposed = false;
    let scriptElement: HTMLScriptElement | null = null;
    let mapsApi: KakaoMapsApi | null = null;
    let idleHandler: (() => void) | null = null;

    const closeInfoWindow = () => {
      infoWindowRef.current?.close();
      infoWindowRef.current = null;
    };

    const clearMarkers = () => {
      if (!mapsApi) return;
      markersRef.current.forEach(({ marker, handleClick }) => {
        mapsApi?.event.removeListener(marker, "click", handleClick);
        marker.setMap(null);
      });
      markersRef.current = [];
    };

    const renderMap = () => {
      const kakao = getKakao();
      const mapElement = mapRef.current;
      const first = originRef.current ?? itemsRef.current[0]?.location;
      if (!kakao || !mapElement || !first || disposed) return;
      mapsApi = kakao.maps;

      kakao.maps.load(() => {
        if (disposed || mapInstanceRef.current) return;
        const center = new kakao.maps.LatLng(first.latitude, first.longitude);
        const map = new kakao.maps.Map(mapElement, { center, level: originRef.current ? 6 : 9 });
        mapInstanceRef.current = map;

        const syncViewport = () => {
          if (disposed) return;
          const bounds = map.getBounds();
          const mapCenter = map.getCenter();
          const centerPoint = { latitude: mapCenter.getLat(), longitude: mapCenter.getLng() };
          const visible = itemsRef.current
            .filter((item) => item.location && bounds.contain(
              new kakao.maps.LatLng(item.location.latitude, item.location.longitude)
            ))
            .map((item) => ({
              ...item,
              distanceKm: haversineKm(centerPoint, item.location!)
            }))
            .sort((firstItem, secondItem) =>
              (firstItem.distanceKm ?? Number.POSITIVE_INFINITY)
              - (secondItem.distanceKm ?? Number.POSITIVE_INFINITY)
              || firstItem.title.localeCompare(secondItem.title, "ko-KR")
            );

          closeInfoWindow();
          clearMarkers();
          visible.slice(0, MAX_VISIBLE_MARKERS).forEach((item) => {
            const location = item.location;
            if (!location) return;
            const marker = new kakao.maps.Marker({
              map,
              position: new kakao.maps.LatLng(location.latitude, location.longitude),
              title: item.title
            });
            const handleClick = () => {
              closeInfoWindow();
              const infoWindow = new kakao.maps.InfoWindow({
                content: createInfoWindowContent(item, () => onSelectRef.current(item)),
                removable: true,
                disableAutoPan: true
              });
              infoWindow.open(map, marker);
              infoWindowRef.current = infoWindow;
            };
            kakao.maps.event.addListener(marker, "click", handleClick);
            markersRef.current.push({ marker, handleClick });
          });
          setViewportItems(visible);
        };

        syncViewportRef.current = syncViewport;
        idleHandler = syncViewport;
        kakao.maps.event.addListener(map, "idle", syncViewport);
        syncViewport();
        setStatus("ready");
      });
    };

    const handleScriptLoad = () => renderMap();
    const handleScriptError = () => {
      if (!disposed) setStatus("error");
    };

    queueMicrotask(() => {
      if (!disposed) setStatus("loading");
    });
    const existing = document.querySelector<HTMLScriptElement>("script[data-honor-kakao-map]");
    if (existing) {
      scriptElement = existing;
      if (getKakao()) queueMicrotask(renderMap);
      else existing.addEventListener("load", handleScriptLoad, { once: true });
    } else {
      const script = document.createElement("script");
      scriptElement = script;
      script.dataset.honorKakaoMap = "true";
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KAKAO_MAP_APP_KEY)}&autoload=false`;
      script.async = true;
      script.addEventListener("load", handleScriptLoad, { once: true });
      script.addEventListener("error", handleScriptError, { once: true });
      document.head.appendChild(script);
    }

    return () => {
      disposed = true;
      scriptElement?.removeEventListener("load", handleScriptLoad);
      scriptElement?.removeEventListener("error", handleScriptError);
      const map = mapInstanceRef.current;
      if (map && mapsApi && idleHandler) mapsApi.event.removeListener(map, "idle", idleHandler);
      clearMarkers();
      closeInfoWindow();
      syncViewportRef.current = null;
      mapInstanceRef.current = null;
    };
  }, [canRenderMap]);

  const showFallback = !KAKAO_MAP_APP_KEY || status === "error";
  const showMapEmpty = Boolean(KAKAO_MAP_APP_KEY && mappableItems.length === 0);
  const activeItems = status === "ready" && canRenderMap ? viewportItems : mappableItems;
  const listItems = activeItems.slice(0, MAX_LIST_ITEMS);
  const resultLabel = status === "ready" && canRenderMap
    ? `지도 안 ${activeItems.length}곳`
    : `${mappableItems.length}곳`;

  return (
    <section className="map-panel" aria-labelledby="map-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">지도와 목록</span>
          <h2 id="map-title">혜택 위치 보기</h2>
        </div>
        <span className="result-count" aria-live="polite">{resultLabel}</span>
      </div>

      <div className="privacy-note privacy-note--compact">
        <span aria-hidden="true">◎</span>
        현재 위치는 이 기기에서만 거리 계산에 사용되며 AWS로 보내지지 않습니다. 지도 사용 시
        좌표가 카카오에 전달될 수 있습니다.
      </div>

      {showFallback ? (
        <div className="map-fallback" role="status">
          <div className="map-fallback__grid" aria-hidden="true">
            <span className="map-pin map-pin--one">1</span>
            <span className="map-pin map-pin--two">2</span>
            <span className="map-pin map-pin--three">3</span>
          </div>
          <div className="map-fallback__copy">
            <strong>{KAKAO_MAP_APP_KEY ? "지도를 불러오지 못했어요" : "지도 키를 연결하면 여기에 지도가 표시돼요"}</strong>
            <span>목록만으로도 모든 혜택을 확인할 수 있습니다.</span>
          </div>
        </div>
      ) : showMapEmpty ? (
        <div className="map-fallback map-fallback--empty" role="status">
          <div className="map-fallback__copy">
            <strong>조건에 맞는 좌표 시설이 없습니다.</strong>
            <span>검색어 또는 지역 조건을 바꾸면 지도를 다시 표시합니다.</span>
          </div>
        </div>
      ) : (
        <div className="map-canvas-wrap">
          <div ref={mapRef} className="map-canvas" aria-label="카카오 지도" />
          {status === "loading" ? <div className="map-loading">지도를 불러오는 중…</div> : null}
        </div>
      )}

      {items.some((item) => !item.location && item.type === "FACILITY") ? (
        <p className="map-note">좌표가 없는 시설은 지도 목록에서 제외되지만 전체·지역·키워드 검색에는 포함됩니다.</p>
      ) : null}

      {status === "ready" && canRenderMap ? (
        <p className="map-note map-note--viewport" aria-live="polite">
          지도를 이동하거나 확대·축소하면 현재 화면 안의 시설을 중심에서 가까운 순서로 다시 표시합니다.
          {activeItems.length > MAX_VISIBLE_MARKERS
            ? ` 성능을 위해 가까운 ${MAX_VISIBLE_MARKERS}곳만 마커로 표시합니다.`
            : ""}
        </p>
      ) : null}

      <div className="map-place-list" aria-label="지도에 표시된 혜택 목록">
        {listItems.length ? listItems.map((item, index) => (
          <button type="button" key={item.id} onClick={() => onSelect(item)}>
            <span className="map-place-list__number">{index + 1}</span>
            <span className="map-place-list__body">
              <strong>{item.title}</strong>
              <span>{item.displayAddress ?? item.provider}</span>
            </span>
            <span className="map-place-list__distance">
              {status === "ready" ? `중심 ${formatDistance(item.distanceKm)}` : formatDistance(item.distanceKm)}
            </span>
          </button>
        )) : (
          <div className="map-place-list__empty" role="status">
            <strong>현재 지도 영역에 표시할 시설이 없습니다.</strong>
            <span>지도를 이동하거나 축소해 다른 지역을 확인해 보세요.</span>
          </div>
        )}
      </div>
      {status === "ready" && canRenderMap && activeItems.length > MAX_LIST_ITEMS ? (
        <p className="map-note">지도 안 {activeItems.length}곳 중 중심에서 가까운 {MAX_LIST_ITEMS}곳을 목록에 표시합니다.</p>
      ) : null}
    </section>
  );
}

function createInfoWindowContent(item: SearchResult, onSelect: () => void): HTMLElement {
  const container = document.createElement("div");
  container.className = "map-info-window";
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", `${item.title} 지도 정보`);

  const title = document.createElement("strong");
  title.className = "map-info-window__title";
  title.textContent = item.title;

  const address = document.createElement("span");
  address.className = "map-info-window__address";
  address.textContent = item.displayAddress ?? item.address ?? item.provider;

  const summary = document.createElement("p");
  summary.className = "map-info-window__summary";
  summary.textContent = item.summary.length > 90 ? `${item.summary.slice(0, 87)}…` : item.summary;

  const actions = document.createElement("div");
  actions.className = "map-info-window__actions";

  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.textContent = "혜택 상세 보기";
  detailsButton.addEventListener("click", onSelect);
  actions.appendChild(detailsButton);

  if (item.location) {
    const kakaoLink = document.createElement("a");
    kakaoLink.href = [
      "https://map.kakao.com/link/map/",
      encodeURIComponent(item.title),
      `,${item.location.latitude},${item.location.longitude}`
    ].join("");
    kakaoLink.target = "_blank";
    kakaoLink.rel = "noopener noreferrer";
    kakaoLink.textContent = "카카오맵에서 보기 ↗";
    actions.appendChild(kakaoLink);
  }

  container.append(title, address, summary, actions);
  return container;
}
