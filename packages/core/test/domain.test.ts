import { describe, expect, it } from "vitest";
import {
  canonicalStringify,
  diffBenefitSets,
  generateDataset,
  haversineKm,
  isCoordinateInKorea,
  normalizeMmaFacility,
  sha256Hex,
  searchBenefits,
  verifyDataset,
} from "../src/index.js";
import { mmaFacilityFixture } from "./fixtures/mma.js";

const now = "2026-07-12T00:00:00.000Z";

describe("canonical hash and risk based diff", () => {
  it("canonicalizes object keys deterministically", () => {
    expect(canonicalStringify({ z: 1, a: { y: 2, x: 3 } }))
      .toBe(canonicalStringify({ a: { x: 3, y: 2 }, z: 1 }));
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("auto-approves non-core changes and queues benefit changes", () => {
    const before = normalizeMmaFacility(mmaFacilityFixture, now);
    const contact = { ...before, contact: { ...before.contact, phone: "033-000-0000" } };
    expect(diffBenefitSets([before], [contact], now)[0]).toMatchObject({
      risk: "LOW", status: "AUTO_APPROVED", changedFields: ["contact"],
    });
    expect(diffBenefitSets([before], [{ ...before, summary: "이용료 30% 할인" }], now)[0])
      .toMatchObject({ risk: "HIGH", status: "PENDING", changedFields: ["summary"] });
    expect(diffBenefitSets([before], [], now)[0]).toMatchObject({ action: "DELETE", risk: "HIGH" });
    expect(diffBenefitSets([], [before], now)[0]).toMatchObject({ action: "ADD", risk: "LOW" });
    const ordinance = {
      ...before, id: "ord:123", type: "ORDINANCE" as const,
      scope: "REGION" as const, category: "지자체 조례",
    };
    expect(diffBenefitSets([], [ordinance], now)[0]).toMatchObject({ action: "ADD", risk: "HIGH", status: "PENDING" });
  });

  it("ignores retrieval-only timestamps", () => {
    const before = normalizeMmaFacility(mmaFacilityFixture, now);
    const after = {
      ...before,
      validity: { ...before.validity, checkedAt: "2026-07-13T00:00:00.000Z" },
      updatedAt: "2026-07-13T00:00:00.000Z",
      source: { ...before.source, retrievedAt: "2026-07-13T00:00:00.000Z" },
    };
    expect(diffBenefitSets([before], [after], now)).toEqual([]);
  });
});

describe("coordinates, local search and manifests", () => {
  it("calculates Seoul-Busan distance and validates Korea coordinates", () => {
    const distance = haversineKm(
      { latitude: 37.5665, longitude: 126.978 },
      { latitude: 35.1796, longitude: 129.0756 },
    );
    expect(distance).toBeGreaterThan(320);
    expect(distance).toBeLessThan(330);
    expect(isCoordinateInKorea({ latitude: 37.5, longitude: 127 })).toBe(true);
    expect(isCoordinateInKorea({ latitude: 0, longitude: 0 })).toBe(false);
  });

  it("sorts located results first but keeps coordinate-less results", () => {
    const located = normalizeMmaFacility(mmaFacilityFixture, now);
    const missing = normalizeMmaFacility({
      ...mmaFacilityFixture,
      mmgudgigwan_cd: "9999",
      udae_ggm: "좌표 없는 레일파크",
      wido_vl: "",
      gyeongdo_vl: "",
    }, now);
    const result = searchBenefits([missing, located], {
      query: "레일파크",
      origin: { latitude: 37.7, longitude: 127.7 },
    });
    expect(result.map((item) => item.id)).toEqual(["fac:2689", "fac:9999"]);
    expect(result[1]?.distanceKm).toBeUndefined();
  });

  it("creates a versioned manifest and detects corruption", () => {
    const benefit = normalizeMmaFacility(mmaFacilityFixture, now);
    const generated = generateDataset([benefit], now, "/pilot/data/");
    expect(generated.manifest).toMatchObject({ schemaVersion: 1, itemCount: 1 });
    expect(generated.manifest.indexUrl).toContain(`search-index.${generated.manifest.datasetId}.json`);
    expect(verifyDataset(generated.manifest, generated.indexJson)).toBe(true);
    expect(verifyDataset(generated.manifest, `${generated.indexJson} `)).toBe(false);
  });
});
