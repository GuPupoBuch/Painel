import http from "node:http";

const calls = [];
const placed = [];
const reduced = {};
let band = { buyLmt: "200000", sellLmt: "1000", enabled: true };
let failBatchMsg = null;
let n = 1;
const keys = {
  "key-pupo": "pupo",
  "key-pai": "pai",
  "key-mae": "mãe",
  "key-tcheco": "tcheco",
};

function legs(account) {
  const base = { long: "2", short: "1" };
  const rows = [];
  for (const posSide of ["long", "short"]) {
    const pos = reduced[account + ":" + posSide] ?? base[posSide];
    if (!(parseFloat(pos) > 0)) continue;
    rows.push({
      instId: "BTC-USD-SWAP", posSide, pos,
      avgPx: posSide === "long" ? "60000" : "68000", markPx: "64000", upl: "0.001",
    });
  }
  return rows;
}
function stops(name) {
  return [
    { instId: "BTC-USD-SWAP", algoId: "sl-long-" + name, posSide: "long", slTriggerPx: "58000", closeFraction: "1", ordType: "conditional" },
    { instId: "BTC-USD-SWAP", algoId: "sl-short-" + name, posSide: "short", slTriggerPx: "70000", closeFraction: "1", ordType: "conditional" },
  ];
}
function asPending(item) {
  const b = item.body || {};
  return {
    instId: "BTC-USD-SWAP", algoId: item.algoId, ordType: b.ordType, posSide: b.posSide, side: b.side,
    sz: b.sz, reduceOnly: b.reduceOnly === true, triggerPx: b.triggerPx || "", triggerPxType: b.triggerPxType || "last",
    orderPx: b.orderPx || "", chaseType: b.chaseType || "", chaseVal: b.chaseVal || "",
    maxChaseType: b.maxChaseType || "", maxChaseVal: b.maxChaseVal || "",
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1:8788");
    const raw = Buffer.concat(chunks).toString("utf8");
    const account = keys[String(req.headers["ok-access-key"] || "")] || "pupo";
    let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
    const send = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/__health") return send({ ok: true });
    if (url.pathname === "/__reset") {
      calls.length = 0; placed.length = 0;
      for (const k of Object.keys(reduced)) delete reduced[k];
      band = { buyLmt: "200000", sellLmt: "1000", enabled: true };
      failBatchMsg = null;
      return send({ ok: true });
    }
    if (url.pathname === "/__legs" && req.method === "POST") {
      for (const name of Object.values(keys)) {
        if (body && body.long != null) reduced[name + ":long"] = String(body.long);
        if (body && body.short != null) reduced[name + ":short"] = String(body.short);
      }
      return send({ ok: true });
    }
    if (url.pathname === "/__band" && req.method === "POST") {
      band = { buyLmt: String(body.buyLmt), sellLmt: String(body.sellLmt), enabled: true };
      return send({ ok: true });
    }
    if (url.pathname === "/__failmsg" && req.method === "POST") {
      failBatchMsg = body && body.msg ? String(body.msg) : null;
      return send({ ok: true });
    }
    if (url.pathname === "/__calls") return send(calls);
    calls.push({ account, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (url.pathname === "/api/v5/public/mark-price") return send({ code: "0", data: [{ markPx: "64000" }] });
    if (url.pathname === "/api/v5/public/price-limit") return send({ code: "0", data: [band] });
    if (url.pathname === "/api/v5/account/balance") return send({ code: "0", data: [{ details: [{ ccy: "BTC", eq: "1" }] }] });
    if (url.pathname === "/api/v5/account/positions") return send({ code: "0", data: legs(account) });
    if (url.pathname === "/api/v5/trade/orders-pending") return send({ code: "0", data: [] });
    if (url.pathname === "/api/v5/trade/orders-algo-pending") {
      const ordType = url.searchParams.get("ordType");
      if (ordType === "conditional") return send({ code: "0", data: stops(account) });
      const mine = placed.filter((p) => p.account === account && p.body && p.body.ordType === ordType).map(asPending);
      return send({ code: "0", data: mine });
    }
    if (url.pathname === "/api/v5/trade/order" && req.method === "POST") {
      if (body && body.reduceOnly && (body.posSide === "long" || body.posSide === "short")) {
        const key = account + ":" + body.posSide;
        const cur = parseFloat(reduced[key] ?? (body.posSide === "long" ? "2" : "1"));
        const next = Math.max(0, Math.round((cur - parseFloat(body.sz || "0")) * 10) / 10);
        reduced[key] = String(next);
      }
      return send({ code: "0", data: [{ sCode: "0", ordId: "ord-" + (n++) }] });
    }
    if (url.pathname === "/api/v5/trade/order-algo" && req.method === "POST") {
      const algoId = "algo-" + (n++);
      placed.push({ account, algoId, body });
      return send({ code: "0", data: [{ sCode: "0", algoId }] });
    }
    if (url.pathname === "/api/v5/trade/cancel-algos" && req.method === "POST") {
      const ids = new Set((Array.isArray(body) ? body : []).map((x) => x.algoId));
      for (let i = placed.length - 1; i >= 0; i--) if (ids.has(placed[i].algoId)) placed.splice(i, 1);
      return send({ code: "0", data: [{ sCode: "0" }] });
    }
    if (url.pathname === "/api/v5/trade/amend-algos" || url.pathname === "/api/v5/trade/amend-order") {
      return send({ code: "0", data: [{ sCode: "0" }] });
    }
    if (url.pathname === "/api/v5/trade/batch-orders" && req.method === "POST") {
      const rows = Array.isArray(body) ? body : [];
      if (failBatchMsg) {
        return send({ code: "1", msg: "All operations failed", data: rows.map(() => ({ sCode: "51006", sMsg: failBatchMsg, ordId: "" })) });
      }
      return send({ code: "0", data: rows.map(() => ({ sCode: "0", ordId: "b" + (n++) })) });
    }
    if (url.pathname === "/api/v5/trade/cancel-batch-orders") return send({ code: "0", data: [] });
    return send({ code: "0", data: [] });
  });
});

server.listen(8788, "127.0.0.1");
