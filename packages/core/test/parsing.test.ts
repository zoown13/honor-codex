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
    expect(parseOrdinanceSearch(ordinanceJsonFixture)).toEqual(expect.objectContaining({
      records: [expect.objectContaining({
        id: "1234567", localGovernment: "서울특별시", effectiveAt: "2025-01-01",
      })],
      totalCount: 1, page: 1, rowCount: 1, section: "ordinNm", target: "ordin",
    }));
    const detail = JSON.stringify({ 조문: [
      { 조문내용: "제1조 목적" },
      { 조문내용: "제5조 시장은 병역명문가에게 이용료를 감면할 수 있다." },
    ] });
    expect(parseMatchingArticles(detail)).toEqual(["제5조 시장은 병역명문가에게 이용료를 감면할 수 있다."]);

    const actualFieldNames = JSON.stringify({
      조문: [{ 조내용: "제7조 병역명문가의 시설 이용료를 감면한다." }],
      부칙: { 부칙내용: "이 조례는 병역명문가 지원에 관한 경과조치를 둔다." },
      제개정이유: { 제개정이유내용: "병역명문가 예우 대상을 명확히 하려는 것임." },
    });
    expect(parseMatchingArticles(actualFieldNames)).toEqual([
      "제7조 병역명문가의 시설 이용료를 감면한다.",
      "이 조례는 병역명문가 지원에 관한 경과조치를 둔다.",
      "병역명문가 예우 대상을 명확히 하려는 것임.",
    ]);
  });

  it("accepts numeric metadata and a single law record", () => {
    const fixture = JSON.parse(ordinanceJsonFixture) as { OrdinSearch: Record<string, unknown> };
    fixture.OrdinSearch.page = 1;
    fixture.OrdinSearch.totalCnt = 1;
    fixture.OrdinSearch.numOfRows = 1;
    const [record] = fixture.OrdinSearch.law as Record<string, unknown>[];
    fixture.OrdinSearch.law = record;

    expect(parseOrdinanceSearch(JSON.stringify(fixture))).toEqual(expect.objectContaining({
      records: [expect.objectContaining({ id: "1234567" })],
      totalCount: 1,
      page: 1,
      rowCount: 1,
    }));
  });

  it("accepts an absent law key only for an empty page", () => {
    const fixture = JSON.parse(ordinanceJsonFixture) as { OrdinSearch: Record<string, unknown> };
    fixture.OrdinSearch.totalCnt = "0";
    fixture.OrdinSearch.numOfRows = "0";
    delete fixture.OrdinSearch.law;

    expect(parseOrdinanceSearch(JSON.stringify(fixture))).toEqual({
      records: [], totalCount: 0, page: 1, rowCount: 0, section: "ordinNm", target: "ordin",
    });
  });

  it("rejects malformed ordinance search metadata", () => {
    const invalidMetadata: [string, unknown][] = [
      ["page", "0"],
      ["totalCnt", -1],
      ["numOfRows", "1.5"],
      ["section", ""],
      ["target", "law"],
      ["resultCode", "01"],
    ];
    for (const [field, value] of invalidMetadata) {
      const fixture = JSON.parse(ordinanceJsonFixture) as { OrdinSearch: Record<string, unknown> };
      fixture.OrdinSearch[field] = value;
      expect(() => parseOrdinanceSearch(JSON.stringify(fixture))).toThrow();
    }
    expect(() => parseOrdinanceSearch(JSON.stringify({ resultCode: "00" }))).toThrow("OrdinSearch");
  });

  it("rejects malformed containers, records, and row count mismatches", () => {
    const malformedContainer = JSON.parse(ordinanceJsonFixture) as { OrdinSearch: Record<string, unknown> };
    malformedContainer.OrdinSearch.law = "not-a-record";
    expect(() => parseOrdinanceSearch(JSON.stringify(malformedContainer))).toThrow("container");

    const missingContainer = JSON.parse(ordinanceJsonFixture) as { OrdinSearch: Record<string, unknown> };
    delete missingContainer.OrdinSearch.law;
    expect(() => parseOrdinanceSearch(JSON.stringify(missingContainer))).toThrow("missing law");

    const mismatch = JSON.parse(ordinanceJsonFixture) as { OrdinSearch: Record<string, unknown> };
    mismatch.OrdinSearch.numOfRows = "2";
    expect(() => parseOrdinanceSearch(JSON.stringify(mismatch))).toThrow("row count mismatch");

    const malformedRecord = JSON.parse(ordinanceJsonFixture) as { OrdinSearch: Record<string, unknown> };
    malformedRecord.OrdinSearch.law = [{ "자치법규ID": "1234567" }];
    expect(() => parseOrdinanceSearch(JSON.stringify(malformedRecord))).toThrow("record at index 0");
  });

  it("rejects XML and invalid JSON ordinance search responses", () => {
    expect(() => parseOrdinanceSearch("<OrdinSearch />")).toThrow("must be JSON");
    expect(() => parseOrdinanceSearch("not-json")).toThrow("not valid JSON");
  });

  it("injects fetch into the ordinance client", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => ordinanceJsonFixture
    }));
    const client = new LawApiClient({ oc: "pilot@example.com", fetch: fetchMock });
    const result = await client.searchOrdinances();
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("target")).toBe("ordin");
    expect(requested.searchParams.get("query")).toBe("병역명문가");
    expect(requested.searchParams.get("sort")).toBe("lasc");
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(result.records).toHaveLength(1);
    expect(result).toMatchObject({ totalCount: 1, page: 1, rowCount: 1 });
  });
});
