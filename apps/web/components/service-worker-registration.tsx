"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    navigator.serviceWorker.register("/sw-v2.js", { scope: "/" }).catch(() => {
      // Offline support is best-effort. The app remains usable without registration.
    });
  }, []);

  return null;
}
