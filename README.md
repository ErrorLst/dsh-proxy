# dsh-proxy

让 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 进程内**所有出站请求**（LLM API、web 搜索、远程 MCP 等）统一走 HTTP(S) 代理的 bundle 插件。

## 为什么需要它

- dsh 的 LLM / 搜索 / 远程 MCP 请求都走 Node 全局 `fetch`（undici）。
- Node 22 的 `NODE_USE_ENV_PROXY=1` 只影响 `http.request`，**对全局 fetch 无效**。
- dsh 刻意禁止从 `.env`/配置文件注入 `HTTP_PROXY` 等变量（bootstrap-only，只能由启动环境提供）。

本插件在加载时用 undici 的 `EnvHttpProxyAgent` 替换全局 dispatcher，从此进程内所有 fetch 遵循代理配置。

## 安装

**首选：一行命令安装**

```bash
dsh plugin --profile web add github:ErrorLst/dsh-proxy
```

该命令在 web profile 下执行 `pnpm add github:ErrorLst/dsh-proxy`；安装成功后 reconcile 读取包内 `dsh.bundle.patch` 声明，自动把 `@dsh-external/dsh-proxy` 追加进 `dsh.profile.bundles`（无需手动登记），重启 `dsh web` 后生效。

**本地开发安装（手动 link）**

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
  healthCheckRetryDelay: 2            # 失败后下一次重试的间隔（秒，默认 2）
  healthCheckFailures: 3              # 连续失败多少次判定代理失效
  updateCheckEnabled: true            # 更新检查开关（默认开启）
  updateCheckIntervalMinutes: 30      # 更新检查间隔（分钟，最小 5，默认 30）
```

## 健康检测与弹窗报警

启用代理后，插件会**通过代理**定期访问检测地址（默认 Google 的 204 探测点，轻量稳定），默认每 **10 秒**检测一次：

- 每次访问成功 → 失败计数清零，回到 10 秒正常节奏；
- **一次访问失败 → 不等待下一个周期，延迟 `healthCheckRetryDelay`（默认 2 秒）后立即再次访问**；再失败再过 2 秒继续访问，直到成功或连续失败达到阈值；
- 连续失败达到 `healthCheckFailures` 次（默认 3）→ 判定代理失效（断开后约 4 秒内报警，另有浏览器端最多 5 秒的轮询延迟）；
- 浏览器端每 5 秒轮询 `/dsh-proxy/status` 端点，状态变为失效时**弹出警告窗口**（显示连续失败次数、代理地址、最近错误、检测时间）；
- 手动关闭后同一轮失效期间不再重复打扰；代理恢复后弹窗**自动关闭**（失败期间的 2 秒快速重试也会及时发现恢复）；
- host 日志同步输出 `[dsh-proxy] 代理疑似失效：连续 N 次检测访问 ... 失败` 与 `[dsh-proxy] 代理已恢复`。

检测失败（代理未启动、节点失效、DNS/超时等）不会影响 dsh 本身——请求失败是预期行为，插件只负责报警。

## 更新检查与弹窗提示

插件会在**启动后**以及之后每隔 `updateCheckIntervalMinutes`（默认 **30 分钟**，设置页可改）检查一次 dsh 官方仓库（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tags)）是否有新版本：

- 优先调用 GitHub API 拉取 tag 列表（每页 100 个），接口不可用时回退抓取 `/tags` 页面解析 tag 链接；
- 与当前安装的 dsh 版本（读取 `@deepseek-ai/dsh` 的 package.json）做语义化比较（支持仓库使用的 `dsh-v` 前缀与 `-rc.x` 预发布号）；
- **发现新版本时**：抓取该 tag 的发布说明（release API → releases 列表 → compare API 提交列表 → 发布页 HTML，逐级回退），交给**默认模型**（设置页选择的模型）整理成一份简洁的中文更新日志，然后浏览器端弹窗提示「发现 dsh 新版本」，展示当前 → 最新版本与 AI 整理的更新日志（**Markdown 渲染**：优先复用 dsh 的 MarkdownText 组件，支持 GFM、代码高亮、公式等；模块不可用时自动回退到插件内置的轻量 Markdown 渲染器，标题/列表/代码/加粗等仍正常渲染，绝不显示原始文本），可一键跳转 GitHub 发布页；
- 同一版本只整理一次更新日志（结果持久化在 `~/.dsh/dsh-proxy/state.json`，重启后直接复用，不再重复调用模型）；
- 浏览器端关闭弹窗后**仅本次运行内**不再提示该版本（内存记录，不落盘）：dsh 重启（服务端更换 `bootId`）或刷新页面后会**再次提示**；出现更新的版本时同样会再次弹窗；
- 检查失败（离线、接口异常、无法确定当前版本）只记日志并设置 `lastError`，不影响 dsh 正常工作；
- 浏览器端每 30 秒轮询 `GET /dsh-proxy/update-status` 获取最新检查结果。

## 行为与容错

- 本机回环地址默认不进代理，GUI、mock server、内部 RPC 不受影响；
- **未配置代理时 dsh 保持直连**：settings / 插件配置 / `HTTP(S)_PROXY` 均为空就不替换全局 dispatcher；即使先配置后清空（设置页删掉代理地址、清空环境变量，或插件被卸载），也会**立即恢复直连**，无需重启 dsh；
- 代理地址非法（如无 scheme 的裸地址会由 `new URL()` 拒绝）→ 自动补 `http://`，仍失败则 **warn 并保持直连**，不会拖垮 dsh 启动；
- 代理软件未启动时，dsh 出站请求会失败——这是预期行为，不是插件 bug。

## 开发

- `lib/index.js` — host 端：注册 `dsh-proxy` settings namespace（`installSettingsSection`），`scope.watch` 监听变化即时重挂 dispatcher；健康检测定时器与 `GET /dsh-proxy/status` 状态端点、更新检查定时器与 `GET /dsh-proxy/update-status` 更新状态端点（挂在 `webServer` 服务上）；
- `lib/client.js` — 浏览器端：设置页「网络代理」卡片（`settings.section` 槽位），通过 `settingsScope` 读写 namespace；轮询状态端点并在代理失效时弹原生 DOM 报警窗；轮询更新状态端点并在发现新版本时弹更新提示窗（含 AI 整理的更新日志）；
- `test/` — 本地闭环测试（无需外网与真实代理），在插件目录下直接运行：
  ```powershell
  node test\health-check.mjs        # 健康检测 e2e：ok → 连续失败 broken → 恢复 → 禁用 → 热切换
  node test\update-check.mjs        # 更新检查 e2e：mock GitHub API + mock 默认模型
  node test\update-check-utils.mjs  # 版本比较 / tag 前缀 / HTML 提取 单元测试
  node test\client-smoke.mjs        # 浏览器端弹窗逻辑冒烟（mock DOM/fetch，覆盖健康报警与更新提示）
  ```
  （`hot-reload.mjs` / `e2e-host.mjs` 需要外部 mock 代理进程与 `HTTP_PROXY` 环境，按需使用。）

## License

MIT
