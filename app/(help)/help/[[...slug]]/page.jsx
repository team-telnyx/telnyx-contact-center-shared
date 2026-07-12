import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { getMDXComponents } from "@/mdx-components";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import {
  canAccessHelpPage,
  getHelpRolesFromSession,
} from "@/lib/help/access";
import { helpSource } from "@/lib/help/source";

async function getAuthorizedPage(params) {
  const { slug } = await params;
  const page = helpSource.getPage(slug);

  if (!page) notFound();

  const session = await getServerSession(authOptions);
  if (
    !session?.user ||
    !canAccessHelpPage(page, getHelpRolesFromSession(session))
  ) {
    notFound();
  }

  return page;
}

export default async function HelpPage({ params }) {
  const page = await getAuthorizedPage(params);
  const MDX = page.data.body;
  const isLandingPage = page.data.full === true;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      {!isLandingPage ? <DocsTitle>{page.data.title}</DocsTitle> : null}
      {!isLandingPage && page.data.description ? (
        <DocsDescription>{page.data.description}</DocsDescription>
      ) : null}
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const page = await getAuthorizedPage(params);

  return {
    title: `${page.data.title} | Contact Center Help`,
    description: page.data.description,
  };
}
