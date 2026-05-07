import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startServer } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const artifacts = path.join(__dirname, "artifacts");
const scenarioPath = resolveScenarioPath(process.argv[2] ?? "scenarios/ctrl-c-exit.json");
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const browserUserProfile = process.env.USERPROFILE ?? "";

if (process.env.CTXPARTY_E2E_BROWSER !== "1") {
  console.log("skip: set CTXPARTY_E2E_BROWSER=1 to run browser-terminal E2E");
  process.exit(0);
}

fs.mkdirSync(artifacts, { recursive: true });

let harness;
let browser;
const diagnostics = [];
try {
  harness = await startServer({
    args: scenario.args ?? [],
    cwd: root,
    env: Object.fromEntries(Object.entries(scenario.env ?? {}).map(([key, value]) => [key, String(value)])),
  });
  browser = await chromium.launch({
    headless: process.env.AGENT_BROWSER_HEADED !== "1",
    executablePath: findChromeExecutable(),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (message) => diagnostics.push({ type: "console", level: message.type(), text: message.text() }));
  page.on("pageerror", (error) => diagnostics.push({ type: "pageerror", text: error.stack ?? error.message }));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    const pathname = new URL(request.url()).pathname;
    if (failure === "net::ERR_ABORTED" && (pathname === "/type" || pathname === "/resize")) return;
    diagnostics.push({ type: "requestfailed", url: request.url(), failure });
  });
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#wterm")?.children.length > 0);
  await page.locator("#wterm").focus();
  await assertTerminalSurface(page, "initial");

  const ok = await runSteps(page, harness);
  process.exitCode = ok ? 0 : 1;
} finally {
  if (diagnostics.length > 0) {
    fs.writeFileSync(path.join(artifacts, `${scenario.name}-browser-diagnostics.json`), JSON.stringify(diagnostics, null, 2));
  }
  await closeWithTimeout("browser", () => browser?.close(), 5000);
  await closeWithTimeout("harness", () => harness?.close(), 3000);
}

process.exit(process.exitCode ?? 0);

async function runSteps(page, harness) {
  for (const step of scenario.steps ?? []) {
    if (step.type) {
      await page.keyboard.type(step.type, { delay: Number(process.env.CTXPARTY_E2E_TYPE_DELAY_MS ?? 40) });
    }
    if (step.press) {
      await page.keyboard.press(step.press);
    }
    if (step.pressSequence) {
      const delayMs = Number(step.delayMs ?? 0);
      for (const key of step.pressSequence) {
        await page.keyboard.press(key);
        if (delayMs > 0) {
          await page.waitForTimeout(delayMs);
        }
      }
    }
    if (step.waitMs) {
      await page.waitForTimeout(Number(step.waitMs));
    }
    if (step.expectRunning) {
      const running = await assertRunning(harness, step.name);
      await writeArtifacts(page, harness, step.name);
      if (!running) return false;
    }
    if (step.expectExit) {
      const exited = await waitForExit(harness, step.name);
      await writeArtifacts(page, harness, step.name);
      if (!exited) return false;
      continue;
    }
    const ok = await waitForMarkers(page, harness, step.expect ?? [], step.name);
    if (!ok) return false;
  }
  await writeArtifacts(page, harness, "final");
  return true;
}

async function assertRunning(harness, label) {
  const state = await fetchJson(`${harness.url}/process`);
  fs.writeFileSync(path.join(artifacts, `${scenario.name}-${label}-process.json`), JSON.stringify(state, null, 2));
  if (state.exited) {
    console.error(`failed: process exited unexpectedly for ${label}`);
    return false;
  }
  return true;
}

async function waitForMarkers(page, harness, markers, label) {
  const deadline = Date.now() + (scenario.timeoutMs ?? 30000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const snapshot = await page.locator("#wterm").innerText();
    if (containsOrdered(snapshot, markers)) {
      await assertTerminalSurface(page, label);
      await writeArtifacts(page, harness, label);
      return true;
    }
  }
  await writeArtifacts(page, harness, label);
  console.error(`failed: missing markers for ${label}: ${markers.join(" -> ")}`);
  return false;
}

async function waitForExit(harness, label) {
  const deadline = Date.now() + (scenario.timeoutMs ?? 30000);
  let state = {};
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = await fetchJson(`${harness.url}/process`);
    if (state.exited) {
      fs.writeFileSync(path.join(artifacts, `${scenario.name}-${label}-process.json`), JSON.stringify(state, null, 2));
      return true;
    }
  }
  fs.writeFileSync(path.join(artifacts, `${scenario.name}-${label}-process.json`), JSON.stringify(state, null, 2));
  console.error(`failed: process did not exit for ${label}`);
  return false;
}

async function writeArtifacts(page, harness, label) {
  fs.writeFileSync(path.join(artifacts, `${scenario.name}-${label}-snapshot.txt`), await page.locator("#wterm").innerText());
  fs.writeFileSync(path.join(artifacts, `${scenario.name}-${label}-terminal.txt`), await fetchText(`${harness.url}/snapshot`));
  fs.writeFileSync(
    path.join(artifacts, `${scenario.name}-${label}-input-log.json`),
    JSON.stringify(await page.evaluate(() => globalThis.__wtermInputLog ?? []), null, 2),
  );
  await page.screenshot({ path: path.join(artifacts, `${scenario.name}-${label}-screenshot.png`), fullPage: true });
}

async function assertTerminalSurface(page, label) {
  const metrics = await page.evaluate(() => {
    const host = document.getElementById("wterm");
    const fallback = document.getElementById("terminal");
    const hostBox = host?.getBoundingClientRect();
    const fallbackBox = fallback?.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      host: hostBox ? { width: hostBox.width, height: hostBox.height, childCount: host.children.length } : null,
      fallback: fallbackBox ? { left: fallbackBox.left } : null,
    };
  });
  fs.writeFileSync(path.join(artifacts, `${scenario.name}-${label}-layout.json`), JSON.stringify(metrics, null, 2));
  if (!metrics.host || metrics.host.childCount === 0) {
    throw new Error("WTerm did not initialize");
  }
  if (metrics.host.width < (metrics.viewport.width - 32) * 0.95) {
    throw new Error("WTerm is not filling the browser terminal surface");
  }
  if (metrics.fallback?.left > -1000) {
    throw new Error("Fallback terminal is visible; WTerm is not primary");
  }
}

function containsOrdered(text, markers) {
  let offset = 0;
  for (const marker of markers) {
    const idx = text.indexOf(marker, offset);
    if (idx < 0) return false;
    offset = idx + marker.length;
  }
  return true;
}

function findChromeExecutable() {
  if (process.env.AGENT_BROWSER_EXECUTABLE_PATH) return process.env.AGENT_BROWSER_EXECUTABLE_PATH;
  if (process.platform !== "win32") return undefined;
  const browsersDir = path.join(browserUserProfile, ".agent-browser", "browsers");
  const candidates = fs.existsSync(browsersDir)
    ? fs.readdirSync(browsersDir)
        .filter((name) => name.startsWith("chrome-"))
        .sort()
        .reverse()
        .map((name) => path.join(browsersDir, name, "chrome.exe"))
    : [];
  const chrome = candidates.find((candidate) => fs.existsSync(candidate));
  if (!chrome) {
    throw new Error("Chrome is not installed; run npx --prefix e2e/browser-terminal agent-browser install");
  }
  return chrome;
}

function resolveScenarioPath(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  const fromCwd = path.resolve(filePath);
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.resolve(__dirname, filePath);
}

async function fetchText(url) {
  return await fetch(url).then((response) => response.text());
}

async function fetchJson(url) {
  return await fetch(url).then((response) => response.json());
}

async function closeWithTimeout(label, close, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      close?.(),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          console.warn(`warning: timed out while closing ${label}`);
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
