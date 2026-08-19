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
  healthCheckEnabled: true            # 后台健康检测开关（默认开启）
  healthCheckUrl: "https://www.google.com/generate_204"  # 检测地址（走代理）
  healthCheckInterval: 10             # 检测间隔（秒，最小 5，默认 10）
  healthCheckRetryDelay: 2            # 单次失败后重试前的等待时间（秒，默认 2）
  healthCheckFailures: 3              # 连续失败多少次判定代理失效
```

## 健康检测与弹窗报警

启用代理后，插件会**通过代理**定期访问检测地址（默认 Google 的 204 探测点，轻量稳定），默认每 **10 秒**检测一次：

- 每次检测：先访问一次；**失败则等待 2 秒后重试一次**；首次成功或重试成功 → 失败计数清零（偶发抖动不会误报）；
- **首次和重试都失败** → 计一次检测失败；连续失败达到 `healthCheckFailures` 次（默认 3）→ 判定代理失效；
- 浏览器端每 5 秒轮询 `/dsh-proxy/status` 端点，状态变为失效时**弹出警告窗口**（显示连续失败次数、代理地址、最近错误、检测时间）；
- 手动关闭后同一轮失效期间不再重复打扰；代理恢复后弹窗**自动关闭**；
- host 日志同步输出 `[dsh-proxy] 代理疑似失效：连续 N 次检测访问 ... 失败` 与 `[dsh-proxy] 代理已恢复`。

检测失败（代理未启动、节点失效、DNS/超时等）不会影响 dsh 本身——请求失败是预期行为，插件只负责报警。

## 行为与容错

- 本机回环地址默认不进代理，GUI、mock server、内部 RPC 不受影响；
- 代理地址非法（如无 scheme 的裸地址会由 `new URL()` 拒绝）→ 自动补 `http://`，仍失败则 **warn 并保持直连**，不会拖垮 dsh 启动；
- 代理软件未启动时，dsh 出站请求会失败——这是预期行为，不是插件 bug。

## 开发

- `lib/index.js` — host 端：注册 `dsh-proxy` settings namespace（`installSettingsSection`），`scope.watch` 监听变化即时重挂 dispatcher；健康检测定时器与 `GET /dsh-proxy/status` 状态端点（挂在 `webServer` 服务上）；
- `lib/client.js` — 浏览器端：设置页「网络代理」卡片（`settings.section` 槽位），通过 `settingsScope` 读写 namespace；轮询状态端点并在代理失效时弹原生 DOM 报警窗；
- `test/` — 本地闭环测试（无需外网与真实代理），在插件目录下直接运行：
  ```powershell
  node test\health-check.mjs   # 健康检测 e2e：ok → 连续失败 broken → 恢复 → 禁用 → 热切换
  node test\client-smoke.mjs   # 浏览器端弹窗逻辑冒烟（mock DOM/fetch）
  ```

## License

MIT
