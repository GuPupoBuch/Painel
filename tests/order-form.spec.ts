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

// Preço atual fixo em 64.000 (o mesmo do mock): sem isso o teste dependia do BTC real pelo WebSocket da OKX,
// e a trava "limite acima = venda, abaixo = compra" mudaria com o mercado.
const TEST_MARK = "64000";
test.beforeEach(async ({ page }) => {
  await resetMock();
  await page.routeWebSocket(/wss:\/\/ws\.okx\.com/, (ws) => {
    ws.onMessage((msg) => {
      if (msg === "ping") { ws.send("pong"); return; }
      try {
        const j = JSON.parse(String(msg));
        if (j.op !== "subscribe") return;
        for (const a of j.args || []) {
          if (a.channel === "mark-price") ws.send(JSON.stringify({ arg: a, data: [{ instId: a.instId, markPx: TEST_MARK }] }));
        }
      } catch { /* mensagem que não é JSON */ }
    });
  });
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
  // o % só aparece com o Reduce ligado
  await setReduce(page, true);
  await setSize(page, "pct", "50");
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
  // o % só aparece com o Reduce ligado
  await setReduce(page, true);
  await setSize(page, "pct", "50");
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
  // o % só aparece com o Reduce ligado
  await setReduce(page, true);
  await setSize(page, "pct", "50");
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
  // o % só aparece com o Reduce ligado
  await setReduce(page, true);
  await setSize(page, "pct", "50");
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
  // o % só aparece com o Reduce ligado
  await setReduce(page, true);
  await setSize(page, "pct", "50");
  await page.fill(wide ? "#d-from" : "#m-from", "65000");
  await page.fill(wide ? "#d-to" : "#m-to", "66000");
  await clickSide(page, "short", "/scale");
  batch = await okxPosts("/api/v5/trade/batch-orders");
  for (const chunk of batch) {
    for (const b of chunk as unknown as Body[]) expect(b.reduceOnly === true && b.posSide === "long" && b.side === "sell").toBeTruthy();
  }

  await setKind(page, "hedge");
  await expect(page.locator(wide ? "#d-reduce-toggle" : "#m-reduce-toggle")).toBeVisible();
  await setReduce(page, false);
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

test("escala long sem perna manda o stop anexado", async ({ page }) => {
  await fetch("http://127.0.0.1:8788/__legs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ long: "0", short: "1" }),
  });
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
  const batch = await okxPosts("/api/v5/trade/batch-orders");
  expect(batch.length).toBeGreaterThan(0);
  for (const chunk of batch) {
    const rows = chunk as unknown as Body[];
    expect(rows.length).toBeGreaterThan(0);
    for (const b of rows) {
      const sl = (b.attachAlgoOrds as Body[] | undefined)?.[0];
      expect(sl && sl.slTriggerPx === "60000" && sl.slOrdPx === "-1" && sl.slTriggerPxType === "mark", JSON.stringify(b)).toBeTruthy();
      expect(b.posSide === "long" && b.side === "buy" && !b.reduceOnly).toBeTruthy();
    }
  }
  expect(await okxPosts("/api/v5/trade/order-algo")).toHaveLength(0);
  expect(await okxPosts("/api/v5/trade/cancel-batch-orders")).toHaveLength(0);
});

test("escala de 10 pernas: compra abaixo do mark entra; acima do máximo não", async ({ page }) => {
  const wide = await desk(page);
  expect(wide).toBeTruthy();
  await fetch("http://127.0.0.1:8788/__band", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ buyLmt: "64099.5", sellLmt: "63461.4" }),
  });
  await setKind(page, "scale");
  await setReduce(page, false);
  await setSize(page, "risco");
  await page.fill("#d-from", "62710.5");
  await page.fill("#d-to", "62425");
  await page.locator("input#d-orders").fill("10");
  // tamanho: 60% mais valor em cima (pernas de preço mais alto maiores)
  await page.locator("#d-skew-size").fill("60");
  await expect(page.locator("#d-skew-size-v")).toHaveText("60% em cima");
  await page.fill("#d-stop", "60000");
  await page.fill("#d-risk", "1");
  const deepWait = page.waitForResponse((r) => r.url().includes(":8000/scale") && r.request().method() === "POST");
  await page.click("#d-long");
  await page.waitForSelector("#scale-sheet:not(.hidden)");
  await page.click("#scale-ok");
  const deepRes = await deepWait;
  const deep = await deepRes.json();
  expect(deep.aborted, String(deep.abort_msg || "")).toBeFalsy();
  const deepBody = deepRes.request().postData() || "";
  expect(deepBody).toContain('"sizeMode":"risk"');
  const deepBatches = await okxPosts("/api/v5/trade/batch-orders");
  expect(deepBatches.length).toBeGreaterThan(0);
  for (const chunk of deepBatches) {
    const rows = chunk as unknown as Body[];
    expect(rows.some((b) => parseFloat(String(b.px)) <= 62710.5 && b.side === "buy" && b.posSide === "long")).toBeTruthy();
  }

  await resetMock();
  await fetch("http://127.0.0.1:8788/__band", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ buyLmt: "64099.5", sellLmt: "63461.4" }),
  });
  // escala acima do preço atual (64.000) é venda: o LONG trava e nada sai
  await page.fill("#d-from", "65000");
  await page.fill("#d-to", "66000");
  await expect(page.locator("#d-long")).toBeDisabled();
  await expect(page.locator("#d-long .go-sub")).toHaveText("acima do preço: venda");
  await expect(page.locator("#d-short")).toBeEnabled();
  // escala que cruza o preço atual trava os dois lados
  await page.fill("#d-from", "63000");
  await page.fill("#d-to", "65000");
  await expect(page.locator("#d-long")).toBeDisabled();
  await expect(page.locator("#d-short")).toBeDisabled();
  expect(await okxPosts("/api/v5/trade/batch-orders")).toHaveLength(0);

  await resetMock();
  await fetch("http://127.0.0.1:8788/__failmsg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg: "Order price is not within the price limit" }),
  });
  await page.fill("#d-from", "63500");
  await page.fill("#d-to", "63800");
  const refusedWait = page.waitForResponse((r) => r.url().includes(":8000/scale") && r.request().method() === "POST");
  await page.click("#d-long");
  await page.click("#scale-ok");
  expect((await refusedWait).ok()).toBeTruthy();
  await expect(page.locator("#scale-msg")).toContainText("pupo:");
  await expect(page.locator("#scale-msg")).toContainText("51006");
  await expect(page.locator("#scale-msg")).toContainText("not within the price limit");

  await page.click("#scale-cancel");
  await resetMock();
  await setSize(page, "usd", "10000");
  await page.fill("#d-from", "63500");
  await page.fill("#d-to", "63800");
  const usdWait = page.waitForResponse((r) => r.url().includes(":8000/scale") && r.request().method() === "POST");
  await page.click("#d-long");
  await page.click("#scale-ok");
  const usdRes = await usdWait;
  const usdJson = await usdRes.json();
  const usdBody = JSON.parse(usdRes.request().postData() || "{}");
  expect(usdRes.ok()).toBeTruthy();
  expect(usdJson.aborted, String(usdJson.abort_msg || "")).toBeFalsy();
  expect(usdBody.sizeMode).toBe("usd");
  expect(usdBody.usd).toBe(10000);
  expect(usdBody.n).toBe(10);
  expect(usdBody.sizeSkew).toBe(0.6);
  expect(usdBody.priceSkew).toBe(0);
  expect(usdBody.side).toBe("long");
  const batches = await okxPosts("/api/v5/trade/batch-orders");
  expect(batches.length).toBeGreaterThan(0);
  for (const chunk of batches) {
    const rows = chunk as unknown as Body[];
    expect(rows).toHaveLength(10);
    expect(parseFloat(String(rows[0].sz))).toBeLessThan(parseFloat(String(rows[9].sz)));
    for (const b of rows) expect(b.side === "buy" && b.posSide === "long" && !b.reduceOnly && b.ordType === "limit").toBeTruthy();
  }
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

test("ajustar: LONG reduz a short e SHORT reduz a long", async ({ page }) => {
  // sem a aba Ordem/Ajuste: o painel de ajuste abre pelo Tipo "Ajustar posição %"
  await page.click("#d-groups [data-group=mercado]");
  await page.selectOption("#d-kind", "market-adjust");
  await expect(page.locator("#d-adj-leg")).toHaveCount(0);
  await expect(page.locator("#d-adj-pct-k")).toHaveText("% da posição");
  await expect(page.locator("#d-adj-leg-note")).toHaveText("Escolha LONG ou SHORT. O percentual é % da posição.");
  await expect(page.locator("#d-adj-long")).toBeEnabled();
  await expect(page.locator("#d-adj-short")).toBeEnabled();
  await expect(page.locator("#d-adj-long")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#d-adj-short")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#d-adj-long .go-sub")).toHaveText(/^2 @ /);
  await expect(page.locator("#d-adj-short .go-sub")).toHaveText(/^4 @ /);
  await page.click("#d-adj-preview");
  await expect(page.locator("#adj-banner-err")).toHaveText("Escolha LONG ou SHORT.");
  expect(await okxPosts("/api/v5/trade/order")).toHaveLength(0);

  await page.hover("#d-adj-short");
  await expect(page.locator("#d-adj-short")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#d-adj-pnl")).toContainText("LONG PNL (botão SHORT)");
  await expect(page.locator("#d-adj-pnl")).toContainText("4 ct");
  await page.locator("#desk-order .d-body").evaluate((el) => { el.scrollTop = 0; });
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-desktop-1440-ajustar.png", fullPage: false });
  await page.click("#d-adj-preview");
  await expect(page.locator("#d-adj-send")).toBeEnabled();
  const sent = page.waitForResponse((r) => r.url().includes(":8000/adjust") && r.request().postData()?.includes('"dry":false'));
  await page.click("#d-adj-send");
  expect((await sent).ok()).toBeTruthy();
  let orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.posSide === "long" && b.side === "sell" && b.reduceOnly === true && b.ordType === "market" && b.sz === "1.0", "SHORT reduz a long");

  await resetMock();
  await page.hover("#d-adj-long");
  await expect(page.locator("#d-adj-long")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#d-adj-pnl")).toContainText("SHORT PNL (botão LONG)");
  await expect(page.locator("#d-adj-pnl")).toContainText("2 ct");
  await page.click("#d-adj-preview");
  const sentLong = page.waitForResponse((r) => r.url().includes(":8000/adjust") && r.request().postData()?.includes('"dry":false'));
  await page.click("#d-adj-send");
  expect((await sentLong).ok()).toBeTruthy();
  orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.posSide === "short" && b.side === "buy" && b.reduceOnly === true && b.sz === "0.5", "LONG reduz a short");
});

test("screenshots desktop e o arquivo guarda o reduce verde", async ({ page }) => {
  await setKind(page, "limit");
  await setPrice(page, "64000");
  await setReduce(page, false);
  // abrir posição: só USD ou Risco
  await expect(page.locator('#d-size-modes [data-size="pct"]')).toBeHidden();
  await expect(page.locator('#d-size-modes [data-size="usd"]')).toBeVisible();
  await expect(page.locator('#d-size-modes [data-size="risco"]')).toBeVisible();
  await setSize(page, "usd", "1000");
  await expect(page.locator("#d-qty-k")).toHaveText("Tamanho");
  await page.screenshot({ path: "/opt/cursor/artifacts/painel-desktop-1440-off.png", fullPage: false });
  // com Reduce o % volta, como % da posição; ao desligar o Reduce, o % some e fica USD
  await setReduce(page, true);
  await setSize(page, "pct", "50");
  await expect(page.locator("#d-qty-k")).toHaveText("% da posição");
  await expect(page.locator("#d-size-note")).toContainText("% da posição");
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

test("limite: acima do preço atual só vende, abaixo só compra; stop a mercado livre", async ({ page }) => {
  await setKind(page, "limit");
  await setReduce(page, false);
  await setSize(page, "usd", "400");
  const [L, S] = (await desk(page)) ? ["#d-long", "#d-short"] : ["#btn-long", "#btn-short"];
  await setPrice(page, "65000");
  await expect(page.locator(L)).toBeDisabled();
  await expect(page.locator(S)).toBeEnabled();
  await setPrice(page, "63000");
  await expect(page.locator(L)).toBeEnabled();
  await expect(page.locator(S)).toBeDisabled();
  await clickSide(page, "long", "/order");
  const orders = await okxPosts("/api/v5/trade/order");
  every(orders, (b) => b.ordType === "limit" && b.side === "buy" && b.px === "63000", "compra abaixo do preço atual");
  // stop a mercado: o lado é escolha sua, nos dois sentidos
  await setKind(page, "trigger");
  await page.fill((await desk(page)) ? "#d-trigger" : "#m-trigger", "65000");
  await expect(page.locator(L)).toBeEnabled();
  await expect(page.locator(S)).toBeEnabled();
});

test("setinha da posição: reduz só aquela conta, a limite / chase / mercado", async ({ page }) => {
  test.skip(!(await desk(page)), "só no desktop");
  const open = async (acc: string, side: string) => {
    await page.click(`.pos-act[data-pp-acc="${acc}"][data-pp-side="${side}"]`);
    await expect(page.locator("#pos-pop")).toBeVisible();
  };
  const send = async () => {
    const wait = page.waitForResponse((r) => r.url().includes(":8000/order") && r.request().method() === "POST");
    await page.click("#pp-go");
    const res = await wait;
    const json = await res.json();
    expect(json.aborted, String(json.abort_msg || "")).toBeFalsy();
    await expect(page.locator("#pos-pop")).toBeHidden();
    return JSON.parse(res.request().postData() || "{}");
  };

  // long da pupo, 50% a limite: venda abaixo do preço atual (64.000) trava; acima vai
  await open("pupo", "long");
  await expect(page.locator("#pp-size")).toContainText("1 de 2 ct");
  // % manual: 40% de 2 ct = 0,8 ct; fora de 1–100 trava; o atalho volta a preencher o campo
  await page.fill("#pp-pct", "40");
  await expect(page.locator("#pp-size")).toContainText("0,8 de 2 ct");
  await expect(page.locator("#pp-pcts .d-tog.on")).toHaveCount(0);
  await page.fill("#pp-pct", "150");
  await expect(page.locator("#pp-go")).toBeDisabled();
  await page.click('#pp-pcts [data-pp-pct="50"]');
  await expect(page.locator("#pp-pct")).toHaveValue("50");
  await page.click('#pp-types [data-pp-type="limit"]');
  await page.fill("#pp-price", "63000");
  await expect(page.locator("#pp-go")).toBeDisabled();
  await expect(page.locator("#pp-msg")).toContainText("acima do preço atual");
  await page.fill("#pp-price", "65000");
  await expect(page.locator("#pp-go")).toHaveText("Vender 50% a limite");
  const lim = await send();
  expect(lim).toMatchObject({ side: "long", reduce: true, ordType: "limit", price: 65000, contracts: { pupo: 1 } });
  const limOrders = (await okxPosts("/api/v5/trade/order")) as Body[];
  expect(limOrders).toHaveLength(1);
  expect(limOrders[0]).toMatchObject({ ordType: "limit", side: "sell", posSide: "long", sz: "1.0", px: "65000", reduceOnly: true });

  // short da pai, 100% chase
  await resetMock();
  await open("pai", "short");
  await page.click('#pp-pcts [data-pp-pct="100"]');
  await page.click('#pp-types [data-pp-type="chase"]');
  const ch = await send();
  expect(ch).toMatchObject({ side: "short", reduce: true, ordType: "chase", contracts: { pai: 1 } });
  const algos = (await okxPosts("/api/v5/trade/order-algo")) as Body[];
  expect(algos.some((b) => b.ordType === "chase" && b.side === "buy" && b.posSide === "short" && b.reduceOnly === true)).toBeTruthy();

  // Esc fecha sem enviar
  await resetMock();
  await open("tcheco", "long");
  await page.keyboard.press("Escape");
  await expect(page.locator("#pos-pop")).toBeHidden();
  expect(await okxPosts("/api/v5/trade/order")).toHaveLength(0);
});

test("sem Reduce não tem %; desligar o Reduce com % volta para USD", async ({ page }) => {
  await setKind(page, "limit");
  await setReduce(page, true);
  await setSize(page, "pct", "50");
  await setReduce(page, false);
  const root = (await desk(page)) ? "#d-size-modes" : "#m-size-modes";
  await expect(page.locator(`${root} [data-size="pct"]`)).toBeHidden();
  await expect(page.locator(`${root} [data-size="usd"]`)).toHaveClass(/on/);
});

test("carteira selecionada: info e ordem só dela; Todas manda para as 4", async ({ page }) => {
  const isDesk = await desk(page);
  const pick = async (acc: string) => {
    if (isDesk) await page.selectOption("#d-filter", acc);
    else await page.click(`#accts .chip[data-acct="${acc}"]`);
  };
  await setKind(page, "limit");
  await setReduce(page, false);
  await setSize(page, "usd", "400");
  await setPrice(page, "63000");

  await pick("pupo");
  if (isDesk) {
    await expect(page.locator("#d-size-rows")).toContainText("pupo");
    await expect(page.locator("#d-size-rows")).not.toContainText("tcheco");
    await expect(page.locator("#d-pos-body")).not.toContainText("tcheco");
  }
  await expect(page.locator(isDesk ? "#d-size-note" : "#m-size-note")).toContainText("carteira pupo");
  const wait = page.waitForResponse((r) => r.url().includes(":8000/order") && r.request().method() === "POST");
  await page.click(isDesk ? "#d-long" : "#send");
  const res = await wait;
  expect(JSON.parse(res.request().postData() || "{}").accounts).toEqual(["pupo"]);
  const one = (await fetch("http://127.0.0.1:8788/__calls").then((r) => r.json())) as { method: string; path: string; account: string; body: Body }[];
  const sent = one.filter((c) => c.method === "POST" && c.path === "/api/v5/trade/order");
  expect(sent.map((c) => c.account)).toEqual(["pupo"]);
  expect(sent[0].body.sz).toBe("4.0");

  await resetMock();
  await pick("todas");
  const waitAll = page.waitForResponse((r) => r.url().includes(":8000/order") && r.request().method() === "POST");
  await page.click(isDesk ? "#d-long" : "#send");
  const resAll = await waitAll;
  expect(JSON.parse(resAll.request().postData() || "{}").accounts).toBeUndefined();
  expect(await okxPosts("/api/v5/trade/order")).toHaveLength(4);
});

test("modo Hedge: etiquetas em % da carteira; Limite continua igual", async ({ page }) => {
  test.skip(!(await desk(page)), "só no desktop");
  await page.click('#d-groups [data-group="limite"]');
  const tags = () => page.locator("#line-tags .ltag").allTextContents();
  await expect.poll(async () => (await tags()).length).toBeGreaterThan(0);
  expect((await tags()).some((t) => t.includes("% da carteira"))).toBeFalsy();
  await page.click('#d-groups [data-group="hedge"]');
  // posição: % da carteira (4 ct short = US$ 400 sobre 4 BTC × 64.000 = 0,16%)
  await expect.poll(async () => (await tags()).find((t) => t.startsWith("▼ SHORT"))).toContain("0,2% da carteira");
  // stop reduce da short: tamanho em % e quanto fica vendido se pegar
  await expect.poll(async () => (await tags()).find((t) => t.includes("Stop · compra"))).toContain("→ 0% vendido");
  await page.click('#d-groups [data-group="limite"]');
  await expect.poll(async () => (await tags()).some((t) => t.includes("% da carteira"))).toBeFalsy();
});

test("tamanho: abrindo é USD ou Risco; com Reduce é USD ou % (Risco some)", async ({ page }) => {
  const root = (await desk(page)) ? "#d-size-modes" : "#m-size-modes";
  await setKind(page, "market");
  await setReduce(page, false);
  await expect(page.locator(`${root} [data-size="risco"]`)).toBeVisible();
  await expect(page.locator(`${root} [data-size="pct"]`)).toBeHidden();
  await page.click(`${root} [data-size="risco"]`);
  await expect(page.locator(`${root} [data-size="risco"]`)).toHaveClass(/on/);
  await setReduce(page, true);
  await expect(page.locator(`${root} [data-size="risco"]`)).toBeHidden();
  await expect(page.locator(`${root} [data-size="pct"]`)).toBeVisible();
  await setReduce(page, false);
  await expect(page.locator(`${root} [data-size="risco"]`)).toBeVisible();
});

test("ordem a limite com stop: stop vinculado aparece, ✕ cancela a ordem (e o vinculado sai junto)", async ({ page }) => {
  test.skip(!(await desk(page)), "só no desktop");
  // sem short aberto, a venda a limite nasce com o stop grudado (não soma na perna)
  await fetch("http://127.0.0.1:8788/__legs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ short: 0 }) });
  await page.selectOption("#d-filter", "pupo");
  await setKind(page, "limit");
  await setReduce(page, false);
  await setSize(page, "usd", "1000");
  await page.click("#d-tpsl-tog");
  await setPrice(page, "66300");
  await page.fill("#d-stop", "66860");
  await clickSide(page, "short", "/order");
  await expect(page.locator("#d-ord-body")).toContainText("Stop vinculado");
  // a etiqueta só aparece com o preço dentro da faixa visível do gráfico
  await page.evaluate("series.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 57000, maxValue: 71000 } }) })");
  const tags = page.locator("#line-tags .ltag");
  await expect(tags.filter({ hasText: "Stop vinculado" })).toHaveCount(1);
  const limitTag = tags.filter({ hasText: "Limite · venda" });
  await limitTag.locator(".t-x").click();
  await expect(page.locator("#cancel-sheet")).toBeVisible();
  await expect(page.locator("#cancel-list")).toContainText("66.300");
  const wait = page.waitForResponse((r) => r.url().includes(":8000/cancel") && r.request().method() === "POST");
  await page.click("#cancel-ok");
  const res = await wait;
  expect(JSON.parse(res.request().postData() || "{}")).toMatchObject({ account: "OKX" });
  await expect(page.locator("#cancel-sheet")).toBeHidden();
  await expect(page.locator("#d-ord-body")).not.toContainText("Stop vinculado");
  const cancels = await okxPosts("/api/v5/trade/cancel-order");
  expect(cancels).toHaveLength(1);
});

test("tamanho começa vazio e limpa ao trocar USD ↔ % (sem 1000% da posição)", async ({ page }) => {
  const isDesk = await desk(page);
  const qty = isDesk ? "#d-qty" : "#m-qty";
  await setKind(page, "limit");
  await setReduce(page, false);
  await expect(page.locator(qty)).toHaveValue("");
  await setSize(page, "usd", "1000");
  await setReduce(page, true);
  await setSize(page, "pct");
  await expect(page.locator(qty)).toHaveValue("");
  await page.fill(qty, "50");
  await setReduce(page, false);
  await expect(page.locator(qty)).toHaveValue("");
});
