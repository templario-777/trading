function getEnv(name) {
  const v = process.env[name];
  return v ? String(v).trim() : "";
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body ?? null));
}

async function readBody(req, limitBytes = 1_000_000) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildUpstreamUrl(path, query = "") {
  const base = getEnv("BOT_API_BASE_URL").replace(/\/+$/, "");
  if (!base) return "";
  const qs = query ? (query.startsWith("?") ? query : `?${query}`) : "";
  return `${base}${path}${qs}`;
}

async function proxyJson({ req, res, method, path, body, query }) {
  const upstream = buildUpstreamUrl(path, query);
  if (!upstream) {
    json(res, 500, { error: "missing_env", env: "BOT_API_BASE_URL" });
    return;
  }
  const key = getEnv("BOT_API_KEY");
  if (!key) {
    json(res, 500, { error: "missing_env", env: "BOT_API_KEY" });
    return;
  }

  const upstreamRes = await fetch(upstream, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const contentType = String(upstreamRes.headers.get("content-type") ?? "application/json");
  const text = await upstreamRes.text();
  
  if (!upstreamRes.ok && !contentType.includes("json")) {
    json(res, upstreamRes.status, { error: "upstream_error", status: upstreamRes.status, message: text.slice(0, 200) });
    return;
  }

  res.statusCode = upstreamRes.status;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

export { json, readBody, proxyJson };

