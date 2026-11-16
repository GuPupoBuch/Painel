// Painel de ordens OKX (porta fiel de /workspace/okx/mkt.py, caminho sem --add).
// API JSON apenas; a página HTML é servida fora do supabase.co (que reescreve text/html).
// Rotas: POST /login, GET /session, GET /positions, POST /order, POST /adjust, POST /logout.
// Auth: token assinado (Authorization: Bearer) ~90 dias.

const B = "https://www.okx.com";
const INST = "BTC-USD-SWAP";
const CAP = 1000.0;
const ACC: [string, string][] = [["OKX", "pupo"], ["OKX2", "pai"], ["OKX3", "mãe"], ["OKX4", "tcheco"]];
const SESSION_DAYS = 90;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX = 5;

const env = (k: string) => Deno.env.get(k) ?? "";
const enc = new TextEncoder();

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
async function req(P: string, m: string, p: string, body?: unknown): Promise<J> {
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
}
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
async function markPx(): Promise<number> {
  const r = await req("OKX", "GET", "/api/v5/public/mark-price?instId=" + INST);
  const v = parseFloat(r?.data?.[0]?.markPx);
  if (!(v > 0)) throw okxErr(r, "mark");
  return v;
}
// Python '%g' (6 algarismos significativos, sem zeros à direita)
const pyG = (x: number) => String(parseFloat(x.toPrecision(6)));

// ---------- posições ----------
async function fetchPositions() {
  const mark = await markPx();
  const accounts = await Promise.all(ACC.map(async ([P, name]) => {
    try {
      const [eq, [net, avg, mk0], cs] = await Promise.all([eq_of(P), pos_of(P), conds(P)]);
      const mk = mk0 || mark;
      const expo = eq > 0 && mk > 0 ? Math.abs(net) * 100 / (eq * mk) * 100 : 0;
      const stops = cs.map((x) => parseFloat(x.slTriggerPx)).filter((v) => v > 0);
      return { prefix: P, name, net, avg, mark: mk, eq, expo, side: net > 0 ? "long" : net < 0 ? "short" : "zerada", stops, error: null };
    } catch (e) {
      return { prefix: P, name, net: 0, avg: 0, mark, eq: 0, expo: 0, side: "erro", stops: [], error: "falha ao ler: " + String((e as Error).message || e).slice(0, 160) };
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
  const R = await Promise.all(ACC.map(async ([P, n]) => {
    try {
      const [eq, [ps]] = await Promise.all([eq_of(P), pos_of(P)]);
      const ct = eq > 0 ? Math.trunc(eq * RISK / den / 0.1 + 1e-9) / 10 : 0;
      const expo = eq > 0 && mark > 0 ? (Math.abs(ps) + ct) * 100 / (eq * mark) * 100 : 0;
      let err: string | null = null;
      if (eq <= 0) err = "saldo zerado";
      else if (ps !== 0) err = `já tem posição ${ps}`;
      else if (expo > CAP) err = `expo ${expo.toFixed(0)}% > teto`;
      else if (ct < 0.1) err = "tamanho < 0.1 ct";
      return { P, n, eq, ps, ct, expo, err };
    } catch (e) {
      return { P, n, eq: 0, ps: 0, ct: 0, expo: 0, err: "falha ao ler conta: " + String((e as Error).message || e).slice(0, 120) };
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
        attachAlgoOrds: [{ slTriggerPx: stp, slOrdPx: "-1", slTriggerPxType: "mark" }],
      };
      if (ordType === "limit") body.px = pyG(entry);
      const e = await req(r.P, "POST", "/api/v5/trade/order", body);
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
const floor01 = (x: number) => Math.trunc(x / 0.1 + 1e-9) / 10;
const isCf1 = (x: J) => { const c = String(x.closeFraction ?? ""); return c === "1" || parseFloat(c) === 1; };
async function pos_leg(P: string): Promise<{ side: "long" | "short" | null; pos: number; avg: number; mark: number; err: string | null }> {
  const r = await req(P, "GET", "/api/v5/account/positions?instId=" + INST);
  if (!Array.isArray(r?.data)) throw okxErr(r, "posições");
  const d = r.data.filter((x: J) => x.instId === INST && parseFloat(x.pos || "0") !== 0);
  if (!d.length) return { side: null, pos: 0, avg: 0, mark: 0, err: null };
  if (d.length > 1) return { side: null, pos: 0, avg: 0, mark: 0, err: "duas pernas abertas" };
  const x = d[0];
  const side = x.posSide === "short" ? "short" as const : "long" as const;
  return { side, pos: Math.abs(parseFloat(x.pos)), avg: parseFloat(x.avgPx || "0"), mark: parseFloat(x.markPx || "0"), err: null };
}
function pickStop(cs: J[], posSide: "long" | "short"): { cf1: J | null; others: J[]; trigger: number | null } {
  const mine = cs.filter((x) => !x.posSide || x.posSide === posSide);
  const cf1 = mine.find(isCf1) ?? null;
  const others = mine.filter((x) => !isCf1(x));
  const from = (x: J | null) => { const v = x ? parseFloat(x.slTriggerPx) : NaN; return v > 0 ? v : null; };
  const trigger = from(cf1) ?? (others.map((x) => parseFloat(x.slTriggerPx)).find((v) => v > 0) ?? null);
  return { cf1, others, trigger };
}

async function runAdjust(pct: number, ordType: "market" | "limit", price: number | null, dry: boolean) {
  const t0 = Date.now();
  const lines: string[] = [];
  const out: J = { pct, ordType, price: ordType === "limit" ? price : null, dry, aborted: false, abort_msg: null, accounts: [], warning: false };
  const mark = await markPx();
  out.mark = mark;
  if (ordType === "limit" && !(price != null && price > 0)) return { ...out, aborted: true, abort_msg: "ABORT preço inválido" };
  const R = await Promise.all(ACC.map(async ([P, n]) => {
    try {
      const [eq, leg, cs] = await Promise.all([eq_of(P), pos_leg(P), conds(P)]);
      const mk = leg.mark || mark;
      if (leg.err) return { P, n, eq, mk, side: null as "long" | "short" | null, pos: 0, avg: 0, ct: 0, expoAfter: 0, st: pickStop(cs, "long"), fillWarn: false, err: leg.err, skip: false };
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
  const actionable = R.filter((r) => !r.skip);
  if (!actionable.length) { lines.push("ABORT: nenhuma conta com posição aberta"); out.raw = lines.join("\n"); return { ...out, aborted: true, abort_msg: "Nenhuma conta com posição aberta." }; }
  if (dry) { lines.push("DRY: nada enviado"); out.raw = lines.join("\n"); return out; }
  const sendable = R.filter((r) => !r.skip && !r.err);
  if (!sendable.length) { lines.push("ABORT: nenhuma ordem enviada"); out.raw = lines.join("\n"); return { ...out, aborted: true, abort_msg: "ABORT: nenhuma ordem enviada" }; }

  const ensureStop = async (r: typeof R[number], afterMarketClose: boolean) => {
    // after a full market close, just cancel leftovers when flat; otherwise keep/place a single cf=1
    if (afterMarketClose && pct >= 100 - 1e-9) {
      const cs = await conds(r.P);
      const dup = cs.map((x) => ({ algoId: x.algoId, instId: INST }));
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
    const cs = await conds(r.P);
    const dup = cs.filter((x) => !isCf1(x)).map((x) => ({ algoId: x.algoId, instId: INST }));
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
            const leg = await pos_leg(r.P);
            if (leg.pos <= r.pos - r.ct + 1e-9) break;
            await new Promise((res) => setTimeout(res, 300));
          }
        } else {
          const t = Date.now();
          while (Date.now() - t < 20000) {
            const leg = await pos_leg(r.P);
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

Deno.serve(async (req) => {
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
      const dry = body.dry === true;
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true;
      try {
        const r = await runAdjust(pct, ordType, price, dry);
        console.log(JSON.stringify({ ev: "adjust", ip, pct, dry, ordType, price, aborted: r.aborted, acc: (r.accounts || []).map((a: J) => `${a.name}=${Math.round(a.close_usd ?? 0)}${a.error ? "(" + a.error + ")" : ""}`) }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; }
    }
    if (path === "/order" && req.method === "POST") {
      let body: J = {};
      try { body = await req.json(); } catch { return json(400, { ok: false, error: "Pedido inválido." }); }
      const side = String(body.side ?? "").trim().toLowerCase();
      if (side !== "long" && side !== "short") return json(400, { ok: false, error: "Lado inválido: use long ou short." });
      const stop = num(body.stop);
      if (stop == null || stop <= 0) return json(400, { ok: false, error: "Stop inválido." });
      const risk = num(body.risk);
      if (risk == null || !(risk > 0 && risk <= 5)) return json(400, { ok: false, error: "Risco inválido: use um valor maior que 0 e no máximo 5%." });
      const rawType = String(body.ordType ?? "market").trim().toLowerCase();
      const ordType = rawType === "" ? "market" : rawType;
      if (ordType !== "market" && ordType !== "limit") return json(400, { ok: false, error: "Tipo inválido: use market ou limit." });
      let price: number | null = null;
      if (ordType === "limit") {
        price = num(body.price);
        if (price == null || !(price > 0)) return json(400, { ok: false, error: "Preço inválido." });
      }
      const dry = body.dry === true;
      if (orderBusy) return json(409, { ok: false, error: "Já tem uma ordem em andamento." });
      orderBusy = true;
      try {
        const r = await runOrder(side, stop, risk, dry, ordType, price);
        console.log(JSON.stringify({ ev: "order", ip, side, stop, risk, dry, ordType, price, aborted: r.aborted, acc: (r.accounts || []).map((a: J) => `${a.name}=${Math.round(a.size_usd ?? 0)}${a.error ? "(" + a.error + ")" : ""}`) }));
        return json(200, { ok: !r.aborted, ...r });
      } finally { orderBusy = false; }
    }
    return json(404, { ok: false, error: "não encontrado" });
  } catch (e) {
    console.error("erro", String((e as Error).message || e).slice(0, 200));
    return json(502, { ok: false, error: "Falha falando com a OKX: " + String((e as Error).message || e).slice(0, 160) });
  }
});
