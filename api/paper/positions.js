import { proxyJson } from "../_proxy.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("allow", "GET");
    res.end();
    return;
  }
  await proxyJson({ req, res, method: "GET", path: "/api/paper/positions" });
}

