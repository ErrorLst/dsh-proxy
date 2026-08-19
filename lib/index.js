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

import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import Schema from "@deepseek-ai/schemastery";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";

export const name = "dsh-proxy";

const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";

/** Normalize a proxy address: bare host:port gets an http:// scheme. */
function normalizeProxyUrl(value) {
  const trimmed = value.trim();
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function apply(ctx, config = {}) {
  const schema = Schema.object({
    proxyUrl: Schema.string().description("代理地址，例如 http://127.0.0.1:7890（不带 http:// 会自动补全）"),
    noProxy: Schema.string().description("不走代理的地址列表，逗号分隔（默认放行本机回环）"),
  });

  // The current configuration source: composition entry first, swapped to the
  // resolved settings scope once the settings service mounts.
  let source = () => config;

  const applyProxy = () => {
    const value = source() ?? {};
    const rawProxyUrl = value.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    const noProxy = value.noProxy ?? process.env.NO_PROXY ?? DEFAULT_NO_PROXY;

    if (!rawProxyUrl) {
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
      ctx.logger.warn(`[dsh-proxy] 代理配置无效（${proxyUrl}），dsh 请求保持直连: ${error.message}`);
      return;
    }
    ctx.logger.info(`[dsh-proxy] 已启用代理 ${proxyUrl}（NO_PROXY=${noProxy}）`);
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
}
