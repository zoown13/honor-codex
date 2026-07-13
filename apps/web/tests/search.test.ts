import type { SearchRequest } from "@honor/core";
import { benefits } from "../data/sample-benefits";
import { distanceKm, searchBenefits } from "../lib/search";

describe("benefit search", () => {
  it("matches normalized Korean terms across the search text", () => {
    const result = searchBenefits(benefits, { query: "서울 주차" });
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("서울숲 공영주차장");
  });

  it("combines type, region, and benefit-kind filters", () => {
    const request: SearchRequest = {
      types: ["FACILITY"],
      regionCodes: ["BUSAN"],
      benefitKinds: ["DISCOUNT"]
    };
    const result = searchBenefits(benefits, request);
    expect(result.map((item) => item.id)).toEqual(["fac:mma-sample-003"]);
  });

  it("sorts geocoded venues first and retains missing-coordinate venues", () => {
    const result = searchBenefits(benefits, {
      types: ["FACILITY"],
      origin: { latitude: 37.55, longitude: 127.04 }
    });
    expect(result[0]?.id).toBe("fac:mma-sample-001");
    expect(result.at(-1)?.id).toBe("fac:mma-sample-005");
    expect(result.at(-1)?.distanceKm).toBeUndefined();
  });

  it("calculates a plausible Seoul-to-Busan distance", () => {
    const value = distanceKm(
      { latitude: 37.5665, longitude: 126.978 },
      { latitude: 35.1796, longitude: 129.0756 }
    );
    expect(value).toBeGreaterThan(320);
    expect(value).toBeLessThan(340);
  });

  it("searches and distance-sorts 2,071 facilities within the 100ms pilot budget", () => {
    const fixture = benefits.find((item) => item.type === "FACILITY" && item.location);
    expect(fixture).toBeDefined();
    const location = fixture!.location!;
    const corpus = Array.from({ length: 2_071 }, (_, index) => ({
      ...fixture!,
      id: `fac:performance-${index}`,
      title: `${fixture!.title} ${index}`,
      location: {
        ...location,
        latitude: location.latitude + (index % 100) * 0.00001
      }
    }));
    const request: SearchRequest = {
      types: ["FACILITY"],
      origin: { latitude: 37.55, longitude: 127.04 }
    };
    searchBenefits(corpus, request);
    const started = performance.now();
    const result = searchBenefits(corpus, request);
    const elapsed = performance.now() - started;

    expect(result).toHaveLength(2_071);
    expect(elapsed).toBeLessThan(100);
  });
});
