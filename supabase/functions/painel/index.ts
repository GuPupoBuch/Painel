// Painel de ordens OKX (porta fiel de /workspace/okx/mkt.py, caminho sem --add).
// API JSON apenas; a página HTML é servida fora do supabase.co (que reescreve text/html).
// Rotas: POST /login, GET /session, GET /positions, POST /order, POST /adjust, POST /scale, POST /amend, POST /cancel, POST /logout.
// /order aceita ordType market|limit (como antes) e também trigger (stop a mercado) e chase.
// Tamanho por risco+stop segue igual. sizeMode usd|pct abre por valor ou % do saldo, sem exigir risco.
// Auth: token assinado (Authorization: Bearer) ~90 dias.

const INST = "BTC-USD-SWAP";
const CAP = 1000.0;
const ACC: [string, string][] = [["OKX", "pupo"], ["OKX2", "pai"], ["OKX3", "mãe"], ["OKX4", "tcheco"]];
// Carteiras da ordem em andamento (o painel manda `accounts` quando uma carteira está selecionada).
// Sem lista = todas. Aceita nome ("pupo") ou prefixo ("OKX"). As rotas de ordem rodam uma de cada vez (orderBusy),
// então o escopo vale só para o pedido atual e é limpo no finally.
let scope: string[] | null = null;
function accs(): [string, string][] {
  const s = scope;
  return s && s.length ? ACC.filter(([P, n]) => s.includes(P) || s.includes(n)) : ACC;
}
function accountScope(v: unknown): string[] | null | "bad" {
  if (v == null) return null;
  if (!Array.isArray(v)) return "bad";
  const list = v.map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return null;
  if (list.some((x) => !ACC.some(([P, n]) => P === x || n === x))) return "bad";
  return list;
}
const SESSION_DAYS = 90;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 5;

const env = (k: string) => Deno.env.get(k) ?? "";
const B = env("OKX_BASE") || "https://www.okx.com";
const enc = new TextEncoder();

// ---------- trava de ambiente ----------
// A OKX real exige TRÊS coisas ao mesmo tempo; o mock em loopback é sempre permitido:
//   1. destino: exatamente a origem https://www.okx.com (sem porta, caminho, query, fragmento ou credenciais);
//   2. detecção de execução hospedada (hostedMarkersPresent): global EdgeRuntime + SB_EXECUTION_ID (UUID)
//      + DENO_DEPLOYMENT_ID do projeto. São marcadores documentados do ambiente hospedado, NÃO prova
//      criptográfica: qualquer um pode defini-los. Só reduzem o risco de liberar a OKX por engano;
//   3. autorização para negociar (okxLiveAuthorized): OKX_LIVE_ENABLED exatamente "true".
// SUPABASE_URL não conta para nada. Localmente, a barreira obrigatória continua sendo o
// --allow-net=127.0.0.1 do tests/serve-painel.sh: o Deno recusa qualquer outro host.
type EnvGet = (k: string) => string;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OKX_REAL_HOST = "www.okx.com";
const PROJECT_REF = "krzznjwvcrbuhlfwsdel";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// {project_ref}_{function_id}_{version}: segmentos não vazios só com [A-Za-z0-9.-], separados por "_".
// Ancorada nas duas pontas; exige pelo menos function_id e version.
const DEPLOYMENT_ID_RE = new RegExp(`^${PROJECT_REF}_[A-Za-z0-9-]+(?:_[A-Za-z0-9.-]+)+$`);
// OKX real: só esta origem, comparada como texto exato (new URL() esconderia ":443" e aceitaria caminho/query).
const OKX_REAL_ORIGIN = "https://" + OKX_REAL_HOST;
// O Supabase Edge Runtime define o global EdgeRuntime (hospedado e também no supabase functions serve).
const IN_EDGE_RUNTIME = typeof (globalThis as Record<string, unknown>).EdgeRuntime !== "undefined";
// Detecção: só diz se parece execução hospedada. Não autoriza nada.
function hostedMarkersPresent(get: EnvGet, hasEdgeRuntime: boolean): boolean {
  if (!hasEdgeRuntime) return false;
  const exec = get("SB_EXECUTION_ID");
  const dep = get("DENO_DEPLOYMENT_ID"); // formato documentado: {project_ref}_{function_id}_{version}
  return UUID_RE.test(exec) && DEPLOYMENT_ID_RE.test(dep);
}
// Autorização: decisão explícita de negociar de verdade, independente da detecção.
const okxLiveAuthorized = (get: EnvGet) => get("OKX_LIVE_ENABLED") === "true";
function okxTargetAllowed(base: string, liveAuthorized: boolean, hosted: boolean): boolean {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  if (LOOPBACK.has(u.hostname)) return u.protocol === "http:" || u.protocol === "https:";
  // sem porta (nem :443), caminho, query, fragmento, usuário ou senha: o texto tem de ser exatamente a origem
  return liveAuthorized && hosted && base === OKX_REAL_ORIGIN;
}
const okxBaseOf = (get: EnvGet) => get("OKX_BASE") || OKX_REAL_ORIGIN;
function okxAllowedByEnv(get: EnvGet, hasEdgeRuntime: boolean): boolean {
  return okxTargetAllowed(okxBaseOf(get), okxLiveAuthorized(get), hostedMarkersPresent(get, hasEdgeRuntime));
}
// Diagnóstico da trava, só com a FORMA dos valores: letras viram "a", dígitos viram "9", o resto fica.
// Nenhum valor real sai no log (nem ids, nem a flag, nem OKX_BASE). Não muda nenhuma decisão da trava.
const shapeOf = (s: string) => s.replace(/[A-Za-z]/g, "a").replace(/[0-9]/g, "9");
function okxEnvDiagnostics(get: EnvGet, hasEdgeRuntime: boolean) {
  const exec = get("SB_EXECUTION_ID");
  const dep = get("DENO_DEPLOYMENT_ID");
  const flag = get("OKX_LIVE_ENABLED");
  const base = get("OKX_BASE");
  return {
    edgeRuntime: hasEdgeRuntime,
    execId: { present: exec !== "", len: exec.length, uuidOk: UUID_RE.test(exec), shape: shapeOf(exec) },
    deploymentId: {
      present: dep !== "", len: dep.length, refPrefixOk: dep.startsWith(PROJECT_REF + "_"),
      formatOk: DEPLOYMENT_ID_RE.test(dep), segments: dep === "" ? 0 : dep.split("_").length, shape: shapeOf(dep),
    },
    liveFlag: { present: flag !== "", exactTrue: flag === "true", looseTrue: flag.trim().toLowerCase() === "true" },
    okxBase: { present: base !== "", exactOrigin: base === "" || base === OKX_REAL_ORIGIN },
    hosted: hostedMarkersPresent(get, hasEdgeRuntime),
    allowed: okxAllowedByEnv(get, hasEdgeRuntime),
  };
}

// ---------- crypto ----------
async function hmacRaw(key: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, "0")).join("");
function safeEq(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

// ---------- OKX ----------
type J = Record<string, any>;
let req = async function req(P: string, m: string, p: string, body?: unknown): Promise<J> {
  if (!okxTargetAllowed(B, okxLiveAuthorized(env), hostedMarkersPresent(env, IN_EDGE_RUNTIME))) {
    throw new Error(`OKX bloqueada (${B}): fora do ambiente hospedado ou sem OKX_LIVE_ENABLED=true só o mock em loopback é permitido`);
  }
  // mesmo timestamp ISO ms + 'Z' e assinatura ts+method+path+body do mkt.py
  const ts = new Date().toISOString();
  const b = body ? JSON.stringify(body) : "";
  const sig = b64(await hmacRaw(env(P + "_API_SECRET"), ts + m + p + b));
  const h: Record<string, string> = {
    "OK-ACCESS-KEY": env(P + "_API_KEY"), "OK-ACCESS-SIGN": sig, "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": env(P + "_API_PASSPHRASE"), "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 hedge-bot",
  };
  const r = await fetch(B + p, { method: m, headers: h, body: b || undefined, signal: AbortSignal.timeout(8000) });
  const t = await r.text();
  try { return t ? JSON.parse(t) : {}; } catch { return { code: String(r.status), msg: t.slice(0, 200) }; }
};
function okxErr(r: J, what: string): Error {
  return new Error(`${what}: code ${r.code ?? "?"} ${r.msg ?? ""}`.trim());
}
async function eq_of(P: string): Promise<number> {
  const r = await req(P, "GET", "/api/v5/account/balance?ccy=BTC");
  const det = r?.data?.[0]?.details;
  if (!Array.isArray(det)) throw okxErr(r, "saldo");
  const d = det.filter((x: J) => x.ccy === "BTC");
  if (!d.length) throw new Error("saldo: sem BTC");
  return parseFloat(d[0].eq);
}
async function pos_of(P: string): Promise<[number, number, number]> {
  // hedge mode (long_short): soma pernas com sinal; long +, short -
  const r = await req(P, "GET", "/api/v5/account/positions?instId=" + INST);
  if (!Array.isArray(r?.data)) throw okxErr(r, "posições");
  const d = r.data.filter((x: J) => x.instId === INST && parseFloat(x.pos || "0") !== 0);
  if (!d.length) return [0, 0, 0];
  const net = d.reduce((s: number, x: J) => s + parseFloat(x.pos) * (x.posSide === "short" ? -1 : 1), 0);
  const mx = d.reduce((a: J, x: J) => (Math.abs(parseFloat(x.pos)) > Math.abs(parseFloat(a.pos)) ? x : a), d[0]);
  return [net, parseFloat(mx.avgPx || "0"), parseFloat(mx.markPx || "0")];
}
async function conds(P: string): Promise<J[]> {
  const r = await req(P, "GET", "/api/v5/trade/orders-algo-pending?ordType=conditional&instType=SWAP");
  if (!Array.isArray(r?.data)) throw okxErr(r, "stops");
  return r.data.filter((x: J) => x.instId === INST);
}
// Trigger e chase não derrubam a leitura da conta se a OKX recusar o ordType.
async function algosOf(P: string, ordType: string): Promise<J[]> {
  try {
    const r = await req(P, "GET", "/api/v5/trade/orders-algo-pending?ordType=" + ordType + "&instId=" + INST);
    if (!Array.isArray(r?.data)) return [];
    return r.data.filter((x: J) => x.instId === INST && (x.ordType == null || x.ordType === "" || x.ordType === ordType));
  } catch {
    return [];
  }
}
async function markPx(): Promise<number> {
  const r = await req("OKX", "GET", "/api/v5/public/mark-price?instId=" + INST);
  const v = parseFloat(r?.data?.[0]?.markPx);
  if (!(v > 0)) throw okxErr(r, "mark");
  return v;
}
// Python '%g' (6 algarismos significativos, sem zeros à direita)
const pyG = (x: number) => String(parseFloat(x.toPrecision(6)));
const pxTick = (x: number) => Math.round(x * 10) / 10;
const pxStr = (x: number) => {
  const t = pxTick(x);
  return Number.isInteger(t) ? String(t) : t.toFixed(1);
};
const szStr = (ct: number) => (Math.round(ct * 10) / 10).toFixed(1);
function venueMsg(row: J | null | undefined, top: J | null | undefined): string {
  const code = row && row.sCode != null && String(row.sCode) !== "0" ? String(row.sCode) : "";
  const msg = (row && (row.sMsg || row.msg)) || (top && top.msg) || "";
  return [code, msg].filter(Boolean).join(" ") || "perna recusada";
}
function accBrief(accounts: J[] | undefined): string[] {
  return (accounts || []).map((a) => {
    const why = a.error ? ":" + String(a.error).replace(/\s+/g, " ").slice(0, 160) : "";
    return `${a.name}=${a.status}${why}`;
  });
}
async function priceBand(): Promise<{ buy: number; sell: number } | null> {
  try {
    const r = await req("OKX", "GET", "/api/v5/public/price-limit?instId=" + INST);
    const d = r?.data?.[0];
    if (!d || d.enabled === false) return null;
    const buy = parseFloat(d.buyLmt);
    const sell = parseFloat(d.sellLmt);
    if (!(buy > 0) || !(sell > 0) || !(sell < buy)) return null;
    return { buy, sell };
  } catch {
    return null;
  }
}
// buyLmt é o máximo de uma compra. sellLmt é o mínimo de uma venda.
// Compra abaixo do mark e venda acima do mark são ordens normais e passam.
function pricesOutside(prices: number[], band: { buy: number; sell: number } | null, buying: boolean): string | null {
  if (!band) return null;
  const bad = prices.filter((p) => buying ? p > band.buy + 1e-9 : p < band.sell - 1e-9);
  if (!bad.length) return null;
  const show = [...new Set(bad.map(pxStr))].slice(0, 4).join(", ");
  const rule = buying ? `compra acima de ${pxStr(band.buy)}` : `venda abaixo de ${pxStr(band.sell)}`;
  return `Preço fora do limite da OKX (${rule}). Fora: ${show}. Nada foi enviado.`;
}
type Side = "long" | "short";
type Leg = { posSide: Side; pos: number; avg: number; mark: number; upl: number };
const floor01 = (x: number) => Math.trunc(x / 0.1 + 1e-9) / 10;
function roundLot(ct: number): number {
  return Math.round(ct * 10 + 1e-9) / 10;
}
function clampLot(requested: number, pos: number): number {
  if (!(requested > 0) || !(pos >= 0.1)) return 0;
  const ct = Math.min(pos, roundLot(requested));
  return ct >= 0.1 - 1e-9 ? ct : 0;
}
// PnL realizado de contrato inverso (ctVal 100 USD). USD ≈ BTC * preço de saída.
function realizedPnlBtc(ct: number, entry: number, exit: number, side: Side): number {
  if (!(ct > 0) || !(entry > 0) || !(exit > 0)) return 0;
  const inv = side === "long" ? (1 / entry - 1 / exit) : (1 / exit - 1 / entry);
  return ct * 100 * inv;
}
// Mesmo % da perna em cada conta. Arredonda no lote 0,1 e não passa da perna nem do total pedido.
function allocateReduce(legs: { key: string; pos: number }[], totalCt: number): { key: string; ct: number }[] {
  const usable = legs.map((l) => ({ key: l.key, pos: l.pos > 0 ? l.pos : 0 }));
  const sum = usable.reduce((s, l) => s + l.pos, 0);
  if (!(sum > 0) || !(totalCt > 0)) return usable.map((l) => ({ key: l.key, ct: 0 }));
  const pct = Math.min(100, (totalCt / sum) * 100);
  const cts = usable.map((l) => {
    if (pct >= 100 - 1e-9) return { key: l.key, ct: roundLot(l.pos) };
    const ct = Math.min(l.pos, roundLot(l.pos * pct / 100));
    return { key: l.key, ct: ct >= 0.1 - 1e-9 ? ct : 0 };
  });
  const cap = pct >= 100 - 1e-9 ? roundLot(sum) : roundLot(sum * pct / 100);
  let extra = roundLot(cts.reduce((s, r) => s + r.ct, 0) - cap);
  let guard = 0;
  while (extra >= 0.1 - 1e-9 && guard++ < 1000) {
    const idx = (guard - 1) % cts.length;
    if (cts[idx].ct >= 0.1 - 1e-9) {
      cts[idx].ct = roundLot(cts[idx].ct - 0.1);
      if (cts[idx].ct < 0.1 - 1e-9) cts[idx].ct = 0;
      extra = roundLot(extra - 0.1);
    }
  }
  return cts.map((r) => ({ key: r.key, ct: r.ct >= 0.1 - 1e-9 ? r.ct : 0 }));
}
function splitLots(total: number, weights: number[]): number[] {
  if (!weights.length || !(total > 0)) return weights.map(() => 0);
  const capped = roundLot(total);
  const wsum = weights.reduce((s, w) => s + (w > 0 ? w : 0), 0) || 1;
  const cts = weights.map((w) => {
    const ct = roundLot(capped * (w > 0 ? w : 0) / wsum);
    return ct >= 0.1 - 1e-9 ? ct : 0;
  });
  let extra = roundLot(cts.reduce((s, c) => s + c, 0) - capped);
  let i = cts.length - 1;
  let guard = 0;
  while (Math.abs(extra) >= 0.1 - 1e-9 && guard++ < 1000) {
    const step = extra > 0 ? -0.1 : 0.1;
    const next = roundLot(cts[i] + step);
    if (next >= -1e-9 && (step > 0 || cts[i] >= 0.1 - 1e-9)) {
      cts[i] = next >= 0.1 - 1e-9 ? next : 0;
      extra = roundLot(extra + step);
    }
    i = (i - 1 + cts.length) % cts.length;
  }
  return cts.map((c) => (c >= 0.1 - 1e-9 ? c : 0));
}
function contractMap(raw: unknown): Record<string, number> | null {
  if (raw == null) return null;
  const out: Record<string, number> = {};
  const put = (key: string, v: unknown) => {
    const ct = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
    if (key && Number.isFinite(ct) && ct > 0) out[key] = ct;
  };
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (!row || typeof row !== "object") continue;
      const rec = row as J;
      put(String(rec.name ?? rec.prefix ?? "").trim(), rec.ct);
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as J)) put(String(k).trim(), v);
  }
  return Object.keys(out).length ? out : null;
}
const isCf1 = (x: J) => { const c = String(x.closeFraction ?? ""); return c === "1" || parseFloat(c) === 1; };
// Stop atual da perna (o cf=1; senão o primeiro stop com gatilho).
function legStopPx(cs: J[], side: Side): number | null {
  const mine = cs.filter((x) => x.posSide === side);
  const s = mine.find(isCf1) ?? mine.find((x) => parseFloat(x.slTriggerPx) > 0) ?? null;
  const v = parseFloat(s?.slTriggerPx ?? "");
  return v > 0 ? v : null;
}
// A ordem de abertura só executa depois que o preço passa do stop atual da perna (short: no stop ou acima; long: no stop ou abaixo).
function beyondLegStop(side: Side, price: number, legStop: number | null): boolean {
  if (legStop == null || !(legStop > 0) || !(price > 0)) return false;
  return side === "short" ? price >= legStop : price <= legStop;
}
// "Aumentar a perna" (stop da perna é movido para o stop novo) só quando a perna existe e a ordem pode executar com ela aberta.
// Se todas as entradas estão além do stop atual, o stop atual fecha a perna antes: é posição nova, com o stop novo grudado
// na ordem, e o stop atual fica como está.
function addsToLeg(legs: Leg[], cs: J[], side: Side, entries: number[]): boolean {
  if (!legs.some((l) => l.posSide === side && l.pos > 0)) return false;
  const s = legStopPx(cs, side);
  return !(entries.length > 0 && entries.every((p) => beyondLegStop(side, p, s)));
}
function ctFromRisk(eq: number, entry: number, stop: number, riskPct: number): number {
  if (!(eq > 0) || !(entry > 0) || !(stop > 0) || !(riskPct > 0)) return 0;
  const den = Math.abs(100 * (1 / entry - 1 / stop));
  if (!(den > 0)) return 0;
  return Math.trunc(eq * (riskPct / 100) / den / 0.1 + 1e-9) / 10;
}
// % do saldo em USD da conta. ctVal 100: contratos = eq * mark * pct / 100 / 100, truncados no lote 0,1.
function ctFromEquityPct(eq: number, mark: number, pct: number): number {
  if (!(eq > 0) || !(mark > 0) || !(pct > 0)) return 0;
  const usd = eq * mark * (pct / 100);
  return Math.trunc(usd / 100 / 0.1 + 1e-9) / 10;
}
function orderSide(posSide: Side, reduce: boolean): "buy" | "sell" {
  if (reduce) return posSide === "long" ? "sell" : "buy";
  return posSide === "long" ? "buy" : "sell";
}
function ratioFromPct(pct: number): string {
  return String(parseFloat((pct / 100).toPrecision(8)));
}
type SizeMode = "usd" | "pct" | "risk" | "contracts";
function stopGuarded(posSide: Side, stop: number, entry: number, market: boolean): boolean {
  if (!(stop > 0) || !(entry > 0)) return false;
  if (!market) return stopOnSide(posSide, stop, entry);
  return posSide === "short" ? entry < stop * 0.999 : entry > stop * 1.001;
}
function lossBtc(ct: number, entry: number, stop: number): number {
  return ct * 100 * Math.abs(1 / entry - 1 / stop);
}
function stopOnSide(posSide: Side, stop: number, ref: number): boolean {
  return posSide === "long" ? stop < ref : stop > ref;
}
async function legsOf(P: string): Promise<Leg[]> {
  const r = await req(P, "GET", "/api/v5/account/positions?instId=" + INST);
  if (!Array.isArray(r?.data)) throw okxErr(r, "posições");
  return r.data.filter((x: J) => x.instId === INST && Math.abs(parseFloat(x.pos || "0")) > 0).map((x: J) => ({
    posSide: (x.posSide === "short" ? "short" : "long") as Side,
    pos: Math.abs(parseFloat(x.pos || "0")),
    avg: parseFloat(x.avgPx || "0"),
    mark: parseFloat(x.markPx || "0"),
    upl: parseFloat(x.upl || "0"),
  }));
}
async function pendingLimits(P: string): Promise<J[]> {
  const r = await req(P, "GET", "/api/v5/trade/orders-pending?instType=SWAP&instId=" + INST);
  if (!Array.isArray(r?.data)) throw okxErr(r, "ordens");
  return r.data.filter((x: J) => x.instId === INST);
}
function algosFor(cs: J[], posSide: Side): J[] {
  return cs.filter((x) => x.posSide === posSide);
}

// ---------- posições ----------
async function fetchPositions() {
  const mark = await markPx();
  const accounts = await Promise.all(ACC.map(async ([P, name]) => {
    try {
      const [eq, legs, cs, limits, triggers, chases] = await Promise.all([
        eq_of(P), legsOf(P), conds(P), pendingLimits(P), algosOf(P, "trigger"), algosOf(P, "chase"),
      ]);
      const net = legs.reduce((s, l) => s + l.pos * (l.posSide === "short" ? -1 : 1), 0);
      const mx = legs.reduce((a: Leg | null, l) => (!a || l.pos > a.pos ? l : a), null);
      const avg = mx ? mx.avg : 0;
      const mk = (mx && mx.mark) || mark;
      const expo = eq > 0 && mk > 0 ? Math.abs(net) * 100 / (eq * mk) * 100 : 0;
      const stops = cs.map((x) => parseFloat(x.slTriggerPx)).filter((v) => v > 0);
      const legRows = legs.map((l) => ({
        posSide: l.posSide, ct: l.pos, usd: l.pos * 100, avg: l.avg, upl: l.upl,
        stops: algosFor(cs, l.posSide).map((x) => ({
          algoId: x.algoId ?? null, slTriggerPx: parseFloat(x.slTriggerPx), closeFraction: x.closeFraction ?? null,
        })).filter((s) => s.slTriggerPx > 0),
      }));
      const orders = [
        ...limits.map((o) => ({
          kind: "limit", ordId: o.ordId ?? null, price: parseFloat(o.px), sz: parseFloat(o.sz),
          side: o.side ?? null, posSide: o.posSide ?? null, reduceOnly: o.reduceOnly === true || o.reduceOnly === "true",
        })),
        ...cs.map((x) => ({
          kind: "stop", algoId: x.algoId ?? null, price: parseFloat(x.slTriggerPx),
          posSide: x.posSide ?? null, closeFraction: x.closeFraction ?? null, slTriggerPx: parseFloat(x.slTriggerPx),
        })).filter((s) => s.price > 0),
        ...triggers.map((x) => ({
          kind: "trigger", algoId: x.algoId ?? null, price: parseFloat(x.triggerPx),
          posSide: x.posSide ?? null, side: x.side ?? null, sz: parseFloat(x.sz || "0"),
          reduceOnly: x.reduceOnly === true || x.reduceOnly === "true",
          triggerPxType: x.triggerPxType || "last",
        })).filter((s) => s.price > 0),
        ...chases.map((x) => ({
          kind: "chase", algoId: x.algoId ?? null, price: null,
          posSide: x.posSide ?? null, side: x.side ?? null, sz: parseFloat(x.sz || "0"),
          reduceOnly: x.reduceOnly === true || x.reduceOnly === "true",
          chaseType: x.chaseType ?? null, chaseVal: x.chaseVal ?? null,
          maxChaseType: x.maxChaseType ?? null, maxChaseVal: x.maxChaseVal ?? null,
        })),
      ];
      return { prefix: P, name, net, avg, mark: mk, eq, expo, side: net > 0 ? "long" : net < 0 ? "short" : "zerada", stops, legs: legRows, orders, error: null };
    } catch (e) {
      return { prefix: P, name, net: 0, avg: 0, mark, eq: 0, expo: 0, side: "erro", stops: [], legs: [], orders: [], error: "falha ao ler: " + String((e as Error).message || e).slice(0, 160) };
    }
  }));
  return { mark, accounts };
}

// ---------- ordem (mkt.py sem --add; limite opcional) ----------
let orderBusy = false;
async function runOrder(side: "long" | "short", STOP: number, riskPct: number, dry: boolean, ordType: "market" | "limit" = "market", price: number | null = null) {
  const t0 = Date.now();
  const RISK = riskPct / 100;
  const lines: string[] = [];
  const out: J = { side, stop: STOP, risk: riskPct, dry, ordType, price: ordType === "limit" ? price : null, aborted: false, abort_msg: null, accounts: [], warning: false };
  const mark = await markPx();
  out.mark = mark;
  const entry = ordType === "limit" ? price : mark;
  if (!(entry != null && entry > 0)) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  if (ordType === "limit") {
    if (side === "short" && STOP <= entry) return { ...out, aborted: true, abort_msg: `ABORT stop abaixo/igual ao preço limite ${entry}` };
    if (side === "long" && STOP >= entry) return { ...out, aborted: true, abort_msg: `ABORT stop acima/igual ao preço limite ${entry}` };
  } else {
    if (side === "short" && mark >= STOP * 0.999) return { ...out, aborted: true, abort_msg: `ABORT stop abaixo/colado no mark ${mark}` };
    if (side === "long" && mark <= STOP * 1.001) return { ...out, aborted: true, abort_msg: `ABORT stop acima/colado no mark ${mark}` };
  }
  const den = Math.abs(100 * (1 / entry - 1 / STOP));
  const stp = pyG(STOP);
  const R = await Promise.all(accs().map(async ([P, n]) => {
    try {
      const [eq, legs, cs] = await Promise.all([eq_of(P), legsOf(P), conds(P)]);
      const gross = legs.reduce((s, l) => s + l.pos, 0);
      const ps = legs.reduce((s, l) => s + l.pos * (l.posSide === "short" ? -1 : 1), 0);
      const ct = ctFromRisk(eq, entry, STOP, riskPct);
      const expo = eq > 0 && mark > 0 ? (gross + ct) * 100 / (eq * mark) * 100 : 0;
      const adding = addsToLeg(legs, cs, side, [entry]);
      let err: string | null = null;
      if (eq <= 0) err = "saldo zerado";
      else if (expo > CAP) err = `expo ${expo.toFixed(0)}% > teto`;
      else if (ct < 0.1) err = "tamanho < 0.1 ct";
      return { P, n, eq, ps, ct, expo, err, adding };
    } catch (e) {
      return { P, n, eq: 0, ps: 0, ct: 0, expo: 0, err: "falha ao ler conta: " + String((e as Error).message || e).slice(0, 120), adding: false };
    }
  }));
  const head = ordType === "limit" ? `limite ${pyG(entry)}  mark ${mark.toFixed(1)}` : `mark ${mark.toFixed(1)}`;
  lines.push(`${head}  stop ${stp}  risco ${(RISK * 100).toFixed(2)}%  prep ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const r of R) lines.push(` ${r.P.padEnd(6)} eq ${r.eq.toFixed(6)} ct ${r.ct.toFixed(1)} (US$ ${(r.ct * 100).toFixed(0)}) expo ${r.expo.toFixed(1)}% ${r.err ?? "ok"}`);
  const lossBtc = (ct: number) => ct * 100 * Math.abs(1 / entry - 1 / STOP);
  out.accounts = R.map((r) => ({ prefix: r.P, name: r.n, ct: r.ct, size_usd: r.ct * 100, avg: null, expo: r.expo, loss_btc: r.err ? null : lossBtc(r.ct), loss_usd: r.err ? null : lossBtc(r.ct) * mark, status: r.err ? "bloqueado" : "ok", error: r.err }));
  out.warning = R.some((r) => r.expo > 100);
  if (dry) { lines.push("DRY: nada enviado"); out.raw = lines.join("\n"); return out; }
  if (R.some((r) => r.err)) { lines.push("ABORT: nenhuma ordem enviada"); out.raw = lines.join("\n"); return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" }; }
  const os_side = side === "short" ? "sell" : "buy";
  const t1 = Date.now();
  const O = await Promise.all(R.map(async (r) => {
    try {
      const body: J = {
        instId: INST, tdMode: "cross", side: os_side, posSide: side, ordType, sz: r.ct.toFixed(1),
      };
      // perna nova: o stop nasce grudado na ordem, como antes. Perna que já existe: o stop cf=1 cobre a perna inteira e é movido depois.
      if (!r.adding) body.attachAlgoOrds = [{ slTriggerPx: stp, slOrdPx: "-1", slTriggerPxType: "mark" }];
      if (ordType === "limit") body.px = pyG(entry);
      const e = await req(r.P, "POST", "/api/v5/trade/order", body);
      const d0 = (e.data && e.data[0]) || {};
      const placed = e.code === "0" && d0.sCode === "0";
      if (placed && r.adding) {
        const moved = await ensureCf1(r.P, side, STOP);
        if (moved.err) return { code: "0", sCode: "stop", sMsg: "entrou; stop: " + moved.err };
      }
      const d = (e.data && e.data[0]) || {};
      return { code: e.code ?? null, sCode: d.sCode ?? null, sMsg: d.sMsg ?? e.msg ?? null };
    } catch (e) {
      return { code: "net", sCode: null, sMsg: String((e as Error).message || e).slice(0, 120) };
    }
  }));
  lines.push(`envio ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  const V = await Promise.all(R.map(async (r) => {
    try {
      const [[ps, avg, mk], eq] = await Promise.all([pos_of(r.P), eq_of(r.P)]);
      const loss = avg ? Math.abs(ps) * 100 * Math.abs(1 / avg - 1 / STOP) : 0;
      return { ps, avg, eq, mk: mk || mark, loss, err: null as string | null };
    } catch (e) {
      return { ps: 0, avg: 0, eq: 0, mk: mark, loss: 0, err: String((e as Error).message || e).slice(0, 120) };
    }
  }));
  let tl = 0;
  out.accounts = R.map((r, i) => {
    const o = O[i], v = V[i];
    tl += v.loss;
    const ok = o.code === "0" && o.sCode === "0";
    const expo = v.mk && v.eq ? Math.abs(v.ps) * 100 / (v.eq * v.mk) * 100 : 0;
    lines.push(` ${r.P.padEnd(6)} [${o.code},${o.sCode},${o.sMsg}] | pos ${v.ps.toFixed(1)} avg ${v.avg.toFixed(1)} eq ${v.eq.toFixed(6)} expo ${expo.toFixed(1)}% perda ${v.loss.toFixed(7)} BTC (US$ ${(v.loss * v.mk).toFixed(2)})`);
    return { prefix: r.P, name: r.n, ct: Math.abs(v.ps), size_usd: Math.abs(v.ps) * 100, avg: v.avg, expo, loss_btc: v.loss, loss_usd: v.loss * v.mk, status: ok ? "ok" : "falhou", error: ok ? (v.err ? "enviada; leitura falhou" : null) : `ordem recusada: ${o.sMsg || o.code}`, entry: o };
  });
  lines.push(`TOTAL perda ${tl.toFixed(7)} BTC (US$ ${(tl * mark).toFixed(2)})  tempo total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  out.warning = out.accounts.some((a: J) => a.expo > 100);
  out.raw = lines.join("\n");
  if (out.accounts.some((a: J) => a.status !== "ok")) { out.aborted = true; out.abort_msg = "Alguma conta não entrou. Confira a tabela."; }
  return out;
}

// ---------- ajuste (reduz posição aberta; nunca abre perna nova) ----------
async function pos_leg(P: string, want?: Side | null): Promise<{ side: "long" | "short" | null; pos: number; avg: number; mark: number; err: string | null }> {
  const r = await req(P, "GET", "/api/v5/account/positions?instId=" + INST);
  if (!Array.isArray(r?.data)) throw okxErr(r, "posições");
  const d = r.data.filter((x: J) => x.instId === INST && parseFloat(x.pos || "0") !== 0);
  const pick = (x: J) => {
    const side = x.posSide === "short" ? "short" as const : "long" as const;
    return { side, pos: Math.abs(parseFloat(x.pos)), avg: parseFloat(x.avgPx || "0"), mark: parseFloat(x.markPx || "0"), err: null };
  };
  if (want === "long" || want === "short") {
    const x = d.find((row: J) => (row.posSide === "short" ? "short" : "long") === want);
    return x ? pick(x) : { side: null, pos: 0, avg: 0, mark: 0, err: null };
  }
  if (!d.length) return { side: null, pos: 0, avg: 0, mark: 0, err: null };
  if (d.length > 1) return { side: null, pos: 0, avg: 0, mark: 0, err: "Escolha long ou short" };
  return pick(d[0]);
}
function pickStop(cs: J[], posSide: "long" | "short"): { cf1: J | null; others: J[]; trigger: number | null } {
  const mine = cs.filter((x) => !x.posSide || x.posSide === posSide);
  const cf1 = mine.find(isCf1) ?? null;
  const others = mine.filter((x) => !isCf1(x));
  const from = (x: J | null) => { const v = x ? parseFloat(x.slTriggerPx) : NaN; return v > 0 ? v : null; };
  const trigger = from(cf1) ?? (others.map((x) => parseFloat(x.slTriggerPx)).find((v) => v > 0) ?? null);
  return { cf1, others, trigger };
}

async function runAdjust(pct: number, ordType: "market" | "limit", price: number | null, dry: boolean, posSide: Side | null = null) {
  const t0 = Date.now();
  const lines: string[] = [];
  const out: J = { pct, ordType, posSide, price: ordType === "limit" ? price : null, dry, aborted: false, abort_msg: null, accounts: [], warning: false };
  const mark = await markPx();
  out.mark = mark;
  if (ordType === "limit" && !(price != null && price > 0)) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  const R = await Promise.all(accs().map(async ([P, n]) => {
    try {
      const [eq, leg, cs] = await Promise.all([eq_of(P), pos_leg(P, posSide), conds(P)]);
      const mk = leg.mark || mark;
      if (leg.err) return { P, n, eq, mk, side: null as "long" | "short" | null, pos: 0, avg: 0, ct: 0, expoAfter: 0, st: pickStop(cs, posSide || "long"), fillWarn: false, err: leg.err, skip: false };
      if (!leg.side || !(leg.pos > 0)) return { P, n, eq, mk, side: null, pos: 0, avg: 0, ct: 0, expoAfter: 0, st: pickStop(cs, "long"), fillWarn: false, err: "zerada", skip: true };
      const pos = leg.pos;
      const ct = pct >= 100 - 1e-9 ? pos : Math.min(pos, floor01(pos * pct / 100));
      const remain = Math.max(0, Math.round((pos - ct) * 10) / 10);
      const expoAfter = eq > 0 && mk > 0 ? remain * 100 / (eq * mk) * 100 : 0;
      const st = pickStop(cs, leg.side);
      const needsStop = !(pct >= 100 - 1e-9 && ordType === "market"); // 100% a mercado zera; limite ainda precisa de stop enquanto não preenche
      let err: string | null = null;
      if (ct < 0.1) err = "tamanho < 0.1 ct";
      else if (needsStop && st.trigger == null) err = "sem stop existente; não reduzo pra não deixar desprotegido";
      const fillWarn = ordType === "limit" && price != null && (
        (leg.side === "long" && price <= mk) || (leg.side === "short" && price >= mk)
      );
      return { P, n, eq, mk, side: leg.side, pos, avg: leg.avg, ct, expoAfter, st, fillWarn, err, skip: false };
    } catch (e) {
      return { P, n, eq: 0, mk: mark, side: null as "long" | "short" | null, pos: 0, avg: 0, ct: 0, expoAfter: 0, st: { cf1: null, others: [], trigger: null }, fillWarn: false, err: "falha ao ler conta: " + String((e as Error).message || e).slice(0, 120), skip: false };
    }
  }));
  const head = ordType === "limit" ? `ajuste ${pct}% limite ${pyG(price!)}  mark ${mark.toFixed(1)}` : `ajuste ${pct}% mercado  mark ${mark.toFixed(1)}`;
  lines.push(`${head}  prep ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const accRow = (r: typeof R[number], extra: J = {}) => {
    let stopAction: string | null = null;
    if (r.skip) stopAction = null;
    else if (pct >= 100 - 1e-9 && ordType === "market") stopAction = "zerar e cancelar stops";
    else if (r.st.cf1) stopAction = "manter cf=1";
    else if (r.st.trigger != null) stopAction = "colocar cf=1";
    return {
      prefix: r.P, name: r.n, side: r.side, avg: r.avg || null,
      pos_before: r.pos, pos_before_usd: r.pos * 100,
      close_ct: r.ct, close_usd: r.ct * 100,
      pos_after: r.skip ? 0 : Math.max(0, Math.round((r.pos - r.ct) * 10) / 10),
      expo_after: r.expoAfter, stop: r.st.trigger, stop_action: stopAction,
      fill_warn: r.fillWarn,
      status: r.skip ? "zerada" : r.err ? "bloqueado" : "ok",
      error: r.skip ? null : r.err,
      ...extra,
    };
  };
  out.accounts = R.map((r) => accRow(r));
  for (const r of R) {
    const tag = r.skip ? "zerada" : r.err ?? "ok";
    lines.push(` ${r.P.padEnd(6)} ${r.side ?? "—"} ${r.pos.toFixed(1)} ct fecha ${r.ct.toFixed(1)} (US$ ${(r.ct * 100).toFixed(0)}) resta ${(r.skip ? 0 : Math.max(0, r.pos - r.ct)).toFixed(1)} expo ${r.expoAfter.toFixed(1)}% stop ${r.st.trigger ?? "—"} ${tag}${r.fillWarn ? " (preço cruza o mark)" : ""}`);
  }
  out.warning = R.some((r) => r.fillWarn);
  if (out.warning) out.warn_msg = "Preço limite cruzaria o mark e pode preencher na hora.";
  if (R.some((r) => r.err === "Escolha long ou short")) {
    lines.push("ABORT: escolha a perna");
    out.raw = lines.join("\n");
    return { ...out, aborted: true, abort_msg: "Escolha long ou short" };
  }
  const actionable = R.filter((r) => !r.skip);
  if (!actionable.length) { lines.push("ABORT: nenhuma conta com posição aberta"); out.raw = lines.join("\n"); return { ...out, aborted: true, abort_msg: "Nenhuma conta com posição aberta." }; }
  if (dry) { lines.push("DRY: nada enviado"); out.raw = lines.join("\n"); return out; }
  const sendable = R.filter((r) => !r.skip && !r.err);
  if (!sendable.length) { lines.push("ABORT: nenhuma ordem enviada"); out.raw = lines.join("\n"); return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" }; }

  const ensureStop = async (r: typeof R[number], afterMarketClose: boolean) => {
    // after a full market close, just cancel leftovers when flat; otherwise keep/place a single cf=1
    if (afterMarketClose && pct >= 100 - 1e-9) {
      const cs = r.side ? algosFor(await conds(r.P), r.side) : await conds(r.P);
      const dup = cs.filter((x) => x.algoId).map((x) => ({ algoId: x.algoId, instId: INST }));
      let cancel: J | null = null;
      if (dup.length) cancel = await req(r.P, "POST", "/api/v5/trade/cancel-algos", dup);
      return { kept: false, placed: false, cancel: cancel?.code ?? null, err: null as string | null, trigger: r.st.trigger };
    }
    if (r.st.cf1) {
      const leftovers = r.st.others.filter((x) => x.algoId).map((x) => ({ algoId: x.algoId, instId: INST }));
      let cancel: J | null = null;
      if (leftovers.length) cancel = await req(r.P, "POST", "/api/v5/trade/cancel-algos", leftovers);
      return { kept: true, placed: false, cancel: cancel?.code ?? null, err: null as string | null, trigger: r.st.trigger };
    }
    if (r.st.trigger == null) return { kept: false, placed: false, cancel: null, err: "sem stop existente", trigger: null };
    const clSide = r.side === "short" ? "buy" : "sell";
    const s = await req(r.P, "POST", "/api/v5/trade/order-algo", {
      instId: INST, tdMode: "cross", side: clSide, posSide: r.side, ordType: "conditional",
      closeFraction: "1", reduceOnly: true, slTriggerPx: pyG(r.st.trigger), slOrdPx: "-1", slTriggerPxType: "mark",
    });
    const sd = (s.data && s.data[0]) || {};
    const ok = s.code === "0" && (sd.sCode == null || sd.sCode === "0");
    if (!ok) return { kept: false, placed: false, cancel: null, err: `falha ao colocar cf=1: ${sd.sMsg || s.msg || s.code}`, trigger: r.st.trigger };
    const cs = r.side ? algosFor(await conds(r.P), r.side) : await conds(r.P);
    const dup = cs.filter((x) => !isCf1(x) && x.algoId).map((x) => ({ algoId: x.algoId, instId: INST }));
    let cancel: J | null = null;
    if (dup.length) cancel = await req(r.P, "POST", "/api/v5/trade/cancel-algos", dup);
    return { kept: false, placed: true, cancel: cancel?.code ?? null, err: null as string | null, trigger: r.st.trigger };
  };

  const t1 = Date.now();
  const O = await Promise.all(R.map(async (r) => {
    if (r.skip || r.err) return { sent: false, code: null, sCode: null, sMsg: null, stop: null as J | null };
    try {
      const osSide = r.side === "short" ? "buy" : "sell";
      const body: J = {
        instId: INST, tdMode: "cross", side: osSide, posSide: r.side, reduceOnly: true,
        ordType, sz: (Math.round(r.ct * 10) / 10).toFixed(1),
      };
      if (ordType === "limit") body.px = pyG(price!);
      // limite: coloca/confirma o cf=1 na hora de lançar a redução (posição ainda aberta)
      let stop: J | null = null;
      if (ordType === "limit") stop = await ensureStop(r, false);
      if (ordType === "limit" && stop?.err) return { sent: false, code: null, sCode: null, sMsg: stop.err, stop };
      const e = await req(r.P, "POST", "/api/v5/trade/order", body);
      const d = (e.data && e.data[0]) || {};
      const ok = e.code === "0" && d.sCode === "0";
      if (ordType === "market" && ok) {
        // espera a redução entrar antes de mexer no stop, se ainda sobra posição
        if (pct < 100 - 1e-9) {
          const t = Date.now();
          while (Date.now() - t < 20000) {
            const leg = await pos_leg(r.P, r.side);
            if (leg.pos <= r.pos - r.ct + 1e-9) break;
            await new Promise((res) => setTimeout(res, 300));
          }
        } else {
          const t = Date.now();
          while (Date.now() - t < 20000) {
            const leg = await pos_leg(r.P, r.side);
            if (!leg.side || leg.pos < 0.1) break;
            await new Promise((res) => setTimeout(res, 300));
          }
        }
        stop = await ensureStop(r, true);
      }
      return { sent: true, code: e.code ?? null, sCode: d.sCode ?? null, sMsg: d.sMsg ?? e.msg ?? null, stop };
    } catch (e) {
      return { sent: true, code: "net", sCode: null, sMsg: String((e as Error).message || e).slice(0, 120), stop: null as J | null };
    }
  }));
  lines.push(`envio ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  out.accounts = R.map((r, i) => {
    const o = O[i];
    const row = accRow(r, { entry: o.sent ? { code: o.code, sCode: o.sCode, sMsg: o.sMsg } : null, stop_result: o.stop });
    if (r.skip) { lines.push(` ${r.P.padEnd(6)} zerada`); return row; }
    if (r.err) { lines.push(` ${r.P.padEnd(6)} bloqueado ${r.err}`); return row; }
    const ok = o.code === "0" && o.sCode === "0";
    const stopErr = o.stop && o.stop.err;
    row.status = ok && !stopErr ? "ok" : "falhou";
    row.error = ok ? (stopErr ? `reduziu; stop: ${stopErr}` : null) : `ordem recusada: ${o.sMsg || o.code}`;
    lines.push(` ${r.P.padEnd(6)} [${o.code},${o.sCode},${o.sMsg}] fecha ${r.ct.toFixed(1)} stop ${o.stop ? JSON.stringify(o.stop) : "—"}`);
    return row;
  });
  lines.push(`tempo total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  out.raw = lines.join("\n");
  if (out.accounts.some((a: J) => a.status === "falhou")) { out.aborted = true; out.abort_msg = "Alguma conta não ajustou. Confira a tabela."; }
  return out;
}

// SL anexado na ordem limite. A OKX ativa quando a ordem executa; não exige posição aberta.
// slTriggerPxType "mark" é o mesmo padrão da ordem única (runOrder / runSized).
function attachSl(trigger: number): J[] {
  return [{ slTriggerPx: pyG(trigger), slOrdPx: "-1", slTriggerPxType: "mark" }];
}
// Move ou cria o stop cf=1 SÓ da perna pedida. A perna oposta não entra no cancelamento.
// Sem posição, não chama a OKX: close-fraction responde "Position doesn't exist" e derrubava a escala.
async function ensureCf1(P: string, posSide: Side, trigger: number): Promise<{ err: string | null }> {
  const open = await legsOf(P);
  if (!open.some((l) => l.posSide === posSide && l.pos > 0)) return { err: null };
  const stp = pyG(trigger);
  const cs = algosFor(await conds(P), posSide);
  const cf1 = cs.find(isCf1) ?? null;
  const others = cs.filter((x) => x !== cf1 && x.algoId);
  const place = async () => {
    const clSide = posSide === "short" ? "buy" : "sell";
    const s = await req(P, "POST", "/api/v5/trade/order-algo", {
      instId: INST, tdMode: "cross", side: clSide, posSide, ordType: "conditional",
      closeFraction: "1", reduceOnly: true, slTriggerPx: stp, slOrdPx: "-1", slTriggerPxType: "mark",
    });
    const sd = (s.data && s.data[0]) || {};
    const ok = s.code === "0" && (sd.sCode == null || sd.sCode === "0");
    return ok ? null : `falha ao colocar cf=1: ${sd.sMsg || s.msg || s.code}`;
  };
  if (cf1?.algoId) {
    const a = await req(P, "POST", "/api/v5/trade/amend-algos", {
      instId: INST, algoId: cf1.algoId, newSlTriggerPx: stp, newSlOrdPx: "-1", newSlTriggerPxType: "mark",
    });
    const ad = (a.data && a.data[0]) || {};
    const ok = a.code === "0" && (ad.sCode == null || ad.sCode === "0");
    if (!ok) return { err: `falha ao mover o stop: ${venueMsg(ad, a)}` };
  } else {
    const err = await place();
    if (err) return { err };
  }
  if (others.length) {
    await req(P, "POST", "/api/v5/trade/cancel-algos", others.map((x) => ({ algoId: x.algoId, instId: INST })));
  }
  return { err: null };
}

async function runReduce(legSide: Side, pct: number, ordType: "market" | "limit", price: number | null, dry: boolean, contracts: Record<string, number> | null = null) {
  const t0 = Date.now();
  const lines: string[] = [];
  const out: J = { reduce: true, side: legSide, pct, contracts: contracts || null, ordType, price: ordType === "limit" ? price : null, dry, aborted: false, abort_msg: null, accounts: [], warning: false };
  const mark = await markPx();
  out.mark = mark;
  if (ordType === "limit" && !(price != null && price > 0)) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  const R = await Promise.all(accs().map(async ([P, n]) => {
    const emptyStop = { cf1: null as J | null, others: [] as J[], trigger: null as number | null };
    try {
      const [eq, legs, cs] = await Promise.all([eq_of(P), legsOf(P), conds(P)]);
      const leg = legs.find((l) => l.posSide === legSide && l.pos > 0) ?? null;
      const mk = leg?.mark || mark;
      if (!leg) return { P, n, eq, mk, pos: 0, avg: 0, ct: 0, st: pickStop(algosFor(cs, legSide), legSide), fillWarn: false, err: `sem perna ${legSide}`, skip: true, absent: false };
      if (contracts && (contracts[n] ?? contracts[P]) == null) {
        return { P, n, eq, mk, pos: leg.pos, avg: leg.avg, ct: 0, st: pickStop(algosFor(cs, legSide), legSide), fillWarn: false, err: null as string | null, skip: true, absent: true };
      }
      const ct = contracts
        ? clampLot(contracts[n] ?? contracts[P], leg.pos)
        : (pct >= 100 - 1e-9 ? leg.pos : Math.min(leg.pos, floor01(leg.pos * pct / 100)));
      const st = pickStop(algosFor(cs, legSide), legSide);
      const closingAll = ct >= leg.pos - 1e-9;
      const needsStop = !(closingAll && ordType === "market");
      let err: string | null = null;
      if (ct < 0.1) err = "tamanho < 0.1 ct";
      else if (needsStop && st.trigger == null) err = "sem stop existente; não reduzo pra não deixar desprotegido";
      const fillWarn = ordType === "limit" && price != null && ((legSide === "long" && price <= mk) || (legSide === "short" && price >= mk));
      return { P, n, eq, mk, pos: leg.pos, avg: leg.avg, ct, st, fillWarn, err, skip: false, absent: false };
    } catch (e) {
      return { P, n, eq: 0, mk: mark, pos: 0, avg: 0, ct: 0, st: emptyStop, fillWarn: false, err: "falha ao ler conta: " + String((e as Error).message || e).slice(0, 120), skip: false, absent: false };
    }
  }));
  lines.push(`reduz ${legSide} ${pct}% ${ordType} ${ordType === "limit" ? pyG(price!) : "mercado"}  mark ${mark.toFixed(1)}`);
  const rowOf = (r: typeof R[number], extra: J = {}) => ({
    prefix: r.P, name: r.n, side: legSide, avg: r.avg || null,
    pos_before: r.pos, close_ct: r.ct, close_usd: r.ct * 100, size_usd: r.ct * 100,
    pos_after: r.skip ? r.pos : Math.max(0, Math.round((r.pos - r.ct) * 10) / 10),
    stop: r.st.trigger, fill_warn: r.fillWarn,
    status: r.absent ? "fora" : r.skip ? "sem perna" : r.err ? "bloqueado" : "ok",
    error: r.absent ? null : r.skip ? `sem perna ${legSide}` : r.err,
    ...extra,
  });
  out.accounts = R.map((r) => rowOf(r));
  for (const r of R) lines.push(` ${r.P.padEnd(6)} ${legSide} ${r.pos.toFixed(1)} fecha ${r.ct.toFixed(1)} ${r.absent ? "fora" : r.skip ? "sem perna" : r.err ?? "ok"}`);
  out.warning = R.some((r) => r.fillWarn);
  if (out.warning) out.warn_msg = "Preço limite cruzaria o mark e pode preencher na hora.";
  if (!R.some((r) => !r.skip)) {
    lines.push("ABORT: nenhuma conta com essa perna");
    out.raw = lines.join("\n");
    const msg = R.some((r) => r.absent) && !R.some((r) => !r.absent) ? "Nenhum tamanho para reduzir." : `Nenhuma conta com perna ${legSide}.`;
    return { ...out, aborted: true, abort_msg: msg };
  }
  if (dry) { lines.push("DRY: nada enviado"); out.raw = lines.join("\n"); return out; }
  const sendable = R.filter((r) => !r.skip && !r.err);
  if (!sendable.length) { out.raw = lines.join("\n"); return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" }; }
  const osSide = legSide === "long" ? "sell" : "buy";
  const O = await Promise.all(R.map(async (r) => {
    if (r.skip || r.err) return { code: null as string | null, sCode: null as string | null, sMsg: null as string | null, stopErr: null as string | null };
    try {
      const full = r.ct >= r.pos - 1e-9 && ordType === "market";
      if (!full && r.st.cf1?.algoId) {
        const leftovers = r.st.others.filter((x) => x.algoId).map((x) => ({ algoId: x.algoId, instId: INST }));
        if (leftovers.length) await req(r.P, "POST", "/api/v5/trade/cancel-algos", leftovers);
      } else if (!full && r.st.trigger != null && !r.st.cf1) {
        const placed = await ensureCf1(r.P, legSide, r.st.trigger);
        if (placed.err) return { code: null, sCode: null, sMsg: placed.err, stopErr: placed.err };
      }
      const body: J = { instId: INST, tdMode: "cross", side: osSide, posSide: legSide, reduceOnly: true, ordType, sz: (Math.round(r.ct * 10) / 10).toFixed(1) };
      if (ordType === "limit") body.px = pyG(price!);
      const e = await req(r.P, "POST", "/api/v5/trade/order", body);
      const d = (e.data && e.data[0]) || {};
      const ok = e.code === "0" && d.sCode === "0";
      let stopErr: string | null = null;
      if (ok && full) {
        const mine = algosFor(await conds(r.P), legSide).filter((x) => x.algoId).map((x) => ({ algoId: x.algoId, instId: INST }));
        if (mine.length) await req(r.P, "POST", "/api/v5/trade/cancel-algos", mine);
      }
      return { code: e.code ?? null, sCode: d.sCode ?? null, sMsg: d.sMsg ?? e.msg ?? null, stopErr };
    } catch (e) {
      return { code: "net", sCode: null, sMsg: String((e as Error).message || e).slice(0, 120), stopErr: null };
    }
  }));
  out.accounts = R.map((r, i) => {
    const o = O[i];
    const row = rowOf(r, { entry: { code: o.code, sCode: o.sCode, sMsg: o.sMsg } });
    if (r.skip || r.err) return row;
    const ok = o.code === "0" && o.sCode === "0" && !o.stopErr;
    row.status = ok ? "ok" : "falhou";
    row.error = ok ? null : (o.stopErr || `ordem recusada: ${o.sMsg || o.code}`);
    lines.push(` ${r.P.padEnd(6)} [${o.code},${o.sCode},${o.sMsg}]`);
    return row;
  });
  lines.push(`tempo ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  out.raw = lines.join("\n");
  if (out.accounts.some((a: J) => a.status === "falhou")) { out.aborted = true; out.abort_msg = "Alguma conta não reduziu. Confira a tabela."; }
  return out;
}

function harmonicAvg(prices: number[], weights: number[]): number {
  let wsum = 0, inv = 0;
  for (let i = 0; i < prices.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (!(prices[i] > 0) || !(w > 0)) continue;
    wsum += w;
    inv += w / prices[i];
  }
  return inv > 0 ? wsum / inv : 0;
}
// Risco da escala inteira, entre a média harmônica (contrato inverso) e o stop.
// Tamanho igual: mesmos contratos. Crescente: os pesos 1..n, no mesmo risco total.
function scaleRiskLots(eq: number, prices: number[], stop: number, riskPct: number, sizeSkew: Skew): { avg: number; cts: number[] } {
  const weights = scaleWeights(prices, sizeSkew);
  const avg = harmonicAvg(prices, weights);
  const total = ctFromRisk(eq, avg, stop, riskPct);
  const cap = eq * (riskPct / 100);
  const lossOf = (cts: number[]) => cts.reduce((s, ct, i) => s + (ct >= 0.1 ? lossBtc(ct, prices[i], stop) : 0), 0);
  if (!skewOn(sizeSkew)) {
    const each = Math.floor(total / prices.length / 0.1 + 1e-9) * 0.1;
    const cts = prices.map(() => each);
    let rem = roundLot(total - each * prices.length);
    while (rem >= 0.1 - 1e-9) {
      const i = cts.length - 1;
      cts[i] = roundLot(cts[i] + 0.1);
      if (lossOf(cts) > cap + 1e-9) { cts[i] = roundLot(Math.max(0, cts[i] - 0.1)); break; }
      rem = roundLot(rem - 0.1);
    }
    return { avg, cts };
  }
  const cts = splitLots(total, weights);
  let guard = 0;
  while (lossOf(cts) > cap + 1e-9 && guard++ < 1000) {
    let idx = -1, dens = -1;
    for (let i = 0; i < cts.length; i++) {
      if (cts[i] < 0.1) continue;
      const per = lossBtc(0.1, prices[i], stop);
      if (per > dens) { dens = per; idx = i; }
    }
    if (idx < 0) break;
    cts[idx] = roundLot(cts[idx] - 0.1);
    if (cts[idx] < 0.1 - 1e-9) cts[idx] = 0;
  }
  return { avg, cts };
}
// Ajustes da escala. Número de −1 a 1 (0 = igual). `true` é o formato antigo e continua igual a antes.
// Distribuição: + agrupa as ordens perto do preço mais alto, − perto do mais baixo.
// Tamanho: + põe mais valor nas ordens de preço mais alto (a média sobe), − nas mais baixas (a média desce).
type Skew = boolean | number;
function skewArg(v: unknown): Skew {
  if (v === true || v === false) return v;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return false;
  return Math.max(-1, Math.min(1, n));
}
const skewOn = (s: Skew) => s === true || (typeof s === "number" && s !== 0);
function scalePrices(from: number, to: number, n: number, priceSkew: Skew): number[] {
  const out: number[] = [];
  if (typeof priceSkew === "number" && priceSkew !== 0) {
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const g = Math.pow(3, -priceSkew);
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : i / (n - 1);
      out.push(lo + (hi - lo) * Math.pow(t, g));
    }
    return from <= to ? out : out.reverse();
  }
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const u = priceSkew === true ? t * t : t;
    out.push(from + (to - from) * u);
  }
  return out;
}
function scaleWeights(prices: number[], sizeSkew: Skew): number[] {
  if (sizeSkew === true) return prices.map((_, i) => i + 1);
  if (typeof sizeSkew !== "number" || sizeSkew === 0 || !prices.length) return prices.map(() => 1);
  const lo = Math.min(...prices), hi = Math.max(...prices), span = hi - lo || 1;
  return prices.map((p) => Math.exp(1.5 * sizeSkew * (((p - lo) / span) * 2 - 1)));
}

async function cancelBatch(P: string, ids: string[]) {
  for (let i = 0; i < ids.length; i += 20) {
    const slice = ids.slice(i, i + 20).map((ordId) => ({ instId: INST, ordId }));
    if (slice.length) await req(P, "POST", "/api/v5/trade/cancel-batch-orders", slice);
  }
}

async function runScale(side: Side, stop: number, riskPct: number, from: number, to: number, n: number, priceSkew: Skew, sizeSkew: Skew, dry: boolean) {
  const t0 = Date.now();
  const lines: string[] = [];
  const out: J = { side, stop, risk: riskPct, from, to, n, priceSkew, sizeSkew, dry, aborted: false, abort_msg: null, accounts: [], warning: false };
  if (!(n >= 2 && n <= 50)) return { ...out, aborted: true, abort_msg: "A escala precisa de 2 a 50 ordens." };
  if (!(from > 0) || !(to > 0) || from === to) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  if (!(stop > 0)) return { ...out, aborted: true, abort_msg: "Stop inválido." };
  const prices = scalePrices(from, to, n, priceSkew).map(pxTick);
  const bandMsg = pricesOutside(prices, await priceBand(), side === "long");
  if (bandMsg) return { ...out, aborted: true, abort_msg: bandMsg };
  if (prices.some((p) => !stopOnSide(side, stop, p))) {
    return { ...out, aborted: true, abort_msg: side === "long" ? "No long, o stop precisa ficar abaixo de todas as pernas." : "No short, o stop precisa ficar acima de todas as pernas." };
  }
  const mark = await markPx();
  out.mark = mark;
  const weights = scaleWeights(prices, sizeSkew);
  out.avg = harmonicAvg(prices, weights);
  const osSide = side === "short" ? "sell" : "buy";
  const R = await Promise.all(accs().map(async ([P, name]) => {
    try {
      const [eq, legs, cs] = await Promise.all([eq_of(P), legsOf(P), conds(P)]);
      const gross = legs.reduce((s, l) => s + l.pos, 0);
      const sized = scaleRiskLots(eq, prices, stop, riskPct, sizeSkew);
      const planned = prices.map((price, i) => {
        const ct = sized.cts[i] || 0;
        return { price, ct, loss: ct >= 0.1 ? lossBtc(ct, price, stop) : 0 };
      });
      const legsOk = planned.filter((l) => l.ct >= 0.1);
      const loss = legsOk.reduce((s, l) => s + l.loss, 0);
      const addCt = legsOk.reduce((s, l) => s + l.ct, 0);
      const expo = eq > 0 && mark > 0 ? (gross + addCt) * 100 / (eq * mark) * 100 : 0;
      const adding = addsToLeg(legs, cs, side, legsOk.map((l) => l.price));
      let err: string | null = null;
      if (eq <= 0) err = "saldo zerado";
      else if (!legsOk.length) err = "tamanho < 0.1 ct";
      else if (expo > CAP) err = `expo ${expo.toFixed(0)}% > teto`;
      return { P, name, eq, legs: planned, legsOk, loss, addCt, expo, adding, err };
    } catch (e) {
      return { P, name, eq: 0, legs: [], legsOk: [], loss: 0, addCt: 0, expo: 0, adding: false, err: "falha ao ler conta: " + String((e as Error).message || e).slice(0, 120) };
    }
  }));
  out.accounts = R.map((r) => ({
    prefix: r.P, name: r.name, eq: r.eq, ct: r.addCt, size_usd: r.addCt * 100,
    loss_btc: r.err ? null : r.loss, loss_usd: r.err ? null : r.loss * mark, expo: r.expo,
    legs: r.legsOk.map((l) => ({ price: l.price, ct: l.ct, usd: l.ct * 100, loss_btc: l.loss })),
    skipped: r.legs.filter((l) => l.ct < 0.1).length,
    status: r.err ? "bloqueado" : "ok", error: r.err,
  }));
  lines.push(`escala ${side} ${n} pernas ${pyG(from)}→${pyG(to)} stop ${pyG(stop)} risco ${riskPct}%`);
  for (const r of R) lines.push(` ${r.P.padEnd(6)} ct ${r.addCt.toFixed(1)} perda ${(r.loss).toFixed(7)} ${r.err ?? "ok"}`);
  if (dry) { lines.push("DRY: nada enviado"); out.raw = lines.join("\n"); return out; }
  if (!R.some((r) => !r.err)) { out.raw = lines.join("\n"); return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" }; }
  const O = await Promise.all(R.map(async (r) => {
    if (r.err) return { ok: false, msg: r.err, placed: [] as string[] };
    const placed: string[] = [];
    let fail = "";
    for (let i = 0; i < r.legsOk.length; i += 20) {
      const chunk = r.legsOk.slice(i, i + 20).map((l) => {
        const order: J = {
          instId: INST, tdMode: "cross", side: osSide, posSide: side, ordType: "limit",
          sz: szStr(l.ct), px: pxStr(l.price),
        };
        if (!r.adding) order.attachAlgoOrds = attachSl(stop);
        return order;
      });
      const e = await req(r.P, "POST", "/api/v5/trade/batch-orders", chunk);
      const data = Array.isArray(e.data) ? e.data : [];
      let bad = e.code !== "0" && e.code !== "2";
      data.forEach((d: J) => {
        if (d && d.sCode === "0" && d.ordId) placed.push(String(d.ordId));
        else { bad = true; fail = fail || venueMsg(d, e); }
      });
      if (!data.length && e.code !== "0") { bad = true; fail = fail || venueMsg(null, e); }
      if (bad) {
        if (placed.length) await cancelBatch(r.P, placed);
        return { ok: false, msg: fail || "perna recusada", placed: [] as string[] };
      }
    }
    if (r.adding) {
      const stopRes = await ensureCf1(r.P, side, stop);
      if (stopRes.err) {
        if (placed.length) await cancelBatch(r.P, placed);
        return { ok: false, msg: stopRes.err, placed: [] as string[] };
      }
    }
    return { ok: true, msg: null as string | null, placed };
  }));
  out.accounts = R.map((r, i) => {
    const o = O[i];
    const row = out.accounts[i];
    if (r.err) return row;
    row.status = o.ok ? "ok" : "falhou";
    row.error = o.ok ? null : o.msg;
    row.ordIds = o.placed;
    lines.push(` ${r.P.padEnd(6)} ${o.ok ? "ok" : "rollback " + o.msg}`);
    return row;
  });
  lines.push(`tempo ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  out.raw = lines.join("\n");
  if (out.accounts.some((a: J) => a.status === "falhou")) { out.aborted = true; out.abort_msg = "Alguma conta não entrou na escala. O que tinha sido enviado nessa conta foi cancelado."; }
  return out;
}

// Escala reduce-only. Sem `reduce` no /scale, runScale segue igual. Sem stop e sem risco.
async function runScaleReduce(side: Side, from: number, to: number, n: number, priceSkew: Skew, sizeSkew: Skew, pct: number | null, contracts: Record<string, number> | null, dry: boolean) {
  const out: J = { reduce: true, scale: true, side, from, to, n, priceSkew, sizeSkew, pct, dry, aborted: false, abort_msg: null, accounts: [], warning: false };
  if (!(n >= 2 && n <= 50)) return { ...out, aborted: true, abort_msg: "A escala precisa de 2 a 50 ordens." };
  if (!(from > 0) || !(to > 0) || from === to) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  const prices = scalePrices(from, to, n, priceSkew).map(pxTick);
  const bandMsg = pricesOutside(prices, await priceBand(), side === "short");
  if (bandMsg) return { ...out, aborted: true, abort_msg: bandMsg };
  const weights = scaleWeights(prices, sizeSkew);
  const mark = await markPx();
  out.mark = mark;
  const osSide = side === "long" ? "sell" : "buy";
  const R = await Promise.all(accs().map(async ([P, name]) => {
    const emptyStop = { cf1: null as J | null, others: [] as J[], trigger: null as number | null };
    try {
      const [legs, cs] = await Promise.all([legsOf(P), conds(P)]);
      const leg = legs.find((l) => l.posSide === side && l.pos > 0) ?? null;
      const st = leg ? pickStop(algosFor(cs, side), side) : emptyStop;
      if (!leg) return { P, name, pos: 0, avg: 0, ct: 0, parts: [] as { price: number; ct: number }[], st, err: `sem perna ${side}`, skip: true, absent: false, fillWarn: false };
      if (contracts && (contracts[name] ?? contracts[P]) == null) {
        return { P, name, pos: leg.pos, avg: leg.avg, ct: 0, parts: [] as { price: number; ct: number }[], st, err: null as string | null, skip: true, absent: true, fillWarn: false };
      }
      const total = contracts
        ? clampLot(contracts[name] ?? contracts[P], leg.pos)
        : (pct != null && pct >= 100 - 1e-9 ? leg.pos : Math.min(leg.pos, floor01(leg.pos * (pct || 0) / 100)));
      const parts = splitLots(total, weights).map((ct, i) => ({ price: prices[i], ct })).filter((p) => p.ct >= 0.1);
      const ct = roundLot(parts.reduce((s, p) => s + p.ct, 0));
      let err: string | null = null;
      if (ct < 0.1) err = "tamanho < 0.1 ct";
      else if (st.trigger == null) err = "sem stop existente; não reduzo pra não deixar desprotegido";
      const mk = leg.mark || mark;
      const fillWarn = parts.some((p) => (side === "long" && p.price <= mk) || (side === "short" && p.price >= mk));
      return { P, name, pos: leg.pos, avg: leg.avg, ct, parts, st, err, skip: false, absent: false, fillWarn };
    } catch (e) {
      return { P, name, pos: 0, avg: 0, ct: 0, parts: [] as { price: number; ct: number }[], st: emptyStop, err: "falha ao ler conta: " + String((e as Error).message || e).slice(0, 120), skip: false, absent: false, fillWarn: false };
    }
  }));
  out.accounts = R.map((r) => ({
    prefix: r.P, name: r.name, side, avg: r.avg || null, pos_before: r.pos,
    close_ct: r.ct, close_usd: r.ct * 100, size_usd: r.ct * 100,
    legs: r.parts.map((p) => ({ price: p.price, ct: p.ct, usd: p.ct * 100 })),
    status: r.absent ? "fora" : r.skip ? "sem perna" : r.err ? "bloqueado" : "ok",
    error: r.absent ? null : r.skip ? r.err : r.err,
    fill_warn: r.fillWarn,
  }));
  out.warning = R.some((r) => r.fillWarn);
  if (out.warning) out.warn_msg = "Preço limite cruzaria o mark e pode preencher na hora.";
  if (!R.some((r) => !r.skip)) {
    out.raw = "ABORT";
    const msg = R.every((r) => r.absent || r.skip) && R.some((r) => r.absent) && !R.some((r) => !r.absent && r.skip)
      ? "Nenhum tamanho para reduzir."
      : `Nenhuma conta com perna ${side}.`;
    return { ...out, aborted: true, abort_msg: R.some((r) => !r.absent) ? `Nenhuma conta com perna ${side}.` : msg };
  }
  if (dry) { out.raw = "DRY: nada enviado"; return out; }
  const sendable = R.filter((r) => !r.skip && !r.err);
  if (!sendable.length) { out.raw = "ABORT"; return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" }; }
  const O = await Promise.all(R.map(async (r) => {
    if (r.skip || r.err) return { ok: false, skipped: true, msg: r.err, placed: [] as string[] };
    if (r.st.trigger != null && !r.st.cf1) {
      const placedStop = await ensureCf1(r.P, side, r.st.trigger);
      if (placedStop.err) return { ok: false, skipped: false, msg: placedStop.err, placed: [] as string[] };
    } else if (r.st.cf1?.algoId && r.st.others.length) {
      const leftovers = r.st.others.filter((x) => x.algoId).map((x) => ({ algoId: x.algoId, instId: INST }));
      if (leftovers.length) await req(r.P, "POST", "/api/v5/trade/cancel-algos", leftovers);
    }
    const placed: string[] = [];
    let fail = "";
    for (let i = 0; i < r.parts.length; i += 20) {
      const chunk = r.parts.slice(i, i + 20).map((l) => ({
        instId: INST, tdMode: "cross", side: osSide, posSide: side, ordType: "limit",
        reduceOnly: true, sz: szStr(l.ct), px: pxStr(l.price),
      }));
      const e = await req(r.P, "POST", "/api/v5/trade/batch-orders", chunk);
      const data = Array.isArray(e.data) ? e.data : [];
      let bad = e.code !== "0" && e.code !== "2";
      data.forEach((d: J) => {
        if (d && d.sCode === "0" && d.ordId) placed.push(String(d.ordId));
        else { bad = true; fail = fail || venueMsg(d, e); }
      });
      if (!data.length && e.code !== "0") { bad = true; fail = fail || venueMsg(null, e); }
      if (bad) {
        if (placed.length) await cancelBatch(r.P, placed);
        return { ok: false, skipped: false, msg: fail || "perna recusada", placed: [] as string[] };
      }
    }
    return { ok: true, skipped: false, msg: null as string | null, placed };
  }));
  out.accounts = R.map((r, i) => {
    const base = out.accounts[i];
    const o = O[i];
    if (r.skip || r.err) return base;
    base.status = o.ok ? "ok" : "falhou";
    base.error = o.ok ? null : o.msg;
    base.ordIds = o.placed;
    return base;
  });
  out.raw = dry ? "DRY: nada enviado" : "enviado";
  if (out.accounts.some((a: J) => a.status === "falhou")) {
    out.aborted = true;
    out.abort_msg = "Alguma conta não reduziu na escala. O que tinha sido enviado nessa conta foi cancelado.";
  }
  return out;
}

async function runAmend(kind: "limit" | "stop" | "trigger", prefix: string, id: string, newPx: number, dry: boolean, triggerPxType?: string | null) {
  const acc = ACC.find(([P]) => P === prefix);
  const out: J = { kind, account: prefix, id, newPx, dry, aborted: false, abort_msg: null };
  if (!acc) return { ...out, aborted: true, abort_msg: "Conta desconhecida." };
  if (!(newPx > 0)) return { ...out, aborted: true, abort_msg: "Preço inválido." };
  if (kind === "trigger") {
    const [triggers, mark] = await Promise.all([algosOf(prefix, "trigger"), markPx()]);
    const algo = triggers.find((x) => String(x.algoId) === id);
    if (!algo) return { ...out, aborted: true, abort_msg: "Stop não encontrado." };
    const posSide: Side = algo.posSide === "short" ? "short" : "long";
    const reduceOnly = algo.reduceOnly === true || algo.reduceOnly === "true";
    const pxType = triggerPxType === "mark" || algo.triggerPxType === "mark" ? "mark" : "last";
    out.posSide = posSide;
    out.mark = mark;
    out.reduceOnly = reduceOnly;
    if (reduceOnly && !stopOnSide(posSide, newPx, mark)) return { ...out, aborted: true, abort_msg: "Stop ficaria do lado errado do mark." };
    if (dry) { out.raw = "DRY: nada enviado"; return out; }
    const e = await req(prefix, "POST", "/api/v5/trade/amend-algos", {
      instId: INST, algoId: id, newTriggerPx: pyG(newPx), newOrdPx: "-1", newTriggerPxType: pxType,
    });
    const d = (e.data && e.data[0]) || {};
    const ok = e.code === "0" && (d.sCode == null || d.sCode === "0");
    out.ok = ok;
    if (!ok) { out.aborted = true; out.abort_msg = d.sMsg || e.msg || "não alterou o stop"; }
    return out;
  }
  if (kind === "stop") {
    const [cs, legs, mark] = await Promise.all([conds(prefix), legsOf(prefix), markPx()]);
    const algo = cs.find((x) => String(x.algoId) === id);
    if (!algo) return { ...out, aborted: true, abort_msg: "Stop não encontrado." };
    const posSide: Side = algo.posSide === "short" ? "short" : "long";
    const leg = legs.find((l) => l.posSide === posSide);
    const entry = leg && leg.avg > 0 ? leg.avg : mark;
    const markOk = stopOnSide(posSide, newPx, mark);
    const entryOk = stopOnSide(posSide, newPx, entry);
    out.posSide = posSide;
    out.mark = mark;
    out.entry = entry;
    if (!markOk || !entryOk) return { ...out, aborted: true, abort_msg: "Stop ficaria do lado errado da entrada ou do mark." };
    if (dry) { out.raw = "DRY: nada enviado"; return out; }
    const e = await req(prefix, "POST", "/api/v5/trade/amend-algos", {
      instId: INST, algoId: id, newSlTriggerPx: pyG(newPx), newSlOrdPx: "-1", newSlTriggerPxType: "mark",
    });
    const d = (e.data && e.data[0]) || {};
    const ok = e.code === "0" && (d.sCode == null || d.sCode === "0");
    out.ok = ok;
    if (!ok) { out.aborted = true; out.abort_msg = d.sMsg || e.msg || "não alterou o stop"; }
    return out;
  }
  if (dry) { out.raw = "DRY: nada enviado"; return out; }
  const e = await req(prefix, "POST", "/api/v5/trade/amend-order", { instId: INST, ordId: id, newPx: pyG(newPx) });
  const d = (e.data && e.data[0]) || {};
  const ok = e.code === "0" && (d.sCode == null || d.sCode === "0");
  out.ok = ok;
  if (!ok) { out.aborted = true; out.abort_msg = d.sMsg || e.msg || "não alterou a ordem"; }
  return out;
}

const CT_VAL = 100;
function hedgeNumbers(eq: number, mark: number, longCt: number, shortCt: number, targetPct: number, mode: "short" | "net") {
  const valor = eq * mark;
  const longUsd = longCt * CT_VAL;
  const shortUsd = shortCt * CT_VAL;
  let hedgePct = mode === "short" ? targetPct : (longUsd + valor * (100 - targetPct) / 100) / (valor || 1) * 100;
  let clamped = false;
  if (hedgePct < 0) { hedgePct = 0; clamped = true; }
  if (hedgePct > CAP) { hedgePct = CAP; clamped = true; }
  const alvoCt = roundLot((hedgePct / 100) * valor / CT_VAL);
  const delta = roundLot(alvoCt - shortCt);
  const atual = valor > 0 ? shortUsd / valor * 100 : 0;
  const net = valor > 0 ? 100 + (longUsd - shortUsd) / valor * 100 : 0;
  return { valor, longUsd, shortUsd, hedgePct, alvoCt, delta, atual, net, clamped };
}

async function runHedge(targetPct: number, mode: "short" | "net", ordType: "market" | "limit", price: number | null, dry: boolean, only: string[] | null, reduce = false) {
  const out: J = { target_pct: targetPct, mode, ordType, price: ordType === "limit" ? price : null, dry, aborted: false, abort_msg: null, accounts: [] };
  if (!(targetPct >= 0 && targetPct <= CAP)) return { ...out, aborted: true, abort_msg: "Alvo fora do intervalo." };
  if (ordType === "limit" && !(price != null && price > 0)) return { ...out, aborted: true, abort_msg: "Preço inválido." };
  let mark = 0;
  try { mark = await markPx(); } catch (e) { return { ...out, aborted: true, abort_msg: "Mark indisponível." }; }
  if (!(mark > 0)) return { ...out, aborted: true, abort_msg: "Mark indisponível." };
  out.mark = mark;
  const base = accs();
  const wanted = only && only.length ? base.filter(([P]) => only.includes(P)) : base;
  if (only && only.length && wanted.length !== only.length) return { ...out, aborted: true, abort_msg: "Conta desconhecida." };
  const R = await Promise.all(wanted.map(async ([P, name]) => {
    const eq = await eq_of(P);
    const legs = await legsOf(P);
    const longCt = legs.find((l) => l.posSide === "long")?.pos ?? 0;
    const shortCt = legs.find((l) => l.posSide === "short")?.pos ?? 0;
    const h = hedgeNumbers(eq, mark, longCt, shortCt, targetPct, mode);
    let action: "vender" | "reduzir" | "nada" = "nada";
    let err: string | null = null;
    let hedgePct = h.hedgePct;
    let alvoCt = h.alvoCt;
    let delta = h.delta;
    if (reduce) {
      const closeCt = roundLot(shortCt * Math.min(100, Math.max(0, targetPct)) / 100);
      delta = -closeCt;
      alvoCt = roundLot(shortCt + delta);
      hedgePct = h.valor > 0 ? alvoCt * 100 / h.valor * 100 : 0;
    }
    if (!(eq > 0)) err = "saldo zerado";
    else if (Math.abs(delta) < 0.1) action = "nada";
    else if (delta > 0) action = "vender";
    else action = "reduzir";
    return { P, name, eq, longCt, shortCt, ...h, hedgePct, alvoCt, delta, action, err };
  }));
  out.accounts = R.map((r) => ({
    prefix: r.P, name: r.name, eq: r.eq, valor_usd: r.valor, long_usd: r.longUsd, short_usd: r.shortUsd,
    atual_pct: r.atual, alvo_pct: r.hedgePct, net_pct: r.net, alvo_ct: r.alvoCt, delta_ct: r.delta,
    delta_usd: r.delta * CT_VAL, action: r.action, clamped: r.clamped, status: r.err ? "bloqueado" : r.action === "nada" ? "no alvo" : "ok", error: r.err,
  }));
  if (dry) { out.raw = "DRY: nada enviado"; return out; }
  const O = await Promise.all(R.map(async (r) => {
    if (r.err || r.action === "nada") return { ok: true, skipped: true, hedge_pct: r.atual };
    const sz = Math.abs(r.delta);
    const clOrdId = ("h" + Date.now().toString(36) + r.P + Math.random().toString(36).slice(2, 6)).replace(/[^0-9A-Za-z]/g, "").slice(0, 32);
    const body: J = {
      instId: INST, tdMode: "cross", clOrdId,
      side: r.action === "vender" ? "sell" : "buy",
      posSide: "short", ordType, sz: sz.toFixed(1),
    };
    if (r.action === "reduzir") body.reduceOnly = true;
    if (ordType === "limit") body.px = pyG(price!);
    const e = await req(r.P, "POST", "/api/v5/trade/order", body);
    const d = (e.data && e.data[0]) || {};
    const ok = e.code === "0" && d.sCode === "0";
    if (ok && r.alvoCt === 0 && r.shortCt >= 0.1) {
      const mine = algosFor(await conds(r.P), "short").filter((x) => x.algoId).map((x) => ({ algoId: x.algoId, instId: INST }));
      if (mine.length) await req(r.P, "POST", "/api/v5/trade/cancel-algos", mine);
    }
    let hedgePct = r.atual;
    try {
      const legs = await legsOf(r.P);
      const sc = legs.find((l) => l.posSide === "short")?.pos ?? 0;
      const valor = r.eq * mark;
      hedgePct = valor > 0 ? (sc * CT_VAL) / valor * 100 : 0;
    } catch { /* leitura depois do envio */ }
    return { ok, skipped: false, hedge_pct: hedgePct, sMsg: d.sMsg || e.msg || null };
  }));
  out.accounts = R.map((r, i) => {
    const base = out.accounts[i];
    const o = O[i];
    base.hedge_pct = o.hedge_pct;
    if (!o.skipped && !o.ok) { base.status = "falhou"; base.error = o.sMsg || "ordem recusada"; }
    return base;
  });
  if (out.accounts.some((a: J) => a.status === "falhou")) { out.aborted = true; out.abort_msg = "Alguma conta não ajustou o hedge."; }
  return out;
}

type Book = { P: string; n: string; eq: number; legs: Leg[]; cs: J[]; err: string | null };
async function readBooks(): Promise<{ mark: number; rows: Book[] }> {
  const mark = await markPx();
  const rows = await Promise.all(accs().map(async ([P, n]) => {
    try {
      const [eq, legs, cs] = await Promise.all([eq_of(P), legsOf(P), conds(P)]);
      return { P, n, eq, legs, cs, err: null as string | null };
    } catch (e) {
      return { P, n, eq: 0, legs: [] as Leg[], cs: [] as J[], err: "falha ao ler conta: " + String((e as Error).message || e).slice(0, 120) };
    }
  }));
  return { mark, rows };
}
function chaseMaxFields(unit: string | null, value: number | null): { maxChaseType?: string; maxChaseVal?: string; error?: string } {
  if (value == null || !(value > 0)) return {};
  const u = (unit || "usd").toLowerCase();
  if (u === "pct" || u === "%") {
    if (value > 100) return { error: "Distância máxima inválida." };
    return { maxChaseType: "ratio", maxChaseVal: ratioFromPct(value) };
  }
  if (u === "ratio") {
    if (!(value > 0 && value < 1)) return { error: "Distância máxima inválida." };
    return { maxChaseType: "ratio", maxChaseVal: String(parseFloat(value.toPrecision(8))) };
  }
  if (u === "usd" || u === "distance") return { maxChaseType: "distance", maxChaseVal: pyG(value) };
  return { error: "Distância máxima inválida." };
}

// Abre market/limit com tamanho em USD (reparte pelo saldo) ou % do saldo. Não mexe no caminho risco+stop.
async function runSized(side: Side, ordType: "market" | "limit", price: number | null, dry: boolean, mode: "usd" | "pct", amount: number, stop: number | null) {
  const out: J = { side, ordType, price: ordType === "limit" ? price : null, sizeMode: mode, amount, stop, dry, aborted: false, abort_msg: null, accounts: [] };
  if (mode === "usd" && !(amount > 0)) return { ...out, aborted: true, abort_msg: "Valor em USD inválido." };
  if (mode === "pct" && !(amount >= 1 && amount <= 100)) return { ...out, aborted: true, abort_msg: "Percentual inválido: use um valor de 1 a 100." };
  if (ordType === "limit" && !(price != null && price > 0)) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  const { mark, rows } = await readBooks();
  out.mark = mark;
  const entry = ordType === "limit" ? price! : mark;
  if (stop != null && stop > 0 && !stopGuarded(side, stop, entry, ordType === "market")) {
    const msg = side === "long" ? "No long, o stop precisa ficar abaixo da entrada." : "No short, o stop precisa ficar acima da entrada.";
    return { ...out, aborted: true, abort_msg: msg };
  }
  const weights = rows.map((r) => (r.eq > 0 && mark > 0 ? r.eq * mark : 0));
  const usdCts = mode === "usd" ? splitLots(amount / 100, weights) : [];
  const planned = rows.map((r, i) => {
    const adding = addsToLeg(r.legs, r.cs, side, [entry]);
    const ct = mode === "usd" ? usdCts[i] : ctFromEquityPct(r.eq, mark, amount);
    const gross = r.legs.reduce((s, l) => s + l.pos, 0);
    const expo = r.eq > 0 && mark > 0 ? (gross + ct) * 100 / (r.eq * mark) * 100 : 0;
    let err = r.err;
    if (!err && !(r.eq > 0)) err = "saldo zerado";
    else if (!err && ct < 0.1) err = "tamanho < 0.1 ct";
    else if (!err && expo > CAP) err = `expo ${expo.toFixed(0)}% > teto`;
    const loss = !err && stop && stop > 0 ? lossBtc(ct, entry, stop) : null;
    return { ...r, ct, expo, adding, err, loss };
  });
  out.accounts = planned.map((r) => ({
    prefix: r.P, name: r.n, ct: r.ct, size_usd: r.ct * 100, avg: null, expo: r.expo,
    loss_btc: r.loss, loss_usd: r.loss != null ? r.loss * mark : null,
    status: r.err ? "bloqueado" : "ok", error: r.err,
  }));
  if (dry) { out.raw = "DRY: nada enviado"; return out; }
  if (planned.some((r) => r.err)) return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" };
  const osSide = orderSide(side, false);
  const sent = await Promise.all(planned.map(async (r) => {
    try {
      const body: J = { instId: INST, tdMode: "cross", side: osSide, posSide: side, ordType, sz: r.ct.toFixed(1) };
      if (ordType === "limit") body.px = pyG(price!);
      if (stop != null && stop > 0 && !r.adding) body.attachAlgoOrds = [{ slTriggerPx: pyG(stop), slOrdPx: "-1", slTriggerPxType: "mark" }];
      const e = await req(r.P, "POST", "/api/v5/trade/order", body);
      const d = (e.data && e.data[0]) || {};
      const ok = e.code === "0" && d.sCode === "0";
      if (ok && r.adding && stop != null && stop > 0) {
        const moved = await ensureCf1(r.P, side, stop);
        if (moved.err) return { ok: false, msg: "entrou; stop: " + moved.err };
      }
      return { ok, msg: ok ? null : (d.sMsg || e.msg || "ordem recusada") };
    } catch (e) {
      return { ok: false, msg: String((e as Error).message || e).slice(0, 120) };
    }
  }));
  out.accounts = planned.map((r, i) => {
    const row = out.accounts[i];
    row.status = sent[i].ok ? "ok" : "falhou";
    row.error = sent[i].ok ? null : sent[i].msg;
    return row;
  });
  if (out.accounts.some((a: J) => a.status !== "ok")) { out.aborted = true; out.abort_msg = "Alguma conta não entrou. Confira a tabela."; }
  return out;
}

async function runAlgo(opts: {
  kind: "trigger" | "chase";
  side: Side;
  reduce: boolean;
  dry: boolean;
  mode: SizeMode;
  amount: number | null;
  stop: number | null;
  contracts: Record<string, number> | null;
  triggerPx: number | null;
  triggerPxType: "last" | "mark";
  maxChaseUnit: string | null;
  maxChase: number | null;
}) {
  const out: J = {
    kind: opts.kind, side: opts.side, reduce: opts.reduce, ordType: opts.kind, dry: opts.dry,
    sizeMode: opts.mode, aborted: false, abort_msg: null, accounts: [],
    triggerPx: opts.kind === "trigger" ? opts.triggerPx : null, triggerPxType: opts.triggerPxType,
  };
  if (opts.kind === "trigger" && !(opts.triggerPx != null && opts.triggerPx > 0)) return { ...out, aborted: true, abort_msg: "Preço de gatilho inválido." };
  if (opts.reduce && opts.mode === "risk") return { ...out, aborted: true, abort_msg: "Para reduzir, use USD ou %." };
  if (opts.mode === "usd" && !(opts.amount != null && opts.amount > 0)) return { ...out, aborted: true, abort_msg: "Valor em USD inválido." };
  if (opts.mode === "pct" && !(opts.amount != null && opts.amount >= 1 && opts.amount <= 100)) return { ...out, aborted: true, abort_msg: "Percentual inválido: use um valor de 1 a 100." };
  if (opts.mode === "risk") {
    if (!(opts.amount != null && opts.amount > 0 && opts.amount <= 5)) return { ...out, aborted: true, abort_msg: "Risco inválido: use um valor maior que 0 e no máximo 5%." };
    if (!(opts.stop != null && opts.stop > 0)) return { ...out, aborted: true, abort_msg: "Stop inválido." };
  }
  if (opts.mode === "contracts" && !opts.contracts) return { ...out, aborted: true, abort_msg: "Quantidade inválida." };
  const max = chaseMaxFields(opts.maxChaseUnit, opts.maxChase);
  if (max.error) return { ...out, aborted: true, abort_msg: max.error };
  const { mark, rows } = await readBooks();
  out.mark = mark;
  const entry = opts.kind === "trigger" ? opts.triggerPx! : mark;
  if (!opts.reduce && opts.stop != null && opts.stop > 0 && !stopGuarded(opts.side, opts.stop, entry, opts.kind === "chase")) {
    return { ...out, aborted: true, abort_msg: opts.side === "long" ? "No long, o stop precisa ficar abaixo da entrada." : "No short, o stop precisa ficar acima da entrada." };
  }
  const weights = rows.map((r) => (r.eq > 0 && mark > 0 ? r.eq * mark : 0));
  const openUsd = !opts.reduce && opts.mode === "usd" ? splitLots((opts.amount || 0) / 100, weights) : [];
  const reduceUsd = opts.reduce && opts.mode === "usd"
    ? allocateReduce(rows.map((r) => ({ key: r.n, pos: r.legs.find((l) => l.posSide === opts.side && l.pos > 0)?.pos || 0 })), (opts.amount || 0) / 100)
    : [];
  const planned = rows.map((r, i) => {
    const leg = r.legs.find((l) => l.posSide === opts.side && l.pos > 0) ?? null;
    const adding = opts.reduce ? !!leg : addsToLeg(r.legs, r.cs, opts.side, [entry]);
    let ct = 0;
    let skip = false;
    let absent = false;
    let err = r.err;
    if (opts.reduce) {
      if (!leg) { skip = true; err = `sem perna ${opts.side}`; }
      else if (opts.mode === "contracts" && (opts.contracts![r.n] ?? opts.contracts![r.P]) == null) { skip = true; absent = true; err = null; }
      else if (opts.mode === "contracts") ct = clampLot(opts.contracts![r.n] ?? opts.contracts![r.P], leg!.pos);
      else if (opts.mode === "pct") {
        const pct = opts.amount || 0;
        ct = pct >= 100 - 1e-9 ? leg!.pos : Math.min(leg!.pos, floor01(leg!.pos * pct / 100));
      } else ct = reduceUsd.find((a) => a.key === r.n)?.ct || 0;
      if (!skip && ct < 0.1) err = "tamanho < 0.1 ct";
    } else if (!err) {
      if (opts.mode === "contracts") {
        const raw = opts.contracts![r.n] ?? opts.contracts![r.P];
        if (raw == null) { skip = true; absent = true; }
        else ct = roundLot(raw);
      } else if (opts.mode === "usd") ct = openUsd[i] || 0;
      else if (opts.mode === "pct") ct = ctFromEquityPct(r.eq, mark, opts.amount || 0);
      else ct = ctFromRisk(r.eq, entry, opts.stop || 0, opts.amount || 0);
      const gross = r.legs.reduce((s, l) => s + l.pos, 0);
      const expo = r.eq > 0 && mark > 0 ? (gross + ct) * 100 / (r.eq * mark) * 100 : 0;
      if (!skip && !(r.eq > 0)) err = "saldo zerado";
      else if (!skip && ct < 0.1) err = "tamanho < 0.1 ct";
      else if (!skip && expo > CAP) err = `expo ${expo.toFixed(0)}% > teto`;
    }
    return { ...r, leg, ct, adding, skip, absent, err };
  });
  out.accounts = planned.map((r) => ({
    prefix: r.P, name: r.n, side: opts.side, ct: r.ct, size_usd: r.ct * 100, close_ct: opts.reduce ? r.ct : 0,
    status: r.absent ? "fora" : r.skip ? "sem perna" : r.err ? "bloqueado" : "ok",
    error: r.absent ? null : r.err,
  }));
  const actionable = planned.filter((r) => !r.skip);
  if (opts.reduce && !actionable.length) {
    return { ...out, aborted: true, abort_msg: `Nenhuma conta com perna ${opts.side}.` };
  }
  if (opts.dry) { out.raw = "DRY: nada enviado"; return out; }
  const sendable = planned.filter((r) => !r.skip && !r.err);
  if (!opts.reduce && planned.some((r) => r.err)) return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" };
  if (!sendable.length) return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" };
  const osSide = orderSide(opts.side, opts.reduce);
  const sent = await Promise.all(planned.map(async (r) => {
    if (r.skip || r.err) return { sent: false, ok: false, msg: r.err };
    try {
      const body: J = { instId: INST, tdMode: "cross", side: osSide, posSide: opts.side, ordType: opts.kind, sz: r.ct.toFixed(1) };
      if (opts.reduce) body.reduceOnly = true;
      if (opts.kind === "trigger") {
        body.triggerPx = pyG(opts.triggerPx!);
        body.orderPx = "-1";
        body.triggerPxType = opts.triggerPxType;
        if (!opts.reduce && opts.stop != null && opts.stop > 0 && !r.adding) {
          body.attachAlgoOrds = [{ slTriggerPx: pyG(opts.stop), slOrdPx: "-1", slTriggerPxType: "mark" }];
        }
      } else {
        body.chaseType = "distance";
        body.chaseVal = "0";
        if (max.maxChaseType && max.maxChaseVal) {
          body.maxChaseType = max.maxChaseType;
          body.maxChaseVal = max.maxChaseVal;
        }
      }
      const e = await req(r.P, "POST", "/api/v5/trade/order-algo", body);
      const d = (e.data && e.data[0]) || {};
      const ok = e.code === "0" && (d.sCode == null || d.sCode === "0");
      if (ok && !opts.reduce && r.adding && opts.stop != null && opts.stop > 0) {
        const moved = await ensureCf1(r.P, opts.side, opts.stop);
        if (moved.err) return { sent: true, ok: false, msg: "entrou; stop: " + moved.err };
      }
      return { sent: true, ok, msg: ok ? null as string | null : (d.sMsg || e.msg || "ordem recusada") };
    } catch (e) {
      return { sent: true, ok: false, msg: String((e as Error).message || e).slice(0, 120) };
    }
  }));
  out.accounts = planned.map((r, i) => {
    const row = out.accounts[i];
    if (r.skip || r.err) return row;
    row.status = sent[i].ok ? "ok" : "falhou";
    row.error = sent[i].ok ? null : sent[i].msg;
    return row;
  });
  out.raw = "enviado";
  if (out.accounts.some((a: J) => a.status === "falhou")) { out.aborted = true; out.abort_msg = "Alguma conta não entrou. Confira a tabela."; }
  return out;
}

async function runScaleAmount(side: Side, from: number, to: number, n: number, priceSkew: Skew, sizeSkew: Skew, dry: boolean, mode: "usd" | "pct", amount: number, stop: number | null) {
  const out: J = { side, from, to, n, sizeMode: mode, amount, stop, dry, aborted: false, abort_msg: null, accounts: [] };
  if (!(n >= 2 && n <= 50)) return { ...out, aborted: true, abort_msg: "A escala precisa de 2 a 50 ordens." };
  if (!(from > 0) || !(to > 0) || from === to) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  if (mode === "usd" && !(amount > 0)) return { ...out, aborted: true, abort_msg: "Valor em USD inválido." };
  if (mode === "pct" && !(amount >= 1 && amount <= 100)) return { ...out, aborted: true, abort_msg: "Percentual inválido: use um valor de 1 a 100." };
  const prices = scalePrices(from, to, n, priceSkew).map(pxTick);
  const bandMsg = pricesOutside(prices, await priceBand(), side === "long");
  if (bandMsg) return { ...out, aborted: true, abort_msg: bandMsg };
  if (stop != null && stop > 0 && prices.some((p) => !stopOnSide(side, stop, p))) {
    return { ...out, aborted: true, abort_msg: side === "long" ? "No long, o stop precisa ficar abaixo de todas as pernas." : "No short, o stop precisa ficar acima de todas as pernas." };
  }
  const weights = scaleWeights(prices, sizeSkew);
  const { mark, rows } = await readBooks();
  out.mark = mark;
  const eqW = rows.map((r) => (r.eq > 0 && mark > 0 ? r.eq * mark : 0));
  const totals = mode === "usd" ? splitLots(amount / 100, eqW) : rows.map((r) => ctFromEquityPct(r.eq, mark, amount));
  const planned = rows.map((r, i) => {
    const parts = splitLots(totals[i] || 0, weights).map((ct, k) => ({ price: prices[k], ct })).filter((p) => p.ct >= 0.1);
    const ct = roundLot(parts.reduce((s, p) => s + p.ct, 0));
    const gross = r.legs.reduce((s, l) => s + l.pos, 0);
    const expo = r.eq > 0 && mark > 0 ? (gross + ct) * 100 / (r.eq * mark) * 100 : 0;
    const adding = addsToLeg(r.legs, r.cs, side, parts.map((p) => p.price));
    let err = r.err;
    if (!err && !(r.eq > 0)) err = "saldo zerado";
    else if (!err && ct < 0.1) err = "tamanho < 0.1 ct";
    else if (!err && expo > CAP) err = `expo ${expo.toFixed(0)}% > teto`;
    return { ...r, ct, parts, expo, adding, err };
  });
  out.accounts = planned.map((r) => ({
    prefix: r.P, name: r.n, ct: r.ct, size_usd: r.ct * 100, expo: r.expo,
    legs: r.parts.map((p) => ({ price: p.price, ct: p.ct, usd: p.ct * 100 })),
    status: r.err ? "bloqueado" : "ok", error: r.err,
  }));
  if (dry) { out.raw = "DRY: nada enviado"; return out; }
  if (!planned.some((r) => !r.err)) return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" };
  const osSide = orderSide(side, false);
  const O = await Promise.all(planned.map(async (r) => {
    if (r.err) return { ok: false, msg: r.err, placed: [] as string[] };
    const placed: string[] = [];
    let fail = "";
    for (let i = 0; i < r.parts.length; i += 20) {
      const chunk = r.parts.slice(i, i + 20).map((l) => {
        const order: J = {
          instId: INST, tdMode: "cross", side: osSide, posSide: side, ordType: "limit", sz: szStr(l.ct), px: pxStr(l.price),
        };
        if (stop != null && stop > 0 && !r.adding) order.attachAlgoOrds = attachSl(stop);
        return order;
      });
      const e = await req(r.P, "POST", "/api/v5/trade/batch-orders", chunk);
      const data = Array.isArray(e.data) ? e.data : [];
      let bad = e.code !== "0" && e.code !== "2";
      data.forEach((d: J) => {
        if (d && d.sCode === "0" && d.ordId) placed.push(String(d.ordId));
        else { bad = true; fail = fail || venueMsg(d, e); }
      });
      if (!data.length && e.code !== "0") { bad = true; fail = fail || venueMsg(null, e); }
      if (bad) {
        if (placed.length) await cancelBatch(r.P, placed);
        return { ok: false, msg: fail || "perna recusada", placed: [] as string[] };
      }
    }
    if (stop != null && stop > 0 && r.adding) {
      const stopRes = await ensureCf1(r.P, side, stop);
      if (stopRes.err) {
        if (placed.length) await cancelBatch(r.P, placed);
        return { ok: false, msg: stopRes.err, placed: [] as string[] };
      }
    }
    return { ok: true, msg: null as string | null, placed };
  }));
  out.accounts = planned.map((r, i) => {
    const row = out.accounts[i];
    if (r.err) return row;
    row.status = O[i].ok ? "ok" : "falhou";
    row.error = O[i].ok ? null : O[i].msg;
    row.ordIds = O[i].placed;
    return row;
  });
  if (out.accounts.some((a: J) => a.status === "falhou")) { out.aborted = true; out.abort_msg = "Alguma conta não entrou na escala. O que tinha sido enviado nessa conta foi cancelado."; }
  return out;
}

async function runCancel(prefix: string, algoId: string, dry: boolean) {
  const out: J = { account: prefix, algoId, dry, aborted: false, abort_msg: null };
  if (!ACC.find(([P]) => P === prefix)) return { ...out, aborted: true, abort_msg: "Conta desconhecida." };
  if (!algoId) return { ...out, aborted: true, abort_msg: "Falta o id da ordem." };
  if (dry) { out.raw = "DRY: nada enviado"; return out; }
  const e = await req(prefix, "POST", "/api/v5/trade/cancel-algos", [{ algoId, instId: INST }]);
  const d = (e.data && e.data[0]) || {};
  const ok = e.code === "0" && (d.sCode == null || d.sCode === "0");
  out.ok = ok;
  if (!ok) { out.aborted = true; out.abort_msg = d.sMsg || e.msg || "não cancelou a ordem"; }
  return out;
}

// ---------- sessão ----------
async function issueToken(): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const rnd = hex(crypto.getRandomValues(new Uint8Array(18)));
  const payload = `${exp}.${rnd}`;
  return `${payload}.${hex(await hmacRaw(env("PANEL_SESSION_SECRET"), payload))}`;
}
async function validToken(t: string | null): Promise<boolean> {
  if (!t || !env("PANEL_SESSION_SECRET")) return false;
  const p = t.split(".");
  if (p.length !== 3) return false;
  const expect = hex(await hmacRaw(env("PANEL_SESSION_SECRET"), `${p[0]}.${p[1]}`));
  return safeEq(expect, p[2]) && parseInt(p[0]) > Date.now() / 1000;
}
const fails = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const q = (fails.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  fails.set(ip, q);
  return q.length >= LOGIN_MAX;
}
const fail = (ip: string) => fails.set(ip, [...(fails.get(ip) || []), Date.now()]);

// ---------- http ----------
const ALLOWED = env("PANEL_ORIGINS").split(",").map((s) => s.trim()).filter(Boolean);
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  const allow = !ALLOWED.length ? "*" : ALLOWED.includes(o) ? o : ALLOWED[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "authorization, content-type, x-panel-token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" };
}
const num = (x: unknown) => { const n = parseFloat(String(x ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };

async function runHedgeScale(targetPct: number, mode: "short" | "net", from: number, to: number, n: number, priceSkew: Skew, sizeSkew: Skew, dry: boolean, reduce: boolean) {
  const out: J = { scale: true, target_pct: targetPct, mode, from, to, n, reduce, dry, aborted: false, abort_msg: null, accounts: [] };
  if (!(n >= 2 && n <= 50)) return { ...out, aborted: true, abort_msg: "A escala precisa de 2 a 50 ordens." };
  if (!(from > 0) || !(to > 0) || from === to) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  const prices = scalePrices(from, to, n, priceSkew).map(pxTick);
  const weights = scaleWeights(prices, sizeSkew);
  let mark = 0;
  try { mark = await markPx(); } catch { return { ...out, aborted: true, abort_msg: "Mark indisponível." }; }
  out.mark = mark;
  const R = await Promise.all(accs().map(async ([P, name]) => {
    const [eq, legs, cs] = await Promise.all([eq_of(P), legsOf(P), conds(P)]);
    let longCt = legs.find((l) => l.posSide === "long")?.pos ?? 0;
    let shortCt = legs.find((l) => l.posSide === "short")?.pos ?? 0;
    // Escala inteira além do stop de uma perna: o stop fecha essa perna antes de o preço chegar nas ordens.
    // O ponto de partida é o que sobra depois do stop (0), não a perna de agora.
    const shortGone = shortCt > 0 && prices.every((p) => beyondLegStop("short", p, legStopPx(cs, "short")));
    const longGone = longCt > 0 && prices.every((p) => beyondLegStop("long", p, legStopPx(cs, "long")));
    if (shortGone) shortCt = 0;
    if (longGone) longCt = 0;
    const valor = eq * mark;
    let delta = 0;
    let alvo = valor > 0 ? shortCt * 100 / valor * 100 : 0;
    if (reduce) {
      delta = -roundLot(shortCt * Math.min(100, Math.max(0, targetPct)) / 100);
      alvo = valor > 0 ? (shortCt + delta) * 100 / valor * 100 : 0;
    } else {
      const h = hedgeNumbers(eq, mark, longCt, shortCt, targetPct, mode);
      delta = h.delta;
      alvo = h.hedgePct;
    }
    const sell = delta > 0;
    const atual = valor > 0 ? shortCt * 100 / valor * 100 : 0;
    const parts = splitLots(Math.abs(delta), weights).map((ct, i) => ({ price: prices[i], ct })).filter((p) => p.ct >= 0.1);
    const totalCt = parts.reduce((s, p) => s + p.ct, 0);
    let walked = 0;
    const cum = parts.map((p, i) => {
      walked = roundLot(walked + p.ct);
      const last = i === parts.length - 1;
      const pct = last || !(totalCt > 0) ? alvo : atual + (alvo - atual) * (walked / totalCt);
      return { price: p.price, ct: p.ct, pct };
    });
    // venda a limite fica acima do preço atual; recompra (reduce) fica abaixo
    let err: string | null = !(eq > 0) ? "saldo zerado" : null;
    if (!err && cum.length && sell && cum.some((p) => p.price < mark)) err = "para vender, a escala precisa ficar acima do preço atual";
    if (!err && cum.length && !sell && cum.some((p) => p.price > mark)) err = "para recomprar, a escala precisa ficar abaixo do preço atual";
    return { P, name, eq, atual, alvo, delta, parts: cum, sell, err, shortGone };
  }));
  out.accounts = R.map((r) => ({
    prefix: r.P, name: r.name, atual_pct: r.atual, alvo_pct: r.alvo, delta_ct: r.delta, after_stop: r.shortGone,
    legs: r.parts, status: r.err ? "bloqueado" : r.parts.length ? "ok" : "no alvo", error: r.err,
  }));
  const band = await priceBand();
  for (const r of R) {
    if (r.err || !r.parts.length) continue;
    const msg = pricesOutside(r.parts.map((p) => p.price), band, !r.sell);
    if (msg) return { ...out, aborted: true, abort_msg: msg };
  }
  if (R.some((r) => r.err && r.err !== "saldo zerado")) {
    return { ...out, aborted: true, abort_msg: R.filter((r) => r.err).map((r) => `${r.name}: ${r.err}`).join("\n") };
  }
  if (dry) { out.raw = "DRY: nada enviado"; return out; }
  if (!R.some((r) => !r.err && r.parts.length)) return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" };
  const O = await Promise.all(R.map(async (r) => {
    if (r.err || !r.parts.length) return { ok: true, msg: r.err };
    const chunk = r.parts.map((l) => {
      const order: J = {
        instId: INST, tdMode: "cross", side: r.sell ? "sell" : "buy", posSide: "short",
        ordType: "limit", sz: szStr(l.ct), px: pxStr(l.price),
      };
      if (!r.sell) order.reduceOnly = true;
      return order;
    });
    const e = await req(r.P, "POST", "/api/v5/trade/batch-orders", chunk);
    const data = Array.isArray(e.data) ? e.data : [];
    const bad = data.some((d: J) => !(d && d.sCode === "0" && d.ordId)) || (e.code !== "0" && e.code !== "2");
    return { ok: !bad, msg: bad ? venueMsg(data.find((d: J) => d.sCode !== "0"), e) : null };
  }));
  out.accounts = R.map((r, i) => {
    const row = out.accounts[i];
    if (r.err || !r.parts.length) return row;
    row.status = O[i].ok ? "ok" : "falhou";
    row.error = O[i].ok ? null : O[i].msg;
    return row;
  });
  if (out.accounts.some((a: J) => a.status === "falhou")) out.aborted = true;
  if (out.aborted) out.abort_msg = "Alguma conta não entrou na escala de hedge.";
  return out;
}

const handler = async (req: Request): Promise<Response> => {
  const c = cors(req);
  const json = (code: number, obj: unknown) => new Response(JSON.stringify(obj), { status: code, headers: { ...c, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
  const path = new URL(req.url).pathname.replace(/^.*?\/painel/, "") || "/";
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || req.headers.get("x-panel-token");
  try {
    if (path === "/login" && req.method === "POST") {
      if (limited(ip)) return json(429, { ok: false, error: "Muitas tentativas. Espera uns minutos." });
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const exp = env("TRADER_PANEL_PASSWORD");
      const ok = !!exp && typeof body.password === "string" && safeEq(body.password, exp) && !!env("PANEL_SESSION_SECRET");
      if (!ok) { fail(ip); return json(401, { ok: false, error: "Senha incorreta." }); }
      return json(200, { ok: true, token: await issueToken(), days: SESSION_DAYS });
    }
    if (path === "/logout") return json(200, { ok: true });
    if (path === "/" || path === "/health") return json(200, { ok: true, service: "painel" });
    if (!(await validToken(tok))) return json(401, { ok: false, error: "Faça login." });
    if (path === "/session") return json(200, { ok: true });
    if (path === "/positions" && req.method === "GET") return json(200, { ok: true, ...(await fetchPositions()) });
    if (path === "/adjust" && req.method === "POST") {
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const pct = num(body.pct);
      if (pct == null || !(pct >= 1 && pct <= 100)) return json(400, { ok: false, error: "Percentual inválido: use um valor de 1 a 100." });
      const rawType = String(body.ordType ?? "market").trim().toLowerCase();
      const ordType = rawType === "" ? "market" : rawType;
      if (ordType !== "market" && ordType !== "limit") return json(400, { ok: false, error: "Tipo inválido: use market ou limit." });
      let price: number | null = null;
      if (ordType === "limit") {
        price = num(body.price);
        if (price == null || !(price > 0)) return json(400, { ok: false, error: "Preço inválido." });
      }
      const rawSide = String(body.posSide ?? "").trim().toLowerCase();
      if (rawSide !== "" && rawSide !== "long" && rawSide !== "short") return json(400, { ok: false, error: "Lado inválido: use long ou short." });
      const posSide: Side | null = rawSide === "long" || rawSide === "short" ? rawSide : null;
      const dry = body.dry === true;
      const sc = accountScope(body.accounts);
      if (sc === "bad") return json(400, { ok: false, error: "Carteira desconhecida." });
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true; scope = sc;
      try {
        const r = await runAdjust(pct, ordType, price, dry, posSide);
        console.log(JSON.stringify({ ev: "adjust", ip, pct, dry, ordType, price, aborted: r.aborted, acc: (r.accounts || []).map((a: J) => `${a.name}=${Math.round(a.close_usd ?? 0)}${a.error ? "(" + a.error + ")" : ""}`) }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; scope = null; }
    }
    if (path === "/order" && req.method === "POST") {
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const side = String(body.side ?? "").trim().toLowerCase();
      if (side !== "long" && side !== "short") return json(400, { ok: false, error: "Lado inválido: use long ou short." });
      const rawType = String(body.ordType ?? "market").trim().toLowerCase();
      const ordType = rawType === "" ? "market" : rawType;
      if (ordType !== "market" && ordType !== "limit" && ordType !== "trigger" && ordType !== "chase") return json(400, { ok: false, error: "Tipo inválido: use market, limit, trigger ou chase." });
      let price: number | null = null;
      if (ordType === "limit") {
        price = num(body.price);
        if (price == null || !(price > 0)) return json(400, { ok: false, error: "Preço inválido." });
      }
      const dry = body.dry === true;
      const reduce = body.reduce === true;
      const sizeMode = String(body.sizeMode ?? "").trim().toLowerCase();
      const sc = accountScope(body.accounts);
      if (sc === "bad") return json(400, { ok: false, error: "Carteira desconhecida." });
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true; scope = sc;
      try {
        if (ordType === "trigger" || ordType === "chase") {
          const pxRaw = String(body.triggerPxType ?? "last").trim().toLowerCase();
          if (pxRaw !== "" && pxRaw !== "last" && pxRaw !== "mark") return json(400, { ok: false, error: "Tipo de gatilho inválido: use last ou mark." });
          const contracts = contractMap(body.contracts);
          const usd = num(body.usd);
          const pct = num(body.pct);
          const risk = num(body.risk);
          const stop = num(body.stop);
          let mode: SizeMode = "pct";
          let amount: number | null = pct;
          if (reduce && contracts) { mode = "contracts"; amount = null; }
          else if (sizeMode === "risk" || sizeMode === "risco") { mode = "risk"; amount = risk; }
          else if (sizeMode === "usd") { mode = "usd"; amount = usd; }
          else if (sizeMode === "pct" || sizeMode === "%") { mode = "pct"; amount = pct; }
          else if (contracts) { mode = "contracts"; amount = null; }
          else if (usd != null && risk == null) { mode = "usd"; amount = usd; }
          else if (risk != null) { mode = "risk"; amount = risk; }
          const r = await runAlgo({
            kind: ordType, side: side as Side, reduce, dry, mode, amount, stop, contracts,
            triggerPx: num(body.triggerPx ?? body.price),
            triggerPxType: pxRaw === "mark" ? "mark" : "last",
            maxChaseUnit: body.maxChaseUnit == null ? null : String(body.maxChaseUnit),
            maxChase: num(body.maxChase),
          });
          console.log(JSON.stringify({ ev: ordType, ip, side, reduce, mode, dry, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
          return json(200, { ok: !r.aborted, ...r });
        }
        if (reduce) {
          const contracts = contractMap(body.contracts);
          const pct = num(body.pct);
          if (!contracts && (pct == null || !(pct >= 1 && pct <= 100))) return json(400, { ok: false, error: "Percentual inválido: use um valor de 1 a 100." });
          const r = await runReduce(side as "long" | "short", pct ?? 0, ordType, price, dry, contracts);
          console.log(JSON.stringify({ ev: "reduce", ip, side, pct, contracts: !!contracts, dry, ordType, price, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
          return json(200, { ok: !r.aborted, ...r });
        }
        if (sizeMode === "usd" || sizeMode === "pct") {
          const amount = sizeMode === "usd" ? num(body.usd) : num(body.pct);
          if (amount == null) return json(400, { ok: false, error: sizeMode === "usd" ? "Valor em USD inválido." : "Percentual inválido: use um valor de 1 a 100." });
          const stop = num(body.stop);
          const r = await runSized(side as Side, ordType, price, dry, sizeMode, amount, stop);
          console.log(JSON.stringify({ ev: "sized", ip, side, sizeMode, dry, ordType, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
          return json(200, { ok: !r.aborted, ...r });
        }
        const stop = num(body.stop);
        if (stop == null || stop <= 0) return json(400, { ok: false, error: "Stop inválido." });
        const risk = num(body.risk);
        if (risk == null || !(risk > 0 && risk <= 5)) return json(400, { ok: false, error: "Risco inválido: use um valor maior que 0 e no máximo 5%." });
        const r = await runOrder(side as "long" | "short", stop, risk, dry, ordType, price);
        console.log(JSON.stringify({ ev: "order", ip, side, stop, risk, dry, ordType, price, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; scope = null; }
    }
    if (path === "/scale" && req.method === "POST") {
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const side = String(body.side ?? "").trim().toLowerCase();
      if (side !== "long" && side !== "short") return json(400, { ok: false, error: "Lado inválido: use long ou short." });
      const from = num(body.from), to = num(body.to);
      const n = num(body.n);
      if (from == null || to == null || n == null) return json(400, { ok: false, error: "Preencha os dois preços e a quantidade." });
      const dry = body.dry === true;
      const sizeMode = String(body.sizeMode ?? "").trim().toLowerCase();
      const sc = accountScope(body.accounts);
      if (sc === "bad") return json(400, { ok: false, error: "Carteira desconhecida." });
      if (!body.reduce && (sizeMode === "usd" || sizeMode === "pct")) {
        const amount = sizeMode === "usd" ? num(body.usd) : num(body.pct);
        if (amount == null) return json(400, { ok: false, error: sizeMode === "usd" ? "Valor em USD inválido." : "Percentual inválido: use um valor de 1 a 100." });
        if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
        orderBusy = true; scope = sc;
        try {
          const r = await runScaleAmount(side as Side, from, to, Math.round(n), skewArg(body.priceSkew), skewArg(body.sizeSkew), dry, sizeMode, amount, num(body.stop));
          console.log(JSON.stringify({ ev: "scale-sized", ip, side, sizeMode, n, dry, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
          return json(200, { ok: !r.aborted, ...r });
        } finally { orderBusy = false; scope = null; }
      }
      if (body.reduce === true) {
        const contracts = contractMap(body.contracts);
        const pct = num(body.pct);
        if (!contracts && (pct == null || !(pct >= 1 && pct <= 100))) return json(400, { ok: false, error: "Percentual inválido: use um valor de 1 a 100." });
        if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
        orderBusy = true; scope = sc;
        try {
          const r = await runScaleReduce(side, from, to, Math.round(n), skewArg(body.priceSkew), skewArg(body.sizeSkew), pct, contracts, dry);
          console.log(JSON.stringify({ ev: "scale-reduce", ip, side, n, dry, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
          return json(200, { ok: !r.aborted, ...r });
        } finally { orderBusy = false; scope = null; }
      }
      const stop = num(body.stop);
      if (stop == null || stop <= 0) return json(400, { ok: false, error: "Stop inválido." });
      const risk = num(body.risk);
      if (risk == null || !(risk > 0 && risk <= 5)) return json(400, { ok: false, error: "Risco inválido: use um valor maior que 0 e no máximo 5%." });
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true; scope = sc;
      try {
        const r = await runScale(side, stop, risk, from, to, Math.round(n), skewArg(body.priceSkew), skewArg(body.sizeSkew), dry);
        console.log(JSON.stringify({ ev: "scale", ip, side, sizeMode: sizeMode || "risk", n, dry, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; scope = null; }
    }
    if (path === "/amend" && req.method === "POST") {
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const kind = String(body.kind ?? "").trim().toLowerCase();
      if (kind !== "limit" && kind !== "stop" && kind !== "trigger") return json(400, { ok: false, error: "Tipo inválido: use limit, stop ou trigger." });
      const prefix = String(body.account ?? body.prefix ?? "").trim();
      const id = String(kind === "limit" ? (body.ordId ?? "") : (body.algoId ?? "")).trim();
      if (!id) return json(400, { ok: false, error: "Falta o id da ordem." });
      const newPx = num(body.newPx);
      if (newPx == null) return json(400, { ok: false, error: "Preço inválido." });
      const dry = body.dry === true;
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true;
      try {
        const r = await runAmend(kind as "limit" | "stop" | "trigger", prefix, id, newPx, dry, body.triggerPxType == null ? null : String(body.triggerPxType));
        console.log(JSON.stringify({ ev: "amend", ip, kind, prefix, dry, aborted: r.aborted }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; }
    }
    if (path === "/cancel" && req.method === "POST") {
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const prefix = String(body.account ?? body.prefix ?? "").trim();
      const algoId = String(body.algoId ?? "").trim();
      const dry = body.dry === true;
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true;
      try {
        const r = await runCancel(prefix, algoId, dry);
        console.log(JSON.stringify({ ev: "cancel", ip, prefix, dry, aborted: r.aborted }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; }
    }
    if (path === "/hedge" && req.method === "POST") {
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const target = num(body.target_pct);
      if (target == null) return json(400, { ok: false, error: "Alvo inválido." });
      const mode = String(body.mode ?? "short").trim().toLowerCase();
      if (mode !== "short" && mode !== "net") return json(400, { ok: false, error: "Modo inválido: use short ou net." });
      const rawType = String(body.ordType ?? "market").trim().toLowerCase();
      const ordType = rawType === "" ? "market" : rawType;
      if (ordType !== "market" && ordType !== "limit") return json(400, { ok: false, error: "Tipo inválido: use market ou limit." });
      // body.accounts vira o escopo (nome ou prefixo); `only` fica para quem chama runHedge direto com prefixos
      const sc = accountScope(body.accounts);
      if (sc === "bad") return json(400, { ok: false, error: "Carteira desconhecida." });
      const only: string[] | null = null;
      const dry = body.dry === true;
      const reduce = body.reduce === true;
      const from = num(body.from), to = num(body.to), nScale = num(body.n);
      const scaling = from != null && to != null && nScale != null;
      let price: number | null = null;
      if (!scaling && ordType === "limit") {
        price = num(body.price);
        if (price == null || !(price > 0)) return json(400, { ok: false, error: "Preço inválido." });
      }
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true; scope = sc;
      try {
        if (from != null && to != null && nScale != null) {
          const r = await runHedgeScale(target, mode as "short" | "net", from, to, Math.round(nScale), skewArg(body.priceSkew), skewArg(body.sizeSkew), dry, reduce);
          console.log(JSON.stringify({ ev: "hedge-scale", ip, target, reduce, n: nScale, dry, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
          return json(200, { ok: !r.aborted, ...r });
        }
        const r = await runHedge(target, mode as "short" | "net", ordType as "market" | "limit", price, dry, only, reduce);
        console.log(JSON.stringify({ ev: "hedge", ip, target, mode, reduce, dry, ordType, aborted: r.aborted, abort: r.abort_msg, acc: accBrief(r.accounts) }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; scope = null; }
    }
    return json(404, { ok: false, error: "não encontrado" });
  } catch (e) {
    console.error("erro", String((e as Error).message || e).slice(0, 200));
    return json(502, { ok: false, error: "Falha falando com a OKX: " + String((e as Error).message || e).slice(0, 160) });
  }
};
// Onde escutar depende só do EdgeRuntime (não dos marcadores, nem da autorização):
// no Edge Runtime (nuvem ou supabase functions serve), Deno.serve exatamente como antes;
// num deno run comum, só 127.0.0.1 (porta PANEL_PORT, padrão 8000).
if (import.meta.main) {
  // uma linha por instância, ao subir: mostra por que a OKX real está liberada ou bloqueada
  console.log(JSON.stringify({ ev: "okx-env", ...okxEnvDiagnostics(env, IN_EDGE_RUNTIME) }));
  if (IN_EDGE_RUNTIME) Deno.serve(handler);
  else Deno.serve({ hostname: "127.0.0.1", port: parseInt(env("PANEL_PORT") || "8000") }, handler);
}

export const __test = {
  setReq(fn: typeof req) { req = fn; },
  reset() { orderBusy = false; scope = null; },
  setScope(s: unknown) { const v = accountScope(s); scope = v === "bad" ? null : v; return v; },
  okxTargetAllowed, okxAllowedByEnv, hostedMarkersPresent, okxLiveAuthorized, okxEnvDiagnostics,
  ctFromRisk, ctFromEquityPct, lossBtc, scalePrices, scaleWeights, skewArg, hedgeNumbers, realizedPnlBtc, allocateReduce, splitLots, contractMap,
  runOrder, runReduce, runAdjust, runScale, runScaleReduce, runScaleAmount, runSized, runAlgo, runAmend, runCancel, runHedge, runHedgeScale, harmonicAvg, scaleRiskLots, fetchPositions, ACC,
};
