// Health-check e2e with a fully local closed loop:
//   a mock proxy (node:http) receives absolute-form requests for
//   http://proxy.test:PORT/health and answers 200 / 500 per a mode flag.
// Sequence:
//   1. apply() with proxyUrl -> mock proxy healthy  -> state "ok", failures 0
//   2. mock proxy answers 500 -> 3 consecutive failures -> state "broken"
//   3. mock proxy answers 200 again -> recovers -> state "ok", failures 0
// Also asserts the /dsh-proxy/status endpoint payload shape.
// Run:  node test/health-check.mjs   (OUTF env var optional for result dump)
import { createServer } from "node:http";
import fs from "node:fs";

const logs = [];
let nsValue = null;
let watchCb = null;

const mockSettings = {
  register(ns, schema, options) {
    logs.push(`REGISTER ${ns}`);
    return {
      get: () => nsValue,
      watch: (cb) => {
        watchCb = cb;
        return () => {};
      },
      update: () => {},
      replace: () => {},
    };
  },
};

// ---- mock proxy ----
let proxyMode = "ok"; // "ok" | "fail"
const proxy = createServer((req, res) => {
  if (proxyMode === "ok") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("PASS");
  } else {
    res.writeHead(500);
    res.end("FAIL");
  }
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = proxy.address().port;

let statusHandler = null;
const mockWebServer = {
  register(route) {
    if (route.path === "/dsh-proxy/status") statusHandler = route.handler;
    return () => {};
  },
};

const ctx = {
  logger: {
    info: (...a) => logs.push("INFO " + a.join(" ")),
    warn: (...a) => logs.push("WARN " + a.join(" ")),
  },
  get: (name) => (name === "webServer" ? mockWebServer : void 0),
  inject: (deps, cb) =>
    cb({
      settings: mockSettings,
      effect: () => () => {},
      fiber: { state: 0 },
    }),
  effect: () => () => {},
  fiber: { state: 0 },
};

const m = await import("@dsh-external/dsh-proxy");
const CONFIG = {
  proxyUrl: `http://127.0.0.1:${proxyPort}`,
  noProxy: "127.0.0.1,localhost",
  healthCheckEnabled: true,
  healthCheckUrl: `http://proxy.test:${proxyPort}/health`,
  healthCheckInterval: 0.3,
  healthCheckFailures: 3,
  healthCheckFirstDelayMs: 100, // internal test hook: skip the 5s grace
};
// installSettingsSection attaches the settings scope as the source once the
// service mounts; mirror the config so the attached scope resolves the same
// values (the real service merges schema defaults + base, so this matches
// production behavior).
nsValue = { ...CONFIG };
m.apply(ctx, CONFIG);

const readStatus = () => {
  let code = 0;
  let body = null;
  statusHandler(
    {},
    {
      writeHead: (c) => {
        code = c;
      },
      end: (b) => {
        body = b;
      },
    },
  );
  return { code, json: JSON.parse(body) };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
};
const summarize = (s) =>
  `state=${s.state} failures=${s.failures}/${s.threshold} lastError=${s.lastError}`;

// 1. healthy proxy -> ok
await sleep(1100);
const s1 = readStatus();
assert(s1.code === 200, `status endpoint should answer 200 (got ${s1.code})`);
assert(s1.json.state === "ok", `step1 state=ok (${summarize(s1.json)})`);
assert(s1.json.failures === 0, `step1 failures=0 (${summarize(s1.json)})`);
assert(s1.json.proxyUrl === `http://127.0.0.1:${proxyPort}`, "proxyUrl reported");
assert(s1.json.checkUrl === `http://proxy.test:${proxyPort}/health`, "checkUrl reported");
assert(s1.json.threshold === 3, "threshold reported");
assert(typeof s1.json.lastCheck === "string" && s1.json.lastCheck.length > 0, "lastCheck reported");

// 2. proxy starts failing -> 3 consecutive failures -> broken
proxyMode = "fail";
await sleep(1800);
const s2 = readStatus();
assert(s2.json.state === "broken", `step2 state=broken (${summarize(s2.json)})`);
assert(s2.json.failures >= 3, `step2 failures>=3 (${summarize(s2.json)})`);
assert((s2.json.lastError ?? "").length > 0, "step2 lastError present");

// 3. proxy recovers -> ok, counter reset
proxyMode = "ok";
await sleep(1400);
const s3 = readStatus();
assert(s3.json.state === "ok", `step3 state=ok (${summarize(s3.json)})`);
assert(s3.json.failures === 0, `step3 failures=0 (${summarize(s3.json)})`);
assert(s3.json.lastError === null, "step3 lastError cleared");

// 4. disabled -> idle
nsValue = { ...CONFIG, healthCheckEnabled: false };
m.apply(ctx, { ...CONFIG, healthCheckEnabled: false });
await sleep(300);
const s4 = readStatus();
assert(s4.json.state === "idle", `step4 state=idle (${summarize(s4.json)})`);
assert(s4.json.enabled === false, "step4 enabled=false");

// 5. hot-reload regression: settings watcher fires with a NEW proxy -> the
// global dispatcher must re-route immediately (same chain as hot-reload.mjs).
const proxy2 = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("NEW");
});
await new Promise((resolve) => proxy2.listen(0, "127.0.0.1", resolve));
const proxy2Port = proxy2.address().port;
nsValue = {
  ...CONFIG,
  proxyUrl: `http://127.0.0.1:${proxy2Port}`,
  healthCheckUrl: `http://proxy.test:${proxy2Port}/health`,
};
watchCb(); // runtime settings change
const step5 = await fetch("http://example.com/").then((r) => r.text());
assert(step5 === "NEW", `step5 fetch routed through the new proxy (got "${step5}")`);
await sleep(500);
const s5 = readStatus();
assert(s5.json.state === "ok", `step5 state=ok after switch (${summarize(s5.json)})`);
assert(s5.json.proxyUrl === `http://127.0.0.1:${proxy2Port}`, "step5 proxyUrl updated");
proxy2.close();

const result = { s1: s1.json, s2: s2.json, s3: s3.json, s4: s4.json, s5: s5.json, step5, logs };
const text = JSON.stringify(result, null, 2);
if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, text);
console.log(text);
proxy.close();
console.log("HEALTH-CHECK: ALL PASSED");
process.exit(0);
