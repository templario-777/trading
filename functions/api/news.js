import { json, proxy } from "../_proxy.js";

export async function onRequestGet(context) {
  try {
    const qs = new URL(context.request.url).searchParams.toString();
    return await proxy({
      request: context.request,
      env: context.env,
      method: "GET",
      path: "/api/news",
      queryString: qs
    });
  } catch (e) {
    const msg = e?.message ?? String(e);
    return json({ error: "server_error", message: msg }, 500);
  }
}
