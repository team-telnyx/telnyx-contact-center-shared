"use client";

import React, { useState, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  IconRobot,
  IconLoader2,
  IconVolume,
  IconMicrophone,
  IconBrain,
  IconCheck,
  IconAlertCircle,
  IconHeadphones,
} from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";

/**
 * CreateAgentSheet - Creates a Telnyx AI Agent from workflow instructions
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {object} props.workflow - The workflow data
 * @param {array} props.stages - The workflow stages with items
 * @param {function} props.onAgentCreated - Callback when agent is created successfully (receives agentId)
 */
export default function CreateAgentSheet({
  open,
  onOpenChange,
  workflow,
  stages = [],
  onAgentCreated,
}) {
  const workflowId = workflow?.id;
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  
  // AI Model settings
  const [llmModels, setLlmModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState("openai/gpt-4o");
  
  // TTS settings
  const [ttsProviders, setTtsProviders] = useState([]);
  const [loadingTts, setLoadingTts] = useState(false);
  const [ttsProvider, setTtsProvider] = useState("AWS");
  const [ttsModel, setTtsModel] = useState("Polly");
  const [ttsVoice, setTtsVoice] = useState("AWS.Polly.Joanna");
  
  // STT settings
  const [sttProvider, setSttProvider] = useState("deepgram");
  const [sttModel, setSttModel] = useState("nova-2");
  const [sttLanguage, setSttLanguage] = useState("en");
  
  // Noise suppression
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true);
  const [noiseSuppressionEngine, setNoiseSuppressionEngine] = useState("krisp");
  
  // Agent name (defaults to workflow name)
  const [agentName, setAgentName] = useState("");
  
  // Custom instructions (optional override)
  const [customInstructions, setCustomInstructions] = useState("");
  
  // Created agent
  const [createdAgent, setCreatedAgent] = useState(null);

  // Available STT providers and models
  const STT_PROVIDERS = [
    { value: "deepgram", label: "Deepgram" },
    { value: "telnyx", label: "Telnyx" },
  ];
  
  const STT_MODELS = {
    deepgram: [
      { value: "nova-2", label: "Nova 2 (Recommended)" },
      { value: "nova", label: "Nova" },
      { value: "enhanced", label: "Enhanced" },
      { value: "base", label: "Base" },
    ],
    telnyx: [
      { value: "default", label: "Default" },
    ],
  };
  
  const STT_LANGUAGES = [
    { value: "en", label: "English" },
    { value: "es", label: "Spanish" },
    { value: "fr", label: "French" },
    { value: "de", label: "German" },
    { value: "it", label: "Italian" },
    { value: "pt", label: "Portuguese" },
    { value: "pl", label: "Polish" },
    { value: "auto", label: "Auto-detect" },
  ];
  
  const NOISE_SUPPRESSION_ENGINES = [
    { value: "krisp", label: "Krisp (Recommended)" },
    { value: "amazon", label: "Amazon" },
  ];

  // Reset state when sheet opens
  useEffect(() => {
    if (open) {
      setAgentName(workflow?.name ? `${workflow.name} Agent` : "Test Agent");
      setCustomInstructions("");
      setCreatedAgent(null);
      setSelectedModel(workflow?.llm_model || "openai/gpt-4o");
    }
  }, [open, workflow]);

  // Load LLM models
  useEffect(() => {
    async function fetchModels() {
      if (!open) return;
      setLoadingModels(true);
      try {
        const res = await fetch("/api/ai/models");
        const data = await res.json();
        if (data.ok && data.models) {
          setLlmModels(data.models);
        }
      } catch (err) {
        console.error("Failed to load models:", err);
      } finally {
        setLoadingModels(false);
      }
    }
    fetchModels();
  }, [open]);

  // Load TTS voices
  useEffect(() => {
    async function fetchVoices() {
      if (!open) return;
      setLoadingTts(true);
      try {
        const res = await fetch("/api/tts/voices");
        const data = await res.json();
        if (data.ok && data.providers) {
          setTtsProviders(data.providers);
        }
      } catch (err) {
        console.error("Failed to load TTS voices:", err);
      } finally {
        setLoadingTts(false);
      }
    }
    fetchVoices();
  }, [open]);

  // Get available models for selected TTS provider
  const getTtsModels = () => {
    const provider = ttsProviders.find(p => p.id === ttsProvider);
    return provider?.models || [];
  };
  
  // Get available voices for selected TTS provider and model
  const getTtsVoices = () => {
    const provider = ttsProviders.find(p => p.id === ttsProvider);
    const model = provider?.models?.find(m => m.id === ttsModel);
    return model?.voices || [];
  };

  // Generate instructions from workflow stages
  const generateInstructions = () => {
    if (customInstructions.trim()) {
      return customInstructions;
    }
    
    let instructions = `# ${workflow?.name || 'AI Assistant'}\n\n`;
    instructions += workflow?.description || "You are a helpful AI assistant.";
    instructions += "\n\n";
    
    // Generate from workflow stages and items
    if (stages && stages.length > 0) {
      instructions += "## Conversation Flow:\n\n";
      
      stages.forEach((stage, stageIdx) => {
        instructions += `### Stage ${stageIdx + 1}: ${stage.name}\n`;
        if (stage.description) {
          instructions += `${stage.description}\n`;
        }
        instructions += "\n";
        
        if (stage.items && stage.items.length > 0) {
          stage.items.forEach((item, itemIdx) => {
            const itemType = item.item_type || item.type;
            const label = item.label || item.name;
            const description = item.description || "";
            
            if (itemType === "question") {
              instructions += `- **Ask**: ${label}`;
              if (description) instructions += ` (${description})`;
              instructions += "\n";
            } else if (itemType === "action") {
              instructions += `- **Action**: ${label}`;
              if (description) instructions += ` - ${description}`;
              instructions += "\n";
            } else if (itemType === "topic") {
              instructions += `- **Cover topic**: ${label}`;
              if (description) instructions += ` - ${description}`;
              instructions += "\n";
            } else if (itemType === "slot") {
              instructions += `- **Collect**: ${label}`;
              if (item.slot_type) instructions += ` (${item.slot_type})`;
              if (description) instructions += ` - ${description}`;
              instructions += "\n";
            } else {
              instructions += `- ${label}`;
              if (description) instructions += `: ${description}`;
              instructions += "\n";
            }
          });
        }
        instructions += "\n";
      });
    }
    
    instructions += "\n## Guidelines:\n";
    instructions += "- Be professional and helpful\n";
    instructions += "- Follow the conversation flow above\n";
    instructions += "- If the caller wants to speak to a human, offer to transfer them\n";
    instructions += "- Confirm important information before proceeding\n";
    
    return instructions;
  };

  // Create the AI agent
  async function handleCreate() {
    setCreating(true);
    try {
      const instructions = generateInstructions();
      
      // Build the agent payload (without channels/unauthenticated - must be set in separate request)
      const payload = {
        name: agentName.trim() || "Test Agent",
        model: selectedModel,
        instructions: instructions,
        greeting: "Hello! How can I help you today?",
        voice: {
          voice_id: ttsVoice,
        },
        transcription: {
          provider: sttProvider,
          model: sttProvider === "deepgram" ? `${sttProvider}/${sttModel}` : sttModel,
          language: sttLanguage,
        },
        // Noise suppression
        noise_suppression: noiseSuppressionEnabled ? {
          enabled: true,
          engine: noiseSuppressionEngine,
        } : { enabled: false },
        // Silence detection settings
        silence_timeout_ms: 500,
        max_silence_count: 2,
      };

      const res = await fetch("/api/ai/assistants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to create AI agent");
      }

      const assistantId = data.assistant?.id;
      
      // Enable voice channel and unauthenticated calls in separate request
      if (assistantId) {
        try {
          await fetch(`/api/ai/assistants/${assistantId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channels: ["voice"],
              allow_unauthenticated: true,
            }),
          });
        } catch (err) {
          console.error("Failed to enable voice channel:", err);
        }
      }

      setCreatedAgent(data.assistant);
      
      // Save AI assistant ID to workflow
      if (workflowId && data.assistant?.id) {
        try {
          await fetch(`/api/admin/workflows/${workflowId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ai_assistant_id: data.assistant.id }),
          });
        } catch (err) {
          console.error("Failed to save assistant ID to workflow:", err);
        }
      }
      
      notify({
        title: "AI Agent Created",
        description: `Agent "${agentName}" has been created successfully.`,
        variant: "success",
      });
      
      if (onAgentCreated) {
        onAgentCreated(data.assistant.id);
      }
    } catch (err) {
      notify({
        title: "Creation Failed",
        description: err.message || "Failed to create AI agent",
        variant: "error",
      });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl overflow-hidden flex flex-col p-0"
      >
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="text-xl font-bold text-telnyx-green flex items-center gap-2">
            <IconRobot className="size-5" />
            Create AI Agent
          </SheetTitle>
          <SheetDescription>
            Create a Telnyx AI Agent from this workflow for testing
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-6">
              {createdAgent ? (
                // Success state
                <div className="text-center py-8 space-y-4">
                  <div className="mx-auto w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <IconCheck className="size-8 text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">Agent Created!</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Your AI agent is ready for testing
                    </p>
                  </div>
                  <div className="bg-muted rounded-lg p-4 text-left">
                    <div className="text-xs text-muted-foreground">Agent ID</div>
                    <code className="text-sm font-mono">{createdAgent.id}</code>
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => onOpenChange(false)}
                  >
                    Close
                  </Button>
                </div>
              ) : (
                <>
                  {/* Agent Name */}
                  <div className="space-y-2">
                    <Label>Agent Name</Label>
                    <Input
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      placeholder="Enter agent name"
                    />
                  </div>

                  <Separator />

                  {/* AI Model Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <IconBrain className="size-4 text-purple-500" />
                      <h3 className="font-semibold">AI Model</h3>
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Model</Label>
                      {loadingModels ? (
                        <Skeleton className="h-10 w-full" />
                      ) : (
                        <Select value={selectedModel} onValueChange={setSelectedModel}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select model" />
                          </SelectTrigger>
                          <SelectContent>
                            {llmModels.map((model) => (
                              <SelectItem key={model.id || model} value={model.id || model}>
                                {model.name || model.id || model}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  </div>

                  <Separator />

                  {/* TTS Settings Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <IconVolume className="size-4 text-blue-500" />
                      <h3 className="font-semibold">Text-to-Speech (TTS)</h3>
                    </div>
                    
                    {loadingTts ? (
                      <div className="space-y-2">
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                      </div>
                    ) : (
                      <div className="grid gap-3">
                        <div className="space-y-2">
                          <Label>Provider</Label>
                          <Select 
                            value={ttsProvider} 
                            onValueChange={(v) => {
                              setTtsProvider(v);
                              // Reset model and voice when provider changes
                              const provider = ttsProviders.find(p => p.id === v);
                              const firstModel = provider?.models?.[0];
                              setTtsModel(firstModel?.id || "");
                              const firstVoice = firstModel?.voices?.[0];
                              setTtsVoice(firstVoice?.id || "");
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select provider" />
                            </SelectTrigger>
                            <SelectContent>
                              {ttsProviders.map((provider) => (
                                <SelectItem key={provider.id} value={provider.id}>
                                  {provider.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        
                        <div className="space-y-2">
                          <Label>Model</Label>
                          <Select 
                            value={ttsModel} 
                            onValueChange={(v) => {
                              setTtsModel(v);
                              // Reset voice when model changes
                              const provider = ttsProviders.find(p => p.id === ttsProvider);
                              const model = provider?.models?.find(m => m.id === v);
                              const firstVoice = model?.voices?.[0];
                              setTtsVoice(firstVoice?.id || "");
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select model" />
                            </SelectTrigger>
                            <SelectContent>
                              {getTtsModels().map((model) => (
                                <SelectItem key={model.id} value={model.id}>
                                  {model.name || model.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        
                        <div className="space-y-2">
                          <Label>Voice</Label>
                          <Select value={ttsVoice} onValueChange={setTtsVoice}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select voice" />
                            </SelectTrigger>
                            <SelectContent className="max-h-[200px]">
                              {getTtsVoices().map((voice) => (
                                <SelectItem key={voice.id} value={voice.id}>
                                  {voice.name || voice.id}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* STT Settings Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <IconMicrophone className="size-4 text-green-500" />
                      <h3 className="font-semibold">Speech-to-Text (STT)</h3>
                    </div>
                    
                    <div className="grid gap-3">
                      <div className="space-y-2">
                        <Label>Provider</Label>
                        <Select 
                          value={sttProvider} 
                          onValueChange={(v) => {
                            setSttProvider(v);
                            // Reset model when provider changes
                            const firstModel = STT_MODELS[v]?.[0];
                            setSttModel(firstModel?.value || "default");
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select provider" />
                          </SelectTrigger>
                          <SelectContent>
                            {STT_PROVIDERS.map((provider) => (
                              <SelectItem key={provider.value} value={provider.value}>
                                {provider.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      
                      <div className="space-y-2">
                        <Label>Model</Label>
                        <Select value={sttModel} onValueChange={setSttModel}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select model" />
                          </SelectTrigger>
                          <SelectContent>
                            {(STT_MODELS[sttProvider] || []).map((model) => (
                              <SelectItem key={model.value} value={model.value}>
                                {model.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      
                      <div className="space-y-2">
                        <Label>Language</Label>
                        <Select value={sttLanguage} onValueChange={setSttLanguage}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select language" />
                          </SelectTrigger>
                          <SelectContent>
                            {STT_LANGUAGES.map((lang) => (
                              <SelectItem key={lang.value} value={lang.value}>
                                {lang.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  <Separator />

                  {/* Noise Suppression Section */}
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <IconHeadphones className="size-4 text-orange-500" />
                        <h3 className="font-semibold">Noise Suppression</h3>
                      </div>
                      <Switch
                        checked={noiseSuppressionEnabled}
                        onCheckedChange={setNoiseSuppressionEnabled}
                      />
                    </div>
                    
                    {noiseSuppressionEnabled && (
                      <div className="space-y-2">
                        <Label>Engine</Label>
                        <Select value={noiseSuppressionEngine} onValueChange={setNoiseSuppressionEngine}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select engine" />
                          </SelectTrigger>
                          <SelectContent>
                            {NOISE_SUPPRESSION_ENGINES.map((engine) => (
                              <SelectItem key={engine.value} value={engine.value}>
                                {engine.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* Custom Instructions (Optional) */}
                  <div className="space-y-2">
                    <Label>Custom Instructions (Optional)</Label>
                    <Textarea
                      value={customInstructions}
                      onChange={(e) => setCustomInstructions(e.target.value)}
                      placeholder="Leave empty to use workflow description, or enter custom instructions..."
                      className="min-h-[100px]"
                    />
                    <p className="text-xs text-muted-foreground">
                      If empty, instructions will be generated from the workflow description
                    </p>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {!createdAgent && (
          <SheetFooter className="px-6 py-4 border-t">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !agentName.trim()}
            >
              {creating ? (
                <>
                  <IconLoader2 className="size-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <IconRobot className="size-4 mr-2" />
                  Create Agent
                </>
              )}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
