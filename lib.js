import ccxt from "ccxt";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LIMIT = 500;
const DEFAULT_EXCHANGE = "binance";

const optimizationCache = new Map();
const exchangeCache = new Map();
const proxyPool = String(process.env.PROXY_URLS ?? "")
  .split(/[,\s]+/g)
  .map((s) => s.trim())
  .filter(Boolean);
let proxyIdx = 0;

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextProxy() {
  if (!proxyPool.length) return null;
  const p = proxyPool[proxyIdx % proxyPool.length];
  proxyIdx = (proxyIdx + 1) % proxyPool.length;
  return p;
}

function toErrText(e) {
  if (!e) return "";
  const msg = e?.message ?? "";
  const stack = e?.stack ?? "";
  return `${msg}\n${stack}`.toLowerCase();
}

function extractHttpStatus(e) {
  const status =
    e?.status ??
    e?.statusCode ??
    e?.response?.status ??
    e?.response?.statusCode ??
    e?.httpStatus ??
    e?.code;
  const n = Number(status);
  if (Number.isFinite(n) && n > 0) return n;
  const text = toErrText(e);
  const m = text.match(/\b(401|403|418|429|451|500|502|503|504)\b/);
  return m ? Number(m[1]) : null;
}

function isRetryableExchangeError(e) {
  if (!e) return false;
  const status = extractHttpStatus(e);
  if (status && [418, 429, 451, 500, 502, 503, 504].includes(status)) return true;
  if (e instanceof ccxt.NetworkError) return true;
  if (e instanceof ccxt.ExchangeNotAvailable) return true;
  if (e instanceof ccxt.RequestTimeout) return true;
  if (e instanceof ccxt.DDoSProtection) return true;
  if (e instanceof ccxt.RateLimitExceeded) return true;
  const text = toErrText(e);
  return (
    text.includes("too many requests") ||
    text.includes("rate limit") ||
    text.includes("ddos") ||
    text.includes("restricted") ||
    text.includes("forbidden") ||
    text.includes("cloudflare") ||
    text.includes("timeout")
  );
}

function shouldRotateProxy(e) {
  const status = extractHttpStatus(e);
  if (status && [403, 418, 429, 451].includes(status)) return true;
  const text = toErrText(e);
  return text.includes("restricted") || text.includes("forbidden") || text.includes("country") || text.includes("region");
}

function roundTo(value, decimals) {
  const m = 10 ** decimals;
  return Math.round(value * m) / m;
}

function formatNumber(value, maxDecimals = 6) {
  if (!Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  const decimals =
    abs >= 1000 ? 2 : abs >= 100 ? 3 : abs >= 10 ? 4 : abs >= 1 ? 5 : maxDecimals;
  return roundTo(value, Math.min(decimals, maxDecimals)).toString();
}

function normalizeSymbol(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("/")) return s;
  if (s.endsWith("USDT")) return `${s.slice(0, -4)}/USDT`;
  if (s.endsWith("USD")) return `${s.slice(0, -3)}/USD`;
  return s;
}

function parseTimeframeList(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return s
    .split(/[,\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function envFirstNonEmpty(names) {
  const arr = Array.isArray(names) ? names : [];
  for (const n of arr) {
    const v = String(process.env[n] ?? "").trim();
    if (v) return v;
  }
  return null;
}

const MEMORY_FILE = "memoria_aether.json";
const MAX_MEMORY_TRADES = 500;

const DEFAULT_TRADING_NOTES_DIR = path.join(process.cwd(), "trading_notes");

const ERROR_MEMORY_PATH =
  envFirstNonEmpty(["ERROR_MEMORY_PATH", "CEREBRO_ERRORES_PATH"]) ??
  path.join(DEFAULT_TRADING_NOTES_DIR, "memoria_errores.json");
const FAIL_MEMORY_PATH =
  envFirstNonEmpty(["FAIL_MEMORY_PATH"]) ?? path.join(DEFAULT_TRADING_NOTES_DIR, "memoria_fallos.json");
const MAX_ERROR_PATTERNS = 500;

const LEARNING_LOG_PATH =
  envFirstNonEmpty(["LEARNING_LOG_PATH"]) ?? path.join(DEFAULT_TRADING_NOTES_DIR, "log_aprendizaje.md");
const OBSIDIAN_BRAIN_PATH =
  envFirstNonEmpty(["OBSIDIAN_BRAIN_PATH"]) ?? path.join(DEFAULT_TRADING_NOTES_DIR, "cerebro.md");
const DAILY_BALANCE_PATH =
  envFirstNonEmpty(["DAILY_BALANCE_PATH", "BALANCE_APRENDIZAJE_PATH"]) ??
  path.join(DEFAULT_TRADING_NOTES_DIR, "Balance_de_Aprendizaje.md");
const DAILY_STATS_PATH =
  envFirstNonEmpty(["DAILY_STATS_PATH"]) ?? path.join(DEFAULT_TRADING_NOTES_DIR, "daily_stats.json");
const EXPERTS_DETECTED_PATH =
  envFirstNonEmpty(["EXPERTS_DETECTED_PATH", "EXPERTOS_DETECTADOS_PATH"]) ??
  path.join(DEFAULT_TRADING_NOTES_DIR, "experts_detectados.json");
const TRADE_HISTORY_PATH =
  envFirstNonEmpty(["TRADE_HISTORY_PATH"]) ?? path.join(DEFAULT_TRADING_NOTES_DIR, "historial_trades.json");
const TRADE_HISTORY_MAX = Number.isFinite(Number(process.env.TRADE_HISTORY_MAX))
  ? Math.max(20, Math.min(10000, Math.floor(Number(process.env.TRADE_HISTORY_MAX))))
  : 100;
const SABIDURIA_EVOLUTIVA_PATH =
  envFirstNonEmpty(["SABIDURIA_EVOLUTIVA_PATH"]) ?? path.join(DEFAULT_TRADING_NOTES_DIR, "SABIDURIA_EVOLUTIVA.md");
const BRAIN_AI_ENABLED = !["0", "false", "off", "no"].includes(
  String(process.env.BRAIN_AI_ENABLED ?? "1").trim().toLowerCase()
);
const BRAIN_AI_COOLDOWN_MIN = Number.isFinite(Number(process.env.BRAIN_AI_COOLDOWN_MIN))
  ? Math.max(1, Math.min(24 * 60, Math.floor(Number(process.env.BRAIN_AI_COOLDOWN_MIN))))
  : 30;

const brainLessonCooldown = new Map();
let wisdomCache = { at: 0, entries: [], total: 0 };
const WISDOM_CACHE_MS = 60_000;
const WISDOM_SEPARATOR = "\n\n---\n\n";

function formatLearningTimestamp(d = new Date()) {
  const iso = d.toISOString();
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function splitWisdomEntries(rawText) {
  const txt = String(rawText ?? "").trim();
  if (!txt) return [];
  const bySep = txt.split(WISDOM_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  if (bySep.length > 1) return bySep;
  const byHead = txt
    .split(/\n(?=##\s+\[)/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return byHead.length ? byHead : [txt];
}

export async function readWisdomEntries({ last = 3 } = {}) {
  const n = Number.isFinite(Number(last)) ? Math.max(1, Math.min(20, Math.floor(Number(last)))) : 3;
  if (Date.now() - wisdomCache.at < WISDOM_CACHE_MS && wisdomCache.entries.length) {
    return {
      path: SABIDURIA_EVOLUTIVA_PATH,
      total: wisdomCache.total,
      entries: wisdomCache.entries.slice(-n)
    };
  }
  try {
    const txt = await fs.readFile(SABIDURIA_EVOLUTIVA_PATH, "utf8");
    const entries = splitWisdomEntries(txt);
    wisdomCache = { at: Date.now(), entries, total: entries.length };
    return { path: SABIDURIA_EVOLUTIVA_PATH, total: entries.length, entries: entries.slice(-n) };
  } catch {
    wisdomCache = { at: Date.now(), entries: [], total: 0 };
    return { path: SABIDURIA_EVOLUTIVA_PATH, total: 0, entries: [] };
  }
}

export async function appendWisdomEntry({ title, blocks, meta } = {}) {
  const dir = path.dirname(SABIDURIA_EVOLUTIVA_PATH);
  await fs.mkdir(dir, { recursive: true });
  const ts = formatLearningTimestamp();
  const t = String(title ?? "").trim() || "Lección";
  const m = meta && typeof meta === "object" ? meta : null;
  const lines = [];
  lines.push(`## [${ts}] ${t}`);
  if (m) {
    const metaLine = Object.entries(m)
      .map(([k, v]) => `${String(k)}=${String(v)}`)
      .join(" | ");
    if (metaLine) lines.push(`Meta: ${metaLine}`);
  }
  lines.push("");
  const arr = Array.isArray(blocks) ? blocks : [];
  for (const b of arr) {
    const s = String(b ?? "").trim();
    if (!s) continue;
    lines.push(s);
    lines.push("");
  }
  const entry = lines.join("\n").trim() + "\n";
  const prefix = entry && entry.startsWith("## ") ? "" : "## ";
  const txt = (prefix ? prefix + entry : entry).trimEnd();

  let needsSep = false;
  try {
    const prev = await fs.readFile(SABIDURIA_EVOLUTIVA_PATH, "utf8");
    needsSep = Boolean(String(prev).trim());
  } catch {
    needsSep = false;
  }
  await fs.appendFile(SABIDURIA_EVOLUTIVA_PATH, (needsSep ? WISDOM_SEPARATOR : "") + txt + "\n", "utf8");
  wisdomCache = { at: 0, entries: [], total: 0 };
  return { ok: true, path: SABIDURIA_EVOLUTIVA_PATH };
}

function formatWisdomContext(entries, maxChars = 900) {
  const arr = Array.isArray(entries) ? entries : [];
  if (!arr.length) return "";
  const compact = arr
    .slice(-3)
    .map((e) => String(e).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ");
  if (!compact) return "";
  return compact.length > maxChars ? compact.slice(0, maxChars) : compact;
}

function normalizeEngramTokens(text) {
  const cleaned = String(text ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/g).filter((t) => t.length >= 3);
}

function buildNgrams(tokens, n = 3) {
  const nn = Number.isFinite(Number(n)) ? Math.max(1, Math.min(6, Math.floor(Number(n)))) : 3;
  const out = [];
  for (let i = 0; i + nn <= tokens.length; i += 1) out.push(tokens.slice(i, i + nn).join("_"));
  return out;
}

function fnv1a32(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function buildEngramIndex({ snippets, n = 3, maxPerKey = 6 } = {}) {
  const arr = Array.isArray(snippets) ? snippets : [];
  const nn = Number.isFinite(Number(n)) ? Math.max(1, Math.min(6, Math.floor(Number(n)))) : 3;
  const cap = Number.isFinite(Number(maxPerKey)) ? Math.max(1, Math.min(30, Math.floor(Number(maxPerKey)))) : 6;
  const index = new Map();
  for (let i = 0; i < arr.length; i += 1) {
    const txt = String(arr[i] ?? "").trim();
    if (!txt) continue;
    const tokens = normalizeEngramTokens(txt);
    if (!tokens.length) continue;
    const grams = buildNgrams(tokens, nn);
    const uniq = new Set(grams);
    for (const g of uniq) {
      const k = fnv1a32(g);
      const prev = index.get(k);
      if (!prev) {
        index.set(k, [i]);
      } else if (prev.length < cap && !prev.includes(i)) {
        prev.push(i);
      }
    }
  }
  return { index, n: nn, snippets: arr };
}

function engramRecallText({ query, snippets, n = 3, limit = 4, maxChars = 900 } = {}) {
  const qTokens = normalizeEngramTokens(query);
  if (!qTokens.length) return "";
  const nn = Number.isFinite(Number(n)) ? Math.max(1, Math.min(6, Math.floor(Number(n)))) : 3;
  const { index } = buildEngramIndex({ snippets, n: nn });
  const qKeys = new Set(buildNgrams(qTokens, nn).map((g) => fnv1a32(g)));
  const scores = new Map();
  for (const k of qKeys) {
    const hits = index.get(k);
    if (!hits) continue;
    for (const idx of hits) scores.set(idx, Number(scores.get(idx) ?? 0) + 1);
  }
  const items = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Number.isFinite(Number(limit)) ? Math.max(1, Math.min(12, Math.floor(Number(limit)))) : 4);
  const out = [];
  for (const [idx, score] of items) {
    const raw = String(snippets?.[idx] ?? "").replace(/\s+/g, " ").trim();
    if (!raw) continue;
    out.push(`${score}x ${raw}`);
  }
  const joined = out.join(" | ");
  if (!joined) return "";
  const cap = Number.isFinite(Number(maxChars)) ? Math.max(200, Math.min(2000, Math.floor(Number(maxChars)))) : 900;
  return joined.length > cap ? joined.slice(0, cap) : joined;
}

async function readRecentLossContext({ last = 3, maxChars = 700 } = {}) {
  const n = Number.isFinite(Number(last)) ? Math.max(1, Math.min(10, Math.floor(Number(last)))) : 3;
  const cap = Number.isFinite(Number(maxChars)) ? Math.max(200, Math.min(2000, Math.floor(Number(maxChars)))) : 700;
  try {
    const hist = await loadTradeHistory();
    const items = Array.isArray(hist?.items) ? hist.items : [];
    const losses = items.filter((t) => Number(t?.pnl_num) < 0).slice(-n);
    if (!losses.length) return "";
    const text = losses
      .map((t) => {
        const symbol = String(t?.symbol ?? "").trim();
        const side = String(t?.side ?? "").trim();
        const motivo = String(t?.motivo ?? "").trim();
        const pnl = String(t?.resultado ?? "").trim();
        const parts = [];
        if (symbol) parts.push(symbol);
        if (side) parts.push(side);
        const head = parts.length ? `${parts.join(" ")}:` : "";
        const detail = [motivo, pnl].filter(Boolean).join(" ");
        return `${head} ${detail}`.trim();
      })
      .filter(Boolean)
      .join(" | ");
    if (!text) return "";
    return text.length > cap ? text.slice(0, cap) : text;
  } catch {
    return "";
  }
}

export async function learnFromLossWithDeepseek({ apiKey, trade, signal, extraNotes } = {}) {
  if (!BRAIN_AI_ENABLED) return { enabled: false };
  const key = String(apiKey ?? "").trim();
  if (!key) return { enabled: false };
  const t = trade && typeof trade === "object" ? trade : {};
  const s = signal && typeof signal === "object" ? signal : null;
  const symbol = String(t.symbol ?? s?.symbol ?? "").trim();
  const timeframe = String(t.timeframe ?? s?.timeframe ?? "").trim();
  if (!symbol) return { enabled: false };

  const cooldownKey = `${symbol}|${timeframe}`;
  const lastAt = Number(brainLessonCooldown.get(cooldownKey) ?? 0);
  const cooldownMs = BRAIN_AI_COOLDOWN_MIN * 60_000;
  if (Number.isFinite(lastAt) && Date.now() - lastAt < cooldownMs) return { enabled: true, skipped: true };
  brainLessonCooldown.set(cooldownKey, Date.now());

  const headlines = await fetchCryptoNewsHeadlines({ maxTitles: 8 }).catch(() => []);
  const prompt = [
    "Eres un analista post-mortem de trading. Responde en JSON puro.",
    "",
    `SIMBOLO: ${symbol}`,
    `EXCHANGE: ${String(t.exchange ?? s?.exchange ?? "")}`,
    `TIMEFRAME: ${timeframe}`,
    `SIDE: ${String(t.side ?? s?.side ?? "")}`,
    `ENTRY: ${String(t.entry ?? s?.entry ?? "")}`,
    `SL: ${String(t.sl ?? s?.sl ?? "")}`,
    `TP: ${String(t.tp ?? s?.tp ?? "")}`,
    `EXIT: ${String(t.exit ?? "")}`,
    `RESULTADO_R: ${String(t.r ?? "")}`,
    s?.indicators ? `INDICADORES: RSI=${s.indicators.rsi} ATR=${s.indicators.atr} EMA_FAST=${s.indicators.emaFast} EMA_SLOW=${s.indicators.emaSlow}` : "",
    headlines.length ? `NOTICIAS: ${headlines.join(" | ")}` : "",
    extraNotes ? `NOTAS: ${String(extraNotes).slice(0, 800)}` : "",
    "",
    "Devuelve JSON con: titulo, leccion, regla, gatillos, accion_futura (todas string, cortas)."
  ]
    .filter(Boolean)
    .join("\n");

  const ai = await consultDeepseek({ apiKey: key, promptText: prompt, temperature: 0.2 });
  const titulo = String(ai?.titulo ?? "").trim() || `Post-mortem ${symbol} ${timeframe}`;
  const blocks = [];
  const leccion = String(ai?.leccion ?? "").trim();
  const regla = String(ai?.regla ?? "").trim();
  const gatillos = String(ai?.gatillos ?? "").trim();
  const accion = String(ai?.accion_futura ?? "").trim();
  if (leccion) blocks.push(`Lección: ${leccion}`);
  if (regla) blocks.push(`Regla: ${regla}`);
  if (gatillos) blocks.push(`Gatillos: ${gatillos}`);
  if (accion) blocks.push(`Acción futura: ${accion}`);

  if (blocks.length) {
    await appendWisdomEntry({
      title: titulo,
      blocks,
      meta: {
        symbol,
        timeframe,
        exchange: String(t.exchange ?? s?.exchange ?? ""),
        side: String(t.side ?? s?.side ?? ""),
        reason: String(t.reason ?? "")
      }
    });
  }
  return { enabled: true, ok: Boolean(blocks.length), titulo };
}

function normalizeForSearch(text) {
  return String(text ?? "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function filtrarPorSabiduria({ signals, wisdomEntries } = {}) {
  const arr = Array.isArray(signals) ? signals : [];
  const entries = Array.isArray(wisdomEntries) ? wisdomEntries : [];
  if (!arr.length || !entries.length) return { kept: arr, blockedSymbols: [] };

  const blocked = [];
  const kept = [];
  for (const s of arr) {
    const sym = normalizeForSearch(s?.symbol ?? "");
    if (!sym) {
      kept.push(s);
      continue;
    }
    let shouldBlock = false;
    for (const e of entries) {
      const one = normalizeForSearch(e);
      const mentions =
        one.includes(`SYMBOL=${sym}`) || one.includes(`ERROR EN ${sym}`) || one.includes(` ${sym} `) || one.endsWith(sym) || one.startsWith(sym);
      if (!mentions) continue;
      const hasBan =
        one.includes("REGLA:") && (one.includes("NO OPERAR") || one.includes("EVITAR")) ||
        one.includes("SENTENCIA:") && one.includes("NO OPERAR") ||
        one.includes("LECCIÓN DE ORO:") && (one.includes("NO OPERAR") || one.includes("EVITAR"));
      if (hasBan) {
        shouldBlock = true;
        break;
      }
    }
    if (shouldBlock) {
      blocked.push(sym);
      continue;
    }
    kept.push(s);
  }
  const uniq = [];
  for (const b of blocked) if (!uniq.includes(b)) uniq.push(b);
  return { kept, blockedSymbols: uniq };
}

export async function generarAutocritica({ apiKey, tradeFallido, contexto } = {}) {
  const enabled = !["0", "false", "off", "no"].includes(
    String(process.env.POSTMORTEM_ENABLED ?? "1").trim().toLowerCase()
  );
  if (!enabled) return { enabled: false };
  const key = String(apiKey ?? "").trim();
  if (!key) return { enabled: true, ok: false, reason: "MISSING_DEEPSEEK_KEY" };

  const t = tradeFallido && typeof tradeFallido === "object" ? tradeFallido : {};
  const symbol = String(t.symbol ?? "").trim();
  const timeframe = String(t.timeframe ?? "").trim();
  const side = String(t.side ?? "").trim();
  const motivo = String(t.reason ?? "").trim() || "SL";
  const pnl = typeof t.pnl_num === "number" ? t.pnl_num : null;

  const ctx = contexto && typeof contexto === "object" ? contexto : {};
  const ctxText = toSafeLogText(ctx).slice(0, 1800);

  const prompt = [
    "Eres un analista post-mortem de trading con estilo directo. Responde en JSON puro.",
    "",
    "SISTEMA DE TRADING FALLIDO:",
    `Moneda: ${symbol || "N/A"}`,
    `Timeframe: ${timeframe || "N/A"}`,
    `Side: ${side || "N/A"}`,
    `Pérdida(%): ${Number.isFinite(Number(pnl)) ? Number(pnl).toFixed(2) : "N/A"}`,
    `Motivo: ${motivo} (Stop Loss alcanzado).`,
    `Contexto: ${ctxText || "N/A"}`,
    "",
    "1) Explica en qué se equivocó el bot (concretamente).",
    "2) Da una 'Lección de Oro' accionable (una regla corta).",
    "3) Propón una mejora técnica concreta del bot (parámetro -> nuevo valor y por qué).",
    "",
    "Devuelve JSON con: que_paso, leccion_de_oro, mejora_tecnica (strings cortos)."
  ].join("\n");

  const ai = await consultDeepseek({ apiKey: key, promptText: prompt, temperature: 0.2 });
  const quePaso = String(ai?.que_paso ?? "").trim();
  const leccion = String(ai?.leccion_de_oro ?? "").trim();
  const mejora = String(ai?.mejora_tecnica ?? "").trim();

  const blocks = [];
  if (quePaso) blocks.push(`¿Qué pasó?: ${quePaso}`);
  if (leccion) blocks.push(`Regla: ${leccion}`);
  if (mejora) blocks.push(`Mejora Técnica: ${mejora}`);
  await appendWisdomEntry({
    title: `Post-Mortem Psicológico · ${symbol || "N/A"} ${timeframe}`.trim(),
    blocks,
    meta: {
      symbol,
      timeframe,
      side,
      reason: motivo
    }
  });

  return { enabled: true, ok: true, que_paso: quePaso, leccion_de_oro: leccion, mejora_tecnica: mejora, path: SABIDURIA_EVOLUTIVA_PATH };
}

function toSafeLogText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim();
  if (v instanceof Error) {
    const msg = v.message ? String(v.message) : String(v);
    const stack = v.stack ? String(v.stack) : "";
    const out = stack && !stack.includes(msg) ? `${msg}\n${stack}` : stack || msg;
    return out.trim();
  }
  try {
    return JSON.stringify(v, null, 2).trim();
  } catch {
    return String(v).trim();
  }
}

export async function registrar_aprendizaje(suceso, solucion) {
  const logPath = LEARNING_LOG_PATH;
  const dir = path.dirname(logPath);
  await fs.mkdir(dir, { recursive: true });

  const ts = formatLearningTimestamp();
  const learned = toSafeLogText(suceso);
  const fixed = toSafeLogText(solucion);

  const entry =
    `## [${ts}]\n\n` +
    `Lo que aprendí: ${learned}\n\n` +
    `Cómo lo resolví: ${fixed}\n\n`;

  await fs.appendFile(logPath, entry, { encoding: "utf8", flag: "a" });
  return { ok: true, path: logPath };
}

export async function registrar_obsidian_markdown(markdown) {
  const logPath = OBSIDIAN_BRAIN_PATH;
  const dir = path.dirname(logPath);
  await fs.mkdir(dir, { recursive: true });
  const txt = String(markdown ?? "").trimEnd() + "\n";
  await fs.appendFile(logPath, txt, { encoding: "utf8", flag: "a" });
  return { ok: true, path: logPath };
}

async function readJsonFileSafe(path) {
  try {
    const txt = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJsonFile(path, obj) {
  const txt = JSON.stringify(obj, null, 2);
  await fs.writeFile(path, txt, "utf8");
}

export async function loadTradeHistory() {
  const raw = await readJsonFileSafe(TRADE_HISTORY_PATH);
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  return { path: TRADE_HISTORY_PATH, items: arr };
}

function computePnlPct({ side, entry, exit }) {
  const e = Number(entry);
  const x = Number(exit);
  if (!Number.isFinite(e) || !Number.isFinite(x) || e === 0) return null;
  if (side === "LONG") return ((x - e) / e) * 100;
  if (side === "SHORT") return ((e - x) / e) * 100;
  return null;
}

export async function registrarEnHistorial(pos, motivo, precioCierre) {
  const p = pos && typeof pos === "object" ? pos : {};
  const side = String(p.side ?? "").toUpperCase();
  const symbol = String(p.symbol ?? "").trim();
  const exchange = String(p.exchange ?? "").trim();
  const entry = Number(p.entry ?? p.entryPrice);
  const exit = Number(precioCierre ?? p.exit ?? p.exitPrice);
  const pnl = computePnlPct({ side, entry, exit });

  const record = {
    id: String(p.id ?? `hist_${nowMs()}_${Math.random().toString(16).slice(2)}`),
    fecha: new Date().toISOString(),
    symbol,
    exchange,
    side,
    motivo: String(motivo ?? p.reason ?? "").trim(),
    resultado: pnl === null ? "N/A" : `${formatNumber(pnl, 2)}%`,
    tp1_tocado: String(motivo ?? p.reason ?? "") === "TP" ? "SÍ" : "NO",
    pnl_num: pnl
  };

  const prev = await loadTradeHistory();
  const items = Array.isArray(prev.items) ? prev.items : [];
  items.push(record);
  const keep = items.slice(-TRADE_HISTORY_MAX);
  await fs.mkdir(path.dirname(TRADE_HISTORY_PATH), { recursive: true }).catch(() => {});
  await writeJsonFile(TRADE_HISTORY_PATH, keep);
  return { ok: true, path: TRADE_HISTORY_PATH, record };
}

function sumFinite(values) {
  let s = 0;
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

function avgFinite(values) {
  let s = 0;
  let n = 0;
  for (const v of values) {
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    s += x;
    n += 1;
  }
  return n ? s / n : null;
}

export async function generarReporteSemanal({ now, days } = {}) {
  const d = now instanceof Date ? now : new Date();
  const windowDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(60, Math.floor(Number(days)))) : 7;
  const from = new Date(d.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const hist = await loadTradeHistory();
  const items = Array.isArray(hist.items) ? hist.items : [];
  if (!items.length) {
    return { ok: true, text: "No hay datos para el reporte semanal.", path: hist.path, from: from.toISOString(), to: d.toISOString() };
  }

  const trades = items.filter((t) => {
    const ts = Date.parse(String(t?.fecha ?? ""));
    return Number.isFinite(ts) && ts >= from.getTime();
  });

  if (!trades.length) {
    return { ok: true, text: "Sin operaciones esta semana.", path: hist.path, from: from.toISOString(), to: d.toISOString() };
  }

  const pnls = trades.map((t) => Number(t?.pnl_num));
  const pnlTotal = sumFinite(pnls);
  const avgPnl = avgFinite(pnls);
  const ganadores = trades.filter((t) => Number(t?.pnl_num) > 0).length;
  const perdedores = trades.filter((t) => Number.isFinite(Number(t?.pnl_num)) && Number(t.pnl_num) <= 0).length;
  const winRate = trades.length ? (ganadores / trades.length) * 100 : 0;

  const sorted = trades
    .filter((t) => Number.isFinite(Number(t?.pnl_num)))
    .slice()
    .sort((a, b) => Number(b.pnl_num) - Number(a.pnl_num));
  const topWin = sorted[0] ?? null;
  const topLoss = sorted[sorted.length - 1] ?? null;

  const sugg = pnlTotal > 0 ? "Mantener estrategia actual." : "Ajustar filtros de confianza.";
  const pnlTxt = formatNumber(pnlTotal, 2);
  const avgTxt = avgPnl === null ? "N/A" : formatNumber(avgPnl, 2);
  const wrTxt = formatNumber(winRate, 2);

  const extra = [];
  if (topWin?.symbol) extra.push(`🏆 Mejor trade: ${topWin.symbol} ${formatNumber(topWin.pnl_num, 2)}% (${topWin.motivo ?? "N/A"})`);
  if (topLoss?.symbol) extra.push(`🧨 Peor trade: ${topLoss.symbol} ${formatNumber(topLoss.pnl_num, 2)}% (${topLoss.motivo ?? "N/A"})`);

  const text = [
    "📊 **REPORTE SEMANAL: AETHER LABS**",
    "━━━━━━━━━━━━━━━━━━",
    `🗓️ Periodo: Últimos ${windowDays} días`,
    `✅ Trades Ganados: ${ganadores}`,
    `❌ Trades Perdidos: ${perdedores}`,
    `🎯 Win Rate: ${wrTxt}%`,
    `💰 PNL Neto: ${pnlTxt}%`,
    `📈 PNL Promedio: ${avgTxt}%`,
    ...extra,
    "━━━━━━━━━━━━━━━━━━",
    `🧠 *Sugerencia IA:* ${sugg}`
  ].join("\n");

  return {
    ok: true,
    text,
    from: from.toISOString(),
    to: d.toISOString(),
    path: hist.path,
    count: trades.length,
    ganadores,
    perdedores,
    winRate,
    pnlTotal
  };
}

export async function loadMemory() {
  const raw = await readJsonFileSafe(MEMORY_FILE);
  if (!raw) return { trades: [], positions: [], stats: {}, strategyStats: {}, config: { alerts: {} } };
  const trades = Array.isArray(raw.trades) ? raw.trades : [];
  const positions = Array.isArray(raw.positions) ? raw.positions : [];
  const stats = raw.stats && typeof raw.stats === "object" ? raw.stats : {};
  const strategyStats = raw.strategyStats && typeof raw.strategyStats === "object" ? raw.strategyStats : {};
  const config = raw.config && typeof raw.config === "object" ? raw.config : { alerts: {} };
  config.alerts = config.alerts && typeof config.alerts === "object" ? config.alerts : {};
  return { trades, positions, stats, strategyStats, config };
}

export async function saveMemory(mem) {
  const safe = {
    trades: Array.isArray(mem?.trades) ? mem.trades.slice(-MAX_MEMORY_TRADES) : [],
    positions: Array.isArray(mem?.positions) ? mem.positions : [],
    stats: mem?.stats && typeof mem.stats === "object" ? mem.stats : {},
    strategyStats: mem?.strategyStats && typeof mem.strategyStats === "object" ? mem.strategyStats : {},
    config: mem?.config && typeof mem.config === "object" ? mem.config : { alerts: {} }
  };
  safe.config.alerts =
    safe.config.alerts && typeof safe.config.alerts === "object" ? safe.config.alerts : {};
  await writeJsonFile(MEMORY_FILE, safe);
  return safe;
}

function normalizeTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúüñ/:\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function jaccardSimilarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function buildErrorPatternText(p) {
  const parts = [
    p.type,
    p.exchange,
    p.market,
    p.symbol,
    p.timeframe,
    p.side,
    p.reason,
    p.notes
  ]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return parts.join(" | ");
}

export async function loadErrorMemory() {
  const raw = await readJsonFileSafe(ERROR_MEMORY_PATH);
  const rawFallback = !raw && FAIL_MEMORY_PATH !== ERROR_MEMORY_PATH ? await readJsonFileSafe(FAIL_MEMORY_PATH) : null;
  const src = raw ?? rawFallback;
  if (!src) return { patterns: [] };
  const patterns = Array.isArray(src.patterns) ? src.patterns : [];
  const scamSignatures = Array.isArray(src.scamSignatures) ? src.scamSignatures : [];
  return { patterns, scamSignatures };
}

export async function saveErrorMemory(mem) {
  const safe = {
    patterns: Array.isArray(mem?.patterns) ? mem.patterns.slice(-MAX_ERROR_PATTERNS) : [],
    scamSignatures: Array.isArray(mem?.scamSignatures) ? mem.scamSignatures.slice(-MAX_ERROR_PATTERNS) : []
  };
  try {
    await fs.mkdir(path.dirname(ERROR_MEMORY_PATH), { recursive: true }).catch(() => {});
    await writeJsonFile(ERROR_MEMORY_PATH, safe);
    if (FAIL_MEMORY_PATH !== ERROR_MEMORY_PATH) {
      await fs.mkdir(path.dirname(FAIL_MEMORY_PATH), { recursive: true }).catch(() => {});
      await writeJsonFile(FAIL_MEMORY_PATH, safe);
    }
  } catch {
  }
  return safe;
}

export async function recordErrorPattern(pattern) {
  const mem = await loadErrorMemory();
  const p = pattern && typeof pattern === "object" ? pattern : {};
  const entry = {
    id: `err_${nowMs()}_${Math.random().toString(16).slice(2)}`,
    ts: nowMs(),
    date: new Date().toISOString().slice(0, 10),
    type: String(p.type ?? "trade_error"),
    exchange: String(p.exchange ?? DEFAULT_EXCHANGE),
    market: String(p.market ?? "futures"),
    symbol: String(p.symbol ?? ""),
    timeframe: String(p.timeframe ?? ""),
    side: String(p.side ?? ""),
    reason: String(p.reason ?? ""),
    notes: String(p.notes ?? ""),
    features: p.features && typeof p.features === "object" ? p.features : {}
  };
  entry.patternText = buildErrorPatternText(entry);
  mem.patterns = Array.isArray(mem.patterns) ? mem.patterns : [];
  mem.patterns.push(entry);
  await saveErrorMemory(mem);
  return entry;
}

export async function recordScamSignature(signature) {
  const mem = await loadErrorMemory();
  const s = signature && typeof signature === "object" ? signature : {};
  const entry = {
    id: `scam_${nowMs()}_${Math.random().toString(16).slice(2)}`,
    ts: nowMs(),
    date: new Date().toISOString().slice(0, 10),
    type: String(s.type ?? "scam_signature"),
    exchange: String(s.exchange ?? DEFAULT_EXCHANGE),
    market: String(s.market ?? "spot"),
    symbol: String(s.symbol ?? ""),
    timeframe: String(s.timeframe ?? ""),
    side: String(s.side ?? ""),
    reason: String(s.reason ?? ""),
    notes: String(s.notes ?? ""),
    features: s.features && typeof s.features === "object" ? s.features : {}
  };
  entry.patternText = buildErrorPatternText(entry);
  mem.scamSignatures = Array.isArray(mem.scamSignatures) ? mem.scamSignatures : [];
  mem.scamSignatures.push(entry);
  await saveErrorMemory(mem);
  return entry;
}

export async function registrar_error(motivo, indicadores) {
  const feats = indicadores && typeof indicadores === "object" ? indicadores : {};
  const notes = String(motivo ?? "").trim();
  return await recordErrorPattern({
    type: "patron_prohibido",
    reason: notes || "LOSS_PATTERN",
    notes,
    features: feats
  });
}

function closenessAbs(a, b, range) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(range) || range <= 0) return null;
  const d = Math.abs(a - b);
  return 1 - Math.min(1, d / range);
}

function closenessRel(a, b, relRange = 0.25) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(relRange) || relRange <= 0) return null;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  const d = Math.abs(a - b) / denom;
  return 1 - Math.min(1, d / relRange);
}

function featureSimilarity(aFeatures, bFeatures) {
  const a = aFeatures && typeof aFeatures === "object" ? aFeatures : {};
  const b = bFeatures && typeof bFeatures === "object" ? bFeatures : {};
  const weights = new Map([
    ["rsi", 0.25],
    ["atr", 0.15],
    ["volRatio", 0.2],
    ["volume", 0.1],
    ["price", 0.1],
    ["hour", 0.05],
    ["upperRatio", 0.05],
    ["lowerRatio", 0.05],
    ["bodyRatio", 0.05]
  ]);

  let sum = 0;
  let wsum = 0;
  for (const [k, w] of weights.entries()) {
    const av = Number(a[k]);
    const bv = Number(b[k]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
    const s =
      k === "rsi"
        ? closenessAbs(av, bv, 20)
        : k === "hour"
          ? closenessAbs(av, bv, 4)
          : k === "upperRatio" || k === "lowerRatio" || k === "bodyRatio"
            ? closenessAbs(av, bv, 0.25)
            : closenessRel(av, bv, 0.35);
    if (s === null) continue;
    sum += s * w;
    wsum += w;
  }
  return wsum ? sum / wsum : 0;
}

export async function findSimilarError(pattern, threshold = 0.8) {
  const mem = await loadErrorMemory();
  const p = pattern && typeof pattern === "object" ? pattern : {};
  const candidate = {
    type: String(p.type ?? ""),
    exchange: String(p.exchange ?? DEFAULT_EXCHANGE),
    market: String(p.market ?? "futures"),
    symbol: String(p.symbol ?? ""),
    timeframe: String(p.timeframe ?? ""),
    side: String(p.side ?? ""),
    notes: String(p.notes ?? ""),
    features: p.features && typeof p.features === "object" ? p.features : {}
  };

  function eq(a, b) {
    return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
  }

  const aNotes = normalizeTokens(candidate.notes);
  let best = null;
  let bestScore = 0;
  const all = []
    .concat(Array.isArray(mem.patterns) ? mem.patterns : [])
    .concat(Array.isArray(mem.scamSignatures) ? mem.scamSignatures : []);
  for (const prev of all) {
    const metaScore =
      (eq(candidate.type, prev?.type) ? 0.05 : 0) +
      (eq(candidate.symbol, prev?.symbol) ? 0.15 : 0) +
      (eq(candidate.timeframe, prev?.timeframe) ? 0.1 : 0) +
      (eq(candidate.side, prev?.side) ? 0.1 : 0) +
      (eq(candidate.exchange, prev?.exchange) ? 0.05 : 0) +
      (eq(candidate.market, prev?.market) ? 0.05 : 0);
    const noteScore = jaccardSimilarity(aNotes, normalizeTokens(prev?.notes ?? "")) * 0.1;
    const featScore = featureSimilarity(candidate.features, prev?.features) * 0.55;
    const score = metaScore + noteScore + featScore;
    if (score > bestScore) {
      bestScore = score;
      best = prev;
    }
  }
  return bestScore >= threshold ? { match: best, score: bestScore } : { match: null, score: bestScore };
}

async function loadDailyStats() {
  const raw = await readJsonFileSafe(DAILY_STATS_PATH);
  if (!raw) return { days: [] };
  const days = Array.isArray(raw.days) ? raw.days : [];
  return { days };
}

async function saveDailyStats(stats) {
  const safe = { days: Array.isArray(stats?.days) ? stats.days.slice(-400) : [] };
  await fs.mkdir(path.dirname(DAILY_STATS_PATH), { recursive: true }).catch(() => {});
  await writeJsonFile(DAILY_STATS_PATH, safe);
  return safe;
}

export async function loadExpertsDetected() {
  const raw = await readJsonFileSafe(EXPERTS_DETECTED_PATH);
  if (!raw) return { items: [] };
  const items = Array.isArray(raw.items) ? raw.items : [];
  return { items };
}

export async function saveExpertsDetected(mem) {
  const safe = { items: Array.isArray(mem?.items) ? mem.items.slice(-2000) : [] };
  await fs.mkdir(path.dirname(EXPERTS_DETECTED_PATH), { recursive: true }).catch(() => {});
  await writeJsonFile(EXPERTS_DETECTED_PATH, safe);
  return safe;
}

export async function recordExpertDetected({ wallet, chain, roi, notes } = {}) {
  const mem = await loadExpertsDetected();
  const entry = {
    id: `exp_${nowMs()}_${Math.random().toString(16).slice(2)}`,
    ts: nowMs(),
    date: new Date().toISOString().slice(0, 10),
    wallet: String(wallet ?? "").trim(),
    chain: String(chain ?? "").trim(),
    roi: Number.isFinite(Number(roi)) ? Number(roi) : null,
    notes: String(notes ?? "").trim()
  };
  mem.items = Array.isArray(mem.items) ? mem.items : [];
  mem.items.push(entry);
  await saveExpertsDetected(mem);
  return entry;
}

function isoDateFromTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString().slice(0, 10);
}

function safePct(value, decimals = 1) {
  if (!Number.isFinite(value)) return null;
  const m = 10 ** Math.max(0, Math.min(6, Math.floor(decimals)));
  return Math.round(value * m) / m;
}

function isLossLikePattern(p) {
  const type = String(p?.type ?? "").toLowerCase();
  const reason = String(p?.reason ?? "").toLowerCase();
  if (!type) return false;
  if (type === "entry_attempt") return false;
  return (
    type.includes("loss") ||
    type.includes("trade") ||
    type.includes("trap") ||
    type.includes("honeypot") ||
    type.includes("scam") ||
    reason.includes("sl") ||
    reason.includes("timeout") ||
    reason.includes("trampa")
  );
}

function uniqueCount(values) {
  const out = new Set();
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (s) out.add(s);
  }
  return out.size;
}

export async function generar_balance_de_aprendizaje({ date } = {}) {
  const today = String(date ?? "").trim() || new Date().toISOString().slice(0, 10);
  const yday = new Date(Date.parse(`${today}T00:00:00Z`) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const err = await loadErrorMemory();
  const allPatterns = []
    .concat(Array.isArray(err.patterns) ? err.patterns : [])
    .concat(Array.isArray(err.scamSignatures) ? err.scamSignatures : []);
  const patternsToday = allPatterns.filter((p) => String(p?.date ?? "") === today && isLossLikePattern(p));
  const learnedCount = uniqueCount(patternsToday.map((p) => p.patternText ?? p.id));

  const experts = await loadExpertsDetected();
  const expertsToday = (Array.isArray(experts.items) ? experts.items : []).filter((e) => String(e?.date ?? "") === today);
  const walletsCount = uniqueCount(expertsToday.map((e) => e.wallet));

  const mem = await loadMemory();
  const trades = Array.isArray(mem.trades) ? mem.trades : [];
  const closedToday = trades.filter((t) => isoDateFromTs(t?.closedAt) === today);
  const nToday = closedToday.length;
  const winsToday = closedToday.filter((t) => Number.isFinite(Number(t?.r)) && Number(t.r) > 0).length;
  const winRateToday = nToday ? winsToday / nToday : 0;

  const stats = await loadDailyStats();
  const y = (Array.isArray(stats.days) ? stats.days : []).find((d) => d?.date === yday) ?? null;
  const winRateYday = y && Number.isFinite(Number(y.winRate)) ? Number(y.winRate) : null;
  const deltaPp = winRateYday === null ? 0 : (winRateToday - winRateYday) * 100;

  const winRateTodayPct = safePct(winRateToday * 100, 1) ?? 0;
  const winRateYdayPct = winRateYday === null ? null : safePct(winRateYday * 100, 1);
  const deltaTxt = safePct(deltaPp, 1) ?? 0;
  const evol = deltaTxt >= 0 ? `Mi precisión ha subido un ${deltaTxt}% respecto a ayer` : `Mi precisión ha bajado un ${Math.abs(deltaTxt)}% respecto a ayer`;

  const lines = [
    `## [${today}] Balance de Aprendizaje`,
    "",
    `Hoy aprendí: ${learnedCount} patrones que causan pérdidas.`,
    `Hoy descubrí: ${walletsCount} billeteras nuevas con alta rentabilidad.`,
    `Evolución: ${evol}.`,
    "",
    `Precisión hoy: ${winRateTodayPct}% (${winsToday}/${nToday}).`,
    winRateYdayPct === null ? "Precisión ayer: N/A." : `Precisión ayer: ${winRateYdayPct}%.`,
    ""
  ];

  await fs.mkdir(path.dirname(DAILY_BALANCE_PATH), { recursive: true }).catch(() => {});
  await fs.appendFile(DAILY_BALANCE_PATH, lines.join("\n"), { encoding: "utf8", flag: "a" });

  const nextDays = (Array.isArray(stats.days) ? stats.days : []).filter((d) => d?.date !== today);
  nextDays.push({ date: today, winRate: winRateToday, learnedCount, walletsCount });
  await saveDailyStats({ days: nextDays });

  return {
    ok: true,
    path: DAILY_BALANCE_PATH,
    date: today,
    learnedCount,
    walletsCount,
    winRateToday
  };
}

export async function verificar_honeypot({ chain, tokenAddress } = {}) {
  const enabled = ["1", "true", "on", "yes"].includes(
    String(process.env.HONEYPOT_CHECK_ENABLED ?? "").trim().toLowerCase()
  );
  if (!enabled) return { enabled: false, ok: true, reason: "DISABLED" };

  const url = String(process.env.HONEYPOT_CHECK_URL ?? "").trim();
  const addr = String(tokenAddress ?? "").trim();
  const ch = String(chain ?? "").trim();
  if (!url || !addr) return { enabled: true, ok: false, reason: "MISSING_CONFIG" };

  const qs = new URLSearchParams({ chain: ch, address: addr }).toString();
  const full = url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;

  const res = await fetch(full, { method: "GET" });
  const txt = await res.text();
  if (!res.ok) return { enabled: true, ok: false, reason: `HTTP_${res.status}`, raw: txt.slice(0, 800) };

  const json = extractJsonObject(txt) ?? {};
  const cannotSell =
    Boolean(json.cannot_sell) ||
    Boolean(json.cannotSell) ||
    Boolean(json.no_sell) ||
    Boolean(json.noSell) ||
    Boolean(json?.result?.cannot_sell) ||
    Boolean(json?.result?.cannotSell);
  const sellTax =
    Number.isFinite(Number(json.sell_tax)) ? Number(json.sell_tax) :
      Number.isFinite(Number(json.sellTax)) ? Number(json.sellTax) :
        Number.isFinite(Number(json?.result?.sell_tax)) ? Number(json.result.sell_tax) :
          Number.isFinite(Number(json?.result?.sellTax)) ? Number(json.result.sellTax) : null;
  const buyTax =
    Number.isFinite(Number(json.buy_tax)) ? Number(json.buy_tax) :
      Number.isFinite(Number(json.buyTax)) ? Number(json.buyTax) :
        Number.isFinite(Number(json?.result?.buy_tax)) ? Number(json.result.buy_tax) :
          Number.isFinite(Number(json?.result?.buyTax)) ? Number(json.result.buyTax) : null;
  const explicitHoneypot =
    Boolean(json.is_honeypot) ||
    Boolean(json.isHoneypot) ||
    Boolean(json.honeypot) ||
    Boolean(json?.result?.is_honeypot) ||
    Boolean(json?.result?.isHoneypot);

  const taxLimit = Number.isFinite(Number(process.env.HONEYPOT_MAX_TAX_PCT)) ? Number(process.env.HONEYPOT_MAX_TAX_PCT) : 20;
  const highTax = (Number.isFinite(sellTax) && sellTax > taxLimit) || (Number.isFinite(buyTax) && buyTax > taxLimit);

  const ok = !cannotSell && !explicitHoneypot && !highTax;
  const reason = cannotSell ? "CANNOT_SELL" : explicitHoneypot ? "HONEYPOT" : highTax ? "HIGH_TAX" : "OK";
  return { enabled: true, ok, reason, buyTax, sellTax, cannotSell };
}

export async function validar_escenario(actual_rsi, actual_vol) {
  const features = {
    rsi: Number(actual_rsi),
    volRatio: Number(actual_vol)
  };
  const sim = await findSimilarError({ type: "entry_attempt", notes: "", features }, 0.85);
  return sim?.match ? { ok: false, ...sim } : { ok: true, ...sim };
}

export async function getAlertsConfig(chatId) {
  const mem = await loadMemory();
  const id = String(chatId ?? "");
  const entry = mem.config?.alerts?.[id];
  if (!entry || typeof entry !== "object") return null;
  return entry;
}

export async function setAlertsConfig(chatId, cfg) {
  const mem = await loadMemory();
  mem.config = mem.config && typeof mem.config === "object" ? mem.config : { alerts: {} };
  mem.config.alerts = mem.config.alerts && typeof mem.config.alerts === "object" ? mem.config.alerts : {};
  const id = String(chatId ?? "");
  if (!id) return null;
  if (cfg === null) {
    delete mem.config.alerts[id];
  } else {
    mem.config.alerts[id] = cfg;
  }
  await saveMemory(mem);
  return mem.config.alerts[id] ?? null;
}

function keyFor(symbol, timeframe) {
  return `${String(symbol ?? "").toUpperCase()}|${String(timeframe ?? "").toLowerCase()}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeRMultiple(side, entry, sl, exit) {
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(exit)) return null;
  const risk = Math.abs(entry - sl);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  if (side === "LONG") return (exit - entry) / risk;
  if (side === "SHORT") return (entry - exit) / risk;
  return null;
}

export function adaptiveConfidenceMultiplier(statsEntry) {
  if (!statsEntry) return 1;
  const wr = Number(statsEntry.winRate);
  const n = Number(statsEntry.n);
  if (!Number.isFinite(wr) || !Number.isFinite(n) || n < 5) return 1;
  return clamp(0.75 + (wr - 0.5) * 1.5, 0.5, 1.5);
}

function extractJsonObject(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const candidate = s.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

export function parseSignalRequest(text) {
  const cleaned = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");

  const parts = cleaned.split(" ").filter(Boolean);
  const symbol = normalizeSymbol(parts[0]);
  const timeframe = parts[1];
  const exchange = parts[2] ? String(parts[2]).trim().toLowerCase() : DEFAULT_EXCHANGE;
  return { symbol, timeframe, exchange };
}

export function parseMultiRequest(text) {
  const cleaned = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");

  const parts = cleaned.split(" ").filter(Boolean);
  const symbol = normalizeSymbol(parts[0]);
  const exchange = parts[1] ? String(parts[1]).trim().toLowerCase() : DEFAULT_EXCHANGE;
  return { symbol, exchange };
}

export function getDefaultTimeframes() {
  return ["1m", "5m", "15m", "1h", "4h", "1d"];
}

function getExchange(exchangeName = DEFAULT_EXCHANGE) {
  const name = String(exchangeName ?? DEFAULT_EXCHANGE).toLowerCase();
  if (exchangeCache.has(name)) return exchangeCache.get(name);

  const ExchangeClass = ccxt[name];
  if (!ExchangeClass) {
    const supported = Array.isArray(ccxt.exchanges) ? ccxt.exchanges.slice(0, 30).join(", ") : "";
    throw new Error(`Exchange no soportado: ${name}. Ejemplos: ${supported}`);
  }

  const ex = new ExchangeClass({
    enableRateLimit: true,
    timeout: 20000
  });
  const p = nextProxy();
  if (p) ex.proxy = p;
  exchangeCache.set(name, ex);
  return ex;
}

function resolveMarketSymbol(markets, symbol) {
  const s = String(symbol ?? "").trim();
  if (!s) return null;
  if (s in markets) return s;
  const upper = s.toUpperCase();
  const keys = Object.keys(markets);
  let key = keys.find((k) => k.toUpperCase() === upper);
  if (key) return key;
  key = keys.find((k) => k.toUpperCase().startsWith(`${upper}:`));
  if (key) return key;
  if (upper.includes("/")) {
    const [base, quote] = upper.split("/");
    const match = Object.values(markets).find(
      (m) =>
        String(m?.base ?? "").toUpperCase() === base &&
        String(m?.quote ?? "").toUpperCase() === quote
    );
    if (match?.symbol) return match.symbol;
  }
  return null;
}

export async function fetchCandles({ exchange, symbol, timeframe, limit = DEFAULT_LIMIT }) {
  const ex = getExchange(exchange);
  if (!ex.has?.fetchOHLCV) throw new Error(`El exchange ${exchange} no soporta OHLCV`);
  const maxAttempts = Number.isFinite(Number(process.env.FETCH_RETRY_ATTEMPTS))
    ? Math.max(1, Math.min(5, Math.floor(Number(process.env.FETCH_RETRY_ATTEMPTS))))
    : 4;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const m = await ex.loadMarkets();
      const normalizedSymbol = resolveMarketSymbol(m, symbol);
      if (!normalizedSymbol) throw new Error(`Símbolo no encontrado en ${exchange}: ${symbol}`);

      const tfOk = ex.timeframes ? Boolean(ex.timeframes[timeframe]) : true;
      if (!tfOk) throw new Error(`Timeframe inválido en ${exchange}: ${timeframe}`);

      const ohlcv = await ex.fetchOHLCV(normalizedSymbol, timeframe, undefined, limit);
      if (!Array.isArray(ohlcv) || ohlcv.length < 50) throw new Error("No hay suficientes velas para calcular señal");
      return { exchange, symbol: normalizedSymbol, timeframe, candles: ohlcv };
    } catch (e) {
      lastErr = e;
      if (!isRetryableExchangeError(e) || attempt === maxAttempts - 1) break;
      if (proxyPool.length && shouldRotateProxy(e)) {
        const p = nextProxy();
        if (p) ex.proxy = p;
      }
      const backoff = 1000 * 2 ** attempt;
      await sleep(backoff);
    }
  }

  throw lastErr ?? new Error("fetchCandles falló");
}

export async function fetchLastPrice({ exchange, symbol }) {
  const ex = getExchange(exchange);
  if (!ex.has?.fetchTicker) throw new Error(`El exchange ${exchange} no soporta ticker`);
  const m = await ex.loadMarkets();
  const normalizedSymbol = resolveMarketSymbol(m, symbol);
  if (!normalizedSymbol) throw new Error(`Símbolo no encontrado en ${exchange}: ${symbol}`);
  const t = await ex.fetchTicker(normalizedSymbol);
  const candidates = [t?.last, t?.close, t?.bid, t?.ask]
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
  if (!candidates.length) throw new Error("Ticker sin precio usable");
  return { exchange, symbol: normalizedSymbol, price: candidates[0], ticker: t };
}

export async function listSpotSymbols({ exchange, quote = "USDT", maxSymbols = 200 } = {}) {
  const ex = getExchange(exchange);
  const markets = await ex.loadMarkets();
  const out = [];

  for (const m of Object.values(markets)) {
    if (!m?.active) continue;
    if (m?.contract) continue;
    if (m?.spot !== true && m?.type !== "spot") continue;
    if (String(m?.quote ?? "").toUpperCase() !== String(quote).toUpperCase()) continue;
    const symbol = String(m?.symbol ?? "");
    if (!symbol || symbol.includes(":")) continue;

    const base = String(m?.base ?? "").toUpperCase();
    if (!base) continue;
    if (/(UP|DOWN|BEAR|BULL|3L|3S|5L|5S)$/.test(base)) continue;

    out.push(symbol);
  }

  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, Math.max(1, Number(maxSymbols) || 200));
}

export async function listFuturesSymbols({ exchange, quote = "USDT", maxSymbols = 200 } = {}) {
  const ex = getExchange(exchange);
  const markets = await ex.loadMarkets();
  const out = [];

  for (const m of Object.values(markets)) {
    if (!m?.active) continue;
    if (!m?.contract) continue;
    if (m?.option) continue;
    if (m?.future) continue;
    if (m?.swap !== true) continue;
    if (String(m?.quote ?? "").toUpperCase() !== String(quote).toUpperCase()) continue;
    if (m?.linear !== true) continue;
    const symbol = String(m?.symbol ?? "");
    if (!symbol) continue;

    const base = String(m?.base ?? "").toUpperCase();
    if (!base) continue;
    if (/(UP|DOWN|BEAR|BULL|3L|3S|5L|5S)$/.test(base)) continue;

    out.push(symbol);
  }

  out.sort((a, b) => a.localeCompare(b));
  return out.slice(0, Math.max(1, Number(maxSymbols) || 200));
}

function ema(values, period) {
  const p = Number(period);
  if (!Number.isFinite(p) || p <= 1) throw new Error("EMA period inválido");
  const k = 2 / (p + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      out[i] = null;
      continue;
    }
    if (prev === null) {
      prev = v;
      out[i] = v;
      continue;
    }
    const next = v * k + prev * (1 - k);
    prev = next;
    out[i] = next;
  }
  return out;
}

function rsi(values, period) {
  const p = Number(period);
  if (!Number.isFinite(p) || p < 2) throw new Error("RSI period inválido");
  const out = new Array(values.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= p) {
      avgGain += gain;
      avgLoss += loss;
      if (i === p) {
        avgGain /= p;
        avgLoss /= p;
        const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        out[i] = 100 - 100 / (1 + rs);
      }
      continue;
    }
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function atr(candles, period) {
  const p = Number(period);
  if (!Number.isFinite(p) || p < 2) throw new Error("ATR period inválido");
  const out = new Array(candles.length).fill(null);
  let prevClose = null;
  let prevAtr = null;
  for (let i = 0; i < candles.length; i += 1) {
    const [, , high, low, close] = candles[i];
    const tr =
      prevClose === null
        ? high - low
        : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    if (i === 0) {
      prevClose = close;
      out[i] = tr;
      continue;
    }
    if (i < p) {
      out[i] = null;
      prevClose = close;
      continue;
    }
    if (prevAtr === null) {
      let sum = 0;
      for (let j = i - p + 1; j <= i; j += 1) {
        const [, , h, l] = candles[j];
        const prevC = candles[j - 1]?.[4];
        const trj =
          prevC === undefined ? h - l : Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
        sum += trj;
      }
      prevAtr = sum / p;
      out[i] = prevAtr;
      prevClose = close;
      continue;
    }
    prevAtr = (prevAtr * (p - 1) + tr) / p;
    out[i] = prevAtr;
    prevClose = close;
  }
  return out;
}

function lastFinite(arr) {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const v = arr[i];
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function signFromCross(fast, slow) {
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return 0;
  if (fast > slow) return 1;
  if (fast < slow) return -1;
  return 0;
}

function simulateCrossoverStrategy(closes, emaFastArr, emaSlowArr, costPerFlip = 0.0005) {
  const returns = [];
  let position = 0;
  let flips = 0;
  for (let i = 2; i < closes.length; i += 1) {
    const prevPos = position;
    const sPrev = signFromCross(emaFastArr[i - 1], emaSlowArr[i - 1]);
    const sNow = signFromCross(emaFastArr[i], emaSlowArr[i]);
    if (sPrev !== 0 && sNow !== 0 && sPrev !== sNow) {
      position = sNow;
      if (prevPos !== 0) flips += 1;
    } else if (position === 0 && sNow !== 0) {
      position = sNow;
    }
    const r = Math.log(closes[i] / closes[i - 1]);
    returns.push(position * r);
  }
  const cost = flips * costPerFlip;
  const sum = returns.reduce((a, b) => a + b, 0) - cost;
  const mean = sum / Math.max(returns.length, 1);
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const std = Math.sqrt(variance);
  const sharpe = std === 0 ? 0 : mean / std;
  const roiPct = (Math.exp(sum) - 1) * 100;
  return { sharpe, flips, mean, std, sum, roiPct };
}

function gridParams() {
  const fast = [8, 10, 12, 14];
  const slow = [21, 26, 30, 35];
  const rsiLen = [14];
  const atrLen = [14];
  const atrMult = [2];
  const rr = [2];
  const out = [];
  for (const f of fast) {
    for (const s of slow) {
      if (f >= s) continue;
      for (const rl of rsiLen) {
        for (const al of atrLen) {
          for (const am of atrMult) {
            for (const r of rr) {
              out.push({ emaFast: f, emaSlow: s, rsiLen: rl, atrLen: al, atrMult: am, rr: r });
            }
          }
        }
      }
    }
  }
  return out;
}

async function optimizeParams({ exchange, symbol, timeframe, candles }, cacheTtlMs = 30 * 60 * 1000) {
  const key = `${exchange}:${symbol}:${timeframe}`;
  const cached = optimizationCache.get(key);
  if (cached && nowMs() - cached.ts < cacheTtlMs) return cached;

  const closes = candles.map((c) => c[4]);
  let best = { sharpe: -Infinity, params: null, flips: 0, mean: 0, std: 0, roiPct: 0, sum: 0 };

  for (const params of gridParams()) {
    const emaFastArr = ema(closes, params.emaFast);
    const emaSlowArr = ema(closes, params.emaSlow);
    const sim = simulateCrossoverStrategy(closes, emaFastArr, emaSlowArr);
    if (sim.sharpe > best.sharpe) {
      best = {
        sharpe: sim.sharpe,
        params,
        flips: sim.flips,
        mean: sim.mean,
        std: sim.std,
        roiPct: sim.roiPct,
        sum: sim.sum
      };
    }
  }

  const result = {
    ts: nowMs(),
    score: best.sharpe,
    flips: best.flips,
    mean: best.mean,
    std: best.std,
    roiPct: best.roiPct,
    sum: best.sum,
    params: best.params ?? gridParams()[0]
  };
  optimizationCache.set(key, result);
  return result;
}

function getStrategyStats(mem, k, name) {
  const all = mem?.strategyStats && typeof mem.strategyStats === "object" ? mem.strategyStats : {};
  const perKey = all?.[k] && typeof all[k] === "object" ? all[k] : {};
  const s = perKey?.[name] && typeof perKey[name] === "object" ? perKey[name] : null;
  if (!s) return { n: 0, wins: 0, sumR: 0, avgR: 0, winRate: 0 };
  return {
    n: Number(s.n) || 0,
    wins: Number(s.wins) || 0,
    sumR: Number(s.sumR) || 0,
    avgR: Number(s.avgR) || 0,
    winRate: Number(s.winRate) || 0
  };
}

function ucbScore({ avgR, n, totalN }, c = 0.6) {
  const t = Math.max(0, Number(totalN) || 0);
  const nn = Math.max(0, Number(n) || 0);
  const a = Number(avgR) || 0;
  const bonus = c * Math.sqrt(Math.log(t + 1) / (nn + 1));
  return a + bonus;
}

function computeBollinger(closes, period = 20, mult = 2) {
  const p = Math.max(5, Math.min(200, Number(period) || 20));
  const slice = closes.slice(Math.max(0, closes.length - p));
  if (slice.length < p) return null;
  const m = mean(slice);
  const sd = stdev(slice);
  if (!Number.isFinite(m) || !Number.isFinite(sd)) return null;
  return { mid: m, upper: m + mult * sd, lower: m - mult * sd, sd };
}

function applyMultiTargets({ side, entry, tp }) {
  const multiTpEnabled = !["0", "false", "off", "no"].includes(
    String(process.env.MULTI_TP_ENABLED ?? "1").trim().toLowerCase()
  );
  const tp1FractionRaw = Number(process.env.MULTI_TP1_FRACTION ?? 0.5);
  const tp1Fraction = Number.isFinite(tp1FractionRaw) ? clamp(tp1FractionRaw, 0.05, 0.95) : 0.5;
  let tp1 = null;
  let tp2 = null;
  if (multiTpEnabled && side !== "NEUTRAL" && Number.isFinite(entry) && Number.isFinite(tp)) {
    tp2 = tp;
    if (side === "LONG") tp1 = entry + (tp2 - entry) * tp1Fraction;
    if (side === "SHORT") tp1 = entry - (entry - tp2) * tp1Fraction;
  } else {
    tp2 = tp;
  }
  return { tp1, tp2 };
}

async function buildTrendSignal({ exchange, symbol, timeframe, candles, opt }) {
  const params = opt.params;
  const closes = candles.map((c) => c[4]);
  const emaFastArr = ema(closes, params.emaFast);
  const emaSlowArr = ema(closes, params.emaSlow);
  const rsiArr = rsi(closes, params.rsiLen);
  const atrArr = atr(candles, params.atrLen);

  const entry = closes[closes.length - 1];
  const fastLast = lastFinite(emaFastArr);
  const slowLast = lastFinite(emaSlowArr);
  const rsiLast = lastFinite(rsiArr);
  const atrLast = lastFinite(atrArr);

  if (!Number.isFinite(entry) || !Number.isFinite(fastLast) || !Number.isFinite(slowLast)) {
    throw new Error("No se pudo calcular EMA para generar señal");
  }
  if (!Number.isFinite(atrLast)) throw new Error("No se pudo calcular ATR");

  const bias = signFromCross(fastLast, slowLast);
  let side = "NEUTRAL";
  if (bias > 0 && (!Number.isFinite(rsiLast) || rsiLast < 72)) side = "LONG";
  if (bias < 0 && (!Number.isFinite(rsiLast) || rsiLast > 28)) side = "SHORT";

  const risk = params.atrMult * atrLast;
  let sl = null;
  let tp = null;
  if (side === "LONG") {
    sl = entry - risk;
    tp = entry + risk * params.rr;
  } else if (side === "SHORT") {
    sl = entry + risk;
    tp = entry - risk * params.rr;
  }

  const { tp1, tp2 } = applyMultiTargets({ side, entry, tp });
  const spread = Math.abs(fastLast - slowLast);
  const quality = Number.isFinite(atrLast) && atrLast > 0 ? clamp(spread / (atrLast * 2), 0, 1) : 0.5;
  const baseConfidence = Math.max(0, Math.min(1, 0.5 + opt.score / 4));
  const reason =
    side === "NEUTRAL"
      ? "Tendencia: sin cruce claro"
      : `Tendencia: cruce EMA(${params.emaFast}/${params.emaSlow})`;

  return {
    exchange,
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp: tp2,
    tp1,
    tp2,
    indicators: { emaFast: fastLast, emaSlow: slowLast, rsi: rsiLast, atr: atrLast },
    model: {
      params,
      score: opt.score,
      flips: opt.flips,
      roiPct: opt.roiPct,
      baseConfidence,
      quality,
      strategyName: "trend",
      strategyReason: reason
    }
  };
}

async function buildRangeSignal({ exchange, symbol, timeframe, candles, opt }) {
  const closes = candles.map((c) => c[4]);
  const entry = closes[closes.length - 1];
  const rsiArr = rsi(closes, 14);
  const atrArr = atr(candles, 14);
  const rsiLast = lastFinite(rsiArr);
  const atrLast = lastFinite(atrArr);
  if (!Number.isFinite(entry)) throw new Error("No se pudo calcular entrada");
  if (!Number.isFinite(atrLast)) throw new Error("No se pudo calcular ATR");

  const bb = computeBollinger(closes, 20, 2);
  let side = "NEUTRAL";
  let quality = 0;
  let reason = "Rango: sin señal";
  if (bb && Number.isFinite(rsiLast)) {
    const z = bb.sd > 0 ? (entry - bb.mid) / (2 * bb.sd) : 0;
    quality = clamp(Math.abs(z), 0, 1);
    if (entry <= bb.lower && rsiLast <= 40) {
      side = "LONG";
      reason = "Rango: banda inferior + RSI bajo";
    }
    if (entry >= bb.upper && rsiLast >= 60) {
      side = "SHORT";
      reason = "Rango: banda superior + RSI alto";
    }
  }

  const atrMult = 1.5;
  const rr = 1.5;
  const risk = atrMult * atrLast;
  let sl = null;
  let tp = null;
  if (side === "LONG") {
    sl = entry - risk;
    tp = entry + risk * rr;
  } else if (side === "SHORT") {
    sl = entry + risk;
    tp = entry - risk * rr;
  }
  const { tp1, tp2 } = applyMultiTargets({ side, entry, tp });
  const baseConfidence = clamp(0.45 + 0.5 * quality, 0, 1);

  return {
    exchange,
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp: tp2,
    tp1,
    tp2,
    indicators: { emaFast: null, emaSlow: null, rsi: rsiLast, atr: atrLast },
    model: {
      params: { emaFast: null, emaSlow: null, rsiLen: 14, atrLen: 14, atrMult, rr },
      score: opt.score,
      flips: opt.flips,
      roiPct: opt.roiPct,
      baseConfidence,
      quality,
      strategyName: "range",
      strategyReason: reason
    }
  };
}

async function buildBreakoutSignal({ exchange, symbol, timeframe, candles, opt }) {
  const closes = candles.map((c) => c[4]);
  const entry = closes[closes.length - 1];
  const atrArr = atr(candles, 14);
  const atrLast = lastFinite(atrArr);
  if (!Number.isFinite(entry)) throw new Error("No se pudo calcular entrada");
  if (!Number.isFinite(atrLast)) throw new Error("No se pudo calcular ATR");

  const lookback = 20;
  const slice = candles.slice(Math.max(0, candles.length - lookback - 1), candles.length - 1);
  const highs = slice.map((c) => c[2]);
  const lows = slice.map((c) => c[3]);
  const hh = highs.length ? Math.max(...highs) : null;
  const ll = lows.length ? Math.min(...lows) : null;
  let side = "NEUTRAL";
  if (Number.isFinite(hh) && entry > hh * 1.001) side = "LONG";
  if (Number.isFinite(ll) && entry < ll * 0.999) side = "SHORT";

  const atrMult = 2;
  const rr = 2;
  const risk = atrMult * atrLast;
  let sl = null;
  let tp = null;
  if (side === "LONG") {
    sl = entry - risk;
    tp = entry + risk * rr;
  } else if (side === "SHORT") {
    sl = entry + risk;
    tp = entry - risk * rr;
  }
  const { tp1, tp2 } = applyMultiTargets({ side, entry, tp });

  const dist = side === "LONG" && Number.isFinite(hh) ? entry - hh : side === "SHORT" && Number.isFinite(ll) ? ll - entry : 0;
  const quality = Number.isFinite(atrLast) && atrLast > 0 ? clamp(dist / (atrLast * 2), 0, 1) : 0.5;
  const baseConfidence = clamp(0.45 + 0.5 * quality, 0, 1);
  const reason =
    side === "NEUTRAL" ? "Breakout: sin ruptura" : `Breakout: ruptura ${lookback} velas`;

  return {
    exchange,
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp: tp2,
    tp1,
    tp2,
    indicators: { emaFast: null, emaSlow: null, rsi: null, atr: atrLast },
    model: {
      params: { emaFast: null, emaSlow: null, rsiLen: null, atrLen: 14, atrMult, rr, lookback },
      score: opt.score,
      flips: opt.flips,
      roiPct: opt.roiPct,
      baseConfidence,
      quality,
      strategyName: "breakout",
      strategyReason: reason
    }
  };
}

function applyAdaptiveConfidence({ mem, k, strategyName, baseConfidence }) {
  const overall = mem.stats?.[k];
  const multOverall = adaptiveConfidenceMultiplier(overall);
  const sStats = getStrategyStats(mem, k, strategyName);
  const multStrategy = adaptiveConfidenceMultiplier(sStats);
  return {
    confidence: clamp(Number(baseConfidence) * multOverall * multStrategy, 0, 1),
    overall: overall ? { n: overall.n, winRate: overall.winRate, avgR: overall.avgR } : null,
    strategy: sStats
  };
}

export async function buildSignal({ exchange, symbol, timeframe, candles }) {
  const [opt, mem] = await Promise.all([
    optimizeParams({ exchange, symbol, timeframe, candles }),
    loadMemory()
  ]);
  const k = keyFor(symbol, timeframe);

  const [trend, range, breakout] = await Promise.all([
    buildTrendSignal({ exchange, symbol, timeframe, candles, opt }),
    buildRangeSignal({ exchange, symbol, timeframe, candles, opt }),
    buildBreakoutSignal({ exchange, symbol, timeframe, candles, opt })
  ]);

  const candidates = [trend, range, breakout];
  const active = candidates.filter((s) => s.side !== "NEUTRAL");
  const pickFrom = active.length ? active : [trend];

  const totalN =
    getStrategyStats(mem, k, "trend").n +
    getStrategyStats(mem, k, "range").n +
    getStrategyStats(mem, k, "breakout").n;

  let best = pickFrom[0];
  let bestScore = -Infinity;
  for (const s of pickFrom) {
    const name = String(s.model?.strategyName ?? "trend");
    const stats = getStrategyStats(mem, k, name);
    const ucb = ucbScore({ avgR: stats.avgR, n: stats.n, totalN }, 0.6);
    const q = Number(s.model?.quality) || 0;
    const score = ucb + q * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  const strategyName = String(best.model?.strategyName ?? "trend");
  const adapt = applyAdaptiveConfidence({
    mem,
    k,
    strategyName,
    baseConfidence: best.model?.baseConfidence ?? 0.5
  });

  return {
    ...best,
    model: {
      ...best.model,
      adaptive: adapt.overall,
      adaptiveStrategy: { n: adapt.strategy.n, winRate: adapt.strategy.winRate, avgR: adapt.strategy.avgR },
      selectorScore: bestScore,
      selectorTotalN: totalN,
      confidence: adapt.confidence
    }
  };
}

export function formatSignalMessage(signal) {
  const {
    exchange,
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp,
    tp1,
    tp2,
    indicators,
    model
  } = signal;

  const lines = [];
  lines.push(`${symbol} (${exchange})`);
  lines.push(`TF: ${timeframe}`);
  lines.push(`Señal: ${side}`);
  lines.push(`Entrada aprox: ${formatNumber(entry)}`);
  if (side !== "NEUTRAL") {
    lines.push(`StopLoss: ${formatNumber(sl)}`);
    if (Number.isFinite(Number(tp1)) && Number.isFinite(Number(tp2))) {
      lines.push(`TakeProfit1: ${formatNumber(tp1)}`);
      lines.push(`TakeProfit2: ${formatNumber(tp2)}`);
    } else {
      lines.push(`TakeProfit: ${formatNumber(tp)}`);
    }
  } else {
    lines.push("StopLoss: N/A (señal NEUTRAL)");
    lines.push("TakeProfit: N/A (señal NEUTRAL)");
  }
  const rsiTxt = Number.isFinite(indicators.rsi) ? formatNumber(indicators.rsi, 2) : "N/A";
  lines.push(
    `EMA(${model.params.emaFast}/${model.params.emaSlow}) RSI(${model.params.rsiLen}) ATR(${model.params.atrLen})`
  );
  lines.push(`RSI: ${rsiTxt} | ATR: ${formatNumber(indicators.atr)}`);
  lines.push(
    `Adaptación: score ${formatNumber(model.score, 3)} | confianza ${formatNumber(model.confidence, 2)}`
  );
  if (model.strategyName) {
    lines.push(`Estrategia: ${model.strategyName}${model.strategyReason ? ` | ${model.strategyReason}` : ""}`);
  }
  if (model.adaptiveStrategy?.n) {
    const wr = Number.isFinite(model.adaptiveStrategy.winRate) ? Math.round(model.adaptiveStrategy.winRate * 100) : null;
    const wrTxt = wr === null ? "N/A" : `${wr}%`;
    lines.push(
      `EstrategiaHist: n ${formatNumber(model.adaptiveStrategy.n, 2)} | winrate ${wrTxt} | avgR ${formatNumber(model.adaptiveStrategy.avgR, 2)}`
    );
  }
  if (model.adaptive?.n) {
    const wr = Number.isFinite(model.adaptive.winRate) ? Math.round(model.adaptive.winRate * 100) : null;
    const wrTxt = wr === null ? "N/A" : `${wr}%`;
    lines.push(`Historial: n ${model.adaptive.n} | winrate ${wrTxt} | avgR ${formatNumber(model.adaptive.avgR, 2)}`);
  }
  return lines.join("\n");
}

export function runSelfTest() {
  const closes = [1, 1.01, 1.02, 1.0, 0.99, 1.03, 1.05, 1.04, 1.06, 1.07];
  const e = ema(closes, 3);
  const r = rsi(closes, 3);
  if (e.length !== closes.length) throw new Error("EMA length mismatch");
  if (r.length !== closes.length) throw new Error("RSI length mismatch");
  if (!Number.isFinite(lastFinite(e))) throw new Error("EMA last not finite");
  const candles = closes.map((c, i) => [i, c, c * 1.01, c * 0.99, c, 1]);
  const a = atr(candles, 3);
  if (!Number.isFinite(lastFinite(a))) throw new Error("ATR last not finite");
  return { ok: true };
}

export async function openPaperPosition({
  chatId,
  exchange,
  symbol,
  timeframe,
  side,
  entry,
  sl,
  tp,
  tp1,
  tp2,
  strategyName,
  strategyReason,
  source
}) {
  const id = `pp_${nowMs()}_${Math.random().toString(16).slice(2)}`;
  const pos = {
    id,
    chatId,
    exchange,
    symbol,
    timeframe,
    side,
    entry,
    sl,
    tp: tp2 ?? tp,
    tp1: tp1 ?? null,
    tp2: tp2 ?? tp ?? null,
    initialSl: sl ?? null,
    initialTp: tp2 ?? tp ?? null,
    strategyName: strategyName ?? null,
    strategyReason: strategyReason ?? null,
    tp1Hit: false,
    remainingPct: 100,
    source: source ?? "signal",
    openedAt: nowMs()
  };
  const mem = await loadMemory();
  mem.positions = Array.isArray(mem.positions) ? mem.positions : [];
  mem.positions.push(pos);
  await saveMemory(mem);
  return pos;
}

export async function listPaperPositions() {
  const mem = await loadMemory();
  return Array.isArray(mem.positions) ? mem.positions : [];
}

export async function updatePaperPosition({ id, patch } = {}) {
  const pid = String(id ?? "").trim();
  if (!pid) return null;
  const p = patch && typeof patch === "object" ? patch : {};
  const mem = await loadMemory();
  mem.positions = Array.isArray(mem.positions) ? mem.positions : [];
  const idx = mem.positions.findIndex((x) => String(x?.id ?? "") === pid);
  if (idx === -1) return null;
  const prev = mem.positions[idx] && typeof mem.positions[idx] === "object" ? mem.positions[idx] : {};
  const next = { ...prev, ...p };
  mem.positions[idx] = next;
  await saveMemory(mem);
  return next;
}

export async function closePaperPosition({ id, exitPrice, reason }) {
  const mem = await loadMemory();
  const positions = Array.isArray(mem.positions) ? mem.positions : [];
  const idx = positions.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const pos = positions[idx];
  positions.splice(idx, 1);
  mem.positions = positions;

  const riskSl = Number(pos.initialSl ?? pos.sl);
  const r = computeRMultiple(pos.side, Number(pos.entry), riskSl, Number(exitPrice));
  const weightRaw = Number(pos.remainingPct);
  const weight = Number.isFinite(weightRaw) ? clamp(weightRaw / 100, 0.01, 1) : 1;
  const closed = {
    id: pos.id,
    chatId: pos.chatId,
    exchange: pos.exchange,
    symbol: pos.symbol,
    timeframe: pos.timeframe,
    side: pos.side,
    entry: pos.entry,
    sl: pos.sl,
    tp: pos.tp,
    tp1: pos.tp1 ?? null,
    tp2: pos.tp2 ?? null,
    initialSl: pos.initialSl ?? null,
    initialTp: pos.initialTp ?? null,
    strategyName: pos.strategyName ?? null,
    strategyReason: pos.strategyReason ?? null,
    tp1Hit: Boolean(pos.tp1Hit),
    remainingPct: pos.remainingPct ?? null,
    exit: exitPrice,
    reason,
    r,
    source: pos.source,
    openedAt: pos.openedAt,
    closedAt: nowMs()
  };

  mem.trades = Array.isArray(mem.trades) ? mem.trades : [];
  mem.trades.push(closed);

  const k = keyFor(pos.symbol, pos.timeframe);
  const prev = mem.stats?.[k];
  const next =
    prev && typeof prev === "object"
      ? { ...prev }
      : { n: 0, wins: 0, sumR: 0, avgR: 0, winRate: 0 };

  next.n = Number(next.n) + 1;
  if (Number.isFinite(r) && r > 0) next.wins = Number(next.wins) + 1;
  if (Number.isFinite(r)) next.sumR = Number(next.sumR) + r;
  next.avgR = next.n ? Number(next.sumR) / Number(next.n) : 0;
  next.winRate = next.n ? Number(next.wins) / Number(next.n) : 0;

  mem.stats = mem.stats && typeof mem.stats === "object" ? mem.stats : {};
  mem.stats[k] = next;

  const strat = String(pos.strategyName ?? "").trim();
  if (strat) {
    mem.strategyStats = mem.strategyStats && typeof mem.strategyStats === "object" ? mem.strategyStats : {};
    const perKey =
      mem.strategyStats[k] && typeof mem.strategyStats[k] === "object" ? mem.strategyStats[k] : {};
    const sPrev = perKey[strat] && typeof perKey[strat] === "object" ? perKey[strat] : {};
    const sNext = {
      n: Number(sPrev.n) || 0,
      wins: Number(sPrev.wins) || 0,
      sumR: Number(sPrev.sumR) || 0
    };
    if (Number.isFinite(r)) {
      sNext.n += weight;
      if (r > 0) sNext.wins += weight;
      sNext.sumR += r * weight;
    }
    sNext.avgR = sNext.n ? sNext.sumR / sNext.n : 0;
    sNext.winRate = sNext.n ? sNext.wins / sNext.n : 0;
    mem.strategyStats[k] = { ...perKey, [strat]: sNext };
  }

  await saveMemory(mem);
  const rNum = Number(closed.r);
  const shouldRemember =
    String(reason) === "SL" || String(reason) === "TIMEOUT" || (Number.isFinite(rNum) && rNum < 0);
  if (shouldRemember) {
    await recordErrorPattern({
      type: String(reason) === "SL" ? "trade_sl" : String(reason) === "TIMEOUT" ? "trade_timeout" : "trade_error",
      exchange: closed.exchange,
      market: String(closed.exchange ?? "").includes("usdm") ? "futures" : "spot",
      symbol: closed.symbol,
      timeframe: closed.timeframe,
      side: closed.side,
      reason: String(reason),
      notes: `R ${Number.isFinite(rNum) ? formatNumber(rNum, 2) : "N/A"} | source ${closed.source ?? ""}`,
      features: {
        r: closed.r,
        entry: closed.entry,
        sl: closed.sl,
        tp: closed.tp,
        exit: closed.exit
      }
    });
  }
  return closed;
}

export async function recordPaperPartialClose({ id, exitPrice, reason, closePct }) {
  const pid = String(id ?? "").trim();
  if (!pid) return null;
  const pctRaw = Number(closePct);
  const pct = Number.isFinite(pctRaw) ? clamp(pctRaw, 0.01, 99.99) : 50;
  const mem = await loadMemory();
  const positions = Array.isArray(mem.positions) ? mem.positions : [];
  const pos = positions.find((p) => String(p?.id ?? "") === pid);
  if (!pos) return null;
  const riskSl = Number(pos.initialSl ?? pos.sl);
  const r = computeRMultiple(pos.side, Number(pos.entry), riskSl, Number(exitPrice));
  const trade = {
    id: `pp_part_${nowMs()}_${Math.random().toString(16).slice(2)}`,
    parentId: pid,
    partial: true,
    closePct: pct,
    chatId: pos.chatId,
    exchange: pos.exchange,
    symbol: pos.symbol,
    timeframe: pos.timeframe,
    side: pos.side,
    entry: pos.entry,
    sl: pos.sl,
    tp: pos.tp,
    exit: exitPrice,
    reason,
    r,
    strategyName: pos.strategyName ?? null,
    strategyReason: pos.strategyReason ?? null,
    source: pos.source,
    openedAt: pos.openedAt,
    closedAt: nowMs()
  };
  mem.trades = Array.isArray(mem.trades) ? mem.trades : [];
  mem.trades.push(trade);
  const k = keyFor(pos.symbol, pos.timeframe);
  const strat = String(pos.strategyName ?? "").trim();
  if (strat && Number.isFinite(r)) {
    const weight = pct / 100;
    mem.strategyStats = mem.strategyStats && typeof mem.strategyStats === "object" ? mem.strategyStats : {};
    const perKey =
      mem.strategyStats[k] && typeof mem.strategyStats[k] === "object" ? mem.strategyStats[k] : {};
    const sPrev = perKey[strat] && typeof perKey[strat] === "object" ? perKey[strat] : {};
    const sNext = {
      n: Number(sPrev.n) || 0,
      wins: Number(sPrev.wins) || 0,
      sumR: Number(sPrev.sumR) || 0
    };
    sNext.n += weight;
    if (r > 0) sNext.wins += weight;
    sNext.sumR += r * weight;
    sNext.avgR = sNext.n ? sNext.sumR / sNext.n : 0;
    sNext.winRate = sNext.n ? sNext.wins / sNext.n : 0;
    mem.strategyStats[k] = { ...perKey, [strat]: sNext };
  }
  await saveMemory(mem);
  return trade;
}

export function formatPositionMessage(pos) {
  const lines = [];
  lines.push(`PAPER ${pos.id}`);
  lines.push(`MONEDA: ${pos.symbol} (${pos.exchange})`);
  lines.push(`TF: ${pos.timeframe}`);
  if (pos.strategyName) lines.push(`ESTRATEGIA: ${pos.strategyName}`);
  lines.push(`LADO: ${pos.side}`);
  lines.push(`ENTRADA: ${formatNumber(pos.entry)}`);
  if (Number.isFinite(Number(pos.tp1)) && Number.isFinite(Number(pos.tp2))) {
    lines.push(`SL: ${formatNumber(pos.sl)} | TP1: ${formatNumber(pos.tp1)} | TP2: ${formatNumber(pos.tp2)}`);
  } else {
    lines.push(`SL: ${formatNumber(pos.sl)} | TP: ${formatNumber(pos.tp)}`);
  }
  return lines.join("\n");
}

export function formatCloseMessage(closed) {
  const rTxt = Number.isFinite(closed.r) ? formatNumber(closed.r, 2) : "N/A";
  const lines = [];
  lines.push(`CERRADO ${closed.id} (${closed.reason})`);
  lines.push(`MONEDA: ${closed.symbol} (${closed.exchange}) TF ${closed.timeframe}`);
  if (closed.strategyName) lines.push(`ESTRATEGIA: ${closed.strategyName}`);
  lines.push(`LADO: ${closed.side}`);
  lines.push(`ENTRADA: ${formatNumber(closed.entry)} -> SALIDA: ${formatNumber(closed.exit)}`);
  lines.push(`R: ${rTxt}`);
  return lines.join("\n");
}

async function mapLimit(items, limit, fn) {
  const max = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    for (;;) {
      const myIdx = idx;
      idx += 1;
      if (myIdx >= items.length) return;
      results[myIdx] = await fn(items[myIdx], myIdx);
    }
  }

  await Promise.all(new Array(Math.min(max, items.length)).fill(0).map(() => worker()));
  return results;
}

function sleepMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, n));
}

export async function scanSignals({
  exchange = DEFAULT_EXCHANGE,
  timeframe = "15m",
  quote = "USDT",
  maxSymbols = 80,
  maxResults = 10,
  concurrent = Number(process.env.SCAN_CONCURRENT ?? 10),
  chunkDelayMs = Number(process.env.SCAN_CHUNK_DELAY_MS ?? 250),
  market = "spot",
  sortBy = "roi"
} = {}) {
  const symbols =
    market === "futures"
      ? await listFuturesSymbols({ exchange, quote, maxSymbols })
      : await listSpotSymbols({ exchange, quote, maxSymbols });
  const started = nowMs();
  let ok = 0;
  let failed = 0;

  const chunkSizeRaw = Number.isFinite(Number(concurrent)) ? Number(concurrent) : 10;
  const chunkSize = Math.max(1, Math.min(50, Math.floor(chunkSizeRaw)));
  const delay = Number.isFinite(Number(chunkDelayMs)) ? Math.max(0, Math.floor(chunkDelayMs)) : 0;

  const computed = [];
  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const chunkRes = await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const data = await fetchCandles({ exchange, symbol, timeframe });
          const signal = await buildSignal(data);
          ok += 1;
          return signal;
        } catch {
          failed += 1;
          return null;
        }
      })
    );
    computed.push(...chunkRes);
    if (delay && i + chunkSize < symbols.length) await sleepMs(delay);
  }

  const tradables = computed
    .filter(Boolean)
    .filter((s) => s.side !== "NEUTRAL")
    .sort((a, b) => {
      if (sortBy === "sharpe") {
        return (b.model?.score ?? 0) - (a.model?.score ?? 0);
      }
      const ra = a.model?.roiPct ?? 0;
      const rb = b.model?.roiPct ?? 0;
      if (rb !== ra) return rb - ra;
      return (b.model?.score ?? 0) - (a.model?.score ?? 0);
    })
    .slice(0, Math.max(1, Number(maxResults) || 10));

  return {
    exchange,
    timeframe,
    quote,
    market,
    sortBy,
    analyzed: symbols.length,
    ok,
    failed,
    concurrent: chunkSize,
    chunkDelayMs: delay,
    ms: nowMs() - started,
    results: tradables
  };
}

export async function scanSignalsParallel(symbolsOrOpts, timeframe, limit = 100) {
  if (Array.isArray(symbolsOrOpts)) {
    const symbols = symbolsOrOpts.slice();
    const tf = String(timeframe ?? "15m");
    const started = nowMs();
    let ok = 0;
    let failed = 0;
    const computed = [];
    const chunkSize = 10;
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      const chunkRes = await Promise.all(
        chunk.map(async (symbol) => {
          try {
            const data = await fetchCandles({ exchange: DEFAULT_EXCHANGE, symbol, timeframe: tf, limit });
            const signal = await buildSignal(data);
            ok += 1;
            return signal;
          } catch {
            failed += 1;
            return null;
          }
        })
      );
      computed.push(...chunkRes.filter(Boolean).filter((s) => s.side !== "NEUTRAL"));
      if (i + chunkSize < symbols.length) await sleepMs(200);
    }
    computed.sort((a, b) => (b.model?.confidence ?? 0) - (a.model?.confidence ?? 0));
    return {
      exchange: DEFAULT_EXCHANGE,
      timeframe: tf,
      quote: "N/A",
      market: "custom",
      sortBy: "confidence",
      analyzed: symbols.length,
      ok,
      failed,
      concurrent: chunkSize,
      chunkDelayMs: 200,
      ms: nowMs() - started,
      results: computed
    };
  }

  const opts = symbolsOrOpts && typeof symbolsOrOpts === "object" ? symbolsOrOpts : {};
  return await scanSignals({
    ...opts,
    concurrent: opts.chunkSize ?? 10,
    chunkDelayMs: opts.pauseMs ?? 200
  });
}

export function formatScanMessage(scan) {
  const lines = [];
  lines.push(`SCAN ${scan.exchange} ${scan.quote} ${scan.market} | TF ${scan.timeframe}`);
  lines.push(`Analizados: ${scan.analyzed} | OK: ${scan.ok} | Fallos: ${scan.failed} | ${scan.ms}ms`);
  if (!scan.results.length) {
    lines.push("Sin señales claras ahora mismo.");
    return lines.join("\n");
  }
  for (let i = 0; i < scan.results.length; i += 1) {
    const s = scan.results[i];
    const conf = Math.round((s.model?.confidence ?? 0) * 100);
    const roi = s.model?.roiPct;
    const roiTxt = Number.isFinite(roi) ? `${formatNumber(roi, 2)}%` : "N/A";
    lines.push(
      `${i + 1}) ${s.symbol} ${s.side} @${formatNumber(s.entry)} SL ${formatNumber(s.sl)} TP ${formatNumber(s.tp)} ROI ${roiTxt} conf ${conf}%`
    );
  }
  return lines.join("\n");
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

function summarizeCandles(candles, window = 120) {
  const slice = candles.slice(Math.max(0, candles.length - window));
  const closes = slice.map((c) => c[4]);
  const highs = slice.map((c) => c[2]);
  const lows = slice.map((c) => c[3]);
  const lastClose = closes[closes.length - 1];
  const firstClose = closes[0];
  const logReturns = [];
  for (let i = 1; i < closes.length; i += 1) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  return {
    window: slice.length,
    lastClose,
    firstClose,
    returnPct: Number.isFinite(firstClose) && firstClose !== 0 ? (lastClose / firstClose - 1) * 100 : null,
    high: Math.max(...highs),
    low: Math.min(...lows),
    vol: stdev(logReturns) * Math.sqrt(Math.max(logReturns.length, 1)) * 100
  };
}

export function detectWhaleTrap({ candles, side, window = 60 } = {}) {
  const arr = Array.isArray(candles) ? candles : [];
  if (arr.length < 10) return { isTrap: false, score: 0 };
  const last = arr[arr.length - 1];
  const prev = arr[arr.length - 2];
  if (!last || !prev) return { isTrap: false, score: 0 };

  const open = Number(last[1]);
  const high = Number(last[2]);
  const low = Number(last[3]);
  const close = Number(last[4]);
  const vol = Number(last[5]);
  if (![open, high, low, close].every((x) => Number.isFinite(x))) return { isTrap: false, score: 0 };

  const body = Math.abs(close - open);
  const range = Math.max(0, high - low);
  const upperWick = Math.max(0, high - Math.max(open, close));
  const lowerWick = Math.max(0, Math.min(open, close) - low);

  const w = Math.max(10, Math.min(arr.length, Number(window) || 60));
  const slice = arr.slice(arr.length - w);
  const vols = slice.map((c) => Number(c?.[5])).filter((x) => Number.isFinite(x));
  vols.sort((a, b) => a - b);
  const medianVol = vols.length ? vols[Math.floor(vols.length / 2)] : null;
  const volRatio =
    Number.isFinite(vol) && Number.isFinite(medianVol) && medianVol > 0 ? vol / medianVol : 1;

  const bodyRatio = range > 0 ? body / range : 0;
  const upperRatio = range > 0 ? upperWick / range : 0;
  const lowerRatio = range > 0 ? lowerWick / range : 0;

  const prevClose = Number(prev[4]);
  const direction = Number.isFinite(prevClose) && Number.isFinite(close) ? close - prevClose : 0;

  let score = 0;
  if (volRatio >= 3) score += 0.4;
  if (bodyRatio <= 0.25) score += 0.2;
  if (side === "LONG") {
    if (upperRatio >= 0.55) score += 0.3;
    if (direction < 0) score += 0.1;
  } else if (side === "SHORT") {
    if (lowerRatio >= 0.55) score += 0.3;
    if (direction > 0) score += 0.1;
  }

  const isTrap = score >= 0.75;
  const notes = isTrap
    ? `Posible whale trap: volRatio ${formatNumber(volRatio, 2)} upper ${formatNumber(upperRatio, 2)} lower ${formatNumber(lowerRatio, 2)} body ${formatNumber(bodyRatio, 2)}`
    : "";

  return {
    isTrap,
    score,
    notes,
    features: {
      volRatio,
      upperRatio,
      lowerRatio,
      bodyRatio
    }
  };
}

export async function consultDeepseek({ apiKey, promptText, model = "deepseek-chat", temperature = 0.2 }) {
  const key = String(apiKey ?? "").trim();
  if (!key) throw new Error("Falta DEEPSEEK_KEY");

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "Eres un Trader Quant. Responde siempre en JSON puro. Si existe ENGRAM_RECALL en el prompt, úsalo como memoria relevante para evitar errores y aplicar reglas."
      },
      { role: "user", content: String(promptText ?? "") }
    ],
    response_format: { type: "json_object" },
    temperature
  };

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await res.text();
  if (!res.ok) {
    const short = bodyText.slice(0, 500);
    throw new Error(`DeepSeek error ${res.status}: ${short}`);
  }

  const json = extractJsonObject(bodyText);
  const content = json?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);
  if (!parsed) throw new Error("DeepSeek respondió pero no devolvió JSON válido");
  return parsed;
}

function extractRssTitles(xmlText, maxTitles = 8) {
  const xml = String(xmlText ?? "");
  const titles = [];
  const re = /<title>([\s\S]*?)<\/title>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const raw = String(m[1] ?? "")
      .replace(/<!\[CDATA\[/g, "")
      .replace(/\]\]>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
    if (!raw) continue;
    titles.push(raw);
    if (titles.length >= maxTitles + 3) break;
  }
  const cleaned = titles.filter((t) => !/RSS|Atom|Feed/i.test(t));
  const uniq = [];
  for (const t of cleaned) {
    if (!uniq.includes(t)) uniq.push(t);
    if (uniq.length >= maxTitles) break;
  }
  return uniq;
}

async function fetchRss(url, maxTitles = 6) {
  const res = await fetch(url, { method: "GET" });
  const txt = await res.text();
  if (!res.ok) return [];
  return extractRssTitles(txt, maxTitles);
}

export async function fetchCryptoNewsHeadlines({ maxTitles = 10 } = {}) {
  const urls = [
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss"
  ];
  const perFeed = Math.max(2, Math.ceil(Number(maxTitles) / urls.length));
  const all = [];
  for (const u of urls) {
    try {
      const t = await fetchRss(u, perFeed);
      all.push(...t);
    } catch {
    }
  }
  const uniq = [];
  for (const t of all) {
    if (!uniq.includes(t)) uniq.push(t);
    if (uniq.length >= maxTitles) break;
  }
  return uniq;
}

async function fetchDerivativesContext({ exchange, symbol }) {
  try {
    const ex = getExchange(exchange);
    const markets = await ex.loadMarkets();
    const s = String(symbol ?? "");
    const normalizedSymbol = s in markets ? s : Object.keys(markets).find((k) => k.toUpperCase() === s.toUpperCase());
    if (!normalizedSymbol) return null;
    const market = markets[normalizedSymbol];
    if (!market?.contract) return null;

    const ctx = { symbol: normalizedSymbol };

    if (ex.has?.fetchFundingRate) {
      try {
        const fr = await ex.fetchFundingRate(normalizedSymbol);
        const rate = Number(fr?.fundingRate);
        if (Number.isFinite(rate)) ctx.fundingRate = rate;
        const ts = Number(fr?.nextFundingTimestamp);
        if (Number.isFinite(ts)) ctx.nextFundingTimestamp = ts;
      } catch {
      }
    }

    if (ex.has?.fetchOpenInterest) {
      try {
        const oi = await ex.fetchOpenInterest(normalizedSymbol);
        const v = Number(oi?.openInterest);
        if (Number.isFinite(v)) ctx.openInterest = v;
      } catch {
      }
    }

    return ctx;
  } catch {
    return null;
  }
}

async function fetchSmartMoneySummary({ symbol }) {
  const enabled = ["1", "true", "on", "yes"].includes(
    String(process.env.SMART_MONEY_ENABLED ?? "").trim().toLowerCase()
  );
  if (!enabled) return { enabled: false, sources: [], items: [] };

  const notes = String(process.env.SMART_MONEY_NOTES ?? "").trim();
  const items = notes ? [notes] : [];
  const sources = ["DeBank/Arkham", "DexCheck", "Crunchbase/Nansen"];
  return { enabled: true, sources, items, symbol: String(symbol ?? "") };
}

function sideToAction(side) {
  if (side === "LONG") return "COMPRA";
  if (side === "SHORT") return "VENTA";
  return "ESPERAR";
}

export async function buildAiTradeIdea({ exchange, symbol, timeframe, candles, apiKey }) {
  const signal = await buildSignal({ exchange, symbol, timeframe, candles });
  const s = summarizeCandles(candles, 180);
  const deriv = await fetchDerivativesContext({ exchange, symbol: signal.symbol });
  const smart = await fetchSmartMoneySummary({ symbol: signal.symbol });
  const wisdom = await readWisdomEntries({ last: 3 }).catch(() => ({ entries: [] }));
  const wisdomText = formatWisdomContext(wisdom?.entries ?? []);
  const lossText = await readRecentLossContext({ last: 3 }).catch(() => "");
  const engramEnabled = !["0", "false", "off", "no"].includes(String(process.env.ENGRAM_ENABLED ?? "1").trim().toLowerCase());
  const engramN = Number.isFinite(Number(process.env.ENGRAM_NGRAM)) ? Number(process.env.ENGRAM_NGRAM) : 3;
  const engramLimit = Number.isFinite(Number(process.env.ENGRAM_LIMIT)) ? Number(process.env.ENGRAM_LIMIT) : 4;
  const engramSnippetsMax = Number.isFinite(Number(process.env.ENGRAM_SNIPPETS_MAX)) ? Number(process.env.ENGRAM_SNIPPETS_MAX) : 12;
  const lossSnippets = lossText
    ? lossText
        .split("|")
        .map((x) => String(x).trim())
        .filter(Boolean)
    : [];
  const engramSnippets = [...(Array.isArray(wisdom?.entries) ? wisdom.entries : []), ...lossSnippets].slice(-engramSnippetsMax);
  const engramQuery = [
    signal.symbol,
    signal.exchange,
    signal.timeframe,
    signal.side,
    `RSI ${fmt(signal.indicators?.rsi, 2)}`,
    `ATR ${fmt(signal.indicators?.atr, 6)}`,
    `RETORNO ${fmt(s.returnPct, 3)}`,
    `VOL ${fmt(s.vol, 3)}`,
    `HIGH ${fmt(s.high, 6)}`,
    `LOW ${fmt(s.low, 6)}`,
    deriv?.fundingRate !== undefined ? `FUNDING ${String(deriv.fundingRate)}` : "",
    deriv?.openInterest !== undefined ? `OI ${String(deriv.openInterest)}` : "",
    smart?.enabled && smart?.items?.length ? smart.items.join(" ") : ""
  ]
    .filter(Boolean)
    .join(" ");
  const engramRecall =
    engramEnabled && engramSnippets.length
      ? engramRecallText({ query: engramQuery, snippets: engramSnippets, n: engramN, limit: engramLimit, maxChars: 900 })
      : "";
  let headlines = [];
  try {
    headlines = await fetchCryptoNewsHeadlines({ maxTitles: 8 });
  } catch {
  }

  const prompt = [
    `SIMBOLO: ${signal.symbol}`,
    `EXCHANGE: ${signal.exchange}`,
    `TIMEFRAME: ${signal.timeframe}`,
    `PRECIO_ACTUAL: ${signal.entry}`,
    `SEÑAL_BASE: ${signal.side}`,
    signal.model?.strategyName ? `ESTRATEGIA_BASE: ${signal.model.strategyName}${signal.model.strategyReason ? ` | ${signal.model.strategyReason}` : ""}` : "",
    `SL_BASE: ${signal.sl}`,
    `TP_BASE: ${signal.tp}`,
    `INDICADORES: EMA_FAST=${signal.indicators.emaFast} EMA_SLOW=${signal.indicators.emaSlow} RSI=${signal.indicators.rsi} ATR=${signal.indicators.atr}`,
    `RESUMEN: ventana=${s.window} retorno%=${s.returnPct} vol%=${s.vol} high=${s.high} low=${s.low}`,
    deriv?.fundingRate !== undefined ? `FUNDING_RATE: ${deriv.fundingRate}` : "",
    deriv?.openInterest !== undefined ? `OPEN_INTEREST: ${deriv.openInterest}` : "",
    smart?.enabled && smart?.items?.length ? `SMART_MONEY (${smart.sources.join(", ")}): ${smart.items.join(" | ")}` : "",
    headlines.length ? `NOTICIAS: ${headlines.join(" | ")}` : "",
    wisdomText ? `LECCIONES_RECIENTES: ${wisdomText}` : "",
    lossText ? `ERRORES_RECIENTES: ${lossText}` : "",
    engramRecall ? `ENGRAM_RECALL: ${engramRecall}` : "",
    "",
    "Instrucción: Genera una señal de trading pero evita patrones similares a ERRORES_RECIENTES y aplica LECCIONES_RECIENTES. Si no hay edge claro, usa accion=ESPERAR.",
    "Devuelve un JSON con: accion (COMPRA/VENTA/ESPERAR), moneda, precio_entrada, tp, sl, porcentaje_confianza (0-100), notas."
  ]
    .filter(Boolean)
    .join("\n");

  const ai = await consultDeepseek({ apiKey, promptText: prompt });

  const merged = {
    accion: ai.accion ?? sideToAction(signal.side),
    moneda: ai.moneda ?? signal.symbol,
    precio_entrada: Number.isFinite(Number(ai.precio_entrada)) ? Number(ai.precio_entrada) : signal.entry,
    tp: Number.isFinite(Number(ai.tp)) ? Number(ai.tp) : signal.tp,
    sl: Number.isFinite(Number(ai.sl)) ? Number(ai.sl) : signal.sl,
    porcentaje_confianza: Number.isFinite(Number(ai.porcentaje_confianza))
      ? Math.max(0, Math.min(100, Number(ai.porcentaje_confianza)))
      : Math.round(signal.model.confidence * 100),
    notas: typeof ai.notas === "string" ? ai.notas : ""
  };

  return {
    ...merged,
    exchange: signal.exchange,
    symbol: signal.symbol,
    timeframe: signal.timeframe
  };
}

export function formatAiMessage(ai) {
  const lines = [];
  lines.push(`AETHER LABS: DEEPSEEK`);
  lines.push(`MONEDA: ${ai.symbol} (${ai.exchange})`);
  lines.push(`TF: ${ai.timeframe}`);
  lines.push(`ACCION: ${ai.accion}`);
  lines.push(`ENTRADA: ${formatNumber(ai.precio_entrada)}`);
  if (ai.accion !== "ESPERAR") {
    lines.push(`TP: ${formatNumber(ai.tp)} | SL: ${formatNumber(ai.sl)}`);
  }
  lines.push(`CONFIANZA: ${formatNumber(ai.porcentaje_confianza, 2)}%`);
  if (ai.notas) lines.push(`NOTAS: ${String(ai.notas).slice(0, 350)}`);
  return lines.join("\n");
}
