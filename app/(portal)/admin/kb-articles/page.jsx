"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminKbArticlesPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/data-sources?view=kb-articles");
  }, [router]);

  return null;
}
