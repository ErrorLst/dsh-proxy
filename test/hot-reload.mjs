// Hot-reload e2e: does a RUNTIME settings change re-route fetch immediately?
// Run inside the web profile so '@dsh-external/dsh-proxy' resolves through
// pnpm links. Two local proxy loggers answer distinct bodies:
//   7899 -> 'A', 7898 -> 'B'  (separate processes).
// Sequence:
//   1. apply() with env fallback (HTTP_PROXY=7899)  -> fetch returns 'A'
//   2. settings gains proxyUrl=7898, watcher fires  -> fetch returns 'B'
//   3. settings changes again to bare "127.0.0.1:7899" (no scheme), watcher
//      fires again -> fetch returns 'A' (normalizer adds http://)
// If any step returns the wrong body, the live re-apply chain is broken.
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

// Runtime change #1: settings page save / settings.yaml hot-publish.
nsValue = { proxyUrl: "http://127.0.0.1:7898", noProxy: "127.0.0.1,localhost" };
watchCb();
const step2 = await fetch("http://example.com/").then((r) => r.text());

// Runtime change #2: another edit, this time without a scheme.
nsValue = { proxyUrl: "127.0.0.1:7899" };
watchCb();
const step3 = await fetch("http://example.com/").then((r) => r.text());

fs.writeFileSync(
  process.env.OUTF,
  `S1=${step1} | S2=${step2} | S3=${step3} | ${logs.join(" || ")}`,
);
process.exit(0);
