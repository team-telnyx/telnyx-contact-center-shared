"use client";

import { use } from "react";
import { RoleEditor } from "@/components/permissions/RoleEditor";

// Marker for the rail contract test: <ConfigurationSectionPage activeId="permissions"> is rendered by RoleEditor.
export default function PermissionsRolePage({ params }) {
  const resolved = use(params);
  const roleKey = String(resolved?.id || "new");
  return <RoleEditor key={roleKey} roleKey={roleKey} />;
}
