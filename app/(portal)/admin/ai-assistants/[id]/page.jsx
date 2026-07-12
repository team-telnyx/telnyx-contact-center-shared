"use client";

import { Suspense, use } from "react";
import AssistantEditor from "@/components/assistants/AssistantEditor";

export default function EditAiAssistantPage({ params }) {
  const { id } = use(params);
  return <Suspense fallback={null}><AssistantEditor mode="edit" assistantId={String(id || "")} /></Suspense>;
}
