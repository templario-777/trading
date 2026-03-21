import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs/promises";
import pathMod from "node:path";

import {
  buildAiTradeIdea,
  buildSignal,
  buildSignalChartUrl,
  closePaperPosition,
  evaluarGuardiaDeEntrada,
  fetchLastPrice,
  fetchBinanceFuturesSummary,
  fetchNewsSnapshot,
  fetchCandles,
  listBinanceFuturesPositions,
  listFuturesShadowPositions,
  setAutotradeFuturesStatus,
  formatAiMessage,
  formatSignalMessage,
  getDefaultTimeframes,
  generarAutocritica,
  learnFromTradeWithDeepseek,
  listPaperPositions,
  loadMemory,
  loadTradeHistory,
  openPaperPosition,
  readWisdomEntries,
  readWisdomEntriesAll,
  recordPaperPartialClose,
  updatePaperPosition,
  placeBinanceFuturesOrder,
  closeBinanceFuturesPosition,
  fetchFuturesTestnetEquity,
  fetchBinanceFuturesTopSymbols
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

function sendText(res, status, text, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(String(text ?? ""));
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

function parseBanUntilDate(entry) {
  const m = String(entry ?? "").match(/(?:HASTA|UNTIL)=([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
  return m ? m[1] : null;
}

function isExpiredBanEntry(entry) {
  const until = parseBanUntilDate(entry);
  if (!until) return false;
  const today = new Date().toISOString().slice(0, 10);
  return until < today;
}

function parseMetaLine(entry) {
  const m = String(entry ?? "").match(/^\s*Meta:\s*(.+)$/m);
  const raw = m ? String(m[1]) : "";
  const parts = raw
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  const meta = {};
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (!k) continue;
    meta[k] = v;
  }
  return meta;
}

function parseTitleLine(entry) {
  const m = String(entry ?? "").match(/^\s*##\s*\[([^\]]+)\]\s*(.+)\s*$/m);
  if (!m) return { ts: null, title: null };
  return { ts: String(m[1]).trim(), title: String(m[2]).trim() };
}

function isRuleEntry(entry) {
  const one = String(entry ?? "").toUpperCase();
  return (
    (one.includes("REGLA:") || one.includes("SENTENCIA:") || one.includes("LECCIÓN DE ORO:")) &&
    (one.includes("NO OPERAR") || one.includes("EVITAR"))
  );
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
  const keyRaw = getEnvAny(["TRADING_BOT_API_KEY"]);
  if (!keyRaw) return false;
  let key = String(keyRaw).trim();
  if (key.startsWith("\"") && key.endsWith("\"") && key.length >= 2) key = key.slice(1, -1);
  let token = getBearerToken(req);
  token = token ? String(token).trim() : null;
  if (token && token.startsWith("\"") && token.endsWith("\"") && token.length >= 2) token = token.slice(1, -1);
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

  const needsAuth = path.startsWith("/api/") && path !== "/api/health" && path !== "/api/meta";
  if (needsAuth && !isAuthorized(req)) {
    sendJson(res, 401, { error: "unauthorized" }, cors);
    return;
  }

  try {
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, ts: new Date().toISOString() }, cors);
      return;
    }

    if (req.method === "GET" && path === "/api/health") {
      sendJson(res, 200, { ok: true, ts: new Date().toISOString() }, cors);
      return;
    }

    if (req.method === "GET" && path === "/api/meta") {
      const deepseekKey = Boolean(getEnvAny(["DEEPSEEK_KEY", "DEEPSEEK_API_KEY"]));
      const apiKeyEnabled = Boolean(getEnvAny(["TRADING_BOT_API_KEY"])) && !isLocalRequest(req);
      const rawAuth = String(req.headers.authorization ?? "").trim();
      let key = getEnvAny(["TRADING_BOT_API_KEY"]);
      key = key ? String(key).trim() : "";
      if (key.startsWith("\"") && key.endsWith("\"") && key.length >= 2) key = key.slice(1, -1);
      let token = getBearerToken(req);
      token = token ? String(token).trim() : "";
      if (token.startsWith("\"") && token.endsWith("\"") && token.length >= 2) token = token.slice(1, -1);
      const wisdom = await readWisdomEntries({ last: 1 }).catch(() => ({ total: 0 }));
      sendJson(
        res,
        200,
        {
          ok: true,
          ts: new Date().toISOString(),
          deepseekKey,
          apiKeyEnabled,
          wisdomTotal: Number(wisdom?.total) || 0,
          authHeaderPresent: Boolean(rawAuth),
          authTokenLen: token ? token.length : 0,
          keyLen: key ? key.length : 0,
          authorized: Boolean(token) && token === key
        },
        cors
      );
      return;
    }

    if (req.method === "GET" && path === "/api/wisdom") {
      const rawLimit = Number(url.searchParams.get("limit") ?? "40");
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 40;
      const out = await readWisdomEntriesAll();
      const entries = Array.isArray(out?.entries) ? out.entries : [];
      const slice = entries.slice(Math.max(0, entries.length - limit));
      const items = slice.map((text) => {
        const meta = parseMetaLine(text);
        const tl = parseTitleLine(text);
        const until = meta.until ?? parseBanUntilDate(text) ?? null;
        return {
          ts: tl.ts,
          title: tl.title,
          until,
          expired: until ? isExpiredBanEntry(text) : false,
          meta,
          text: String(text).slice(0, 1800)
        };
      });
      sendJson(res, 200, { ok: true, path: out?.path ?? null, total: entries.length, items }, cors);
      return;
    }

    if (req.method === "GET" && path === "/api/rules/active") {
      const out = await readWisdomEntriesAll();
      const entries = Array.isArray(out?.entries) ? out.entries : [];
      const items = [];
      for (const text of entries.slice(-200).reverse()) {
        if (!isRuleEntry(text)) continue;
        if (isExpiredBanEntry(text)) continue;
        const meta = parseMetaLine(text);
        const tl = parseTitleLine(text);
        const until = meta.until ?? parseBanUntilDate(text) ?? null;
        const excerpt = String(text).replace(/\s+/g, " ").trim().slice(0, 260);
        items.push({
          ts: tl.ts,
          title: tl.title,
          symbol: meta.symbol ?? null,
          timeframe: meta.timeframe ?? null,
          reason: meta.reason ?? null,
          until,
          excerpt
        });
      }
      sendJson(res, 200, { ok: true, total: items.length, items }, cors);
      return;
    }

    if (req.method === "GET" && path === "/api/panel") {
      const deepseekKey = Boolean(getEnvAny(["DEEPSEEK_KEY", "DEEPSEEK_API_KEY"]));
      const apiKeyEnabled = Boolean(getEnvAny(["TRADING_BOT_API_KEY"])) && !isLocalRequest(req);
      const wisdom = await readWisdomEntries({ last: 1 }).catch(() => ({ total: 0 }));
      const rules = await readWisdomEntriesAll()
        .then((w) => (Array.isArray(w?.entries) ? w.entries : []))
        .then((arr) => arr.filter((e) => isRuleEntry(e) && !isExpiredBanEntry(e)).length)
        .catch(() => 0);
      const config = {
        engramEnabled: !["0", "false", "off", "no"].includes(String(process.env.ENGRAM_ENABLED ?? "1").trim().toLowerCase()),
        wisdomGuardEnabled: !["0", "false", "off", "no"].includes(
          String(process.env.WISDOM_GUARD_ENABLED ?? "1").trim().toLowerCase()
        ),
        guardMinConfidence: Number.isFinite(Number(process.env.GUARD_MIN_CONFIDENCE))
          ? Number(process.env.GUARD_MIN_CONFIDENCE)
          : null,
        learnBanEnabled: !["0", "false", "off", "no"].includes(String(process.env.LEARN_BAN_ENABLED ?? "1").trim().toLowerCase()),
        learnBanLosses: Number.isFinite(Number(process.env.LEARN_BAN_LOSSES)) ? Number(process.env.LEARN_BAN_LOSSES) : null,
        learnBanHours: Number.isFinite(Number(process.env.LEARN_BAN_HOURS)) ? Number(process.env.LEARN_BAN_HOURS) : null,
        paperTp1ClosePct: Number.isFinite(Number(process.env.PAPER_TP1_CLOSE_PCT)) ? Number(process.env.PAPER_TP1_CLOSE_PCT) : null
      };
      sendJson(
        res,
        200,
        {
          ok: true,
          ts: new Date().toISOString(),
          meta: { deepseekKey, apiKeyEnabled, wisdomTotal: Number(wisdom?.total) || 0, activeRules: rules },
          config
        },
        cors
      );
      return;
    }

    if (req.method === "GET" && path === "/api/futures/summary") {
      try {
        const data = await fetchBinanceFuturesSummary();
        sendJson(res, 200, data, cors);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        const m = msg.match(/^missing_env:([A-Z0-9_]+)$/);
        if (m) {
          sendJson(res, 400, { error: "missing_env", env: m[1] }, cors);
        } else {
          sendJson(res, 200, { ok: false, error: "futures_unavailable", message: msg }, cors);
        }
      }
      return;
    }

    if (req.method === "GET" && path === "/api/futures/positions") {
      try {
        const data = await listBinanceFuturesPositions();
        sendJson(res, 200, data, cors);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        const m = msg.match(/^missing_env:([A-Z0-9_]+)$/);
        if (m) {
          sendJson(res, 400, { error: "missing_env", env: m[1] }, cors);
        } else {
          sendJson(res, 200, { ok: false, error: "futures_unavailable", message: msg }, cors);
        }
      }
      return;
    }

    if (req.method === "GET" && path === "/api/futures/shadow") {
      try {
        const rawLast = Number(url.searchParams.get("last") ?? "80");
        const last = Number.isFinite(rawLast) ? rawLast : 80;
        const openOnly = ["1", "true", "on", "yes"].includes(String(url.searchParams.get("openOnly") ?? "").trim().toLowerCase());
        const data = await listFuturesShadowPositions({ last, openOnly });
        sendJson(res, 200, data, cors);
      } catch (e) {
        sendJson(res, 200, { ok: false, error: "shadow_unavailable", message: e?.message ?? String(e) }, cors);
      }
      return;
    }

    if (req.method === "GET" && path === "/api/futures/auto/status") {
      try {
        const mem = await loadMemory();
        const s = mem.autotradeFutures && typeof mem.autotradeFutures === "object" ? mem.autotradeFutures : {};
        sendJson(res, 200, { ok: true, ts: new Date().toISOString(), status: s }, cors);
      } catch (e) {
        sendJson(res, 200, { ok: false, error: "status_unavailable", message: e?.message ?? String(e) }, cors);
      }
      return;
    }

    if (req.method === "GET" && path === "/api/futures/equity") {
      try {
        const rawLimit = Number(url.searchParams.get("limit") ?? "200");
        const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
        const data = await fetchFuturesTestnetEquity({ limit });
        sendJson(res, 200, data, cors);
      } catch (e) {
        sendJson(res, 200, { ok: false, error: "equity_unavailable", message: e?.message ?? String(e) }, cors);
      }
      return;
    }

    if (req.method === "GET" && path === "/api/futures/top") {
      try {
        const rawLimit = Number(url.searchParams.get("limit") ?? "30");
        const limit = Number.isFinite(rawLimit) ? rawLimit : 30;
        const rawMin = Number(url.searchParams.get("minQuoteVol") ?? "50000000");
        const minQuoteVolume = Number.isFinite(rawMin) ? rawMin : 50_000_000;
        const data = await fetchBinanceFuturesTopSymbols({ quote: "USDT", limit, minQuoteVolume });
        sendJson(res, 200, data, cors);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        const m = msg.match(/^missing_env:([A-Z0-9_]+)$/);
        if (m) sendJson(res, 400, { error: "missing_env", env: m[1] }, cors);
        else sendJson(res, 200, { ok: false, error: "top_unavailable", message: msg }, cors);
      }
      return;
    }

    if (req.method === "POST" && path === "/api/futures/order") {
      try {
        const body = (await readJsonBody(req)) ?? {};
        const symbol = normalizeSymbol(body.symbol);
        const timeframe = normalizeTimeframe(body.timeframe);
        const candlesExchange = String(body.candlesExchange ?? process.env.FUTURES_CANDLES_EXCHANGE ?? "binanceusdm").trim();
        if (!symbol) {
          sendJson(res, 400, { error: "symbol_required" }, cors);
          return;
        }
        if (!timeframe) {
          sendJson(res, 400, { error: "timeframe_required" }, cors);
          return;
        }
        const c = await fetchCandles({ exchange: candlesExchange, symbol, timeframe });
        const signal = await buildSignal(c);
        const guard = await evaluarGuardiaDeEntrada({ signal, candles: c.candles });
        if (guard?.enabled && guard?.allow === false) {
          sendJson(res, 400, { error: "blocked_by_guard", reasons: guard?.reasons ?? [] }, cors);
          return;
        }
        const side = String(body.side ?? "").trim().toLowerCase();
        const type = String(body.type ?? "market").trim().toLowerCase();
        const notionalUsdt = body.notionalUsdt;
        const amount = body.amount;
        const price = body.price;
        const leverage = body.leverage;
        const reduceOnly = body.reduceOnly === true;
        const clientId = body.clientId;
        const data = await placeBinanceFuturesOrder({
          symbol,
          side,
          type,
          amount,
          notionalUsdt,
          price,
          leverage,
          reduceOnly,
          clientId
        });
        sendJson(res, 200, { ...data, guard }, cors);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        const m = msg.match(/^missing_env:([A-Z0-9_]+)$/);
        if (m) {
          sendJson(res, 400, { error: "missing_env", env: m[1] }, cors);
        } else if (msg === "futures_trading_disabled") {
          sendJson(res, 400, { error: "futures_trading_disabled" }, cors);
        } else if (msg === "futures_trading_not_confirmed") {
          sendJson(res, 400, { error: "futures_trading_not_confirmed" }, cors);
        } else if (msg === "symbol_not_allowed") {
          sendJson(res, 400, { error: "symbol_not_allowed" }, cors);
        } else {
          sendJson(res, 200, { ok: false, error: "futures_order_failed", message: msg }, cors);
        }
      }
      return;
    }

    if (req.method === "POST" && path === "/api/futures/close") {
      try {
        const body = (await readJsonBody(req)) ?? {};
        const symbol = normalizeSymbol(body.symbol);
        if (!symbol) {
          sendJson(res, 400, { error: "symbol_required" }, cors);
          return;
        }
        const clientId = body.clientId;
        const data = await closeBinanceFuturesPosition({ symbol, clientId });
        sendJson(res, 200, data, cors);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        const m = msg.match(/^missing_env:([A-Z0-9_]+)$/);
        if (m) {
          sendJson(res, 400, { error: "missing_env", env: m[1] }, cors);
        } else if (msg === "futures_trading_disabled") {
          sendJson(res, 400, { error: "futures_trading_disabled" }, cors);
        } else if (msg === "futures_trading_not_confirmed") {
          sendJson(res, 400, { error: "futures_trading_not_confirmed" }, cors);
        } else {
          sendJson(res, 200, { ok: false, error: "futures_close_failed", message: msg }, cors);
        }
      }
      return;
    }

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const filePath = pathMod.join(process.cwd(), "public", "index.html");
      const html = await fs.readFile(filePath, "utf8");
      sendText(res, 200, html, "text/html; charset=utf-8", cors);
      return;
    }

    if (req.method === "GET" && path === "/api/news") {
      const maxTitles = Number.isFinite(Number(url.searchParams.get("maxTitles")))
        ? Number(url.searchParams.get("maxTitles"))
        : 10;
      const data = await fetchNewsSnapshot({ maxTitles });
      sendJson(res, 200, data, cors);
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
            const chartUrl = buildSignalChartUrl({ signal, candles: data.candles });
            const guard = await evaluarGuardiaDeEntrada({ signal, candles: data.candles });
            results.push({ timeframe: tf, signal, text: formatSignalMessage(signal), chartUrl, guard });
          } catch (e) {
            results.push({ timeframe: tf, error: e?.message ?? String(e) });
          }
        }
        sendJson(res, 200, { exchange, symbol, results }, cors);
        return;
      }

      try {
        const data = await fetchCandles({ exchange, symbol, timeframe });
        const signal = await buildSignal(data);
        const chartUrl = buildSignalChartUrl({ signal, candles: data.candles });
        const guard = await evaluarGuardiaDeEntrada({ chatId: null, signal, candles: data.candles });
        let text = formatSignalMessage(signal);
        const sScore = Number(guard?.metrics?.sentimentScore);
        const sLabel = guard?.metrics?.sentimentLabel ? String(guard.metrics.sentimentLabel) : "";
        if (Number.isFinite(sScore)) {
          text += `\n\n📰 Sentimiento: ${Math.round(sScore)}/100 ${sLabel}`.trim();
        }
        if (guard?.enabled) {
          if (guard.allow) {
            text += `\n\n🛡️ GUARDIA: OK`;
          } else {
            const reasons = Array.isArray(guard.reasons) ? guard.reasons : [];
            text += `\n\n🚫 GUARDIA: BLOQUEAR\n- ${reasons.join("\n- ")}`;
          }
        }
        sendJson(res, 200, { exchange, symbol, timeframe, signal, text, chartUrl, guard }, cors);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        sendJson(res, 200, { exchange, symbol, timeframe, ok: false, error: "signal_unavailable", message: msg }, cors);
      }
      return;
    }

    if (req.method === "POST" && path === "/api/ai") {
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
      if (!timeframe || isAllTimeframes(timeframe)) {
        sendJson(res, 400, { error: "timeframe_required" }, cors);
        return;
      }
      const apiKey = getEnvAny(["DEEPSEEK_KEY", "DEEPSEEK_API_KEY"]);
      if (!apiKey) {
        sendJson(res, 400, { error: "missing_env", env: "DEEPSEEK_KEY" }, cors);
        return;
      }
      try {
        const data = await fetchCandles({ exchange, symbol, timeframe });
        const ai = await buildAiTradeIdea({ ...data, apiKey });
        const pseudoSignal = {
          symbol: ai.symbol,
          exchange: ai.exchange,
          timeframe: ai.timeframe,
          side: ai.accion === "COMPRA" ? "LONG" : ai.accion === "VENTA" ? "SHORT" : "NEUTRAL",
          entry: ai.precio_entrada,
          sl: ai.sl,
          tp: ai.tp
        };
        const chartUrl = buildSignalChartUrl({ signal: pseudoSignal, candles: data.candles });
        let text = formatAiMessage(ai);
        const headlines = Array.isArray(ai?.context?.headlines) ? ai.context.headlines : [];
        const wisdom = String(ai?.context?.wisdom ?? "").trim();
        const losses = String(ai?.context?.recentLosses ?? "").trim();
        if (headlines.length) {
          text += `\n\n📰 NOTICIAS:\n- ${headlines.slice(0, 8).join("\n- ")}`;
        }
        if (wisdom) {
          text += `\n\n🧠 LECCIONES_RECIENTES:\n${wisdom.slice(0, 600)}`;
        }
        if (losses) {
          text += `\n\n⚠️ ERRORES_RECIENTES:\n${losses.slice(0, 600)}`;
        }
        sendJson(res, 200, { exchange, symbol, timeframe, ai, text, chartUrl }, cors);
      } catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        sendJson(res, 200, { exchange, symbol, timeframe, ok: false, error: "ai_unavailable", message: msg }, cors);
      }
      return;
    }

    if (req.method === "GET" && path === "/api/paper/positions") {
      const items = await listPaperPositions();
      sendJson(res, 200, { items }, cors);
      return;
    }

    if (req.method === "POST" && path === "/api/paper/sync") {
      const body = (await readJsonBody(req)) ?? {};
      const closeTp1PctRaw = Number(body.closeTp1Pct ?? process.env.PAPER_TP1_CLOSE_PCT ?? 50);
      const closeTp1Pct = Number.isFinite(closeTp1PctRaw) ? Math.max(1, Math.min(99, closeTp1PctRaw)) : 50;
      const positions = await listPaperPositions();
      const items = Array.isArray(positions) ? positions : [];
      const results = [];
      let closed = 0;
      let partial = 0;
      for (const p of items) {
        try {
          const id = String(p?.id ?? "").trim();
          const exchange = String(p?.exchange ?? "").trim();
          const symbol = String(p?.symbol ?? "").trim();
          const timeframe = String(p?.timeframe ?? "").trim();
          const side = String(p?.side ?? "").trim().toUpperCase();
          const sl = Number(p?.sl);
          const tp1 = Number(p?.tp1);
          const tp2 = Number(p?.tp2 ?? p?.tp);
          if (!id || !exchange || !symbol || !timeframe || (side !== "LONG" && side !== "SHORT")) {
            results.push({ id, ok: false, error: "invalid_position" });
            continue;
          }
          const pxData = await fetchLastPrice({ exchange, symbol });
          const price = Number(pxData?.price ?? pxData?.last ?? pxData);
          if (!Number.isFinite(price)) {
            results.push({ id, ok: false, error: "price_unavailable" });
            continue;
          }
          const isLong = side === "LONG";
          const tp1Hit = Boolean(p?.tp1Hit);

          if (Number.isFinite(tp1) && Number.isFinite(tp2) && !tp1Hit) {
            const hitTp1 = isLong ? price >= tp1 : price <= tp1;
            if (hitTp1) {
              const trade = await recordPaperPartialClose({ id, exitPrice: price, reason: "TP1", closePct: closeTp1Pct });
              const prevPct = Number(p?.remainingPct);
              const prev = Number.isFinite(prevPct) ? Math.max(1, Math.min(100, prevPct)) : 100;
              const next = Math.max(1, Math.round(prev * (1 - closeTp1Pct / 100)));
              await updatePaperPosition({ id, patch: { tp1Hit: true, remainingPct: next } });
              partial += 1;
              results.push({ id, ok: true, action: "partial_tp1", price, tradeId: trade?.id ?? null });
              continue;
            }
          }

          const hitSl = Number.isFinite(sl) ? (isLong ? price <= sl : price >= sl) : false;
          const hitTp = Number.isFinite(tp2) ? (isLong ? price >= tp2 : price <= tp2) : false;
          if (hitSl) {
            const t = await closePaperPosition({ id, exitPrice: price, reason: "SL" });
            closed += 1;
            results.push({ id, ok: true, action: "close_sl", price, tradeId: t?.id ?? null });
            continue;
          }
          if (hitTp) {
            const t = await closePaperPosition({ id, exitPrice: price, reason: "TP" });
            closed += 1;
            results.push({ id, ok: true, action: "close_tp", price, tradeId: t?.id ?? null });
            continue;
          }
          results.push({ id, ok: true, action: "none", price });
        } catch (e) {
          results.push({ id: String(p?.id ?? "").trim(), ok: false, error: e?.message ?? String(e) });
        }
      }
      sendJson(res, 200, { ok: true, evaluated: items.length, closed, partial, results }, cors);
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
      const apiKey = getEnvAny(["DEEPSEEK_KEY", "DEEPSEEK_API_KEY"]);
      let learning = null;
      let critique = null;
      if (apiKey) {
        learning = await learnFromTradeWithDeepseek({
          apiKey,
          trade: closed,
          signal: null,
          context: { source: "api", kind: "paper_close" }
        }).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
        const rNum = Number(closed?.r);
        const shouldCritique = String(reason) === "SL" || String(reason) === "TIMEOUT" || (Number.isFinite(rNum) && rNum < 0);
        if (shouldCritique) {
          critique = await generarAutocritica({
            apiKey,
            tradeFallido: closed,
            contexto: { source: "api", kind: "paper_close" }
          }).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
        }
      }
      sendJson(res, 200, { trade: closed, learning, critique }, cors);
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
