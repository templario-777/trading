import { proxy } from "../../_proxy.js";

export async function onRequestGet(context) {
  const u = new URL(context.request.url);
  const qs = u.searchParams.toString();
  return await proxy({
    request: context.request,
    env: context.env,
    method: "GET",
    path: "/api/paper/trades",
    queryString: qs
  });
}

