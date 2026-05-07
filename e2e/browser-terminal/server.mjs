import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const nodeModules = path.join(__dirname, "node_modules");

export async function startServer({
  args = [],
  env = {},
  cwd = root,
  port = Number(process.env.CTXPARTY_E2E_PORT ?? 0),
  ptyFactory = spawnPty,
}) {
  const pty = await ptyFactory({ args, cwd, env });
  let transcript = "";
  let exit = { exited: false, exitCode: undefined, signal: undefined };
  const clients = new Set();

  pty.onData((data) => {
    transcript += data;
    const payload = JSON.stringify({ data });
    for (const res of clients) {
      res.write(`data: ${payload}\n\n`);
    }
  });

  pty.onExit?.((event) => {
    exit = { exited: true, exitCode: event.exitCode, signal: event.signal };
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/snapshot") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(transcript);
      return;
    }
    if (url.pathname === "/process") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(exit));
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ data: transcript })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/type") {
      pty.write(url.searchParams.get("text") ?? "");
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/resize") {
      const cols = Number(url.searchParams.get("cols"));
      const rows = Number(url.searchParams.get("rows"));
      if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
        pty.resize(Math.floor(cols), Math.floor(rows));
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (serveNodeModule(url.pathname, res)) {
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(pageHtml());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    pty,
    server,
    async close() {
      if (!exit.exited) {
        pty.write("\x03");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!exit.exited) {
        pty.kill?.();
      }
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 1000);
        server.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

async function spawnPty({ args, cwd, env }) {
  const { spawn } = await import("node-pty");
  return spawn(process.execPath, [path.join(root, "src", "cli.js"), ...args], {
    name: "xterm-256color",
    cols: 120,
    rows: 36,
    cwd,
    env: { ...process.env, ...env },
  });
}

function serveNodeModule(urlPath, res) {
  const prefix = "/node_modules/";
  if (!urlPath.startsWith(prefix)) return false;
  const relative = decodeURIComponent(urlPath.slice(prefix.length));
  const filePath = path.resolve(nodeModules, relative);
  if (!filePath.startsWith(nodeModules) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return true;
  }
  const ext = path.extname(filePath);
  const contentType = ext === ".css"
    ? "text/css; charset=utf-8"
    : ext === ".js"
      ? "text/javascript; charset=utf-8"
      : "application/octet-stream";
  res.writeHead(200, { "content-type": contentType });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function pageHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ctxparty e2e</title>
  <link rel="stylesheet" href="/node_modules/@wterm/dom/src/terminal.css">
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #101410; }
    body { display: grid; place-items: stretch; }
    main { min-width: 0; min-height: 0; padding: 16px; }
    #wterm { width: calc(100vw - 32px); height: calc(100vh - 32px); box-sizing: border-box; }
    #terminal { position: absolute; left: -10000px; top: 0; width: 1px; height: 1px; overflow: hidden; }
  </style>
  <script type="importmap">
    { "imports": { "@wterm/core": "/node_modules/@wterm/core/dist/index.js" } }
  </script>
</head>
<body>
  <main aria-label="terminal transcript">
    <div id="wterm" role="log" aria-label="wterm terminal transcript"></div>
    <pre id="terminal" role="log" aria-label="terminal transcript fallback"></pre>
  </main>
  <script type="module">
    import { WTerm } from "/node_modules/@wterm/dom/dist/index.js";

    const fallback = document.getElementById("terminal");
    const host = document.getElementById("wterm");
    let inputQueue = Promise.resolve();
    window.__wtermInputLog = [];
    window.__wtermOutputLog = [];
    const term = new WTerm(host, {
      cols: 120,
      rows: 36,
      cursorBlink: true,
      onResize(cols, rows) {
        fetch("/resize?cols=" + cols + "&rows=" + rows, { method: "POST" });
      },
      onData(data) {
        window.__wtermInputLog.push(data);
        sendInput(normalizeInputForPty(data));
      }
    });
    await term.init();
    term.focus();

    const events = new EventSource("/events");
    events.onmessage = (event) => {
      const { data } = JSON.parse(event.data);
      window.__wtermOutputLog.push({ at: performance.now(), length: data.length });
      fallback.textContent += data;
      term.write(data);
    };

    async function sendInput(text) {
      inputQueue = inputQueue.then(() => fetch("/type?text=" + encodeURIComponent(text), { method: "POST" }));
      await inputQueue;
    }

    function normalizeInputForPty(text) {
      return text.replaceAll(String.fromCharCode(27) + "[13;2u", String.fromCharCode(10));
    }
  </script>
</body>
</html>`;
}
