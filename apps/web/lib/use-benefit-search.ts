"use client";

import type { Benefit, SearchRequest, SearchResult } from "@honor/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchBenefits } from "./search";

interface SearchWorkerResponse {
  requestId: number;
  results: SearchResult[];
  elapsedMs: number;
}

export function useBenefitSearch(items: Benefit[], request: SearchRequest) {
  const requestKey = JSON.stringify(request);
  const stableRequest = useMemo(() => request, [requestKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [results, setResults] = useState<SearchResult[]>(() =>
    searchBenefits(items, stableRequest)
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    const worker = new Worker("/search-worker.js");
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
      if (event.data.requestId !== requestIdRef.current) return;
      setResults(event.data.results);
      setElapsedMs(event.data.elapsedMs);
      setIsSearching(false);
    };

    worker.onerror = () => {
      workerRef.current = null;
      setIsSearching(false);
    };

    return () => worker.terminate();
  }, []);

  useEffect(() => {
    const worker = workerRef.current;
    const requestId = ++requestIdRef.current;

    if (!worker) {
      const started = performance.now();
      setResults(searchBenefits(items, stableRequest));
      setElapsedMs(performance.now() - started);
      return;
    }

    setIsSearching(true);
    worker.postMessage({ requestId, items, request: stableRequest });
  }, [items, stableRequest]);

  return { results, elapsedMs, isSearching };
}
