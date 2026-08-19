# dsh-proxy

让 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 进程内**所有出站请求**（LLM API、web 搜索、远程 MCP 等）统一走 HTTP(S) 代理的 bundle 插件。

## 为什么需要它

- dsh 的 LLM / 搜索 / 远程 MCP 请求都走 Node 全局 `fetch`（undici）。
- Node 22 的 `NODE_USE_ENV_PROXY=1` 只影响 `http.request`，**对全局 fetch 无效**。
- dsh 刻意禁止从 `.env`/配置文件注入 `HTTP_PROXY` 等变量（bootstrap-only，只能由启动环境提供）。

本插件在加载时用 undici 的 `EnvHttpProxyAgent` 替换全局 dispatcher，从此进程内所有 fetch 遵循代理配置。

## 安装

在 web profile（`~/.dsh/profiles/web`）中：

1. `package.json` 的 `dsh.profile.bundles` 加入 `"@dsh-external/dsh-proxy"`；
2. `dependencies` 加入 `"@dsh-external/dsh-proxy": "link:<本仓库路径>"`；
3. `pnpm install`；
4. 重启 `dsh web`。

重启后设置页出现「网络代理」卡片，启动日志出现 `[dsh-proxy] 已启用代理 ...` 即生效。

## 配置

优先级从高到低：

1. **settings namespace `dsh-proxy`**（`~/.dsh/settings.yaml` 或设置页卡片）——**运行时修改即时生效，无需重启**（设置页保存或文件热更新都会触发重挂代理）；
2. 插件 composition config（`proxyUrl` / `noProxy`）作为 settings 的 base 层；
3. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` 与 `NO_PROXY`。

```yaml
dsh-proxy:
  proxyUrl: "http://127.0.0.1:7890"   # 不带 http:// 会自动补全
  noProxy: "127.0.0.1,localhost,::1"  # 默认放行本机回环
```

## 行为与容错

- 本机回环地址默认不进代理，GUI、mock server、内部 RPC 不受影响；
- 代理地址非法（如无 scheme 的裸地址会由 `new URL()` 拒绝）→ 自动补 `http://`，仍失败则 **warn 并保持直连**，不会拖垮 dsh 启动；
- 代理软件未启动时，dsh 出站请求会失败——这是预期行为，不是插件 bug。

## 开发

- `lib/index.js` — host 端：注册 `dsh-proxy` settings namespace（`installSettingsSection`），`scope.watch` 监听变化即时重挂 dispatcher；
- `lib/client.js` — 浏览器端：设置页「网络代理」卡片（`settings.section` 槽位），通过 `settingsScope` 读写 namespace；
- `test/` — 本地端到端测试（含运行时热切换验证），在 profile 目录下运行：
  ```powershell
  # 先起两个本地代理 logger（7899→A、7898→B），再：
  node .dsh-plugins\dsh-proxy\test\hot-reload.mjs
  ```

## License

MIT
