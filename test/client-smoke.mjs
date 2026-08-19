// Client-half smoke test: load lib/client.js through a mock __ModuleLoader__,
// drive the health alarm through a mocked fetch/document, and assert the
// popup appears on "broken", does not re-pop while still broken, dismisses on
// the "知道了" button, and closes automatically when the proxy recovers.
const fs = await import("node:fs");

const elements = [];
function makeEl(tag) {
  return {
    tag,
    style: {},
    textContent: "",
    type: "",
    children: [],
    attrs: {},
    listeners: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    addEventListener(k, fn) {
      (this.listeners[k] ??= []).push(fn);
    },
    append(...kids) {
      this.children.push(...kids);
    },
    remove() {
      const i = elements.indexOf(this);
      if (i >= 0) elements.splice(i, 1);
    },
  };
}

globalThis.document = {
  body: {
    append(el) {
      elements.push(el);
    },
  },
  createElement: (tag) => makeEl(tag),
};

let fetchStatus = {
  state: "broken",
  failures: 3,
  threshold: 3,
  checkUrl: "https://www.google.com/generate_204",
  proxyUrl: "http://127.0.0.1:7890",
  lastCheck: new Date().toISOString(),
  lastError: "HTTP 500",
};
globalThis.fetch = async () => ({ ok: true, json: async () => fetchStatus });

let intervalCb = null;
globalThis.setInterval = (cb) => {
  intervalCb = cb;
  return 1;
};
globalThis.clearInterval = () => {};

let loadedDef = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loadedDef = def;
    },
  },
};

await import(new URL("../lib/client.js", import.meta.url).href);
const { inject, apply } = loadedDef.factory((name) => {
  if (name === "react") {
    return {
      useState: () => [null, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      createElement: () => null,
    };
  }
  throw new Error(`unexpected require("${name}")`);
});

const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
};

const ctx = {
  settingsScope: {
    bind: () => ({
      getSnapshot: () => ({ value: {}, revision: 0, writable: true }),
      subscribe: () => () => {},
      set: async () => {},
    }),
  },
  slots: {
    inject: () => {},
    register: () => {},
  },
  effect: () => () => {},
};
apply(ctx);

// 1. immediate poll sees "broken" -> popup appears
await new Promise((resolve) => setTimeout(resolve, 20));
assert(elements.length === 1, "popup mounted on broken state");
assert(elements[0].attrs["data-dsh-proxy-alert"] === "1", "overlay has marker attr");
const card = elements[0].children[0];
assert(card.children[0].textContent.includes("代理连接异常"), "title shows alert copy");
const detailText = card.children[2].textContent;
assert(detailText.includes("HTTP 500") && detailText.includes("127.0.0.1:7890"), "details show error+proxy");

// 2. still broken -> poll again -> no duplicate popup
intervalCb();
await Promise.resolve();
assert(elements.length === 1, "no duplicate popup while still broken");

// 3. user clicks 知道了 -> dismissed
card.children[4].listeners.click[0]();
assert(elements.length === 0, "popup dismissed by button");

// 4. user dismissed while still broken -> same broken episode does NOT
//    re-pop (no nagging); after a recovery, a new broken episode pops again
fetchStatus = { ...fetchStatus, failures: 5, lastError: "请求超时" };
intervalCb();
await new Promise((resolve) => setTimeout(resolve, 10));
assert(elements.length === 0, "no re-pop in the same broken episode after dismissal");
fetchStatus = { ...fetchStatus, state: "ok", failures: 0, lastError: null };
intervalCb();
await new Promise((resolve) => setTimeout(resolve, 10));
fetchStatus = { ...fetchStatus, state: "broken", failures: 4 };
intervalCb();
await new Promise((resolve) => setTimeout(resolve, 10));
assert(elements.length === 1, "popup reappears on a new broken episode");

// 5. proxy recovers -> auto close
fetchStatus = {
  ...fetchStatus,
  state: "ok",
  failures: 0,
  lastError: null,
};
intervalCb();
await new Promise((resolve) => setTimeout(resolve, 10));
assert(elements.length === 0, "popup auto-closes on recovery");

// 6. endpoint unreachable -> silent (no alarm)
globalThis.fetch = async () => {
  throw new TypeError("fetch failed");
};
intervalCb();
await Promise.resolve();
assert(elements.length === 0, "no popup when status endpoint unreachable");

const summary = {
  inject,
  popupMounted: true,
  autoCloseOnRecovery: true,
  dismissByButton: true,
  noDuplicateWhileBroken: true,
  silentWhenEndpointDown: true,
};
const text = JSON.stringify(summary, null, 2);
if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, text);
console.log(text);
console.log("CLIENT-SMOKE: ALL PASSED");
process.exit(0);
