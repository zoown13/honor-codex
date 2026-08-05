import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { benefits } from "../data/sample-benefits";
import { BenefitCard } from "../components/benefit-card";

describe("BenefitCard", () => {
  it("shows the benefit summary and exposes detail and follow actions", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onFollow = vi.fn();
    const benefit = { ...benefits[0]!, distanceKm: 1.24 };

    render(<BenefitCard benefit={benefit} onSelect={onSelect} onFollow={onFollow} />);

    expect(screen.getAllByText("서울숲 공영주차장")).toHaveLength(2);
    expect(screen.getByText("1.2km")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /변경 알림 받기/ }));
    expect(onFollow).toHaveBeenCalledWith(benefit);
    await user.click(screen.getByRole("button", { name: "자세히" }));
    expect(onSelect).toHaveBeenCalledWith(benefit);
  });

  it("shows the ordinance date used for latest-content sorting", () => {
    const ordinance = benefits.find((item) => item.type === "ORDINANCE");
    expect(ordinance).toBeDefined();

    render(<BenefitCard benefit={ordinance!} onSelect={vi.fn()} onFollow={vi.fn()} />);

    expect(screen.getByText(/수정일/)).toBeInTheDocument();
  });

  it("marks AI-refined ordinances on the card", () => {
    const ordinance = benefits.find((item) => item.type === "ORDINANCE");
    expect(ordinance).toBeDefined();
    const aiOrdinance = {
      ...ordinance!,
      updatedAt: "2026-07-29T12:50:11.604Z",
      validity: { ...ordinance!.validity, startsAt: "2025-12-01" },
      summaryProvenance: {
        kind: "AI" as const,
        modelId: "global.amazon.nova-2-lite-v1:0",
        generatedAt: "2026-07-29T12:50:11.604Z",
        sourceContentHash: ordinance!.source.contentHash,
      },
    };

    render(<BenefitCard benefit={aiOrdinance} onSelect={vi.fn()} onFollow={vi.fn()} />);

    expect(screen.getByText("AI 정제")).toBeInTheDocument();
    expect(screen.getByText(/시행일/)).toBeInTheDocument();
  });

  it("uses a uniform condensed preview for ordinance lists", () => {
    const ordinance = benefits.find((item) => item.type === "ORDINANCE");
    expect(ordinance).toBeDefined();

    const { container } = render(
      <BenefitCard
        benefit={{ ...ordinance!, summary: "긴 조례 원문 ".repeat(100) }}
        onSelect={vi.fn()}
        onFollow={vi.fn()}
        condensed
      />
    );

    expect(container.querySelector(".benefit-card--condensed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "내용 더보기" })).toBeInTheDocument();
  });
});
