import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminPanel } from "../components/admin-panel";
import {
  getReviewSummary,
  saveActiveReviewOperation,
  type ActiveReviewOperation
} from "../lib/api";

describe("AdminPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("shows source summaries and requires both acknowledgements before bulk approval", async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);

    expect(await screen.findByRole("heading", { name: "병무청 예우시설" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "병무청 전국 혜택 공지" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "법제처 지자체 조례" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "승인 데이터를 서비스에 게시" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "조례 핵심 내용 AI 정제" })).toBeInTheDocument();
    expect(screen.getByText("승인과 게시는 분리되어 있습니다")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "병무청 예우시설 1건 일괄 승인" }));
    const dialog = screen.getByRole("dialog", { name: "병무청 예우시설 1건 승인" });
    const submit = within(dialog).getByRole("button", { name: "1건 승인 시작" });
    expect(submit).toBeDisabled();

    await user.click(within(dialog).getByRole("checkbox"));
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText("확인 문구 입력"), "APPROVE MMA_FACILITIES 1");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await screen.findByText("병무청 예우시설 1건 승인을 완료했습니다.")).toBeInTheDocument();
    await waitFor(() => {
      const sourceCard = screen.getByRole("heading", { name: "병무청 예우시설" }).closest("article");
      expect(sourceCard).not.toBeNull();
      expect(within(sourceCard!).getByText("대기 중인 변경 없음")).toBeInTheDocument();
    });
  });

  it("restores an unfinished operation without creating a new operation id", async () => {
    const group = (await getReviewSummary()).groups.find((item) => item.source === "MMA_FACILITIES")!;
    const operation: ActiveReviewOperation = {
      source: group.source,
      batchId: group.batchId,
      detectedAt: group.detectedAt,
      expectedCount: group.count,
      fingerprint: group.fingerprint,
      confirmation: group.confirmationPhrase,
      operationId: "11111111-1111-4111-8111-111111111111",
      label: group.label,
      confirmationPhrase: group.confirmationPhrase,
      approvedCount: 0,
      remainingCount: group.count,
      startedAt: "2026-07-14T03:01:00.000Z"
    };
    saveActiveReviewOperation(operation);

    render(<AdminPanel />);

    expect(await screen.findByRole("button", { name: "같은 작업으로 계속" })).toBeInTheDocument();
    expect(screen.getByText("작업 UUID 유지")).toBeInTheDocument();
  });

  it("opens the complete review list instead of limiting the owner to five samples", async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);

    expect(await screen.findByRole("heading", { name: "병무청 예우시설" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "전체 1건 검토" })[0]!);

    const dialog = await screen.findByRole("dialog", { name: "병무청 예우시설 전체 검수" });
    expect(within(dialog).getByText("1페이지")).toBeInTheDocument();
    expect(within(dialog).getByText("/ 1건")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "다음 25건" })).toBeDisabled();
  });
});
