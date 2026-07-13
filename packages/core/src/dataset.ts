import { canonicalStringify, sha256Hex } from "./canonical.ts";
import type { Benefit, DatasetManifest } from "./types.ts";

export interface DatasetIndex {
  schemaVersion: 1;
  datasetId: string;
  generatedAt: string;
  items: Benefit[];
}

export interface GeneratedDataset {
  manifest: DatasetManifest;
  index: DatasetIndex;
  indexJson: string;
}

export function generateDataset(
  benefits: readonly Benefit[],
  generatedAt: string,
  basePath = "/data",
): GeneratedDataset {
  const items = [...benefits].sort((a, b) => a.id.localeCompare(b.id));
  const seedHash = sha256Hex(canonicalStringify(items));
  const timestamp = generatedAt.replace(/\D/g, "").slice(0, 14);
  const datasetId = `${timestamp || "dataset"}-${seedHash.slice(0, 12)}`;
  const index: DatasetIndex = { schemaVersion: 1, datasetId, generatedAt, items };
  const indexJson = canonicalStringify(index);
  const sha256 = sha256Hex(indexJson);
  const normalizedBase = `/${basePath.replace(/^\/+|\/+$/g, "")}`;
  const manifest: DatasetManifest = {
    schemaVersion: 1,
    datasetId,
    generatedAt,
    indexUrl: `${normalizedBase}/search-index.${datasetId}.json`,
    sha256,
    itemCount: items.length,
  };
  return { manifest, index, indexJson };
}

export function verifyDataset(manifest: DatasetManifest, indexJson: string): boolean {
  if (sha256Hex(indexJson) !== manifest.sha256) return false;
  try {
    const index = JSON.parse(indexJson) as Partial<DatasetIndex>;
    return index.schemaVersion === 1 && index.datasetId === manifest.datasetId
      && Array.isArray(index.items) && index.items.length === manifest.itemCount;
  } catch {
    return false;
  }
}
