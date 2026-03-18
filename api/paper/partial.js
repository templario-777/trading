import { json, readBody, proxyJson } from "../_proxy.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end();
    return;
  }
  try {
    const body = (await readBody(req)) ?? {};
    await proxyJson({ req, res, method: "POST", path: "/api/paper/partial", body });
  } catch (e) {
    const msg = e?.message ?? String(e);
    json(res, msg === "body_too_large" ? 413 : 500, { error: "server_error", message: msg });
  }
}

