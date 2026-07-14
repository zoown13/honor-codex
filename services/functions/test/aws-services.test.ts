import { describe, expect, it, vi } from "vitest";
import { normalizeMmaFacility } from "@honor/core";
import { AmplifyDeploymentTrigger, S3DatasetStorage } from "../src/shared/aws-services.js";

const generatedAt = "2026-07-14T00:00:00.000Z";
const benefit = normalizeMmaFacility({
  mmgudgigwan_cd: "1",
  udae_ggm: "테스트 시설",
  udsangse_cn: "10% 할인",
  udjiyeok_cd: "09",
  udggeopjong_gbcd: "05",
  udae_gbcd: "02",
}, generatedAt);

describe("S3DatasetStorage publication rollback", () => {
  it("deletes only the staged manifest version and makes rollback idempotent", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ VersionId: "index-version" })
      .mockResolvedValueOnce({ VersionId: "manifest-version" })
      .mockResolvedValueOnce({});
    const storage = new S3DatasetStorage({
      bucket: "dataset-bucket",
      prefix: "published",
      client: { send } as never,
    });

    const publication = await storage.publish([benefit], generatedAt);
    expect(publication.manifest.itemCount).toBe(1);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: { Bucket: "dataset-bucket", Key: "published/manifest.json" },
    });

    await publication.rollback();
    await publication.rollback();

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      input: {
        Bucket: "dataset-bucket",
        Key: "published/manifest.json",
        VersionId: "manifest-version",
      },
    });
  });
});

describe("AmplifyDeploymentTrigger success gate", () => {
  it("returns only after GetJob reports SUCCEED", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ jobSummary: { jobId: "17" } })
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ job: { summary: { status: "SUCCEED" } } });
    const sleep = vi.fn(async () => undefined);
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      branch: "main",
      client: { send } as never,
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      now: () => 0,
      sleep,
    });

    await expect(deployment.start()).resolves.toBe("17");
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "StartJobCommand",
      "GetJobCommand",
      "GetJobCommand",
    ]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("fails immediately when Amplify reports a terminal failure", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ jobSummary: { jobId: "18" } })
      .mockResolvedValueOnce({ job: { summary: { status: "FAILED" } } });
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      client: { send } as never,
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(deployment.start()).rejects.toThrow("finished with FAILED");
  });

  it("stops a job before failing a deployment timeout", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ jobSummary: { jobId: "19" } })
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ jobSummary: { jobId: "19", status: "CANCELLING" } });
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_001);
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      branch: "main",
      client: { send } as never,
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      now,
      sleep: vi.fn(async () => undefined),
    });

    await expect(deployment.start()).rejects.toThrow("timed out and was stopped");
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "StartJobCommand",
      "GetJobCommand",
      "StopJobCommand",
    ]);
  });
});
