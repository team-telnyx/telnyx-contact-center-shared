export function workspaceLabelForPath(pathname = "") {
  if (pathname.startsWith("/agent")) return "AGENT";
  if (pathname.startsWith("/supervisor")) return "SUPERVISOR";
  if (pathname.startsWith("/admin") || pathname.startsWith("/settings")) {
    return "ADMIN";
  }
  return null;
}

export function workspaceMenuTarget(group, lastMenuByWorkspace = {}) {
  const items = Array.isArray(group?.items) ? group.items : [];
  if (items.length === 0) return null;
  if (group.label === "AGENT") return items[0].url || null;

  const rememberedUrl = lastMenuByWorkspace?.[group.label];
  const rememberedItem = items.find((item) => item.url === rememberedUrl);
  return rememberedItem?.url || items[0].url || null;
}
