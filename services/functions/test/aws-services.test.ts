import { describe, expect, it, vi } from "vitest";
import { normalizeMmaFacility } from "@honor/core";
import { AmplifyDeploymentTrigger, S3DatasetStorage } from "../src/shared/aws-services.js";
import { DeploymentOutcomeUnknownError } from "../src/shared/contracts.js";

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
  it("returns and deletes only the exact staged manifest version", async () => {
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
    expect(publication.rollbackToken).toBe("manifest-version");
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: { Bucket: "dataset-bucket", Key: "published/manifest.json" },
    });

    await storage.rollback(publication.rollbackToken);

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
  it("starts a RELEASE job without hiding its ID from durable state", async () => {
    const send = vi.fn().mockResolvedValueOnce({ jobSummary: { jobId: "17" } });
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      branch: "main",
      client: { send } as never,
    });

    await expect(deployment.start()).resolves.toBe("17");
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: {
        appId: "app-id",
        branchName: "main",
        jobType: "RELEASE",
      },
    });
  });

  it("waits until GetJob reports SUCCEED", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ job: { summary: { status: "SUCCEED" } } });
    const sleep = vi.fn(async () => undefined);
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      client: { send } as never,
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      now: () => 0,
      sleep,
    });

    await expect(deployment.wait("18")).resolves.toBeUndefined();
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "GetJobCommand",
      "GetJobCommand",
    ]);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("retries transient GetJob errors inside the polling deadline", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("temporary network error"))
      .mockResolvedValueOnce({ job: { summary: { status: "SUCCEED" } } });
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      client: { send } as never,
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(deployment.wait("19")).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails immediately when Amplify reports a terminal failure", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ job: { summary: { status: "FAILED" } } });
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      client: { send } as never,
      pollIntervalMs: 0,
      maxWaitMs: 1_000,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    });

    await expect(deployment.wait("20")).rejects.toThrow("finished with FAILED");
  });

  it("waits for CANCELLED after StopJob before declaring a safe failure", async () => {
    let time = 0;
    const send = vi.fn()
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ jobSummary: { jobId: "21", status: "CANCELLING" } })
      .mockResolvedValueOnce({ job: { summary: { status: "CANCELLED" } } });
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      branch: "main",
      client: { send } as never,
      pollIntervalMs: 1,
      maxWaitMs: 1,
      cancellationWaitMs: 10,
      now: () => time,
      sleep: vi.fn(async (milliseconds: number) => { time += milliseconds; }),
    });

    await expect(deployment.wait("21")).rejects.toThrow("finished with CANCELLED");
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      "GetJobCommand",
      "GetJobCommand",
      "StopJobCommand",
      "GetJobCommand",
    ]);
  });

  it("treats a late SUCCEED after StopJob as success instead of rolling back", async () => {
    let time = 0;
    const send = vi.fn()
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ jobSummary: { jobId: "22", status: "CANCELLING" } })
      .mockResolvedValueOnce({ job: { summary: { status: "SUCCEED" } } });
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      client: { send } as never,
      pollIntervalMs: 1,
      maxWaitMs: 1,
      cancellationWaitMs: 10,
      now: () => time,
      sleep: vi.fn(async (milliseconds: number) => { time += milliseconds; }),
    });

    await expect(deployment.wait("22")).resolves.toBeUndefined();
  });

  it("reports an unknown outcome if cancellation never reaches a terminal state", async () => {
    let time = 0;
    const send = vi.fn()
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ job: { summary: { status: "RUNNING" } } })
      .mockResolvedValueOnce({ jobSummary: { jobId: "23", status: "CANCELLING" } })
      .mockResolvedValue({ job: { summary: { status: "CANCELLING" } } });
    const deployment = new AmplifyDeploymentTrigger({
      appId: "app-id",
      client: { send } as never,
      pollIntervalMs: 1,
      maxWaitMs: 1,
      cancellationWaitMs: 2,
      now: () => time,
      sleep: vi.fn(async (milliseconds: number) => { time += milliseconds; }),
    });

    await expect(deployment.wait("23")).rejects.toBeInstanceOf(DeploymentOutcomeUnknownError);
  });
});
