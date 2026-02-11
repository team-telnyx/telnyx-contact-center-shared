"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconArrowLeft,
  IconPlayerPlay,
  IconPlayerStop,
  IconMessageCircle,
  IconPhone,
  IconRobot,
  IconUser,
  IconLoader2,
  IconSend,
  IconVolume,
  IconVolumeOff,
  IconMicrophone,
  IconMicrophoneOff,
  IconRefresh,
  IconCheck,
  IconX,
  IconAlertCircle,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { cn } from "@/lib/utils";

// Test scenarios for AI agent testing
const TEST_SCENARIOS = {
  healthcare_intake: {
    id: "healthcare_intake",
    name: "Complete Workflow",
    description: "Full patient intake process with all information collection",
    responses: [
      { waitForGreeting: true, text: "Hello, I need to arrange a medical transport" },
      { keywords: ["name", "who"], text: "My name is John Smith" },
      { keywords: ["facility", "calling from"], text: "I'm calling from Memorial Hospital" },
      { keywords: ["callback", "number", "reach"], text: "You can reach me at 555-123-4567" },
      { keywords: ["correct", "confirm"], text: "Yes, that's correct" },
      { keywords: ["help", "assist"], text: "I need a new transport" },
      { keywords: ["patient", "name"], text: "The patient is Maria Garcia" },
      { keywords: ["birth", "dob"], text: "Date of birth is March 15, 1965" },
      { keywords: ["weight"], text: "She weighs about 140 pounds" },
      { keywords: ["gender"], text: "Female" },
      { keywords: ["pickup", "where"], text: "Memorial Hospital, Room 302 ICU" },
      { keywords: ["reason", "diagnosis"], text: "Cardiac surgery" },
      { keywords: ["iv", "drip"], text: "2 IV drips" },
      { keywords: ["equipment"], text: "Oxygen support" },
      { keywords: ["accompany"], text: "Yes, her husband" },
      { keywords: ["isolation", "precaution"], text: "No isolation needed" },
      { keywords: ["confirm", "correct"], text: "Yes, all correct" },
      { keywords: ["anything else", "help"], text: "No, thank you!" },
    ],
  },
  early_transfer: {
    id: "early_transfer",
    name: "Early Transfer to Human Agent",
    description: "Customer immediately requests to speak with a human",
    responses: [
      { waitForGreeting: true, text: "I need to speak with a real person please" },
      { keywords: ["help", "assist", "sure"], text: "No, I really just want a human agent" },
      { keywords: ["transfer", "connect"], text: "Yes, please transfer me now" },
    ],
  },
  mid_workflow_transfer: {
    id: "mid_workflow_transfer",
    name: "Mid-Workflow Transfer",
    description: "Customer starts the process but requests transfer midway",
    responses: [
      { waitForGreeting: true, text: "Hello, I need help with my account" },
      { keywords: ["name", "who"], text: "My name is Sarah Johnson" },
      { keywords: ["account", "number"], text: "Actually, this is getting complicated. Can I speak to someone?" },
      { keywords: ["transfer", "help"], text: "Yes, please transfer me to an agent" },
    ],
  },
  out_of_order: {
    id: "out_of_order",
    name: "Out of Order Information",
    description: "Customer provides information in unexpected order",
    responses: [
      { waitForGreeting: true, text: "Hi, I'm John from City Hospital and the patient is Jane Doe born June 1980" },
      { keywords: ["confirm", "correct"], text: "Yes that's right" },
      { keywords: ["callback", "number"], text: "My number is 555-987-6543" },
      { keywords: ["help", "need"], text: "I need to schedule a transport for tomorrow" },
      { keywords: ["pickup", "address"], text: "Room 415, City Hospital on Main Street" },
      { keywords: ["anything else"], text: "No, that's everything" },
    ],
  },
  status_check: {
    id: "status_check",
    name: "Status Check Intent",
    description: "Customer wants to check existing request status",
    responses: [
      { waitForGreeting: true, text: "I want to check on a transport I scheduled" },
      { keywords: ["confirmation", "number", "id"], text: "The confirmation number is TR-12345" },
      { keywords: ["name", "verify"], text: "John Smith" },
      { keywords: ["else", "help"], text: "Can you tell me the ETA?" },
      { keywords: ["anything", "else"], text: "No thank you, that's all I needed" },
    ],
  },
  frustrated_customer: {
    id: "frustrated_customer",
    name: "Frustrated Customer",
    description: "Customer is upset and expresses frustration",
    responses: [
      { waitForGreeting: true, text: "I've been trying to get help all day and nobody can assist me!" },
      { keywords: ["sorry", "understand", "help"], text: "I just need someone who knows what they're doing" },
      { keywords: ["assist", "happy"], text: "Fine. I need to reschedule a transport" },
      { keywords: ["confirmation", "details"], text: "The confirmation is TR-99999" },
      { keywords: ["new", "time", "when"], text: "Tomorrow at 2 PM instead of today" },
      { keywords: ["confirm"], text: "Yes, that's fine" },
      { keywords: ["else"], text: "No. Goodbye." },
    ],
  },
};

// Message component
function Message({ message, isUser }) {
  return (
    <div className={cn("flex gap-3 mb-4", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "flex items-center justify-center w-8 h-8 rounded-full shrink-0",
          isUser
            ? "bg-blue-100 dark:bg-blue-900/50"
            : "bg-green-100 dark:bg-green-900/50"
        )}
      >
        {isUser ? (
          <IconUser className="size-4 text-blue-600 dark:text-blue-400" />
        ) : (
          <IconRobot className="size-4 text-green-600 dark:text-green-400" />
        )}
      </div>
      <div
        className={cn(
          "rounded-lg px-4 py-2 max-w-[80%]",
          isUser
            ? "bg-blue-500 text-white"
            : "bg-muted"
        )}
      >
        <p className="text-sm">{message.content}</p>
        <span className="text-xs opacity-70 mt-1 block">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

export default function TestAgentPage() {
  const router = useRouter();
  const params = useParams();
  const flowId = params.id;

  const [loading, setLoading] = useState(true);
  const [workflow, setWorkflow] = useState(null);
  const [selectedScenario, setSelectedScenario] = useState("healthcare_intake");
  const [channel, setChannel] = useState("chat"); // "chat" or "voice"
  const [isTestRunning, setIsTestRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  
  // Chat state
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [isAutoMode, setIsAutoMode] = useState(true);
  
  // Voice state
  const [voiceStatus, setVoiceStatus] = useState("idle"); // idle, connecting, active, error
  const [isMuted, setIsMuted] = useState(false);
  const [localAudioEnabled, setLocalAudioEnabled] = useState(true);
  const [agentState, setAgentState] = useState("idle");
  const [hasReceivedWelcomeMessage, setHasReceivedWelcomeMessage] = useState(false);
  
  // Agent state
  const [agentId, setAgentId] = useState(null);
  const [availableAgents, setAvailableAgents] = useState([]);
  
  // Chat conversation state
  const [conversationId, setConversationId] = useState(null);
  
  // Refs
  const messagesEndRef = useRef(null);
  const voiceClientRef = useRef(null);
  const audioContextRef = useRef(null);
  const autoModeRef = useRef(isAutoMode); // Track auto mode in ref for callbacks
  const welcomeMessageReceivedRef = useRef(false); // Track if welcome message was received
  
  // Keep autoModeRef in sync
  useEffect(() => {
    autoModeRef.current = isAutoMode;
  }, [isAutoMode]);

  // Load workflow data
  useEffect(() => {
    async function loadWorkflow() {
      try {
        const res = await fetch(`/api/admin/workflows/${flowId}`);
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Failed to load workflow");
        }
        setWorkflow(data.flow);
      } catch (err) {
        notify({
          title: "Error",
          description: err.message,
          variant: "error",
        });
        router.push(`/admin/workflows/${flowId}`);
      } finally {
        setLoading(false);
      }
    }
    loadWorkflow();
  }, [flowId, router]);

  // Load available agents (only those assigned to workflows)
  useEffect(() => {
    async function loadAgents() {
      try {
        const res = await fetch("/api/ai/assistants?pageSize=100&onlyWorkflowAssistants=true");
        const data = await res.json();
        if (data.ok && data.items) {
          setAvailableAgents(data.items);
          // Auto-select first agent if available
          if (data.items.length > 0 && !agentId) {
            setAgentId(data.items[0].id);
          }
        }
      } catch (err) {
        console.error("Failed to load agents:", err);
      }
    }
    loadAgents();
  }, [agentId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Get current scenario
  const currentScenario = TEST_SCENARIOS[selectedScenario];

  // Send chat message via REST API
  const sendChatMessage = useCallback(async (messageText, convId, stepIndex = null) => {
    if (!agentId || !convId) return null;
    
    setSendingMessage(true);
    
    // Add user message to UI
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: messageText,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      const res = await fetch(`/api/ai/assistants/${agentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: messageText,
          conversation_id: convId,
          name: "Test User",
        }),
      });
      
      const data = await res.json();
      setSendingMessage(false);
      
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Chat request failed");
      }
      
      const aiContent = data.content || data.response || "";
      
      // Add AI response to UI
      setMessages((prev) => [
        ...prev,
        {
          id: `ai-${Date.now()}`,
          role: "assistant",
          content: aiContent,
          timestamp: new Date().toISOString(),
        },
      ]);
      
      return aiContent;
    } catch (err) {
      setSendingMessage(false);
      notify({
        title: "Chat Error",
        description: err.message,
        variant: "error",
      });
      return null;
    }
  }, [agentId]);

  // Process AI response and send next scenario step if in auto mode
  const processAIResponse = useCallback(async (aiContent, convId, currentStepIndex) => {
    if (!autoModeRef.current || isPaused) return;
    
    const scenario = currentScenario;
    if (!scenario?.responses?.length) return;
    
    const lowerMessage = (aiContent || "").toLowerCase();
    
    // Find matching response based on keywords
    for (let i = currentStepIndex; i < scenario.responses.length; i++) {
      const step = scenario.responses[i];
      if (step.keywords) {
        const hasMatch = step.keywords.some(kw => lowerMessage.includes(kw.toLowerCase()));
        if (hasMatch) {
          setCurrentStep(i + 1);
          
          // Small delay before sending next message
          await new Promise(r => setTimeout(r, 1000));
          
          const nextResponse = await sendChatMessage(step.text, convId, i);
          
          // Check if test is complete
          if (i >= scenario.responses.length - 1) {
            setMessages((prev) => [
              ...prev,
              {
                id: "system-complete",
                role: "system",
                content: "✅ Test scenario completed successfully!",
                timestamp: new Date().toISOString(),
              },
            ]);
            return;
          }
          
          // Continue processing if we got a response
          if (nextResponse) {
            await processAIResponse(nextResponse, convId, i + 1);
          }
          return;
        }
      }
    }
  }, [currentScenario, isPaused, sendChatMessage]);

  // Create a new conversation via Telnyx API
  const createConversation = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Test: ${currentScenario.name}`,
          metadata: {
            test_scenario: selectedScenario,
            assistant_id: agentId,
          },
        }),
      });
      
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to create conversation");
      }
      
      return data.id;
    } catch (err) {
      console.error("Failed to create conversation:", err);
      throw err;
    }
  }, [currentScenario, selectedScenario, agentId]);

  // Start chat test - uses REST API endpoint
  const startChatTest = useCallback(async () => {
    if (!agentId) {
      notify({
        title: "No Assistant Selected",
        description: "Please select or create an AI assistant first.",
        variant: "error",
      });
      return;
    }

    // Create new conversation via API
    let newConversationId;
    try {
      newConversationId = await createConversation();
      setConversationId(newConversationId);
    } catch (err) {
      notify({
        title: "Failed to create conversation",
        description: err.message,
        variant: "error",
      });
      return;
    }
    
    setIsTestRunning(true);
    setMessages([]);
    setCurrentStep(0);
    setAgentState("active");

    // Add system message
    setMessages([
      {
        id: "system-start",
        role: "system",
        content: `Starting chat test: ${currentScenario.name} (REST API)`,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      // Step 1: Send "Hello" to get welcome message from AI
      const welcomeResponse = await sendChatMessage("Hello", newConversationId);
      
      if (!welcomeResponse) {
        throw new Error("No welcome message from AI");
      }

      // Wait a moment before sending first scenario message
      await new Promise(r => setTimeout(r, 1000));

      // Step 2: Send first scenario message
      const firstStep = currentScenario.responses[0];
      if (!firstStep) {
        throw new Error("No messages in scenario");
      }

      setCurrentStep(1);
      const firstResponse = await sendChatMessage(firstStep.text, newConversationId);
      
      if (!firstResponse) {
        throw new Error("No response from AI");
      }

      // In auto mode, continue with remaining messages
      if (isAutoMode && currentScenario.responses.length > 1) {
        await processAIResponse(firstResponse, newConversationId, 1);
      }

    } catch (err) {
      setAgentState("error");
      setIsTestRunning(false);
      notify({
        title: "Failed to start chat test",
        description: err.message,
        variant: "error",
      });
    }
  }, [agentId, currentScenario, isAutoMode, sendChatMessage, processAIResponse, createConversation]);

  // Send scenario message (manual mode) - uses REST API for chat, WebRTC for voice
  const sendScenarioMessage = useCallback(
    async (stepIndex) => {
      const scenario = currentScenario;
      if (!scenario || stepIndex >= scenario.responses.length) {
        setMessages((prev) => [
          ...prev,
          {
            id: "system-complete",
            role: "system",
            content: "✅ Test scenario completed successfully!",
            timestamp: new Date().toISOString(),
          },
        ]);
        return;
      }

      const step = scenario.responses[stepIndex];
      
      if (channel === "chat" && conversationId) {
        // Chat mode - use REST API
        await sendChatMessage(step.text, conversationId, stepIndex);
        setCurrentStep(stepIndex + 1);
      } else if (voiceClientRef.current) {
        // Voice mode - use WebRTC
        voiceClientRef.current.sendConversationMessage(step.text);
        setMessages((prev) => [
          ...prev,
          {
            id: `user-${Date.now()}`,
            role: "user",
            content: step.text,
            timestamp: new Date().toISOString(),
          },
        ]);
        setCurrentStep(stepIndex + 1);
      }
    },
    [currentScenario, channel, conversationId, sendChatMessage]
  );

  // Send manual message - uses REST API for chat, WebRTC for voice
  const sendMessage = useCallback(async () => {
    if (!inputMessage.trim() || sendingMessage) return;

    const messageText = inputMessage.trim();
    setInputMessage("");
    
    if (channel === "chat" && conversationId) {
      // Chat mode - use REST API
      const response = await sendChatMessage(messageText, conversationId);
      // In auto mode, process the response for next steps
      if (isAutoMode && response) {
        await processAIResponse(response, conversationId, currentStep);
      }
    } else if (voiceClientRef.current) {
      // Voice mode - use WebRTC
      voiceClientRef.current.sendConversationMessage(messageText);
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: "user",
          content: messageText,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  }, [inputMessage, sendingMessage, channel, conversationId, sendChatMessage, isAutoMode, processAIResponse, currentStep]);

  // Stop test
  const stopTest = useCallback(() => {
    setIsTestRunning(false);
    setIsPaused(false);
    setMessages((prev) => [
      ...prev,
      {
        id: "system-stopped",
        role: "system",
        content: "Test stopped by user",
        timestamp: new Date().toISOString(),
      },
    ]);

    // Clean up voice if active
    if (voiceClientRef.current) {
      try {
        voiceClientRef.current.endConversation?.();
        voiceClientRef.current.disconnect?.();
      } catch (e) {
        // Ignore cleanup errors
      }
      voiceClientRef.current = null;
    }
    setVoiceStatus("idle");
  }, []);

  // Reset test
  const resetTest = useCallback(() => {
    setIsTestRunning(false);
    setIsPaused(false);
    setMessages([]);
    setCurrentStep(0);
    setVoiceStatus("idle");
    setAgentState("idle");
    setHasReceivedWelcomeMessage(false);
    welcomeMessageReceivedRef.current = false;
  }, []);

  // Start voice test
  const startVoiceTest = useCallback(async () => {
    if (!agentId) {
      notify({
        title: "No Assistant Selected",
        description: "Please select or create an AI assistant first.",
        variant: "error",
      });
      return;
    }

    setIsTestRunning(true);
    setVoiceStatus("connecting");
    setHasReceivedWelcomeMessage(false);
    welcomeMessageReceivedRef.current = false;
    setCurrentStep(0);
    setMessages([
      {
        id: "system-voice-start",
        role: "system",
        content: `Starting voice test: ${currentScenario.name}`,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      // Dynamic import of TelnyxAIAgent
      const { TelnyxAIAgent } = await import("@telnyx/ai-agent-lib");

      const client = new TelnyxAIAgent({
        agentId: agentId,
        debug: true,
      });

      voiceClientRef.current = client;

      // Set up event handlers
      client.on("agent.connected", () => {
        setVoiceStatus("active");
        setMessages((prev) => [
          ...prev,
          {
            id: "system-connected",
            role: "system",
            content: "Connected to AI Agent",
            timestamp: new Date().toISOString(),
          },
        ]);
      });

      client.on("agent.disconnected", () => {
        setVoiceStatus("idle");
        setIsTestRunning(false);
      });

      client.on("agent.error", (err) => {
        setVoiceStatus("error");
        let errorMessage = "An unknown error occurred";
        
        if (err) {
          if (typeof err === 'string') {
            errorMessage = err;
          } else if (err.message) {
            errorMessage = err.message;
          } else if (err.description) {
            errorMessage = err.description;
          } else if (err.error?.message) {
            errorMessage = err.error.message;
          } else if (typeof err === 'object') {
            // Try to extract meaningful error info
            if (err.code && err.message) {
              errorMessage = `Error ${err.code}: ${err.message}`;
            } else {
              errorMessage = JSON.stringify(err);
            }
          } else {
            errorMessage = String(err);
          }
        }
        
        notify({
          title: "Voice Error",
          description: errorMessage,
          variant: "error",
        });
        console.error("[Voice Test] Agent error:", err);
      });

      client.on("conversation.agent.state", (state) => {
        setAgentState(state);
      });

      client.on("transcript.item", (item) => {
        const isAssistant = item.role === "assistant";
        const isFinal = item.isFinal !== false; // Default to true if not specified
        
        setMessages((prev) => [
          ...prev,
          {
            id: item.id || `transcript-${Date.now()}`,
            role: isAssistant ? "assistant" : "user",
            content: item.content,
            timestamp: new Date().toISOString(),
          },
        ]);
        
        // Wait for assistant's welcome message before sending scenario responses
        if (isAssistant && isFinal && !welcomeMessageReceivedRef.current) {
          welcomeMessageReceivedRef.current = true;
          setHasReceivedWelcomeMessage(true);
          
          // If auto mode is enabled and we have scenario responses, start sending after welcome
          if (autoModeRef.current && currentScenario.responses.length > 0) {
            const firstStep = currentScenario.responses[0];
            if (firstStep.waitForGreeting) {
              // Wait a bit after welcome message, then send first response
              setTimeout(() => {
                if (voiceClientRef.current) {
                  voiceClientRef.current.sendConversationMessage(firstStep.text);
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: `user-${Date.now()}`,
                      role: "user",
                      content: firstStep.text,
                      timestamp: new Date().toISOString(),
                    },
                  ]);
                  setCurrentStep(1);
                }
              }, 1500);
            }
          }
        }
      });

      await client.connect();
      await client.startConversation({
        callerName: "Test User",
        audio: true,
      });
      
      // Note: We wait for the assistant's welcome message before sending any scenario responses
      // This is handled in the transcript.item event handler
    } catch (err) {
      setVoiceStatus("error");
      setIsTestRunning(false);
      
      let errorMessage = "An unknown error occurred";
      if (err) {
        if (typeof err === 'string') {
          errorMessage = err;
        } else if (err.message) {
          errorMessage = err.message;
        } else if (err.description) {
          errorMessage = err.description;
        } else if (err.error?.message) {
          errorMessage = err.error.message;
        } else if (typeof err === 'object') {
          if (err.code && err.message) {
            errorMessage = `Error ${err.code}: ${err.message}`;
          } else {
            errorMessage = JSON.stringify(err);
          }
        } else {
          errorMessage = String(err);
        }
      }
      
      notify({
        title: "Failed to start voice test",
        description: errorMessage,
        variant: "error",
      });
      console.error("[Voice Test] Failed to start:", err);
    }
  }, [agentId, currentScenario]);

  if (loading) {
    return (
      <div className="p-4">
        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <IconRobot className="h-5 w-5 text-telnyx-green" />
              Test AI Agent
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-[600px] w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="px-0 lg:px-6 py-0">
      <Card className="w-full shadow-sm flex flex-col overflow-hidden" style={{ height: "90vh" }}>
        <CardHeader className="flex flex-row items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push(`/admin/workflows/${flowId}`)}
            >
              <IconArrowLeft className="size-4 mr-2" />
              Back to Workflow
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <IconRobot className="h-5 w-5 text-telnyx-green" />
              Test AI Agent
            </CardTitle>
            <div className="text-sm text-muted-foreground">
              {workflow?.name || "Workflow"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={isTestRunning ? "default" : "secondary"}>
              {isTestRunning ? "Test Running" : "Ready"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0 h-full flex flex-col overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-full p-6 items-stretch">
          {/* Settings Panel */}
          <div className="flex flex-col gap-4 h-full min-h-0">
            <Card className="shrink-0">
              <CardHeader>
                <CardTitle className="text-sm">Test Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Agent Selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">AI Assistant</label>
                  <Select value={agentId || ""} onValueChange={setAgentId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an assistant" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableAgents.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name || agent.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {availableAgents.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No assistants found. Create one first using "Create AI Agent" and assign it to a workflow.
                    </p>
                  )}
                </div>

                {/* Scenario Selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Test Scenario</label>
                  <Select
                    value={selectedScenario}
                    onValueChange={setSelectedScenario}
                    disabled={isTestRunning}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(TEST_SCENARIOS).map((scenario) => (
                        <SelectItem key={scenario.id} value={scenario.id}>
                          {scenario.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {currentScenario?.description}
                  </p>
                </div>

                {/* Channel Selection */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Channel</label>
                  <Tabs value={channel} onValueChange={setChannel}>
                    <TabsList className="w-full">
                      <TabsTrigger value="chat" className="flex-1">
                        <IconMessageCircle className="size-4 mr-2" />
                        Chat
                      </TabsTrigger>
                      <TabsTrigger value="voice" className="flex-1">
                        <IconPhone className="size-4 mr-2" />
                        Voice
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>

                {/* Auto Mode Toggle */}
                <div className="flex items-center justify-between">
                  <Label htmlFor="auto-mode" className="text-sm font-medium cursor-pointer">
                    Auto Mode
                  </Label>
                  <Switch
                    id="auto-mode"
                    checked={isAutoMode}
                    onCheckedChange={setIsAutoMode}
                    disabled={isTestRunning}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Test Controls */}
            <Card className="shrink-0">
              <CardHeader>
                <CardTitle className="text-sm">Controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {!isTestRunning ? (
                  <Button
                    className="w-full"
                    onClick={channel === "chat" ? startChatTest : startVoiceTest}
                    disabled={!agentId}
                  >
                    <IconPlayerPlay className="size-4 mr-2" />
                    Start Test
                  </Button>
                ) : (
                  <>
                    {channel === "chat" && (
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => setIsPaused(!isPaused)}
                      >
                        {isPaused ? (
                          <>
                            <IconPlayerPlay className="size-4 mr-2" />
                            Resume
                          </>
                        ) : (
                          <>
                            <IconPlayerStop className="size-4 mr-2" />
                            Pause
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      className="w-full"
                      onClick={stopTest}
                    >
                      <IconX className="size-4 mr-2" />
                      Stop Test
                    </Button>
                  </>
                )}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={resetTest}
                  disabled={isTestRunning}
                >
                  <IconRefresh className="size-4 mr-2" />
                  Reset
                </Button>
              </CardContent>
            </Card>

            {/* Progress */}
            {isTestRunning && channel === "chat" && (
              <Card className="shrink-0">
                <CardHeader>
                  <CardTitle className="text-sm">Progress</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Step</span>
                      <span>
                        {currentStep} / {currentScenario.responses.length}
                      </span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2">
                      <div
                        className="bg-telnyx-green h-2 rounded-full transition-all"
                        style={{
                          width: `${(currentStep / currentScenario.responses.length) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Agent Status (Chat & Voice) */}
            {isTestRunning && (
              <Card className="shrink-0">
                <CardHeader>
                  <CardTitle className="text-sm">Voice Status</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={
                        voiceStatus === "active"
                          ? "default"
                          : voiceStatus === "connecting"
                          ? "secondary"
                          : voiceStatus === "error"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {voiceStatus}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      Agent: {agentState}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsMuted(!isMuted)}
                    >
                      {isMuted ? (
                        <IconMicrophoneOff className="size-4" />
                      ) : (
                        <IconMicrophone className="size-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setLocalAudioEnabled(!localAudioEnabled)}
                    >
                      {localAudioEnabled ? (
                        <IconVolume className="size-4" />
                      ) : (
                        <IconVolumeOff className="size-4" />
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Chat/Voice Panel */}
          <div className="lg:col-span-2 flex flex-col h-full min-h-0">
            <Card className="h-full flex flex-col min-h-0 overflow-hidden">
              <CardHeader className="shrink-0">
                <CardTitle className="text-sm flex items-center gap-2">
                  {channel === "chat" ? (
                    <>
                      <IconMessageCircle className="size-4" />
                      Chat Test
                    </>
                  ) : (
                    <>
                      <IconPhone className="size-4" />
                      Voice Test
                    </>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col overflow-hidden p-0 min-h-0">
                {/* Messages Area */}
                <div className="flex-1 min-h-0 overflow-hidden">
                  <ScrollArea className="h-full">
                    <div className="space-y-1 py-4 px-4">
                    {messages.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full text-center py-12">
                        <IconRobot className="size-12 text-muted-foreground/50 mb-4" />
                        <p className="text-sm text-muted-foreground">
                          No messages yet
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Click "Start Test" to begin
                        </p>
                      </div>
                    ) : (
                      messages.map((message) => {
                        if (message.role === "system") {
                          return (
                            <div
                              key={message.id}
                              className="text-center text-xs text-muted-foreground py-2"
                            >
                              {message.content}
                            </div>
                          );
                        }
                        return (
                          <Message
                            key={message.id}
                            message={message}
                            isUser={message.role === "user"}
                          />
                        );
                      })
                    )}
                    {sendingMessage && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <IconLoader2 className="size-4 animate-spin" />
                        <span className="text-sm">AI is typing...</span>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                    </div>
                  </ScrollArea>
                </div>

                {/* Input Area (Chat only) */}
                {channel === "chat" && (
                  <div className="shrink-0 border-t p-4">
                    <div className="flex gap-2">
                      <Input
                        value={inputMessage}
                        onChange={(e) => setInputMessage(e.target.value)}
                        placeholder="Type a message..."
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                          }
                        }}
                        disabled={!isTestRunning || sendingMessage}
                      />
                      <Button
                        onClick={sendMessage}
                        disabled={!isTestRunning || sendingMessage || !inputMessage.trim()}
                      >
                        <IconSend className="size-4" />
                      </Button>
                    </div>
                    {!isAutoMode && isTestRunning && currentStep < currentScenario.responses.length && (
                      <div className="mt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => sendScenarioMessage(currentStep)}
                        >
                          Send Next Scenario Response
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
