import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_HELP_ID,
  HELP_TOPICS,
  getHelpTopic,
  resolveHelpTopic,
  resolveScreenHelpId,
} from "../lib/help/help-registry.js";
import { buildHelpSearchIndex } from "../lib/help/search-index.js";
import {
  MAX_HELP_SEARCH_LIMIT,
  mergeHelpSearchResultSets,
  parseHelpSearchLimit,
} from "../lib/help/search-query.js";
import {
  canAccessHelpPage,
  filterHelpPageTree,
  filterHelpSearchResults,
  getHelpRolesFromSession,
} from "../lib/help/access.js";

async function readHelpArticle(relativePath) {
  try {
    return await readFile(
      new URL(`../content/help/${relativePath}.mdx`, import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return readFile(
      new URL(`../content/help/${relativePath}/index.mdx`, import.meta.url),
      "utf8",
    );
  }
}

test("help registry entries are internally consistent and deep-link into /help", () => {
  for (const [helpId, topic] of Object.entries(HELP_TOPICS)) {
    assert.equal(topic.id, helpId);
    assert.ok(topic.title);
    assert.ok(topic.summary);
    assert.match(topic.articleHref, /^\/help(?:\/|$)/);

    if (topic.scope === "field") {
      assert.match(topic.articleHref, /#[a-z0-9-]+$/);
    }
  }
});

test("queue routes resolve to queue screen help, including nested paths", () => {
  assert.equal(resolveScreenHelpId("/admin/queues"), "admin.queues.screen");
  assert.equal(
    resolveScreenHelpId("/admin/queues/queue-123?tab=routing"),
    "admin.queues.screen",
  );
  assert.equal(resolveScreenHelpId("/admin/queues/"), "admin.queues.screen");
});

test("users and skills routes resolve to their administration guides", () => {
  assert.equal(resolveScreenHelpId("/admin/users"), "admin.users.screen");
  assert.equal(resolveScreenHelpId("/admin/skills"), "admin.skills.screen");
  assert.equal(
    getHelpTopic("admin.users.screen").articleHref,
    "/help/administration/users",
  );
  assert.equal(
    getHelpTopic("admin.skills.screen").articleHref,
    "/help/administration/skills",
  );
});

test("Agent and Supervisor routes resolve to their workspace guides", () => {
  const routes = [
    ["/agent/desktop", "agent.desktop.screen", "/help/agent"],
    ["/supervisor/monitor?section=agents", "supervisor.monitor.screen", "/help/supervisor/monitoring"],
    ["/supervisor/analytics?section=skills-gap", "supervisor.analytics.screen", "/help/supervisor/analytics"],
    ["/supervisor/call-history/call-1", "supervisor.analytics.screen", "/help/supervisor/analytics"],
    ["/supervisor/quality?section=evaluations", "supervisor.quality.screen", "/help/supervisor/quality"],
    ["/supervisor/outbound-dialer", "supervisor.outbound-dialer.screen", "/help/supervisor/outbound-dialer"],
  ];

  for (const [pathname, helpId, articleHref] of routes) {
    assert.equal(resolveScreenHelpId(pathname), helpId);
    assert.equal(getHelpTopic(helpId).articleHref, articleHref);
  }
});

test("Admin Workspace routes resolve to their detailed guides", () => {
  const routes = [
    ["/admin/statuses", "admin.statuses.screen", "statuses"],
    ["/admin/wrapup-codes", "admin.wrapup-codes.screen", "wrapup-codes"],
    ["/supervisor/scheduled-events", "admin.scheduled-events.screen", "scheduled-events"],
    ["/admin/numbers", "admin.numbers.screen", "numbers"],
    ["/admin/data-sources?view=tasks", "admin.data-sources.screen", "data-sources"],
    ["/admin/web-pages", "admin.web-pages.screen", "web-pages"],
    ["/admin/media-library", "admin.media-library.screen", "media-library"],
    ["/admin/domains", "admin.domains.screen", "domains"],
    ["/admin/mcp-servers", "admin.mcp-servers.screen", "mcp-servers"],
    ["/admin/secrets", "admin.secrets.screen", "secrets"],
    ["/settings", "admin.theme-settings.screen", "theme-settings"],
    ["/admin/ai-assistants/assistant-1", "admin.ai-assistants.screen", "ai-assistants"],
    ["/admin/tools-library", "admin.tools-library.screen", "tools-library"],
    ["/admin/insights", "admin.insights.screen", "insights"],
    ["/admin/system", "admin.system.screen", "system"],
    ["/admin/call-generator", "admin.call-generator.screen", "call-generator"],
    ["/admin/logging", "admin.logging.screen", "logging"],
    ["/admin/phones-provisioning?section=phones", "admin.phones-provisioning.screen", "phones-provisioning"],
    ["/admin/call-flows/flow-1", "admin.call-flows.screen", "call-flows"],
    ["/admin/workflows/workflow-1", "admin.workflows.screen", "workflows"],
    ["/admin/forms/form-1", "admin.forms.screen", "forms"],
  ];

  for (const [pathname, helpId, slug] of routes) {
    assert.equal(resolveScreenHelpId(pathname), helpId);
    assert.equal(
      getHelpTopic(helpId).articleHref,
      `/help/administration/${slug}`,
    );
  }
});

test("field help wins over screen help and invalid IDs fall back safely", () => {
  assert.equal(
    resolveHelpTopic({
      pathname: "/admin/queues",
      helpId: "admin.queues.form.max-wait-time",
    }).id,
    "admin.queues.form.max-wait-time",
  );

  assert.equal(
    resolveHelpTopic({ pathname: "/admin/queues", helpId: "missing" }).id,
    "admin.queues.screen",
  );
  assert.equal(resolveHelpTopic({ pathname: "/unknown" }).id, DEFAULT_HELP_ID);
  assert.equal(getHelpTopic("missing"), null);
});

test("queue UI help IDs resolve and the article renders the same canonical snippets", async () => {
  const [queueEditor, queueArticle] = await Promise.all([
    readFile(new URL("../components/queues/EditSheet.jsx", import.meta.url), "utf8"),
    readFile(
      new URL("../content/help/administration/queues.mdx", import.meta.url),
      "utf8",
    ),
  ]);
  const referencedIds = [
    ...queueEditor.matchAll(/data-help-id="([^"]+)"/g),
  ].map((match) => match[1]);

  assert.ok(referencedIds.length > 0);
  assert.equal(new Set(referencedIds).size, referencedIds.length);

  for (const helpId of referencedIds) {
    assert.ok(getHelpTopic(helpId), `missing registry topic for ${helpId}`);
    assert.match(
      queueArticle,
      new RegExp(`<HelpTopicContent helpId="${helpId.replaceAll(".", "\\.")}"`),
    );
  }
});

test("help search indexes canonical contextual copy and page keywords", async () => {
  const index = await buildHelpSearchIndex({
    url: "/help/administration/queues",
    data: {
      title: "Configure queues",
      description: "Queue configuration",
      audiences: ["admin", "owner"],
      keywords: ["ACD", "routing"],
      structuredData: {
        headings: [{ id: "maximum-wait-time", content: "Maximum wait time" }],
        contents: [{ heading: undefined, content: "Queues hold calls." }],
      },
    },
  });

  assert.deepEqual(index.tag, ["admin", "owner"]);
  assert.ok(
    index.structuredData.contents.some(
      (entry) =>
        entry.heading === "maximum-wait-time" &&
        entry.content.includes("does not currently apply overflow automatically"),
    ),
  );
  assert.ok(
    index.structuredData.contents.some((entry) => entry.content === "ACD routing"),
  );
});

test("help search parses optional limits and merges role-filtered result sets", () => {
  assert.equal(parseHelpSearchLimit(new URLSearchParams()), undefined);
  assert.equal(parseHelpSearchLimit(new URLSearchParams("limit=0")), undefined);
  assert.equal(parseHelpSearchLimit(new URLSearchParams("limit=invalid")), undefined);
  assert.equal(parseHelpSearchLimit(new URLSearchParams("limit=12")), 12);
  assert.equal(
    parseHelpSearchLimit(new URLSearchParams("limit=10000")),
    MAX_HELP_SEARCH_LIMIT,
  );

  assert.deepEqual(
    mergeHelpSearchResultSets([
      [
        { id: "shared", url: "/help/shared" },
        { id: "agent", url: "/help/agent" },
      ],
      [
        { id: "shared", url: "/help/shared" },
        { id: "admin", url: "/help/admin" },
      ],
    ]).map((result) => result.id),
    ["shared", "agent", "admin"],
  );
});

test("help audiences restrict pages, navigation, and search results by session role", () => {
  const agentRoles = getHelpRolesFromSession({ user: { roles: ["agent"] } });
  const adminRoles = getHelpRolesFromSession({ user: { roles: ["admin"] } });
  const agentPage = {
    url: "/help/agent",
    data: { audiences: ["agent", "admin"] },
  };
  const adminPage = {
    url: "/help/administration",
    data: { audiences: ["admin", "owner"] },
  };
  const pagesByUrl = new Map([
    [agentPage.url, agentPage],
    [adminPage.url, adminPage],
  ]);
  const source = {
    getPages: () => [agentPage, adminPage],
    getNodePage: (node) => pagesByUrl.get(node.url),
  };
  const tree = {
    name: "Help",
    children: [
      { type: "page", name: "Agent", url: agentPage.url },
      { type: "page", name: "Administration", url: adminPage.url },
    ],
  };

  assert.equal(canAccessHelpPage(adminPage, agentRoles), false);
  assert.equal(canAccessHelpPage(adminPage, adminRoles), true);
  assert.deepEqual(
    filterHelpPageTree(tree, agentRoles, source).children.map((node) => node.url),
    [agentPage.url],
  );
  assert.deepEqual(
    filterHelpSearchResults(
      [
        { url: `${agentPage.url}#during-an-interaction` },
        { url: `${adminPage.url}#setup-order` },
      ],
      agentRoles,
      source,
    ).map((result) => result.url),
    [`${agentPage.url}#during-an-interaction`],
  );
});

test("workspace folders use Overview as their first article title", async () => {
  const files = await Promise.all([
    readFile(new URL("../content/help/agent/index.mdx", import.meta.url), "utf8"),
    readFile(new URL("../content/help/supervisor/index.mdx", import.meta.url), "utf8"),
    readFile(new URL("../content/help/administration/index.mdx", import.meta.url), "utf8"),
  ]);

  for (const content of files) {
    assert.match(content, /^---\ntitle: Overview\n/);
  }
});

test("Admin Workspace overview documents the current menu, tiles, and rails", async () => {
  const [overview, menu, aiRail, configurationRail, systemRail, automationsRail] =
    await Promise.all([
      readFile(new URL("../content/help/administration/index.mdx", import.meta.url), "utf8"),
      readFile(new URL("../config/menu.jsx", import.meta.url), "utf8"),
      readFile(new URL("../components/assistants/AiAssistantsSectionNav.jsx", import.meta.url), "utf8"),
      readFile(new URL("../components/admin/ConfigurationSectionNav.jsx", import.meta.url), "utf8"),
      readFile(new URL("../components/admin/SystemSectionNav.jsx", import.meta.url), "utf8"),
      readFile(new URL("../components/admin/AutomationsSectionNav.jsx", import.meta.url), "utf8"),
    ]);

  for (const label of ["AI Assistants", "Configuration", "System", "Automations"]) {
    assert.match(menu, new RegExp(`title: ["']${label}["']`));
    assert.match(overview, new RegExp(`\\*\\*${label}\\*\\*`));
  }

  for (const rail of [aiRail, configurationRail, systemRail, automationsRail]) {
    for (const match of rail.matchAll(/label: "([^"]+)"/g)) {
      if (match[1] !== "Exit") assert.ok(overview.includes(match[1]));
    }
  }
});

test("every Admin Workspace navigation entry has a valid MDX article", async () => {
  const meta = JSON.parse(
    await readFile(
      new URL("../content/help/administration/meta.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(meta.title, "Admin Workspace");
  assert.equal(new Set(meta.pages).size, meta.pages.length);

  for (const slug of meta.pages) {
    const article = await readHelpArticle(`administration/${slug}`);
    assert.match(article, /^---\ntitle: .+\n/);
    assert.match(article, /\naudiences: \[admin, owner\]\n/);
  }
});

test("Automation documentation exposes detailed submenus and one page per Call Flow node", async () => {
  const sections = ["call-flows", "workflows", "forms"];
  for (const section of sections) {
    const meta = JSON.parse(
      await readFile(
        new URL(`../content/help/administration/${section}/meta.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.equal(meta.pages[0], "index");
    assert.ok(meta.pages.length > 4);
    for (const slug of meta.pages.filter((page) => page !== "nodes")) {
      const article = await readHelpArticle(`administration/${section}/${slug}`);
      assert.match(article, /^---\ntitle: .+\n/);
    }
  }

  const nodeMeta = JSON.parse(
    await readFile(
      new URL("../content/help/administration/call-flows/nodes/meta.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(nodeMeta.pages.length, 43);
  assert.equal(new Set(nodeMeta.pages).size, nodeMeta.pages.length);
  for (const slug of nodeMeta.pages) {
    const article = await readHelpArticle(`administration/call-flows/nodes/${slug}`);
    assert.match(article, /^---\ntitle: .+\n/);
  }
});

test("Agent, Supervisor, and shared WebRTC Phone navigation entries have valid role-aware articles", async () => {
  const sections = [
    ["agent", "Agent workspace", "agent|supervisor|admin|owner"],
    ["supervisor", "Supervisor workspace", "supervisor|admin|owner"],
    ["webrtc-phone", "WebRTC Phone", "agent|supervisor|admin|owner"],
  ];

  for (const [section, title, requiredAudience] of sections) {
    const meta = JSON.parse(
      await readFile(
        new URL(`../content/help/${section}/meta.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.equal(meta.title, title);
    assert.equal(meta.pages[0], "index");
    assert.equal(new Set(meta.pages).size, meta.pages.length);
    assert.ok(meta.pages.length >= 6);

    for (const slug of meta.pages) {
      const article = await readHelpArticle(`${section}/${slug}`);
      assert.match(article, /^---\ntitle: .+\n/);
      assert.match(article, new RegExp(`\\naudiences: \\[[^\\]]*(${requiredAudience})`));
    }
  }
});
