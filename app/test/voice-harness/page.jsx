"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { TelnyxAIAgentProvider } from "@telnyx/ai-agent-lib";
import VoiceTestHarness from "./voice-test-harness";

// Default test assistant (Healthcare Intake - GMR)
const DEFAULT_ASSISTANT_ID = "assistant-06fd0ed6-69fd-4235-986b-72e5ae1af71c";

export default function VoiceTestPage() {
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
        <h1 className="text-3xl font-bold mb-2">🎤 Voice Test Harness</h1>
        <p className="text-zinc-400 mb-8">
          Test AI Assistant workflows using voice call + text injection
        </p>

        {!isRunning ? (
          <div className="bg-zinc-800 rounded-lg p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">Configuration</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  Assistant ID
                </label>
                <input
                  type="text"
                  value={inputAssistantId}
                  onChange={(e) => setInputAssistantId(e.target.value)}
                  className="w-full bg-zinc-700 border border-zinc-600 rounded px-3 py-2 text-white"
                  placeholder="assistant-xxx"
                />
              </div>

              <div>
                <label className="block text-sm text-zinc-400 mb-1">
                  Test Scenario
                </label>
                <select
                  value={scenario}
                  onChange={(e) => setScenario(e.target.value)}
                  className="w-full bg-zinc-700 border border-zinc-600 rounded px-3 py-2 text-white"
                >
                  <option value="full_workflow">Full Healthcare Intake Workflow</option>
                  <option value="transfer_early">Early Transfer to Human</option>
                  <option value="transfer_mid">Mid-Workflow Transfer</option>
                  <option value="out_of_order">Out of Order Info</option>
                </select>
              </div>

              <button
                onClick={handleStart}
                className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-3 px-6 rounded-lg transition-colors"
              >
                🚀 Start Voice Test
              </button>
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
