import { proxy } from "../_proxy.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  return await proxy({ request: context.request, env: context.env, method: "GET", path: "/api/engrams", queryString: url.search });
}
