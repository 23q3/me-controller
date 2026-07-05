// 静态文件服务。
import { extname, join, normalize, sep } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "public");

function contentType(path: string) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".ico") return "image/x-icon";
  if (ext === ".map") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export async function staticResponse(url: URL) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const path = join(PUBLIC_DIR, relative);
  // 必须带分隔符前缀比较：裸 startsWith 会放过 "public-evil" 这类同前缀兄弟目录
  if (path !== PUBLIC_DIR && !path.startsWith(PUBLIC_DIR + sep)) {
    return new Response("Forbidden", { status: 403 });
  }

  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });
  const headers: Record<string, string> = { "content-type": contentType(path) };
  // 物品图标 URL 带 ?v=构建版本参数,可以放心长缓存;item-index.json 不再长缓存
  // (前端实际走 /api/items,这里只是兜底)
  const itemsPrefix = join("generated", "items") + sep;
  if (relative.startsWith(itemsPrefix) || relative.startsWith("generated/items/")) {
    headers["cache-control"] = "public, max-age=86400";
  }
  return new Response(file, { headers });
}
