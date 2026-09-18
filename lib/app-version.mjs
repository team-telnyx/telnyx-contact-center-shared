// Next replaces this expression at build time. Never read package.json, Git,
// the clock, or a remote "latest release" endpoint from the running app.
export const APP_BUILD = Object.freeze(JSON.parse(process.env.NEXT_PUBLIC_CC_BUILD_INFO || "null"));

export function versionInfoText(info = APP_BUILD) {
  if (!info) return "Contact Center version information unavailable";
  return [
    `Telnyx Contact Center ${info.displayVersion}`,
    `Build: ${info.buildId}`,
    `Commit: ${info.commit || "Unavailable"}`,
    `Built at: ${info.builtAt}`,
    `Channel: ${info.channel}`,
    `Working tree: ${info.dirty === null ? "Unknown" : info.dirty ? "Modified" : "Clean"}`,
  ].join("\n");
}
