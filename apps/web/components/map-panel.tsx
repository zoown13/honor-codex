"use client";

import type { SearchResult } from "@honor/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { KAKAO_MAP_APP_KEY } from "../lib/config";
import { formatDistance } from "../lib/format";

interface KakaoMapsApi {
  load: (callback: () => void) => void;
  LatLng: new (latitude: number, longitude: number) => unknown;
  Map: new (element: HTMLElement, options: { center: unknown; level: number }) => unknown;
  Marker: new (options: { map: unknown; position: unknown; title?: string }) => unknown;
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

export function MapPanel({ items, origin, onSelect }: MapPanelProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const mappableItems = useMemo(() => items.filter((item) => item.location).slice(0, 80), [items]);

  useEffect(() => {
    if (!KAKAO_MAP_APP_KEY || !mapRef.current || mappableItems.length === 0) return;
    let disposed = false;

    const renderMap = () => {
      const kakao = getKakao();
      const mapElement = mapRef.current;
      const first = origin ?? mappableItems[0]?.location;
      if (!kakao || !mapElement || !first || disposed) return;

      kakao.maps.load(() => {
        if (disposed) return;
        const center = new kakao.maps.LatLng(first.latitude, first.longitude);
        const map = new kakao.maps.Map(mapElement, { center, level: origin ? 6 : 9 });
        mappableItems.forEach((item) => {
          if (!item.location) return;
          new kakao.maps.Marker({
            map,
            position: new kakao.maps.LatLng(item.location.latitude, item.location.longitude),
            title: item.title
          });
        });
        setStatus("ready");
      });
    };

    const existing = document.querySelector<HTMLScriptElement>("script[data-honor-kakao-map]");
    if (existing) {
      queueMicrotask(() => { if (!disposed) setStatus("loading"); });
      if (getKakao()) renderMap();
      else existing.addEventListener("load", renderMap, { once: true });
      return () => {
        disposed = true;
        existing.removeEventListener("load", renderMap);
      };
    }

    queueMicrotask(() => { if (!disposed) setStatus("loading"); });
    const script = document.createElement("script");
    script.dataset.honorKakaoMap = "true";
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KAKAO_MAP_APP_KEY)}&autoload=false`;
    script.async = true;
    script.addEventListener("load", renderMap, { once: true });
    script.addEventListener("error", () => setStatus("error"), { once: true });
    document.head.appendChild(script);

    return () => {
      disposed = true;
      script.removeEventListener("load", renderMap);
    };
  }, [mappableItems, origin]);

  const showFallback = !KAKAO_MAP_APP_KEY || status === "error";

  return (
    <section className="map-panel" aria-labelledby="map-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">지도와 목록</span>
          <h2 id="map-title">혜택 위치 보기</h2>
        </div>
        <span className="result-count">{mappableItems.length}곳</span>
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
      ) : (
        <div className="map-canvas-wrap">
          <div ref={mapRef} className="map-canvas" aria-label="카카오 지도" />
          {status === "loading" ? <div className="map-loading">지도를 불러오는 중…</div> : null}
        </div>
      )}

      {items.some((item) => !item.location && item.type === "FACILITY") ? (
        <p className="map-note">좌표가 없는 시설도 아래 목록과 지역·키워드 검색에는 포함됩니다.</p>
      ) : null}

      <div className="map-place-list" aria-label="지도에 표시된 혜택 목록">
        {items.slice(0, 8).map((item, index) => (
          <button type="button" key={item.id} onClick={() => onSelect(item)}>
            <span className="map-place-list__number">{index + 1}</span>
            <span className="map-place-list__body">
              <strong>{item.title}</strong>
              <span>{item.displayAddress ?? item.provider}</span>
            </span>
            <span className="map-place-list__distance">
              {item.type === "FACILITY" ? formatDistance(item.distanceKm) : "전국"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
