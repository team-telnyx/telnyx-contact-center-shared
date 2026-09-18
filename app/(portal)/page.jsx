import { redirect } from "next/navigation";
import { AgentDashboard } from "@/components/contact-center/AgentDashboard";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { resolveHomeDestination } from "@/lib/home-destination.mjs";
import { effectiveAccess } from "@/lib/authz/effective.mjs";
import { screenGrantsFor } from "@/lib/authz/page-access-server.mjs";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }) {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/signin");

  // The home is the first screen the user's roles grant (RBAC Phase 3).
  let screens = null;
  try {
    screens = screenGrantsFor(await effectiveAccess(user));
  } catch {
    screens = null;
  }
  const destination = resolveHomeDestination(user.roles, screens);
  const params = (await searchParams) || {};
  const denied = typeof params.denied === "string" && params.denied ? params.denied : null;
  if (destination) {
    // A refused page (proxy) carries the missing screen along so the workspace can explain it.
    redirect(denied ? `${destination}${destination.includes("?") ? "&" : "?"}denied=${encodeURIComponent(denied)}` : destination);
  }

  return <AgentDashboard className="px-4 lg:px-6 pb-6" />;
}
