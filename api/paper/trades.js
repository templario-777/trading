import { proxyJson } from "../_proxy.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return;
  }
  const raw = String(req.url ?? "");
  const q = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  await proxyJson({ req, res, method: "GET", path: "/api/paper/trades", query: q });
}

