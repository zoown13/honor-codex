import "@testing-library/jest-dom/vitest";

class WorkerStub {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage() {}
  terminate() {}
}

Object.defineProperty(globalThis, "Worker", { value: WorkerStub, writable: true });
