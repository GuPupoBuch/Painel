import { defineConfig } from "@playwright/test";

// Servidor estático em Node (sem depender de Python): serve a raiz do repositório só em 127.0.0.1:4173.
// O código vai em base64 no comando para não depender das regras de aspas do shell (cmd no Windows, sh no Linux/macOS).
const STATIC_SERVER = `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = process.cwd();
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(4173, '127.0.0.1');
`;
const staticServerCommand = `node -e "eval(Buffer.from('${Buffer.from(STATIC_SERVER).toString("base64")}','base64').toString())"`;

export default defineConfig({
  testDir: "tests",
  timeout: 90000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    { command: "node tests/mock-okx.mjs", url: "http://127.0.0.1:8788/__health", reuseExistingServer: false, timeout: 20000 },
    { command: "bash tests/serve-painel.sh", url: "http://127.0.0.1:8000/health", reuseExistingServer: false, timeout: 30000 },
    { command: staticServerCommand, url: "http://127.0.0.1:4173/index.html", reuseExistingServer: false, timeout: 20000 },
  ],
});
