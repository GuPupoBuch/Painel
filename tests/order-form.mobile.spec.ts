import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile 390: reduce verde, 44px e stop a mercado", async ({ page }) => {
  await page.goto("/index.html?api=http://127.0.0.1:8000");
  await page.fill("#password", "teste");
  await page.click("#login-btn");
  await page.waitForSelector("#m-kind", { state: "visible" });
  await expect(page.locator("body")).toContainText("pupo", { timeout: 15000 });
  await page.selectOption("#m-kind", "trigger");
  await page.click("#m-size-modes button[data-size='pct']");
  await page.fill("#m-qty", "50");
  await page.fill("#m-trigger", "63000");
  await expect(page.locator("#m-qty-k")).toHaveText("% do saldo");
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-mobile-390-off.png", fullPage: true });
  await page.click("#m-reduce-toggle");
  await expect(page.locator("#m-reduce-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#m-qty-k")).toHaveText("% da perna");
  await expect(page.locator("#m-size-note")).toContainText("% da perna");
  const box = await page.locator("#m-reduce-toggle").boundingBox();
  expect(box && box.height >= 44).toBeTruthy();
  await expect(page.locator("#m-pnl")).toContainText("SHORT PNL");
  await expect(page.locator("#m-pnl")).toContainText("LONG PNL");
  await expect(page.locator("#btn-long .go-sub")).toContainText("2 @");
  await expect(page.locator("#btn-short .go-sub")).toContainText("4 @");
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-mobile-390.png", fullPage: true });
  await expect(page.locator("#btn-reduce")).toHaveCount(0);
});
