import { expect, test } from "@playwright/test";

test("shared pilot path supports search and benefit detail", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: /병역명문가 혜택/ })).toBeVisible();
  await expect(page.getByText("화면 검증용 샘플 데이터")).toBeVisible();

  await page.getByLabel("혜택 검색").fill("서울 주차");
  const seoulCard = page.getByRole("article").filter({ hasText: "서울숲 공영주차장" });
  await expect(seoulCard).toBeVisible();
  await seoulCard.getByRole("button", { name: "자세히" }).click();
  await expect(page.getByRole("dialog")).toContainText("준비물");
  await expect(page.getByRole("dialog")).toContainText("공식 원문");
  await page.getByRole("button", { name: "닫기" }).click();
});

test("location denial leaves a manual region path", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await page.goto(baseURL!);
  await page.getByRole("button", { name: "현재 위치 사용" }).click();
  await expect(page.getByText(/지역을 직접/)).toBeVisible();
  await page.getByLabel("지역 직접 선택").selectOption("BUSAN");
  await expect(page.getByText("부산시민공원 주차장")).toBeVisible();
  await context.close();
});

test("mock email OTP creates a follow subscription", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "알림 설정" }).click();
  await page.getByLabel("알림 받을 이메일").fill("pilot@example.com");
  await page.getByRole("button", { name: "인증번호 받기" }).click();
  await page.getByLabel("이메일 인증번호").fill("123456");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await page.getByRole("button", { name: "이메일 알림 추가" }).click();
  await expect(page.getByText("알림 설정을 저장했습니다.")).toBeVisible();
});

test("root path does not reveal the pilot", async ({ page, baseURL }) => {
  const root = new URL(baseURL!).origin;
  const response = await page.goto(root);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "공유된 파일럿 주소를 확인해 주세요" })).toBeVisible();
});

test("last verified dataset and app shell remain available offline", async ({ browser, baseURL }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(baseURL!);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw-v2.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: /병역명문가 혜택/ })).toBeVisible();

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /병역명문가 혜택/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^서울숲 공영주차장 병역명문가증/ })).toBeVisible();
  await context.close();
});

test("precise device coordinates never enter application network requests", async ({ browser, baseURL }) => {
  const latitude = 37.123456;
  const longitude = 127.654321;
  const context = await browser.newContext({
    geolocation: { latitude, longitude },
    permissions: ["geolocation"]
  });
  const requests: string[] = [];
  const page = await context.newPage();
  page.on("request", (request) => {
    requests.push(`${request.url()} ${request.postData() ?? ""}`);
  });
  await page.goto(baseURL!);
  await page.getByRole("button", { name: "현재 위치 사용" }).click();
  await expect(page.getByText("현재 위치에서 가까운 순서로 정렬했어요.")).toBeVisible();

  const networkText = requests.join("\n");
  expect(networkText).not.toContain(String(latitude));
  expect(networkText).not.toContain(String(longitude));
  await context.close();
});
