#!/usr/bin/env node
// TEST ONLY. Evaluates an expression inside LabourLink's WebView on an
// emulator/debug build via the Chrome DevTools Protocol (debug builds have
// WebView debugging enabled; release builds don't, so this can't touch a
// production install).
//
//   node cdp.mjs <adb-serial> eval '<js expression, may return a promise>'
//   node cdp.mjs <adb-serial> navigate '<url>'
import { execFileSync } from "node:child_process";

const [serial, mode, arg] = process.argv.slice(2);
if (!serial || !mode) {
  console.error("usage: cdp.mjs <serial> eval|navigate <arg>");
  process.exit(2);
}
if (!serial.startsWith("emulator-")) {
  console.error("refusing: cdp.mjs only ever targets an emulator");
  process.exit(2);
}

const adb = (...a) => execFileSync("adb", ["-s", serial, ...a], { encoding: "utf8" });
const pid = adb("shell", "pidof", "com.linklogictechnologies.labourlink").trim().split(/\s+/)[0];
if (!pid) throw new Error("LabourLink is not running");
const port = 9300 + (Number(pid) % 500);
adb("forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.startsWith("https://localhost"));
if (!page) throw new Error("no LabourLink page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

let out;
if (mode === "eval") {
  const res = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) {
    console.error(JSON.stringify(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails));
    process.exit(1);
  }
  out = res.result?.result?.value;
} else if (mode === "navigate") {
  // Fire and forget — e.g. chrome://crash never answers.
  ws.send(JSON.stringify({ id: ++id, method: "Page.navigate", params: { url: arg } }));
  await new Promise((r) => setTimeout(r, 500));
  out = "sent";
}
console.log(typeof out === "string" ? out : JSON.stringify(out));
ws.close();
adb("forward", "--remove", `tcp:${port}`);
process.exit(0);
