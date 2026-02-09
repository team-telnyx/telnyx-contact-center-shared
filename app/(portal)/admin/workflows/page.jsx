"use client";

import { useState } from "react";
import WorkflowsListSheet from "@/components/contact-center/WorkflowsListSheet";
import WorkflowEditorSheet from "@/components/contact-center/WorkflowEditorSheet";

/**
 * Workflows Admin Page
 * 
 * This page now uses Sheet components for workflow management.
 * The list and editor are displayed as right-side sheets.
 */
export default function AdminWorkflowsPage() {
  const [listOpen, setListOpen] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(null);
  const [isNewWorkflow, setIsNewWorkflow] = useState(false);

  function handleEditWorkflow(workflow) {
    setSelectedWorkflowId(workflow.id);
    setIsNewWorkflow(false);
    setListOpen(false);
    setEditorOpen(true);
  }

  function handleNewWorkflow() {
    setSelectedWorkflowId(null);
    setIsNewWorkflow(true);
    setListOpen(false);
    setEditorOpen(true);
  }

  function handleBackToList() {
    setEditorOpen(false);
    setSelectedWorkflowId(null);
    setIsNewWorkflow(false);
    setListOpen(true);
  }

  function handleListClose(open) {
    setListOpen(open);
    // If closing the list without opening editor, we might want to redirect
    // For now, just close the sheet
  }

  function handleEditorClose(open) {
    if (!open) {
      handleBackToList();
    }
  }

  return (
    <>
      <WorkflowsListSheet
        open={listOpen}
        onOpenChange={handleListClose}
        onEditWorkflow={handleEditWorkflow}
        onNewWorkflow={handleNewWorkflow}
      />
      <WorkflowEditorSheet
        open={editorOpen}
        onOpenChange={handleEditorClose}
        workflowId={selectedWorkflowId}
        onBack={handleBackToList}
        isNew={isNewWorkflow}
      />
    </>
  );
}
