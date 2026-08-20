// Test-only: render the REAL MarkdownText from @deepseek-ai/dsh-client-ui-primitives
// with the REAL changelog text, using react-dom/server (no DOM needed).
// Absolute-path imports because the plugin tree cannot resolve profile packages.
import React from "file://C:/Users/zhoujin/.dsh/profiles/node_modules/react/index.js";
import { renderToString } from "file://C:/Users/zhoujin/.dsh/profiles/node_modules/react-dom/server.node.js";
import { MarkdownText } from "file://C:/Users/zhoujin/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js";
import fs from "node:fs";

const changelog = "dsh-v0.1.0-rc.8 发布：重点增强多模态支持（原生图片请求、图文命令、@ 引用文件/会话），新增 Claude Code 与 Codex 子代理按需安装及 Windows 持久 PowerShell 会话。\n\n### 新增功能\n- 多模态能力：DeepSeek 模型适配器支持配置启用原生图片请求，`/goal`、`/plan` 等命令可接收图文输入。\n- 子代理按需安装：Claude Code 与 Codex 子代理均可作为 Profile Bundle 安装。\n- Windows PTY 终端支持持久 PowerShell 会话。\n\n### 问题修复\n- 修复图片尺寸过大或历史累计图片载荷过高导致模型请求失败的问题。\n- 修正取消流式生成后已展示的回复前缀未带入后续。";
try {
  const html = renderToString(React.createElement(MarkdownText, { text: changelog }));
  if (process.env.OUTF) fs.writeFileSync(process.env.OUTF, html);
  console.log("RENDERED OK, html length:", html.length);
  console.log("has <h3>:", html.includes("<h3"));
  console.log("has <li>:", html.includes("<li"));
  console.log("has <strong>:", html.includes("<strong"));
  console.log("has <code>:", html.includes("<code"));
  console.log("raw '###' remains:", html.includes("###"));
  console.log("--- html head ---");
  console.log(html.slice(0, 700));
} catch (e) {
  console.error("RENDER FAILED:", e && e.stack ? e.stack : String(e));
  process.exit(1);
}
