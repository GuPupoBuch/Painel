import { __test } from "./index.ts";

const { setReq, reset, ctFromRisk, ctFromEquityPct, lossBtc, hedgeNumbers, realizedPnlBtc, allocateReduce, splitLots, runOrder, runReduce, runAdjust, runScale, runScaleReduce, runScaleAmount, runSized, runAlgo, runAmend, runCancel, runHedge, fetchPositions } = __test;

type Call = { P: string; m: string; p: string; body?: unknown };
let calls: Call[] = [];
let positions: Record<string, any[]> = {};
let algos: Record<string, any[]> = {};
let balances: Record<string, number> = {};
let failBatch = false;

function algo(posSide: string, id: string, px: string, cf = "1") {
  return { instId: "BTC-USD-SWAP", algoId: id, posSide, slTriggerPx: px, closeFraction: cf, ordType: "conditional" };
}
function leg(posSide: string, pos: string, avg = "64000", mark = "64100") {
  return { instId: "BTC-USD-SWAP", posSide, pos, avgPx: avg, markPx: mark, upl: "0.001" };
}

function install() {
  calls = [];
  setReq(async (P, m, p, body) => {
    calls.push({ P, m, p, body });
    if (p.startsWith("/api/v5/public/price-limit")) return { code: "0", data: [{ buyLmt: "200000", sellLmt: "1000", enabled: true }] };
    if (p.startsWith("/api/v5/public/mark-price")) return { code: "0", data: [{ markPx: "64100" }] };
    if (p.startsWith("/api/v5/account/balance")) return { code: "0", data: [{ details: [{ ccy: "BTC", eq: String(balances[P] ?? 1) }] }] };
    if (p.startsWith("/api/v5/account/positions")) return { code: "0", data: positions[P] ?? [] };
    if (p.startsWith("/api/v5/trade/orders-algo-pending")) return { code: "0", data: algos[P] ?? [] };
    if (p.startsWith("/api/v5/trade/orders-pending")) return { code: "0", data: [] };
    if (p === "/api/v5/trade/order" && m === "POST") return { code: "0", data: [{ sCode: "0", ordId: "ord-" + calls.length }] };
    if (p === "/api/v5/trade/order-algo" && m === "POST") return { code: "0", data: [{ sCode: "0", algoId: "new-algo" }] };
    if (p === "/api/v5/trade/amend-algos") return { code: "0", data: [{ sCode: "0" }] };
    if (p === "/api/v5/trade/amend-order") return { code: "0", data: [{ sCode: "0" }] };
    if (p === "/api/v5/trade/cancel-algos") return { code: "0", data: [{ sCode: "0" }] };
    if (p === "/api/v5/trade/cancel-batch-orders") return { code: "0", data: [] };
    if (p === "/api/v5/trade/batch-orders") {
      const rows = (body as any[]) || [];
      if (failBatch && P === "OKX") {
        return { code: "2", data: rows.map((_: unknown, i: number) => i === rows.length - 1 ? { sCode: "51008", sMsg: "falhou a perna", ordId: "" } : { sCode: "0", ordId: "b" + i }) };
      }
      return { code: "0", data: rows.map((_: unknown, i: number) => ({ sCode: "0", ordId: P + "-" + i })) };
    }
    return { code: "0", data: [] };
  });
}

const posts = () => calls.filter((c) => c.m === "POST");
const hit = (p: string, P?: string) => calls.filter((c) => c.p === p && (!P || c.P === P));

Deno.test("abre short com long já aberto", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
  positions = { OKX: [leg("long", "1")] };
  algos = { OKX: [algo("long", "sl-long", "62000"), algo("short", "sl-short", "66000")] };
  const r = await runOrder("short", 66000, 1, false, "limit", 65000);
  if (r.aborted) throw new Error(r.abort_msg);
  const order = hit("/api/v5/trade/order", "OKX").map((c) => c.body as any);
  if (!order.length || order[0].posSide !== "short" || order[0].side !== "sell") throw new Error("não abriu short: " + JSON.stringify(order[0]));
  if (!order[0].attachAlgoOrds) throw new Error("perna nova precisa nascer com stop");
  const cancel = hit("/api/v5/trade/cancel-algos").flatMap((c) => c.body as any[]);
  if (cancel.some((x) => x.algoId === "sl-long" || x.algoId === "sl-short")) throw new Error("mexeu no stop da outra perna");
  if (posts().some((c) => JSON.stringify(c.body).includes("já tem posição"))) throw new Error("bloqueou posição existente");
});

Deno.test("soma na perna long e move o stop dela", async () => {
  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("long", "1", "64000"), leg("short", "0.5", "65000")] };
  algos = { OKX: [algo("long", "sl-long", "62000"), algo("short", "sl-short", "67000")] };
  const r = await runOrder("long", 63000, 1, false, "limit", 64500);
  if (r.aborted) throw new Error(String(r.abort_msg));
  const order = hit("/api/v5/trade/order", "OKX")[0].body as any;
  if (order.posSide !== "long" || order.attachAlgoOrds) throw new Error("soma não devia criar outro stop parcial: " + JSON.stringify(order));
  const amend = hit("/api/v5/trade/amend-algos", "OKX")[0]?.body as any;
  if (!amend || amend.algoId !== "sl-long" || amend.newSlTriggerPx !== "63000") throw new Error("não moveu o stop da long: " + JSON.stringify(amend));
  const cancel = hit("/api/v5/trade/cancel-algos").flatMap((c) => (c.body as any[]) || []);
  if (cancel.some((x) => x.algoId === "sl-short")) throw new Error("cancelou stop da short");
});

Deno.test("reduz 50% da long e não mexe na short", async () => {
  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("long", "2", "64000"), leg("short", "1", "66000")] };
  algos = { OKX: [algo("long", "sl-long", "62000"), algo("short", "sl-short", "68000")] };
  const r = await runReduce("long", 50, "market", null, false);
  const okx = (r.accounts as any[]).find((a) => a.prefix === "OKX");
  if (!okx || okx.status !== "ok" || okx.close_ct !== 1) throw new Error(JSON.stringify(okx));
  const order = hit("/api/v5/trade/order", "OKX")[0].body as any;
  if (order.side !== "sell" || order.posSide !== "long" || order.reduceOnly !== true || order.sz !== "1.0") throw new Error(JSON.stringify(order));
  const touched = calls.filter((c) => c.m === "POST" && c.P === "OKX").flatMap((c) => JSON.stringify(c.body));
  if (touched.some((s) => s.includes("sl-short"))) throw new Error("redução mexeu na short");
});

Deno.test("escala de 10 pernas: perda no stop cabe no risco, e uma perna ruim desfaz a conta", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1 };
  positions = {};
  algos = {};
  const prices = __test.scalePrices(63000, 64800, 10, false).map((p) => Math.round(p * 10) / 10);
  const stop = 60000;
  const sized = __test.scaleRiskLots(1, prices, stop, 1, false);
  const cts = sized.cts.filter((c) => c >= 0.1);
  if (new Set(cts).size > 2) throw new Error("tamanho igual não ficou igual: " + cts.join(","));
  const mid = (prices[0] + prices[prices.length - 1]) / 2;
  if (Math.abs(sized.avg - mid) > mid * 0.01) throw new Error("média longe do centro " + sized.avg);
  let expect = 0;
  sized.cts.forEach((ct, i) => { if (ct >= 0.1) expect += lossBtc(ct, prices[i], stop); });
  const target = ctFromRisk(1, sized.avg, stop, 1);
  const targetLoss = lossBtc(target, sized.avg, stop);
  if (Math.abs(expect - targetLoss) > targetLoss * 0.08) throw new Error(`perda ${expect} != média ${targetLoss}`);
  const dry = await runScale("long", stop, 1, 63000, 64800, 10, false, false, true);
  if (posts().length) throw new Error("dry enviou");
  const row = (dry.accounts as any[]).find((a) => a.prefix === "OKX");
  const loss = row.loss_btc as number;
  if (Math.abs(loss - expect) > 1e-6) throw new Error(`perda ${loss} != ${expect}`);
  const legCts = (row.legs as any[]).map((l) => l.ct);
  if (new Set(legCts).size > 2) throw new Error("pernas desiguais " + legCts.join(","));
  if (loss > 1 * 0.01 + 1e-6) throw new Error("perda passou do risco");
  if (loss < 1 * 0.01 * 0.5) throw new Error("perda ficou longe do risco");

  failBatch = true;
  const live = await runScale("long", stop, 1, 63000, 64800, 10, false, false, false);
  failBatch = false;
  const bad = (live.accounts as any[]).find((a) => a.prefix === "OKX");
  const good = (live.accounts as any[]).find((a) => a.prefix === "OKX2");
  if (bad.status !== "falhou") throw new Error("OKX devia falhar: " + JSON.stringify(bad));
  if (good.status !== "ok") throw new Error("OKX2 devia entrar: " + JSON.stringify(good));
  const cancelled = hit("/api/v5/trade/cancel-batch-orders", "OKX").flatMap((c) => c.body as any[]);
  if (!cancelled.length || cancelled.some((x) => !x.ordId)) throw new Error("não desfez as pernas da OKX");
  if (hit("/api/v5/trade/cancel-batch-orders", "OKX2").length) throw new Error("desfez a conta que deu certo");
});

Deno.test("escala de hedge acumula a % vendida", async () => {
  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("short", "64.1", "68000", "64100")] };
  const dry = await __test.runHedgeScale(40, "short", 65000, 68000, 4, false, false, true, false);
  if (dry.aborted) throw new Error(String(dry.abort_msg));
  const legs = ((dry.accounts as any[])[0].legs) as { pct: number; ct: number }[];
  if (legs.length !== 4) throw new Error(JSON.stringify(legs));
  if (!(legs[0].pct < legs[1].pct && legs[2].pct < legs[3].pct)) throw new Error(JSON.stringify(legs));
  if (!(legs[0].pct > 10)) throw new Error("começou do zero " + JSON.stringify(legs));
  if (legs[3].pct !== 40) throw new Error("final " + legs[3].pct);
  const live = await __test.runHedgeScale(40, "short", 65000, 68000, 4, false, false, false, false);
  if (live.aborted) throw new Error(String(live.abort_msg));
  const rows = hit("/api/v5/trade/batch-orders", "OKX").flatMap((c) => c.body as any[]);
  if (rows.length !== 4 || rows.some((b) => b.posSide !== "short" || b.side !== "sell" || b.reduceOnly)) throw new Error(JSON.stringify(rows[0]));
});

Deno.test("altera limite e stop; stop do lado errado não sai", async () => {
  reset(); install();
  positions = { OKX: [leg("long", "1", "64000", "64100")] };
  algos = { OKX: [algo("long", "sl-long", "62000")] };
  const lim = await runAmend("limit", "OKX", "ord-1", 63900, false);
  if (lim.aborted) throw new Error(String(lim.abort_msg));
  const body = hit("/api/v5/trade/amend-order")[0].body as any;
  if (body.ordId !== "ord-1" || body.newPx !== "63900") throw new Error(JSON.stringify(body));
  const bad = await runAmend("stop", "OKX", "sl-long", 65000, false);
  if (!bad.aborted) throw new Error("aceitou stop acima da entrada");
  if (hit("/api/v5/trade/amend-algos").length) throw new Error("stop inválido foi enviado");
  const ok = await runAmend("stop", "OKX", "sl-long", 63000, false);
  if (ok.aborted) throw new Error(String(ok.abort_msg));
  const moved = hit("/api/v5/trade/amend-algos")[0].body as any;
  if (moved.algoId !== "sl-long" || moved.newSlTriggerPx !== "63000") throw new Error(JSON.stringify(moved));
  const dry = await runAmend("stop", "OKX", "sl-long", 62500, true);
  if (dry.aborted || posts().some((c) => c.p === "/api/v5/trade/amend-algos" && (c.body as any).newSlTriggerPx === "62500")) throw new Error("dry enviou o stop");
});

Deno.test("hedge 0→50, 50→25, 50→50 e modo comprado", async () => {
  reset(); install();
  // mark do stub é 64100; 50% de 1 BTC = 320.5 ct
  const alvo50 = hedgeNumbers(1, 64100, 0, 0, 50, "short").alvoCt;
  if (alvo50 !== 320.5) throw new Error("alvo 50% " + alvo50);
  positions = { OKX: [], OKX2: [leg("short", "320.5", "64000", "64100"), leg("long", "1", "63000", "64100")] };
  algos = { OKX2: [algo("short", "sl-short", "70000"), algo("long", "sl-long", "60000")] };
  balances = { OKX: 1, OKX2: 1 };
  const up = await runHedge(50, "short", "market", null, false, ["OKX", "OKX2"]);
  const a = (up.accounts as any[]).find((x) => x.prefix === "OKX");
  const b = (up.accounts as any[]).find((x) => x.prefix === "OKX2");
  if (a.action !== "vender" || a.delta_ct !== 320.5) throw new Error("0→50 " + JSON.stringify(a));
  if (b.status !== "no alvo") throw new Error("50→50 devia ser no alvo " + JSON.stringify(b));
  const sell = hit("/api/v5/trade/order", "OKX")[0].body as any;
  if (sell.side !== "sell" || sell.posSide !== "short" || sell.reduceOnly || sell.sz !== "320.5" || !sell.clOrdId) throw new Error(JSON.stringify(sell));
  if (hit("/api/v5/trade/order", "OKX2").length) throw new Error("no-op enviou ordem");
  if (hit("/api/v5/trade/cancel-algos").length) throw new Error("hedge cancelou stop sem zerar");

  positions = { OKX: [leg("short", "320.5"), leg("long", "2", "63000")] };
  const down = await runHedge(25, "short", "market", null, false, ["OKX"]);
  const row = (down.accounts as any[])[0];
  if (row.action !== "reduzir" || !(row.delta_ct < 0)) throw new Error(JSON.stringify(row));
  const buy = hit("/api/v5/trade/order", "OKX").slice(-1)[0].body as any;
  if (buy.side !== "buy" || buy.posSide !== "short" || buy.reduceOnly !== true) throw new Error(JSON.stringify(buy));
  const touched = hit("/api/v5/trade/cancel-algos").flatMap((c) => JSON.stringify(c.body));
  if (touched.some((s) => s.includes("sl-long") || s.includes("long"))) throw new Error("hedge mexeu na long");

  const net = hedgeNumbers(1, 64100, 0, 0, 50, "net");
  if (Math.abs(net.hedgePct - 50) > 1e-6) throw new Error("net 50 não virou 50% vendido: " + net.hedgePct);
  const full = hedgeNumbers(1, 64100, 0, 320.5, 100, "net");
  if (full.alvoCt !== 0) throw new Error("100% comprado devia zerar o short: " + full.alvoCt);
  positions = { OKX: [leg("short", "320.5")] };
  algos = { OKX: [algo("short", "sl-short", "70000")] };
  const flat = await runHedge(0, "short", "market", null, false, ["OKX"]);
  if ((flat.accounts as any[])[0].action !== "reduzir") throw new Error(JSON.stringify(flat.accounts));
  const canc = hit("/api/v5/trade/cancel-algos", "OKX").flatMap((c) => c.body as any[]);
  if (!canc.some((x) => x.algoId === "sl-short")) throw new Error("zerar o short devia cancelar o stop órfão");
});

Deno.test("pnl inverso e rateio do reduce", () => {
  const longWin = realizedPnlBtc(1, 60000, 64000, "long");
  const longLoss = realizedPnlBtc(1, 68000, 64000, "long");
  const shortWin = realizedPnlBtc(1, 68000, 64000, "short");
  const shortLoss = realizedPnlBtc(1, 60000, 64000, "short");
  if (!(longWin > 0) || !(shortWin > 0) || !(longLoss < 0) || !(shortLoss < 0)) throw new Error("sinal do pnl " + [longWin, longLoss, shortWin, shortLoss]);
  if (Math.abs(longWin - 100 * (1 / 60000 - 1 / 64000)) > 1e-12) throw new Error("pnl long " + longWin);
  if (Math.abs(shortWin - 100 * (1 / 64000 - 1 / 68000)) > 1e-12) throw new Error("pnl short " + shortWin);
  const alloc = allocateReduce([{ key: "pupo", pos: 10 }, { key: "pai", pos: 5 }, { key: "mãe", pos: 0 }], 3);
  const pupo = alloc.find((a) => a.key === "pupo")!;
  const pai = alloc.find((a) => a.key === "pai")!;
  const mae = alloc.find((a) => a.key === "mãe")!;
  if (pupo.ct !== 2 || pai.ct !== 1 || mae.ct !== 0) throw new Error("rateio " + JSON.stringify(alloc));
  if (pupo.ct / 10 !== pai.ct / 5) throw new Error("não ficou o mesmo %");
  const capped = allocateReduce([{ key: "a", pos: 1 }, { key: "b", pos: 1 }], 5);
  if (capped.some((a) => a.ct !== 1)) throw new Error("passou da perna " + JSON.stringify(capped));
  const parts = splitLots(1.3, [1, 1]);
  if (Math.abs(parts[0] + parts[1] - 1.3) > 1e-9) throw new Error("escada " + parts);
  if (parts.some((c) => Math.abs(c * 10 - Math.round(c * 10)) > 1e-9)) throw new Error("lote " + parts);
});

Deno.test("reduce por contratos, sem mexer no % antigo", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1 };
  positions = {
    OKX: [leg("long", "2", "64000"), leg("short", "1", "66000")],
    OKX2: [leg("long", "4", "64000")],
  };
  algos = {
    OKX: [algo("long", "sl-long", "62000"), algo("short", "sl-short", "68000")],
    OKX2: [algo("long", "sl-2", "62000")],
  };
  const r = await runReduce("long", 0, "limit", 65000, false, { pupo: 1.26, pai: 9 });
  if (r.aborted) throw new Error(String(r.abort_msg));
  const okx = (r.accounts as any[]).find((a) => a.prefix === "OKX");
  const pai = (r.accounts as any[]).find((a) => a.prefix === "OKX2");
  if (okx.close_ct !== 1.3 || okx.status !== "ok") throw new Error("pupo " + JSON.stringify(okx));
  if (pai.close_ct !== 4 || pai.status !== "ok") throw new Error("pai devia cravar na perna " + JSON.stringify(pai));
  const orders = hit("/api/v5/trade/order").map((c) => c.body as any);
  if (orders.length !== 2 || orders.some((o) => o.reduceOnly !== true || o.posSide !== "long" || o.side !== "sell")) throw new Error(JSON.stringify(orders));
  if (orders.find((o) => o.sz === "1.3")?.px !== "65000") throw new Error("preço " + JSON.stringify(orders));
  const touched = hit("/api/v5/trade/cancel-algos", "OKX").flatMap((c) => JSON.stringify(c.body));
  if (touched.some((s) => s.includes("sl-short"))) throw new Error("contratos mexeram na short");

  reset(); install();
  positions = { OKX: [leg("long", "2", "64000")] };
  algos = { OKX: [algo("long", "sl-long", "62000")] };
  const pct = await runReduce("long", 33, "market", null, true);
  const row = (pct.accounts as any[]).find((a) => a.prefix === "OKX");
  if (row.close_ct !== 0.6) throw new Error("% ainda trunca no lote: " + row.close_ct);
  if (posts().length) throw new Error("dry do % enviou");
});

Deno.test("escala reduce-only: dry não envia, falha desfaz, sem stop não sai", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1 };
  positions = { OKX: [leg("long", "2", "60000", "64100")], OKX2: [leg("short", "2", "68000", "64100")] };
  algos = { OKX: [algo("long", "sl-long", "58000")] };
  const dry = await runScaleReduce("long", 63000, 65000, 2, false, false, 50, null, true);
  if (posts().length) throw new Error("dry enviou");
  const okx = (dry.accounts as any[]).find((a) => a.prefix === "OKX");
  const other = (dry.accounts as any[]).find((a) => a.prefix === "OKX2");
  if (okx.status !== "ok" || okx.close_ct !== 1) throw new Error("50% de 2 em 2 pernas " + JSON.stringify(okx));
  if (other.status !== "sem perna") throw new Error("short não devia entrar na redução long " + JSON.stringify(other));
  const legs = okx.legs as any[];
  if (legs.length !== 2 || legs.some((l) => l.ct !== 0.5)) throw new Error("pernas " + JSON.stringify(legs));

  const live = await runScaleReduce("long", 63000, 65000, 2, false, false, null, { pupo: 1 }, false);
  if (live.aborted) throw new Error(String(live.abort_msg));
  const batch = hit("/api/v5/trade/batch-orders", "OKX")[0].body as any[];
  if (batch.length !== 2 || batch.some((o) => o.reduceOnly !== true || o.posSide !== "long" || o.side !== "sell")) throw new Error(JSON.stringify(batch));
  if (hit("/api/v5/trade/batch-orders", "OKX2").length) throw new Error("mandou escala na conta sem a perna");

  reset(); install();
  positions = { OKX: [leg("long", "2", "60000")] };
  algos = {};
  const bare = await runScaleReduce("long", 63000, 65000, 2, false, false, 50, null, false);
  if (!bare.aborted || posts().some((c) => c.p === "/api/v5/trade/batch-orders")) throw new Error("sem stop não podia enviar");

  failBatch = true;
  positions = { OKX: [leg("long", "2", "60000")], OKX2: [leg("long", "2", "60000")] };
  algos = { OKX: [algo("long", "sl-long", "58000")], OKX2: [algo("long", "sl-2", "58000")] };
  const bad = await runScaleReduce("long", 63000, 65000, 2, false, false, 50, null, false);
  failBatch = false;
  const failed = (bad.accounts as any[]).find((a) => a.prefix === "OKX");
  const good = (bad.accounts as any[]).find((a) => a.prefix === "OKX2");
  if (failed.status !== "falhou") throw new Error("OKX devia falhar " + JSON.stringify(failed));
  if (good.status !== "ok") throw new Error("OKX2 devia entrar " + JSON.stringify(good));
  if (!hit("/api/v5/trade/cancel-batch-orders", "OKX").length) throw new Error("não desfez a escala da OKX");
});

Deno.test("stop a mercado: trigger com orderPx -1, e reduce-only na perna pedida", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
  positions = {};
  algos = {};
  const open = await runAlgo({
    kind: "trigger", side: "long", reduce: false, dry: false, mode: "usd", amount: 400,
    stop: null, contracts: null, triggerPx: 63000, triggerPxType: "last", maxChaseUnit: null, maxChase: null,
  });
  if (open.aborted) throw new Error(String(open.abort_msg));
  const bodies = hit("/api/v5/trade/order-algo").map((c) => c.body as any);
  if (bodies.length !== 4) throw new Error("contas " + bodies.length);
  if (bodies.some((b) => b.ordType !== "trigger" || b.orderPx !== "-1" || b.triggerPx !== "63000" || b.triggerPxType !== "last")) throw new Error(JSON.stringify(bodies[0]));
  if (bodies.some((b) => b.posSide !== "long" || b.side !== "buy" || b.reduceOnly || b.sz !== "1.0")) throw new Error(JSON.stringify(bodies));
  if (hit("/api/v5/trade/order").length) throw new Error("trigger não pode ir em /order");

  reset(); install();
  positions = { OKX: [leg("long", "2"), leg("short", "1")] };
  algos = { OKX: [algo("long", "sl-long", "58000")] };
  const red = await runAlgo({
    kind: "trigger", side: "long", reduce: true, dry: false, mode: "pct", amount: 50,
    stop: null, contracts: null, triggerPx: 61000, triggerPxType: "mark", maxChaseUnit: null, maxChase: null,
  });
  if (red.aborted) throw new Error(String(red.abort_msg));
  const body = hit("/api/v5/trade/order-algo", "OKX")[0].body as any;
  if (body.posSide !== "long" || body.side !== "sell" || body.reduceOnly !== true || body.sz !== "1.0") throw new Error(JSON.stringify(body));
  if (body.triggerPxType !== "mark" || body.orderPx !== "-1" || body.triggerPx !== "61000") throw new Error(JSON.stringify(body));
  const touched = hit("/api/v5/trade/cancel-algos").flatMap((c) => JSON.stringify(c.body));
  if (touched.some((s) => s.includes("sl-long"))) throw new Error("stop a mercado não devia cancelar o stop");
});

Deno.test("chase segue o book e o máximo vira maxChase; reduzir manda reduceOnly", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
  positions = { OKX: [leg("short", "2", "68000")] };
  algos = { OKX: [algo("short", "sl-short", "70000")] };
  const open = await runAlgo({
    kind: "chase", side: "short", reduce: false, dry: false, mode: "pct", amount: 1,
    stop: 70000, contracts: null, triggerPx: null, triggerPxType: "last", maxChaseUnit: "pct", maxChase: 5,
  });
  if (open.aborted) throw new Error(String(open.abort_msg));
  const body = hit("/api/v5/trade/order-algo", "OKX")[0].body as any;
  if (body.ordType !== "chase" || body.chaseType !== "distance" || body.chaseVal !== "0") throw new Error(JSON.stringify(body));
  if (body.maxChaseType !== "ratio" || body.maxChaseVal !== "0.05") throw new Error("max " + JSON.stringify(body));
  if (body.posSide !== "short" || body.side !== "sell" || body.reduceOnly) throw new Error(JSON.stringify(body));
  if (body.attachAlgoOrds) throw new Error("chase não anexa stop na ordem");

  reset(); install();
  positions = { OKX: [leg("long", "2"), leg("short", "1")] };
  algos = { OKX: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")] };
  const red = await runAlgo({
    kind: "chase", side: "short", reduce: true, dry: false, mode: "usd", amount: 100,
    stop: null, contracts: null, triggerPx: null, triggerPxType: "last", maxChaseUnit: null, maxChase: null,
  });
  if (red.aborted) throw new Error(String(red.abort_msg));
  const buy = hit("/api/v5/trade/order-algo", "OKX")[0].body as any;
  if (buy.posSide !== "short" || buy.side !== "buy" || buy.reduceOnly !== true || buy.sz !== "1.0") throw new Error(JSON.stringify(buy));
  if (buy.maxChaseType || buy.maxChaseVal) throw new Error("sem máximo não manda maxChase");
  if (buy.chaseType !== "distance" || buy.chaseVal !== "0") throw new Error(JSON.stringify(buy));
});

Deno.test("abre limite por % do saldo e por USD repartido; risco antigo não muda", async () => {
  if (ctFromEquityPct(1, 64000, 1) !== 6.4) throw new Error("1% de 1 BTC @ 64000 = 6.4 ct, veio " + ctFromEquityPct(1, 64000, 1));
  reset(); install();
  balances = { OKX: 2, OKX2: 1, OKX3: 1, OKX4: 1 };
  positions = {};
  const usd = await runSized("long", "market", null, false, "usd", 500, null);
  if (usd.aborted) throw new Error(String(usd.abort_msg) + " " + JSON.stringify(usd.accounts));
  const sz = Object.fromEntries(hit("/api/v5/trade/order").map((c) => [c.P, (c.body as any).sz]));
  if (sz.OKX !== "2.0" || sz.OKX2 !== "1.0" || sz.OKX3 !== "1.0" || sz.OKX4 !== "1.0") throw new Error(JSON.stringify(sz));
  const sample = hit("/api/v5/trade/order", "OKX")[0].body as any;
  if (sample.ordType !== "market" || sample.posSide !== "long" || sample.side !== "buy" || sample.reduceOnly || sample.px) throw new Error(JSON.stringify(sample));

  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("long", "1", "64000")] };
  algos = { OKX: [algo("long", "sl-long", "60000")] };
  const pct = await runSized("long", "limit", 63000, true, "pct", 1, 60000);
  if (pct.aborted || posts().length) throw new Error("dry do % enviou " + JSON.stringify(pct));
  const row = (pct.accounts as any[]).find((a) => a.prefix === "OKX");
  if (row.ct !== 6.4) throw new Error("prévia % " + row.ct);

  reset(); install();
  const risk = await runOrder("short", 66000, 1, true, "market", null);
  if (posts().length) throw new Error("risco dry enviou");
  if (risk.ordType !== "market" || risk.aborted) throw new Error(String(risk.abort_msg));
});

Deno.test("altera stop a mercado com newTriggerPx e cancela chase", async () => {
  reset(); install();
  setReq(async (P, m, p, body) => {
    calls.push({ P, m, p, body });
    if (p.startsWith("/api/v5/public/mark-price")) return { code: "0", data: [{ markPx: "64100" }] };
    if (p.startsWith("/api/v5/trade/orders-algo-pending") && p.includes("ordType=trigger")) {
      return { code: "0", data: [{ instId: "BTC-USD-SWAP", algoId: "tg-1", ordType: "trigger", posSide: "long", triggerPx: "60000", triggerPxType: "last", orderPx: "-1", reduceOnly: true, sz: "1" }] };
    }
    if (p.startsWith("/api/v5/trade/orders-algo-pending")) return { code: "0", data: algos[P] ?? [] };
    if (p === "/api/v5/trade/amend-algos") return { code: "0", data: [{ sCode: "0" }] };
    if (p === "/api/v5/trade/cancel-algos") return { code: "0", data: [{ sCode: "0" }] };
    if (p.startsWith("/api/v5/account/positions")) return { code: "0", data: positions[P] ?? [] };
    return { code: "0", data: [] };
  });
  const bad = await runAmend("trigger", "OKX", "tg-1", 65000, false);
  if (!bad.aborted || hit("/api/v5/trade/amend-algos").length) throw new Error("reduce trigger do lado errado saiu");
  const ok = await runAmend("trigger", "OKX", "tg-1", 62000, false, "mark");
  if (ok.aborted) throw new Error(String(ok.abort_msg));
  const body = hit("/api/v5/trade/amend-algos")[0].body as any;
  if (body.algoId !== "tg-1" || body.newTriggerPx !== "62000" || body.newOrdPx !== "-1" || body.newTriggerPxType !== "mark") throw new Error(JSON.stringify(body));
  if (body.newSlTriggerPx) throw new Error("trigger não usa slTrigger");
  const cancel = await runCancel("OKX", "ch-1", false);
  if (cancel.aborted) throw new Error(String(cancel.abort_msg));
  const gone = hit("/api/v5/trade/cancel-algos")[0].body as any[];
  if (gone[0].algoId !== "ch-1" || gone[0].instId !== "BTC-USD-SWAP") throw new Error(JSON.stringify(gone));
  const dry = await runCancel("OKX", "ch-2", true);
  if (dry.aborted || hit("/api/v5/trade/cancel-algos").length !== 1) throw new Error("dry cancelou");
});

Deno.test("escala de 10 pernas crescentes com as duas pernas abertas", async () => {
  reset(); install();
  const banded = (buy: string, sell: string) => {
    setReq(async (P, m, p, body) => {
      calls.push({ P, m, p, body });
      if (p.startsWith("/api/v5/public/price-limit")) return { code: "0", data: [{ buyLmt: buy, sellLmt: sell, enabled: true }] };
      if (p.startsWith("/api/v5/public/mark-price")) return { code: "0", data: [{ markPx: "63772" }] };
      if (p.startsWith("/api/v5/account/balance")) return { code: "0", data: [{ details: [{ ccy: "BTC", eq: String(balances[P] ?? 1) }] }] };
      if (p.startsWith("/api/v5/account/positions")) return { code: "0", data: positions[P] ?? [] };
      if (p.startsWith("/api/v5/trade/orders-algo-pending")) return { code: "0", data: algos[P] ?? [] };
      if (p.startsWith("/api/v5/trade/orders-pending")) return { code: "0", data: [] };
      if (p === "/api/v5/trade/batch-orders") {
        const rows = (body as any[]) || [];
        return { code: "0", data: rows.map((_: unknown, i: number) => ({ sCode: "0", ordId: "b" + i })) };
      }
      if (p === "/api/v5/trade/amend-algos" || p === "/api/v5/trade/cancel-algos" || p === "/api/v5/trade/cancel-batch-orders") return { code: "0", data: [{ sCode: "0" }] };
      return { code: "0", data: [] };
    });
  };
  balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
  positions = {
    OKX: [leg("long", "2", "60000"), leg("short", "1", "68000")],
    OKX2: [leg("long", "2", "60000"), leg("short", "1", "68000")],
    OKX3: [leg("long", "2", "60000"), leg("short", "1", "68000")],
    OKX4: [leg("long", "2", "60000"), leg("short", "1", "68000")],
  };
  algos = {
    OKX: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")],
    OKX2: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")],
    OKX3: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")],
    OKX4: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")],
  };
  banded("64099.5", "63461.4");
  const deep = await runScale("long", 60000, 1, 62710.5, 62425, 10, false, true, false);
  if (deep.aborted) throw new Error("compra abaixo do mark foi bloqueada: " + deep.abort_msg);
  const deepRows = hit("/api/v5/trade/batch-orders", "OKX").flatMap((c) => c.body as any[]);
  if (deepRows.length !== 10) throw new Error("deep batch " + deepRows.length);
  if (deepRows.some((b) => !(parseFloat(b.px) <= 62710.5))) throw new Error("preço profundo sumiu");

  calls = [];
  const tooHigh = await runScale("long", 60000, 1, 65000, 66000, 10, false, false, false);
  if (!tooHigh.aborted || !String(tooHigh.abort_msg).includes("compra acima de 64099.5")) throw new Error(String(tooHigh.abort_msg));
  if (posts().some((c) => c.p === "/api/v5/trade/batch-orders")) throw new Error("compra acima do máximo foi enviada");

  calls = [];
  const tooLow = await runScale("short", 70000, 1, 62000, 62400, 10, false, false, false);
  if (!tooLow.aborted || !String(tooLow.abort_msg).includes("venda abaixo de 63461.4")) throw new Error(String(tooLow.abort_msg));
  if (posts().some((c) => c.p === "/api/v5/trade/batch-orders")) throw new Error("venda abaixo do mínimo foi enviada");

  install();
  const live = await runScale("long", 60000, 1, 63500, 63800, 10, false, true, false);
  if (live.aborted) throw new Error(String(live.abort_msg) + " " + JSON.stringify((live.accounts as any[]).map((a) => a.error)));
  const batches = hit("/api/v5/trade/batch-orders", "OKX").map((c) => c.body as any[]);
  if (batches.length !== 1 || batches[0].length !== 10) throw new Error("batch " + batches.map((b) => b.length).join(","));
  const rows = batches[0];
  if (rows.some((b) => b.side !== "buy" || b.posSide !== "long" || b.reduceOnly || b.ordType !== "limit")) throw new Error(JSON.stringify(rows[0]));
  if (rows.some((b) => !/^\d+(\.\d)?$/.test(b.px) || !/^\d+\.\d$/.test(b.sz))) throw new Error("px/sz " + JSON.stringify(rows[0]));
  const first = parseFloat(rows[0].sz);
  const last = parseFloat(rows[9].sz);
  if (!(last > first)) throw new Error(`tamanho não cresce ${first} -> ${last}`);
  const amends = hit("/api/v5/trade/amend-algos").map((c) => c.body as any);
  if (!amends.length || amends.some((b) => b.algoId !== "sl-long" || b.newSlOrdPx !== "-1")) throw new Error(JSON.stringify(amends));
  if (hit("/api/v5/trade/cancel-algos").some((c) => JSON.stringify(c.body).includes("sl-short"))) throw new Error("mexeu no stop da short");
});

Deno.test("escala long sem perna anexa o stop e não chama cf=1", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
  positions = {
    OKX: [leg("short", "1", "68000")],
    OKX2: [leg("long", "2", "60000"), leg("short", "1", "68000")],
    OKX3: [],
    OKX4: [leg("short", "1", "68000")],
  };
  algos = {
    OKX2: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")],
  };
  const live = await runScale("long", 60000, 1, 62000, 63000, 4, false, false, false);
  if (live.aborted) throw new Error(String(live.abort_msg) + " " + JSON.stringify((live.accounts as any[]).map((a) => [a.name, a.status, a.error])));
  for (const prefix of ["OKX", "OKX3", "OKX4"]) {
    const rows = hit("/api/v5/trade/batch-orders", prefix).flatMap((c) => c.body as any[]);
    if (!rows.length) throw new Error(prefix + " não enviou");
    for (const b of rows) {
      const sl = b.attachAlgoOrds && b.attachAlgoOrds[0];
      if (!sl || sl.slTriggerPx !== "60000" || sl.slOrdPx !== "-1" || sl.slTriggerPxType !== "mark") throw new Error(prefix + " " + JSON.stringify(b));
      if (b.posSide !== "long" || b.side !== "buy") throw new Error(prefix + " lado " + JSON.stringify(b));
    }
  }
  const withLeg = hit("/api/v5/trade/batch-orders", "OKX2").flatMap((c) => c.body as any[]);
  if (!withLeg.length || withLeg.some((b) => b.attachAlgoOrds)) throw new Error("perna existente não devia anexar SL " + JSON.stringify(withLeg[0]));
  const placedStop = hit("/api/v5/trade/order-algo").filter((c) => JSON.stringify(c.body).includes("closeFraction"));
  if (placedStop.length) throw new Error("cf=1 sem posição: " + JSON.stringify(placedStop[0].body));
  if (hit("/api/v5/trade/cancel-batch-orders").length) throw new Error("a escala foi desfeita");
  const amends = hit("/api/v5/trade/amend-algos").map((c) => c.body as any);
  if (amends.length !== 1 || amends[0].algoId !== "sl-long" || amends[0].newSlTriggerPx !== "60000") throw new Error(JSON.stringify(amends));
});

Deno.test("recusa da OKX na escala guarda sCode e sMsg por conta", async () => {
  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("long", "2", "60000"), leg("short", "1", "68000")] };
  algos = { OKX: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")] };
  setReq(async (P, m, p, body) => {
    calls.push({ P, m, p, body });
    if (p.startsWith("/api/v5/public/mark-price")) return { code: "0", data: [{ markPx: "64100" }] };
    if (p.startsWith("/api/v5/public/price-limit")) return { code: "0", data: [{ buyLmt: "70000", sellLmt: "60000", enabled: true }] };
    if (p.startsWith("/api/v5/account/balance")) return { code: "0", data: [{ details: [{ ccy: "BTC", eq: "1" }] }] };
    if (p.startsWith("/api/v5/account/positions")) return { code: "0", data: positions[P] ?? [] };
    if (p.startsWith("/api/v5/trade/orders-algo-pending")) return { code: "0", data: algos[P] ?? [] };
    if (p.startsWith("/api/v5/trade/orders-pending")) return { code: "0", data: [] };
    if (p === "/api/v5/trade/batch-orders") {
      const rows = (body as any[]) || [];
      return { code: "1", msg: "All operations failed", data: rows.map(() => ({ sCode: "51006", sMsg: "Order price is not within the price limit", ordId: "" })) };
    }
    return { code: "0", data: [{ sCode: "0" }] };
  });
  const live = await runScale("long", 60000, 1, 63500, 63800, 10, false, true, false);
  const row = (live.accounts as any[]).find((a) => a.prefix === "OKX");
  if (row.status !== "falhou" || !String(row.error).includes("51006") || !String(row.error).includes("not within the price limit")) {
    throw new Error(JSON.stringify(row));
  }
  if (hit("/api/v5/trade/batch-orders", "OKX").flatMap((c) => c.body as any[]).some((b) => b.ordId)) throw new Error("guardou ordem recusada");
});

Deno.test("escala por USD reparte e não exige risco; posições listam trigger e chase", async () => {
  reset(); install();
  balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
  positions = {};
  const sc = await runScaleAmount("short", 66000, 68000, 2, false, false, false, "usd", 400, null);
  if (sc.aborted) throw new Error(String(sc.abort_msg));
  const batch = hit("/api/v5/trade/batch-orders", "OKX")[0].body as any[];
  if (batch.length !== 2 || batch.some((o) => o.reduceOnly || o.posSide !== "short" || o.side !== "sell" || o.ordType !== "limit")) throw new Error(JSON.stringify(batch));
  const cts = batch.map((o) => Number(o.sz));
  if (Math.abs(cts[0] + cts[1] - 1) > 1e-9) throw new Error("1 ct na conta " + cts);
  if (hit("/api/v5/trade/order-algo").length) throw new Error("escala sem stop não coloca stop");

  setReq(async (P, m, p, body) => {
    calls.push({ P, m, p, body });
    if (p.startsWith("/api/v5/public/mark-price")) return { code: "0", data: [{ markPx: "64100" }] };
    if (p.startsWith("/api/v5/account/balance")) return { code: "0", data: [{ details: [{ ccy: "BTC", eq: "1" }] }] };
    if (p.startsWith("/api/v5/account/positions")) return { code: "0", data: [] };
    if (p.startsWith("/api/v5/trade/orders-pending")) return { code: "0", data: [] };
    if (p.includes("ordType=trigger")) return { code: "0", data: P === "OKX" ? [{ instId: "BTC-USD-SWAP", algoId: "tg", ordType: "trigger", posSide: "long", triggerPx: "61000", triggerPxType: "last", sz: "1.5", side: "buy", reduceOnly: false }] : [] };
    if (p.includes("ordType=chase")) return { code: "0", data: P === "OKX" ? [{ instId: "BTC-USD-SWAP", algoId: "ch", ordType: "chase", posSide: "short", sz: "2", side: "sell", reduceOnly: true, chaseType: "distance", chaseVal: "0" }] : [] };
    if (p.startsWith("/api/v5/trade/orders-algo-pending")) return { code: "0", data: [] };
    return { code: "0", data: [] };
  });
  const pos = await fetchPositions();
  const okx = (pos.accounts as any[]).find((a) => a.prefix === "OKX");
  const kinds = (okx.orders as any[]).map((o) => o.kind).sort();
  if (kinds.join(",") !== "chase,trigger") throw new Error(kinds.join(","));
  const tg = okx.orders.find((o: any) => o.kind === "trigger");
  if (tg.price !== 61000 || tg.algoId !== "tg") throw new Error(JSON.stringify(tg));
});

Deno.test("ajuste com as duas pernas pede o lado e mexe só na perna escolhida", async () => {
  // posSide é a perna reduzida. O painel manda a oposta ao botão: LONG envia short, SHORT envia long.
  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("long", "2", "60000"), leg("short", "1", "68000")] };
  algos = { OKX: [algo("long", "sl-long", "58000"), algo("short", "sl-short", "70000")] };
  const missing = await runAdjust(50, "market", null, false, null);
  if (!missing.aborted || missing.abort_msg !== "Escolha long ou short") throw new Error(String(missing.abort_msg));
  if (posts().length) throw new Error("sem lado enviou");

  positions = { OKX: [leg("long", "2", "60000")] };
  const only = await runAdjust(50, "market", null, true, null);
  if (only.aborted) throw new Error("perna única devia seguir: " + only.abort_msg);
  const row = (only.accounts as any[])[0];
  if (row.side !== "long" || row.close_ct !== 1) throw new Error(JSON.stringify(row));
  if (posts().length) throw new Error("dry enviou");

  positions = { OKX: [leg("long", "2", "60000"), leg("short", "1", "68000")] };
  let shrunk = false;
  setReq(async (P, m, p, body) => {
    calls.push({ P, m, p, body });
    if (p.startsWith("/api/v5/public/mark-price")) return { code: "0", data: [{ markPx: "64100" }] };
    if (p.startsWith("/api/v5/account/balance")) return { code: "0", data: [{ details: [{ ccy: "BTC", eq: "1" }] }] };
    if (p.startsWith("/api/v5/account/positions")) {
      const rows = shrunk
        ? [leg("long", "1", "60000"), leg("short", "1", "68000")]
        : [leg("long", "2", "60000"), leg("short", "1", "68000")];
      return { code: "0", data: rows };
    }
    if (p.startsWith("/api/v5/trade/orders-algo-pending")) return { code: "0", data: algos[P] ?? [] };
    if (p.startsWith("/api/v5/trade/orders-pending")) return { code: "0", data: [] };
    if (p === "/api/v5/trade/order" && m === "POST") { shrunk = true; return { code: "0", data: [{ sCode: "0", ordId: "adj" }] }; }
    if (p === "/api/v5/trade/order-algo" || p === "/api/v5/trade/cancel-algos" || p === "/api/v5/trade/amend-algos") return { code: "0", data: [{ sCode: "0" }] };
    return { code: "0", data: [] };
  });
  const long = await runAdjust(50, "market", null, false, "long");
  if (long.aborted) throw new Error(String(long.abort_msg));
  const sell = hit("/api/v5/trade/order", "OKX").map((c) => c.body as any).pop();
  if (sell.posSide !== "long" || sell.side !== "sell" || sell.reduceOnly !== true || sell.sz !== "1.0" || sell.ordType !== "market") throw new Error(JSON.stringify(sell));
  const touched = hit("/api/v5/trade/cancel-algos").flatMap((c) => JSON.stringify(c.body));
  if (touched.some((s) => s.includes("sl-short"))) throw new Error("ajuste da long mexeu no stop da short");

  shrunk = false;
  const short = await runAdjust(50, "limit", 65000, false, "short");
  if (short.aborted) throw new Error(String(short.abort_msg));
  const buy = hit("/api/v5/trade/order", "OKX").map((c) => c.body as any).pop();
  if (buy.posSide !== "short" || buy.side !== "buy" || buy.reduceOnly !== true || buy.ordType !== "limit" || buy.px !== "65000" || buy.sz !== "0.5") throw new Error(JSON.stringify(buy));
  const again = hit("/api/v5/trade/cancel-algos").flatMap((c) => JSON.stringify(c.body));
  if (again.some((s) => s.includes("sl-long"))) throw new Error("ajuste da short mexeu no stop da long");
});

const EXEC_ID = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const DEP_ID = "krzznjwvcrbuhlfwsdel_0a1b2c3d-4e5f-6789-abcd-ef0123456789_42";
const envOf = (vars: Record<string, string>) => (k: string) => vars[k] ?? "";
const HOSTED_ENV = { SB_EXECUTION_ID: EXEC_ID, DENO_DEPLOYMENT_ID: DEP_ID };

Deno.test("trava de ambiente: destino da OKX real exige HTTPS em www.okx.com, autorização e hospedagem; loopback sempre", () => {
  const { okxTargetAllowed } = __test;
  const cases: [string, boolean, boolean, boolean][] = [
    // [base, autorizado, hospedado, esperado]
    // mock em loopback: permitido em qualquer combinação
    ["http://127.0.0.1:8788", false, false, true],
    ["http://localhost:8788", false, false, true],
    ["http://[::1]:8788", false, false, true],
    ["http://127.0.0.1:8788", true, true, true],
    ["ftp://127.0.0.1:8788", false, false, false],
    // OKX real: só com as duas condições
    ["https://www.okx.com", true, true, true],
    ["https://www.okx.com", true, false, false],
    ["https://www.okx.com", false, true, false],
    ["https://www.okx.com", false, false, false],
    // destino errado, mesmo autorizado e hospedado
    ["http://www.okx.com", true, true, false],
    ["https://www.okx.com:8443", true, true, false],
    ["https://user:pw@www.okx.com", true, true, false],
    ["https://okx.com", true, true, false],
    ["https://aws.okx.com", true, true, false],
    ["https://www.okx.com.evil.com", true, true, false],
    ["https://evil.com", true, true, false],
    ["http://127.0.0.1.okx.com", true, true, false],
    ["lixo", true, true, false],
    // origem exata: nem porta padrão explícita, nem caminho, query, fragmento ou variação de escrita
    ["https://www.okx.com:443", true, true, false],
    ["https://www.okx.com/api", true, true, false],
    ["https://www.okx.com/?x=1", true, true, false],
    ["https://www.okx.com?x=1", true, true, false],
    ["https://www.okx.com/", true, true, false],
    ["https://www.okx.com#x", true, true, false],
    ["https://user@www.okx.com", true, true, false],
    ["https://:pw@www.okx.com", true, true, false],
    ["HTTPS://WWW.OKX.COM", true, true, false],
    ["https://www.okx.com.", true, true, false],
    [" https://www.okx.com", true, true, false],
    ["https://www.okx.com ", true, true, false],
    // mock em loopback continua com porta e nos três hosts
    ["http://localhost:8788", true, true, true],
    ["http://[::1]:8788", true, true, true],
    ["https://127.0.0.1:8788", false, false, true],
  ];
  for (const [base, live, hosted, want] of cases) {
    if (okxTargetAllowed(base, live, hosted) !== want) throw new Error(`okxTargetAllowed(${base}, ${live}, ${hosted}) deveria ser ${want}`);
  }
});

Deno.test("trava de ambiente: marcadores de hospedagem ausentes, incompletos ou malformados não contam", () => {
  const { hostedMarkersPresent } = __test;
  const cases: [Record<string, string>, boolean, boolean, string][] = [
    // [variáveis, EdgeRuntime presente, esperado, cenário]
    [HOSTED_ENV, true, true, "todos os marcadores válidos"],
    [{}, false, false, "deno run comum, nada definido"],
    [{}, true, false, "só EdgeRuntime (como no supabase functions serve)"],
    [{ SB_EXECUTION_ID: EXEC_ID }, true, false, "falta DENO_DEPLOYMENT_ID"],
    [{ DENO_DEPLOYMENT_ID: DEP_ID }, true, false, "falta SB_EXECUTION_ID"],
    [HOSTED_ENV, false, false, "variáveis forjadas num deno run comum, sem EdgeRuntime"],
    [{ ...HOSTED_ENV, SB_EXECUTION_ID: "abc" }, true, false, "SB_EXECUTION_ID não é UUID"],
    [{ ...HOSTED_ENV, SB_EXECUTION_ID: EXEC_ID + "x" }, true, false, "SB_EXECUTION_ID com sobra"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "outroprojeto_fn_1" }, true, false, "deploy de outro projeto"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel" }, true, false, "só o ref, sem função/versão"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_" }, true, false, "ref com sufixo vazio"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdelX_fn_1" }, true, false, "prefixo parecido"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn 1" }, true, false, "espaço no id"],
    // sufixos malformados de DENO_DEPLOYMENT_ID
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn" }, true, false, "sem versão"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn_" }, true, false, "versão vazia"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel__1" }, true, false, "function_id vazio"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn__1" }, true, false, "segmento vazio no meio"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn_1\n" }, true, false, "quebra de linha no fim"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn_1 " }, true, false, "espaço no fim"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: " krzznjwvcrbuhlfwsdel_fn_1" }, true, false, "espaço no início"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn/1_2" }, true, false, "barra"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn_1;x" }, true, false, "ponto e vírgula"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fñ_1" }, true, false, "caractere fora do conjunto"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "x_krzznjwvcrbuhlfwsdel_fn_1" }, true, false, "ref fora do início"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "KRZZNJWVCRBUHLFWSDEL_fn_1" }, true, false, "ref em maiúsculas"],
    // formatos válidos de {project_ref}_{function_id}_{version}
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_painel_7" }, true, true, "function_id simples"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_my-fn_12" }, true, true, "function_id com hífen"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_0a1b2c3d-4e5f-6789-abcd-ef0123456789_3" }, true, true, "function_id UUID"],
    [{ ...HOSTED_ENV, DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn_1.2" }, true, true, "versão com ponto"],
  ];
  for (const [vars, edge, want, why] of cases) {
    if (hostedMarkersPresent(envOf(vars), edge) !== want) throw new Error(`hostedMarkersPresent: ${why} deveria ser ${want}`);
  }
});

Deno.test("trava de ambiente: detecção não autoriza; autorização sem detecção não libera; mock local continua", () => {
  const { okxAllowedByEnv, okxLiveAuthorized } = __test;
  // autorização é só a flag exata, sem relação com os marcadores
  if (!okxLiveAuthorized(envOf({ OKX_LIVE_ENABLED: "true" }))) throw new Error("flag exata deveria autorizar");
  for (const v of ["", "TRUE", "True", "1", "yes", " true", "true "]) {
    if (okxLiveAuthorized(envOf({ OKX_LIVE_ENABLED: v }))) throw new Error(`flag ${JSON.stringify(v)} não deveria autorizar`);
  }
  if (okxLiveAuthorized(envOf(HOSTED_ENV))) throw new Error("marcadores não podem autorizar");

  const prodUrl = "https://krzznjwvcrbuhlfwsdel.supabase.co";
  const cases: [Record<string, string>, boolean, boolean, string][] = [
    // [variáveis, EdgeRuntime presente, esperado, cenário]
    [{ ...HOSTED_ENV, OKX_LIVE_ENABLED: "true" }, true, true, "produção: marcadores + flag"],
    [{ ...HOSTED_ENV, OKX_LIVE_ENABLED: "true", OKX_BASE: "https://www.okx.com" }, true, true, "produção com OKX_BASE explícito"],
    // flag ausente ou errada
    [HOSTED_ENV, true, false, "marcadores sem flag"],
    [{ ...HOSTED_ENV, OKX_LIVE_ENABLED: "TRUE" }, true, false, "flag em maiúsculas"],
    // marcadores ausentes/incompletos com a flag
    [{ OKX_LIVE_ENABLED: "true" }, false, false, "flag num deno run comum"],
    [{ OKX_LIVE_ENABLED: "true" }, true, false, "flag com só EdgeRuntime (functions serve)"],
    [{ OKX_LIVE_ENABLED: "true", SB_EXECUTION_ID: EXEC_ID }, true, false, "flag com marcador incompleto"],
    // falsificações simuladas
    [{ ...HOSTED_ENV, OKX_LIVE_ENABLED: "true" }, false, false, "marcadores + flag forjados sem EdgeRuntime"],
    [{ OKX_LIVE_ENABLED: "true", SUPABASE_URL: prodUrl }, true, false, "SUPABASE_URL de produção não conta"],
    [{ SUPABASE_URL: prodUrl, OKX_BASE: "https://www.okx.com" }, true, false, "SUPABASE_URL sem flag nem marcadores"],
    // destino errado mesmo com tudo
    [{ ...HOSTED_ENV, OKX_LIVE_ENABLED: "true", OKX_BASE: "http://www.okx.com" }, true, false, "OKX real por http"],
    [{ ...HOSTED_ENV, OKX_LIVE_ENABLED: "true", OKX_BASE: "https://evil.com" }, true, false, "outro host"],
    // mock local: como o tests/serve-painel.sh
    [{ OKX_BASE: "http://127.0.0.1:8788" }, false, true, "mock local sem nada"],
    [{ OKX_BASE: "http://127.0.0.1:8788", SUPABASE_URL: prodUrl }, false, true, "mock local com SUPABASE_URL"],
    [{ ...HOSTED_ENV, OKX_LIVE_ENABLED: "true", OKX_BASE: "http://127.0.0.1:8788" }, true, true, "mock com tudo definido"],
    // padrão sem OKX_BASE é a OKX real: bloqueado fora de produção
    [{}, false, false, "nada definido"],
  ];
  for (const [vars, edge, want, why] of cases) {
    if (okxAllowedByEnv(envOf(vars), edge) !== want) throw new Error(`okxAllowedByEnv: ${why} deveria ser ${want}`);
  }
});

Deno.test("trava de ambiente: diagnóstico mostra a forma dos marcadores sem vazar valores", () => {
  const { okxEnvDiagnostics } = __test;
  const secretFlag = "true";
  const base = "https://www.okx.com";
  const vars = { ...HOSTED_ENV, OKX_LIVE_ENABLED: secretFlag, OKX_BASE: base };
  const d = okxEnvDiagnostics(envOf(vars), true);
  const txt = JSON.stringify(d);
  for (const raw of [EXEC_ID, DEP_ID, "krzznjwvcrbuhlfwsdel", base, "okx.com"]) {
    if (txt.includes(raw)) throw new Error(`diagnóstico vazou ${raw}`);
  }
  if (!(d.edgeRuntime && d.execId.uuidOk && d.deploymentId.refPrefixOk && d.deploymentId.formatOk && d.deploymentId.segments === 3 &&
    d.liveFlag.exactTrue && d.okxBase.exactOrigin && d.hosted && d.allowed)) throw new Error("produção completa: " + txt);
  const shape = (s: string) => s.replace(/[A-Za-z]/g, "a").replace(/[0-9]/g, "9");
  if (d.execId.shape !== shape(EXEC_ID) || d.deploymentId.shape !== shape(DEP_ID)) {
    throw new Error("shape: " + d.execId.shape + " / " + d.deploymentId.shape);
  }

  // cenários de bloqueio: o diagnóstico aponta o motivo
  const semFlag = okxEnvDiagnostics(envOf(HOSTED_ENV), true);
  if (semFlag.allowed || semFlag.liveFlag.present || !semFlag.hosted) throw new Error("sem flag: " + JSON.stringify(semFlag));
  const flagErrada = okxEnvDiagnostics(envOf({ ...HOSTED_ENV, OKX_LIVE_ENABLED: " True " }), true);
  if (flagErrada.allowed || flagErrada.liveFlag.exactTrue || !flagErrada.liveFlag.looseTrue) throw new Error("flag errada: " + JSON.stringify(flagErrada));
  const depEstranho = okxEnvDiagnostics(envOf({ ...HOSTED_ENV, OKX_LIVE_ENABLED: "true", DENO_DEPLOYMENT_ID: "krzznjwvcrbuhlfwsdel_fn" }), true);
  if (depEstranho.allowed || depEstranho.deploymentId.formatOk || !depEstranho.deploymentId.refPrefixOk || depEstranho.deploymentId.segments !== 2) {
    throw new Error("deployment id fora do formato: " + JSON.stringify(depEstranho));
  }
  const local = okxEnvDiagnostics(envOf({ OKX_BASE: "http://127.0.0.1:8788" }), false);
  if (!local.allowed || local.hosted || local.okxBase.exactOrigin || local.execId.present) throw new Error("mock local: " + JSON.stringify(local));
  if (JSON.stringify(local).includes("8788")) throw new Error("diagnóstico vazou OKX_BASE local");
});

// Ordem de abertura além do stop atual da perna: o stop atual fecha a perna antes, então é posição nova.
// O stop novo vai grudado na ordem e o stop atual não é movido. Vale para todo tipo de ordem.
Deno.test("além do stop atual: posição nova, stop novo na ordem e stop atual intacto", async () => {
  const setup = () => {
    reset(); install();
    balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
    positions = { OKX: [leg("short", "1", "68000", "63000"), leg("long", "2", "60000", "63000")] };
    algos = { OKX: [algo("short", "sl-short", "70000"), algo("long", "sl-long", "58000")] };
  };
  const untouched = (what: string) => {
    if (hit("/api/v5/trade/amend-algos").length) throw new Error(what + ": moveu o stop atual");
    if (hit("/api/v5/trade/cancel-algos").length) throw new Error(what + ": cancelou o stop atual");
  };

  // escala por USD, short 70.837→75.068 acima do stop 70.000, stop novo 76.000
  setup();
  const sc = await runScaleAmount("short", 70837.2, 75068.9, 10, false, false, false, "usd", 1000, 76000);
  if (sc.aborted) throw new Error("escala: " + sc.abort_msg);
  const rows = hit("/api/v5/trade/batch-orders", "OKX").flatMap((c) => c.body as any[]);
  if (!rows.length || rows.some((o) => o.attachAlgoOrds?.[0]?.slTriggerPx !== "76000")) throw new Error("escala sem stop novo: " + JSON.stringify(rows[0]));
  untouched("escala");

  // escala por USD sem stop novo: entra sem stop e o stop atual fica
  setup();
  const bare = await runScaleAmount("short", 70837.2, 75068.9, 10, false, false, false, "usd", 1000, null);
  if (bare.aborted) throw new Error("escala sem stop: " + bare.abort_msg);
  untouched("escala sem stop");

  // limite por risco (ordem única) acima do stop da short
  setup();
  const lim = await runOrder("short", 72000, 1, false, "limit", 71000);
  if (lim.aborted) throw new Error("limite: " + lim.abort_msg);
  const order = hit("/api/v5/trade/order", "OKX")[0].body as any;
  if (order.attachAlgoOrds?.[0]?.slTriggerPx !== "72000") throw new Error("limite sem stop novo: " + JSON.stringify(order));
  untouched("limite risco");

  // limite por USD, long abaixo do stop da long
  setup();
  const sized = await runSized("long", "limit", 57000, false, "usd", 400, 56000);
  if (sized.aborted) throw new Error("limite usd: " + sized.abort_msg);
  const o2 = hit("/api/v5/trade/order", "OKX")[0].body as any;
  if (o2.attachAlgoOrds?.[0]?.slTriggerPx !== "56000") throw new Error("limite usd sem stop novo: " + JSON.stringify(o2));
  untouched("limite usd");

  // stop a mercado (trigger) acima do stop da short
  setup();
  const tg = await runAlgo({
    kind: "trigger", side: "short", reduce: false, dry: false, mode: "usd", amount: 400,
    stop: 73000, contracts: null, triggerPx: 71000, triggerPxType: "last", maxChaseUnit: null, maxChase: null,
  });
  if (tg.aborted) throw new Error("trigger: " + tg.abort_msg);
  const t = hit("/api/v5/trade/order-algo", "OKX").map((c) => c.body as any).find((b) => b.ordType === "trigger");
  if (t?.attachAlgoOrds?.[0]?.slTriggerPx !== "73000") throw new Error("trigger sem stop novo: " + JSON.stringify(t));
  untouched("trigger");

  // controle: limite dentro do stop atual continua somando na perna e movendo o stop
  setup();
  const inside = await runOrder("short", 69000, 1, false, "limit", 66000);
  if (inside.aborted) throw new Error("dentro: " + inside.abort_msg);
  const amend = hit("/api/v5/trade/amend-algos", "OKX")[0]?.body as any;
  if (!amend || amend.algoId !== "sl-short" || amend.newSlTriggerPx !== "69000") throw new Error("dentro do stop devia mover o stop da perna: " + JSON.stringify(amend));
});

// Ajustes da escala: número de −1 a 1 (0 = igual); true é o formato antigo e não muda.
Deno.test("escala: distribuição e tamanho por número, sem quebrar o formato antigo", async () => {
  const { scalePrices, scaleWeights, skewArg } = __test as any;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  // 0 e false = igual
  const even = scalePrices(60000, 70000, 5, 0);
  if (!near(even[2], 65000)) throw new Error("igual: " + even);
  if (scaleWeights(even, 0).some((w: number) => w !== 1)) throw new Error("peso igual");
  // antigo: true continua t² e pesos 1..n
  const old = scalePrices(60000, 70000, 3, true);
  if (!near(old[1], 62500)) throw new Error("antigo mudou: " + old);
  if (scaleWeights(old, true).join() !== "1,2,3") throw new Error("peso antigo mudou");
  // + agrupa em cima: a ordem do meio sobe; − agrupa embaixo; pontas ficam
  const up = scalePrices(60000, 70000, 5, 0.8), down = scalePrices(60000, 70000, 5, -0.8);
  if (!(up[2] > 65000 && down[2] < 65000)) throw new Error("agrupar: " + up + " | " + down);
  if (!near(up[0], 60000) || !near(up[4], 70000)) throw new Error("pontas mudaram: " + up);
  // de cima para baixo (de > até): a 1ª ordem segue sendo o "de", e + continua agrupando perto do preço mais alto
  const rev = scalePrices(70000, 60000, 5, 0.8);
  if (!near(rev[0], 70000) || !near(rev[4], 60000) || !(rev[2] > 65000)) throw new Error("invertida: " + rev);
  // tamanho +: mais peso no preço mais alto, média sobe; −: média desce
  const avg = (ps: number[], ws: number[]) => ws.reduce((s, w) => s + w, 0) / ws.reduce((s, w, i) => s + w / ps[i], 0);
  const base = avg(even, scaleWeights(even, 0));
  if (!(avg(even, scaleWeights(even, 0.6)) > base && avg(even, scaleWeights(even, -0.6)) < base)) throw new Error("média não mexeu");
  // entrada: número, texto, fora da faixa, lixo
  if (skewArg(0.4) !== 0.4 || skewArg("-0.5") !== -0.5 || skewArg(3) !== 1 || skewArg("x") !== false || skewArg(true) !== true) throw new Error("skewArg");
});

// Carteira selecionada: com `accounts`, a ordem só lê e só envia nas carteiras pedidas; sem, vai para todas.
Deno.test("carteira selecionada: ordem só na carteira escolhida", async () => {
  const { setScope } = __test as any;
  const setup = () => {
    reset(); install();
    balances = { OKX: 1, OKX2: 1, OKX3: 1, OKX4: 1 };
    positions = {};
    algos = {};
  };
  const sentTo = (p: string) => [...new Set(hit(p).filter((c) => c.m === "POST").map((c) => c.P))].sort().join(",");

  setup(); setScope(["pupo"]);
  const one = await runSized("long", "limit", 63000, false, "usd", 400, null);
  if (one.aborted) throw new Error(String(one.abort_msg));
  if (sentTo("/api/v5/trade/order") !== "OKX") throw new Error("foi para: " + sentTo("/api/v5/trade/order"));
  if ((one.accounts as any[]).length !== 1) throw new Error("listou outras carteiras");
  // US$ 400 inteiros na pupo (sem dividir por 4)
  if ((hit("/api/v5/trade/order")[0].body as any).sz !== "4.0") throw new Error("tamanho: " + JSON.stringify(hit("/api/v5/trade/order")[0].body));

  setup(); setScope(["pai"]);
  const sc = await runScaleAmount("long", 60000, 62000, 4, 0, 0, false, "usd", 400, null);
  if (sc.aborted) throw new Error(String(sc.abort_msg));
  if (sentTo("/api/v5/trade/batch-orders") !== "OKX2") throw new Error("escala foi para: " + sentTo("/api/v5/trade/batch-orders"));

  setup(); setScope(null);
  const all = await runSized("long", "limit", 63000, false, "usd", 400, null);
  if (all.aborted) throw new Error(String(all.abort_msg));
  if (sentTo("/api/v5/trade/order") !== "OKX,OKX2,OKX3,OKX4") throw new Error("todas: " + sentTo("/api/v5/trade/order"));

  if (setScope(["fulano"]) !== "bad") throw new Error("carteira desconhecida passou");
  setScope(null);
});

// Escala de hedge além do stop do short: o stop fecha o short antes, então a escala parte de 0% e VENDE até o alvo.
// Antes ela partia do short de agora (112%) e mandava recompras acima do preço atual, que a OKX recusa.
Deno.test("escala de hedge além do stop: parte de 0% e vende até o alvo; recompra acima do preço é barrada", async () => {
  const { runHedgeScale } = __test as any;
  reset(); install();
  balances = { OKX: 0.009 };
  positions = { OKX: [leg("short", "6.4", "64914", "64100"), leg("long", "1.5", "63282", "64100")] };
  algos = { OKX: [algo("short", "sl-short", "65365"), algo("long", "sl-long", "61880")] };
  const setScope = (__test as any).setScope; setScope(["pupo"]);
  const r = await runHedgeScale(20, "short", 67316.7, 66240.1, 8, 0, 0, false, false);
  setScope(null);
  if (r.aborted) throw new Error(String(r.abort_msg));
  const rows = hit("/api/v5/trade/batch-orders", "OKX").flatMap((c) => c.body as any[]);
  if (!rows.length || rows.some((o) => o.side !== "sell" || o.posSide !== "short" || o.reduceOnly)) throw new Error("devia vender short: " + JSON.stringify(rows[0]));
  const total = rows.reduce((s, o) => s + Number(o.sz), 0);
  // 20% de 0,009 BTC × 64.100 = US$ 115 ≈ 1,2 ct (e não os 5,3 ct de recompra de antes)
  if (Math.abs(total - 1.2) > 1e-9) throw new Error("tamanho " + total);
  if (hit("/api/v5/trade/amend-algos").length || hit("/api/v5/trade/cancel-algos").length) throw new Error("mexeu no stop");
  if (!(r.accounts as any[])[0].after_stop) throw new Error("não marcou que parte depois do stop");

  // stop acima da escala: o short continua aberto, o alvo menor pede recompra, e recompra acima do preço atual não sai
  reset(); install();
  balances = { OKX: 0.009 };
  positions = { OKX: [leg("short", "6.4", "64914", "64100")] };
  algos = { OKX: [algo("short", "sl-short", "70000")] };
  setScope(["pupo"]);
  const bad = await runHedgeScale(20, "short", 67316.7, 66240.1, 8, 0, 0, false, false);
  setScope(null);
  if (!bad.aborted || !String(bad.abort_msg).includes("abaixo do preço atual")) throw new Error("devia barrar: " + bad.abort_msg);
  if (hit("/api/v5/trade/batch-orders").length) throw new Error("enviou recompra acima do preço");
});

// Stop anexado a uma ordem a limite pendente aparece como "stop vinculado"; cancelar limite usa cancel-order com ordId.
Deno.test("stop vinculado da ordem a limite aparece; cancelar limite pelo ordId", async () => {
  const { runCancel } = __test as any;
  reset(); install();
  calls = [];
  setReq(async (P, m, p, body) => {
    calls.push({ P, m, p, body });
    if (p.startsWith("/api/v5/public/mark-price")) return { code: "0", data: [{ markPx: "64100" }] };
    if (p.startsWith("/api/v5/account/balance")) return { code: "0", data: [{ details: [{ ccy: "BTC", eq: "1" }] }] };
    if (p.startsWith("/api/v5/account/positions")) return { code: "0", data: P === "OKX" ? [leg("short", "169.8", "64912", "64100")] : [] };
    if (p.startsWith("/api/v5/trade/orders-pending")) return { code: "0", data: P === "OKX" ? [{
      instId: "BTC-USD-SWAP", ordId: "L1", ordType: "limit", px: "66295.9", sz: "96.3", side: "sell", posSide: "short",
      attachAlgoOrds: [{ attachAlgoId: "A1", slTriggerPx: "66858.5", slOrdPx: "-1" }],
    }] : [] };
    if (p.startsWith("/api/v5/trade/orders-algo-pending")) return { code: "0", data: [] };
    if (p === "/api/v5/trade/cancel-order") return { code: "0", data: [{ sCode: "0", ordId: (body as any).ordId }] };
    return { code: "0", data: [] };
  });
  const pos = await fetchPositions();
  const okx = (pos.accounts as any[]).find((a) => a.prefix === "OKX");
  const linked = okx.orders.find((o: any) => o.kind === "linked");
  if (!linked || linked.price !== 66858.5 || linked.parentOrdId !== "L1" || linked.side !== "buy" || linked.posSide !== "short") throw new Error(JSON.stringify(linked));
  const c = await runCancel("OKX", "", false, "L1");
  if (c.aborted) throw new Error(String(c.abort_msg));
  const sent = calls.find((x) => x.p === "/api/v5/trade/cancel-order");
  if (!sent || (sent.body as any).ordId !== "L1" || (sent.body as any).instId !== "BTC-USD-SWAP") throw new Error(JSON.stringify(sent));
  if (calls.some((x) => x.p === "/api/v5/trade/cancel-algos")) throw new Error("cancelou algo em vez de limite");
});

// Hedge com gatilho: vira stop a mercado (order-algo trigger) e não mexe em nada agora.
Deno.test("hedge com gatilho vira stop a mercado; além do stop do short parte de 0%", async () => {
  const { runHedge, setScope } = __test as any;
  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("short", "1", "64000", "64100")] };
  algos = { OKX: [algo("short", "sl-short", "70000")] };
  setScope(["pupo"]);
  // abaixo do stop: short de agora (1 ct = 0,16%) → 50% de 1 BTC × 64.100 = 320,5 ct; vende 319,5 quando cair em 63.000
  const r = await runHedge(50, "short", "trigger", 63000, false, null, false);
  if (r.aborted) throw new Error(String(r.abort_msg));
  const t = hit("/api/v5/trade/order-algo", "OKX").map((c) => c.body as any).find((b) => b.ordType === "trigger");
  if (!t || t.side !== "sell" || t.posSide !== "short" || t.triggerPx !== "63000" || t.orderPx !== "-1" || t.reduceOnly) throw new Error(JSON.stringify(t));
  if (hit("/api/v5/trade/order").length) throw new Error("executou na hora");
  if (hit("/api/v5/trade/cancel-algos").length || hit("/api/v5/trade/amend-algos").length) throw new Error("mexeu nos stops");
  // além do stop (71.000 ≥ 70.000): o stop fecha o short antes; o hedge parte de 0
  reset(); install();
  balances = { OKX: 1 };
  positions = { OKX: [leg("short", "1", "64000", "64100")] };
  algos = { OKX: [algo("short", "sl-short", "70000")] };
  const r2 = await runHedge(50, "short", "trigger", 71000, false, null, false);
  setScope(null);
  if (r2.aborted) throw new Error(String(r2.abort_msg));
  const acc = (r2.accounts as any[])[0];
  if (!acc.after_stop || Math.abs(acc.delta_ct - acc.alvo_ct) > 1e-9) throw new Error(JSON.stringify(acc));
});
