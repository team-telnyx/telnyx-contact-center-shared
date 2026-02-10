"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  useTranscript,
  useClient,
  useConversation,
  useAgentState,
  useConnectionState,
  useSetTranscript,
} from "@telnyx/ai-agent-lib";

// Test scenarios with expected responses
const TEST_SCENARIOS = {
  full_workflow: {
    name: "Full Healthcare Intake Workflow",
    responses: [
      { trigger: "greeting", response: "Hello, I need to arrange a medical transport", waitForAI: true },
      { trigger: "name", response: "My name is John Smith", keywords: ["name", "who"] },
      { trigger: "facility", response: "I'm calling from Memorial Hospital", keywords: ["facility", "calling from", "hospital"] },
      { trigger: "callback", response: "You can reach me at 555-123-4567", keywords: ["callback", "number", "reach"] },
      { trigger: "confirm_callback", response: "Yes, that's correct", keywords: ["correct", "confirm", "555"] },
      { trigger: "intent", response: "I need a new transport", keywords: ["help", "assist", "how can"] },
      { trigger: "confirm_intent", response: "Yes, that's correct", keywords: ["transport", "correct", "arrange"] },
      { trigger: "patient_name", response: "The patient is Maria Garcia", keywords: ["patient", "name", "full name"] },
      { trigger: "patient_dob", response: "Date of birth is March 15, 1965", keywords: ["birth", "dob", "born"] },
      { trigger: "patient_weight", response: "She weighs about 140 pounds", keywords: ["weight", "weighs"] },
      { trigger: "patient_gender", response: "Female", keywords: ["gender"] },
      { trigger: "pickup_facility", response: "Pickup from Memorial Hospital", keywords: ["picking up", "pickup", "where"] },
      { trigger: "pickup_location", response: "Room 302 in the ICU", keywords: ["room", "location", "department", "floor"] },
      { trigger: "transport_reason", response: "Cardiac surgery", keywords: ["reason", "diagnosis", "transport"] },
      { trigger: "iv_count", response: "2 IV drips", keywords: ["iv", "drip", "infusion"] },
      { trigger: "special_equipment", response: "Oxygen support only", keywords: ["equipment", "ventilator", "oxygen"] },
      { trigger: "accompanying", response: "Yes, her husband will accompany", keywords: ["accompany", "family", "someone"] },
      { trigger: "isolation", response: "No isolation precautions needed", keywords: ["isolation", "precaution", "covid", "ppe"] },
      { trigger: "confirm_all", response: "Yes, all information is correct", keywords: ["correct", "confirm", "change"] },
      { trigger: "close", response: "No, that's all. Thank you!", keywords: ["anything else", "thank you", "goodbye"] },
    ],
  },
  transfer_early: {
    name: "Early Transfer to Human",
    responses: [
      { trigger: "greeting", response: "Hello", waitForAI: true },
      { trigger: "name", response: "My name is Jane Doe from City Hospital", keywords: ["name"] },
      { trigger: "transfer", response: "I need to speak to a human agent please", keywords: ["callback", "help", "how can"] },
    ],
  },
  transfer_mid: {
    name: "Mid-Workflow Transfer",
    responses: [
      { trigger: "greeting", response: "Hello, I need a new transport", waitForAI: true },
      { trigger: "name", response: "I'm Sarah Johnson from General Hospital", keywords: ["name"] },
      { trigger: "callback", response: "Callback is 555-987-6543", keywords: ["callback", "number"] },
      { trigger: "confirm", response: "Yes correct", keywords: ["correct"] },
      { trigger: "patient", response: "Patient is Robert Brown, DOB January 5, 1970, Male, 180 pounds", keywords: ["patient"] },
      { trigger: "transfer", response: "Actually, can I speak with a real person?", keywords: ["pickup", "where"] },
    ],
  },
  out_of_order: {
    name: "Out of Order Info",
    responses: [
      { trigger: "greeting", response: "Hi, I need transport for patient Maria Lopez from St. Mary's Hospital. I'm Dr. Chen, callback 555-111-2222", waitForAI: true },
      { trigger: "details", response: "She's 65 years old, female, 130 lbs, needs ventilator. Picking up from ICU room 405", keywords: ["patient", "birth", "weight", "pickup"] },
      { trigger: "more", response: "Heart failure, 3 IVs, her daughter will accompany. No isolation needed", keywords: ["reason", "iv", "accompany", "isolation"] },
      { trigger: "confirm", response: "Yes that's all correct", keywords: ["correct", "confirm"] },
      { trigger: "close", response: "Thank you", keywords: ["anything else", "thank"] },
    ],
  },
};

export default function VoiceTestHarness({ assistantId, scenario, onStop }) {
  const client = useClient();
  const transcript = useTranscript();
  const conversation = useConversation();
  const agentState = useAgentState();
  const connectionState = useConnectionState();
  const setTranscript = useSetTranscript();
  
  const [status, setStatus] = useState("initializing");
  const [currentStep, setCurrentStep] = useState(0);
  const [logs, setLogs] = useState([]);
  const [testResult, setTestResult] = useState(null);
  const [autoMode, setAutoMode] = useState(true);
  const [manualInput, setManualInput] = useState("");
  
  const audioRef = useRef(null);
  const lastProcessedRef = useRef(-1);
  const responseTimeoutRef = useRef(null);
  const testScenario = TEST_SCENARIOS[scenario] || TEST_SCENARIOS.full_workflow;
  const startTimeRef = useRef(null);

  const log = useCallback((message, type = "info") => {
    const timestamp = new Date().toLocaleTimeString();
    const entry = { timestamp, message, type };
    setLogs(prev => [...prev, entry]);
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
  }, []);

  // Setup audio playback
  useEffect(() => {
    if (conversation?.call?.remoteStream && audioRef.current) {
      audioRef.current.srcObject = conversation.call.remoteStream;
      log("Audio stream connected", "success");
    }
  }, [conversation, log]);

  // Start the call when component mounts
  useEffect(() => {
    if (!client) return;

    const startTest = async () => {
      try {
        log("Connecting to Telnyx platform...");
        setStatus("connecting");
        
        await client.connect();
        log("Connected! Starting conversation...");
        
        startTimeRef.current = Date.now();
        
        await client.startConversation({
          callerName: "Voice Test Harness",
          customHeaders: [
            { name: "X-Test-Run", value: "true" },
            { name: "X-Scenario", value: scenario },
          ],
        });
        
        setStatus("in_call");
        log("Conversation started!", "success");
        
      } catch (error) {
        log(`Error: ${error.message}`, "error");
        setStatus("error");
      }
    };

    startTest();

    return () => {
      if (responseTimeoutRef.current) {
        clearTimeout(responseTimeoutRef.current);
      }
    };
  }, [client, scenario, log]);

  // Find matching response based on AI's last message
  const findMatchingResponse = useCallback((aiMessage) => {
    const lowerMessage = aiMessage.toLowerCase();
    const responses = testScenario.responses;
    
    for (let i = currentStep; i < responses.length; i++) {
      const step = responses[i];
      
      // Check if any keyword matches
      if (step.keywords) {
        const hasMatch = step.keywords.some(kw => lowerMessage.includes(kw.toLowerCase()));
        if (hasMatch) {
          return { step, index: i };
        }
      }
    }
    
    // If no keyword match but we're waiting for AI's first response
    if (currentStep === 0 && responses[0]?.waitForAI) {
      return { step: responses[0], index: 0 };
    }
    
    return null;
  }, [currentStep, testScenario]);

  // Send response to AI
  const sendResponse = useCallback((text) => {
    if (!client) return;
    
    log(`📤 Sending: "${text}"`, "user");
    client.sendConversationMessage(text);
  }, [client, log]);

  // Process new transcript items
  useEffect(() => {
    // Debug: log all transcript changes
    if (transcript.length > 0) {
      const latest = transcript[transcript.length - 1];
      console.log("[Transcript Debug]", {
        length: transcript.length,
        latest: latest,
        role: latest.role,
        isFinal: latest.isFinal,
        content: latest.content?.substring(0, 50)
      });
    }
    
    if (!autoMode || !transcript.length) return;
    
    const latestIndex = transcript.length - 1;
    if (latestIndex <= lastProcessedRef.current) return;
    
    const latest = transcript[latestIndex];
    
    // Only process final assistant messages
    if (latest.role !== "assistant" || !latest.isFinal) return;
    
    lastProcessedRef.current = latestIndex;
    log(`🤖 AI: "${latest.content}"`, "assistant");
    
    // Clear any pending timeout
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current);
    }
    
    // Find and send matching response after a short delay
    responseTimeoutRef.current = setTimeout(() => {
      const match = findMatchingResponse(latest.content);
      
      if (match) {
        setCurrentStep(match.index + 1);
        sendResponse(match.step.response);
        
        // Check if we're done
        if (match.index >= testScenario.responses.length - 1) {
          setTimeout(() => {
            const duration = (Date.now() - startTimeRef.current) / 1000;
            setTestResult({
              passed: true,
              steps: match.index + 1,
              duration,
              transcript: transcript,
            });
            setStatus("completed");
            log(`✅ Test completed in ${duration.toFixed(1)}s`, "success");
          }, 2000);
        }
      } else {
        log(`⚠️ No matching response found for step ${currentStep}`, "warning");
      }
    }, 500);
    
  }, [transcript, autoMode, findMatchingResponse, sendResponse, currentStep, testScenario, log]);

  // Handle agent state changes
  useEffect(() => {
    if (agentState) {
      log(`Agent state: ${agentState}`, "state");
    }
  }, [agentState, log]);

  // Handle agent errors
  useEffect(() => {
    if (!client) return;
    
    const handleError = (error) => {
      const errorMessage = error?.message || error?.description || 
        (typeof error === 'object' ? JSON.stringify(error) : String(error));
      log(`❌ Agent Error: ${errorMessage}`, "error");
      console.error("Agent error details:", error);
    };
    
    client.on('agent.error', handleError);
    
    return () => {
      client.off('agent.error', handleError);
    };
  }, [client, log]);

  // End the call
  const handleEndCall = useCallback(() => {
    if (client) {
      client.endConversation();
      setStatus("ended");
      log("Call ended", "info");
    }
  }, [client, log]);

  // Manual message send
  const handleManualSend = () => {
    if (manualInput.trim()) {
      sendResponse(manualInput.trim());
      setManualInput("");
    }
  };

  return (
    <div className="space-y-6">
      {/* Status Bar */}
      <div className="bg-zinc-800 rounded-lg p-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${
            status === "in_call" ? "bg-green-500 animate-pulse" :
            status === "completed" ? "bg-blue-500" :
            status === "error" ? "bg-red-500" :
            "bg-yellow-500"
          }`} />
          <div>
            <div className="font-semibold">{testScenario.name}</div>
            <div className="text-sm text-zinc-400">
              Status: {status} | Step: {currentStep}/{testScenario.responses.length} | Agent: {agentState || "N/A"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoMode(!autoMode)}
            className={`px-3 py-1 rounded text-sm ${
              autoMode ? "bg-green-600" : "bg-zinc-600"
            }`}
          >
            {autoMode ? "Auto" : "Manual"}
          </button>
          <button
            onClick={handleEndCall}
            className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded"
          >
            End Call
          </button>
          <button
            onClick={onStop}
            className="bg-zinc-600 hover:bg-zinc-700 px-4 py-2 rounded"
          >
            Stop Test
          </button>
        </div>
      </div>

      {/* Audio Element (hidden but functional) */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />

      {/* Manual Input (when not in auto mode) */}
      {!autoMode && (
        <div className="bg-zinc-800 rounded-lg p-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={manualInput}
              onChange={(e) => setManualInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleManualSend()}
              placeholder="Type message to send..."
              className="flex-1 bg-zinc-700 border border-zinc-600 rounded px-3 py-2"
            />
            <button
              onClick={handleManualSend}
              className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Live Transcript */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">📝 Live Transcript</h3>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {transcript.length === 0 ? (
            <div className="text-zinc-500 text-center py-4">
              Waiting for conversation...
            </div>
          ) : (
            transcript.map((item, index) => (
              <div
                key={index}
                className={`p-2 rounded ${
                  item.role === "assistant"
                    ? "bg-zinc-700 border-l-4 border-green-500"
                    : "bg-zinc-700 border-l-4 border-blue-500"
                } ${!item.isFinal ? "opacity-50" : ""}`}
              >
                <div className="text-xs text-zinc-400 mb-1">
                  {item.role === "assistant" ? "🤖 AI" : "👤 User"}
                  {!item.isFinal && " (typing...)"}
                </div>
                <div>{item.content}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Test Log */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">📋 Test Log</h3>
        <div className="space-y-1 max-h-48 overflow-y-auto font-mono text-sm">
          {logs.map((entry, index) => (
            <div
              key={index}
              className={`${
                entry.type === "error" ? "text-red-400" :
                entry.type === "success" ? "text-green-400" :
                entry.type === "warning" ? "text-yellow-400" :
                entry.type === "user" ? "text-blue-400" :
                entry.type === "assistant" ? "text-green-300" :
                entry.type === "state" ? "text-purple-400" :
                "text-zinc-400"
              }`}
            >
              [{entry.timestamp}] {entry.message}
            </div>
          ))}
        </div>
      </div>

      {/* Test Result */}
      {testResult && (
        <div className={`rounded-lg p-6 ${
          testResult.passed ? "bg-green-900/50 border border-green-500" : "bg-red-900/50 border border-red-500"
        }`}>
          <h3 className="text-xl font-bold mb-2">
            {testResult.passed ? "✅ Test Passed!" : "❌ Test Failed"}
          </h3>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-zinc-400">Steps Completed</div>
              <div className="text-2xl font-bold">{testResult.steps}</div>
            </div>
            <div>
              <div className="text-zinc-400">Duration</div>
              <div className="text-2xl font-bold">{testResult.duration.toFixed(1)}s</div>
            </div>
            <div>
              <div className="text-zinc-400">Messages</div>
              <div className="text-2xl font-bold">{testResult.transcript.length}</div>
            </div>
          </div>
        </div>
      )}

      {/* Expected Steps Reference */}
      <div className="bg-zinc-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold mb-4">📋 Expected Steps</h3>
        <div className="space-y-1 text-sm">
          {testScenario.responses.map((step, index) => (
            <div
              key={index}
              className={`flex items-center gap-2 p-2 rounded ${
                index < currentStep
                  ? "bg-green-900/30 text-green-400"
                  : index === currentStep
                  ? "bg-blue-900/30 text-blue-400"
                  : "text-zinc-500"
              }`}
            >
              <span className="w-6 text-center">
                {index < currentStep ? "✓" : index === currentStep ? "→" : "○"}
              </span>
              <span className="font-medium">{step.trigger}:</span>
              <span className="text-zinc-400 truncate">{step.response}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
