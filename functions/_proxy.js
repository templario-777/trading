function envGet(env, name) {
  const v = env?.[name];
  return v ? String(v).trim() : "";
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj ?? null), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      ...headers
    }
  });
}

async function readJson(request, limitBytes = 1_000_000) {
  const txt = await request.text();
  if (!txt) return null;
  if (txt.length > limitBytes) throw new Error("body_too_large");
  return JSON.parse(txt);
}

function buildUpstreamUrl(env, path, queryString) {
  let base = envGet(env, "BOT_API_BASE_URL").replace(/\/+$/, "");
  
  // Auto-correction: Use the Cloudflare Tunnel hostname if available or raw IP is used
  if (!base || base.includes("161.35.107.114")) {
    base = "https://api.aetherconnectlabs.software";
  }

  const qs = queryString ? (queryString.startsWith("?") ? queryString : `?${queryString}`) : "";
  return `${base}${path}${qs}`;
}

async function proxy({ request, env, method, path, body, queryString }) {
  const upstream = buildUpstreamUrl(env, path, queryString);
  if (!upstream) return json({ error: "missing_env", env: "BOT_API_BASE_URL" }, 500);
  
  // Prioritize Authorization from the browser, fallback to env
  let auth = request.headers.get("authorization");
  if (!auth) {
    const key = envGet(env, "BOT_API_KEY") || "AETHER_2026";
    auth = `Bearer ${key}`;
  }

  const upstreamRes = await fetch(upstream, {
    method,
    headers: {
      authorization: auth,
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const contentType = upstreamRes.headers.get("content-type") ?? "application/json; charset=utf-8";
  const text = await upstreamRes.text();
  
  if (!upstreamRes.ok && !contentType.includes("json")) {
    return json({ error: "upstream_error", status: upstreamRes.status, message: text.slice(0, 200) }, upstreamRes.status);
  }

  return new Response(text, {
    status: upstreamRes.status,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type"
    }
  });
}

export { json, readJson, proxy };

