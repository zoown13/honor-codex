"use client";

import {
  sha256Hex,
  type Benefit,
  type DatasetManifest,
} from "@honor/core";
import { useEffect, useState } from "react";

interface DatasetState {
  items: Benefit[];
  manifest: DatasetManifest;
  source: "bundled" | "published";
  error?: string;
}

export function useDataset(
  fallbackItems: Benefit[],
  fallbackManifest: DatasetManifest,
): DatasetState {
  const [state, setState] = useState<DatasetState>({
    items: fallbackItems,
    manifest: fallbackManifest,
    source: "bundled",
  });

  useEffect(() => {
    let active = true;
    void loadPublishedDataset()
      .then((loaded) => {
        if (active) setState({ ...loaded, source: "published" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "게시 데이터 확인 실패",
        }));
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}

async function loadPublishedDataset(): Promise<Pick<DatasetState, "items" | "manifest">> {
  const manifestResponse = await fetch("/data/manifest.json", { cache: "no-store" });
  if (!manifestResponse.ok) throw new Error("데이터 버전 정보를 불러오지 못했습니다.");
  const manifest = await manifestResponse.json() as DatasetManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.datasetId ||
    !manifest.indexUrl.startsWith("/data/") ||
    !/^[a-f0-9]{64}$/i.test(manifest.sha256)
  ) {
    throw new Error("데이터 버전 정보가 올바르지 않습니다.");
  }

  const indexResponse = await fetch(manifest.indexUrl, { cache: "no-cache" });
  if (!indexResponse.ok) throw new Error("혜택 인덱스를 불러오지 못했습니다.");
  const indexText = await indexResponse.text();
  if (sha256Hex(indexText) !== manifest.sha256) {
    throw new Error("혜택 인덱스 무결성 검증에 실패했습니다.");
  }

  const parsed = JSON.parse(indexText) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : undefined;
  if (!items || items.length !== manifest.itemCount || !items.every(isBenefit)) {
    throw new Error("혜택 인덱스 형식이 올바르지 않습니다.");
  }
  if (isRecord(parsed) && parsed.datasetId !== undefined && parsed.datasetId !== manifest.datasetId) {
    throw new Error("혜택 인덱스 버전이 manifest와 다릅니다.");
  }

  return { items: items as Benefit[], manifest };
}

function isBenefit(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && ["FACILITY", "NATIONAL", "ORDINANCE"].includes(String(value.type))
    && Array.isArray(value.regionCodes)
    && isRecord(value.source)
    && typeof value.source.url === "string";
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
