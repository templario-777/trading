import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";

import {
  buildSignal,
  closePaperPosition,
  fetchCandles,
  formatSignalMessage,
  getDefaultTimeframes,
  listPaperPositions,
  loadTradeHistory,
  openPaperPosition,
  recordPaperPartialClose
} from "./lib.js";

function getEnvAny(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return null;
}

function parseListEnv(name) {
  return String(process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBearerToken(req) {
  const raw = String(req.headers.authorization ?? "").trim();
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function isLocalRequest(req) {
  const addr = String(req.socket?.remoteAddress ?? "");
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function normalizeExchange(raw) {
  return String(raw ?? "").trim();
}

function normalizeSymbol(raw) {
  return String(raw ?? "").trim().toUpperCase();
}

function normalizeTimeframe(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function isAllTimeframes(raw) {
  const tf = normalizeTimeframe(raw);
  return tf === "all" || tf === "todas" || tf === "*";
}

function buildCorsHeaders(req) {
  const allowed = parseListEnv("TRADING_BOT_API_ALLOWED_ORIGINS");
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin || !allowed.length) return {};
  if (!allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    vary: "origin"
  };
}

function isAuthorized(req) {
  const allowNoAuth = ["1", "true", "on", "yes"].includes(
    String(process.env.TRADING_BOT_API_ALLOW_NO_AUTH ?? "").trim().toLowerCase()
  );
  if (allowNoAuth && isLocalRequest(req)) return true;
  const key = getEnvAny(["TRADING_BOT_API_KEY"]);
  if (!key) return false;
  const token = getBearerToken(req);
  return Boolean(token) && token === key;
}

async function handle(req, res) {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (!isAuthorized(req) && path !== "/health") {
    sendJson(res, 401, { error: "unauthorized" }, cors);
    return;
  }

  try {
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, ts: new Date().toISOString() }, cors);
      return;
    }

    if (req.method === "POST" && path === "/api/signal") {
      const body = (await readJsonBody(req)) ?? {};
      const exchange = normalizeExchange(body.exchange);
      const symbol = normalizeSymbol(body.symbol);
      const timeframe = normalizeTimeframe(body.timeframe);
      if (!exchange) {
        sendJson(res, 400, { error: "exchange_required" }, cors);
        return;
      }
      if (!symbol) {
        sendJson(res, 400, { error: "symbol_required" }, cors);
        return;
      }
      if (!timeframe) {
        sendJson(res, 400, { error: "timeframe_required" }, cors);
        return;
      }

      if (isAllTimeframes(timeframe)) {
        const timeframes = getDefaultTimeframes();
        const results = [];
        for (const tf of timeframes) {
          try {
            const data = await fetchCandles({ exchange, symbol, timeframe: tf });
            const signal = await buildSignal(data);
            results.push({ timeframe: tf, signal, text: formatSignalMessage(signal) });
          } catch (e) {
            results.push({ timeframe: tf, error: e?.message ?? String(e) });
          }
        }
        sendJson(res, 200, { exchange, symbol, results }, cors);
        return;
      }

      const data = await fetchCandles({ exchange, symbol, timeframe });
      const signal = await buildSignal(data);
      sendJson(res, 200, { exchange, symbol, timeframe, signal, text: formatSignalMessage(signal) }, cors);
      return;
    }

    if (req.method === "GET" && path === "/api/paper/positions") {
      const items = await listPaperPositions();
      sendJson(res, 200, { items }, cors);
      return;
    }

    if (req.method === "POST" && path === "/api/paper/open") {
      const body = (await readJsonBody(req)) ?? {};
      const exchange = normalizeExchange(body.exchange);
      const symbol = normalizeSymbol(body.symbol);
      const timeframe = normalizeTimeframe(body.timeframe);
      const side = String(body.side ?? "").trim().toUpperCase();
      const entry = Number(body.entry);
      const sl = body.sl === null || body.sl === undefined ? null : Number(body.sl);
      const tp = body.tp === null || body.tp === undefined ? null : Number(body.tp);
      const tp1 = body.tp1 === null || body.tp1 === undefined ? null : Number(body.tp1);
      const tp2 = body.tp2 === null || body.tp2 === undefined ? null : Number(body.tp2);
      if (!exchange) {
        sendJson(res, 400, { error: "exchange_required" }, cors);
        return;
      }
      if (!symbol) {
        sendJson(res, 400, { error: "symbol_required" }, cors);
        return;
      }
      if (!timeframe) {
        sendJson(res, 400, { error: "timeframe_required" }, cors);
        return;
      }
      if (side !== "LONG" && side !== "SHORT") {
        sendJson(res, 400, { error: "side_invalid" }, cors);
        return;
      }
      if (!Number.isFinite(entry)) {
        sendJson(res, 400, { error: "entry_invalid" }, cors);
        return;
      }

      const pos = await openPaperPosition({
        chatId: 0,
        exchange,
        symbol,
        timeframe,
        side,
        entry,
        sl: Number.isFinite(sl) ? sl : null,
        tp: Number.isFinite(tp) ? tp : null,
        tp1: Number.isFinite(tp1) ? tp1 : null,
        tp2: Number.isFinite(tp2) ? tp2 : null,
        strategyName: body.strategyName ?? null,
        strategyReason: body.strategyReason ?? null,
        source: "api"
      });

      sendJson(res, 200, { position: pos }, cors);
      return;
    }

    if (req.method === "POST" && path === "/api/paper/close") {
      const body = (await readJsonBody(req)) ?? {};
      const id = String(body.id ?? "").trim();
      const exitPrice = Number(body.exitPrice);
      const reason = String(body.reason ?? "MANUAL").trim().toUpperCase();
      if (!id) {
        sendJson(res, 400, { error: "id_required" }, cors);
        return;
      }
      if (!Number.isFinite(exitPrice)) {
        sendJson(res, 400, { error: "exitPrice_invalid" }, cors);
        return;
      }
      const closed = await closePaperPosition({ id, exitPrice, reason });
      if (!closed) {
        sendJson(res, 404, { error: "not_found" }, cors);
        return;
      }
      sendJson(res, 200, { trade: closed }, cors);
      return;
    }

    if (req.method === "POST" && path === "/api/paper/partial") {
      const body = (await readJsonBody(req)) ?? {};
      const id = String(body.id ?? "").trim();
      const exitPrice = Number(body.exitPrice);
      const reason = String(body.reason ?? "PARTIAL").trim().toUpperCase();
      const closePct = Number(body.closePct);
      if (!id) {
        sendJson(res, 400, { error: "id_required" }, cors);
        return;
      }
      if (!Number.isFinite(exitPrice)) {
        sendJson(res, 400, { error: "exitPrice_invalid" }, cors);
        return;
      }
      if (!Number.isFinite(closePct)) {
        sendJson(res, 400, { error: "closePct_invalid" }, cors);
        return;
      }
      const trade = await recordPaperPartialClose({ id, exitPrice, reason, closePct });
      if (!trade) {
        sendJson(res, 404, { error: "not_found" }, cors);
        return;
      }
      sendJson(res, 200, { trade }, cors);
      return;
    }

    if (req.method === "GET" && path === "/api/paper/trades") {
      const rawLimit = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(2000, Math.floor(rawLimit))) : 100;
      const out = await loadTradeHistory();
      const items = Array.isArray(out.items) ? out.items.slice(-limit) : [];
      sendJson(res, 200, { path: out.path, items }, cors);
      return;
    }

    sendJson(res, 404, { error: "not_found" }, cors);
  } catch (e) {
    const msg = e?.message ?? String(e);
    const status = msg === "body_too_large" ? 413 : 500;
    sendJson(res, status, { error: "server_error", message: msg }, cors);
  }
}

async function main() {
  const portRaw = Number(getEnvAny(["TRADING_BOT_API_PORT"]) ?? 8787);
  const port = Number.isFinite(portRaw) ? Math.max(1, Math.min(65535, Math.floor(portRaw))) : 8787;
  const host = String(getEnvAny(["TRADING_BOT_API_HOST"]) ?? "127.0.0.1").trim() || "127.0.0.1";

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const msg = e?.message ?? String(e);
      sendJson(res, 500, { error: "server_error", message: msg });
    });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  process.stdout.write(`[API] listening on http://${host}:${port}\n`);
}

main().catch((e) => {
  process.stderr.write(`[API] fatal: ${e?.stack ?? e?.message ?? String(e)}\n`);
  process.exitCode = 1;
});

