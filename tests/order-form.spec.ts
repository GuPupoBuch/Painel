import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

type Body = Record<string, unknown>;
type Call = { method: string; path: string; body: Body | Body[] | null };

async function resetMock() {
  await fetch("http://127.0.0.1:8788/__reset");
}
async function okxPosts(path: string): Promise<Body[]> {
  const all = (await fetch("http://127.0.0.1:8788/__calls").then((r) => r.json())) as Call[];
  return all.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body as Body);
}

async function desk(page: Page) {
  return page.locator("#d-kind").isVisible();
}
async function login(page: Page) {
  await page.goto("/index.html?api=http://127.0.0.1:8000");
  if (await page.locator("#password").isVisible()) {
    await page.fill("#password", "teste");
    await page.click("#login-btn");
  }
  await page.waitForFunction(() => document.documentElement.classList.contains("in-app"));
  if (page.viewportSize()!.width >= 1024) await page.waitForSelector("#d-kind", { state: "visible" });
  else await page.waitForSelector("#m-kind", { state: "visible" });
  await expect(page.locator("body")).toContainText("pupo", { timeout: 15000 });
}
async function setKind(page: Page, kind: string) {
  await page.selectOption(await desk(page) ? "#d-kind" : "#m-kind", kind);
}
async function setSize(page: Page, mode: "usd" | "pct" | "risco", value?: string) {
  const root = (await desk(page)) ? "#d-size-modes" : "#m-size-modes";
  await page.click(`${root} button[data-size="${mode}"]`);
  if (mode !== "risco" && value != null) await page.fill((await desk(page)) ? "#d-qty" : "#m-qty", value);
}
async function setReduce(page: Page, on: boolean) {
  const id = (await desk(page)) ? "#d-reduce-toggle" : "#m-reduce-toggle";
  const pressed = await page.getAttribute(id, "aria-pressed");
  if ((pressed === "true") !== on) await page.locator(id).click();
  await expect(page.locator(id)).toHaveAttribute("aria-pressed", on ? "true" : "false");
}
async function setPrice(page: Page, value: string) {
  await page.fill((await desk(page)) ? "#d-price" : "#price", value);
}
async function clickSide(page: Page, side: "long" | "short", path: string) {
  const wait = page.waitForResponse((r) => r.url().includes(":8000" + path) && r.request().method() === "POST");
  if (await desk(page)) await page.click(side === "long" ? "#d-long" : "#d-short");
  else {
    await page.click(side === "long" ? "#btn-long" : "#btn-short");
    await page.click("#send");
  }
  if (path === "/scale" || path === "/hedge") {
    await page.waitForSelector("#scale-sheet:not(.hidden)");
    await page.click("#scale-ok");
  }
  const res = await wait;
  expect(res.ok()).toBeTruthy();
}

function every(bodies: Body[], pred: (b: Body) => boolean, label: string) {
  expect(bodies.length, label).toBeGreaterThan(0);
  for (const b of bodies) expect(pred(b), label + " " + JSON.stringify(b)).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.addInitScript(() => sessionStorage.removeItem("painel_reduce"));
  await login(page);
});

test("limite abre e reduz a perna oposta", async ({ page }) => {
  await setKind(page, "limit");
  await setSize(page, "usd", "400");
  await setReduce(page, false);
  await setPrice(page, "63000");
  await clickSide(page, "long", "/order");
  let orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.ordType === "limit" && b.side === "buy" && b.posSide === "long" && b.px === "63000" && b.sz === "1.0" && !b.reduceOnly, "limite aberto");
  expect(orders).toHaveLength(4);

  await resetMock();
  await setSize(page, "pct", "50");
  await setReduce(page, true);
  await setPrice(page, "65000");
  await clickSide(page, "short", "/order");
  orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.ordType === "limit" && b.side === "sell" && b.posSide === "long" && b.reduceOnly === true && b.px === "65000" && b.sz === "1.0", "short reduz a long");
});

test("mercado abre e o botão long reduz a short", async ({ page }) => {
  await setKind(page, "market");
  await setSize(page, "usd", "400");
  await setReduce(page, false);
  await clickSide(page, "long", "/order");
  let orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.ordType === "market" && b.side === "buy" && b.posSide === "long" && b.sz === "1.0" && !b.reduceOnly && !b.px, "mercado aberto");

  await resetMock();
  await setSize(page, "pct", "50");
  await setReduce(page, true);
  await clickSide(page, "long", "/order");
  orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.ordType === "market" && b.side === "buy" && b.posSide === "short" && b.reduceOnly === true && b.sz === "0.5" && !b.px, "long reduz a short");
});

test("stop a mercado manda trigger com orderPx -1", async ({ page }) => {
  await setKind(page, "trigger");
  await setSize(page, "usd", "400");
  await setReduce(page, false);
  await page.fill((await desk(page)) ? "#d-trigger" : "#m-trigger", "63000");
  await clickSide(page, "long", "/order");
  let algos = await okxPosts("/api/v5/trade/order-algo");
  every(algos, (b) => b.ordType === "trigger" && b.orderPx === "-1" && b.triggerPx === "63000" && b.triggerPxType === "last" && b.side === "buy" && b.posSide === "long" && b.sz === "1.0" && !b.reduceOnly, "trigger aberto");
  expect(await okxPosts("/api/v5/trade/order")).toHaveLength(0);

  await resetMock();
  await setSize(page, "pct", "50");
  await setReduce(page, true);
  await page.fill((await desk(page)) ? "#d-trigger" : "#m-trigger", "61000");
  await clickSide(page, "short", "/order");
  algos = await okxPosts("/api/v5/trade/order-algo");
  every(algos, (b) => b.ordType === "trigger" && b.orderPx === "-1" && b.triggerPx === "61000" && b.side === "sell" && b.posSide === "long" && b.reduceOnly === true && b.sz === "1.0", "trigger reduz a long");
});

test("chase limite segue o book e aparece com cancelar", async ({ page }) => {
  await setKind(page, "chase");
  await setSize(page, "usd", "400");
  await setReduce(page, false);
  await page.fill((await desk(page)) ? "#d-chase" : "#m-chase", "5");
  await clickSide(page, "long", "/order");
  let algos = await okxPosts("/api/v5/trade/order-algo");
  every(algos, (b) => b.ordType === "chase" && b.chaseType === "distance" && b.chaseVal === "0" && b.maxChaseType === "ratio" && b.maxChaseVal === "0.05" && b.side === "buy" && b.posSide === "long" && b.sz === "1.0" && !b.reduceOnly, "chase aberto");

  await expect(page.locator("body")).toContainText("Chase");
  await resetMock();
  const cancel = page.waitForResponse((r) => r.url().includes(":8000/cancel"));
  await page.locator("[data-cancel-algo]").first().click();
  await cancel;
  const raw = (await fetch("http://127.0.0.1:8788/__calls").then((r) => r.json())) as { method: string; path: string; body: { algoId: string }[] }[];
  const gone = raw.filter((c) => c.method === "POST" && c.path === "/api/v5/trade/cancel-algos");
  expect(gone).toHaveLength(1);
  expect(gone[0].body[0].algoId).toMatch(/^algo-/);

  await resetMock();
  await page.fill((await desk(page)) ? "#d-chase" : "#m-chase", "");
  await setSize(page, "pct", "50");
  await setReduce(page, true);
  await clickSide(page, "short", "/order");
  algos = await okxPosts("/api/v5/trade/order-algo");
  every(algos, (b) => b.ordType === "chase" && b.chaseVal === "0" && b.side === "sell" && b.posSide === "long" && b.reduceOnly === true && !b.maxChaseType, "chase reduz a long");
});

test("escala com e sem reduce, hedge esconde o toggle", async ({ page }) => {
  await setKind(page, "scale");
  await setReduce(page, false);
  await setSize(page, "risco");
  const wide = await desk(page);
  await page.fill(wide ? "#d-from" : "#m-from", "62000");
  await page.fill(wide ? "#d-to" : "#m-to", "63000");
  if (wide) await page.locator("input#d-orders").fill("2");
  else await page.fill("#m-orders", "2");
  await page.fill(wide ? "#d-stop" : "#stop", "60000");
  await clickSide(page, "long", "/scale");
  let batch = await okxPosts("/api/v5/trade/batch-orders");
  expect(batch.length).toBeGreaterThan(0);
  for (const chunk of batch) {
    const rows = chunk as unknown as Body[];
    expect(Array.isArray(rows)).toBeTruthy();
    for (const b of rows) expect(b.ordType === "limit" && b.posSide === "long" && b.side === "buy" && !b.reduceOnly).toBeTruthy();
  }

  await resetMock();
  await setSize(page, "pct", "50");
  await setReduce(page, true);
  await page.fill(wide ? "#d-from" : "#m-from", "65000");
  await page.fill(wide ? "#d-to" : "#m-to", "66000");
  await clickSide(page, "short", "/scale");
  batch = await okxPosts("/api/v5/trade/batch-orders");
  for (const chunk of batch) {
    for (const b of chunk as unknown as Body[]) expect(b.reduceOnly === true && b.posSide === "long" && b.side === "sell").toBeTruthy();
  }

  await setKind(page, "hedge");
  await expect(page.locator(wide ? "#d-reduce-toggle" : "#m-reduce-toggle")).toBeHidden();
  await resetMock();
  if (wide) await page.click("#d-hedge-go");
  else await page.click("#send");
  await page.waitForSelector("#scale-sheet:not(.hidden)");
  const hedge = page.waitForResponse((r) => r.url().includes(":8000/hedge"));
  await page.click("#scale-ok");
  expect((await hedge).ok()).toBeTruthy();
  const orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.posSide === "short" && b.side === "sell" && !b.reduceOnly, "hedge vende short");
});

test("reduce fica ligado na sessão", async ({ page }) => {
  await setKind(page, "limit");
  await setReduce(page, true);
  await page.addInitScript(() => sessionStorage.setItem("painel_reduce", "1"));
  await page.reload();
  await page.waitForFunction(() => document.documentElement.classList.contains("in-app"));
  const id = (await desk(page)) ? "#d-reduce-toggle" : "#m-reduce-toggle";
  await expect(page.locator(id)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(id)).toHaveClass(/on/);
});

test("ajustar escolhe a perna quando as duas estão abertas", async ({ page }) => {
  await page.click("#d-tabs [data-tab=reduce]");
  await expect(page.locator("#d-adj-leg-note")).toHaveText("Escolha long ou short.");
  await expect(page.locator("#d-adj-leg [data-leg=long]")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#d-adj-leg [data-leg=short]")).toHaveAttribute("aria-pressed", "false");
  await page.click("#d-adj-preview");
  await expect(page.locator("#adj-banner-err")).toHaveText("Escolha long ou short.");
  expect(await okxPosts("/api/v5/trade/order")).toHaveLength(0);

  await page.click("#d-adj-leg [data-leg=long]");
  await page.click("#d-adj-preview");
  await expect(page.locator("#d-adj-send")).toBeEnabled();
  const sent = page.waitForResponse((r) => r.url().includes(":8000/adjust") && r.request().postData()?.includes('"dry":false'));
  await page.click("#d-adj-send");
  expect((await sent).ok()).toBeTruthy();
  let orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.posSide === "long" && b.side === "sell" && b.reduceOnly === true && b.ordType === "market" && b.sz === "1.0", "ajuste long");

  await resetMock();
  await page.click("#d-adj-leg [data-leg=short]");
  await page.click("#d-adj-preview");
  const sentShort = page.waitForResponse((r) => r.url().includes(":8000/adjust") && r.request().postData()?.includes('"dry":false'));
  await page.click("#d-adj-send");
  expect((await sentShort).ok()).toBeTruthy();
  orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.posSide === "short" && b.side === "buy" && b.reduceOnly === true && b.sz === "0.5", "ajuste short");
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-desktop-1440-ajustar.png", fullPage: false });
});

test("screenshots desktop e o arquivo guarda o reduce verde", async ({ page }) => {
  await setKind(page, "limit");
  await setSize(page, "pct", "50");
  await setPrice(page, "64000");
  await setReduce(page, false);
  await expect(page.locator("#d-qty-k")).toHaveText("% do saldo");
  await expect(page.locator("#d-size-note")).toContainText("saldo disponível");
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-desktop-1440-off.png", fullPage: false });
  await setReduce(page, true);
  await expect(page.locator("#d-qty-k")).toHaveText("% da perna");
  await expect(page.locator("#d-size-note")).toContainText("% da perna");
  await expect(page.locator("#d-pnl")).toContainText("SHORT PNL (botão LONG)");
  await expect(page.locator("#d-pnl")).toContainText("2 ct");
  await expect(page.locator("#d-pnl")).toContainText("LONG PNL (botão SHORT)");
  await expect(page.locator("#d-pnl")).toContainText("4 ct");
  await expect(page.locator("#d-pnl-acc")).toBeHidden();
  await expect(page.locator("#d-long .go-sub")).toHaveText("2 @ 64.000");
  await expect(page.locator("#d-short .go-sub")).toHaveText("4 @ 64.000");
  const box = await page.locator("#d-long").boundingBox();
  const vp = page.viewportSize();
  expect(box && box.y >= 0 && box.y + box.height <= vp.height).toBeTruthy();
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-desktop-1440.png", fullPage: false });
});
