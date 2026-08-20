// One-shot e2e test for @dsh-external/dsh-proxy host apply(), run inside the
// web profile so '@dsh-external/dsh-proxy' resolves through pnpm links.
// Expects a local proxy logger on 7899 (separate process) and HTTP_PROXY set.
const fs = await import("node:fs");

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

const ctx = {
  logger: {
    info: (...a) => logs.push("INFO " + a.join(" ")),
    warn: (...a) => logs.push("WARN " + a.join(" ")),
  },
  get: (name) => (name === "webServer" ? { register: () => () => {} } : void 0),
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
m.apply(ctx, {});

const step1 = await fetch("http://example.com/").then((r) => r.text());

// Simulate a settings-page save: namespace gains a value, watcher fires.
nsValue = { proxyUrl: "http://127.0.0.1:7899", noProxy: "127.0.0.1,localhost" };
watchCb();
const step2 = await fetch("http://example.com/").then((r) => r.text());

fs.writeFileSync(
  process.env.OUTF,
  `STEP1=${step1.trim()} | STEP2=${step2.trim()} | ${logs.join(" || ")}`,
);
process.exit(0);
