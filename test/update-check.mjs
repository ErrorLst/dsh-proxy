// Update-check e2e with a fully local closed loop:
//   a mock GitHub API (node:http) serving /tags and /releases/tags/<tag>,
//   a fake default model (ctx llm + agentDefaultModel mocks), and a state
//   file under a temp DSH_HOME.
// Sequence:
//   1. current 0.1.0-rc.7, tags only dsh-v0.1.0-rc.7 -> no update, endpoint
//      reports updateAvailable=false with the latest tag;
//   2. a newer tag dsh-v0.2.0-rc.1 appears -> update detected, the default
//      model composes the changelog, /dsh-proxy/update-status serves it, and
//      the state file records the summarized tag;
//   3. the next periodic run with the same tag -> the model is NOT called
//      again (persisted changelog reused);
//   4. updateCheckEnabled=false -> endpoint reports enabled=false.
// Run:  node test/update-check.mjs   (OUTF env var optional for result dump)
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// ---- mock GitHub API ----
const tags = ["dsh-v0.1.0-rc.7", "dsh-v0.1.0-rc.6"];
const releaseBodies = {
  "dsh-v0.2.0-rc.1": "## New Features\n- foo\n### Bug Fixes\n- bar",
};
const api = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/tags") {
    res.end(JSON.stringify(tags.map((name) => ({ name, commit: { sha: "abc123" } }))));
    return;
  }
  const match = url.pathname.match(/^\/releases\/tags\/(.+)$/);
  if (match) {
    const tag = decodeURIComponent(match[1]);
    if (releaseBodies[tag]) {
      res.end(JSON.stringify({ tag_name: tag, body: releaseBodies[tag] }));
      return;
    }
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ message: "not found" }));
});
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiPort = api.address().port;

// ---- temp DSH home for the persisted state ----
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-proxy-update-"));
process.env.DSH_HOME = tempHome;

let llmCalls = 0;
const fakeLlm = {
  stream: async function* (options) {
    llmCalls += 1;
    if (options.provider !== "test-provider" || options.model !== "test-model") {
      throw new Error(`unexpected route ${options.provider}/${options.model}`);
    }
    yield { type: "text-delta", text: "【更新日志】v0.2.0 修复若干问题。" };
    yield { type: "finish", reason: { kind: "stop" } };
  },
};
const fakeDefaultModel = {
  currentSelection: () => ({ provider: "test-provider", model: "test-model" }),
};

let statusHandler = null;
let updateStatusHandler = null;
const mockWebServer = {
  register(route) {
    if (route.path === "/dsh-proxy/status") statusHandler = route.handler;
    if (route.path === "/dsh-proxy/update-status") updateStatusHandler = route.handler;
    return () => {};
  },
};

const ctx = {
  logger: {
    info: (...a) => logs.push("INFO " + a.join(" ")),
    warn: (...a) => logs.push("WARN " + a.join(" ")),
  },
  get: (name) => {
    if (name === "webServer") return mockWebServer;
    if (name === "llm") return fakeLlm;
    if (name === "agentDefaultModel") return fakeDefaultModel;
    return void 0;
  },
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
  healthCheckEnabled: false, // keep the health machinery quiet
  updateCheckEnabled: true,
  updateCheckIntervalMinutes: 0.01, // 0.6s between periodic runs
  updateCheckFirstDelayMs: 50, // internal test hook: skip the 15s grace
  updateCheckApiBaseUrl: `http://127.0.0.1:${apiPort}`, // internal test hook
  updateCheckCurrentVersion: "0.1.0-rc.7", // internal test hook: fake install
};
nsValue = { ...CONFIG };
m.apply(ctx, CONFIG);

const readUpdateStatus = () => {
  let code = 0;
  let body = null;
  updateStatusHandler(
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

// 1. no newer tag -> updateAvailable=false, latest reported
await sleep(300);
let u1 = readUpdateStatus();
assert(u1.code === 200, `update-status should answer 200 (got ${u1.code})`);
assert(u1.json.enabled === true, "step1 enabled=true");
assert(typeof u1.json.bootId === "string" && u1.json.bootId.length > 0, "step1 bootId reported");
assert(u1.json.updateAvailable === false, "step1 no update yet");
assert(u1.json.currentVersion === "0.1.0-rc.7", "step1 currentVersion reported");
assert(u1.json.latestTag === "dsh-v0.1.0-rc.7", "step1 latestTag reported");
assert(llmCalls === 0, "step1 model not called without an update");

// 2. newer tag appears -> update, model composes the changelog
tags.unshift("dsh-v0.2.0-rc.1");
watchCb(); // settings change -> re-arm the check (first-delay hook fires soon)
await sleep(300);
const u2 = readUpdateStatus();
assert(u2.json.bootId === u1.json.bootId, "step2 bootId stable within one host run");
assert(u2.json.updateAvailable === true, "step2 update available");
assert(u2.json.latestTag === "dsh-v0.2.0-rc.1", "step2 latestTag reported");
assert(u2.json.latestVersion === "0.2.0-rc.1", "step2 latestVersion reported");
assert(u2.json.changelog === "【更新日志】v0.2.0 修复若干问题。", "step2 AI-composed changelog served");
assert(u2.json.releaseUrl === "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1", "step2 release url");
assert(llmCalls === 1, "step2 model called exactly once");

// state file recorded the summarized tag
const statePath = path.join(tempHome, "dsh-proxy", "state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
assert(state.lastSummarizedTag === "dsh-v0.2.0-rc.1", "step2 state file records the tag");
assert(state.lastChangelog === "【更新日志】v0.2.0 修复若干问题。", "step2 state file records the changelog");

// 3. next periodic run (0.6s) with the same tag -> changelog reused, no new model call
await sleep(900);
const u3 = readUpdateStatus();
assert(u3.json.updateAvailable === true, "step3 still update available");
assert(u3.json.changelog === "【更新日志】v0.2.0 修复若干问题。", "step3 changelog persisted");
assert(llmCalls === 1, "step3 model NOT called again for the same tag");

// 4. disabled -> endpoint reports enabled=false
nsValue = { ...CONFIG, updateCheckEnabled: false };
watchCb();
await sleep(150);
const u4 = readUpdateStatus();
assert(u4.json.enabled === false, "step4 enabled=false");

const result = {
  u1: u1.json,
  u2: u2.json,
  u3: u3.json,
  u4: u4.json,
  llmCalls,
  state,
  logs,
};
const text = JSON.stringify(result, null, 2);
if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, text);
console.log(text);
api.close();
fs.rmSync(tempHome, { recursive: true, force: true });
console.log("UPDATE-CHECK: ALL PASSED");
process.exit(0);
