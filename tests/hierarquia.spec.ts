import { expect, test, type Page } from "@playwright/test";

type ScalePlan = {
  avg: number;
  legs: { price: number; per: { sz: { ct: number } | null }[] }[];
} | null;

async function login(page: Page) {
  await page.goto("/index.html?api=http://127.0.0.1:8000");
  if (await page.locator("#password").isVisible()) {
    await page.fill("#password", "teste");
    await page.click("#login-btn");
  }
  await page.waitForFunction(() => document.documentElement.classList.contains("in-app"));
  await expect(page.locator("body")).toContainText("pupo", { timeout: 15000 });
}

test("grupos no desktop e a escala de hedge no gráfico", async ({ page }) => {
  await login(page);
  await page.click("#d-groups [data-group=limite]");
  await expect(page.locator("#d-groups [data-group=limite]")).toHaveClass(/on/);
  await expect(page.locator("#d-kind")).toHaveValue("limit");
  await expect(page.locator("#d-size-modes [data-size=usd]")).toHaveClass(/on/);
  await page.screenshot({ path: "/opt/cursor/artifacts/hier-limite-1440.png" });

  await page.click("#d-groups [data-group=mercado]");
  await expect(page.locator("#d-kind")).toHaveValue("market");
  await page.screenshot({ path: "/opt/cursor/artifacts/hier-mercado-1440.png" });

  await page.click("#d-groups [data-group=hedge]");
  await expect(page.locator("#d-hedge-now")).toContainText("Vendido agora");
  await page.screenshot({ path: "/opt/cursor/artifacts/hier-hedge-1440.png" });

  await page.selectOption("#d-kind", "hedge-scale");
  await page.fill("#d-from", "63400");
  await page.fill("#d-to", "64100");
  await page.locator("input#d-orders").fill("4");
  await page.fill("#d-hedge-pct", "40");
  const ladder = await page.evaluate(() => (window as unknown as { __painel: { hedgeLadder: () => { legs: { pct: number; ct: number }[] } } }).__painel.hedgeLadder());
  expect(ladder.legs).toHaveLength(4);
  expect(ladder.legs[3].pct).toBeGreaterThan(ladder.legs[1].pct);
  expect(ladder.legs[1].pct).toBeGreaterThan(ladder.legs[0].pct);
  expect(ladder.legs[3].pct).toBeGreaterThan(38);
  expect(ladder.legs[3].pct).toBeLessThan(42);
  await page.screenshot({ path: "/opt/cursor/artifacts/hier-hedge-escala-1440.png" });

  await page.selectOption("#d-kind", "scale");
  await page.click("#d-size-modes [data-size=risco]");
  await expect(page.locator("#d-size-even")).toHaveClass(/on/);
  await page.fill("#d-from", "63000");
  await page.fill("#d-to", "64000");
  await page.locator("input#d-orders").fill("4");
  await page.fill("#d-stop", "60000");
  await page.fill("#d-risk", "1");
  const plan = await page.evaluate(() => (window as unknown as { __painel: { scalePlan: () => ScalePlan } }).__painel.scalePlan());
  expect(plan).toBeTruthy();
  const perLeg = plan!.legs.map((l) => l.per.map((r) => (r.sz ? r.sz.ct : 0)));
  for (const row of perLeg) expect(row.every((ct) => ct === row[0] && ct >= 0.1)).toBeTruthy();
  const cts = perLeg.map((row) => row[0]);
  expect(cts.slice(0, -1).every((ct) => ct === cts[0])).toBeTruthy();
  expect(cts[cts.length - 1]).toBeGreaterThanOrEqual(cts[0]);
  const mid = (63000 + 64000) / 2;
  expect(Math.abs(plan!.avg - mid)).toBeLessThan(mid * 0.01);
  const loss = plan!.legs.reduce((s, l) => s + l.per.reduce((a, r) => a + ((r.sz?.ct || 0) * 100 * Math.abs(1 / l.price - 1 / 60000)), 0), 0);
  const atAvg = plan!.legs.reduce((s, l) => s + l.per.reduce((a, r) => a + (r.sz?.ct || 0), 0), 0) * 100 * Math.abs(1 / plan!.avg - 1 / 60000);
  expect(loss).toBeLessThanOrEqual(4 * 0.01 + 1e-6);
  expect(Math.abs(loss - atAvg)).toBeLessThan(atAvg * 0.08);
});

test.describe("grupos no celular", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("limite, mercado, hedge e a escala", async ({ page }) => {
    await login(page);
    await page.waitForFunction(() => (window as unknown as { __painel: { ready: () => boolean } }).__painel.ready());
    await page.click("#m-groups [data-group=limite]");
    await expect(page.locator("#m-kind")).toHaveValue("limit");
    await page.screenshot({ path: "/opt/cursor/artifacts/hier-limite-390.png" });
    await page.click("#m-groups [data-group=mercado]");
    await expect(page.locator("#m-kind")).toHaveValue("market");
    await page.screenshot({ path: "/opt/cursor/artifacts/hier-mercado-390.png" });
    await page.click("#m-groups [data-group=hedge]");
    await expect(page.locator("#m-hedge-now")).toContainText("Vendido agora");
    await page.screenshot({ path: "/opt/cursor/artifacts/hier-hedge-390.png" });
    await page.selectOption("#m-kind", "hedge-scale");
    await page.fill("#m-hedge-pct", "40");
    const band = await page.evaluate(() => {
      const h = document.querySelector("#chart")!.getBoundingClientRect().height;
      const p = (window as unknown as { __painel: { priceAt: (y: number) => number; fmt: (n: number) => string } }).__painel;
      return { lo: p.fmt(p.priceAt(Math.round(h * 0.78))), hi: p.fmt(p.priceAt(Math.round(h * 0.22))) };
    });
    await page.fill("#m-from", band.lo);
    await page.fill("#m-to", band.hi);
    await page.fill("#m-orders", "4");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => {
      const api = (window as unknown as { __painel: { hedgeLadder: () => { legs: { price: number }[] }; yFor: (n: number) => number } }).__painel;
      const ladder = api.hedgeLadder();
      return !!ladder && ladder.legs.length === 4 && ladder.legs.every((l) => api.yFor(l.price) != null);
    });
    await page.screenshot({ path: "/opt/cursor/artifacts/hier-hedge-escala-390.png" });
  });
});
