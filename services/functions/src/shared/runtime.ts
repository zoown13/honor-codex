import { DynamoAppRepository } from "./aws-repository.js";
import {
  AmplifyDeploymentTrigger,
  LambdaNotificationTrigger,
  S3DatasetStorage,
  SesMailer,
  VapidPushSender,
} from "./aws-services.js";
export { systemClock } from "./contracts.js";

export function repository(env: NodeJS.ProcessEnv = process.env): DynamoAppRepository {
  return new DynamoAppRepository({ tableName: required(env, "TABLE_NAME") });
}

export function datasetStorage(env: NodeJS.ProcessEnv = process.env): S3DatasetStorage {
  return new S3DatasetStorage({
    bucket: required(env, "DATA_BUCKET"),
    rawPrefix: nonEmpty(env.RAW_PREFIX) || "raw",
    prefix: nonEmpty(env.DATA_PREFIX) || "data",
  });
}

export function deploymentTrigger(env: NodeJS.ProcessEnv = process.env): AmplifyDeploymentTrigger {
  const appId = nonEmpty(env.AMPLIFY_APP_ID);
  return new AmplifyDeploymentTrigger({
    ...(appId ? { appId } : {}),
    branch: nonEmpty(env.AMPLIFY_BRANCH) || "main",
  });
}

export function notificationTrigger(env: NodeJS.ProcessEnv = process.env): LambdaNotificationTrigger {
  return new LambdaNotificationTrigger({ functionName: required(env, "NOTIFICATION_FUNCTION_NAME") });
}

export function mailer(env: NodeJS.ProcessEnv = process.env): SesMailer {
  return new SesMailer(required(env, "SES_FROM_EMAIL"));
}

export function pushSender(env: NodeJS.ProcessEnv = process.env): VapidPushSender | undefined {
  const subject = nonEmpty(env.VAPID_SUBJECT);
  const publicKey = nonEmpty(env.VAPID_PUBLIC_KEY);
  const privateKey = nonEmpty(env.VAPID_PRIVATE_KEY);
  return subject && publicKey && privateKey ? new VapidPushSender(subject, publicKey, privateKey) : undefined;
}

export function liveMmaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MMA_LIVE_INGESTION_ENABLED?.trim().toLocaleLowerCase("en-US") === "true";
}

export function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = nonEmpty(env[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}
