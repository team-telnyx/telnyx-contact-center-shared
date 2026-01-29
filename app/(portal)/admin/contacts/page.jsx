"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminContactsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/data-sources?view=contacts");
  }, [router]);

  return null;
}
