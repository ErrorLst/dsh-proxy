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

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-proxy",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    // ---- health alarm ----
    const POLL_INTERVAL_MS = 5000;
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
      const [checkFailures, setCheckFailures] = useState(
        value.healthCheckFailures ? String(value.healthCheckFailures) : ""
      );
      const [saved, setSaved] = useState(false);

      useEffect(() => {
        setProxyUrl(value.proxyUrl ?? "");
        setNoProxy(value.noProxy ?? "");
        setHealthEnabled(value.healthCheckEnabled !== false);
        setCheckUrl(value.healthCheckUrl ?? "");
        setCheckInterval(value.healthCheckInterval ? String(value.healthCheckInterval) : "");
        setCheckFailures(value.healthCheckFailures ? String(value.healthCheckFailures) : "");
        setSaved(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snapshot.revision]);

      const save = useCallback(async () => {
        await controller.set("proxyUrl", proxyUrl.trim());
        await controller.set("noProxy", noProxy.trim());
        await controller.set("healthCheckEnabled", healthEnabled);
        if (checkUrl.trim()) await controller.set("healthCheckUrl", checkUrl.trim());
        await controller.set("healthCheckInterval", Number(checkInterval) || 30);
        await controller.set("healthCheckFailures", Number(checkFailures) || 3);
        setSaved(true);
      }, [controller, proxyUrl, noProxy, healthEnabled, checkUrl, checkInterval, checkFailures]);

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
              placeholder: "30",
              onChange: (event) => setCheckInterval(event.target.value),
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
    }

    return { inject, apply };
  },
});
