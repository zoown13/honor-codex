import { describe, expect, it, vi } from "vitest";
import { createIngestionControl, type IngestionJob, type JobStore, type Source } from "../src/handlers/ingestion-control.js";
import { createIngestionWorker } from "../src/handlers/ingestion-worker.js";
import { httpEvent } from "./fakes.js";

class Store implements JobStore {
  jobs = new Map<Source, IngestionJob>();
  async get(source: Source) { return this.jobs.get(source) ?? null; }
  async begin(job: IngestionJob) {
    const current = this.jobs.get(job.source);
    if (current && ["QUEUED", "RUNNING"].includes(current.status) && current.expiresAt > Date.now()) return false;
    this.jobs.set(job.source, job);
    return true;
  }
  async update(job: IngestionJob, expected: IngestionJob["status"]) {
    const current = this.jobs.get(job.source);
    if (current?.id !== job.id || current.status !== expected) return false;
    this.jobs.set(job.source, job);
    return true;
  }
}
const env = { PILOT_ADMIN_TOKEN: "owner-secret", MMA_LIVE_INGESTION_ENABLED: "true", LAW_INGESTION_AVAILABLE: "true" };
const event = (source: unknown, token = "owner-secret") => httpEvent("/v1/pilot-admin/ingestion", "POST", { source }, { headers: { "x-honor-pilot-admin": token } });
describe("manual ingestion", () => {
  it("rejects invalid credentials, sources, and disabled ingestion before dispatch", async () => {
    const enqueue = vi.fn();
    const store = new Store();
    const api = createIngestionControl({ store, enqueue }, env);
    expect((await api(event("MMA_FACILITIES", "wrong"))).statusCode).toBe(403);
    expect((await api(event("arbitrary-function"))).statusCode).toBe(400);
    expect((await createIngestionControl({ store, enqueue }, { ...env, LAW_INGESTION_AVAILABLE: "false" })(event("LAW_ORDINANCES"))).statusCode).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("accepts asynchronously and rejects duplicate starts", async () => {
    const store = new Store();
    const enqueue = vi.fn();
    const api = createIngestionControl({ store, enqueue }, env);
    expect((await api(event("MMA_FACILITIES"))).statusCode).toBe(202);
    expect((await api(event("MMA_FACILITIES"))).statusCode).toBe(409);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it("runs each queued job once and records completion without publishing", async () => {
    const store = new Store();
    await createIngestionControl({ store, enqueue: async () => {} }, env)(event("MMA_FACILITIES"));
    const job = (await store.get("MMA_FACILITIES"))!;
    const collect = vi.fn().mockResolvedValue({ changes: 2 });
    const worker = createIngestionWorker(store, collect);
    await Promise.all([worker(job), worker(job)]);
    expect(collect).toHaveBeenCalledTimes(1);
    expect((await store.get(job.source))?.status).toBe("COMPLETED");
    await worker(job);
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it("marks skipped and failed collections as failed and allows retry", async () => {
    const store = new Store();
    const api = createIngestionControl({ store, enqueue: async () => {} }, env);
    await api(event("LAW_ORDINANCES"));
    await createIngestionWorker(store, async () => ({ skipped: true }))((await store.get("LAW_ORDINANCES"))!);
    expect((await store.get("LAW_ORDINANCES"))?.status).toBe("FAILED");
    expect((await api(event("LAW_ORDINANCES"))).statusCode).toBe(202);
    await expect(createIngestionWorker(store, async () => { throw new Error("unavailable"); })((await store.get("LAW_ORDINANCES"))!)).rejects.toThrow("unavailable");
    expect((await store.get("LAW_ORDINANCES"))?.status).toBe("FAILED");
  });
  it("shows expired jobs as failed and fences stale workers", async () => {
    const store = new Store();
    await createIngestionControl({ store, enqueue: async () => {} }, env)(event("MMA_NOTICES"));
    const old = (await store.get("MMA_NOTICES"))!;
    store.jobs.set(old.source, { ...old, expiresAt: 0 });
    const api = createIngestionControl({ store, enqueue: async () => {} }, env);
    const status = await api(httpEvent("/v1/pilot-admin/ingestion", "GET", undefined, { headers: { "x-honor-pilot-admin": "owner-secret" } }));
    expect(JSON.parse(String(status.body)).jobs[0].status).toBe("FAILED");
    expect((await api(event("MMA_NOTICES"))).statusCode).toBe(202);
    const collect = vi.fn();
    await createIngestionWorker(store, collect)(old);
    expect(collect).not.toHaveBeenCalled();
  });
});
