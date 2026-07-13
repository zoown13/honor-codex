export type BenefitType = "FACILITY" | "NATIONAL" | "ORDINANCE";
export type BenefitScope = "VENUE" | "REGION" | "NATIONAL";
export type BenefitKind = "FREE" | "DISCOUNT" | "OTHER";
export type BenefitStatus =
  | "ACTIVE"
  | "PENDING_REVIEW"
  | "ENDED"
  | "NEEDS_CONFIRMATION";
export type ReviewState = "SOURCE_ONLY" | "REVIEWED";

export interface GeoPoint {
  latitude: number;
  longitude: number;
  provenance: "MMA" | "MANUAL";
}

export interface BenefitSource {
  system: "MMA" | "LAW_GO_KR" | "MANUAL";
  id: string;
  url: string;
  retrievedAt: string;
  contentHash: string;
}

export interface Evidence {
  label: string;
  sourceUrl: string;
  sourceId: string;
  article?: string;
  excerpt?: string;
}

export interface BenefitContact {
  phone?: string;
  website?: string;
  department?: string;
}

export interface BenefitValidity {
  startsAt?: string;
  endsAt?: string;
  checkedAt: string;
}

export interface Benefit {
  id: string;
  type: BenefitType;
  scope: BenefitScope;
  title: string;
  provider: string;
  category: string;
  benefitKind: BenefitKind;
  summary: string;
  eligibility: string[];
  amount?: string;
  requiredProof: string[];
  howToUse: string[];
  constraints: string[];
  address?: string;
  displayAddress?: string;
  regionCodes: string[];
  location?: GeoPoint;
  contact?: BenefitContact;
  validity: BenefitValidity;
  status: BenefitStatus;
  source: BenefitSource;
  evidence: Evidence[];
  reviewState: ReviewState;
  updatedAt: string;
  searchText: string;
}

export interface DatasetManifest {
  schemaVersion: 1;
  datasetId: string;
  generatedAt: string;
  indexUrl: string;
  sha256: string;
  itemCount: number;
}

export type SubscriptionTargetType = "BENEFIT" | "REGION" | "CATEGORY";
export type SubscriptionCadence = "WEEKLY" | "IMMEDIATE";
export type NotificationChannel = "EMAIL" | "WEB_PUSH";

export interface Subscription {
  id: string;
  userId: string;
  targetType: SubscriptionTargetType;
  targetId: string;
  cadence: SubscriptionCadence;
  channels: NotificationChannel[];
  createdAt: string;
  updatedAt: string;
}

export type ChangeRisk = "LOW" | "HIGH";
export type ChangeAction = "ADD" | "UPDATE" | "DELETE";
export type ChangeStatus =
  | "AUTO_APPROVED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "PUBLISHED";

export interface BenefitChange {
  id: string;
  benefitId: string;
  action: ChangeAction;
  risk: ChangeRisk;
  status: ChangeStatus;
  changedFields: string[];
  before?: Benefit;
  after?: Benefit;
  detectedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  publishedAt?: string;
}

export interface SearchRequest {
  query?: string;
  types?: BenefitType[];
  categories?: string[];
  regionCodes?: string[];
  benefitKinds?: BenefitKind[];
  origin?: { latitude: number; longitude: number };
}

export interface SearchResult extends Benefit {
  distanceKm?: number;
}

export interface RawMmaFacility {
  mmgudgigwan_cd: string;
  udae_ggm: string;
  udsangse_cn?: string;
  addr?: string;
  displayaddr?: string;
  udjiyeok_cd?: string;
  udggeopjong_gbcd?: string;
  udae_gbcd?: string;
  udhangmok_gbcd?: string;
  udhmgagyeok_cn?: string;
  udgigwan_telno?: string;
  hmpg_addr?: string;
  wido_vl?: string;
  gyeongdo_vl?: string;
  udgigwan_yhcd?: string;
  hyjeokyong_sjdt?: string;
  hyjeokyong_jrdt?: string;
  udgghaeje_dt?: string;
  udgigwan_rm?: string;
  [key: string]: unknown;
}

export interface MmaFacilityPayload {
  success: boolean;
  list: RawMmaFacility[];
}

export interface RawMmaNotice {
  gsgeul_no: string;
  title: string;
  publishedAt?: string;
  updatedAt?: string;
  body?: string;
  url: string;
}

export interface OrdinanceRecord {
  id: string;
  title: string;
  localGovernment: string;
  promulgatedAt?: string;
  effectiveAt?: string;
  updatedAt?: string;
  kind?: string;
  revisionType?: string;
  url: string;
  matchingArticles: string[];
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
  updatedAt: string;
}
