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

import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
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

/** Normalize a proxy address: bare host:port gets an http:// scheme. */
function normalizeProxyUrl(value) {
  const trimmed = value.trim();
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
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
  });

  // The current configuration source: composition entry first, swapped to the
  // resolved settings scope once the settings service mounts.
  let source = () => config;

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

  const applyProxy = () => {
    const value = source() ?? {};
    const rawProxyUrl = value.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    const noProxy = value.noProxy ?? process.env.NO_PROXY ?? DEFAULT_NO_PROXY;

    if (!rawProxyUrl) {
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
    onChange: () => applyProxy(),
  });

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

  const registerStatusRoute = () => {
    const server = ctx.get("webServer");
    if (server === void 0) return false;
    try {
      server.register({ kind: "exact", path: "/dsh-proxy/status", handler: statusHandler });
      ctx.logger.info("[dsh-proxy] 状态端点已注册：GET /dsh-proxy/status");
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
        ctx.logger.warn("[dsh-proxy] 状态端点注册失败（webServer 未就绪），浏览器端健康报警不可用");
      }
    }, 2000);
    ctx.effect(() => () => clearTimeout(retry));
  }

  ctx.effect(() => () => stopHealthCheck());
}
