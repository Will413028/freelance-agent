import { NextRequest } from "next/server";

const upstream = process.env.FREELANCE_CONTAINER === "1" ? "http://api:8327" : "http://127.0.0.1:8327";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const host = request.headers.get("host");
  if (host !== "127.0.0.1:3327" && host !== "localhost:3327")
    return Response.json({ error: "本機工作台不接受外部存取" }, { status: 403 });
  const { path } = await context.params;
  const route = path.join("/");
  const application = /^applications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(route);
  const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const entity=new RegExp(`^(clients|contacts|proposal-templates|proposals|submissions)/${uuid}$`).test(route);
  const collections=['clients','contacts','proposal-templates','proposals','submissions'];
  const readWorkbench=['clients','proposal-templates','proposals','submissions','submission-capabilities'].includes(route)||entity||new RegExp(`^clients/${uuid}/contacts$`).test(route);
  const writeWorkbench=collections.includes(route)||route==='proposal-templates/preview'||new RegExp(`^(clients|contacts|proposal-templates|proposals)/${uuid}/archive$`).test(route)||new RegExp(`^proposals/${uuid}/(versions|template)$`).test(route)||new RegExp(`^applications/${uuid}/party$`).test(route)||new RegExp(`^submissions/${uuid}/(approve|dispatch|cancel|reconcile)$`).test(route);
  const allowed = request.method === "GET" ? ["dashboard", "digest", "applications", "applications/summary"].includes(route) || application
      || readWorkbench || /^opportunities\/(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(route)
    : request.method === "POST" ? route === "applications" || route === "preferences" || /^feedback\/(?:[a-f0-9]{24}|[a-f0-9]{64})$/.test(route)||writeWorkbench
    : request.method==='PATCH' ? application||new RegExp(`^(clients|contacts|proposal-templates)/${uuid}$`).test(route)
    : request.method==='DELETE'&&application;
  if (!allowed) return Response.json({ error: "找不到資源" }, { status: 404 });
  if (request.method !== "GET" && request.headers.get("origin") !== `http://${host}`)
    return Response.json({ error: "不允許的來源" }, { status: 403 });
  const body = request.method !== "GET" ? await request.text() : undefined;
  if (body && Buffer.byteLength(body) > 65536)
    return Response.json({ error: "內容超過限制" }, { status: 413 });
  try {
    const result = await fetch(`${upstream}/${route}${request.nextUrl.search}`, {
      method: request.method, body, cache: "no-store", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", Origin: `http://${host}` },
    });
    return new Response(await result.text(), { status: result.status, headers: {
      "Content-Type": result.headers.get("content-type") || "application/json",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "案件服務未啟動，請先啟動 Python API。" }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as DELETE };
