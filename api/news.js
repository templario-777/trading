import { json, proxyJson } from "./_proxy.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return;
  }
  try {
    const url = new URL(req.url ?? "/api/news", "http://localhost");
    const query = url.searchParams.toString();
    await proxyJson({ req, res, method: "GET", path: "/api/news", query });
  } catch (e) {
    const msg = e?.message ?? String(e);
    json(res, 500, { error: "server_error", message: msg });
  }
}
