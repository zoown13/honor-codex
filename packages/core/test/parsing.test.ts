import { describe, expect, it, vi } from "vitest";
import {
  LawApiClient,
  normalizeMmaFacilities,
  parseJsonp,
  parseMatchingArticles,
  parseMmaFacilityPayload,
  parseMmaNotices,
  parseOrdinanceSearch,
} from "../src/index.js";
import { mmaJsonpFixture, ordinanceJsonFixture } from "./fixtures/mma.js";

describe("safe source parsing", () => {
  it("parses actual MMA fields without evaluating JSONP", () => {
    const payload = parseMmaFacilityPayload(mmaJsonpFixture, "honorPilot");
    const [benefit] = normalizeMmaFacilities(payload.list, "2026-07-12T00:00:00.000Z");
    expect(benefit).toMatchObject({
      id: "fac:2689",
      category: "스포츠/레저",
      benefitKind: "DISCOUNT",
      regionCodes: ["GANGWON"],
      location: { latitude: 37.818336, longitude: 127.711765, provenance: "MMA" },
    });
    expect(benefit?.contact?.website).toBe("https://www.railpark.co.kr/");
  });

  it("rejects callback confusion, executable suffixes, and schema drift", () => {
    expect(() => parseJsonp("evil({\"ok\":true})", { expectedCallback: "safe" })).toThrow("Unexpected");
    expect(() => parseJsonp("safe({\"ok\":true});alert(1)")).toThrow();
    expect(() => parseJsonp("safe({__proto__: {polluted: true}})")).toThrow();
    expect(() => parseMmaFacilityPayload("cb({\"success\":true,\"list\":[{}]})", "cb")).toThrow("index 0");
  });

  it("extracts MMA notice stable keys from board HTML", () => {
    const html = `<a href="/hall/board/boardView.do?gsgeul_no=99123">병역명문가 신규 협약 안내</a>`;
    expect(parseMmaNotices(html)).toEqual([expect.objectContaining({
      gsgeul_no: "99123", title: "병역명문가 신규 협약 안내",
    })]);
  });

  it("parses law.go.kr records and retains only matching article evidence", () => {
    expect(parseOrdinanceSearch(ordinanceJsonFixture)).toEqual([expect.objectContaining({
      id: "1234567", localGovernment: "서울특별시", effectiveAt: "2025-01-01",
    })]);
    const detail = JSON.stringify({ 조문: [
      { 조문내용: "제1조 목적" },
      { 조문내용: "제5조 시장은 병역명문가에게 이용료를 감면할 수 있다." },
    ] });
    expect(parseMatchingArticles(detail)).toEqual(["제5조 시장은 병역명문가에게 이용료를 감면할 수 있다."]);
  });

  it("injects fetch into the ordinance client", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => ordinanceJsonFixture }));
    const client = new LawApiClient({ oc: "pilot@example.com", fetch: fetchMock });
    const result = await client.searchOrdinances();
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("target")).toBe("ordin");
    expect(requested.searchParams.get("query")).toBe("병역명문가");
    expect(result).toHaveLength(1);
  });
});
