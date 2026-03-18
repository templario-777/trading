import { proxy } from "../_proxy.js";

export async function onRequestGet(context) {
  return await proxy({ request: context.request, env: context.env, method: "GET", path: "/health" });
}

