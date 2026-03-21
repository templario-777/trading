import { proxy } from "../../_proxy.js";

export async function onRequestPost(context) {
  const body = await context.request.json().catch(() => ({}));
  return await proxy({ request: context.request, env: context.env, method: "POST", path: "/api/paper/sync", body });
}
