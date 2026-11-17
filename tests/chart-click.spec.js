const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const LIB = fs.readFileSync(path.join(__dirname, "fixtures/lightweight-charts.js"));
const ART = "/opt/cursor/artifacts";

function buildCandles() {
  const start = Date.UTC(2026, 0, 1);
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const mid = 100000 + Math.sin(i / 6) * 1500;
    const open = mid;
    const close = mid + Math.cos(i / 4) * 180;
    const high = Math.max(open, close) + 80;
    const low = Math.min(open, close) - 80;
    rows.push([String(start + i * 3600000), open.toFixed(1), high.toFixed(1), low.toFixed(1), close.toFixed(1), "12"]);
  }
  return rows.reverse();
}

function positions() {
  return {
    mark: 100000,
    accounts: [
      {
        name: "pupo", prefix: "pupo", eq: 1.2, mark: 100000, net: 8, side: "long", avg: 99500,
        stops: [97000],
        legs: [{ posSide: "long", ct: 8, avg: 99500, usd: 800 }],
        orders: [{ kind: "limit", price: 99000, ordId: "L1", side: "buy", sz: 1 }],
      },
      { name: "pai", prefix: "pai", eq: 0.8, mark: 100000, net: 0, stops: [], orders: [] },
      { name: "mãe", prefix: "mãe", eq: 0.5, mark: 100000, net: 0, stops: [], orders: [] },
      { name: "tcheco", prefix: "tcheco", eq: 0.4, mark: 100000, net: 0, stops: [], orders: [] },
    ],
  };
}

let posts = [];

async function installMocks(page) {
  await page.addInitScript(() => {
    localStorage.setItem("painel_token", "teste");
    localStorage.setItem("painel_tf", "1H");
    localStorage.setItem("painel_acct", "todas");
  });
  page.on("request", (req) => {
    const method = req.method();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") posts.push(method + " " + req.url());
  });
  await page.routeWebSocket(/okx\.com/, (ws) => {
    ws.onMessage((msg) => { if (msg === "ping") ws.send("pong"); });
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      posts.push(method + " " + url);
      await route.abort();
      return;
    }
    if (url.includes("unpkg.com/lightweight-charts")) {
      await route.fulfill({ contentType: "text/javascript", body: LIB });
      return;
    }
    if (url.includes("/api/v5/market/candles")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ code: "0", data: buildCandles() }) });
      return;
    }
    if (url.includes("/functions/v1/painel")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(positions()) });
      return;
    }
    await route.continue();
  });
}

async function boot(page) {
  await page.goto("/");
  await page.waitForFunction(() => {
    const chart = document.getElementById("chart");
    if (!chart || !window.__painel || !window.__painel.ready()) return false;
    const h = chart.clientHeight;
    return h > 100 && window.__painel.priceAt(Math.round(h * 0.4)) > 0 && window.__painel.yFor(99000) != null;
  });
}

async function revealChart(page) {
  await page.evaluate(() => {
    const el = document.getElementById("chart");
    const chrome = document.querySelector(".chrome");
    const h = chrome ? chrome.getBoundingClientRect().height : 0;
    const top = el.getBoundingClientRect().top + window.scrollY - h - 4;
    window.scrollTo(0, Math.max(0, top));
  });
}

async function pickSpot(page, avoid = []) {
  await revealChart(page);
  const box = await page.locator("#chart").boundingBox();
  if (!box || box.height < 80) throw new Error("gráfico sem tamanho");
  const ratios = [0.2, 0.28, 0.36, 0.46, 0.54, 0.62, 0.72, 0.8];
  for (const r of ratios) {
    const localY = Math.round(box.height * r);
    const info = await page.evaluate((y) => ({
      fmt: window.__painel.fmt(window.__painel.priceAt(y)),
      near: window.__painel.nearLine(y),
    }), localY);
    if (!info.fmt || info.near || avoid.includes(info.fmt)) continue;
    return { x: box.x + Math.round(box.width * 0.42), y: box.y + localY, localY, fmt: info.fmt };
  }
  throw new Error("nenhum ponto livre no gráfico");
}

async function clickChart(page, spot) {
  await page.mouse.click(spot.x, spot.y);
}

test.beforeEach(async ({ page }) => {
  posts = [];
  await installMocks(page);
});

test.afterEach(() => {
  expect(posts, "não pode haver POST").toEqual([]);
});

test("clique no gráfico preenche o preço limite", async ({ page }) => {
  await boot(page);
  await expect(page.locator("#d-kind")).toHaveValue("limit");
  await expect(page.locator("#chart-hint")).toHaveText("Clique no gráfico: preço");
  const spot = await pickSpot(page);
  await clickChart(page, spot);
  await expect(page.locator("#d-price")).toHaveValue(spot.fmt);
  await expect(page.locator("#price")).toHaveValue(spot.fmt);
  await expect(page.locator(".px-hit")).toHaveCount(1);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  fs.mkdirSync(ART, { recursive: true });
  await page.screenshot({ path: path.join(ART, "painel-desktop-1440.png") });
});

test("mercado preenche o stop", async ({ page }) => {
  await boot(page);
  const priceBefore = await page.locator("#price").inputValue();
  await page.locator("#d-kind").selectOption("market");
  await expect(page.locator("#chart-hint")).toHaveText("Clique no gráfico: stop");
  const spot = await pickSpot(page);
  await clickChart(page, spot);
  await expect(page.locator("#d-stop")).toHaveValue(spot.fmt);
  await expect(page.locator("#stop")).toHaveValue(spot.fmt);
  await expect(page.locator("#price")).toHaveValue(priceBefore);
  await expect(page.locator("#amend-sheet")).toBeHidden();
});

test("escala: dois cliques preenchem de e até, o terceiro volta para de", async ({ page }) => {
  await boot(page);
  await page.locator("#d-kind").selectOption("scale");
  await expect(page.locator("#chart-hint")).toHaveText("Clique no gráfico: de");
  const a = await pickSpot(page);
  await clickChart(page, a);
  await expect(page.locator("#d-from")).toHaveValue(a.fmt);
  await expect(page.locator("#m-from")).toHaveValue(a.fmt);
  await expect(page.locator("#chart-hint")).toHaveText("Clique no gráfico: até");
  const b = await pickSpot(page, [a.fmt]);
  await clickChart(page, b);
  await expect(page.locator("#d-to")).toHaveValue(b.fmt);
  await expect(page.locator("#m-to")).toHaveValue(b.fmt);
  await expect(page.locator("#d-from")).toHaveValue(a.fmt);
  const c = await pickSpot(page, [a.fmt, b.fmt]);
  await clickChart(page, c);
  await expect(page.locator("#d-from")).toHaveValue(c.fmt);
  await expect(page.locator("#d-to")).toHaveValue(b.fmt);
});

test("foco no stop recebe o clique", async ({ page }) => {
  await boot(page);
  await page.fill("#d-price", "100000");
  await page.locator("#d-stop").focus();
  await expect(page.locator("#chart-hint")).toHaveText("Clique no gráfico: stop");
  const spot = await pickSpot(page, ["100000.0"]);
  await clickChart(page, spot);
  await expect(page.locator("#d-stop")).toHaveValue(spot.fmt);
  await expect(page.locator("#d-price")).toHaveValue("100000");
});

test("arrastar a prévia muda o preço e o tamanho, sem enviar ordem", async ({ page }) => {
  await boot(page);
  await page.fill("#d-stop", "97000");
  await page.fill("#d-price", "100000");
  await expect(page.locator("#d-size")).not.toHaveText("—");
  const sizeBefore = await page.locator("#d-size").innerText();
  await revealChart(page);
  const box = await page.locator("#chart").boundingBox();
  const y0 = await page.evaluate(() => window.__painel.yFor(100000));
  expect(y0).toBeGreaterThan(10);
  const x = box.x + Math.round(box.width * 0.42);
  await page.mouse.move(x, box.y + y0);
  await expect(page.locator("#chart")).toHaveClass(/line-hover/);
  const cursor = await page.evaluate(() => getComputedStyle(document.querySelector("#chart canvas")).cursor);
  expect(cursor).toBe("ns-resize");
  const dy = y0 < box.height * 0.55 ? 90 : -90;
  await page.mouse.down();
  await page.mouse.move(x, box.y + y0 + dy, { steps: 12 });
  await page.mouse.up();
  const expected = await page.evaluate((y) => window.__painel.fmt(window.__painel.priceAt(y)), y0 + dy);
  await expect(page.locator("#d-price")).toHaveValue(expected);
  await expect(page.locator("#price")).toHaveValue(expected);
  expect(expected).not.toBe("100000");
  await expect(page.locator("#d-size")).not.toHaveText(sizeBefore);
  await expect(page.locator("#amend-sheet")).toBeHidden();
});

test("arrastar ordem aberta abre a confirmação e um clique na linha não preenche", async ({ page }) => {
  await boot(page);
  await page.fill("#d-price", "100000");
  await revealChart(page);
  const box = await page.locator("#chart").boundingBox();
  const y = await page.evaluate(() => window.__painel.yFor(99000));
  expect(y).toBeGreaterThan(8);
  expect(y).toBeLessThan(box.height - 8);
  const x = box.x + Math.round(box.width * 0.4);
  await page.mouse.click(x, box.y + y);
  await expect(page.locator("#amend-sheet")).toBeHidden();
  await expect(page.locator("#d-price")).toHaveValue("100000");
  const dy = y > box.height * 0.72 ? -80 : 80;
  await page.mouse.move(x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(x, box.y + y + dy, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator("#amend-sheet")).toBeVisible();
  await expect(page.locator("#amend-move")).toContainText("→");
  await expect(page.locator("#d-price")).toHaveValue("100000");
});

test("pan e zoom não preenchem o preço", async ({ page }) => {
  await boot(page);
  await page.fill("#d-price", "100000");
  const spot = await pickSpot(page);
  const before = await page.evaluate(() => window.__painel.range());
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.move(spot.x + 180, spot.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator("#d-price")).toHaveValue("100000");
  const after = await page.evaluate(() => window.__painel.range());
  expect(after.from).not.toBeCloseTo(before.from, 1);
  await page.mouse.move(spot.x, spot.y);
  const zoomBefore = await page.evaluate(() => window.__painel.range());
  await page.mouse.wheel(0, -400);
  const zoomAfter = await page.evaluate(() => window.__painel.range());
  const width = (r) => r.to - r.from;
  expect(width(zoomAfter)).not.toBeCloseTo(width(zoomBefore), 1);
  await expect(page.locator("#d-price")).toHaveValue("100000");
});

test("toque no celular preenche o limite; pan e pinça não preenchem", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await installMocks(page);
  await boot(page);
  await expect(page.locator("#chart-hint")).toHaveText("Toque no gráfico: stop");
  await page.locator("#btn-limit").click();
  await expect(page.locator("#chart-hint")).toHaveText("Toque no gráfico: preço");
  await revealChart(page);
  const spot = await pickSpot(page);
  await page.touchscreen.tap(spot.x, spot.y);
  await expect(page.locator("#price")).toHaveValue(spot.fmt);
  const kept = await page.locator("#price").inputValue();
  const pan = await pickSpot(page, [kept]);
  await page.mouse.move(pan.x, pan.y);
  await page.mouse.down();
  await page.mouse.move(pan.x + 90, pan.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator("#price")).toHaveValue(kept);
  const box = await page.locator("#chart").boundingBox();
  await page.evaluate(({ x, y }) => {
    const el = document.getElementById("chart");
    const fire = (type, id, cx, cy) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: id, pointerType: "touch",
      clientX: cx, clientY: cy, button: 0, buttons: type === "pointerup" ? 0 : 1,
    }));
    fire("pointerdown", 7, x, y);
    fire("pointerdown", 8, x + 28, y + 10);
    fire("pointerup", 7, x, y);
    fire("pointerup", 8, x + 28, y + 10);
  }, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.45 });
  await expect(page.locator("#price")).toHaveValue(kept);
  fs.mkdirSync(ART, { recursive: true });
  await page.screenshot({ path: path.join(ART, "painel-mobile-390.png"), fullPage: true });
  await context.close();
});
