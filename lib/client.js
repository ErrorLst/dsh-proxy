// @dsh-external/dsh-proxy — browser half.
//
// Registered through the client-modules system: this bundle is served at
// `/plugins/@dsh-external/dsh-proxy/client.js`, executed once to register a
// factory under `window.__ModuleLoader__`, and materialized lazily. The
// factory returns the Cordis client plugin (`inject` + `apply`), which
// registers one piece of UI:
//
//   settings.section — "网络代理" card in the settings page. It edits the
//   "dsh-proxy" settings namespace (proxyUrl / noProxy) through the
//   settingsScope service; the host plugin watches the namespace and
//   re-applies the proxy dispatcher live, so saving the card takes effect
//   immediately — no dsh restart needed.
//
// Only `react` is required (a platform seed word). No JSX: build elements
// with React.createElement. Inline styles reference the theme CSS variables
// so the card follows the active theme.
//
// Proxy health alarm: the host plugin checks the proxy periodically and
// exposes the result at GET /dsh-proxy/status. This half polls that endpoint
// and, on the transition to `state: "broken"` (consecutive failures), shows a
// native-DOM modal popup — deliberately NOT a slot entry, because slots are
// declared by the shell and none is guaranteed mounted on every page. The
// popup closes on the recovery transition or when the user dismisses it.
//
// Update notification: the host plugin compares the installed dsh version
// with the official repo tags (startup + every `updateCheckIntervalMinutes`)
// and exposes the result at GET /dsh-proxy/update-status. This half polls
// that endpoint and, when an update is available, shows a popup with the
// version change and the AI-composed changelog (rendered as Markdown through
// the platform MarkdownText component, with a built-in markdown renderer as
// fallback so the source text is never shown raw). Dismissing mutes the
// version for the CURRENT program run only (in-memory, nothing is persisted):
// the popup comes back on the next dsh startup (the host serves a fresh
// bootId that clears the mute) or on a page reload. A newer tag always
// announces again.

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-proxy",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    // ---- health alarm & update notification ----
    const POLL_INTERVAL_MS = 5000;
    const UPDATE_POLL_INTERVAL_MS = 30000;
    const ALERT_Z_INDEX = 2147483000;

    function buildAlertOverlay(status) {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-dsh-proxy-alert", "1");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:" +
        ALERT_Z_INDEX +
        ";display:flex;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,0.45);";

      const card = document.createElement("div");
      card.style.cssText =
        "box-sizing:border-box;width:440px;max-width:calc(100vw - 48px);" +
        "border-radius:14px;padding:22px 24px;" +
        "background:var(--dsw-alias-surface-2,#ffffff);" +
        "border:1px solid var(--dsw-alias-border-l2);" +
        "box-shadow:0 12px 40px rgba(0,0,0,0.28);" +
        "color:var(--dsw-alias-label-primary);font-family:inherit;";

      const title = document.createElement("div");
      title.textContent = "\u26a0\ufe0f \u4ee3\u7406\u8fde\u63a5\u5f02\u5e38";
      title.style.cssText =
        "margin:0 0 10px;font-size:17px;font-weight:600;line-height:24px;" +
        "color:var(--dsw-alias-state-danger-primary,#e5484d);";

      const desc = document.createElement("p");
      desc.textContent =
        "\u8fde\u7eed " +
        status.failures +
        " \u6b21\u8bbf\u95ee " +
        status.checkUrl +
        " \u5931\u8d25\uff0cdsh \u51fa\u7ad9\u8bf7\u6c42\uff08LLM \u3001\u641c\u7d22\u3001\u8fdc\u7a0b MCP \uff09\u5f53\u524d\u65e0\u6cd5\u901a\u8fc7\u4ee3\u7406\u6b63\u5e38\u5de5\u4f5c\u3002";
      desc.style.cssText =
        "margin:0 0 12px;font-size:14px;line-height:22px;" +
        "color:var(--dsw-alias-label-secondary);";

      const details = document.createElement("p");
      const lastError = status.lastError ?? "\u672a\u77e5";
      const lastCheck = status.lastCheck ? new Date(status.lastCheck).toLocaleString() : "\u2014";
      details.textContent =
        "\u4ee3\u7406\u5730\u5740\uff1a" +
        (status.proxyUrl ?? "\u2014") +
        "\n\u6700\u8fd1\u9519\u8bef\uff1a" +
        lastError +
        "\n\u68c0\u6d4b\u65f6\u95f4\uff1a" +
        lastCheck;
      details.style.cssText =
        "margin:0 0 6px;font-size:12px;line-height:20px;white-space:pre-line;" +
        "color:var(--dsw-alias-label-tertiary);";

      const hint = document.createElement("p");
      hint.textContent = "\u63d0\u793a\uff1a\u4ee3\u7406\u6062\u590d\u540e\u6b64\u63d0\u793a\u4f1a\u81ea\u52a8\u5173\u95ed\u3002";
      hint.style.cssText =
        "margin:0 0 16px;font-size:12px;line-height:18px;" +
        "color:var(--dsw-alias-label-tertiary);";

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "\u77e5\u9053\u4e86";
      button.style.cssText =
        "box-sizing:border-box;height:36px;padding:0 18px;font-size:14px;font-family:inherit;" +
        "cursor:pointer;border:none;border-radius:18px;display:block;margin-left:auto;" +
        "background:var(--dsw-alias-button-primary-fill);" +
        "color:var(--dsw-alias-label-primary-foreground);";
      button.addEventListener("click", () => overlay.remove());

      card.append(title, desc, details, hint, button);
      overlay.append(card);
      return overlay;
    }

    function installHealthAlarm(ctx) {
      let wasBroken = false;
      let overlay = null;

      const dismiss = () => {
        if (overlay !== null) {
          overlay.remove();
          overlay = null;
        }
      };

      const poll = async () => {
        let status;
        try {
          const response = await fetch("/dsh-proxy/status", {
            signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) return;
          status = await response.json();
        } catch {
          return; // endpoint unreachable — nothing to alarm about
        }
        const broken = status.state === "broken";
        if (broken && !wasBroken && overlay === null) {
          overlay = buildAlertOverlay(status);
          document.body.append(overlay);
        } else if (!broken && wasBroken) {
          dismiss();
        }
        wasBroken = broken;
      };

      const timer = setInterval(poll, POLL_INTERVAL_MS);
      poll();
      ctx.effect(() => () => {
        clearInterval(timer);
        dismiss();
      });
    }

    // ---- built-in markdown fallback renderer ----
    // Renders the common changelog subset (headings, lists, fenced code,
    // blockquotes, hr, paragraphs, and inline bold/italic/code/links) into
    // DOM nodes. Every text goes through textContent, so no HTML injection is
    // possible. Used when the platform MarkdownText is unreachable, so the
    // popup never degrades to raw markdown source.
    function renderInlineMarkdown(text, container) {
      const tokenRe = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
      const parts = [];
      let last = 0;
      let match;
      while ((match = tokenRe.exec(text)) !== null) {
        if (match.index > last) parts.push({ kind: "text", value: text.slice(last, match.index) });
        const token = match[1];
        if (token.startsWith("**") && token.endsWith("**")) parts.push({ kind: "bold", value: token.slice(2, -2) });
        else if (token.startsWith("*") && token.endsWith("*")) parts.push({ kind: "italic", value: token.slice(1, -1) });
        else if (token.startsWith("`") && token.endsWith("`")) parts.push({ kind: "code", value: token.slice(1, -1) });
        else {
          const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
          if (link) parts.push({ kind: "link", value: link[1], url: link[2] });
          else parts.push({ kind: "text", value: token });
        }
        last = match.index + token.length;
      }
      if (last < text.length) parts.push({ kind: "text", value: text.slice(last) });
      for (const part of parts) {
        if (part.kind === "text") {
          container.append(document.createTextNode(part.value));
        } else if (part.kind === "bold") {
          const el = document.createElement("strong");
          el.textContent = part.value;
          container.append(el);
        } else if (part.kind === "italic") {
          const el = document.createElement("em");
          el.textContent = part.value;
          container.append(el);
        } else if (part.kind === "code") {
          const el = document.createElement("code");
          el.textContent = part.value;
          el.style.cssText =
            "padding:1px 5px;border-radius:4px;font-size:12px;" +
            "background:var(--dsw-alias-input-fill, rgba(127,127,127,0.12));" +
            "color:var(--dsw-alias-label-primary);";
          container.append(el);
        } else if (part.kind === "link") {
          const el = document.createElement("a");
          el.href = /^https?:\/\//i.test(part.url) ? part.url : "#";
          el.target = "_blank";
          el.rel = "noreferrer";
          el.textContent = part.value;
          el.style.cssText = "color:var(--dsw-alias-state-info-primary,#4a9eff);";
          container.append(el);
        }
      }
    }

    function renderMarkdownFallback(source, container) {
      const lines = String(source).split(/\r?\n/);
      let i = 0;
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed === "") {
          i += 1;
          continue;
        }
        if (/^```/.test(trimmed)) {
          const codeLines = [];
          i += 1;
          while (i < lines.length && !/^```/.test(lines[i].trim())) {
            codeLines.push(lines[i]);
            i += 1;
          }
          i += 1; // closing fence
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = codeLines.join("\n");
          pre.append(code);
          container.append(pre);
          continue;
        }
        if (/^#{1,6}\s+/.test(trimmed)) {
          const level = trimmed.match(/^#{1,6}/)[0].length;
          const el = document.createElement(level <= 3 ? "h" + level : "h4");
          el.textContent = trimmed.replace(/^#{1,6}\s*/, "");
          el.style.cssText =
            "margin:6px 0 4px;font-size:" + (level <= 1 ? "16px" : level === 2 ? "15px" : "14px") +
            ";font-weight:600;color:var(--dsw-alias-label-primary);";
          container.append(el);
          i += 1;
          continue;
        }
        if (/^[-*+]\s+/.test(trimmed)) {
          const list = document.createElement("ul");
          list.style.cssText = "margin:4px 0;padding-left:20px;";
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            const li = document.createElement("li");
            renderInlineMarkdown(lines[i].trim().replace(/^[-*+]\s+/, ""), li);
            list.append(li);
            i += 1;
          }
          container.append(list);
          continue;
        }
        if (/^\d+\.\s+/.test(trimmed)) {
          const list = document.createElement("ol");
          list.style.cssText = "margin:4px 0;padding-left:20px;";
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            const li = document.createElement("li");
            renderInlineMarkdown(lines[i].trim().replace(/^\d+\.\s+/, ""), li);
            list.append(li);
            i += 1;
          }
          container.append(list);
          continue;
        }
        if (/^>\s?/.test(trimmed)) {
          const quote = document.createElement("blockquote");
          const quoteLines = [];
          while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
            quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
            i += 1;
          }
          renderInlineMarkdown(quoteLines.join(" "), quote);
          container.append(quote);
          continue;
        }
        if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
          const hr = document.createElement("hr");
          container.append(hr);
          i += 1;
          continue;
        }
        const paragraphLines = [];
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\`\`\`)/.test(lines[i].trim())
        ) {
          paragraphLines.push(lines[i].trim());
          i += 1;
        }
        const paragraph = document.createElement("p");
        paragraph.style.cssText = "margin:4px 0;";
        renderInlineMarkdown(paragraphLines.join(" "), paragraph);
        container.append(paragraph);
      }
    }

    // ---- update notification ----
    function buildUpdateOverlay(status, onDismiss) {
      const overlay = document.createElement("div");
      overlay.setAttribute("data-dsh-proxy-update", "1");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:" +
        ALERT_Z_INDEX +
        ";display:flex;align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,0.45);";

      const card = document.createElement("div");
      card.style.cssText =
        "box-sizing:border-box;width:540px;max-width:calc(100vw - 48px);" +
        "max-height:calc(100vh - 80px);display:flex;flex-direction:column;" +
        "border-radius:14px;padding:22px 24px;" +
        "background:var(--dsw-alias-surface-2,#ffffff);" +
        "border:1px solid var(--dsw-alias-border-l2);" +
        "box-shadow:0 12px 40px rgba(0,0,0,0.28);" +
        "color:var(--dsw-alias-label-primary);font-family:inherit;";

      const title = document.createElement("div");
      title.textContent =
        "\ud83d\ude80 " + // 🚀
        "\u53d1\u73b0 dsh \u65b0\u7248\u672c"; // 发现 dsh 新版本
      title.style.cssText =
        "margin:0 0 8px;font-size:17px;font-weight:600;line-height:24px;" +
        "color:var(--dsw-alias-label-primary);";

      const meta = document.createElement("p");
      meta.textContent =
        "\u5f53\u524d\u7248\u672c " + // 当前版本
        (status.currentVersion ?? "\uff1f") +
        "  \u2192  \u6700\u65b0\u7248\u672c " + // → 最新版本
        (status.latestVersion ?? status.latestTag ?? "\uff1f");
      meta.style.cssText =
        "margin:0 0 10px;font-size:13px;line-height:20px;" +
        "color:var(--dsw-alias-state-success-primary,#3fb950);";

      // Changelog container: rendered through the platform MarkdownText
      // (GFM + code highlighting + KaTeX, safe links) when available, with a
      // plain-text fallback if the module is not reachable.
      const changelog = document.createElement("div");
      changelog.setAttribute("data-dsh-proxy-changelog", "1");
      changelog.style.cssText =
        "box-sizing:border-box;margin:0 0 10px;padding:10px 14px;flex:1;" +
        "overflow-y:auto;min-height:60px;max-height:320px;font-size:13px;" +
        "line-height:21px;word-break:break-word;" +
        "background:var(--dsw-alias-input-fill, rgba(127,127,127,0.06));" +
        "border:1px solid var(--dsw-alias-border-l2);border-radius:8px;" +
        "color:var(--dsw-alias-label-secondary);";
      let changelogRoot = null;
      const source = status.changelog ?? "";
      if (source.length > 0) {
        let rendered = false;
        try {
          const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
          const reactDomClient = require("react-dom/client");
          const MarkdownText = primitives && primitives.MarkdownText;
          if (typeof MarkdownText === "function" && reactDomClient && typeof reactDomClient.createRoot === "function") {
            changelogRoot = reactDomClient.createRoot(changelog, {
              onUncaughtError: (error) => {
                console.warn("[dsh-proxy] MarkdownText 渲染失败，改用内置渲染器：", error);
                changelog.textContent = "";
                renderMarkdownFallback(source, changelog);
              },
            });
            changelogRoot.render(React.createElement(MarkdownText, { text: source }));
            rendered = true;
          }
        } catch (error) {
          console.warn("[dsh-proxy] Markdown 渲染模块加载失败，改用内置渲染器：", error);
        }
        if (!rendered) renderMarkdownFallback(source, changelog);
      }

      const note = document.createElement("p");
      note.textContent = "\u66f4\u65b0\u65e5\u5fd7\u7531\u9ed8\u8ba4\u6a21\u578b\u6839\u636e\u5b98\u65b9\u53d1\u5e03\u8bf4\u660e\u6574\u7406"; // 更新日志由默认模型根据官方发布说明整理
      note.style.cssText =
        "margin:0 0 14px;font-size:11px;line-height:16px;" +
        "color:var(--dsw-alias-label-tertiary);";

      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;justify-content:flex-end;gap:10px;";

      const link = document.createElement("a");
      link.href = status.releaseUrl ?? "#";
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "\u67e5\u770b\u53d1\u5e03\u9875"; // 查看发布页
      link.style.cssText =
        "box-sizing:border-box;height:36px;padding:0 16px;font-size:14px;" +
        "font-family:inherit;line-height:36px;cursor:pointer;" +
        "text-decoration:none;border-radius:18px;display:inline-block;" +
        "background:var(--dsw-alias-button-primary-fill);" +
        "color:var(--dsw-alias-label-primary-foreground);";

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "\u77e5\u9053\u4e86"; // 知道了
      button.style.cssText =
        "box-sizing:border-box;height:36px;padding:0 18px;font-size:14px;" +
        "font-family:inherit;cursor:pointer;border:none;border-radius:18px;" +
        "background:var(--dsw-alias-button-primary-fill);" +
        "color:var(--dsw-alias-label-primary-foreground);";
      button.addEventListener("click", () => {
        if (changelogRoot !== null) changelogRoot.unmount();
        overlay.remove();
        if (typeof onDismiss === "function") onDismiss();
      });

      // Hand the markdown root to the notifier so its dismiss path can
      // unmount React as well (effect cleanup, page unload).
      if (changelogRoot !== null) overlay.__dshChangelogRoot = changelogRoot;

      row.append(link, button);
      card.append(title, meta, changelog, note, row);
      overlay.append(card);
      return overlay;
    }

    function installUpdateNotifier(ctx) {
      let overlay = null;
      // Dismissals are per CURRENT RUN only: tags muted in this page session
      // stay muted until the host restarts (the payload carries a fresh
      // bootId that clears the set) or the page reloads (the set is in
      // memory). Nothing is persisted.
      const dismissedTags = new Set();
      let seenBootId = null;

      const dismiss = () => {
        if (overlay !== null) {
          if (overlay.__dshChangelogRoot) overlay.__dshChangelogRoot.unmount();
          overlay.remove();
          overlay = null;
        }
      };

      const poll = async () => {
        let status;
        try {
          const response = await fetch("/dsh-proxy/update-status", {
            signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) return;
          status = await response.json();
        } catch {
          return; // endpoint unreachable — nothing to announce
        }
        if (!status || status.enabled !== true || !status.updateAvailable || !status.latestTag) return;
        // A new host run (dsh restarted) forgets every per-run dismissal.
        // The host serves a bootId since v0.2.0; while it is absent (older
        // host, not yet restarted) dismissals last for the page session and
        // are never auto-cleared — so an undefined bootId must NOT be treated
        // as "changed" on every poll.
        if (typeof status.bootId === "string" && status.bootId.length > 0) {
          if (status.bootId !== seenBootId) {
            seenBootId = status.bootId;
            dismissedTags.clear();
          }
        }
        if (overlay !== null) return;
        if (dismissedTags.has(status.latestTag)) return;
        overlay = buildUpdateOverlay(status, () => {
          if (status.latestTag) dismissedTags.add(status.latestTag);
          overlay = null;
        });
        document.body.append(overlay);
      };

      const timer = setInterval(poll, UPDATE_POLL_INTERVAL_MS);
      poll();
      ctx.effect(() => () => {
        clearInterval(timer);
        dismiss();
      });
    }

    const inject = ["slots", "settingsScope", "connection", "remote"];

    const CARD_STYLE = {
      maxWidth: "720px",
      color: "var(--dsw-alias-label-primary)",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    };
    const TITLE_STYLE = {
      margin: 0,
      fontSize: "16px",
      fontWeight: 500,
      lineHeight: "24px",
    };
    const INTRO_STYLE = {
      margin: 0,
      fontSize: "14px",
      lineHeight: "22px",
      color: "var(--dsw-alias-label-tertiary)",
    };
    const FIELD_STYLE = {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
    };
    const LABEL_STYLE = {
      fontSize: "13px",
      color: "var(--dsw-alias-label-secondary)",
    };
    const INPUT_STYLE = {
      boxSizing: "border-box",
      width: "100%",
      height: "36px",
      padding: "0 12px",
      fontSize: "14px",
      fontFamily: "inherit",
      color: "var(--dsw-alias-label-primary)",
      background: "var(--dsw-alias-input-fill, rgba(127,127,127,0.06))",
      border: "1px solid var(--dsw-alias-border-l2)",
      borderRadius: "8px",
      outline: "none",
    };
    const BUTTON_STYLE = {
      boxSizing: "border-box",
      height: "36px",
      padding: "0 16px",
      fontSize: "14px",
      cursor: "pointer",
      border: "none",
      borderRadius: "18px",
      background: "var(--dsw-alias-button-primary-fill)",
      color: "var(--dsw-alias-label-primary-foreground)",
    };
    const STATUS_STYLE = {
      margin: 0,
      fontSize: "12px",
      lineHeight: "18px",
      color: "var(--dsw-alias-label-tertiary)",
    };

    function ProxySection(props) {
      // Slot renderers spread the inject face directly onto component props
      // ({...kit, ...inject(), ...slotProps}); guard against missing wiring.
      const { controller } = props;
      if (controller === void 0) return null;

      const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
      useEffect(() => controller.subscribe(setSnapshot), [controller]);

      const value = snapshot.value ?? {};
      const [proxyUrl, setProxyUrl] = useState(value.proxyUrl ?? "");
      const [noProxy, setNoProxy] = useState(value.noProxy ?? "");
      const [healthEnabled, setHealthEnabled] = useState(value.healthCheckEnabled !== false);
      const [checkUrl, setCheckUrl] = useState(value.healthCheckUrl ?? "");
      const [checkInterval, setCheckInterval] = useState(
        value.healthCheckInterval ? String(value.healthCheckInterval) : ""
      );
      const [retryDelay, setRetryDelay] = useState(
        value.healthCheckRetryDelay !== undefined ? String(value.healthCheckRetryDelay) : ""
      );
      const [checkFailures, setCheckFailures] = useState(
        value.healthCheckFailures ? String(value.healthCheckFailures) : ""
      );
      const [updateEnabled, setUpdateEnabled] = useState(value.updateCheckEnabled !== false);
      const [updateInterval, setUpdateInterval] = useState(
        value.updateCheckIntervalMinutes ? String(value.updateCheckIntervalMinutes) : ""
      );
      const [saved, setSaved] = useState(false);

      useEffect(() => {
        setProxyUrl(value.proxyUrl ?? "");
        setNoProxy(value.noProxy ?? "");
        setHealthEnabled(value.healthCheckEnabled !== false);
        setCheckUrl(value.healthCheckUrl ?? "");
        setCheckInterval(value.healthCheckInterval ? String(value.healthCheckInterval) : "");
        setRetryDelay(
          value.healthCheckRetryDelay !== undefined ? String(value.healthCheckRetryDelay) : ""
        );
        setCheckFailures(value.healthCheckFailures ? String(value.healthCheckFailures) : "");
        setUpdateEnabled(value.updateCheckEnabled !== false);
        setUpdateInterval(
          value.updateCheckIntervalMinutes ? String(value.updateCheckIntervalMinutes) : ""
        );
        setSaved(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snapshot.revision]);

      const save = useCallback(async () => {
        await controller.set("proxyUrl", proxyUrl.trim());
        await controller.set("noProxy", noProxy.trim());
        await controller.set("healthCheckEnabled", healthEnabled);
        if (checkUrl.trim()) await controller.set("healthCheckUrl", checkUrl.trim());
        await controller.set("healthCheckInterval", Number(checkInterval) || 10);
        await controller.set("healthCheckRetryDelay", Number(retryDelay) || 2);
        await controller.set("healthCheckFailures", Number(checkFailures) || 3);
        await controller.set("updateCheckEnabled", updateEnabled);
        await controller.set("updateCheckIntervalMinutes", Number(updateInterval) || 30);
        setSaved(true);
      }, [
        controller,
        proxyUrl,
        noProxy,
        healthEnabled,
        checkUrl,
        checkInterval,
        retryDelay,
        checkFailures,
        updateEnabled,
        updateInterval,
      ]);

      const writable = snapshot.writable !== false;

      return React.createElement(
        "div",
        { style: CARD_STYLE },
        React.createElement("h3", { style: TITLE_STYLE }, "\u7f51\u7edc\u4ee3\u7406"),
        React.createElement(
          "p",
          { style: INTRO_STYLE },
          "\u914d\u7f6e dsh \u51fa\u7ad9\u8bf7\u6c42\u7684\u4ee3\u7406\uff08LLM\u3001\u641c\u7d22\u3001\u8fdc\u7a0b MCP \u7b49\u8d70\u5168\u5c40 fetch\uff09\u3002\u4fdd\u5b58\u540e\u7acb\u5373\u751f\u6548\uff0c\u65e0\u9700\u91cd\u542f\u3002\u4e0d\u586b\u5199\u65f6\u56de\u843d\u5230 HTTPS_PROXY/HTTP_PROXY \u73af\u5883\u53d8\u91cf\u3002"
        ),
        React.createElement(
          "div",
          { style: FIELD_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "\u4ee3\u7406\u5730\u5740"),
          React.createElement("input", {
            style: INPUT_STYLE,
            value: proxyUrl,
            placeholder: "http://127.0.0.1:7890",
            onChange: (event) => setProxyUrl(event.target.value),
            disabled: !writable,
          })
        ),
        React.createElement(
          "div",
          { style: FIELD_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "\u653e\u884c\u5217\u8868\uff08NO_PROXY\uff09"),
          React.createElement("input", {
            style: INPUT_STYLE,
            value: noProxy,
            placeholder: "127.0.0.1,localhost,::1",
            onChange: (event) => setNoProxy(event.target.value),
            disabled: !writable,
          })
        ),
        React.createElement(
          "h4",
          { style: { ...TITLE_STYLE, fontSize: "14px", margin: "14px 0 8px" } },
          "\u5065\u5eb7\u68c0\u6d4b"
        ),
        React.createElement(
          "label",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "13px",
              color: "var(--dsw-alias-label-secondary)",
            },
          },
          React.createElement("input", {
            type: "checkbox",
            checked: healthEnabled,
            onChange: (event) => setHealthEnabled(event.target.checked),
            disabled: !writable,
          }),
          "\u542f\u7528\u540e\u53f0\u68c0\u6d4b\uff1a\u5b9a\u671f\u901a\u8fc7\u4ee3\u7406\u8bbf\u95ee\u68c0\u6d4b\u5730\u5740\uff0c\u8fde\u7eed\u5931\u8d25\u65f6\u5f39\u7a97\u62a5\u8b66"
        ),
        React.createElement(
          "div",
          { style: FIELD_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "\u68c0\u6d4b\u5730\u5740"),
          React.createElement("input", {
            style: INPUT_STYLE,
            value: checkUrl,
            placeholder: "https://www.google.com/generate_204",
            onChange: (event) => setCheckUrl(event.target.value),
            disabled: !writable,
          })
        ),
        React.createElement(
          "div",
          { style: { display: "flex", gap: "12px" } },
          React.createElement(
            "div",
            { style: { ...FIELD_STYLE, flex: 1 } },
            React.createElement("label", { style: LABEL_STYLE }, "\u68c0\u6d4b\u95f4\u9694\uff08\u79d2\uff09"),
            React.createElement("input", {
              style: INPUT_STYLE,
              type: "number",
              min: 5,
              value: checkInterval,
              placeholder: "10",
              onChange: (event) => setCheckInterval(event.target.value),
              disabled: !writable,
            })
          ),
          React.createElement(
            "div",
            { style: { ...FIELD_STYLE, flex: 1 } },
            React.createElement(
              "label",
              { style: LABEL_STYLE },
              "\u5931\u8d25\u540e\u91cd\u8bd5\u5ef6\u8fdf\uff08\u79d2\uff09"
            ),
            React.createElement("input", {
              style: INPUT_STYLE,
              type: "number",
              min: 0,
              value: retryDelay,
              placeholder: "2",
              onChange: (event) => setRetryDelay(event.target.value),
              disabled: !writable,
            })
          ),
          React.createElement(
            "div",
            { style: { ...FIELD_STYLE, flex: 1 } },
            React.createElement("label", { style: LABEL_STYLE }, "\u8fde\u7eed\u5931\u8d25\u591a\u5c11\u6b21\u62a5\u8b66"),
            React.createElement("input", {
              style: INPUT_STYLE,
              type: "number",
              min: 1,
              value: checkFailures,
              placeholder: "3",
              onChange: (event) => setCheckFailures(event.target.value),
              disabled: !writable,
            })
          )
        ),
        React.createElement(
          "h4",
          { style: { ...TITLE_STYLE, fontSize: "14px", margin: "14px 0 8px" } },
          "\u66f4\u65b0\u68c0\u67e5"
        ),
        React.createElement(
          "label",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "13px",
              color: "var(--dsw-alias-label-secondary)",
            },
          },
          React.createElement("input", {
            type: "checkbox",
            checked: updateEnabled,
            onChange: (event) => setUpdateEnabled(event.target.checked),
            disabled: !writable,
          }),
          "\u542f\u7528\u66f4\u65b0\u68c0\u67e5\uff1a\u5b9a\u671f\u68c0\u67e5 dsh \u5b98\u65b9\u4ed3\u5e93\uff08deepseek-harness\uff09\u662f\u5426\u53d1\u5e03\u65b0\u7248\u672c\uff0c\u6709\u66f4\u65b0\u65f6\u5f39\u7a97\u63d0\u793a\u5e76\u9644 AI \u6574\u7406\u7684\u66f4\u65b0\u65e5\u5fd7"
        ),
        React.createElement(
          "div",
          { style: FIELD_STYLE },
          React.createElement("label", { style: LABEL_STYLE }, "\u68c0\u67e5\u95f4\u9694\uff08\u5206\u949f\uff09"),
          React.createElement("input", {
            style: INPUT_STYLE,
            type: "number",
            min: 5,
            value: updateInterval,
            placeholder: "30",
            onChange: (event) => setUpdateInterval(event.target.value),
            disabled: !writable,
          })
        ),
        React.createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "12px" } },
          React.createElement(
            "button",
            { style: BUTTON_STYLE, onClick: save, disabled: !writable },
            "\u4fdd\u5b58"
          ),
          saved
            ? React.createElement("span", { style: { ...STATUS_STYLE, color: "var(--dsw-alias-state-success-primary)" } }, "\u5df2\u4fdd\u5b58\uff0c\u4ee3\u7406\u5df2\u66f4\u65b0")
            : null
        ),
        React.createElement(
          "p",
          { style: STATUS_STYLE },
          "\u63d0\u793a\uff1a\u4ee3\u7406\u8f6f\u4ef6\u672a\u542f\u52a8\u65f6 dsh \u51fa\u7ad9\u8bf7\u6c42\u4f1a\u5931\u8d25\uff1b\u672c\u673a\u56de\u73af\u5730\u5740\u4e0d\u8d70\u4ee3\u7406\u3002"
        )
      );
    }

    function apply(ctx) {
      const controller = ctx.settingsScope.bind({ namespace: "dsh-proxy" });
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "dsh-proxy",
            order: 60,
            label: () => "\u7f51\u7edc\u4ee3\u7406",
            inject: () => ({ controller }),
          },
          ProxySection
        )
      );
      installHealthAlarm(ctx);
      installUpdateNotifier(ctx);
    }

    return { inject, apply };
  },
});
