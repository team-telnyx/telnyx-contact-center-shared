import { publicWidgetConfig, widgetTestOrigin } from "./config.js";
import { widgetIconSvgMarkup } from "./icon-svg.js";
import { createWidgetBootstrapToken } from "./session-tokens.js";

export function buildWidgetBootstrapPayload(widget, { publicId, origin, testGrant = false }) {
  return {
    widget: {
      id: widget.public_id,
      name: widget.name,
      revision: widget.version,
      bootstrapToken: createWidgetBootstrapToken({
        publicId, revisionId: widget.revision_id,
        origin: testGrant ? widgetTestOrigin(origin) : origin,
      }),
      launcherIconSvg: widgetIconSvgMarkup(widget.config.components.launcher.icon),
      config: publicWidgetConfig(widget.config),
      callbacks: { enabled: false },
    },
  };
}
