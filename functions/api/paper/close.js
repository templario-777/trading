import { json, readJson, proxy } from "../../_proxy.js";

export async function onRequestPost(context) {
  try {
    const body = (await readJson(context.request)) ?? {};
    return await proxy({ request: context.request, env: context.env, method: "POST", path: "/api/paper/close", body });
  } catch (e) {
    const msg = e?.message ?? String(e);
    return json({ error: "server_error", message: msg }, msg === "body_too_large" ? 413 : 500);
  }
}

