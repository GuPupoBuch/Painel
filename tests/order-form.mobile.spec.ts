import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("mobile 390: reduce verde, 44px e stop a mercado", async ({ page }) => {
  await page.goto("/index.html?api=http://127.0.0.1:8000");
  await page.fill("#password", "teste");
  await page.click("#login-btn");
  await page.waitForSelector("#m-kind", { state: "visible" });
  await expect(page.locator("body")).toContainText("pupo", { timeout: 15000 });
  const order = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel).getBoundingClientRect().top + window.scrollY;
    return { chart: top("#chart"), chips: top("#accts"), form: top("#tab-entrada"), pos: top("#positions") };
  });
  expect(order.chart).toBeLessThan(order.chips);
  expect(order.chips).toBeLessThan(order.form);
  expect(order.form).toBeLessThan(order.pos);
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-mobile-390.png", fullPage: false });
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
  await expect(page.locator("#m-pnl")).toContainText("SHORT PNL (botão LONG)");
  await expect(page.locator("#m-pnl")).toContainText("LONG PNL (botão SHORT)");
  await expect(page.locator("#m-pnl-acc")).toBeHidden();
  await expect(page.locator("#btn-long .go-sub")).toContainText("2 @");
  await expect(page.locator("#btn-short .go-sub")).toContainText("4 @");
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-mobile-390-reduce.png", fullPage: true });
  await page.click("#tab-ajustar");
  await expect(page.locator("#m-adj-leg")).toHaveCount(0);
  await expect(page.locator("#m-adj-pct-k")).toHaveText("% da perna");
  await expect(page.locator("#m-adj-leg-note")).toHaveText("Escolha LONG ou SHORT. O percentual é % da perna.");
  await expect(page.locator("#m-adj-long")).toBeEnabled();
  await expect(page.locator("#m-adj-short")).toBeEnabled();
  await page.click("#m-adj-long");
  await expect(page.locator("#m-adj-long")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#adj-pnl")).toContainText("SHORT PNL (botão LONG)");
  await expect(page.locator("#m-adj-long .go-sub")).toContainText("2 @");
  await expect(page.locator("#m-adj-short .go-sub")).toContainText("4 @");
  const stack = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel).getBoundingClientRect().top + window.scrollY;
    return { form: top("#tab-ajustar"), pos: top("#positions") };
  });
  expect(stack.form).toBeLessThan(stack.pos);
  await page.evaluate(() => {
    const el = document.querySelector("#m-adj-long");
    const top = el.getBoundingClientRect().top + window.scrollY - 120;
    window.scrollTo(0, Math.max(0, top));
  });
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-mobile-390-ajustar.png", fullPage: false });
  await expect(page.locator("#btn-reduce")).toHaveCount(0);
});
