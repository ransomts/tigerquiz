// A small Chrome DevTools Protocol client, enough to drive a page and take a
// picture of it. Node 22+ has a WebSocket client built in, so this needs no
// dependencies — which is the point: the screenshots in docs/ can be recaptured
// on any machine with chromium and nothing else installed.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One tab, addressed over its own websocket. */
export class Tab {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("could not attach to the tab")), { once: true });
    });
  }

  send(method, params = {}, timeout = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeout}ms`));
      }, timeout);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve when `method` fires, or reject after `ms`. */
  once(method, ms = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), ms);
      const listener = (msg) => {
        if (msg.method !== method) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((l) => l !== listener);
        resolve(msg.params);
      };
      this.listeners.push(listener);
    });
  }

  async open(url, { width, height, scale = 2, mobile = false } = {}) {
    await this.ready;
    this.view = { width, height, deviceScaleFactor: scale, mobile };
    await this.send("Page.enable");
    await this.send("Emulation.setDeviceMetricsOverride", this.view);
    const loaded = this.once("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Run an expression in the page and return its value. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }

  /** Poll an expression until it is truthy, so a shot is never taken mid-render. */
  async until(expression, { ms = 15000, every = 100 } = {}) {
    const deadline = Date.now() + ms;
    let last = "";
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expression)) return;
      } catch (e) { last = ` (last error: ${e.message})`; }
      await sleep(every);
    }
    throw new Error(`gave up waiting for: ${expression}${last}`);
  }

  /**
   * A picture of the viewport, or of the whole page with `full`.
   *
   * Full-page means growing the viewport to fit and shrinking it back, rather
   * than captureBeyondViewport, which never returns on a page with a running
   * animation on it — the lobby, whose PIN pulses, hangs forever.
   */
  async shot(file, { full = false } = {}) {
    await this.front();
    const v = this.view;
    if (full && v) {
      const height = await this.eval(`Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)`);
      await this.send("Emulation.setDeviceMetricsOverride", { ...v, height: Math.min(height, 4000) });
      await new Promise((r) => setTimeout(r, 250));
    }
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    if (full && v) await this.send("Emulation.setDeviceMetricsOverride", v);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  /**
   * Make this the visible tab. Headless chrome only renders the foreground one:
   * a background tab produces no frames, so captureScreenshot waits forever, and
   * its timers are throttled, so its websocket falls behind the game.
   */
  async front() {
    await this.send("Page.bringToFront").catch(() => {});
  }

  /** Close the websocket, and the tab itself when it came from launch(). */
  async close() {
    this.ws.close();
    if (this.pageUrl) await fetch(this.pageUrl).catch(() => {});
  }
}

/**
 * Start a headless chromium and hand back a way to open tabs in it.
 *
 * The debugging port is picked per launch. A fixed one would silently attach to
 * a browser left running by an earlier go, and every tab would then be opened in
 * a process this one cannot see, close, or reason about.
 */
export async function launch({ binary = process.env.CHROME || "chromium", port } = {}) {
  port ||= 9300 + Math.floor(Math.random() * 600);
  const profile = await mkdtemp(path.join(tmpdir(), "tigerquiz-shots-"));
  const child = spawn(binary, [
    "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--force-device-scale-factor=1", "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank",
  ], { stdio: "ignore" });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`${binary} exited before it was ready`);
    try {
      await fetch(`${base}/json/version`);
      up = true;
      break;
    } catch { await sleep(100); }
  }
  if (!up) throw new Error(`${binary} never opened a debugging port on ${port}`);

  const tabs = [];
  return {
    async tab(url = "about:blank") {
      const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
      const { webSocketDebuggerUrl, id } = await r.json();
      const tab = new Tab(webSocketDebuggerUrl);
      tab.pageUrl = `${base}/json/close/${id}`;
      tabs.push({ tab, id });
      return tab;
    },
    async close() {
      for (const { tab, id } of tabs) {
        tab.ws.close();
        await fetch(`${base}/json/close/${id}`).catch(() => {});
      }
      child.kill("SIGKILL");
      await rm(profile, { recursive: true, force: true });
    },
  };
}
