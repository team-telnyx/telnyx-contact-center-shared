import { WIDGET_ICON_COMPONENTS } from "./icon-components.js";
import { normalizeWidgetIconId } from "./icon-catalog.js";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function attributeName(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function serializeNode([tag, attributes]) {
  const serialized = Object.entries(attributes || {})
    .filter(([name, value]) => name !== "key" && value !== undefined && value !== null && value !== false)
    .map(([name, value]) => `${attributeName(name)}="${escapeXml(value)}"`)
    .join(" ");
  return `<${tag}${serialized ? ` ${serialized}` : ""}/>`;
}

export function widgetIconSvgMarkup(name) {
  const normalized = normalizeWidgetIconId(name);
  const component = WIDGET_ICON_COMPONENTS[normalized] || WIDGET_ICON_COMPONENTS["message-circle"];
  const iconNode = component.render({}, null).props.iconNode;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconNode.map(serializeNode).join("")}</svg>`;
}
