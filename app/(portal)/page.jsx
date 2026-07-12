import { redirect } from "next/navigation";
import { AgentDashboard } from "@/components/contact-center/AgentDashboard";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { resolveHomeDestination } from "@/lib/home-destination.mjs";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getAuthenticatedUser();
  if (!user) redirect("/signin");

  const destination = resolveHomeDestination(user.roles);
  if (destination) redirect(destination);

  return <AgentDashboard className="px-4 lg:px-6 pb-6" />;
}
