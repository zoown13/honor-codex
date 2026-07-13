import type {
  Benefit,
  BenefitChange,
  DatasetManifest,
  PushSubscriptionRecord,
  Subscription,
} from "@honor/core";

export interface StoredSubscription extends Subscription {
  recipientEmail: string;
}

export interface DeliveryReservation {
  userId: string;
  idempotencyKey: string;
  channel: "EMAIL" | "WEB_PUSH";
  status: "PENDING" | "SENT" | "FAILED";
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface AppRepository {
  listSubscriptions(userId: string): Promise<StoredSubscription[]>;
  putSubscription(value: StoredSubscription): Promise<void>;
  deleteSubscription(userId: string, subscriptionId: string): Promise<boolean>;
  listAllSubscriptions(): Promise<StoredSubscription[]>;
  putPushSubscription(value: PushSubscriptionRecord): Promise<void>;
  listPushSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  deletePushSubscription(userId: string, pushId: string): Promise<boolean>;
  deleteUserData(userId: string): Promise<number>;
  putChanges(changes: readonly BenefitChange[]): Promise<number>;
  listChanges(statuses?: readonly BenefitChange["status"][]): Promise<BenefitChange[]>;
  getChange(changeId: string): Promise<BenefitChange | undefined>;
  reviewChange(changeId: string, decision: "APPROVED" | "REJECTED", reviewer: string, at: string): Promise<BenefitChange>;
  markChangesPublished(changeIds: readonly string[], at: string): Promise<void>;
  reserveDelivery(value: DeliveryReservation): Promise<boolean>;
  finishDelivery(userId: string, key: string, status: "SENT" | "FAILED", at: string, error?: string): Promise<void>;
}

export interface DatasetStorage {
  loadBenefits(): Promise<Benefit[]>;
  saveSnapshot(source: string, retrievedAt: string, body: string): Promise<string>;
  saveCandidate(source: string, retrievedAt: string, benefits: readonly Benefit[]): Promise<string>;
  publish(benefits: readonly Benefit[], generatedAt: string): Promise<DatasetManifest>;
}

export interface DeploymentTrigger {
  start(): Promise<string | undefined>;
}

export interface NotificationTrigger {
  immediate(changeIds: readonly string[]): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export interface PushMessage {
  subscription: PushSubscriptionRecord;
  title: string;
  body: string;
  url: string;
}

export interface PushSender {
  send(message: PushMessage): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
