(function () {
  "use strict";

  var script = document.currentScript;
  if (!script || script.dataset.loaded === "true") return;
  script.dataset.loaded = "true";
  var widgetId = script.dataset.widgetId;
  if (!widgetId) {
    console.error("[Telnyx widget] data-widget-id is required");
    return;
  }

  var baseUrl = new URL(script.src).origin;
  // Set by the Contact Center widget test page only; customer pages never carry it.
  var testGrant = script.dataset.testGrant || "";
  function bootstrapUrl(id) {
    return baseUrl + "/api/widgets/" + encodeURIComponent(id) + "/bootstrap" + (testGrant ? "?grant=" + encodeURIComponent(testGrant) : "");
  }
  fetch(bootstrapUrl(widgetId), {
    mode: "cors", credentials: "omit", cache: "no-store",
  })
    .then(function (response) {
      if (!response.ok) throw new Error("bootstrap returned " + response.status);
      return response.json();
    })
    .then(function (payload) {
      var evaluated = evaluateWidget(payload.widget);
      if (evaluated.visible) mount(evaluated.widget);
    })
    .catch(function (error) { console.error("[Telnyx widget] failed to initialize:", error); });

  function wildcardMatches(value, pattern) {
    if (!pattern) return false;
    if (!pattern.endsWith("*")) return value === pattern;
    return value.startsWith(pattern.slice(0, -1));
  }

  function matchesTargeting(targeting) {
    if (!targeting) return true;
    var width = window.innerWidth;
    var device = width <= 600 ? "mobile" : width <= 1024 ? "tablet" : "desktop";
    if (targeting.devices && targeting.devices[device] === false) return false;
    var path = window.location.pathname;
    if (targeting.includePaths && targeting.includePaths.length && !targeting.includePaths.some(function (entry) { return wildcardMatches(path, entry); })) return false;
    if (targeting.excludePaths && targeting.excludePaths.some(function (entry) { return wildcardMatches(path, entry); })) return false;
    return true;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function nestedValue(source, path) {
    if (!source) return undefined;
    if (Object.prototype.hasOwnProperty.call(source, path)) return source[path];
    return String(path || "").split(".").reduce(function (value, key) {
      return value == null ? undefined : value[key];
    }, source);
  }

  function cookieValue(name) {
    var prefix = encodeURIComponent(name) + "=";
    var entry = document.cookie.split(";").map(function (value) { return value.trim(); })
      .find(function (value) { return value.indexOf(prefix) === 0; });
    if (!entry) return undefined;
    try { return decodeURIComponent(entry.slice(prefix.length)); } catch (_) { return entry.slice(prefix.length); }
  }

  function dataLayerValue(path) {
    var layer = Array.isArray(window.dataLayer) ? window.dataLayer : [];
    for (var index = layer.length - 1; index >= 0; index -= 1) {
      var value = nestedValue(layer[index], path);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function collectDecisionContext(config) {
    var width = window.innerWidth;
    var context = {
      "page.path": window.location.pathname,
      "page.host": window.location.host,
      "page.url": window.location.href,
      "device.type": width <= 600 ? "mobile" : width <= 1024 ? "tablet" : "desktop",
      "visitor.locale": navigator.language || config.locale,
    };
    var hostContext = window.TelnyxWidgetContext || {};
    // Everything the page publishes travels on as Telnyx dynamic variables, not
    // only the keys declared as decision variables.
    Object.keys(hostContext).forEach(function (key) {
      var hostValue = hostContext[key];
      if (hostValue === null || hostValue === undefined) return;
      if (typeof hostValue === "object") return;
      context[key] = hostValue;
    });
    var query = new URLSearchParams(window.location.search);
    (config.decisions && config.decisions.variables || []).forEach(function (variable) {
      var key = variable.key;
      var leaf = key.split(".").pop();
      var value;
      if (variable.source === "query") value = query.get(key) ?? query.get(leaf);
      else if (variable.source === "cookie") value = cookieValue(key) ?? cookieValue(leaf);
      else if (variable.source === "data-layer") value = dataLayerValue(key) ?? dataLayerValue(leaf);
      else value = nestedValue(hostContext, key);
      if (value !== undefined && value !== null) context[key] = value;
    });
    return context;
  }

  function normalized(value) {
    return String(value == null ? "" : value).trim().toLocaleLowerCase();
  }

  function conditionMatches(condition, context) {
    var actual = nestedValue(context, condition.field);
    var expected = condition.value;
    var left = normalized(actual);
    var right = normalized(expected);
    var leftNumber = Number(actual);
    var rightNumber = Number(expected);
    switch (condition.operator) {
      case "exists": return actual !== undefined && actual !== null && left !== "";
      case "not-exists": return actual === undefined || actual === null || left === "";
      case "not-equals": return left !== right;
      case "contains": return left.indexOf(right) !== -1;
      case "not-contains": return left.indexOf(right) === -1;
      case "starts-with": return left.indexOf(right) === 0;
      case "ends-with": return left.endsWith(right);
      case "greater-than": return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber > rightNumber;
      case "greater-or-equal": return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber >= rightNumber;
      case "less-than": return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber < rightNumber;
      case "less-or-equal": return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber <= rightNumber;
      case "in": return String(expected == null ? "" : expected).split(",").map(normalized).indexOf(left) !== -1;
      default:
        if (typeof actual === "boolean") return actual === (expected === true || right === "true");
        return left === right;
    }
  }

  function interpolate(value, context) {
    return String(value == null ? "" : value).replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, function (_, key) {
      var replacement = nestedValue(context, key);
      return replacement == null ? "" : String(replacement);
    });
  }

  function localize(config, locale) {
    var snapshot = config.decisionLocales && (config.decisionLocales[locale] || config.decisionLocales[Object.keys(config.decisionLocales).find(function (key) {
      return key.split("-")[0].toLowerCase() === locale.split("-")[0].toLowerCase();
    })]);
    if (!snapshot) return;
    config.locale = locale;
    config.content = clone(snapshot.content);
    config.components.messages = clone(snapshot.messages);
    config.components.launcher = clone(snapshot.launcher);
    config.engagement.headsUp = clone(snapshot.headsUp);
  }

  function evaluateWidget(sourceWidget) {
    var widget = clone(sourceWidget);
    var config = widget.config;
    var context = collectDecisionContext(config);
    var visible = true;
    var routeQueueId = null;
    var surface = config.behavior.defaultSurface;
    if (config.decisions && config.decisions.enabled) {
      var rules = config.decisions.rules.filter(function (rule) { return rule.enabled; })
        .sort(function (left, right) { return left.priority - right.priority; });
      for (var index = 0; index < rules.length; index += 1) {
        var rule = rules[index];
        var matches = rule.conditions.map(function (condition) { return conditionMatches(condition, context); });
        var matched = rule.match === "any" ? matches.some(Boolean) : matches.every(Boolean);
        if (!matched) continue;
        rule.actions.forEach(function (action) {
          var value = interpolate(action.value, context);
          if (action.type === "visibility") visible = value !== "hidden" && value !== "false";
          if (action.type === "channels") {
            // Same set semantics as evaluateWidgetDecisions on the server: "both"
            // is messaging + voice, "all" adds video, a list selects explicitly.
            var allowed = value === "both" ? ["messaging", "voice"] : value === "all" ? ["messaging", "voice", "video"] : String(value || "").split(/[\s,]+/).filter(Boolean);
            config.channels.messaging.enabled = config.channels.messaging.enabled && allowed.indexOf("messaging") >= 0;
            config.channels.voice.enabled = config.channels.voice.enabled && allowed.indexOf("voice") >= 0;
            if (config.channels.video) config.channels.video.enabled = config.channels.video.enabled && allowed.indexOf("video") >= 0;
            if (!config.channels.messaging.enabled && !config.channels.voice.enabled && !(config.channels.video && config.channels.video.enabled)) visible = false;
          }
          if (action.type === "locale") localize(config, value);
          if (action.type === "surface") {
            surface = value;
            if (value !== "launcher") config.behavior.defaultSurface = value;
          }
          if (action.type === "launcher-delay") config.engagement.triggers.launcher.delaySeconds = Math.max(0, Math.min(3600, Number(value) || 0));
          if (action.type === "auto-open") {
            config.engagement.triggers.autoOpen.enabled = true;
            config.engagement.triggers.autoOpen.delaySeconds = Math.max(0, Math.min(3600, Number(value) || 0));
            config.engagement.triggers.autoOpen.surface = surface === "launcher" ? config.behavior.defaultSurface : surface;
          }
          if (action.type === "route-queue") routeQueueId = value;
          if (action.type === "customer-label") config.components.messages.customerLabel = value;
        });
        break;
      }
    }
    widget.config = config;
    widget.decisionContext = context;
    widget.decision = { routeQueueId: routeQueueId };
    return { widget: widget, visible: visible };
  }

  window.TelnyxWidget = window.TelnyxWidget || {};
  window.TelnyxWidget.setContext = function (nextContext) {
    window.TelnyxWidgetContext = Object.assign({}, window.TelnyxWidgetContext || {}, nextContext || {});
  };

  function mount(widget) {
    var config = widget.config;
    if (config.schemaVersion !== 2 || !matchesTargeting(config.targeting)) return;
    var rootId = "telnyx-widget-" + widget.id;
    // A page that embeds the snippet twice must still end up with one launcher,
    // otherwise the second launcher keeps floating next to the open panel.
    if (document.getElementById(rootId)) return;
    var dimensions = config.dimensions;
    var colors = config.theme.colors;
    var launcher = config.components.launcher;
    var triggers = config.engagement.triggers;
    var animation = config.engagement.animation || { launcherEntrance: "none", panelEntrance: "none", durationMs: 240 };
    // The entrance class is removed once it finishes: its filled-in transform would
    // otherwise outrank the attention loop and the expanded-preview geometry.
    function playEntrance(element, name) {
      if (!name || name === "none") return;
      element.classList.add("enter", "enter-" + name);
      var clear = function () { element.classList.remove("enter", "enter-" + name); };
      element.addEventListener("animationend", clear, { once: true });
      window.setTimeout(clear, animation.durationMs + 400);
    }
    var launcherSide = dimensions.launcherPosition === "bottom-left" ? "left" : "right";
    var launcherOtherSide = launcherSide === "left" ? "right" : "left";
    var panelSide = dimensions.panelPosition === "bottom-left" ? "left" : "right";
    var panelOtherSide = panelSide === "left" ? "right" : "left";

    var root = document.createElement("div");
    root.id = rootId;
    var shadow = root.attachShadow({ mode: "open" });
    document.body.appendChild(root);

    var style = document.createElement("style");
    style.textContent =
      ":host{all:initial}" +
      ".wrap{position:fixed;z-index:2147483000;bottom:" + dimensions.launcherOffsetY + "px;" + launcherSide + ":" + dimensions.launcherOffsetX + "px;" + launcherOtherSide + ":auto;font-family:" + JSON.stringify(config.theme.typography.fontFamily) + ",ui-sans-serif,system-ui,sans-serif;display:none;align-items:" + (launcherSide === "left" ? "flex-start" : "flex-end") + ";flex-direction:column;gap:10px}" +
      "button{font:inherit}" +
      ".fab{min-width:" + dimensions.fabSize + "px;height:" + dimensions.fabSize + "px;padding:0;border:0;background:" + launcher.backgroundColor + ";color:" + launcher.textColor + ";box-shadow:0 12px 36px rgba(0,0,0,.24);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:9px}" +
      ".fab.label{padding:0 " + Math.max(16, Math.round(dimensions.fabSize / 3)) + "px}" +
      ".fab.round{border-radius:999px}.fab.rounded{border-radius:16px}.fab.square{border-radius:2px}" +
      ".fab:focus-visible,.headsup-close:focus-visible{outline:3px solid " + colors.surface + ";box-shadow:0 0 0 5px " + launcher.backgroundColor + "}" +
      ".fab svg{width:" + Math.max(20, Math.round(dimensions.fabSize * .42)) + "px;height:" + Math.max(20, Math.round(dimensions.fabSize * .42)) + "px}.fab-label{font-weight:650;white-space:nowrap}" +
      ".badge{position:absolute;top:-4px;" + (launcherSide === "left" ? "left" : "right") + ":-4px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#dc2626;color:#fff;display:grid;place-items:center;font:700 11px/1 system-ui}.badge[hidden]{display:none}" +
      ".headsup{position:relative;width:min(280px,calc(100vw - 32px));box-sizing:border-box;padding:15px;border:1px solid " + colors.border + ";border-radius:" + config.theme.shape.panelRadius + "px;background:" + colors.surface + ";color:" + colors.text + ";box-shadow:0 14px 40px rgba(0,0,0,.2);display:none}.headsup.open{display:block}.headsup strong{display:block;margin:0 26px 4px 0;font-size:" + config.theme.typography.titleSize + "px}.headsup p{margin:0;color:" + colors.mutedText + ";font-size:" + config.theme.typography.baseSize + "px;line-height:1.4}.headsup-close{position:absolute;right:8px;top:8px;border:0;background:transparent;color:inherit;cursor:pointer}" +
      ".frame{position:fixed;z-index:2147482999;border:0;background:transparent;width:" + dimensions.panelWidth + "px;height:" + dimensions.panelHeight + "px;bottom:" + dimensions.panelOffsetY + "px;" + panelSide + ":" + dimensions.panelOffsetX + "px;" + panelOtherSide + ":auto;filter:drop-shadow(0 18px 42px rgba(0,0,0,.25))}" +
      ".pulse{animation:tn-pulse 2s ease-in-out infinite}.bounce{animation:tn-bounce 1.7s ease-in-out infinite}.fade{animation:tn-fade 2.8s ease-in-out infinite}@keyframes tn-pulse{50%{transform:scale(1.06)}}@keyframes tn-bounce{50%{transform:translateY(-7px)}}@keyframes tn-fade{50%{opacity:.62}}" +
      ".enter{animation-duration:" + animation.durationMs + "ms;animation-timing-function:cubic-bezier(.16,1,.3,1);animation-fill-mode:both}" +
      ".enter-fade{animation-name:tn-in-fade}.enter-scale{animation-name:tn-in-scale}.enter-slide-up{animation-name:tn-in-slide-up}.enter-drop{animation-name:tn-in-drop}.enter-slide-right{animation-name:tn-in-slide-right}" +
      "@keyframes tn-in-fade{from{opacity:0}}@keyframes tn-in-scale{from{opacity:0;transform:scale(.88)}}@keyframes tn-in-slide-up{from{opacity:0;transform:translateY(18px)}}@keyframes tn-in-drop{from{opacity:0;transform:translateY(-18px)}}@keyframes tn-in-slide-right{from{opacity:0;transform:translateX(26px)}}" +
      ".frame.enter-scale{transform-origin:" + (dimensions.panelPosition === "bottom-left" ? "bottom left" : "bottom right") + "}" +
      ".backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55)}" +
      ".cb-indicator{position:fixed;z-index:2147483003;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;max-width:calc(100vw - 24px);padding:10px 14px;border-radius:12px;background:#111827;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);font:600 13px/1.3 system-ui}" +
      ".cb-indicator button{border:1px solid #fff;border-radius:8px;background:#fff;color:#111827;padding:6px 12px;cursor:pointer;font-weight:700}" +
      ".cb-indicator button:focus-visible{outline:3px solid #facc15;outline-offset:3px}" +
      ".cb-dialog{position:fixed;inset:0;z-index:2147483004;display:grid;place-items:center;background:rgba(0,0,0,.65);font:14px/1.5 system-ui;color:#111827}" +
      ".cb-card{width:min(360px,calc(100vw - 32px));box-sizing:border-box;border-radius:16px;background:#fff;padding:22px;box-shadow:0 16px 48px rgba(0,0,0,.3)}" +
      ".cb-card h2{font-size:19px;margin:0 0 9px}.cb-card p{margin:8px 0}.cb-card strong{font-size:28px;letter-spacing:4px}.cb-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}.cb-actions button{border:1px solid #111827;border-radius:8px;padding:8px 12px;background:#fff;color:#111827;cursor:pointer}.cb-actions button.primary{background:#111827;color:#fff}" +
      "@media(prefers-reduced-motion:reduce){.pulse,.bounce,.fade,.enter{animation:none}}" +
      "@media(max-width:600px){.frame.full{inset:0;width:100vw;height:100dvh}.frame:not(.full){width:calc(100vw - 24px);height:min(" + dimensions.panelHeight + "px,calc(100dvh - 24px));bottom:12px;left:12px;right:auto}.wrap{bottom:12px;" + launcherSide + ":12px;" + launcherOtherSide + ":auto}}";
    shadow.appendChild(style);

    var capture = null;
    var captureSessionId = null;
    var captureScriptPromise = null;
    var indicator = null;
    var controlDialog = null;
    var controlStopButton = null;
    var controlPollTimer = null;
    var controlDecisionBusy = false;
    var controlRevokePending = false;
    var controlActivityTimer = null;
    var activeCaptureKey = "telnyx-cobrowse-active:" + widget.id;
    var pageSuspended = false;
    var captureGeneration = 0;
    function loadCaptureScript() {
      if (window.TelnyxCobrowseCapture) return Promise.resolve();
      if (!captureScriptPromise) captureScriptPromise = new Promise(function (resolve, reject) {
        var element = document.createElement("script");
        element.src = baseUrl + "/widget/v1/cobrowse.js";
        element.async = true;
        element.onload = function () { window.TelnyxCobrowseCapture ? resolve() : reject(new Error("capture unavailable")); };
        element.onerror = function () { reject(new Error("capture script blocked")); };
        document.head.appendChild(element);
      });
      return captureScriptPromise;
    }
    function removeIndicator() {
      captureGeneration += 1;
      clearTimeout(controlPollTimer);
      controlPollTimer = null;
      if (controlDialog) controlDialog.remove();
      controlDialog = null;
      controlRevokePending = false;
      clearTimeout(controlActivityTimer);
      controlActivityTimer = null;
      if (indicator) indicator.remove();
      indicator = null;
      controlStopButton = null;
      capture = null;
      captureSessionId = null;
      sessionStorage.removeItem(activeCaptureKey);
    }
    function showIndicator() {
      if (indicator) return indicator.firstChild;
      indicator = document.createElement("div");
      indicator.className = "cb-indicator";
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-live", "polite");
      var label = document.createElement("span");
      label.textContent = config.cobrowse.indicator.text;
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = "Stop sharing";
      button.setAttribute("aria-label", "Stop sharing this page");
      button.addEventListener("click", function () {
        if (capture) { void capture.stop(); return; }
        var previous = null;
        try { previous = JSON.parse(sessionStorage.getItem(activeCaptureKey) || "null"); } catch (_) { /* Remove malformed local state. */ }
        removeIndicator();
        if (previous) fetch(baseUrl + "/api/widget-cobrowse/sessions/" + previous.sessionId + "/stop", {
          method: "POST", mode: "cors", credentials: "omit", keepalive: true,
          headers: { Authorization: "Bearer " + previous.browserCredential },
        }).catch(function () {});
      });
      controlStopButton = document.createElement("button");
      controlStopButton.type = "button";
      controlStopButton.textContent = "Stop control";
      controlStopButton.hidden = true;
      controlStopButton.addEventListener("click", function () {
        capture?.setControlAllowed(false);
        controlRevokePending = true;
        controlStopButton.hidden = true;
        void decideControl("revoke");
      });
      indicator.appendChild(label);
      indicator.appendChild(controlStopButton);
      indicator.appendChild(button);
      shadow.appendChild(indicator);
      return label;
    }
    function controlCredential() {
      if (capture?.getCredential) return capture.getCredential();
      try { return JSON.parse(sessionStorage.getItem(activeCaptureKey) || "null")?.browserCredential; }
      catch (_) { return null; }
    }
    function hideControlDialog() {
      if (controlDialog) controlDialog.remove();
      controlDialog = null;
    }
    async function decideControl(decision) {
      if (controlDecisionBusy || !captureSessionId) return;
      controlDecisionBusy = true;
      var decidingSession = captureSessionId;
      try {
        const response = await fetch(baseUrl + "/api/widget-cobrowse/sessions/" + decidingSession + "/control", {
          method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
          headers: { Authorization: "Bearer " + controlCredential(), "Content-Type": "application/json" },
          body: JSON.stringify({ decision: decision }),
        });
        if (!response.ok) throw new Error("Could not save control decision");
        const data = await response.json();
        if (captureSessionId !== decidingSession) return;
        controlRevokePending = false;
        capture?.setControlAllowed(data.session?.controlLevel === "assist");
        if (controlStopButton) controlStopButton.hidden = data.session?.controlLevel !== "assist";
        hideControlDialog();
      } catch (_) {
        if (indicator?.firstChild) indicator.firstChild.textContent = "Control decision could not be saved; sharing remains active";
      } finally { controlDecisionBusy = false; }
    }
    function showControlDialog(agentName) {
      if (controlDialog) return;
      controlDialog = document.createElement("div");
      controlDialog.className = "cb-dialog";
      controlDialog.setAttribute("role", "dialog");
      controlDialog.setAttribute("aria-modal", "true");
      controlDialog.setAttribute("aria-label", "Agent control request");
      var card = document.createElement("div");
      card.className = "cb-card";
      var title = document.createElement("h2");
      title.textContent = "Allow agent to control this page?";
      var explanation = document.createElement("p");
      explanation.textContent = (agentName || "Your support agent") + " can click site-approved links and buttons and fill explicitly allowed fields in this tab. Password, payment, private fields and submit buttons stay blocked. You can stop control at any time.";
      var actions = document.createElement("div");
      actions.className = "cb-actions";
      [{ label: "Decline", decision: "decline" }, { label: "Allow control", decision: "accept", primary: true }].forEach(function (choice) {
        var action = document.createElement("button");
        action.type = "button";
        action.textContent = choice.label;
        if (choice.primary) action.className = "primary";
        action.addEventListener("click", function () { void decideControl(choice.decision); });
        actions.appendChild(action);
      });
      card.appendChild(title);
      card.appendChild(explanation);
      card.appendChild(actions);
      controlDialog.appendChild(card);
      shadow.appendChild(controlDialog);
    }
    function pollControl(generation) {
      if (pageSuspended || generation !== captureGeneration || !captureSessionId) return;
      fetch(baseUrl + "/api/widget-cobrowse/sessions/" + captureSessionId, {
        mode: "cors", credentials: "omit", cache: "no-store",
        headers: { Authorization: "Bearer " + controlCredential() },
      }).then(function (response) { if (!response.ok) throw new Error("Control state unavailable"); return response.json(); })
        .then(function (data) {
          if (generation !== captureGeneration || !captureSessionId) return;
          var state = data.session;
          if (!state || state.state === "ended") { capture?.setControlAllowed(false); hideControlDialog(); return; }
          if (controlRevokePending) { if (!controlDecisionBusy) void decideControl("revoke"); return; }
          var allowed = state.controlLevel === "assist";
          capture?.setControlAllowed(allowed);
          if (controlStopButton) controlStopButton.hidden = !allowed;
          if (indicator?.firstChild && !controlActivityTimer) {
            if (allowed) indicator.firstChild.textContent = "Agent control is active";
            else if (indicator.firstChild.textContent === "Agent control is active") indicator.firstChild.textContent = config.cobrowse.indicator.text;
          }
          if (state.controlRequestedAt && !allowed) showControlDialog(state.agentName);
          else hideControlDialog();
        }).catch(function () { capture?.setControlAllowed(false); })
        .finally(function () {
          if (generation === captureGeneration && !pageSuspended) controlPollTimer = setTimeout(function () { pollControl(generation); }, 1500);
        });
    }
    function startCapture(sessionId, browserCredential) {
      if (!config.cobrowse || !config.cobrowse.enabled) return;
      if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^cbr_[A-Za-z0-9_-]{43}$/.test(browserCredential)) return;
      if (capture && captureSessionId === sessionId) return;
      if (capture) void capture.stop();
      var generation = ++captureGeneration;
      captureSessionId = sessionId;
      var label = showIndicator();
      label.textContent = "Connecting page sharing…";
      sessionStorage.setItem(activeCaptureKey, JSON.stringify({ sessionId: sessionId, browserCredential: browserCredential }));
      pollControl(generation);
      loadCaptureScript().then(function () {
        if (pageSuspended || captureGeneration !== generation || captureSessionId !== sessionId) return;
        capture = window.TelnyxCobrowseCapture.start({
          baseUrl: baseUrl,
          sessionId: sessionId,
          browserCredential: browserCredential,
          privacy: config.cobrowse.privacy,
          onCredential: function (next) {
            if (captureGeneration === generation && !pageSuspended)
              sessionStorage.setItem(activeCaptureKey, JSON.stringify({ sessionId: sessionId, browserCredential: next }));
          },
          onStopped: function () { if (captureGeneration === generation) removeIndicator(); },
          onStatus: function (status) {
            if (!indicator || captureGeneration !== generation) return;
            label.textContent = status === "connected" ? config.cobrowse.indicator.text
              : status === "page_too_large" ? "This page is too large to share safely"
              : status === "capture_error" ? "Page sharing could not capture this page"
              : "Page sharing is reconnecting…";
          },
          onControlAction: function (action, accepted) {
            if (!indicator || captureGeneration !== generation) return;
            clearTimeout(controlActivityTimer);
            label.textContent = accepted ? "Agent action: " + action : "Blocked agent action: " + action;
            controlActivityTimer = setTimeout(function () {
              controlActivityTimer = null;
              if (indicator && captureGeneration === generation)
                label.textContent = controlStopButton && !controlStopButton.hidden ? "Agent control is active" : config.cobrowse.indicator.text;
            }, 2500);
          },
        });
      }).catch(function () {
        if (captureGeneration === generation && !pageSuspended) label.textContent = "Page sharing script was blocked by this site";
      });
    }
    var pairingDialog = null;
    var pairingTimer = null;
    var pairingState = null;
    function closePairing() {
      clearTimeout(pairingTimer);
      pairingTimer = null;
      if (pairingState && pairingState.pairingId && pairingState.pairingCredential && !pairingState.accepted) {
        fetch(baseUrl + "/api/widget-cobrowse/pairings/" + pairingState.pairingId + "/cancel", {
          method: "POST", mode: "cors", credentials: "omit", keepalive: true,
          headers: { Authorization: "Bearer " + pairingState.pairingCredential },
        }).catch(function () {});
      }
      pairingState = null;
      if (pairingDialog) pairingDialog.remove();
      pairingDialog = null;
    }
    function pairingContent(title, body, actions) {
      if (!pairingDialog) return;
      var card = pairingDialog.firstChild;
      card.replaceChildren();
      var heading = document.createElement("h2");
      heading.textContent = title;
      var text = document.createElement("p");
      text.textContent = body;
      var buttons = document.createElement("div");
      buttons.className = "cb-actions";
      actions.forEach(function (action) {
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        if (action.primary) button.className = "primary";
        button.addEventListener("click", action.run);
        buttons.appendChild(button);
      });
      card.appendChild(heading);
      card.appendChild(text);
      card.appendChild(buttons);
    }
    function beginPairing() {
      if (pairingDialog || !config.cobrowse || !config.cobrowse.enabled || !config.cobrowse.entryPoints.pairingCode) return;
      pairingDialog = document.createElement("div");
      pairingDialog.className = "cb-dialog";
      pairingDialog.setAttribute("role", "dialog");
      pairingDialog.setAttribute("aria-modal", "true");
      pairingDialog.setAttribute("aria-label", "Share this page");
      var card = document.createElement("div");
      card.className = "cb-card";
      pairingDialog.appendChild(card);
      shadow.appendChild(pairingDialog);
      pairingContent("Share this page", "Creating a code…", [{ label: "Cancel", run: closePairing }]);
      fetch(bootstrapUrl(widget.id), { mode: "cors", credentials: "omit", cache: "no-store" })
        .then(function (response) { if (!response.ok) throw new Error("Bootstrap unavailable"); return response.json(); })
        .then(function (payload) { return fetch(baseUrl + "/api/widgets/" + encodeURIComponent(widget.id) + "/cobrowse/pairings", {
          method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bootstrapToken: payload.widget.bootstrapToken }),
        }); })
        .then(function (response) { if (!response.ok) throw new Error("Could not create a pairing code"); return response.json(); })
        .then(function (result) {
          if (!pairingDialog) return;
          pairingState = { pairingId: result.pairingId, pairingCredential: result.browserCredential,
            browserCredential: result.browserCredential };
          pairingContent("Read this code to your agent", result.code + " · Expires in " + Math.ceil(config.cobrowse.pairing.seconds / 60) + " minutes. Sharing has not started.", [{ label: "Cancel", run: closePairing }]);
          function poll() {
            if (!pairingDialog || !pairingState) return;
            fetch(baseUrl + "/api/widget-cobrowse/pairings/" + result.pairingId, {
              mode: "cors", credentials: "omit", cache: "no-store",
              headers: { Authorization: "Bearer " + result.browserCredential },
            }).then(function (response) { if (!response.ok) throw new Error("Pairing unavailable"); return response.json(); })
              .then(function (state) {
                if (!pairingDialog || !pairingState) return;
                if (state.state === "claimed") {
                  pairingState.sessionId = state.sessionId;
                  pairingState.browserCredential = state.browserCredential;
                  return fetch(baseUrl + "/api/widget-cobrowse/sessions/" + state.sessionId, {
                    mode: "cors", credentials: "omit", cache: "no-store",
                    headers: { Authorization: "Bearer " + state.browserCredential },
                  }).then(function (response) { if (!response.ok) throw new Error("Session unavailable"); return response.json(); })
                    .then(function (details) {
                      var session = details.session;
                      pairingContent("Allow page sharing?", (session.agentName || state.agentName || "Support agent") + " can view this tab. Control requires a separate request and approval. Recording is off. " + (session.consent?.text || config.cobrowse.consent.text), [
                        { label: "Decline", run: closePairing },
                        { label: "Share this page", primary: true, run: function () {
                          pairingContent("Share this page", "Saving your decision…", []);
                          fetch(baseUrl + "/api/widget-cobrowse/sessions/" + state.sessionId + "/consent", {
                            method: "POST", mode: "cors", credentials: "omit", cache: "no-store",
                            headers: { Authorization: "Bearer " + state.browserCredential, "Content-Type": "application/json" },
                            body: JSON.stringify({ accepted: true }),
                          }).then(function (response) { if (!response.ok) throw new Error("Consent could not be saved"); return response.json(); })
                            .then(function (decision) {
                              pairingState.accepted = true;
                              startCapture(state.sessionId, decision.browserCredential);
                              closePairing();
                            }).catch(function () { pairingContent("Share this page", "Could not start sharing. Please try again.", [{ label: "Close", run: closePairing }]); });
                        } },
                      ]);
                    });
                }
                if (state.state !== "open") { pairingContent("Code expired", "Please generate a new code.", [{ label: "Close", run: closePairing }]); return; }
                pairingTimer = window.setTimeout(poll, 1000);
              }).catch(function () { pairingContent("Pairing unavailable", "Please try again.", [{ label: "Close", run: closePairing }]); });
          }
          poll();
        }).catch(function () { pairingContent("Pairing unavailable", "This site blocked the request or pairing is disabled.", [{ label: "Close", run: closePairing }]); });
    }
    if (config.cobrowse && config.cobrowse.enabled) {
      try {
        var previousCapture = JSON.parse(sessionStorage.getItem(activeCaptureKey) || "null");
        if (previousCapture) startCapture(previousCapture.sessionId, previousCapture.browserCredential);
      } catch (_) { sessionStorage.removeItem(activeCaptureKey); }
      window.addEventListener("pagehide", function () {
        pageSuspended = true;
        captureGeneration += 1;
        clearTimeout(controlPollTimer);
        controlPollTimer = null;
        clearTimeout(controlActivityTimer);
        controlActivityTimer = null;
        hideControlDialog();
        capture?.suspend();
        capture = null;
        captureSessionId = null;
        if (indicator) indicator.remove();
        indicator = null;
        controlStopButton = null;
      });
      window.addEventListener("pageshow", function (event) {
        if (!event.persisted || !pageSuspended) return;
        pageSuspended = false;
        try {
          var prior = JSON.parse(sessionStorage.getItem(activeCaptureKey) || "null");
          if (prior) startCapture(prior.sessionId, prior.browserCredential);
        } catch (_) { sessionStorage.removeItem(activeCaptureKey); }
      });
    }

    var wrap = document.createElement("div");
    wrap.className = "wrap";
    var messaging = config.channels.messaging.enabled;
    var voice = config.channels.voice.enabled;
    var video = Boolean(config.channels.video && config.channels.video.enabled);
    // The bootstrap response carries the callback experience beside the public
    // config, which never includes it.
    var callbacks = Boolean(widget.callbacks && widget.callbacks.enabled);
    var availableActionCount = Number(messaging) + Number(voice) + Number(video) + Number(callbacks) + Number(Boolean(config.cobrowse && config.cobrowse.enabled && config.cobrowse.entryPoints.pairingCode));
    var soleAction = callbacks ? "callbacks" : voice ? "voice" : video ? "video" : "messaging";
    var opening = false;
    // With more than one way to reach support the panel opens on its home
    // surface, which is the same screen the panel's home button returns to.
    var defaultAction = availableActionCount > 1 ? "home" : soleAction;

    var headsUp = document.createElement("div");
    headsUp.className = "headsup";
    headsUp.setAttribute("role", "status");
    var headsUpTitle = document.createElement("strong");
    headsUpTitle.textContent = config.engagement.headsUp.headline;
    var headsUpBody = document.createElement("p");
    headsUpBody.textContent = config.engagement.headsUp.body;
    headsUp.appendChild(headsUpTitle);
    headsUp.appendChild(headsUpBody);
    if (config.engagement.headsUp.showClose) {
      var headsUpClose = document.createElement("button");
      headsUpClose.type = "button";
      headsUpClose.className = "headsup-close";
      headsUpClose.setAttribute("aria-label", "Close");
      headsUpClose.textContent = "×";
      headsUpClose.addEventListener("click", function () { headsUp.classList.remove("open"); });
      headsUp.appendChild(headsUpClose);
    }

    var fab = document.createElement("button");
    fab.className = "fab " + launcher.shape + (launcher.style === "icon-label" ? " label" : "") + (launcher.animation !== "none" ? " " + launcher.animation : "");
    fab.type = "button";
    fab.setAttribute("aria-label", launcher.label || widget.name);
    fab.innerHTML = widget.launcherIconSvg || iconSvg(launcher.icon);
    if (launcher.style === "icon-label") {
      var label = document.createElement("span");
      label.className = "fab-label";
      label.textContent = launcher.label;
      fab.appendChild(label);
    }
    if (launcher.showUnreadBadge) {
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.hidden = true;
      badge.textContent = "";
      fab.appendChild(badge);
    }
    function setUnreadCount(value) {
      if (!badge) return;
      var count = Math.max(0, Math.floor(Number(value) || 0));
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? "99+" : String(count || "");
    }
    fab.addEventListener("click", function () {
      headsUp.classList.remove("open");
      if (availableActionCount > 1 && config.behavior.defaultSurface === "chat") openPanel("messaging");
      else if (availableActionCount > 1 && config.behavior.defaultSurface === "voice") openPanel("voice");
      else if (availableActionCount > 1 && config.behavior.defaultSurface === "video" && video) openPanel("video");
      else openPanel(defaultAction);
    });
    wrap.appendChild(headsUp);
    wrap.appendChild(fab);
    shadow.appendChild(wrap);

    var launcherShown = false;
    var showLauncher = function () {
      if (launcherShown) return;
      launcherShown = true;
      wrap.style.display = "flex";
      playEntrance(wrap, animation.launcherEntrance);
      removeTriggerListeners();
      if (config.engagement.headsUp.enabled) window.setTimeout(function () { headsUp.classList.add("open"); }, config.engagement.headsUp.delaySeconds * 1000);
      scheduleAutoOpen();
    };
    var scrollListener;
    var exitListener;
    function removeTriggerListeners() {
      if (scrollListener) window.removeEventListener("scroll", scrollListener);
      if (exitListener) document.removeEventListener("mouseout", exitListener);
    }
    var launcherTrigger = triggers.launcher;
    if (launcherTrigger.delaySeconds === 0 && launcherTrigger.scrollPercent === 0 && !launcherTrigger.exitIntent) showLauncher();
    if (launcherTrigger.delaySeconds > 0) window.setTimeout(showLauncher, launcherTrigger.delaySeconds * 1000);
    if (launcherTrigger.scrollPercent > 0) {
      scrollListener = function () {
        var scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        if ((window.scrollY / scrollable) * 100 >= launcherTrigger.scrollPercent) showLauncher();
      };
      window.addEventListener("scroll", scrollListener, { passive: true });
    }
    if (launcherTrigger.exitIntent) {
      exitListener = function (event) { if (event.clientY <= 0) showLauncher(); };
      document.addEventListener("mouseout", exitListener);
    }

    function scheduleAutoOpen() {
      if (!triggers.autoOpen.enabled || shouldSuppressAutoOpen()) return;
      window.setTimeout(function () {
        markAutoOpened();
        if (triggers.autoOpen.surface === "home") {
          openPanel(defaultAction);
        } else if (triggers.autoOpen.surface === "callbacks" && callbacks) {
          openPanel("callbacks");
        } else if (triggers.autoOpen.surface === "voice" && voice) {
          openPanel("voice");
        } else if (messaging) {
          openPanel("messaging");
        } else {
          openPanel(soleAction);
        }
      }, triggers.autoOpen.delaySeconds * 1000);
    }

    function shouldSuppressAutoOpen() {
      var sessionKey = "telnyx-widget-auto-open:" + widget.id;
      if (triggers.oncePerSession && window.sessionStorage.getItem(sessionKey)) return true;
      var last = Number(window.localStorage.getItem(sessionKey) || 0);
      return triggers.cooldownMinutes > 0 && Date.now() - last < triggers.cooldownMinutes * 60000;
    }

    function markAutoOpened() {
      var sessionKey = "telnyx-widget-auto-open:" + widget.id;
      window.sessionStorage.setItem(sessionKey, "1");
      window.localStorage.setItem(sessionKey, String(Date.now()));
    }

    var retained = null;
    function revealRetainedFrame() {
      wrap.style.display = "none";
      retained.frame.style.removeProperty("display");
      retained.frame.contentWindow.postMessage({ type: "telnyx-widget-visibility", visible: true }, baseUrl);
      setUnreadCount(0);
      opening = false;
      fab.disabled = false;
    }
    function discardRetainedFrame() {
      if (!retained) return;
      window.removeEventListener("message", retained.onMessage);
      retained.frame.remove();
      retained = null;
      setUnreadCount(0);
    }
    function openPanel(mode) {
      if (opening) return;
      if (retained) {
        opening = true;
        fab.disabled = true;
        revealRetainedFrame();
        return;
      }
      discardRetainedFrame();
      opening = true;
      fab.disabled = true;
      fetch(bootstrapUrl(widget.id), { mode: "cors", credentials: "omit", cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("bootstrap refresh returned " + response.status);
          return response.json();
        })
        .then(function (payload) {
          var evaluated = evaluateWidget(payload.widget);
          var enabled = mode === "home"
            ? true
            : mode === "callbacks"
              ? evaluated.widget.callbacks && evaluated.widget.callbacks.enabled
              : evaluated.widget.config.channels[mode] && evaluated.widget.config.channels[mode].enabled;
          if (!evaluated.visible || !enabled) throw new Error("channel disabled by a decision rule");
          openFrame(mode, evaluated.widget);
        })
        .catch(function (error) {
          console.error("[Telnyx widget] failed to open:", error);
          opening = false;
          fab.disabled = false;
        });
    }

    function openFrame(mode, runtimeWidget) {
      headsUp.classList.remove("open");
      wrap.style.display = "none";
      var frame = document.createElement("iframe");
      frame.className = "frame" + (runtimeWidget.config.behavior.mobileFullscreen ? " full" : "");
      frame.title = widget.name + " – " + mode;
      // The panel can move to the voice or video surface from its home screen,
      // so devices are granted whenever this widget offers those channels.
      // `autoplay` lets the waiting playlist start with sound after the visitor pressed Start call.
      frame.allow = video ? "microphone; camera; display-capture; autoplay" : voice ? "microphone" : "";
      frame.src = baseUrl + "/widget/frame?mode=" + encodeURIComponent(mode) + "&parentOrigin=" + encodeURIComponent(window.location.origin);
      function closeFrame() {
        collapseFrame();
        // Keeping the panel alive but hidden is the only way to notice messages
        // that arrive while it is closed; without the badge there is nothing to
        // report, so the session is torn down instead of polling forever.
        if (launcher.showUnreadBadge && hasMessagingSession && runtimeWidget.config.behavior.reopenBehavior !== "new") {
          frame.style.display = "none";
          frame.contentWindow.postMessage({ type: "telnyx-widget-visibility", visible: false }, baseUrl);
          retained = { frame: frame, onMessage: onMessage };
        } else {
          window.removeEventListener("message", onMessage);
          frame.remove();
        }
        wrap.style.display = "flex";
        opening = false;
        fab.disabled = false;
        fab.focus();
      }
      // A document preview or an expanded avatar can ask for more room than the
      // panel has. The frame is grown over the host page (optionally behind a
      // dimmed backdrop, for the avatar modal) and restored to its own geometry
      // afterwards.
      var collapsedStyle = null;
      var backdrop = null;
      function expandFrame(widthPercent, heightPercent, withBackdrop, aspectRatio, headerHeight) {
        if (collapsedStyle === null) collapsedStyle = frame.getAttribute("style") || "";
        // On phones the panel already spans the page; a modal narrower than
        // the panel would shrink the video instead of enlarging it.
        var width = window.innerWidth <= 600 ? 100 : Math.max(20, Math.min(100, Number(widthPercent) || 60));
        var height = Math.max(30, Math.min(100, Number(heightPercent) || 80));
        // An avatar or video modal follows the stage's aspect ratio (plus the
        // frame's own chrome): the width is the requested share of the page
        // unless the height limit is hit, in which case the modal narrows so
        // the stage keeps its proportions; a document preview takes the whole limit.
        var widthCss = width + "vw";
        var heightCss = height + "vh";
        if (Number(aspectRatio) > 0) {
          var chrome = Number(headerHeight) || 0;
          var widthPx = (width / 100) * window.innerWidth;
          var maxStage = (height / 100) * window.innerHeight - chrome;
          if (widthPx / Number(aspectRatio) > maxStage) widthPx = Math.max(maxStage, 0) * Number(aspectRatio);
          widthCss = Math.round(widthPx) + "px";
          heightCss = Math.round(widthPx / Number(aspectRatio) + chrome) + "px";
        }
        frame.style.cssText = "position:fixed;z-index:2147483001;border:0;background:transparent;" +
          "width:" + widthCss + ";height:" + heightCss + ";left:50%;top:50%;transform:translate(-50%,-50%);" +
          "right:auto;bottom:auto;filter:drop-shadow(0 18px 42px rgba(0,0,0,.35))";
        if (withBackdrop && !backdrop) {
          backdrop = document.createElement("div");
          backdrop.className = "backdrop";
          shadow.insertBefore(backdrop, frame);
        } else if (!withBackdrop && backdrop) {
          backdrop.remove();
          backdrop = null;
        }
      }
      function collapseFrame() {
        if (backdrop) { backdrop.remove(); backdrop = null; }
        if (collapsedStyle === null) return;
        frame.setAttribute("style", collapsedStyle);
        collapsedStyle = null;
      }
      // The video surface may ask for its own panel size (Widget Studio →
      // Video → Panel size); the size is kept behind an enlarged modal and
      // dropped when the surface closes. Phones keep the responsive panel.
      function setPanelSize(width, height) {
        // The "full" class only takes effect on phones (media query), so the
        // width check is the mobile guard; desktop panels resize freely.
        if (window.innerWidth <= 600) return;
        var css = width && height ? "width:" + Math.round(width) + "px;height:" + Math.round(height) + "px;" : "";
        if (collapsedStyle !== null) collapsedStyle = css;
        else frame.setAttribute("style", css);
      }
      var hasMessagingSession = false;
      function refreshFrameBootstrap(requestId) {
        fetch(bootstrapUrl(widget.id), {
          mode: "cors", credentials: "omit", cache: "no-store",
        })
          .then(function (response) {
            if (!response.ok) throw new Error("bootstrap refresh returned " + response.status);
            return response.json();
          })
          .then(function (payload) {
            var evaluated = evaluateWidget(payload.widget);
            if (!evaluated.visible) throw new Error("widget hidden by a decision rule");
            frame.contentWindow.postMessage({
              type: "telnyx-widget-bootstrap-response",
              requestId: requestId,
              widget: evaluated.widget,
            }, baseUrl);
          })
          .catch(function (error) {
            frame.contentWindow.postMessage({
              type: "telnyx-widget-bootstrap-response",
              requestId: requestId,
              error: error.message || "bootstrap refresh failed",
            }, baseUrl);
          });
      }
      function onMessage(event) {
        if (event.origin !== baseUrl || event.source !== frame.contentWindow) return;
        if (event.data && event.data.type === "telnyx-widget-session") hasMessagingSession = event.data.active === true;
        if (event.data && event.data.type === "telnyx-cobrowse-start") startCapture(event.data.sessionId, event.data.browserCredential);
        if (event.data && event.data.type === "telnyx-cobrowse-pair") beginPairing();
        if (event.data && event.data.type === "telnyx-widget-bootstrap-request" && event.data.widgetId === widget.id) refreshFrameBootstrap(event.data.requestId);
        if (event.data && event.data.type === "telnyx-widget-expand") expandFrame(event.data.widthPercent, event.data.heightPercent, event.data.backdrop === true, event.data.aspectRatio, event.data.headerHeight);
        if (event.data && event.data.type === "telnyx-widget-collapse") collapseFrame();
        if (event.data && event.data.type === "telnyx-widget-panel-size") setPanelSize(Number(event.data.width), Number(event.data.height));
        if (event.data && event.data.type === "telnyx-widget-panel-size-reset") setPanelSize(0, 0);
        if (event.data && event.data.type === "telnyx-widget-ready") frame.contentWindow.postMessage({ type: "telnyx-widget-config", widget: runtimeWidget, mode: mode }, baseUrl);
        if (event.data && event.data.type === "telnyx-widget-unread") setUnreadCount(event.data.count);
        // A widget with a single surface has no home screen to return to, so its
        // home button falls back to the launcher exactly like close.
        if (event.data && (event.data.type === "telnyx-widget-close" || event.data.type === "telnyx-widget-home")) closeFrame();
      }
      window.addEventListener("message", onMessage);
      shadow.appendChild(frame);
      playEntrance(frame, animation.panelEntrance);
    }
  }

  function iconSvg(icon) {
    var paths = {
      phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.33 1.84.56 2.8.69A2 2 0 0 1 22 16.92z"/>',
      headset: '<path d="M4 14a8 8 0 0 1 16 0"/><path d="M18 19c0 1.7-1.3 3-3 3h-1"/><path d="M4 14v3a2 2 0 0 0 2 2h1v-7H6a2 2 0 0 0-2 2z"/><path d="M20 14v3a2 2 0 0 1-2 2h-1v-7h1a2 2 0 0 1 2 2z"/>',
      chat: '<path d="M7 8h10M7 12h7"/><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
      message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
    };
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[icon] || paths.message) + "</svg>";
  }
})();
