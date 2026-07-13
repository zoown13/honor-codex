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
});
