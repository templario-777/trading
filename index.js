import "dotenv/config";
import * as cron from "node-cron";
import { Telegraf, Markup } from "telegraf";
import fs from "node:fs/promises";
import {
  buildAiTradeIdea,
  buildSignal,
  closePaperPosition,
  detectWhaleTrap,
  fetchCandles,
  fetchLastPrice,
  findSimilarError,
  formatAiMessage,
  formatCloseMessage,
  formatScanMessage,
  formatSignalMessage,
  formatPositionMessage,
  getAlertsConfig,
  getDefaultTimeframes,
  listPaperPositions,
  loadMemory,
  loadErrorMemory,
  openPaperPosition,
  parseMultiRequest,
  parseSignalRequest,
  recordPaperPartialClose,
  recordExpertDetected,
  recordErrorPattern,
  recordScamSignature,
  scanSignalsParallel,
  saveErrorMemory,
  setAlertsConfig,
  updatePaperPosition,
  registrarEnHistorial,
  loadTradeHistory,
  generarReporteSemanal,
  readWisdomEntries,
  learnFromLossWithDeepseek,
  filtrarPorSabiduria,
  generarAutocritica,
  generar_balance_de_aprendizaje,
  registrar_aprendizaje,
  registrar_obsidian_markdown,
  verificar_honeypot,
  runSelfTest
} from "./lib.js";

function getEnvAny(names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Falta variable de entorno: ${names.join(" o ")}`);
}

function logAprendizaje(suceso, solucion) {
  registrar_aprendizaje(suceso, solucion).catch(() => {});
}

function logObsidian(markdown) {
  registrar_obsidian_markdown(markdown).catch(() => {});
}

function fmt(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "na";
  return n.toFixed(Math.max(0, Math.min(12, Math.floor(decimals))));
}

async function handleOne({ exchange, symbol, timeframe }) {
  const data = await fetchCandles({ exchange, symbol, timeframe });
  const signal = await buildSignal(data);
  return { signal, text: formatSignalMessage(signal), data };
}

async function handleMulti({ exchange, symbol }) {
  const timeframes = getDefaultTimeframes();
  const out = [];
  for (const tf of timeframes) {
    try {
      const r = await handleOne({ exchange, symbol, timeframe: tf });
      out.push(r.text);
    } catch (e) {
      logAprendizaje(
        `Error generando señal multi (${exchange}) ${symbol} ${tf}`,
        `Se capturó el error por timeframe para continuar con el resto.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
      );
      out.push(`${symbol} ${tf} (${exchange})\nError: ${e?.message ?? String(e)}`);
    }
  }
  return out.join("\n\n");
}

function isAllTimeframes(timeframe) {
  const tf = String(timeframe ?? "")
    .trim()
    .toLowerCase();
  return tf === "all" || tf === "todas" || tf === "*";
}

async function main() {
  if (process.argv.includes("--selftest")) {
    const base = runSelfTest();
    let panelOk = false;
    try {
      const kb = Markup.inlineKeyboard([[Markup.button.callback("TEST", "test")]]);
      panelOk = Boolean(kb?.reply_markup?.inline_keyboard?.length);
    } catch {
      panelOk = false;
    }
    const res = { ...base, panelOk };
    process.stdout.write(JSON.stringify(res) + "\n");
    return;
  }

  const token = getEnvAny(["TELEGRAM_BOT_TOKEN", "TOKEN_TELEGRAM"]);
  const bot = new Telegraf(token);
  const notifyName = String(process.env.TELEGRAM_NOTIFY_NAME ?? "Daniel").trim() || "Daniel";
  const adminChatIdRaw = process.env.TELEGRAM_ADMIN_CHAT_ID ?? process.env.TELEGRAM_NOTIFY_CHAT_ID ?? null;
  const adminChatId = adminChatIdRaw ? Number(adminChatIdRaw) : null;
  let paperEnabled = ["1", "true", "on", "yes"].includes(String(process.env.PAPER_TRADING ?? "").trim().toLowerCase());
  let monitoring = false;
  const paperMaxOpen = Math.max(1, Math.min(20, Number(process.env.PAPER_MAX_OPEN ?? 5)));
  const paperMaxHoldMinutes = Math.max(0, Number(process.env.PAPER_MAX_HOLD_MINUTES ?? 360));
  const paperTrailingEnabled = !["0", "false", "off", "no"].includes(
    String(process.env.PAPER_TRAILING_ENABLED ?? "1").trim().toLowerCase()
  );
  const paperTrailBreakevenPct = Number.isFinite(Number(process.env.PAPER_TRAIL_BREAKEVEN_PCT))
    ? Math.max(0, Math.min(0.2, Number(process.env.PAPER_TRAIL_BREAKEVEN_PCT)))
    : 0.02;
  const paperTrailPct = Number.isFinite(Number(process.env.PAPER_TRAIL_PCT))
    ? Math.max(0, Math.min(0.2, Number(process.env.PAPER_TRAIL_PCT)))
    : 0.01;
  const paperTrailMinStepPct = Number.isFinite(Number(process.env.PAPER_TRAIL_MIN_STEP_PCT))
    ? Math.max(0, Math.min(0.05, Number(process.env.PAPER_TRAIL_MIN_STEP_PCT)))
    : 0.001;
  const deepseekKey = String(process.env.DEEPSEEK_KEY ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const alertsCooldownMinutes = Math.max(1, Number(process.env.ALERTS_COOLDOWN_MINUTES ?? 10));
  const alertsMinConfidence = Math.max(0, Math.min(1, Number(process.env.ALERTS_MIN_CONFIDENCE ?? 0.6)));
  const alertsMaxSymbols = Math.max(5, Math.min(800, Number(process.env.ALERTS_MAX_SYMBOLS ?? 200)));
  const scanConcurrent = Math.max(1, Math.min(50, Math.floor(Number(process.env.SCAN_CONCURRENT ?? 10))));
  const scanChunkDelayMs = Math.max(0, Math.floor(Number(process.env.SCAN_CHUNK_DELAY_MS ?? 250)));
  let alertsRunning = false;
  await saveErrorMemory(await loadErrorMemory());

  process.on("unhandledRejection", (e) => {
    const msg = e?.stack ?? e?.message ?? String(e);
    process.stderr.write(`[UNHANDLED_REJECTION] ${msg}\n`);
  });
  process.on("uncaughtException", (e) => {
    const msg = e?.stack ?? e?.message ?? String(e);
    process.stderr.write(`[UNCAUGHT_EXCEPTION] ${msg}\n`);
    process.exitCode = 1;
  });

  async function bootLog() {
    const multiTpEnabled = !["0", "false", "off", "no"].includes(
      String(process.env.MULTI_TP_ENABLED ?? "1").trim().toLowerCase()
    );
    const engramEnabled = !["0", "false", "off", "no"].includes(String(process.env.ENGRAM_ENABLED ?? "1").trim().toLowerCase());
    const hasDeepseek = Boolean(deepseekKey);
    const base = [
      `[BOOT] starting`,
      `cwd=${process.cwd()}`,
      `node=${process.version}`,
      `paper=${paperEnabled ? "on" : "off"}`,
      `paperTrailing=${paperTrailingEnabled ? "on" : "off"}`,
      `multiTP=${multiTpEnabled ? "on" : "off"}`,
      `engram=${engramEnabled ? "on" : "off"}`,
      `deepseek=${hasDeepseek ? "on" : "off"}`
    ].join(" | ");
    process.stdout.write(base + "\n");

    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    const withTimeout = async (p, ms) => {
      const n = Number.isFinite(Number(ms)) ? Math.max(1000, Math.floor(Number(ms))) : 8000;
      return await Promise.race([p, sleepMs(n).then(() => null)]);
    };

    try {
      const me = await withTimeout(bot.telegram.getMe(), 8000);
      const who = me?.username ? `@${me.username}` : me?.id ? String(me.id) : "unknown";
      process.stdout.write(`[BOOT] telegram_ok=${Boolean(me)} | bot=${who}\n`);
    } catch (e) {
      const msg = e?.message ?? String(e);
      process.stderr.write(`[BOOT] telegram_check_failed: ${msg}\n`);
    }
  }

  async function notifyAdmin(text) {
    if (!adminChatId || !Number.isFinite(adminChatId)) return;
    try {
      await bot.telegram.sendMessage(adminChatId, String(text ?? "").slice(0, 3900));
    } catch {
    }
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function replyHtmlCode(ctx, rawText) {
    const text = escapeHtml(rawText);
    const max = 3500;
    for (let i = 0; i < text.length; i += max) {
      const chunk = text.slice(i, i + max);
      await ctx.reply(`<pre><code>${chunk}</code></pre>`, { parse_mode: "HTML" });
    }
  }

  async function getChatDefaults(chatId) {
    const cfg = await getAlertsConfig(chatId);
    const market = String(cfg?.market ?? "futures").trim().toLowerCase();
    const timeframe = String(cfg?.timeframe ?? "15m").trim().toLowerCase() || "15m";
    const quote = String(cfg?.quote ?? "USDT").trim().toUpperCase() || "USDT";
    const fallbackExchange = market === "spot" ? "binance" : "binanceusdm";
    const exchange = String(cfg?.exchange ?? fallbackExchange).trim().toLowerCase() || fallbackExchange;
    const enabled = Boolean(cfg?.enabled);
    const minConfidence = Number.isFinite(Number(cfg?.minConfidence)) ? Number(cfg.minConfidence) : alertsMinConfidence;
    const cooldownMinutes = Number.isFinite(Number(cfg?.cooldownMinutes))
      ? Number(cfg.cooldownMinutes)
      : alertsCooldownMinutes;
    const maxSymbols = Number.isFinite(Number(cfg?.maxSymbols)) ? Number(cfg.maxSymbols) : alertsMaxSymbols;
    return {
      chatId,
      cfg: cfg && typeof cfg === "object" ? cfg : null,
      enabled,
      timeframe,
      exchange,
      market: market === "spot" ? "spot" : "futures",
      quote,
      minConfidence,
      cooldownMinutes,
      maxSymbols
    };
  }

  async function upsertAlertsConfig(chatId, patch) {
    const current = await getAlertsConfig(chatId);
    const base = current && typeof current === "object" ? current : {};
    const next = { ...base, ...(patch && typeof patch === "object" ? patch : {}) };

    const market = String(next.market ?? "futures").trim().toLowerCase();
    next.market = market === "spot" ? "spot" : "futures";

    const quote = String(next.quote ?? "USDT").trim().toUpperCase() || "USDT";
    next.quote = quote;

    const fallbackExchange = next.market === "spot" ? "binance" : "binanceusdm";
    const ex = String(next.exchange ?? fallbackExchange).trim().toLowerCase() || fallbackExchange;
    next.exchange = ex;

    const tf = String(next.timeframe ?? "15m").trim().toLowerCase() || "15m";
    next.timeframe = tf;

    const minC = Number(next.minConfidence);
    next.minConfidence = Number.isFinite(minC) ? Math.max(0, Math.min(1, minC)) : alertsMinConfidence;

    const cd = Number(next.cooldownMinutes);
    next.cooldownMinutes = Number.isFinite(cd) ? Math.max(1, Math.floor(cd)) : alertsCooldownMinutes;

    const mx = Number(next.maxSymbols);
    next.maxSymbols = Number.isFinite(mx) ? Math.max(5, Math.min(800, Math.floor(mx))) : alertsMaxSymbols;

    next.enabled = Boolean(next.enabled);

    await setAlertsConfig(chatId, next);
    return next;
  }

  function panelKeyboard(d) {
    const tf = d?.timeframe ?? "15m";
    const market = d?.market ?? "futures";
    const quote = d?.quote ?? "USDT";
    const exchange = d?.exchange ?? (market === "spot" ? "binance" : "binanceusdm");
    const max = Number.isFinite(Number(d?.maxSymbols)) ? Number(d.maxSymbols) : alertsMaxSymbols;
    const minC = Number.isFinite(Number(d?.minConfidence)) ? Number(d.minConfidence) : alertsMinConfidence;
    const cd = Number.isFinite(Number(d?.cooldownMinutes)) ? Number(d.cooldownMinutes) : alertsCooldownMinutes;

    const btn = (label, data) => Markup.button.callback(label, data);
    const pick = (label, selected) => (selected ? `${label} ✓` : label);

    return Markup.inlineKeyboard(
      [
        [btn("Analizar TOP 10", "scan_top10"), btn("Buscar Gemas (IA)", "scan_gems_ai")],
        [btn("Alertas ALL (ON)", "alerts_all_on"), btn("Alertas (OFF)", "alerts_off")],
        [btn(pick("TF 5m", tf === "5m"), "cfg:tf=5m"), btn(pick("TF 15m", tf === "15m"), "cfg:tf=15m"), btn(pick("TF 1h", tf === "1h"), "cfg:tf=1h")],
        [btn(pick("Spot", market === "spot"), "cfg:market=spot"), btn(pick("Futuros", market === "futures"), "cfg:market=futures")],
        [btn(pick("Binance", exchange === "binance"), "cfg:ex=binance"), btn(pick("BinanceUSDM", exchange === "binanceusdm"), "cfg:ex=binanceusdm")],
        [btn(pick("USDT", quote === "USDT"), "cfg:quote=USDT"), btn(pick("USDC", quote === "USDC"), "cfg:quote=USDC")],
        [btn(pick("Max 200", max === 200), "cfg:max=200"), btn(pick("Max 400", max === 400), "cfg:max=400"), btn(pick("Max 800", max === 800), "cfg:max=800")],
        [btn(pick("Conf 0.55", minC === 0.55), "cfg:conf=0.55"), btn(pick("Conf 0.6", minC === 0.6), "cfg:conf=0.6"), btn(pick("Conf 0.7", minC === 0.7), "cfg:conf=0.7")],
        [btn(pick("CD 5m", cd === 5), "cfg:cd=5"), btn(pick("CD 10m", cd === 10), "cfg:cd=10"), btn(pick("CD 20m", cd === 20), "cfg:cd=20")],
        [btn("Mi Balance", "get_balance"), btn("Estado Paper", "paper_status")],
        [btn("CERRAR TODO", "panic_confirm")],
        [btn("Refrescar Panel", "panel_refresh")]
      ],
      { columns: 3 }
    );
  }

  async function sendPanel(ctx) {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    const d = await getChatDefaults(chatId);
    const positions = (await listPaperPositions()).filter((p) => p.chatId === chatId);
    const alertsEmoji = d.enabled ? "🟢" : "🔴";
    const paperEmoji = paperEnabled ? "🟢" : "🔴";
    const header = [
      "<b>AETHER LABS · Panel</b>",
      `<b>Mercado:</b> <code>${escapeHtml(d.exchange)}</code> <code>${escapeHtml(d.market)}</code> <b>Quote:</b> <code>${escapeHtml(d.quote)}</code> <b>TF:</b> <code>${escapeHtml(d.timeframe)}</code>`,
      `<b>Alertas:</b> ${alertsEmoji} ${d.enabled ? "ON" : "OFF"}  <b>minConf:</b> <code>${escapeHtml(d.minConfidence)}</code>  <b>cooldown:</b> <code>${escapeHtml(d.cooldownMinutes)}m</code>  <b>max:</b> <code>${escapeHtml(d.maxSymbols)}</code>`,
      `<b>Paper:</b> ${paperEmoji} ${paperEnabled ? "ON" : "OFF"}  <b>Posiciones:</b> <code>${positions.length}</code>`,
      "",
      "Selecciona una acción:"
    ].join("\n");
    await ctx.reply(header, { parse_mode: "HTML", ...panelKeyboard(d) });
  }

  async function readFileTailSafe(filePath, maxChars = 3500) {
    try {
      const txt = await fs.readFile(String(filePath), "utf8");
      const out = txt.length > maxChars ? txt.slice(-maxChars) : txt;
      return out.trim();
    } catch {
      return "";
    }
  }

  async function runDailyCloseOnce() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const mem = await loadMemory();
      mem.config = mem.config && typeof mem.config === "object" ? mem.config : { alerts: {} };
      const lastDaily = String(mem.config.lastDailyBalanceDate ?? "");
      if (lastDaily === today) return;
      const res = await generar_balance_de_aprendizaje();
      mem.config.lastDailyBalanceDate = String(res.date ?? today);
      await saveMemory(mem);
      await notifyAdmin(`🧾 Balance de Aprendizaje listo: ${res.date}\n${res.path}`);
      const tail = await readFileTailSafe(res.path);
      if (tail) await notifyAdmin(tail);
    } catch (e) {
      logAprendizaje(
        "Cierre de Jornada: fallo generando Balance_de_Aprendizaje.md",
        `Se capturó el error para no romper el bot.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
      );
    }
  }

  function msUntilNextDailyRun(hour, minute, second) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, second, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return Math.max(1_000, next.getTime() - now.getTime());
  }

  const dailyEnabled = !["0", "false", "off", "no"].includes(
    String(process.env.DAILY_REFLECTION_ENABLED ?? "1").trim().toLowerCase()
  );
  if (dailyEnabled) {
    const hour = Number.isFinite(Number(process.env.DAILY_CLOSE_HOUR))
      ? Math.max(0, Math.min(23, Math.floor(Number(process.env.DAILY_CLOSE_HOUR))))
      : 23;
    const minute = Number.isFinite(Number(process.env.DAILY_CLOSE_MINUTE))
      ? Math.max(0, Math.min(59, Math.floor(Number(process.env.DAILY_CLOSE_MINUTE))))
      : 59;
    const second = Number.isFinite(Number(process.env.DAILY_CLOSE_SECOND))
      ? Math.max(0, Math.min(59, Math.floor(Number(process.env.DAILY_CLOSE_SECOND))))
      : 30;
    const firstDelay = msUntilNextDailyRun(hour, minute, second);
    setTimeout(() => {
      runDailyCloseOnce().catch(() => {});
      setInterval(() => runDailyCloseOnce().catch(() => {}), 24 * 60 * 60 * 1000).unref?.();
    }, firstDelay).unref?.();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function computeVolumeRisePct10m(candles1m) {
    const arr = Array.isArray(candles1m) ? candles1m : [];
    if (arr.length < 25) return null;
    const last = arr[arr.length - 1];
    const lastTs = Number(last?.[0]);
    if (!Number.isFinite(lastTs)) return null;
    const now = lastTs;
    const win = 10 * 60 * 1000;
    const sumVol = (from, to) =>
      arr
        .filter((c) => {
          const ts = Number(c?.[0]);
          return Number.isFinite(ts) && ts > from && ts <= to;
        })
        .map((c) => Number(c?.[5]))
        .filter((v) => Number.isFinite(v) && v >= 0)
        .reduce((a, b) => a + b, 0);
    const vNow = sumVol(now - win, now);
    const vPrev = sumVol(now - 2 * win, now - win);
    if (!Number.isFinite(vNow) || !Number.isFinite(vPrev) || vPrev <= 0) return null;
    return ((vNow / vPrev) - 1) * 100;
  }

  async function maybeOpenPaper(ctx, signal, data, source) {
    if (!paperEnabled) return null;
    if (!signal || signal.side === "NEUTRAL") return null;
    const market = String(signal.exchange ?? "").includes("usdm") ? "futures" : "spot";

    const trap = detectWhaleTrap({ candles: data?.candles, side: signal.side });
    if (trap?.isTrap) {
      const msg = "Evitando error histórico: Patrón de falso breakout detectado";
      await recordErrorPattern({
        type: "whale_trap",
        exchange: signal.exchange,
        market,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        side: signal.side,
        reason: "WHALE_TRAP",
        notes: trap.notes ?? "",
        features: trap.features ?? {}
      });
      await ctx.reply(`${msg}\nMotivo: movimiento falso de ballena detectado.`);
      logAprendizaje(msg, `Se bloqueó apertura por whale trap.\n\n${trap.notes ?? ""}`);
      logObsidian(
        [
          "## 🧠 Bloqueo de Error Repetido",
          "",
          `Causa: Patrón de falso breakout/whale trap detectado (${signal.symbol} ${signal.timeframe}).`,
          "Decisión: Operación abortada para proteger el capital.",
          ""
        ].join("\n")
      );
      await notifyAdmin(
        `⚠️ ${notifyName}, acabo de salvar capital.\nIba a entrar en ${signal.symbol}, pero detecté una trampa de liquidez.\nRevisa tu Obsidian para ver el detalle.`
      );
      return null;
    }

    const shieldEnabled = !["0", "false", "off", "no"].includes(
      String(process.env.WHALE_SHIELD_ENABLED ?? "1").trim().toLowerCase()
    );
    const minVolRise = Number.isFinite(Number(process.env.WHALE_SHIELD_MIN_VOL_RISE_PCT))
      ? Number(process.env.WHALE_SHIELD_MIN_VOL_RISE_PCT)
      : 5;
    const waitSeconds = Number.isFinite(Number(process.env.WHALE_SHIELD_WAIT_SECONDS))
      ? Math.max(0, Number(process.env.WHALE_SHIELD_WAIT_SECONDS))
      : 60;
    const maxRetracePct = Number.isFinite(Number(process.env.WHALE_SHIELD_MAX_RETRACE_PCT))
      ? Math.max(0, Number(process.env.WHALE_SHIELD_MAX_RETRACE_PCT))
      : 2;

    if (shieldEnabled && Number(trap?.score ?? 0) >= 0.6) {
      try {
        const c1m = await fetchCandles({ exchange: signal.exchange, symbol: signal.symbol, timeframe: "1m" });
        const rise = computeVolumeRisePct10m(c1m?.candles);
        if (Number.isFinite(rise) && rise < minVolRise) {
          const msg = "Escudo de Seguridad: trampa de liquidez (volumen débil)";
          const entry = await recordErrorPattern({
            type: "liquidity_trap",
            exchange: signal.exchange,
            market,
            symbol: signal.symbol,
            timeframe: signal.timeframe,
            side: signal.side,
            reason: "VOL_RISE_LT_5PCT_10M",
            notes: `Subida de volumen 10m: ${fmt(rise, 2)}% (umbral ${fmt(minVolRise, 2)}%).`,
            features: { volRise10m: rise, trapScore: Number(trap?.score ?? 0) }
          });
          await ctx.reply(`${msg}\nMotivo: el volumen global no confirmó el movimiento (+${fmt(rise, 2)}% en 10m).`);
          logAprendizaje(msg, `Se bloqueó apertura por volumen insuficiente.\n\n${entry.patternText ?? ""}`);
          logObsidian(
            [
              "## ⚠️ Alerta de Manipulación",
              "",
              `Detectado movimiento tipo ballena en ${signal.symbol}.`,
              "Motivo de Rechazo: Volumen artificial (falso breakout).",
              "Skill Mejorada: Umbral de confirmación subido a 2 minutos para este token.",
              ""
            ].join("\n")
          );
          await notifyAdmin(
            `⚠️ ${notifyName}, acabo de salvar capital.\nIba a entrar en ${signal.symbol}, pero recordé el error del ${entry.date}.\nRevisa tu Obsidian para ver el detalle.`
          );
          return null;
        }
      } catch {
      }

      if (waitSeconds > 0) {
        try {
          const base = Number(signal.entry);
          await ctx.reply(`Escudo de Seguridad: esperando ${waitSeconds}s para confirmar liquidez real...`);
          await sleep(waitSeconds * 1000);
          const p2 = await fetchLastPrice({ exchange: signal.exchange, symbol: signal.symbol });
          const price2 = Number(p2?.price);
          if (Number.isFinite(base) && Number.isFinite(price2) && base > 0) {
            const adverse =
              signal.side === "LONG" ? ((base - price2) / base) * 100 : ((price2 - base) / base) * 100;
            if (Number.isFinite(adverse) && adverse > maxRetracePct) {
              const msg = "Escudo de Seguridad: retroceso peligroso tras movimiento de ballena";
              const entry = await recordErrorPattern({
                type: "whale_trap",
                exchange: signal.exchange,
                market,
                symbol: signal.symbol,
                timeframe: signal.timeframe,
                side: signal.side,
                reason: "RETRACE_GT_2PCT_60S",
                notes: `Retroceso adverso ${fmt(adverse, 2)}% tras ${waitSeconds}s.`,
                features: { adversePct: adverse, waitSeconds, trapScore: Number(trap?.score ?? 0) }
              });
              await ctx.reply(`${msg}\nMotivo: retroceso ${fmt(adverse, 2)}% tras ${waitSeconds}s.`);
              logAprendizaje(msg, `Se descartó y se guardó como Trampa Detectada.\n\n${entry.patternText ?? ""}`);
              logObsidian(
                [
                  "## ⚠️ Alerta de Manipulación",
                  "",
                  `Detectado movimiento de ballena en ${signal.symbol}.`,
                  "Motivo de Rechazo: Retroceso rápido (trampa detectada).",
                  "Skill Mejorada: Confirmación obligatoria tras 60s antes de entrar.",
                  ""
                ].join("\n")
              );
              await notifyAdmin(
                `⚠️ ${notifyName}, acabo de salvar capital.\nIba a entrar en ${signal.symbol}, pero recordé el error del ${entry.date}.\nRevisa tu Obsidian para ver el detalle.`
              );
              return null;
            }
          }
        } catch {
        }
      }
    }

    const candles = Array.isArray(data?.candles) ? data.candles : [];
    const last = candles.length ? candles[candles.length - 1] : null;
    const lastVol = last ? Number(last[5]) : null;
    const vols = candles.slice(-20).map((c) => Number(c?.[5])).filter((v) => Number.isFinite(v) && v > 0);
    const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    const volRatio = Number.isFinite(lastVol) && Number.isFinite(avgVol) && avgVol > 0 ? lastVol / avgVol : null;
    const hour = new Date().getHours();

    const notes = [
      `rsi ${Number.isFinite(signal.indicators?.rsi) ? Math.round(signal.indicators.rsi) : "na"}`,
      `atr ${Number.isFinite(signal.indicators?.atr) ? fmt(signal.indicators.atr, 4) : "na"}`,
      `volRatio ${Number.isFinite(volRatio) ? fmt(volRatio, 2) : "na"}`,
      `ema ${signal.model?.params?.emaFast}/${signal.model?.params?.emaSlow}`
    ].join(" | ");

    const sim = await findSimilarError(
      {
        type: "entry_attempt",
        exchange: signal.exchange,
        market,
        symbol: signal.symbol,
        timeframe: signal.timeframe,
        side: signal.side,
        reason: "PRECHECK",
        notes,
        features: {
          rsi: Number(signal.indicators?.rsi),
          atr: Number(signal.indicators?.atr),
          volRatio: Number(volRatio),
          volume: Number(lastVol),
          price: Number(signal.entry),
          hour
        }
      },
      0.85
    );

    if (sim?.match) {
      const pct = Math.round(sim.score * 100);
      const msg =
        pct >= 90
          ? "Evitando error histórico: Patrón de falso breakout detectado"
          : `🧠 Decisión Inteligente: Evité una pérdida segura porque el patrón se parecía al error del ${sim.match.date}`;
      await ctx.reply(`${msg}\nSimilitud: ${pct}%`);
      logAprendizaje(
        msg,
        `Se abortó por patrón similar (>=85%).\n\nPatrón actual:\n${notes}\n\nPatrón previo:\n${sim.match.patternText ?? ""}`
      );
      logObsidian(
        [
          "## 🧠 Bloqueo de Error Repetido",
          "",
          `Causa: El escenario actual es casi idéntico al fallo del ${sim.match.date}.`,
          "Decisión: Operación abortada para proteger el capital.",
          ""
        ].join("\n")
      );
      await notifyAdmin(
        `⚠️ ${notifyName}, acabo de salvar capital.\nIba a entrar en ${signal.symbol}, pero recordé el error del ${sim.match.date}.\nRevisa tu Obsidian para ver el detalle.`
      );
      return null;
    }
    const existing = (await listPaperPositions()).filter((p) => p.chatId === ctx.chat?.id);
    if (existing.length >= paperMaxOpen) {
      await ctx.reply(`Paper: límite de posiciones abiertas alcanzado (${paperMaxOpen}).`);
      logAprendizaje(
        `Paper: no se abrió posición (límite alcanzado)`,
        `Decisión: se bloqueó apertura porque ya hay ${existing.length}/${paperMaxOpen} posiciones abiertas para chatId=${ctx.chat?.id}.`
      );
      return null;
    }
    const pos = await openPaperPosition({
      chatId: ctx.chat?.id,
      exchange: signal.exchange,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      side: signal.side,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      tp1: signal.tp1,
      tp2: signal.tp2,
      strategyName: signal.model?.strategyName ?? null,
      strategyReason: signal.model?.strategyReason ?? null,
      source
    });
    await ctx.reply(formatPositionMessage(pos));
    logAprendizaje(
      `Paper: se abrió posición ${pos.symbol} ${pos.timeframe} ${pos.side}`,
      `Decisión estratégica: apertura paper basada en señal (${source}). entry=${pos.entry} sl=${pos.sl} tp=${pos.tp} exchange=${pos.exchange} chatId=${pos.chatId}.`
    );
    monitorPaperPositions().catch(() => {});
    return pos;
  }

  async function monitorPaperPositions() {
    if (monitoring) return;
    monitoring = true;
    try {
      const positions = await listPaperPositions();
      for (const pos of positions) {
        try {
          const p = await fetchLastPrice({ exchange: pos.exchange, symbol: pos.symbol });
          const price = p.price;
          const entryPrice = Number(pos.entry);
          let sl = Number(pos.sl);
          const tp = Number(pos.tp);
          const tp1 = Number(pos.tp1);
          const tp2 = Number(pos.tp2);
          let tp1Hit = Boolean(pos.tp1Hit);

          const multiTpEnabled = !["0", "false", "off", "no"].includes(
            String(process.env.MULTI_TP_ENABLED ?? "1").trim().toLowerCase()
          );
          const closePctRaw = Number(process.env.MULTI_TP_CLOSE_PCT ?? 50);
          const closePct = Number.isFinite(closePctRaw) ? Math.max(1, Math.min(99, Math.floor(closePctRaw))) : 50;
          const isMulti = multiTpEnabled && Number.isFinite(tp1) && Number.isFinite(tp2);

          if (isMulti && !tp1Hit && Number.isFinite(price) && Number.isFinite(entryPrice)) {
            const hitTp1 = pos.side === "LONG" ? price >= tp1 : pos.side === "SHORT" ? price <= tp1 : false;
            if (hitTp1) {
              const remainingPrev = Number(pos.remainingPct);
              const remainingBase = Number.isFinite(remainingPrev) ? remainingPrev : 100;
              const remainingPct = Math.max(0, Math.min(100, remainingBase - closePct));
              const newSl =
                pos.side === "LONG"
                  ? Math.max(Number.isFinite(sl) ? sl : -Infinity, entryPrice)
                  : pos.side === "SHORT"
                    ? Math.min(Number.isFinite(sl) ? sl : Infinity, entryPrice)
                    : sl;

              const updated = await updatePaperPosition({
                id: pos.id,
                patch: {
                  tp1Hit: true,
                  tp1HitAt: Date.now(),
                  tp1HitPrice: price,
                  sl: newSl,
                  remainingPct,
                  multiTpClosePct: closePct
                }
              });
              sl = Number(updated?.sl);
              tp1Hit = true;
              await recordPaperPartialClose({ id: pos.id, exitPrice: price, reason: "TP1", closePct });
              if (pos.chatId) {
                await bot.telegram.sendMessage(
                  pos.chatId,
                  `💵 TP1 alcanzado en ${pos.symbol}\nCerrado: ${closePct}%\n🛡️ SL protegido: ${fmt(sl, 6)}`
                );
              }
            }
          }

          const paperTrailStartPct = Number.isFinite(Number(process.env.PAPER_TRAIL_START_PCT))
            ? Math.max(0, Math.min(0.2, Number(process.env.PAPER_TRAIL_START_PCT)))
            : 0.03;
          const paperTrailNotifyCooldownMs = Math.max(
            30_000,
            Math.floor(Number(process.env.PAPER_TRAIL_NOTIFY_COOLDOWN_MS ?? 10 * 60 * 1000))
          );

          if (paperTrailingEnabled && Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(price)) {
            let nextSl = sl;
            let didBreakeven = false;
            let didTrail = false;

            if (pos.side === "LONG") {
              const beTrigger = entryPrice * (1 + paperTrailBreakevenPct);
              if (price >= beTrigger && (!Number.isFinite(nextSl) || nextSl < entryPrice)) {
                nextSl = entryPrice;
                didBreakeven = true;
              }
              const trailTrigger = entryPrice * (1 + paperTrailStartPct);
              if (price >= trailTrigger) {
                const candidate = price * (1 - paperTrailPct);
                if (!Number.isFinite(nextSl) || candidate > nextSl) {
                  nextSl = candidate;
                  didTrail = true;
                }
              }
            } else if (pos.side === "SHORT") {
              const beTrigger = entryPrice * (1 - paperTrailBreakevenPct);
              if (price <= beTrigger && (!Number.isFinite(nextSl) || nextSl > entryPrice)) {
                nextSl = entryPrice;
                didBreakeven = true;
              }
              const trailTrigger = entryPrice * (1 - paperTrailStartPct);
              if (price <= trailTrigger) {
                const candidate = price * (1 + paperTrailPct);
                if (!Number.isFinite(nextSl) || candidate < nextSl) {
                  nextSl = candidate;
                  didTrail = true;
                }
              }
            }

            if (
              Number.isFinite(nextSl) &&
              (!Number.isFinite(sl) || Math.abs(nextSl - sl) / entryPrice > paperTrailMinStepPct)
            ) {
              const updated = await updatePaperPosition({
                id: pos.id,
                patch: {
                  sl: nextSl,
                  trailLastAt: Date.now(),
                  trailLastPrice: price
                }
              });
              sl = Number(updated?.sl);

              const lastNotifiedAt = Number(updated?.trailNotifiedAt ?? 0);
              const canNotify = !Number.isFinite(lastNotifiedAt) || Date.now() - lastNotifiedAt >= paperTrailNotifyCooldownMs;
              if (didBreakeven && pos.chatId) {
                await bot.telegram.sendMessage(pos.chatId, `🛡️ PROTECCIÓN: SL movido a entrada para ${pos.symbol}`);
                await updatePaperPosition({ id: pos.id, patch: { trailNotifiedAt: Date.now() } });
              } else if (didTrail && canNotify && pos.chatId) {
                await bot.telegram.sendMessage(pos.chatId, `📈 Trailing SL actualizado para ${pos.symbol}: ${fmt(sl, 6)}`);
                await updatePaperPosition({ id: pos.id, patch: { trailNotifiedAt: Date.now() } });
              }
            }
          }

          let hit = null;
          if (pos.side === "LONG") {
            const finalTp = isMulti ? tp2 : tp;
            if (Number.isFinite(finalTp) && price >= finalTp) hit = isMulti ? "TP2" : "TP";
            if (Number.isFinite(sl) && price <= sl) hit = tp1Hit ? "TRAIL" : "SL";
          } else if (pos.side === "SHORT") {
            const finalTp = isMulti ? tp2 : tp;
            if (Number.isFinite(finalTp) && price <= finalTp) hit = isMulti ? "TP2" : "TP";
            if (Number.isFinite(sl) && price >= sl) hit = tp1Hit ? "TRAIL" : "SL";
          }

          if (!hit && paperMaxHoldMinutes > 0) {
            const openedAt = Number(pos.openedAt);
            if (Number.isFinite(openedAt)) {
              const ageMinutes = (Date.now() - openedAt) / 60000;
              if (ageMinutes >= paperMaxHoldMinutes) hit = "TIMEOUT";
            }
          }

          if (hit) {
            const closed = await closePaperPosition({ id: pos.id, exitPrice: price, reason: hit });
            if (closed?.chatId) await bot.telegram.sendMessage(closed.chatId, formatCloseMessage(closed));
            logAprendizaje(
              `Paper: se cerró posición ${closed.symbol} (${hit})`,
              `Decisión de salida: ${hit}. entry=${closed.entry} exit=${closed.exit} sl=${closed.sl} tp=${closed.tp} side=${closed.side} r=${closed.r} exchange=${closed.exchange} chatId=${closed.chatId}.`
            );
            registrarEnHistorial(closed, hit, price).catch(() => {});
            if (closed && Number.isFinite(Number(closed.r)) && Number(closed.r) < 0) {
              try {
                const data = await fetchCandles({ exchange: closed.exchange, symbol: closed.symbol, timeframe: closed.timeframe });
                const sig = await buildSignal(data);
                const candles = Array.isArray(data?.candles) ? data.candles : [];
                const last = candles.length ? candles[candles.length - 1] : null;
                const lastVol = last ? Number(last[5]) : null;
                const vols = candles.slice(-20).map((c) => Number(c?.[5])).filter((v) => Number.isFinite(v) && v > 0);
                const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
                const volRatio = Number.isFinite(lastVol) && Number.isFinite(avgVol) && avgVol > 0 ? lastVol / avgVol : null;
                if (hit === "SL" && closed.chatId) {
                  try {
                    const entryPx = Number(closed.entry);
                    const exitPx = Number(closed.exit);
                    const pnlNum =
                      Number.isFinite(entryPx) && Number.isFinite(exitPx) && entryPx !== 0
                        ? closed.side === "SHORT"
                          ? ((entryPx - exitPx) / entryPx) * 100
                          : ((exitPx - entryPx) / entryPx) * 100
                        : null;
                    const critique = await generarAutocritica({
                      apiKey: deepseekKey,
                      tradeFallido: { ...closed, pnl_num: pnlNum },
                      contexto: {
                        rsi: Number(sig.indicators?.rsi),
                        atr: Number(sig.indicators?.atr),
                        volRatio,
                        hour: new Date().getHours()
                      }
                    });
                    if (critique?.enabled && critique?.ok) {
                      const msg = [
                        "<b>❌ TRADE FALLIDO: POST-MORTEM PSICOLÓGICO</b>",
                        "━━━━━━━━━━━━━━━━━━",
                        `<b>${escapeHtml(closed.symbol)}</b> <code>${escapeHtml(closed.timeframe)}</code> <code>${escapeHtml(closed.side)}</code>`,
                        "",
                        `<b>¿Qué pasó?</b> ${escapeHtml(critique.que_paso || "N/A")}`,
                        "",
                        `<b>Lección de Oro:</b> ${escapeHtml(critique.leccion_de_oro || "N/A")}`,
                        "",
                        `<b>Mejora Técnica:</b> ${escapeHtml(critique.mejora_tecnica || "N/A")}`,
                        "",
                        "<b>🧠 Memoria actualizada:</b> lección guardada en SABIDURIA_EVOLUTIVA.md"
                      ].join("\n");
                      await bot.telegram.sendMessage(closed.chatId, msg.slice(0, 3900), { parse_mode: "HTML" });
                    } else if (critique?.reason === "MISSING_DEEPSEEK_KEY") {
                      await bot.telegram.sendMessage(closed.chatId, "Post-Mortem IA: OFF (falta DEEPSEEK_KEY).");
                    }
                  } catch (e) {
                    logAprendizaje(
                      `Post-Mortem: fallo generando autocrítica ${closed?.symbol ?? ""}`,
                      `Se capturó el error para no romper el bot.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
                    );
                  }
                }
                const entry = await recordErrorPattern({
                  type: "loss_trade",
                  exchange: closed.exchange,
                  market: String(closed.exchange ?? "").includes("usdm") ? "futures" : "spot",
                  symbol: closed.symbol,
                  timeframe: closed.timeframe,
                  side: closed.side,
                  reason: closed.reason,
                  notes: `Trade en pérdida. r=${closed.r} | rsi ${Math.round(Number(sig.indicators?.rsi ?? 0))} | volRatio ${Number.isFinite(volRatio) ? fmt(volRatio, 2) : "na"}`,
                  features: {
                    rsi: Number(sig.indicators?.rsi),
                    atr: Number(sig.indicators?.atr),
                    volRatio: Number(volRatio),
                    volume: Number(lastVol),
                    price: Number(sig.entry),
                    hour: new Date().getHours()
                  }
                });
                logObsidian(
                  [
                    `## [${entry.date}] Patrón Prohibido guardado`,
                    "",
                    `Motivo: Trade cerrado en pérdida (${closed.reason}).`,
                    `Síntomas: RSI ${Math.round(Number(sig.indicators?.rsi ?? 0))}, volRatio ${Number.isFinite(volRatio) ? fmt(volRatio, 2) : "na"}.`,
                    "Sentencia: No operar si estas condiciones se repiten.",
                    ""
                  ].join("\n")
                );
                try {
                  const apiKey = process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || null;
                  if (apiKey) {
                    await learnFromLossWithDeepseek({
                      apiKey,
                      trade: closed,
                      signal: sig,
                      extraNotes: `volRatio=${Number.isFinite(volRatio) ? fmt(volRatio, 2) : "na"}`
                    });
                  }
                } catch (e) {
                  logAprendizaje(
                    `Brain: fallo generando lección IA (${closed?.symbol ?? ""})`,
                    `Se capturó el error para no romper el bot.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
                  );
                }
              } catch (e) {
                logAprendizaje(
                  `Post-Mortem: fallo registrando pérdida ${closed?.symbol ?? ""}`,
                  `Se capturó el error para no romper el bot.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
                );
              }
            }
          }
        } catch (e) {
          logAprendizaje(
            `Error monitorizando posición paper ${pos?.id ?? "N/A"}`,
            `Se capturó la excepción para no detener el loop de monitorización.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
          );
        }
      }
    } finally {
      monitoring = false;
    }
  }

  function formatAlertsStatus(cfg) {
    if (!cfg) return "Alertas: OFF";
    const tf = cfg.timeframe ?? "15m";
    const ex = cfg.exchange ?? "binanceusdm";
    const market = cfg.market ?? "futures";
    const quote = String(cfg.quote ?? "USDT").toUpperCase();
    const minConf = Number.isFinite(Number(cfg.minConfidence)) ? Number(cfg.minConfidence) : alertsMinConfidence;
    const cooldown = Number.isFinite(Number(cfg.cooldownMinutes)) ? Number(cfg.cooldownMinutes) : alertsCooldownMinutes;
    const maxSym = Number.isFinite(Number(cfg.maxSymbols)) ? Number(cfg.maxSymbols) : alertsMaxSymbols;
    return `Alertas: ${cfg.enabled ? "ON" : "OFF"} | TF ${tf} | ${ex} ${market} | quote ${quote} | minConf ${minConf} | cooldown ${cooldown}m | maxSymbols ${maxSym}`;
  }

  async function runAlertsOnce() {
    if (alertsRunning) return;
    alertsRunning = true;
    try {
      const mem = await loadMemory();
      const alerts = mem.config?.alerts && typeof mem.config.alerts === "object" ? mem.config.alerts : {};
      const apiKey = process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || null;
      const now = Date.now();

      for (const [chatId, cfgRaw] of Object.entries(alerts)) {
        const cfg = cfgRaw && typeof cfgRaw === "object" ? cfgRaw : null;
        if (!cfg?.enabled) continue;

        const timeframe = String(cfg.timeframe ?? "15m");
        const exchange = String(cfg.exchange ?? "binanceusdm").trim().toLowerCase();
        const market = String(cfg.market ?? "futures").trim().toLowerCase();
        const quote = String(cfg.quote ?? "USDT").trim().toUpperCase() || "USDT";
        const minConfidence = Number.isFinite(Number(cfg.minConfidence)) ? Number(cfg.minConfidence) : alertsMinConfidence;
        const cooldownMinutes = Number.isFinite(Number(cfg.cooldownMinutes)) ? Number(cfg.cooldownMinutes) : alertsCooldownMinutes;
        const maxSymbols = Number.isFinite(Number(cfg.maxSymbols)) ? Number(cfg.maxSymbols) : alertsMaxSymbols;
        const maxResults = 3;
        const cooldownMs = Math.max(1, cooldownMinutes) * 60000;

        const scan = await scanSignalsParallel({
          exchange,
          timeframe,
          quote,
          maxSymbols,
          maxResults,
          chunkSize: scanConcurrent,
          pauseMs: scanChunkDelayMs,
          market: market === "spot" ? "spot" : "futures",
          sortBy: "roi"
        });

        const top = scan.results?.[0];
        if (!top) continue;
        const conf = Number(top.model?.confidence ?? 0);
        if (conf < minConfidence) continue;

        const key = `${top.symbol}|${timeframe}|${exchange}|${market}|${top.side}`;
        const lastSentAt = Number(cfg.lastSentAt ?? 0);
        if (cfg.lastSentKey === key && Number.isFinite(lastSentAt) && now - lastSentAt < cooldownMs) continue;

        let message = null;
        if (apiKey) {
          try {
            const data = await fetchCandles({ exchange, symbol: top.symbol, timeframe });
            const ai = await buildAiTradeIdea({ ...data, apiKey });
            message = formatAiMessage(ai);
          } catch {
            logAprendizaje(
              `Alertas: fallo AI para ${top.symbol} ${timeframe} (${exchange} ${market})`,
              "Mitigación: se usó fallback a señal base (formatSignalMessage) para no perder la alerta."
            );
            message = formatSignalMessage(top);
          }
        } else {
          message = formatSignalMessage(top);
        }

        await bot.telegram.sendMessage(chatId, message);
        await setAlertsConfig(chatId, { ...cfg, lastSentKey: key, lastSentAt: now });
      }
    } finally {
      alertsRunning = false;
    }
  }

  function helpText() {
    return [
      "Bot listo.",
      "",
      "Comandos:",
      "/panel",
      "/signal BTC/USDT 15m",
      "/multi BTC/USDT",
      "/scan 15m 10",
      "/scanf 15m 10",
      "/deepseek BTC/USDT 15m",
      "/paper on",
      "/positions",
      "/close <id>",
      "/alerts all 15m",
      "/alerts on 15m binanceusdm futures 0.6 10 300 USDT",
      "/balance",
      "/inspect",
      "/brain",
      "",
      "También puedes escribir:",
      "BTC/USDT 1h",
      "BTC/USDT 15m binanceusdm",
      "",
      "Nota:",
      "Si la señal sale NEUTRAL, no hay entrada/SL/TP (es 'esperar'). Prueba otro timeframe o usa /scanf para encontrar oportunidades.",
      "Alertas busca muchas monedas (pares por quote, ej: USDT). Sube maxSymbols para cubrir más mercado."
    ].join("\n");
  }

  bot.start(async (ctx) => {
    await ctx.reply(helpText());
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpText());
  });

  bot.command("inspect", async (ctx) => {
    const mem = await loadMemory();
    await replyHtmlCode(ctx, JSON.stringify(mem, null, 2));
  });

  bot.command("brain", async (ctx) => {
    const d = await readWisdomEntries({ last: 3 });
    if (!d.entries.length) {
      await ctx.reply("🧠 AETHER: Mi cerebro está en blanco. Necesito operar más para empezar a aprender.");
      return;
    }
    const lines = [];
    lines.push("<b>🧠 ESTADO DE APRENDIZAJE: AETHER LABS</b>");
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push(`<b>Total lecciones:</b> <code>${escapeHtml(d.total)}</code>`);
    lines.push("");
    lines.push("<b>💡 ÚLTIMAS LECCIONES DE ORO</b>");
    lines.push("");
    for (let i = 0; i < d.entries.length; i += 1) {
      const raw = String(d.entries[i] ?? "").trim();
      const parts = raw.split("\n").filter(Boolean);
      const title = parts[0] ? parts[0].replace(/^##\s*/, "") : `Lección ${i + 1}`;
      const body = parts.slice(1).join(" ").replace(/\s+/g, " ").trim();
      const short = body.length > 500 ? body.slice(0, 500) + "…" : body;
      lines.push(`<b>🔸 ${escapeHtml(title)}</b>`);
      if (short) lines.push(escapeHtml(short));
      lines.push("");
    }
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push("<i>Mi algoritmo se ajusta automáticamente basándose en estas experiencias.</i>");
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("history", async (ctx) => {
    const h = await loadTradeHistory();
    const historial = Array.isArray(h.items) ? h.items : [];
    if (!historial.length) {
      await ctx.reply("📂 AETHER: Aún no hay trades registrados en el historial.");
      return;
    }

    const lastN = 5;
    const ultimos = historial.slice(-lastN).reverse();
    const total = historial
      .map((t) => Number(t?.pnl_num))
      .filter((x) => Number.isFinite(x))
      .reduce((a, b) => a + b, 0);
    const wins = historial.filter((t) => Number.isFinite(Number(t?.pnl_num)) && Number(t.pnl_num) >= 0).length;
    const n = historial.length;
    const winRate = n ? Math.round((wins / n) * 100) : 0;

    const lines = [];
    lines.push("<b>📜 HISTORIAL RECIENTE (Aether Labs)</b>");
    lines.push("━━━━━━━━━━━━━━━━━━");
    for (const t of ultimos) {
      const pnl = Number(t?.pnl_num);
      const icon = Number.isFinite(pnl) && pnl >= 0 ? "✅" : "❌";
      const sym = escapeHtml(t?.symbol ?? "N/A");
      const res = escapeHtml(t?.resultado ?? "N/A");
      const motivo = escapeHtml(t?.motivo ?? "N/A");
      const tp1 = escapeHtml(t?.tp1_tocado ?? "NO");
      const day = String(t?.fecha ?? "").split("T")[0] || "N/A";
      lines.push(`${icon} <b>${sym}</b>: ${res} (<code>${motivo}</code>)`);
      lines.push(`   └ TP1: <code>${tp1}</code> | <code>${escapeHtml(day)}</code>`);
      lines.push("");
    }
    lines.push("━━━━━━━━━━━━━━━━━━");
    lines.push(`<b>📈 PNL ACUMULADO:</b> <code>${escapeHtml(fmt(total, 2))}%</code>`);
    lines.push(`<b>🎯 Winrate:</b> <code>${escapeHtml(winRate)}%</code> (<code>${escapeHtml(wins)}/${escapeHtml(n)}</code>)`);
    lines.push(`<b>Archivo:</b> <code>${escapeHtml(h.path)}</code>`);
    await ctx.reply(lines.join("\n").slice(0, 3900), { parse_mode: "HTML" });
  });

  bot.command("panel", async (ctx) => {
    await sendPanel(ctx);
  });

  bot.command("balance", async (ctx) => {
    const res = await generar_balance_de_aprendizaje();
    let tail = "";
    try {
      const txt = await fs.readFile(res.path, "utf8");
      const max = 3500;
      tail = txt.length > max ? txt.slice(-max) : txt;
      tail = tail.trim();
    } catch {
    }
    const base = [
      `Balance generado: ${res.date}`,
      `Hoy aprendí: ${res.learnedCount} patrones que causan pérdidas.`,
      `Hoy descubrí: ${res.walletsCount} billeteras nuevas con alta rentabilidad.`,
      `Archivo: ${res.path}`
    ].join("\n");
    await ctx.reply(base);
    if (tail) await ctx.reply(tail.slice(0, 3900));
  });

  async function handleScanTop10(ctx) {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    const { timeframe, exchange, market, quote, maxSymbols } = await getChatDefaults(chatId);
    await ctx.replyWithChatAction("typing");
    const scan = await scanSignalsParallel({
      exchange,
      timeframe,
      quote,
      market: market === "spot" ? "spot" : "futures",
      maxSymbols: Math.max(50, Math.min(800, Number(maxSymbols) || 300)),
      maxResults: 10,
      chunkSize: scanConcurrent,
      pauseMs: scanChunkDelayMs,
      sortBy: "roi"
    });
    const wisdom = await readWisdomEntries({ last: 6 });
    const f = filtrarPorSabiduria({ signals: scan.results, wisdomEntries: wisdom.entries });
    const out = { ...scan, results: f.kept };
    await ctx.reply(formatScanMessage(out));
    if (f.blockedSymbols.length) {
      await ctx.reply(`🧠 Sabiduría: descartadas ${f.blockedSymbols.length}: ${f.blockedSymbols.join(", ")}`);
    }
  }

  async function handleScanGemsAi(ctx) {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    const { timeframe, exchange, market, quote, maxSymbols } = await getChatDefaults(chatId);
    const apiKey = process.env.DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY || null;
    if (!apiKey) {
      await ctx.reply("IA: OFF (falta DEEPSEEK_KEY).");
      return;
    }
    await ctx.replyWithChatAction("typing");
    const scan = await scanSignalsParallel({
      exchange,
      timeframe,
      quote,
      market: market === "spot" ? "spot" : "futures",
      maxSymbols: Math.max(50, Math.min(800, Number(maxSymbols) || 300)),
      maxResults: 5,
      chunkSize: scanConcurrent,
      pauseMs: scanChunkDelayMs,
      sortBy: "roi"
    });
    const wisdom = await readWisdomEntries({ last: 6 });
    const f = filtrarPorSabiduria({ signals: scan.results, wisdomEntries: wisdom.entries });
    const out = { ...scan, results: f.kept };
    if (!out.results.length) {
      await ctx.reply(formatScanMessage(out));
      return;
    }
    if (f.blockedSymbols.length) {
      await ctx.reply(`🧠 Sabiduría: descartadas ${f.blockedSymbols.length}: ${f.blockedSymbols.join(", ")}`);
    }
    const top = out.results.slice(0, 3);
    const ideas = [];
    for (const s of top) {
      try {
        const data = await fetchCandles({ exchange: s.exchange, symbol: s.symbol, timeframe: s.timeframe });
        const ai = await buildAiTradeIdea({ ...data, apiKey });
        ideas.push(formatAiMessage(ai));
      } catch (e) {
        ideas.push(`${s.symbol} (${s.exchange})\nError IA: ${e?.message ?? String(e)}`);
      }
    }
    await ctx.reply(["GEMAS (IA)", "", ...ideas].join("\n\n").slice(0, 3900));
  }

  async function handleBalance(ctx) {
    const res = await generar_balance_de_aprendizaje();
    const base = [
      `Balance generado: ${res.date}`,
      `Hoy aprendí: ${res.learnedCount} patrones que causan pérdidas.`,
      `Hoy descubrí: ${res.walletsCount} billeteras nuevas con alta rentabilidad.`,
      `Archivo: ${res.path}`
    ].join("\n");
    await ctx.reply(base);
    const tail = await readFileTailSafe(res.path);
    if (tail) await ctx.reply(tail.slice(0, 3900));
  }

  async function handlePaperStatus(ctx) {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    const positions = (await listPaperPositions()).filter((p) => p.chatId === chatId);
    const lines = [];
    lines.push(`Paper trading: ${paperEnabled ? "ON" : "OFF"}`);
    lines.push(`Posiciones abiertas: ${positions.length}`);
    if (positions.length) {
      lines.push("");
      lines.push(positions.slice(0, 10).map((p) => `${p.id} ${p.symbol} ${p.side} TF ${p.timeframe}`).join("\n"));
    }
    await ctx.reply(lines.join("\n"));
  }

  async function handleAlertsAllOn(ctx) {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    const { timeframe, exchange, market, quote, minConfidence, cooldownMinutes, maxSymbols } =
      await getChatDefaults(chatId);
    const cfg = {
      enabled: true,
      timeframe,
      exchange,
      market: market === "spot" ? "spot" : "futures",
      quote,
      minConfidence,
      cooldownMinutes,
      maxSymbols: Math.max(200, Math.min(800, Number(maxSymbols) || 800))
    };
    await setAlertsConfig(chatId, cfg);
    await ctx.reply(formatAlertsStatus(cfg));
    runAlertsOnce().catch(() => {});
  }

  async function handleAlertsOff(ctx) {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    await setAlertsConfig(chatId, { enabled: false });
    const cfg = await getAlertsConfig(chatId);
    await ctx.reply(formatAlertsStatus(cfg));
  }

  async function handlePanicConfirm(ctx) {
    await ctx.reply(
      "CONFIRMA: ¿Quieres cerrar TODAS las posiciones paper y apagar alertas/paper en este chat?",
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ SI, CERRAR TODO", "panic_execute")],
        [Markup.button.callback("↩️ Cancelar", "panic_cancel")]
      ])
    );
  }

  async function handlePanicExecute(ctx) {
    const chatId = ctx.chat?.id ?? ctx.from?.id;
    await setAlertsConfig(chatId, { enabled: false });
    paperEnabled = false;
    const positions = (await listPaperPositions()).filter((p) => p.chatId === chatId);
    const closed = [];
    for (const pos of positions) {
      try {
        const p = await fetchLastPrice({ exchange: pos.exchange, symbol: pos.symbol });
        const c = await closePaperPosition({ id: pos.id, exitPrice: p.price, reason: "PANIC" });
        if (c) closed.push(c);
      } catch {
      }
    }
    const lines = [];
    lines.push("PANIC: OK");
    lines.push("Alertas: OFF");
    lines.push("Paper: OFF");
    lines.push(`Cerradas: ${closed.length}`);
    await ctx.reply(lines.join("\n"));
    if (closed.length) {
      const blocks = closed.slice(0, 10).map((c) => formatCloseMessage(c));
      await ctx.reply(blocks.join("\n\n").slice(0, 3900));
    }
  }

  async function handlePanicCancel(ctx) {
    await ctx.reply("Panic cancelado.", panelKeyboard());
  }

  const panelHandlers = new Map([
    ["scan_top10", handleScanTop10],
    ["scan_gems_ai", handleScanGemsAi],
    ["get_balance", handleBalance],
    ["paper_status", handlePaperStatus],
    ["alerts_all_on", handleAlertsAllOn],
    ["alerts_off", handleAlertsOff],
    ["panic_confirm", handlePanicConfirm],
    ["panic_execute", handlePanicExecute],
    ["panic_cancel", handlePanicCancel],
    ["panel_refresh", sendPanel]
  ]);

  bot.on("callback_query", async (ctx) => {
    const data = String(ctx.callbackQuery?.data ?? "").trim();
    const handler = panelHandlers.get(data);
    try {
      await ctx.answerCbQuery();
    } catch {
    }
    try {
      if (handler) {
        await handler(ctx);
        return;
      }

      if (data.startsWith("cfg:")) {
        const chatId = ctx.chat?.id ?? ctx.from?.id;
        const raw = data.slice(4);
        const [k, vRaw] = raw.split("=");
        const v = String(vRaw ?? "").trim();
        const patch = {};

        if (k === "tf") patch.timeframe = v || "15m";
        if (k === "market") {
          patch.market = v === "spot" ? "spot" : "futures";
          patch.exchange = v === "spot" ? "binance" : "binanceusdm";
        }
        if (k === "ex") patch.exchange = v || "binanceusdm";
        if (k === "quote") patch.quote = v || "USDT";
        if (k === "max") patch.maxSymbols = Number(v);
        if (k === "conf") patch.minConfidence = Number(v);
        if (k === "cd") patch.cooldownMinutes = Number(v);

        await upsertAlertsConfig(chatId, patch);
        await sendPanel(ctx);
      }
    } catch (e) {
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("addexpert", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/addexpert(@\w+)?/i, "").trim();
    const parts = args.split(/\s+/).filter(Boolean);
    const wallet = parts[0] ?? "";
    const chain = parts[1] ?? "";
    const roi = parts[2] ?? "";
    const notes = parts.slice(3).join(" ");
    if (!wallet) {
      await ctx.reply("Uso: /addexpert <wallet> <chain> <roi_pct_opcional> <notas_opcional>");
      return;
    }
    const entry = await recordExpertDetected({ wallet, chain, roi: roi ? Number(roi) : null, notes });
    await ctx.reply(`✅ Guardado experto: ${entry.wallet} (${entry.chain || "N/A"}) roi=${entry.roi ?? "N/A"}`);
  });

  bot.command("honeypot", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/honeypot(@\w+)?/i, "").trim();
    const parts = args.split(/\s+/).filter(Boolean);
    const chain = parts[0] ?? "";
    const tokenAddress = parts[1] ?? "";
    if (!tokenAddress) {
      await ctx.reply("Uso: /honeypot <chain> <token_address>");
      return;
    }
    const res = await verificar_honeypot({ chain, tokenAddress });
    if (!res.enabled) {
      await ctx.reply("Honeypot check: OFF (activa HONEYPOT_CHECK_ENABLED=1).");
      return;
    }
    if (res.ok) {
      await ctx.reply(`✅ Honeypot check OK (${res.reason}).`);
      return;
    }
    const sig = await recordScamSignature({
      type: "honeypot",
      exchange: "onchain",
      market: String(chain || "unknown"),
      symbol: String(tokenAddress),
      timeframe: "",
      side: "",
      reason: String(res.reason),
      notes: `Honeypot check falló. buyTax=${res.buyTax ?? "N/A"} sellTax=${res.sellTax ?? "N/A"} cannotSell=${res.cannotSell ?? "N/A"}`,
      features: { buyTax: res.buyTax, sellTax: res.sellTax, cannotSell: res.cannotSell }
    });
    await recordErrorPattern({
      type: "honeypot",
      exchange: "onchain",
      market: String(chain || "unknown"),
      symbol: String(tokenAddress),
      timeframe: "",
      side: "",
      reason: String(res.reason),
      notes: sig.notes,
      features: sig.features
    });
    logObsidian(
      [
        "## ⚠️ Alerta de Manipulación: HoneyPot",
        "",
        `Token: ${tokenAddress}`,
        `Chain: ${chain || "N/A"}`,
        `Motivo de Rechazo: ${res.reason}`,
        "Decisión: EL BOT ABORTA Y APRENDE.",
        ""
      ].join("\n")
    );
    await ctx.reply(`⚠️ Honeypot detectado (${res.reason}). Guardado en memoria/Obsidian.`);
  });

  bot.command("paper", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/paper(@\w+)?/i, "").trim().toLowerCase();
    if (args === "on" || args === "1" || args === "true") {
      paperEnabled = true;
      await ctx.reply("Paper trading: ON");
      return;
    }
    if (args === "off" || args === "0" || args === "false") {
      paperEnabled = false;
      await ctx.reply("Paper trading: OFF");
      return;
    }
    await ctx.reply(`Paper trading: ${paperEnabled ? "ON" : "OFF"}. Usa /paper on o /paper off`);
  });

  bot.command("alerts", async (ctx) => {
    const chatId = ctx.chat?.id;
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/alerts(@\w+)?/i, "").trim();
    const parts = args.split(/\s+/).filter(Boolean);
    const action = (parts[0] ?? "status").toLowerCase();

    try {
      if (action === "off") {
        await setAlertsConfig(chatId, { enabled: false });
        const cfg = await getAlertsConfig(chatId);
        await ctx.reply(formatAlertsStatus(cfg));
        return;
      }

      if (action === "on" || action === "all") {
        const timeframe = parts[1] ?? "15m";
        const exchange = (parts[2] ?? "binanceusdm").toLowerCase();
        const market = (parts[3] ?? "futures").toLowerCase();
        const minConfidence = parts[4] !== undefined ? Number(parts[4]) : alertsMinConfidence;
        const cooldownMinutes = parts[5] !== undefined ? Number(parts[5]) : alertsCooldownMinutes;
        const defaultMax = action === "all" ? 800 : alertsMaxSymbols;
        const maxSymbols = parts[6] !== undefined ? Number(parts[6]) : defaultMax;
        const quote = String(parts[7] ?? "USDT").trim().toUpperCase() || "USDT";

        const cfg = {
          enabled: true,
          timeframe,
          exchange,
          market: market === "spot" ? "spot" : "futures",
          quote,
          minConfidence: Math.max(0, Math.min(1, Number.isFinite(minConfidence) ? minConfidence : alertsMinConfidence)),
          cooldownMinutes: Math.max(1, Number.isFinite(cooldownMinutes) ? cooldownMinutes : alertsCooldownMinutes),
          maxSymbols: Math.max(5, Math.min(800, Number.isFinite(maxSymbols) ? maxSymbols : defaultMax))
        };

        await setAlertsConfig(chatId, cfg);
        await ctx.reply(formatAlertsStatus(cfg));
        runAlertsOnce().catch(() => {});
        return;
      }

      const cfg = await getAlertsConfig(chatId);
      await ctx.reply(formatAlertsStatus(cfg));
    } catch (e) {
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("positions", async (ctx) => {
    try {
      const positions = (await listPaperPositions()).filter((p) => p.chatId === ctx.chat?.id);
      if (!positions.length) {
        await ctx.reply("Sin posiciones paper abiertas.");
        return;
      }
      const blocks = positions.slice(0, 20).map((p) => formatPositionMessage(p));
      await ctx.reply(blocks.join("\n\n"));
    } catch (e) {
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("close", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/close(@\w+)?/i, "").trim();
    const id = args.split(/\s+/)[0];
    if (!id) {
      await ctx.reply("Uso: /close <id>");
      return;
    }
    try {
      const positions = await listPaperPositions();
      const pos = positions.find((p) => p.id === id && p.chatId === ctx.chat?.id);
      if (!pos) {
        await ctx.reply("No existe esa posición en este chat.");
        return;
      }
      const p = await fetchLastPrice({ exchange: pos.exchange, symbol: pos.symbol });
      const closed = await closePaperPosition({ id: pos.id, exitPrice: p.price, reason: "MANUAL" });
      if (closed) await ctx.reply(formatCloseMessage(closed));
      if (closed && Number.isFinite(Number(closed.r)) && Number(closed.r) < 0) {
        try {
          const data = await fetchCandles({ exchange: closed.exchange, symbol: closed.symbol, timeframe: closed.timeframe });
          const sig = await buildSignal(data);
          const candles = Array.isArray(data?.candles) ? data.candles : [];
          const last = candles.length ? candles[candles.length - 1] : null;
          const lastVol = last ? Number(last[5]) : null;
          const vols = candles.slice(-20).map((c) => Number(c?.[5])).filter((v) => Number.isFinite(v) && v > 0);
          const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
          const volRatio = Number.isFinite(lastVol) && Number.isFinite(avgVol) && avgVol > 0 ? lastVol / avgVol : null;
          const entry = await recordErrorPattern({
            type: "loss_trade",
            exchange: closed.exchange,
            market: String(closed.exchange ?? "").includes("usdm") ? "futures" : "spot",
            symbol: closed.symbol,
            timeframe: closed.timeframe,
            side: closed.side,
            reason: closed.reason,
            notes: `Pérdida manual. r=${closed.r} | rsi ${Math.round(Number(sig.indicators?.rsi ?? 0))} | volRatio ${Number.isFinite(volRatio) ? fmt(volRatio, 2) : "na"}`,
            features: {
              rsi: Number(sig.indicators?.rsi),
              atr: Number(sig.indicators?.atr),
              volRatio: Number(volRatio),
              volume: Number(lastVol),
              price: Number(sig.entry),
              hour: new Date().getHours()
            }
          });
          logObsidian(
            [
              `## [${entry.date}] Patrón Prohibido guardado`,
              "",
              `Motivo: Trade cerrado en pérdida (${closed.reason}).`,
              `Síntomas: RSI ${Math.round(Number(sig.indicators?.rsi ?? 0))}, volRatio ${Number.isFinite(volRatio) ? fmt(volRatio, 2) : "na"}.`,
              "Sentencia: No operar si estas condiciones se repiten.",
              ""
            ].join("\n")
          );
        } catch (e) {
          logAprendizaje(
            `Post-Mortem: fallo registrando pérdida manual ${closed?.symbol ?? ""}`,
            `Se capturó el error para no romper el bot.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
          );
        }
      }
    } catch (e) {
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("deepseek", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/deepseek(@\w+)?/i, "").trim();
    const req = parseSignalRequest(args);
    if (!req.symbol || !req.timeframe) {
      await ctx.reply("Uso: /deepseek BTC/USDT 15m");
      return;
    }
    if (isAllTimeframes(req.timeframe)) {
      await ctx.reply("DeepSeek solo en 1 timeframe. Usa /multi BTC/USDT para todas.");
      return;
    }
    const apiKey = getEnvAny(["DEEPSEEK_KEY", "DEEPSEEK_API_KEY"]);
    try {
      await ctx.replyWithChatAction("typing");
      const data = await fetchCandles(req);
      const ai = await buildAiTradeIdea({ ...data, apiKey });
      await ctx.reply(formatAiMessage(ai));
    } catch (e) {
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("ai", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/ai(@\w+)?/i, "").trim();
    const req = parseSignalRequest(args);
    if (!req.symbol || !req.timeframe) {
      await ctx.reply("Uso: /ai BTC/USDT 15m");
      return;
    }
    if (isAllTimeframes(req.timeframe)) {
      await ctx.reply("AI solo en 1 timeframe. Usa /multi BTC/USDT para todas.");
      return;
    }
    const apiKey = getEnvAny(["DEEPSEEK_KEY", "DEEPSEEK_API_KEY"]);
    try {
      await ctx.replyWithChatAction("typing");
      const data = await fetchCandles(req);
      const ai = await buildAiTradeIdea({ ...data, apiKey });
      await ctx.reply(formatAiMessage(ai));
      logAprendizaje(
        `AI: idea generada para ${req.symbol} ${req.timeframe} (${req.exchange})`,
        `Decisión estratégica: se generó idea con buildAiTradeIdea usando DeepSeek y contexto de velas. action=${ai?.action ?? "N/A"} confidence=${ai?.confidence ?? "N/A"}.`
      );
    } catch (e) {
      logAprendizaje(
        `AI: error generando idea para ${req.symbol} ${req.timeframe} (${req.exchange})`,
        `Se capturó el error y se respondió al usuario sin tumbar el bot.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
      );
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("signal", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/signal(@\w+)?/i, "").trim();
    const req = parseSignalRequest(args);
    if (!req.symbol || !req.timeframe) {
      await ctx.reply("Uso: /signal BTC/USDT 15m");
      return;
    }
    try {
      await ctx.replyWithChatAction("typing");
      if (isAllTimeframes(req.timeframe)) {
        const out = await handleMulti(req);
        await ctx.reply(out);
        return;
      }
      const r = await handleOne(req);
      await ctx.reply(r.text);
      logAprendizaje(
        `Señal: ${req.symbol} ${req.timeframe} (${req.exchange})`,
        `Decisión estratégica: side=${r.signal?.side ?? "N/A"} confidence=${r.signal?.model?.confidence ?? r.signal?.confidence ?? "N/A"} entry=${r.signal?.entry ?? "N/A"} sl=${r.signal?.sl ?? "N/A"} tp=${r.signal?.tp ?? "N/A"}.`
      );
      await maybeOpenPaper(ctx, r.signal, r.data, "signal");
    } catch (e) {
      logAprendizaje(
        `Señal: error para ${req.symbol} ${req.timeframe} (${req.exchange})`,
        `Se capturó el error y se devolvió mensaje al usuario.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
      );
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("multi", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/multi(@\w+)?/i, "").trim();
    const req = parseMultiRequest(args);
    if (!req.symbol) {
      await ctx.reply("Uso: /multi BTC/USDT");
      return;
    }
    try {
      await ctx.replyWithChatAction("typing");
      const out = await handleMulti(req);
      await ctx.reply(out);
    } catch (e) {
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("scan", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/scan(@\w+)?/i, "").trim();
    const parts = args.split(/\s+/).filter(Boolean);
    const timeframe = parts[0] ?? "15m";
    const maxResults = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 10;
    const exchange = parts[2] ? String(parts[2]).trim().toLowerCase() : "binance";
    const market = parts[3] ? String(parts[3]).trim().toLowerCase() : "spot";
    const quote = String(parts[4] ?? "USDT").trim().toUpperCase() || "USDT";

    const safeMax = Math.max(1, Math.min(20, Math.floor(maxResults)));

    try {
      await ctx.replyWithChatAction("typing");
      if (isAllTimeframes(timeframe)) {
        const tfs = getDefaultTimeframes();
        const chunks = [];
        const wisdom = await readWisdomEntries({ last: 6 });
        for (const tf of tfs) {
          const scan = await scanSignalsParallel({
            exchange,
            timeframe: tf,
            quote: "USDT",
            maxSymbols: 25,
            maxResults: Math.min(3, safeMax),
            chunkSize: scanConcurrent,
            pauseMs: scanChunkDelayMs,
            market
          });
          const f = filtrarPorSabiduria({ signals: scan.results, wisdomEntries: wisdom.entries });
          const out = { ...scan, results: f.kept };
          const tag = f.blockedSymbols.length ? `\n🧠 Sabiduría: descartadas ${f.blockedSymbols.length}` : "";
          chunks.push(formatScanMessage(out) + tag);
        }
        await ctx.reply(chunks.join("\n\n"));
        return;
      }

      const scan = await scanSignalsParallel({
        exchange,
        timeframe,
        quote,
        maxSymbols: market === "spot" ? 40 : 60,
        maxResults: safeMax,
        chunkSize: scanConcurrent,
        pauseMs: scanChunkDelayMs,
        market
      });
      const wisdom = await readWisdomEntries({ last: 6 });
      const f = filtrarPorSabiduria({ signals: scan.results, wisdomEntries: wisdom.entries });
      const out = { ...scan, results: f.kept };
      await ctx.reply(formatScanMessage(out));
      if (f.blockedSymbols.length) {
        await ctx.reply(`🧠 Sabiduría: descartadas ${f.blockedSymbols.length}: ${f.blockedSymbols.join(", ")}`);
      }
      const top = out.results?.[0];
      if (top) {
        logAprendizaje(
          `Scan: top ${top.symbol} ${timeframe} (${exchange} ${market})`,
          `Decisión estratégica: ranking por scanSignals. side=${top.side} roi=${top.roi} sharpe=${top.sharpe} confidence=${top.model?.confidence ?? "N/A"}.`
        );
      }
    } catch (e) {
      logAprendizaje(
        `Scan: error (${exchange} ${market}) tf=${timeframe}`,
        `Se capturó el error y se devolvió mensaje al usuario.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
      );
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.command("scanf", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/scanf(@\w+)?/i, "").trim();
    const parts = args.split(/\s+/).filter(Boolean);
    const timeframe = parts[0] ?? "15m";
    const maxResults = Number.isFinite(Number(parts[1])) ? Number(parts[1]) : 10;
    const exchange = parts[2] ? String(parts[2]).trim().toLowerCase() : "binanceusdm";
    const quote = String(parts[3] ?? "USDT").trim().toUpperCase() || "USDT";
    const safeMax = Math.max(1, Math.min(20, Math.floor(maxResults)));

    try {
      await ctx.replyWithChatAction("typing");
      const scan = await scanSignalsParallel({
        exchange,
        timeframe,
        quote,
        maxSymbols: 60,
        maxResults: safeMax,
        chunkSize: scanConcurrent,
        pauseMs: scanChunkDelayMs,
        market: "futures",
        sortBy: "roi"
      });
      const wisdom = await readWisdomEntries({ last: 6 });
      const f = filtrarPorSabiduria({ signals: scan.results, wisdomEntries: wisdom.entries });
      const out = { ...scan, results: f.kept };
      await ctx.reply(formatScanMessage(out));
      if (f.blockedSymbols.length) {
        await ctx.reply(`🧠 Sabiduría: descartadas ${f.blockedSymbols.length}: ${f.blockedSymbols.join(", ")}`);
      }
      const top = out.results?.[0];
      if (top) {
        logAprendizaje(
          `ScanF: top ${top.symbol} ${timeframe} (${exchange} futures)`,
          `Decisión estratégica: ranking por ROI en futuros. side=${top.side} roi=${top.roi} sharpe=${top.sharpe} confidence=${top.model?.confidence ?? "N/A"}.`
        );
      }
    } catch (e) {
      logAprendizaje(
        `ScanF: error (${exchange}) tf=${timeframe}`,
        `Se capturó el error y se devolvió mensaje al usuario.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
      );
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  bot.on("text", async (ctx) => {
    const text = ctx.message?.text ?? "";
    if (!text) return;
    if (text.trim().startsWith("/")) return;

    const req = parseSignalRequest(text);
    if (!req.symbol || !req.timeframe) return;

    try {
      await ctx.replyWithChatAction("typing");
      if (isAllTimeframes(req.timeframe)) {
        const out = await handleMulti(req);
        await ctx.reply(out);
        return;
      }
      const r = await handleOne(req);
      await ctx.reply(r.text);
      logAprendizaje(
        `Señal (texto): ${req.symbol} ${req.timeframe} (${req.exchange})`,
        `Decisión estratégica: side=${r.signal?.side ?? "N/A"} confidence=${r.signal?.model?.confidence ?? r.signal?.confidence ?? "N/A"} entry=${r.signal?.entry ?? "N/A"} sl=${r.signal?.sl ?? "N/A"} tp=${r.signal?.tp ?? "N/A"}.`
      );
      await maybeOpenPaper(ctx, r.signal, r.data, "text");
    } catch (e) {
      logAprendizaje(
        `Señal (texto): error para ${req.symbol} ${req.timeframe} (${req.exchange})`,
        `Se capturó el error y se devolvió mensaje al usuario.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
      );
      await ctx.reply(`Error: ${e?.message ?? String(e)}`);
    }
  });

  await bootLog();
  await bot.launch();
  const weeklyEnabled = !["0", "false", "off", "no"].includes(
    String(process.env.WEEKLY_REPORT_ENABLED ?? "1").trim().toLowerCase()
  );
  const weeklyCron = String(process.env.WEEKLY_REPORT_CRON ?? "0 20 * * 0").trim() || "0 20 * * 0";
  const weeklyTz = String(process.env.WEEKLY_REPORT_TZ ?? "America/Santiago").trim() || "America/Santiago";
  const weeklyDays = Number.isFinite(Number(process.env.WEEKLY_REPORT_DAYS)) ? Number(process.env.WEEKLY_REPORT_DAYS) : 7;
  const weeklyTask =
    weeklyEnabled && adminChatId && Number.isFinite(adminChatId)
      ? cron.schedule(
          weeklyCron,
          async () => {
            try {
              process.stdout.write("Enviando reporte semanal automático...\n");
              const rep = await generarReporteSemanal({ days: weeklyDays });
              await bot.telegram.sendMessage(adminChatId, rep.text, { parse_mode: "Markdown" });
            } catch (e) {
              await notifyAdmin(`Reporte semanal: error\n${e?.message ?? String(e)}`);
            }
          },
          { timezone: weeklyTz }
        )
      : null;

  async function obtenerStatsSemana({ now, days } = {}) {
    const d = now instanceof Date ? now : new Date();
    const windowDays = Number.isFinite(Number(days)) ? Math.max(1, Math.min(60, Math.floor(Number(days)))) : 7;
    const from = new Date(d.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const hist = await loadTradeHistory();
    const items = Array.isArray(hist.items) ? hist.items : [];
    const trades = items.filter((t) => {
      const ts = Date.parse(String(t?.fecha ?? ""));
      return Number.isFinite(ts) && ts >= from.getTime();
    });
    const ganadores = trades.filter((t) => Number(t?.pnl_num) > 0).length;
    const winRate = trades.length ? (ganadores / trades.length) * 100 : 0;
    return { count: trades.length, winRate };
  }

  const autoTuneEnabled = !["0", "false", "off", "no"].includes(
    String(process.env.AUTO_TUNE_ENABLED ?? "1").trim().toLowerCase()
  );
  const autoTuneCron = String(process.env.AUTO_TUNE_CRON ?? "5 20 * * 0").trim() || "5 20 * * 0";
  const autoTuneTz = String(process.env.AUTO_TUNE_TZ ?? weeklyTz).trim() || weeklyTz;
  const autoTuneTask =
    autoTuneEnabled && adminChatId && Number.isFinite(adminChatId)
      ? cron.schedule(
          autoTuneCron,
          async () => {
            try {
              const stats = await obtenerStatsSemana({ days: weeklyDays });
              if (!stats.count) {
                await notifyAdmin("Autonomía: sin operaciones recientes; no se ajusta minConfidence.");
                return;
              }

              const mem = await loadMemory();
              const alerts = mem?.config?.alerts && typeof mem.config.alerts === "object" ? mem.config.alerts : {};
              const chatIds = Object.keys(alerts);
              let touched = 0;
              let updated = 0;
              let direction = "estable";
              for (const chatIdStr of chatIds) {
                const chatId = Number(chatIdStr);
                if (!Number.isFinite(chatId)) continue;
                const cfg = await getAlertsConfig(chatId);
                if (!cfg || !cfg.enabled) continue;
                const cur = Number.isFinite(Number(cfg.minConfidence)) ? Number(cfg.minConfidence) : alertsMinConfidence;
                let next = cur;
                if (stats.winRate < 45) {
                  next = Math.min(0.95, cur + 0.05);
                  direction = "subiendo";
                } else if (stats.winRate > 65) {
                  next = Math.max(0.55, cur - 0.02);
                  direction = "bajando";
                }
                touched += 1;
                if (Math.abs(next - cur) < 1e-9) continue;
                await upsertAlertsConfig(chatId, { minConfidence: next });
                updated += 1;
              }

              const minConfTxt = updated ? `${direction} el filtro` : "manteniendo el filtro";
              await notifyAdmin(
                `Autonomía: ${minConfTxt}. winRate=${stats.winRate.toFixed(1)}% trades=${stats.count} chats=${touched} actualizados=${updated}.`
              );
            } catch (e) {
              await notifyAdmin(`Autonomía: error en auto-ajuste\n${e?.message ?? String(e)}`);
            }
          },
          { timezone: autoTuneTz }
        )
      : null;

  const stop = (signal) => {
    try {
      if (weeklyTask) weeklyTask.stop();
      if (autoTuneTask) autoTuneTask.stop();
      bot.stop(signal);
    } catch {
    }
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  setInterval(() => {
    monitorPaperPositions().catch(() => {});
  }, 25_000);
  setInterval(() => {
    runAlertsOnce().catch(() => {});
  }, 60_000);
  runAlertsOnce().catch(() => {});
}

main().catch(async (e) => {
  process.stderr.write(`${e?.message ?? String(e)}\n`);
  try {
    await registrar_aprendizaje(
      "Fallo fatal en main()",
      `Se registró el error fatal antes de terminar el proceso.\n\nDetalle técnico:\n${e?.stack ?? e?.message ?? String(e)}`
    );
  } catch {
  }
  process.exit(1);
});
