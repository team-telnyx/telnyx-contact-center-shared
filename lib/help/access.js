const DEFAULT_ROLE = "agent";

export function getHelpRolesFromSession(session) {
  const sessionRoles = Array.isArray(session?.user?.roles)
    ? session.user.roles
    : session?.user?.role
      ? [session.user.role]
      : [];
  const normalized = sessionRoles
    .map((role) => String(role || "").trim().toLowerCase())
    .filter(Boolean);

  return new Set(normalized.length > 0 ? normalized : [DEFAULT_ROLE]);
}

export function canAccessHelpPage(page, roles) {
  const audiences = page?.data?.audiences;
  if (!Array.isArray(audiences) || audiences.length === 0) return true;

  return audiences.some((audience) => roles.has(String(audience).toLowerCase()));
}

export function filterHelpPageTree(tree, roles, source) {
  const filterNode = (node) => {
    if (node.type === "page") {
      const page = source.getNodePage(node);
      return page && canAccessHelpPage(page, roles) ? { ...node } : null;
    }

    if (node.type === "folder") {
      const index = node.index ? filterNode(node.index) : null;
      const children = node.children.map(filterNode).filter(Boolean);

      if (!index && children.length === 0) return null;

      return {
        ...node,
        index: index || undefined,
        children,
      };
    }

    return { ...node };
  };

  return {
    ...tree,
    children: tree.children.map(filterNode).filter(Boolean),
    fallback: tree.fallback
      ? filterHelpPageTree(tree.fallback, roles, source)
      : undefined,
  };
}

export function filterHelpSearchResults(results, roles, source) {
  const allowedUrls = new Set(
    source
      .getPages()
      .filter((page) => canAccessHelpPage(page, roles))
      .map((page) => page.url),
  );

  return results.filter((result) => {
    const pageUrl = String(result.url || "").split("#", 1)[0];
    return allowedUrls.has(pageUrl);
  });
}
