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
  return new Response(file, { headers: { "content-type": contentType(path) } });
}
