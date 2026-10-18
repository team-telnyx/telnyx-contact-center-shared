"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useEffect, useRef, useState, useCallback } from "react";
import { TelnyxAIAgentProvider } from "@telnyx/ai-agent-lib";
import VoiceTestHarness from "./voice-test-harness";

// Default test assistant (Healthcare Intake - the reference workflow)
const DEFAULT_ASSISTANT_ID = "assistant-00000000-0000-0000-0000-000000000000";

export default function VoiceTestPage() {
  const tUi = useUiText();
  const [assistantId, setAssistantId] = useState(DEFAULT_ASSISTANT_ID);
  const [scenario, setScenario] = useState("full_workflow");
  const [isRunning, setIsRunning] = useState(false);
  const [inputAssistantId, setInputAssistantId] = useState(DEFAULT_ASSISTANT_ID);

  const handleStart = () => {
    setAssistantId(inputAssistantId);
    setIsRunning(true);
  };

  const handleStop = () => {
    setIsRunning(false);
  };

  return (
    <div className="min-h-screen bg-zinc-900 text-white p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">{tUi("🎤 Voice Test Harness")}</h1>
        <p className="text-zinc-400 mb-8">{tUi("Test AI Assistant workflows using voice call + text injection")}</p>

        {!isRunning ? (
          <div className="bg-zinc-800 rounded-lg p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">{tUi("Configuration")}</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">{tUi("Assistant ID")}</label>
                <input
                  type="text"
                  value={inputAssistantId}
                  onChange={(e) => setInputAssistantId(e.target.value)}
                  className="w-full bg-zinc-700 border border-zinc-600 rounded px-3 py-2 text-white"
                  placeholder={tUi("assistant-xxx")}
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">{tUi("Test Scenario")}</label>
                <select
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value)}
                  className="w-full bg-zinc-700 border border-zinc-600 rounded px-3 py-2 text-white"
                >
                  <option value="full_workflow">{tUi("Full Healthcare Intake Workflow")}</option>
                  <option value="transfer_early">{tUi("Early Transfer to Human")}</option>
                  <option value="transfer_mid">{tUi("Mid-Workflow Transfer")}</option>
                  <option value="out_of_order">{tUi("Out of Order Info")}</option>
                </select>
              </div>

              <button
                onClick={handleStart}
                className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
              >{tUi("🚀 Start Voice Test")}</button>
            </div>
          </div>
        ) : (
          <TelnyxAIAgentProvider agentId={assistantId} debug={true}>
            <VoiceTestHarness
              assistantId={assistantId}
              scenario={scenario}
              onStop={handleStop}
            />
          </TelnyxAIAgentProvider>
        )}
      </div>
    </div>
  );
}
