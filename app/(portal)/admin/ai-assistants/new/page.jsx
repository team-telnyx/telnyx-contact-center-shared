"use client";

import { Suspense } from "react";
import AssistantEditor from "@/components/assistants/AssistantEditor";

export default function NewAiAssistantPage() {
  return <Suspense fallback={null}><AssistantEditor mode="create" /></Suspense>;
}
