import { AmplifyClient, GetJobCommand, StartJobCommand, StopJobCommand } from "@aws-sdk/client-amplify";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PutObjectCommandOutput } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { generateDataset } from "@honor/core";
import type { Benefit, DatasetManifest } from "@honor/core";
import webPush from "web-push";
import type {
  DatasetPublication,
  DatasetStorage,
  DeploymentTrigger,
  EmailMessage,
  Mailer,
  NotificationTrigger,
  PushMessage,
  PushSender,
} from "./contracts.js";
import { DeploymentOutcomeUnknownError } from "./contracts.js";

interface S3DatasetStorageOptions {
  bucket: string;
  prefix?: string;
  rawPrefix?: string;
  client?: S3Client;
}

export class S3DatasetStorage implements DatasetStorage {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #rawPrefix: string;
  readonly #client: S3Client;

  constructor(options: S3DatasetStorageOptions) {
    if (!options.bucket.trim()) throw new Error("DATA_BUCKET is required");
    this.#bucket = options.bucket;
    this.#prefix = (options.prefix?.trim() || "data").replace(/^\/+|\/+$/g, "");
    this.#rawPrefix = (options.rawPrefix?.trim() || "raw").replace(/^\/+|\/+$/g, "");
    this.#client = options.client ?? new S3Client({});
  }

  async loadBenefits(): Promise<Benefit[]> {
    try {
      const manifestText = await this.#get(`${this.#prefix}/manifest.json`);
      const manifest = JSON.parse(manifestText) as DatasetManifest;
      const fileName = manifest.indexUrl.split("/").filter(Boolean).at(-1);
      if (!fileName) throw new Error("Published manifest has no index file");
      const indexText = await this.#get(`${this.#prefix}/${fileName}`);
      const index = JSON.parse(indexText) as { items?: unknown };
      if (!Array.isArray(index.items)) throw new Error("Published dataset index is invalid");
      return index.items as Benefit[];
    } catch (error) {
      if (isMissingObject(error)) return [];
      throw error;
    }
  }

  async saveSnapshot(source: string, retrievedAt: string, body: string): Promise<string> {
    const key = `${this.#rawPrefix}/${safeSegment(source)}/${fileTimestamp(retrievedAt)}.txt`;
    await this.#put(key, body, "text/plain; charset=utf-8");
    return key;
  }

  async saveCandidate(source: string, retrievedAt: string, benefits: readonly Benefit[]): Promise<string> {
    const key = `candidates/${safeSegment(source)}/${fileTimestamp(retrievedAt)}.json`;
    await this.#put(key, JSON.stringify({ retrievedAt, source, items: benefits }), "application/json; charset=utf-8");
    return key;
  }

  async publish(benefits: readonly Benefit[], generatedAt: string): Promise<DatasetPublication> {
    const generated = generateDataset(benefits, generatedAt, "/data");
    const fileName = generated.manifest.indexUrl.split("/").at(-1);
    if (!fileName) throw new Error("Generated dataset path is invalid");
    await this.#put(
      `${this.#prefix}/${fileName}`,
      generated.indexJson,
      "application/json; charset=utf-8",
      "public, max-age=31536000, immutable",
    );
    const manifestKey = `${this.#prefix}/manifest.json`;
    const manifestResult = await this.#put(
      manifestKey,
      JSON.stringify(generated.manifest),
      "application/json; charset=utf-8",
      "no-cache, max-age=60",
    );
    const manifestVersionId = manifestResult.VersionId;
    if (!manifestVersionId) {
      throw new Error("Versioned dataset bucket did not return a manifest VersionId");
    }

    return {
      manifest: generated.manifest,
      rollbackToken: manifestVersionId,
    };
  }

  async rollback(rollbackToken: string): Promise<void> {
    if (!rollbackToken.trim()) throw new Error("Manifest rollback token is required");
    await this.#client.send(new DeleteObjectCommand({
      Bucket: this.#bucket,
      Key: `${this.#prefix}/manifest.json`,
      VersionId: rollbackToken,
    }));
  }

  async #get(key: string): Promise<string> {
    const result = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
    if (!result.Body) throw new Error(`S3 object has no body: ${key}`);
    return result.Body.transformToString("utf-8");
  }

  async #put(
    key: string,
    body: string,
    contentType: string,
    cacheControl?: string,
  ): Promise<PutObjectCommandOutput> {
    return this.#client.send(new PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
      ServerSideEncryption: "AES256",
    }));
  }
}

interface AmplifyDeploymentOptions {
  appId?: string;
  branch?: string;
  client?: AmplifyClient;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  cancellationWaitMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const FAILED_AMPLIFY_STATUSES = new Set(["FAILED", "CANCELLED"]);

export class AmplifyDeploymentTrigger implements DeploymentTrigger {
  readonly #appId: string | undefined;
  readonly #branch: string;
  readonly #client: AmplifyClient;
  readonly #pollIntervalMs: number;
  readonly #maxWaitMs: number;
  readonly #cancellationWaitMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: AmplifyDeploymentOptions) {
    this.#appId = options.appId?.trim() || undefined;
    this.#branch = options.branch?.trim() || "main";
    this.#client = options.client ?? new AmplifyClient({});
    this.#pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.#maxWaitMs = options.maxWaitMs ?? 10 * 60_000;
    this.#cancellationWaitMs = options.cancellationWaitMs ?? 2 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (this.#pollIntervalMs < 0 || this.#maxWaitMs <= 0 || this.#cancellationWaitMs <= 0) {
      throw new Error("Amplify deployment polling configuration is invalid");
    }
  }

  async start(): Promise<string | undefined> {
    if (!this.#appId) return undefined;
    const result = await this.#client.send(new StartJobCommand({
      appId: this.#appId,
      branchName: this.#branch,
      jobType: "RELEASE",
      jobReason: "Publish approved benefit dataset",
    }));
    const jobId = result.jobSummary?.jobId;
    if (!jobId) throw new Error("Amplify did not return a deployment job ID");
    return jobId;
  }

  async wait(jobId: string): Promise<void> {
    if (!this.#appId) throw new Error("Amplify deployment is not configured");
    const deadline = this.#now() + this.#maxWaitMs;
    for (;;) {
      try {
        const status = await this.#status(jobId);
        if (status === "SUCCEED") return;
        if (status && FAILED_AMPLIFY_STATUSES.has(status)) {
          throw new Error(`Amplify deployment ${jobId} finished with ${status}`);
        }
      } catch (error) {
        if (isTerminalAmplifyError(error)) throw error;
      }
      if (this.#now() >= deadline) break;
      await this.#sleep(this.#pollIntervalMs);
    }

    let stopStatus: string | undefined;
    try {
      const stopped = await this.#client.send(new StopJobCommand({
        appId: this.#appId,
        branchName: this.#branch,
        jobId,
      }));
      stopStatus = stopped.jobSummary?.status;
    } catch {
      throw new DeploymentOutcomeUnknownError(
        jobId,
        `Amplify deployment ${jobId} timed out and StopJob failed; outcome requires recheck`,
      );
    }
    if (stopStatus === "SUCCEED") return;
    if (stopStatus && FAILED_AMPLIFY_STATUSES.has(stopStatus)) {
      throw new Error(`Amplify deployment ${jobId} finished with ${stopStatus}`);
    }

    const cancellationDeadline = this.#now() + this.#cancellationWaitMs;
    for (;;) {
      try {
        const status = await this.#status(jobId);
        if (status === "SUCCEED") return;
        if (status && FAILED_AMPLIFY_STATUSES.has(status)) {
          throw new Error(`Amplify deployment ${jobId} finished with ${status}`);
        }
      } catch (error) {
        if (isTerminalAmplifyError(error)) throw error;
      }
      if (this.#now() >= cancellationDeadline) {
        throw new DeploymentOutcomeUnknownError(
          jobId,
          `Amplify deployment ${jobId} did not reach a terminal state after StopJob`,
        );
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  async #status(jobId: string): Promise<string | undefined> {
    const current = await this.#client.send(new GetJobCommand({
      appId: this.#appId,
      branchName: this.#branch,
      jobId,
    }));
    return current.job?.summary?.status;
  }
}

interface LambdaNotificationTriggerOptions {
  functionName: string;
  client?: LambdaClient;
}

export class LambdaNotificationTrigger implements NotificationTrigger {
  readonly #functionName: string;
  readonly #client: LambdaClient;

  constructor(options: LambdaNotificationTriggerOptions) {
    if (!options.functionName.trim()) throw new Error("NOTIFICATION_FUNCTION_NAME is required");
    this.#functionName = options.functionName.trim();
    this.#client = options.client ?? new LambdaClient({});
  }

  async immediate(changeIds: readonly string[]): Promise<void> {
    const ids = [...new Set(changeIds)].filter(Boolean);
    if (!ids.length) return;
    const result = await this.#client.send(new InvokeCommand({
      FunctionName: this.#functionName,
      InvocationType: "Event",
      Payload: new TextEncoder().encode(JSON.stringify({ mode: "IMMEDIATE", changeIds: ids })),
    }));
    if (result.StatusCode !== 202) throw new Error(`Notification Lambda invoke returned ${result.StatusCode ?? "no status"}`);
  }
}
export class SesMailer implements Mailer {
  readonly #from: string;
  readonly #client: SESv2Client;

  constructor(from: string, client = new SESv2Client({})) {
    if (!from.trim()) throw new Error("SES_FROM_EMAIL is required");
    this.#from = from.trim();
    this.#client = client;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.#client.send(new SendEmailCommand({
      FromEmailAddress: this.#from,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {}),
          },
        },
      },
    }));
  }
}

export class VapidPushSender implements PushSender {
  constructor(subject: string, publicKey: string, privateKey: string) {
    if (!subject || !publicKey || !privateKey) throw new Error("VAPID configuration is incomplete");
    webPush.setVapidDetails(subject, publicKey, privateKey);
  }

  async send(message: PushMessage): Promise<void> {
    await webPush.sendNotification(
      { endpoint: message.subscription.endpoint, keys: message.subscription.keys },
      JSON.stringify({ title: message.title, body: message.body, url: message.url }),
      { TTL: 3600, urgency: "normal" },
    );
  }
}

function safeSegment(value: string): string {
  const result = value.replace(/[^a-z0-9_-]/gi, "-").replace(/-+/g, "-").slice(0, 64);
  if (!result) throw new Error("Invalid storage source name");
  return result;
}

function fileTimestamp(value: string): string {
  return value.replace(/[^0-9]/g, "").slice(0, 17) || String(Date.now());
}

function isTerminalAmplifyError(error: unknown): boolean {
  return error instanceof Error && /^Amplify deployment .* finished with (FAILED|CANCELLED)$/.test(error.message);
}

function isMissingObject(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error
    && ["NoSuchKey", "NotFound"].includes(String((error as { name?: string }).name));
}
