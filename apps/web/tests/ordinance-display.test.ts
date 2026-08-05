import type { Benefit } from "@honor/core";
import { benefits } from "../data/sample-benefits";
import {
  compareOrdinancesForDisplay,
  ordinanceContentDate,
} from "../lib/ordinance-display";

function ordinanceFixture(overrides: Partial<Benefit>): Benefit {
  const ordinance = benefits.find((item) => item.type === "ORDINANCE");
  if (!ordinance) throw new Error("ordinance fixture is missing");
  return { ...ordinance, ...overrides };
}

describe("ordinance latest-content display", () => {
  it("sorts by official modification date descending", () => {
    const older = ordinanceFixture({
      id: "ord:older",
      title: "이전 조례",
      updatedAt: "2025-12-01",
      validity: { checkedAt: "2026-07-14", startsAt: "2025-12-01" },
    });
    const newer = ordinanceFixture({
      id: "ord:newer",
      title: "최신 조례",
      updatedAt: "2026-07-13",
      validity: { checkedAt: "2026-07-14", startsAt: "2026-07-13" },
    });

    expect([older, newer].sort(compareOrdinancesForDisplay).map(({ id }) => id))
      .toEqual(["ord:newer", "ord:older"]);
    expect(ordinanceContentDate(newer)).toMatchObject({
      label: "수정일",
      value: "2026-07-13",
    });
  });

  it("puts AI summaries first and uses their effective dates for ordering", () => {
    const legacyAi = ordinanceFixture({
      id: "ord:legacy-ai",
      updatedAt: "2026-07-29T12:50:11.604Z",
      validity: { checkedAt: "2026-07-14", startsAt: "2024-11-04" },
      summaryProvenance: {
        kind: "AI",
        modelId: "global.amazon.nova-2-lite-v1:0",
        generatedAt: "2026-07-29T12:50:11.604Z",
        sourceContentHash: "source-hash",
      },
    });
    const newerAi = ordinanceFixture({
      ...legacyAi,
      id: "ord:newer-ai",
      updatedAt: "2026-07-30T12:50:11.604Z",
      validity: { checkedAt: "2026-07-14", startsAt: "2025-12-01" },
      summaryProvenance: {
        ...legacyAi.summaryProvenance!,
        generatedAt: "2026-07-30T12:50:11.604Z",
      },
    });
    const normal = ordinanceFixture({
      id: "ord:normal",
      updatedAt: "2026-07-13",
      validity: { checkedAt: "2026-07-14", startsAt: "2026-07-13" },
    });

    expect([legacyAi, normal, newerAi].sort(compareOrdinancesForDisplay).map(({ id }) => id))
      .toEqual(["ord:newer-ai", "ord:legacy-ai", "ord:normal"]);
    expect(ordinanceContentDate(legacyAi)).toMatchObject({
      label: "시행일",
      value: "2024-11-04",
    });
  });
});
