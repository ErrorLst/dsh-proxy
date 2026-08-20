// Client-half smoke test: load lib/client.js through a mock __ModuleLoader__,
// drive the health alarm and the update notifier through mocked fetch/document,
// and assert:
//   health: popup on "broken", no re-pop while still broken, dismiss by
//   button, auto-close on recovery, silent when the endpoint is down;
//   update: popup on updateAvailable, changelog rendered through MarkdownText,
//   no duplicate, dismiss mutes the tag for the current run only (a fresh
//   bootId after a restart re-prompts the SAME version), a newer tag pops
//   again, plain-text fallback when markdown module missing.
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
  createTextNode: (value) => ({ nodeType: 3, textContent: value, children: [] }),
};

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
};

let healthStatus = {
  state: "broken",
  failures: 3,
  threshold: 3,
  checkUrl: "https://www.google.com/generate_204",
  proxyUrl: "http://127.0.0.1:7890",
  lastCheck: new Date().toISOString(),
  lastError: "HTTP 500",
};
let updateStatus = {
  bootId: "boot-1",
  enabled: true,
  lastChecked: new Date().toISOString(),
  currentVersion: "0.1.0-rc.7",
  latestTag: null,
  latestVersion: null,
  updateAvailable: false,
  releaseUrl: null,
  changelog: null,
  lastError: null,
};
let fetchThrows = false;
globalThis.fetch = async (url) => {
  if (fetchThrows) throw new TypeError("fetch failed");
  const u = String(url);
  if (u.includes("/dsh-proxy/update-status")) {
    return { ok: true, json: async () => updateStatus };
  }
  return { ok: true, json: async () => healthStatus };
};

const intervals = [];
globalThis.setInterval = (cb, ms) => {
  intervals.push({ cb, ms });
  return intervals.length;
};
globalThis.clearInterval = () => {};
const healthPoll = () => intervals.find((i) => i.ms === 5000).cb();
const updatePoll = () => intervals.find((i) => i.ms === 30000).cb();
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

let loadedDef = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loadedDef = def;
    },
  },
};

// ---- markdown stubs ----
const MarkdownTextStub = function MarkdownText(props) {
  return { kind: "MarkdownText", props };
};
const primitivesStub = { MarkdownText: MarkdownTextStub };
let primitivesUnavailable = false;
let lastMarkdownRender = null;

await import(new URL("../lib/client.js", import.meta.url).href);
const { inject, apply } = loadedDef.factory((name) => {
  if (name === "react") {
    return {
      useState: () => [null, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    };
  }
  if (name === "react-dom/client") {
    return {
      createRoot: (el) => ({
        render: (node) => {
          lastMarkdownRender = { el, node };
        },
        unmount: () => {
          lastMarkdownRender = null;
        },
      }),
    };
  }
  if (name === "@deepseek-ai/dsh-client-ui-primitives") {
    if (primitivesUnavailable) {
      throw new Error(`client-modules: require("${name}") missed the module table`);
    }
    return primitivesStub;
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

// ---- health alarm flow ----
// 1. immediate poll sees "broken" -> popup appears
await flush();
assert(elements.length === 1, "popup mounted on broken state");
assert(elements[0].attrs["data-dsh-proxy-alert"] === "1", "overlay has marker attr");
const card = elements[0].children[0];
assert(card.children[0].textContent.includes("代理连接异常"), "title shows alert copy");
const detailText = card.children[2].textContent;
assert(detailText.includes("HTTP 500") && detailText.includes("127.0.0.1:7890"), "details show error+proxy");

// 2. still broken -> poll again -> no duplicate popup
healthPoll();
await Promise.resolve();
assert(elements.length === 1, "no duplicate popup while still broken");

// 3. user clicks 知道了 -> dismissed
card.children[4].listeners.click[0]();
assert(elements.length === 0, "popup dismissed by button");

// 4. user dismissed while still broken -> same broken episode does NOT
//    re-pop (no nagging); after a recovery, a new broken episode pops again
healthStatus = { ...healthStatus, failures: 5, lastError: "请求超时" };
healthPoll();
await flush();
assert(elements.length === 0, "no re-pop in the same broken episode after dismissal");
healthStatus = { ...healthStatus, state: "ok", failures: 0, lastError: null };
healthPoll();
await flush();
healthStatus = { ...healthStatus, state: "broken", failures: 4 };
healthPoll();
await flush();
assert(elements.length === 1, "popup reappears on a new broken episode");

// 5. proxy recovers -> auto close
healthStatus = {
  ...healthStatus,
  state: "ok",
  failures: 0,
  lastError: null,
};
healthPoll();
await flush();
assert(elements.length === 0, "popup auto-closes on recovery");

// ---- update notification flow ----
// 6. no update available -> no popup
updateStatus = { ...updateStatus, enabled: true, updateAvailable: false, latestTag: null };
updatePoll();
await flush();
assert(elements.length === 0, "no popup when no update available");

// 7. update available -> popup, changelog rendered through MarkdownText
updateStatus = {
  ...updateStatus,
  enabled: true,
  updateAvailable: true,
  latestTag: "dsh-v0.2.0-rc.1",
  latestVersion: "0.2.0-rc.1",
  currentVersion: "0.1.0-rc.7",
  releaseUrl: "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1",
  changelog: "## 更新日志\n\n- **新增**若干功能\n- 修复若干问题",
};
updatePoll();
await flush();
assert(elements.length === 1, "update popup mounted");
assert(elements[0].attrs["data-dsh-proxy-update"] === "1", "update overlay has marker attr");
const ucard = elements[0].children[0];
assert(ucard.children[0].textContent.includes("新版本"), "update title shows new-version copy");
assert(ucard.children[1].textContent.includes("0.1.0-rc.7") && ucard.children[1].textContent.includes("0.2.0-rc.1"), "meta shows version change");
const changelogEl = ucard.children[2];
assert(changelogEl.attrs["data-dsh-proxy-changelog"] === "1", "changelog container present");
assert(
  lastMarkdownRender !== null &&
    lastMarkdownRender.el === changelogEl &&
    lastMarkdownRender.node.type === MarkdownTextStub &&
    lastMarkdownRender.node.props.text.includes("修复若干问题"),
  "changelog rendered through MarkdownText with the full source",
);
assert(ucard.children[4].children[0].href === updateStatus.releaseUrl, "release link present");

// 8. same update again -> no duplicate popup
updatePoll();
await Promise.resolve();
assert(elements.length === 1, "no duplicate update popup");

// 9. dismiss 知道了 -> muted for THIS run only: no re-pop while the same
//    bootId, nothing persisted
ucard.children[4].children[1].listeners.click[0]();
assert(elements.length === 0, "update popup dismissed by button");
assert(lastMarkdownRender === null, "markdown root unmounted on dismiss");
updatePoll();
await flush();
assert(elements.length === 0, "no re-pop for the dismissed tag in the same run");

// 9b. host restarts (fresh bootId) -> the SAME version prompts again
updateStatus = { ...updateStatus, bootId: "boot-2" };
updatePoll();
await flush();
assert(elements.length === 1, "same version pops again after a restart (new bootId)");
elements[0].children[0].children[4].children[1].listeners.click[0]();

// 10. a newer tag (same run) -> popup again
updateStatus = { ...updateStatus, latestTag: "dsh-v0.2.0-rc.2", latestVersion: "0.2.0-rc.2" };
updatePoll();
await flush();
assert(elements.length === 1, "newer tag pops again");
elements[0].children[0].children[4].children[1].listeners.click[0]();

// 10b. OLD host without a bootId (not yet restarted): a dismissed tag must
//      NOT re-pop on the next poll (regression: an undefined bootId used to
//      be treated as "changed" on every poll, clearing dismissals -> a
//      ~30s popup loop)
updateStatus = { ...updateStatus, bootId: undefined };
updatePoll();
await flush();
assert(elements.length === 0, "no re-pop loop when the host serves no bootId");

// 10c. even without a bootId, a NEWER tag still prompts and can be dismissed
updateStatus = { ...updateStatus, latestTag: "dsh-v0.2.0-rc.3", latestVersion: "0.2.0-rc.3" };
updatePoll();
await flush();
assert(elements.length === 1, "new tag pops even without bootId");
elements[0].children[0].children[4].children[1].listeners.click[0]();

// 11. disabled -> no popup even when updateAvailable stays true
updateStatus = { ...updateStatus, enabled: false, latestTag: "dsh-v0.2.0-rc.3" };
updatePoll();
await flush();
assert(elements.length === 0, "no popup when update checking disabled");

// 12. markdown module unavailable -> BUILT-IN markdown fallback still
//     renders structure (headings/lists), never the raw source
primitivesUnavailable = true;
updateStatus = {
  ...updateStatus,
  enabled: true,
  updateAvailable: true,
  latestTag: "dsh-v0.3.0",
  latestVersion: "0.3.0",
  changelog: "### 标题\n- 项目一\n- 项目二\n\n段落 **加粗**",
};
updatePoll();
await flush();
assert(elements.length === 1, "fallback popup mounted");
const fcard = elements[0].children[0];
const fcl = fcard.children[2];
assert(fcl.attrs["data-dsh-proxy-changelog"] === "1", "fallback container present");
const childTags = fcl.children.map((c) => c.tag);
assert(childTags.includes("h3"), "fallback renders headings");
const ul = fcl.children.find((c) => c.tag === "ul");
assert(ul !== undefined && ul.children.length === 2, "fallback renders list items");
const strong = fcl.children.find((c) => c.tag === "p")?.children.find((c) => c.tag === "strong");
assert(strong !== undefined && strong.textContent === "加粗", "fallback renders inline bold");
assert(!fcl.textContent.includes("###"), "fallback strips markdown markers");
assert(lastMarkdownRender === null, "no MarkdownText render in fallback mode");
fcard.children[4].children[1].listeners.click[0]();
primitivesUnavailable = false;

// 13. endpoint unreachable -> silent (no alarm, no update popup)
fetchThrows = true;
healthPoll();
updatePoll();
await Promise.resolve();
assert(elements.length === 0, "no popup when endpoints unreachable");

const summary = {
  inject,
  popupMounted: true,
  autoCloseOnRecovery: true,
  dismissByButton: true,
  noDuplicateWhileBroken: true,
  silentWhenEndpointDown: true,
  updatePopupMounted: true,
  updateMarkdownRendered: true,
  updateRootUnmounted: true,
  updateDismissPerRunOnly: true,
  updateRepromptsAfterRestart: true,
  updateNewerTagPopsAgain: true,
  updateDisabledSilent: true,
  updateBuiltinMarkdownFallback: true,
};
const text = JSON.stringify(summary, null, 2);
if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, text);
console.log(text);
console.log("CLIENT-SMOKE: ALL PASSED");
process.exit(0);
