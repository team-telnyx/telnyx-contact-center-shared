import { HELP_TOPICS } from "./help-registry.js";

export async function buildHelpSearchIndex(page) {
  const sourceStructuredData =
    typeof page.data.structuredData === "function"
      ? await page.data.structuredData()
      : page.data.structuredData;

  if (!sourceStructuredData) {
    throw new Error(`Missing structured help content for ${page.url}`);
  }

  const contextualContents = Object.values(HELP_TOPICS)
    .map((topic) => {
      const [articleUrl, anchor] = topic.articleHref.split("#", 2);
      if (articleUrl !== page.url) return null;

      return {
        heading: anchor || undefined,
        content: [topic.title, topic.summary, ...(topic.paragraphs || []), ...(topic.tips || [])]
          .filter(Boolean)
          .join(" "),
      };
    })
    .filter(Boolean);

  const keywordContent = page.data.keywords?.length
    ? [
        {
          heading: undefined,
          content: page.data.keywords.join(" "),
        },
      ]
    : [];

  return {
    id: page.url,
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    tag: page.data.audiences,
    structuredData: {
      headings: sourceStructuredData.headings,
      contents: [
        ...sourceStructuredData.contents,
        ...contextualContents,
        ...keywordContent,
      ],
    },
  };
}
