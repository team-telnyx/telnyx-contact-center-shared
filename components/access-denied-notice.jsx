"use client";

import { useUiText } from "@/components/i18n/use-ui-text";
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { notify } from "@/components/ToastNotify";
import { screenLabel } from "@/lib/authz/permissions.mjs";

/**
 * The proxy sends a refused page to the home page with `?denied=<screen>`;
 * the home redirect carries it to the workspace the user may open. This
 * announces the missing screen once and removes the parameter from the URL.
 */
export function AccessDeniedNotice() {
  const tUi = useUiText();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const denied = searchParams.get("denied");
  const announced = useRef(null);

  useEffect(() => {
    if (!denied || announced.current === denied) return;
    announced.current = denied;
    const label = denied === "unknown" ? tUi("that page") : tUi(screenLabel(denied));
    notify({
      title: "Access denied",
      description: tUi("Your roles do not include {value0}. Ask an administrator to grant it in Permissions.", {value0: label}),
      variant: "error",
    });
    const next = new URLSearchParams(searchParams.toString());
    next.delete("denied");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [denied, pathname, router, searchParams, tUi]);

  return null;
}
