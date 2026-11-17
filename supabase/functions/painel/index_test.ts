import { __test } from "./index.ts";

const { setReq, reset, ctFromRisk, lossBtc, hedgeNumbers, realizedPnlBtc, allocateReduce, splitLots, runOrder, runReduce, runScale, runScaleReduce, runAmend, runHedge } = __test;

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
  const prices = __test.scalePrices(63000, 64800, 10, false);
  const stop = 60000;
  let expect = 0;
  for (const price of prices) {
    const ct = ctFromRisk(1, price, stop, 1 / 10);
    if (ct >= 0.1) expect += lossBtc(ct, price, stop);
  }
  const dry = await runScale("long", stop, 1, 63000, 64800, 10, false, false, true);
  if (posts().length) throw new Error("dry enviou");
  const loss = (dry.accounts as any[]).find((a) => a.prefix === "OKX").loss_btc as number;
  if (Math.abs(loss - expect) > 1e-9) throw new Error(`perda ${loss} != ${expect}`);
  if (loss > 1 * 0.01 + 1e-8) throw new Error("perda passou do risco");
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
