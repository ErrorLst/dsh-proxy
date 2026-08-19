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

window.__ModuleLoader__.load({
  id: "@dsh-external/dsh-proxy",
  factory: (require) => {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

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
      const [saved, setSaved] = useState(false);

      useEffect(() => {
        setProxyUrl(value.proxyUrl ?? "");
        setNoProxy(value.noProxy ?? "");
        setSaved(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [snapshot.revision]);

      const save = useCallback(async () => {
        await controller.set("proxyUrl", proxyUrl.trim());
        await controller.set("noProxy", noProxy.trim());
        setSaved(true);
      }, [controller, proxyUrl, noProxy]);

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
    }

    return { inject, apply };
  },
});
