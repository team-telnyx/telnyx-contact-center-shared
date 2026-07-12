import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { RootProvider } from "fumadocs-ui/provider/next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  IconChartBar,
  IconHeadset,
  IconHistory,
  IconHome2,
  IconRocket,
  IconSettings,
  IconShieldCog,
  IconTool,
} from "@tabler/icons-react";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import {
  filterHelpPageTree,
  getHelpRolesFromSession,
} from "@/lib/help/access";
import { DocsTopBar } from "@/components/help/DocsTopBar";
import { DocsSidebarRestoreButton } from "@/components/help/DocsSidebarRestoreButton";
import { helpSource } from "@/lib/help/source";

const pageIcons = {
  "/help": IconHome2,
  "/help/setup": IconSettings,
  "/help/getting-started": IconRocket,
  "/help/troubleshooting": IconTool,
  "/help/changelog": IconHistory,
};

const folderIcons = {
  "Agent workspace": IconHeadset,
  "Supervisor workspace": IconChartBar,
  "Admin Workspace": IconShieldCog,
};

function decorateHelpPageTree(tree) {
  const decorateNode = (node) => {
    if (node.type === "page") {
      const Icon = pageIcons[node.url];
      return {
        ...node,
        name: node.url === "/help" ? "Home" : node.name,
        icon: Icon ? <Icon className="size-4" /> : node.icon,
      };
    }

    if (node.type === "folder") {
      const Icon = folderIcons[String(node.name)];
      return {
        ...node,
        icon: Icon ? <Icon className="size-4" /> : node.icon,
        index: node.index ? decorateNode(node.index) : undefined,
        children: node.children.map(decorateNode),
      };
    }

    return node;
  };

  return {
    ...tree,
    children: tree.children.map(decorateNode),
    fallback: tree.fallback ? decorateHelpPageTree(tree.fallback) : undefined,
  };
}

export default async function HelpLayout({ children }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/signin?callbackUrl=%2Fhelp");

  const roles = getHelpRolesFromSession(session);
  const pageTree = decorateHelpPageTree(
    filterHelpPageTree(helpSource.getPageTree(), roles, helpSource),
  );

  return (
    <RootProvider
      theme={{ enabled: false }}
      search={{ options: { api: "/api/help/search" } }}
    >
      <div className="help-docs-shell">
        <DocsTopBar />
        <DocsLayout
          tree={pageTree}
          nav={{ enabled: false }}
          sidebar={{ defaultOpenLevel: 2 }}
          containerProps={{ className: "help-docs-layout" }}
        >
          <DocsSidebarRestoreButton />
          {children}
        </DocsLayout>
      </div>
    </RootProvider>
  );
}
