import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

// No celular o quadro é o mesmo do PC (sem abas Entrada/Ajustar), em coluna, com controles mais baixos.
test("mobile 390: mesmo quadro do PC, controles menores, PnL realizado nas posições", async ({ page }) => {
  await page.goto("/index.html?api=http://127.0.0.1:8000");
  await page.fill("#password", "teste");
  await page.click("#login-btn");
  await page.waitForSelector("#d-kind", { state: "visible" });
  await expect(page.locator("body")).toContainText("pupo", { timeout: 15000 });
  // o quadro antigo do celular não aparece mais
  await expect(page.locator("#app-view")).toBeHidden();
  await expect(page.locator("#tab-ajustar")).toBeHidden();
  const order = await page.evaluate(() => {
    const top = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().top + window.scrollY;
    return { chart: top("#chart"), chips: top("#accts"), form: top("#desk-order"), pos: top("#d-positions") };
  });
  expect(order.chart).toBeLessThan(order.chips);
  expect(order.chips).toBeLessThan(order.form);
  expect(order.form).toBeLessThan(order.pos);
  // nada passa da largura da tela
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // LONG/SHORT fixos embaixo
  const dock = (await page.locator("#d-long").boundingBox())!;
  expect(dock.y + dock.height).toBeLessThanOrEqual(844);
  expect(dock.height).toBeLessThanOrEqual(48);
  // controles mais baixos que antes (eram 44–52px), mas ainda bons de tocar
  for (const sel of ["#d-groups button", "#d-size-modes button", "#d-reduce-toggle"]) {
    const h = (await page.locator(sel).first().boundingBox())!.height;
    expect(h, sel).toBeGreaterThanOrEqual(32);
    expect(h, sel).toBeLessThan(44);
  }
  // stop a mercado com Reduce: % da posição
  await page.selectOption("#d-kind", "trigger");
  await expect(page.locator("#d-size-modes button[data-size='pct']")).toBeHidden();
  await page.fill("#d-trigger", "63000");
  await page.click("#d-reduce-toggle");
  await expect(page.locator("#d-reduce-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.click("#d-size-modes button[data-size='pct']");
  await page.fill("#d-qty", "50");
  await expect(page.locator("#d-qty-k")).toHaveText("% da posição");
  // posições: sem a coluna do símbolo, com o PnL aberto e o realizado
  const head = page.locator("#d-pos-body thead");
  await expect(head).not.toContainText("Símbolo");
  await expect(head).toContainText("Aberto");
  await expect(head).toContainText("Realizado");
  await expect(page.locator("#d-pos-body tbody tr").first()).toContainText("+US$ 32");
  await expect(page.locator("#d-pos-body")).toContainText("−US$ 13");
  expect(await page.evaluate(() => { const b = document.querySelector("#d-pos-body")!; return b.scrollWidth - b.clientWidth; })).toBeLessThanOrEqual(1);
  // a setinha abre a redução como folha embaixo da tela
  await page.locator(".pos-act").first().click();
  const pop = (await page.locator("#pos-pop").boundingBox())!;
  expect(pop.x).toBeGreaterThanOrEqual(0);
  expect(pop.x + pop.width).toBeLessThanOrEqual(390);
  expect(pop.y + pop.height).toBeLessThanOrEqual(844);
});
