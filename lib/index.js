// @dsh-external/dsh-proxy — route every dsh outbound fetch through a proxy.
//
// Why: dsh's LLM calls, web search, and remote MCP requests all use the Node
// global `fetch` (undici). On Node 22 the NODE_USE_ENV_PROXY flag only affects
// http.request, NOT the global fetch, and dsh deliberately rejects proxy
// variables from .env/config files (bootstrap-only). This plugin replaces
// undici's global dispatcher with EnvHttpProxyAgent at load time: every fetch
// issued by the dsh process then honors the proxy configuration.
//
// Configuration sources, highest priority first:
//   1. settings namespace "dsh-proxy" (editable from the web UI settings page
//      via the plugin's settings section card) — live-applied on change;
//   2. plugin composition config (proxyUrl / noProxy) as the settings base;
//   3. environment: HTTPS_PROXY ?? HTTP_PROXY, NO_PROXY.
//
// Local loopback stays out of the proxy so the GUI, mock servers, and
// internal RPC are unaffected. If the proxy is unreachable, outbound
// requests fail — that is expected behavior, not a plugin bug.
//
// Health monitoring: while a proxy is applied, this plugin periodically
// fetches a health-check URL THROUGH the proxy (every `healthCheckInterval`
// seconds). After a failed check the next one fires after `healthCheckRetryDelay`
// seconds (absolute 2s by default) instead of the normal interval, so a dead
// proxy is probed every 2s until a check succeeds or consecutive failures
// reach `healthCheckFailures` (broken). The browser half polls the
// `/dsh-proxy/status` endpoint (registered on the webServer service) and
// shows an alert popup; a successful check resets the counter and the popup
// closes itself.
//
// Update checking: on startup and then every `updateCheckIntervalMinutes`
// (default 30, configurable from the settings card), the plugin compares the
// installed dsh version (@deepseek-ai/dsh package.json) against the tags of
// the official repository (GitHub API, falling back to the /tags HTML page).
// When a newer tag exists, the release notes (or the commit list) are handed
// to the default model (agentDefaultModel + llm services) to compose a
// concise changelog; the result is exposed at `/dsh-proxy/update-status`,
// which the browser half polls and turns into an update popup. The last
// summarized tag is persisted under the DSH home so the model is not called
// again for the same version.

import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import Schema from "@deepseek-ai/schemastery";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";

export const name = "dsh-proxy";

const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";
const DEFAULT_CHECK_URL = "https://www.google.com/generate_204";
const DEFAULT_CHECK_INTERVAL = 10; // seconds between checks
const DEFAULT_CHECK_THRESHOLD = 3; // consecutive failed checks before "broken"
const DEFAULT_RETRY_DELAY = 2; // seconds to wait before the retry attempt
const CHECK_TIMEOUT_MS = 10000; // per-attempt timeout
const FIRST_CHECK_DELAY_MS = 5000; // grace period before the first check

// ---- update-check constants ----
const DEFAULT_UPDATE_INTERVAL_MINUTES = 30;
const UPDATE_REPO_BASE = "https://api.github.com/repos/deepseek-ai/deepseek-harness";
const UPDATE_TAGS_PAGE_URL = "https://github.com/deepseek-ai/deepseek-harness/tags";
const UPDATE_RELEASES_PAGE_URL = "https://github.com/deepseek-ai/deepseek-harness/releases/tag/";
const UPDATE_FETCH_TIMEOUT_MS = 15000;
const UPDATE_MODEL_TIMEOUT_MS = 90000;
const FIRST_UPDATE_CHECK_DELAY_MS = 15000; // grace period before the first update check
const VERSION_TAG_RE = /^(?:dsh[-_])?v?\d+\.\d+(?:\.\d+)?/i;

/** Normalize a proxy address: bare host:port gets an http:// scheme. */
function normalizeProxyUrl(value) {
  const trimmed = value.trim();
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

/**
 * Strip tag prefixes used by the harness repo: "dsh-v0.1.0-rc.7" -> "0.1.0-rc.7",
 * "v1.2.3" -> "1.2.3". Also used for the version values installed.
 */
export function stripTagPrefixes(value) {
  return String(value).trim().replace(/^dsh[-_]/i, "").replace(/^v/i, "");
}

/** Parse the numeric core of a version: "0.1.0-rc.7" -> [0, 1, 0]. */
function parseVersion(value) {
  const cleaned = stripTagPrefixes(value);
  const core = cleaned.split("-")[0] ?? "";
  const nums = core.split(".").map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
  while (nums.length < 3) nums.push(0);
  return nums;
}

/** Parse the prerelease part: "0.1.0-rc.7" -> ["rc", "7"], "0.1.0" -> null. */
function parsePrerelease(value) {
  const cleaned = stripTagPrefixes(value);
  const index = cleaned.indexOf("-");
  return index < 0 ? null : cleaned.slice(index + 1).split(".");
}

/**
 * Semver-ish comparison over tag/version strings. Handles the "dsh-v"
 * prefix used by the harness repo, numeric cores, and prerelease ordering
 * (release > prerelease; numeric identifiers sort below alphanumeric).
 * Returns 1 when a > b, -1 when a < b, 0 when equal.
 */
export function compareVersions(a, b) {
  const na = parseVersion(a);
  const nb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (na[i] !== nb[i]) return na[i] > nb[i] ? 1 : -1;
  }
  const pa = parsePrerelease(a);
  const pb = parsePrerelease(b);
  if (pa === null && pb === null) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const numericA = /^\d+$/.test(xa);
    const numericB = /^\d+$/.test(xb);
    if (numericA && numericB) {
      const diff = Number(xa) - Number(xb);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (numericA) {
      return -1; // numeric identifiers sort below alphanumeric ones
    } else if (numericB) {
      return 1;
    } else if (xa !== xb) {
      return xa > xb ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Best-effort extraction of the markdown-body text from a GitHub releases
 * page (HTML). Returns null when the page has no markdown-body div.
 */
export function extractMarkdownBody(html) {
  const start = html.indexOf('<div class="markdown-body');
  if (start < 0) return null;
  let depth = 0;
  let inTag = false;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inTag) {
      if (ch === ">") inTag = false;
      continue;
    }
    if (ch !== "<") continue;
    if (html.startsWith("</div", i)) {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
      inTag = true;
    } else if (html.startsWith("<div", i)) {
      depth += 1;
      inTag = true;
    } else if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i);
      if (close >= 0) i = close + 2;
    } else {
      inTag = true;
    }
  }
  if (end < 0) return null;
  const text = html
    .slice(start, end)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

export function apply(ctx, config = {}) {
  const schema = Schema.object({
    proxyUrl: Schema.string().description("代理地址，例如 http://127.0.0.1:7890（不带 http:// 会自动补全）"),
    noProxy: Schema.string().description("不走代理的地址列表，逗号分隔（默认放行本机回环）"),
    healthCheckEnabled: Schema.boolean()
      .default(true)
      .description("后台健康检测：定期通过代理访问检测地址，连续失败时在界面弹窗报警"),
    healthCheckUrl: Schema.string().description(`健康检测地址（默认 ${DEFAULT_CHECK_URL}，建议选轻量且稳定的站点）`),
    healthCheckInterval: Schema.number()
      .min(5)
      .default(DEFAULT_CHECK_INTERVAL)
      .description("检测间隔（秒）"),
    healthCheckRetryDelay: Schema.number()
      .min(0)
      .default(DEFAULT_RETRY_DELAY)
      .description("检测失败后下一次重试的间隔（秒）：失败后每隔该时长连续重试，直到成功或连续失败达阈值"),
    healthCheckFailures: Schema.number()
      .min(1)
      .default(DEFAULT_CHECK_THRESHOLD)
      .description("连续失败多少次判定代理失效并弹窗报警"),
    updateCheckEnabled: Schema.boolean()
      .default(true)
      .description("更新检查：启动及每隔一段时间检查 dsh 官方仓库是否发布了新版本，有更新时在界面弹窗提示并附 AI 整理的更新日志"),
    updateCheckIntervalMinutes: Schema.number()
      .min(5)
      .default(DEFAULT_UPDATE_INTERVAL_MINUTES)
      .description("更新检查间隔（分钟），默认 30"),
  });

  // The current configuration source: composition entry first, swapped to the
  // resolved settings scope once the settings service mounts.
  let source = () => config;

  // Identity of this host run (plugin load). Exposed through the update-status
  // payload so the browser half can tell a restart apart and forget per-run
  // dismissals ("ignore this version for now" resets on the next startup).
  const bootId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // ---- global-dispatcher state ----
  // The dispatcher installed before this plugin first replaced it; restored
  // when the proxy is cleared or the plugin is disposed (direct connection).
  const previousDispatcher = getGlobalDispatcher();
  let proxied = false;

  // ---- health-monitoring state ----
  const health = {
    enabled: false,
    state: "idle", // "idle" (no proxy applied) | "ok" | "broken"
    failures: 0,
    threshold: DEFAULT_CHECK_THRESHOLD,
    retryDelayMs: DEFAULT_RETRY_DELAY * 1000,
    checkUrl: DEFAULT_CHECK_URL,
    proxyUrl: null,
    lastCheck: null,
    lastError: null,
  };
  let checkTimer = null;
  let checking = false;

  const markBrokenOrOk = () => {
    if (health.failures >= health.threshold) {
      if (health.state !== "broken") {
        health.state = "broken";
        ctx.logger.warn(
          `[dsh-proxy] 代理疑似失效：连续 ${health.failures} 次检测访问 ${health.checkUrl} 失败（${health.lastError}）`,
        );
      }
    } else {
      if (health.state === "broken") {
        ctx.logger.info("[dsh-proxy] 代理已恢复（健康检测通过）");
      }
      health.state = "ok";
    }
  };

  /** One attempt against the check URL; returns ok flag plus an error string. */
  const attemptCheck = async () => {
    try {
      const response = await fetch(health.checkUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, error: null };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return {
        ok: false,
        error:
          error && (error.name === "TimeoutError" || error.name === "AbortError")
            ? "请求超时"
            : error && error.message
              ? error.message
              : String(error),
      };
    }
  };

  // One check = one attempt. On failure the NEXT check fires after
  // `retryDelayMs` (absolute 2s by default), not after the normal interval —
  // so a dead proxy is retried every 2s until a check succeeds (counter
  // resets, back to the normal interval) or consecutive failures reach the
  // threshold (broken). A successful retry resets the counter like a
  // successful first attempt.
  const runCheck = async () => {
    if (checking) return;
    checking = true;
    try {
      const result = await attemptCheck();
      if (result.ok) {
        health.failures = 0;
        health.lastError = null;
      } else {
        health.failures += 1;
        health.lastError = result.error;
      }
    } finally {
      health.lastCheck = new Date().toISOString();
      checking = false;
      markBrokenOrOk();
      const value = source() ?? {};
      const nextDelay =
        health.failures === 0
          ? (value.healthCheckInterval ?? DEFAULT_CHECK_INTERVAL) * 1000
          : health.retryDelayMs;
      schedule(nextDelay);
    }
  };

  const schedule = (delayMs) => {
    checkTimer = setTimeout(async () => {
      checkTimer = null;
      await runCheck();
    }, delayMs);
  };

  const stopHealthCheck = () => {
    if (checkTimer !== null) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    health.enabled = false;
    health.state = "idle";
    health.failures = 0;
    health.lastError = null;
  };

  const startHealthCheck = () => {
    stopHealthCheck();
    const value = source() ?? {};
    if (value.healthCheckEnabled === false) return;
    health.enabled = true;
    health.threshold = Math.max(1, value.healthCheckFailures ?? DEFAULT_CHECK_THRESHOLD);
    health.retryDelayMs = Math.max(0, value.healthCheckRetryDelay ?? DEFAULT_RETRY_DELAY) * 1000;
    health.checkUrl = (value.healthCheckUrl ?? "").trim() || DEFAULT_CHECK_URL;
    // healthCheckFirstDelayMs is an internal test hook; production always uses
    // the fixed grace period before the first check.
    schedule(value.healthCheckFirstDelayMs ?? FIRST_CHECK_DELAY_MS);
  };

  // ---- update-check machinery ----
  //
  // Flow: startup + every interval -> detect installed dsh version ->
  // fetch repo tags (GitHub API, HTML tags page as fallback) -> if the
  // newest tag is newer than the installed version, fetch the release notes
  // (release API, releases list, compare API, HTML releases page, in that
  // order), ask the default model to compose a concise changelog, and expose
  // everything at /dsh-proxy/update-status for the browser popup. The
  // summarized tag is persisted under the DSH home so the model is called
  // only once per version.

  const require = createRequire(import.meta.url);

  /** The DSH home (respects $DSH_HOME, defaults to ~/.dsh). */
  const dshHome = () => {
    const env = process.env.DSH_HOME;
    return typeof env === "string" && env.trim().length > 0 ? env.trim() : join(homedir(), ".dsh");
  };

  /**
   * Determine the installed dsh version by reading the @deepseek-ai/dsh
   * package.json. Candidates: resolution through this plugin's own module
   * graph, the running CLI entry (process.argv walk-up), then the DSH home
   * profile layouts. Returns null when nothing resolves.
   */
  const detectDshVersion = () => {
    const candidates = [];
    try {
      candidates.push(require.resolve("@deepseek-ai/dsh/package.json"));
    } catch {
      // not resolvable from this plugin's module graph — try the other candidates
    }
    for (const arg of process.argv.slice(1)) {
      if (typeof arg === "string" && arg.length > 0) candidates.push(arg);
    }
    const home = dshHome();
    candidates.push(
      join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json"),
      join(home, "profiles", "web", "node_modules", "@deepseek-ai", "dsh", "package.json"),
      join(home, "node_modules", "@deepseek-ai", "dsh", "package.json"),
    );
    for (const candidate of candidates) {
      const version = versionFromCandidate(candidate);
      if (version !== null) return version;
    }
    return null;
  };

  /** Read the dsh version from one candidate path (a package.json or a JS entry to walk up from). */
  const versionFromCandidate = (candidate) => {
    try {
      if (candidate.endsWith("package.json")) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (pkg && pkg.name === "@deepseek-ai/dsh" && typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
        return null;
      }
      let dir = dirname(candidate);
      for (let depth = 0; depth < 16; depth++) {
        const pkgPath = join(dir, "package.json");
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (pkg && pkg.name === "@deepseek-ai/dsh" && typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
        } catch {
          // not this directory — keep walking up
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // unreadable candidate
    }
    return null;
  };

  /** Fetch the repo tag list; GitHub API first, the HTML tags page as fallback. */
  const fetchTags = async (apiBase) => {
    try {
      const response = await fetch(`${apiBase}/tags?per_page=100`, {
        headers: { "User-Agent": "dsh-proxy-plugin", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          const names = data
            .map((item) => (item && typeof item.name === "string" ? item.name : ""))
            .filter(Boolean);
          if (names.length > 0) return names;
        }
      }
    } catch {
      // fall through to the HTML page
    }
    try {
      const response = await fetch(UPDATE_TAGS_PAGE_URL, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; dsh-proxy-plugin)" },
        signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const html = await response.text();
        const names = new Set();
        for (const match of html.matchAll(/releases\/tag\/([^"\\?#]+)/g)) {
          const name = decodeURIComponent(match[1].trim());
          if (name.length > 0) names.add(name);
        }
        for (const match of html.matchAll(/deepseek-harness\/tree\/([^"\\?#]+)/g)) {
          const name = decodeURIComponent(match[1].trim());
          if (name.length > 0) names.add(name);
        }
        if (names.size > 0) return [...names];
      }
    } catch {
      // nothing usable
    }
    return null;
  };

  /**
   * Fetch the release notes for one tag: exact release API, releases list,
   * then the HTML releases page (markdown-body extraction).
   */
  const fetchReleaseBody = async (apiBase, tag) => {
    try {
      const response = await fetch(`${apiBase}/releases/tags/${encodeURIComponent(tag)}`, {
        headers: { "User-Agent": "dsh-proxy-plugin", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const release = await response.json();
        if (typeof release.body === "string" && release.body.trim().length > 0) return release.body;
      }
    } catch {
      // try the next source
    }
    try {
      const response = await fetch(`${apiBase}/releases?per_page=30`, {
        headers: { "User-Agent": "dsh-proxy-plugin", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const releases = await response.json();
        if (Array.isArray(releases)) {
          const found = releases.find((release) => release && release.tag_name === tag);
          if (found && typeof found.body === "string" && found.body.trim().length > 0) return found.body;
        }
      }
    } catch {
      // try the HTML page
    }
    try {
      const response = await fetch(`${UPDATE_RELEASES_PAGE_URL}${encodeURIComponent(tag)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; dsh-proxy-plugin)" },
        signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const html = await response.text();
        const body = extractMarkdownBody(html);
        if (body !== null) return body;
      }
    } catch {
      // nothing usable
    }
    return null;
  };

  /** Fallback raw changelog: commits between the installed version and the latest tag. */
  const fetchCompareCommits = async (apiBase, currentVersion, latestTag) => {
    for (const base of [`dsh-v${currentVersion}`, `v${currentVersion}`, currentVersion]) {
      try {
        const response = await fetch(
          `${apiBase}/compare/${encodeURIComponent(base)}...${encodeURIComponent(latestTag)}`,
          {
            headers: { "User-Agent": "dsh-proxy-plugin", Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
          },
        );
        if (response.ok) {
          const data = await response.json();
          const commits = Array.isArray(data.commits)
            ? data.commits.map((item) => (item && item.commit && typeof item.commit.message === "string" ? item.commit.message : "")).filter(Boolean)
            : [];
          if (commits.length > 0) return `自 ${base} 以来的提交：\n${commits.slice(0, 60).join("\n")}`;
        }
      } catch {
        // try the next base candidate
      }
    }
    return null;
  };

  /** Ask the default model to compose a concise changelog from the raw release notes. */
  const summarizeChangelog = async (rawText, tag) => {
    const defaultModel = ctx.get("agentDefaultModel");
    const llm = ctx.get("llm");
    const selection =
      defaultModel && typeof defaultModel.currentSelection === "function"
        ? defaultModel.currentSelection()
        : null;
    if (!llm || !selection || !selection.provider || !selection.model) {
      ctx.logger.warn("[dsh-proxy] 未找到默认模型（llm / agentDefaultModel 服务不可用），更新日志使用原始发布说明");
      return null;
    }
    const system = [
      "你是 dsh（DeepSeek Harness）的更新日志整理助手。",
      "用户提供某个新版本 tag 的原始发布说明（可能是中英双语、HTML 或提交信息）。",
      "请整理成一份简洁清晰的中文更新日志：先用一句话概括该版本，再按「新增功能 / 问题修复 / 体验优化」等小节列出要点。",
      "只输出更新日志正文，不要任何开场白、解释或 Markdown 代码块围栏。",
    ].join("\n");
    const userText = `版本 tag：${tag}\n\n原始发布说明：\n${String(rawText).slice(0, 8000)}`;
    let text = "";
    try {
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        system,
        maxTokens: 1200,
        messages: [
          {
            id: `dsh-proxy-update-${Date.now()}`,
            role: "user",
            content: [{ type: "text", text: userText }],
            source: { kind: "user" },
          },
        ],
        signal: AbortSignal.timeout(UPDATE_MODEL_TIMEOUT_MS),
      })) {
        if (chunk.type === "text-delta") text += chunk.text;
        else if (chunk.type === "finish" && (chunk.reason.kind === "error" || chunk.reason.kind === "aborted")) {
          throw new Error((chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind);
        }
      }
    } catch (error) {
      ctx.logger.warn(`[dsh-proxy] 更新日志整理失败（${error.message}），改用原始发布说明`);
      return null;
    }
    const result = text.trim();
    return result.length > 0 ? result : null;
  };

  // ---- update-check state & lifecycle ----
  const updateStatePath = () => join(dshHome(), "dsh-proxy", "state.json");
  const loadUpdateState = () => {
    try {
      const parsed = JSON.parse(readFileSync(updateStatePath(), "utf8"));
      return {
        lastSummarizedTag: typeof parsed.lastSummarizedTag === "string" ? parsed.lastSummarizedTag : null,
        lastChangelog: typeof parsed.lastChangelog === "string" ? parsed.lastChangelog : null,
      };
    } catch {
      return { lastSummarizedTag: null, lastChangelog: null };
    }
  };
  const saveUpdateState = (state) => {
    try {
      const file = updateStatePath();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      ctx.logger.warn(`[dsh-proxy] 更新检查状态持久化失败：${error.message}`);
    }
  };

  const update = {
    enabled: true,
    intervalMs: DEFAULT_UPDATE_INTERVAL_MINUTES * 60 * 1000,
    persisted: loadUpdateState(),
    currentVersion: null,
    latestTag: null,
    latestVersion: null,
    updateAvailable: false,
    releaseUrl: null,
    changelog: null,
    lastChecked: null,
    lastError: null,
    checking: false,
  };
  let updateTimer = null;

  /** One full update check: tags -> compare -> release notes -> model summary. */
  const runUpdateCheck = async () => {
    if (update.checking) return;
    update.checking = true;
    try {
      const value = source() ?? {};
      if (value.updateCheckEnabled === false) {
        update.enabled = false;
        return;
      }
      update.enabled = true;
      const apiBase = ((value.updateCheckApiBaseUrl ?? "").trim() || UPDATE_REPO_BASE).replace(/\/+$/, "");
      const currentVersion =
        typeof value.updateCheckCurrentVersion === "string" && value.updateCheckCurrentVersion.length > 0
          ? value.updateCheckCurrentVersion
          : detectDshVersion();
      update.currentVersion = currentVersion;
      if (!currentVersion) {
        update.lastError = "无法确定当前 dsh 版本（未找到 @deepseek-ai/dsh 安装）";
        ctx.logger.warn(`[dsh-proxy] ${update.lastError}，跳过更新检查`);
        return;
      }
      const tags = await fetchTags(apiBase);
      if (!tags || tags.length === 0) {
        update.lastError = "获取 GitHub 版本列表失败（网络或接口异常）";
        ctx.logger.warn("[dsh-proxy] 获取 GitHub 版本列表失败，跳过本次更新检查");
        return;
      }
      let latest = null;
      for (const tag of tags) {
        if (!VERSION_TAG_RE.test(tag)) continue;
        if (latest === null || compareVersions(tag, latest) > 0) latest = tag;
      }
      if (latest === null) {
        update.lastError = "未在版本列表中找到可比较的版本号";
        ctx.logger.warn(`[dsh-proxy] ${update.lastError}（tags: ${tags.join(", ")}）`);
        return;
      }
      const latestVersion = stripTagPrefixes(latest);
      const newer = compareVersions(latestVersion, currentVersion) > 0;
      update.latestTag = latest;
      update.latestVersion = latestVersion;
      update.releaseUrl = `${UPDATE_RELEASES_PAGE_URL}${encodeURIComponent(latest)}`;
      update.updateAvailable = newer;
      if (newer) {
        if (update.persisted.lastSummarizedTag === latest && update.persisted.lastChangelog) {
          update.changelog = update.persisted.lastChangelog;
          ctx.logger.info(`[dsh-proxy] 发现 dsh 新版本：${currentVersion} → ${latestVersion}（${latest}，更新日志复用上次整理结果）`);
        } else {
          let raw = await fetchReleaseBody(apiBase, latest);
          if (!raw) raw = await fetchCompareCommits(apiBase, currentVersion, latest);
          const summarized = raw ? await summarizeChangelog(raw, latest) : null;
          update.changelog = summarized ?? raw ?? "（未获取到发布说明，请前往发布页查看）";
          update.persisted = { lastSummarizedTag: latest, lastChangelog: update.changelog };
          saveUpdateState(update.persisted);
          ctx.logger.info(`[dsh-proxy] 发现 dsh 新版本：${currentVersion} → ${latestVersion}（${latest}）`);
        }
      } else {
        update.changelog = null;
        ctx.logger.info(`[dsh-proxy] 更新检查：当前版本 ${currentVersion} 已是最新（仓库最新 tag ${latest}）`);
      }
      update.lastError = null;
    } catch (error) {
      update.lastError = (error && error.message) || String(error);
      ctx.logger.warn(`[dsh-proxy] 更新检查失败：${update.lastError}`);
    } finally {
      update.lastChecked = new Date().toISOString();
      update.checking = false;
      scheduleNextUpdateCheck();
    }
  };

  const stopUpdateCheck = () => {
    if (updateTimer !== null) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
  };

  /** Re-arm the periodic check from current settings (used on boot and on settings change). */
  const startUpdateCheck = () => {
    stopUpdateCheck();
    const value = source() ?? {};
    if (value.updateCheckEnabled === false) {
      update.enabled = false;
      return;
    }
    update.enabled = true;
    const minutes =
      Number(value.updateCheckIntervalMinutes) > 0
        ? Number(value.updateCheckIntervalMinutes)
        : DEFAULT_UPDATE_INTERVAL_MINUTES;
    update.intervalMs = minutes * 60 * 1000;
    const firstDelayMs =
      Number(value.updateCheckFirstDelayMs) > 0 ? Number(value.updateCheckFirstDelayMs) : FIRST_UPDATE_CHECK_DELAY_MS;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      runUpdateCheck();
    }, firstDelayMs);
  };

  /** Schedule the next periodic check after a completed run. */
  const scheduleNextUpdateCheck = () => {
    stopUpdateCheck();
    const value = source() ?? {};
    if (value.updateCheckEnabled === false) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      runUpdateCheck();
    }, update.intervalMs);
  };

  /** Restore the pre-plugin global dispatcher (back to direct connection). */
  const restoreDispatcher = () => {
    if (!proxied) return;
    setGlobalDispatcher(previousDispatcher);
    proxied = false;
    ctx.logger.info("[dsh-proxy] 已恢复直连（全局 dispatcher 已还原）");
  };

  const applyProxy = () => {
    const value = source() ?? {};
    const rawProxyUrl = value.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    const noProxy = value.noProxy ?? process.env.NO_PROXY ?? DEFAULT_NO_PROXY;

    if (!rawProxyUrl) {
      restoreDispatcher();
      stopHealthCheck();
      ctx.logger.warn("[dsh-proxy] 未配置代理（settings / 插件配置 / HTTP(S)_PROXY 均为空），dsh 请求保持直连");
      return;
    }

    const proxyUrl = normalizeProxyUrl(rawProxyUrl);
    try {
      setGlobalDispatcher(
        new EnvHttpProxyAgent({
          httpProxy: proxyUrl,
          httpsProxy: proxyUrl,
          noProxy,
        }),
      );
    } catch (error) {
      stopHealthCheck();
      ctx.logger.warn(`[dsh-proxy] 代理配置无效（${proxyUrl}），dsh 请求保持直连: ${error.message}`);
      return;
    }
    proxied = true;
    health.proxyUrl = proxyUrl;
    ctx.logger.info(`[dsh-proxy] 已启用代理 ${proxyUrl}（NO_PROXY=${noProxy}）`);
    startHealthCheck();
  };

  // Apply the composition/env configuration immediately, then let the
  // settings namespace take over (and keep re-applying on every change).
  applyProxy();
  installSettingsSection(ctx, "dsh-proxy", schema, config, {
    setSource: (next) => {
      source = next;
    },
    onChange: () => {
      applyProxy();
      startUpdateCheck();
    },
  });

  // First update check shortly after boot; afterwards the periodic timer
  // (re-armed by startUpdateCheck / scheduleNextUpdateCheck) takes over.
  startUpdateCheck();

  // ---- status endpoint for the browser half ----
  const statusHandler = (req, res) => {
    const value = source() ?? {};
    const body = JSON.stringify({
      enabled: health.enabled,
      state: health.state,
      failures: health.failures,
      threshold: health.threshold,
      intervalSeconds: value.healthCheckInterval ?? DEFAULT_CHECK_INTERVAL,
      retryDelaySeconds: value.healthCheckRetryDelay ?? DEFAULT_RETRY_DELAY,
      checkUrl: health.checkUrl,
      proxyUrl: health.proxyUrl,
      lastCheck: health.lastCheck,
      lastError: health.lastError,
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };

  // ---- update-status endpoint for the browser half ----
  const updateStatusHandler = (req, res) => {
    const body = JSON.stringify({
      bootId,
      enabled: update.enabled,
      lastChecked: update.lastChecked,
      currentVersion: update.currentVersion,
      latestTag: update.latestTag,
      latestVersion: update.latestVersion,
      updateAvailable: update.updateAvailable,
      releaseUrl: update.releaseUrl,
      changelog: update.changelog,
      lastError: update.lastError,
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(body);
  };

  const registerStatusRoute = () => {
    const server = ctx.get("webServer");
    if (server === void 0) return false;
    try {
      server.register({ kind: "exact", path: "/dsh-proxy/status", handler: statusHandler });
      server.register({ kind: "exact", path: "/dsh-proxy/update-status", handler: updateStatusHandler });
      ctx.logger.info("[dsh-proxy] 状态端点已注册：GET /dsh-proxy/status、GET /dsh-proxy/update-status");
      return true;
    } catch (error) {
      ctx.logger.warn(`[dsh-proxy] 状态端点注册失败: ${error.message}`);
      return false;
    }
  };

  if (!registerStatusRoute()) {
    // webServer may not be ready at plugin load; retry shortly after.
    const retry = setTimeout(() => {
      if (!registerStatusRoute()) {
        ctx.logger.warn("[dsh-proxy] 状态端点注册失败（webServer 未就绪），浏览器端健康报警/更新提示不可用");
      }
    }, 2000);
    ctx.effect(() => () => clearTimeout(retry));
  }

  ctx.effect(() => () => {
    restoreDispatcher();
    stopHealthCheck();
    stopUpdateCheck();
  });
}


