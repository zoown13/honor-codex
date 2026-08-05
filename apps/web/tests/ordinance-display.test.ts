import type { Benefit } from "@honor/core";
import { benefits } from "../data/sample-benefits";
import {
  compareOrdinancesByLatestContent,
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

    expect([older, newer].sort(compareOrdinancesByLatestContent).map(({ id }) => id))
      .toEqual(["ord:newer", "ord:older"]);
    expect(ordinanceContentDate(newer)).toMatchObject({
      label: "수정일",
      value: "2026-07-13",
    });
  });

  it("uses the effective date for legacy AI records whose update date was overwritten", () => {
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
    const normal = ordinanceFixture({
      id: "ord:normal",
      updatedAt: "2025-12-01",
      validity: { checkedAt: "2026-07-14", startsAt: "2025-12-01" },
    });

    expect([legacyAi, normal].sort(compareOrdinancesByLatestContent).map(({ id }) => id))
      .toEqual(["ord:normal", "ord:legacy-ai"]);
    expect(ordinanceContentDate(legacyAi)).toMatchObject({
      label: "시행일",
      value: "2024-11-04",
    });
  });
});
