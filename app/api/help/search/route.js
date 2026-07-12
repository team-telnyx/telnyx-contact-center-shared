import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { createFromSource } from "fumadocs-core/search/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import {
  filterHelpSearchResults,
  getHelpRolesFromSession,
} from "@/lib/help/access";
import { helpSource } from "@/lib/help/source";
import { buildHelpSearchIndex } from "@/lib/help/search-index";
import {
  DEFAULT_HELP_SEARCH_LIMIT,
  mergeHelpSearchResultSets,
  parseHelpSearchLimit,
} from "@/lib/help/search-query";

const helpSearch = createFromSource(helpSource, {
  language: "english",
  buildIndex: buildHelpSearchIndex,
});

export async function GET(request) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get("query");
  if (!query) return NextResponse.json([]);

  const roles = getHelpRolesFromSession(session);
  const limit = parseHelpSearchLimit(url.searchParams);
  const effectiveLimit = limit ?? DEFAULT_HELP_SEARCH_LIMIT;
  const searchOptions = {
    limit: effectiveLimit,
    locale: url.searchParams.get("locale"),
    mode: url.searchParams.get("mode") === "vector" ? "vector" : "full",
  };

  // Fumadocs combines multiple tags with `containsAll`, while application roles
  // are additive. Search once per role so every Orama result window is already
  // authorized, then merge and de-duplicate the ranked result sets.
  const resultSets = await Promise.all(
    [...roles].map((role) =>
      helpSearch.search(query, { ...searchOptions, tag: role }),
    ),
  );
  const results = mergeHelpSearchResultSets(resultSets);

  return NextResponse.json(
    filterHelpSearchResults(
      results,
      roles,
      helpSource,
    ).slice(0, effectiveLimit),
  );
}
