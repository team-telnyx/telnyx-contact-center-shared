"use client";

import React, { useState, useEffect, useMemo } from "react";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
} from "@/components/ui/command";
import {
  IconRobot,
  IconLoader2,
  IconVolume,
  IconMicrophone,
  IconBrain,
  IconCheck,
  IconHeadphones,
  IconWorld,
  IconCircleDashed,
  IconCircleX,
  IconPhoneCall,
} from "@tabler/icons-react";
import { TRANSCRIPTION_PROVIDERS, AZURE_REGIONS } from "@/config/voice";

// Helper functions for language filtering
function normalizeLocaleCode(code) {
  try {
    const s = String(code || "").replace(/_/g, "-");
    // Handle simple 2-letter codes
    if (/^[a-zA-Z]{2}$/.test(s)) {
      return s.toLowerCase();
    }
    const m = s.match(/^([a-zA-Z]{2,3})(?:-([a-zA-Z]{2,4}|\d{3}))?$/);
    if (!m) return s.toLowerCase();
    const lang = m[1].toLowerCase();
    const region = m[2] ? m[2].toUpperCase() : null;
    return region ? `${lang}-${region}` : lang;
  } catch (_) {
    return null;
  }
}

function regionToFlag(region) {
  try {
    const r = String(region || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(r)) return "";
    const codePoints = [...r].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
    return String.fromCodePoint(...codePoints);
  } catch (_) {
    return "";
  }
}

function formatProviderLabel(providerId) {
  if (!providerId) return "";
  const id = String(providerId).toLowerCase();
  if (id === "aws") return "AWS";
  if (id === "elevenlabs") return "ElevenLabs";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// Default region for language codes (for flags)
const DEFAULT_REGION_MAP = {
  en: "US", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "PT", nl: "NL",
  pl: "PL", ru: "RU", ja: "JP", ko: "KR", zh: "CN", ar: "SA", hi: "IN",
  tr: "TR", vi: "VN", th: "TH", id: "ID", ms: "MY", sv: "SE", da: "DK",
  fi: "FI", no: "NO", cs: "CZ", sk: "SK", hu: "HU", ro: "RO", bg: "BG",
  uk: "UA", el: "GR", he: "IL", fa: "IR", ur: "PK", bn: "BD", ta: "IN",
  te: "IN", mr: "IN", gu: "IN", kn: "IN", ml: "IN", pa: "IN", or: "IN",
  as: "IN", ne: "NP", si: "LK", my: "MM", km: "KH", lo: "LA", ka: "GE",
  hy: "AM", az: "AZ", kk: "KZ", uz: "UZ", tg: "TJ", ky: "KG", tk: "TM",
  mn: "MN", et: "EE", lv: "LV", lt: "LT", sq: "AL", mk: "MK", bs: "BA",
  hr: "HR", sr: "RS", sl: "SI", mt: "MT", is: "IS", ga: "IE", cy: "GB",
  eu: "ES", ca: "ES", gl: "ES", af: "ZA", sw: "KE", ha: "NG", yo: "NG",
  ig: "NG", zu: "ZA", xh: "ZA", am: "ET", so: "SO", mg: "MG", ht: "HT",
  mi: "NZ", yue: "HK", auto: null,
};

function getLanguageDisplayInfo(langCode) {
  const normalized = normalizeLocaleCode(langCode);
  if (!normalized) return { value: langCode, label: langCode, flag: "🌐" };
  
  // Handle auto-detect variants
  if (normalized === "auto" || normalized === "auto_detect") {
    return { value: langCode, label: "Auto-detect", flag: "🌐" };
  }
  
  const parts = normalized.split("-");
  const lang = parts[0];
  const region = parts[1] || DEFAULT_REGION_MAP[lang];
  
  let label = normalized.toUpperCase();
  let flag = "🌐";
  
  try {
    const langNames = new Intl.DisplayNames(undefined, { type: "language" });
    const regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    
    const langName = langNames.of(lang) || lang.toUpperCase();
    if (region) {
      const regionName = regionNames.of(region) || region;
      label = `${langName} (${regionName})`;
      flag = regionToFlag(region);
    } else {
      label = langName;
      flag = DEFAULT_REGION_MAP[lang] ? regionToFlag(DEFAULT_REGION_MAP[lang]) : "🌐";
    }
  } catch (_) {}
  
  return { value: langCode, label, flag };
}

/**
 * CreateAgentSheet - Creates a Telnyx AI Agent from workflow instructions
 */
export default function CreateAgentSheet({
  open,
  onOpenChange,
  workflow,
  stages = [],
  onAgentCreated,
}) {
  const workflowId = workflow?.id;
  const [creating, setCreating] = useState(false);
  
  // Progress tracking for creation steps
  const [creationSteps, setCreationSteps] = useState([
    { id: "assistant", label: "Create AI Assistant", status: "pending" },
    { id: "telephony", label: "Enable Voice Channel", status: "pending" },
    { id: "insights", label: "Configure Insights", status: "pending" },
    { id: "workflow", label: "Link to Workflow", status: "pending" },
  ]);
  
  // AI Model settings
  const [llmModels, setLlmModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [selectedModel, setSelectedModel] = useState("openai/gpt-4o");
  
  // TTS settings (default: Telnyx NaturalHD Astra)
  const DEFAULT_TTS_VOICE = "Telnyx.NaturalHD.astra";
  const [ttsProviders, setTtsProviders] = useState([]);
  const [loadingTts, setLoadingTts] = useState(false);
  const [ttsProvider, setTtsProvider] = useState("telnyx");
  const [ttsModel, setTtsModel] = useState("NaturalHD");
  const [ttsVoice, setTtsVoice] = useState(DEFAULT_TTS_VOICE);
  const [ttsLanguageFilter, setTtsLanguageFilter] = useState("");
  const [ttsLanguageSearch, setTtsLanguageSearch] = useState("");
  const [ttsLanguagePopoverOpen, setTtsLanguagePopoverOpen] = useState(false);
  const [ttsVoiceSearch, setTtsVoiceSearch] = useState("");
  const [ttsVoicePopoverOpen, setTtsVoicePopoverOpen] = useState(false);
  
  // ElevenLabs API Key Reference (loaded from server config)
  const [elevenLabsApiKeyRef, setElevenLabsApiKeyRef] = useState("");
  
  // STT settings - using TRANSCRIPTION_PROVIDERS from config
  const [sttModel, setSttModel] = useState("deepgram/nova-2");
  const [sttLanguage, setSttLanguage] = useState("auto");
  const [sttLanguageSearch, setSttLanguageSearch] = useState("");
  const [sttLanguagePopoverOpen, setSttLanguagePopoverOpen] = useState(false);
  const [sttAzureRegion, setSttAzureRegion] = useState("westeurope");
  
  // Noise suppression
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true);
  const [noiseSuppressionEngine, setNoiseSuppressionEngine] = useState("krisp");
  
  // Agent name (defaults to workflow name)
  const [agentName, setAgentName] = useState("");
  
  // Custom instructions (optional override)
  const [customInstructions, setCustomInstructions] = useState("");
  
  // Created agent
  const [createdAgent, setCreatedAgent] = useState(null);
  
  // Call flows for transfer tool
  const [callFlows, setCallFlows] = useState([]);
  const [loadingCallFlows, setLoadingCallFlows] = useState(false);
  const [selectedCallFlowId, setSelectedCallFlowId] = useState("");
  
  const NOISE_SUPPRESSION_ENGINES = [
    { value: "krisp", label: "Krisp (Recommended)" },
    { value: "deepfilternet", label: "DeepFilterNet" },
  ];

  // Check if ElevenLabs is selected
  const isElevenLabs = ttsProvider?.toLowerCase() === "elevenlabs";
  
  // Check if selected STT model requires Azure region
  const selectedSttProvider = TRANSCRIPTION_PROVIDERS.find(p => p.model_name === sttModel);
  const sttRequiresRegion = selectedSttProvider?.requiresRegion === true;

  // Reset state when sheet opens
  useEffect(() => {
    if (open) {
      setAgentName(workflow?.name ? `${workflow.name} Agent` : "Test Agent");
      setCustomInstructions("");
      setCreatedAgent(null);
      setSelectedModel(workflow?.llm_model || "openai/gpt-4o");
      setTtsProvider("telnyx");
      setTtsModel("NaturalHD");
      setTtsVoice(DEFAULT_TTS_VOICE);
      setTtsLanguageFilter("");
      setSttModel("deepgram/nova-2");
      setSttLanguage("auto");
      setSttAzureRegion("westeurope");
      setSelectedCallFlowId("");
      setCreationSteps([
        { id: "assistant", label: "Create AI Assistant", status: "pending" },
        { id: "telephony", label: "Enable Voice Channel", status: "pending" },
        { id: "insights", label: "Configure Insights", status: "pending" },
        { id: "workflow", label: "Link to Workflow", status: "pending" },
      ]);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Load call flows for transfer tool
  useEffect(() => {
    async function fetchCallFlows() {
      if (!open) return;
      setLoadingCallFlows(true);
      try {
        const res = await fetch("/api/voice/flows");
        const data = await res.json();
        if (data.ok && data.items) {
          setCallFlows(data.items);
          if (data.items.length > 0 && !selectedCallFlowId) {
            setSelectedCallFlowId(data.items[0].id);
          }
        }
      } catch (err) {
        console.error("Failed to load call flows:", err);
      } finally {
        setLoadingCallFlows(false);
      }
    }
    fetchCallFlows();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load TTS voices (uses ELEVENLABS_API_KEY_REF from server .env)
  useEffect(() => {
    async function fetchVoices() {
      if (!open) return;
      setLoadingTts(true);
      try {
        const res = await fetch("/api/tts/voices");
        const data = await res.json();
        console.log("[CreateAgentSheet] TTS voices response:", {
          ok: data.ok,
          providersCount: data.providers?.length,
          elevenLabsApiKeyRef: data.elevenLabsApiKeyRef || "(not set)",
        });
        if (data.ok && data.providers) {
          let providers = data.providers;
          // Always ensure ElevenLabs is in the list if API key is configured
          if (data.elevenLabsApiKeyRef) {
            const hasElevenLabs = providers.some(
              (p) => p.id?.toLowerCase() === "elevenlabs"
            );
            if (!hasElevenLabs) {
              providers = [
                ...providers,
                { id: "ElevenLabs", name: "ElevenLabs", models: [] },
              ];
            }
          }
          setTtsProviders(providers);
        }
        // Store ElevenLabs API key ref if returned from server
        if (data.elevenLabsApiKeyRef) {
          console.log("[CreateAgentSheet] Setting elevenLabsApiKeyRef:", data.elevenLabsApiKeyRef);
          setElevenLabsApiKeyRef(data.elevenLabsApiKeyRef);
        } else {
          console.warn("[CreateAgentSheet] elevenLabsApiKeyRef not in API response!");
        }
      } catch (err) {
        console.error("Failed to load TTS voices:", err);
      } finally {
        setLoadingTts(false);
      }
    }
    fetchVoices();
  }, [open]);

  // Preselect default voice when providers load
  useEffect(() => {
    if (!open || !ttsProviders.length || loadingTts) return;
    const targetVoiceId = DEFAULT_TTS_VOICE;
    for (const prov of ttsProviders) {
      for (const m of prov.models || []) {
        const voice = (m.voices || []).find(
          (v) => String(v?.id || "").toLowerCase() === targetVoiceId.toLowerCase()
        );
        if (voice) {
          setTtsProvider(prov.id);
          setTtsModel(m.id);
          setTtsVoice(voice.id);
          return;
        }
      }
    }
    const telnyxProv = ttsProviders.find(
      (p) => String(p?.id || "").toLowerCase() === "telnyx"
    );
    if (telnyxProv?.models?.length) {
      const firstModel = telnyxProv.models[0];
      const firstVoice = firstModel?.voices?.[0];
      if (firstVoice) {
        setTtsProvider(telnyxProv.id);
        setTtsModel(firstModel.id);
        setTtsVoice(firstVoice.id);
      }
    }
  }, [open, ttsProviders, loadingTts]);

  // Get available models for selected TTS provider
  const getTtsModels = () => {
    const provider = ttsProviders.find(
      (p) => String(p?.id || "").toLowerCase() === String(ttsProvider || "").toLowerCase()
    );
    return provider?.models || [];
  };
  
  // Get all voices for selected TTS provider and model
  const allTtsVoices = useMemo(() => {
    const provider = ttsProviders.find(
      (p) => String(p?.id || "").toLowerCase() === String(ttsProvider || "").toLowerCase()
    );
    if (!provider?.models) return [];
    
    if (!ttsModel) {
      const allVoices = [];
      for (const m of provider.models) {
        const modelVoices = typeof m === "object" && m.voices ? m.voices : [];
        allVoices.push(...modelVoices);
      }
      return allVoices.filter((v) => v?.id);
    }
    
    const model = provider.models.find(m => m.id === ttsModel);
    return model?.voices?.filter((v) => v?.id) || [];
  }, [ttsProviders, ttsProvider, ttsModel]);

  // Extract available languages from TTS voices
  const ttsLanguageOptions = useMemo(() => {
    const map = new Map();
    for (const v of allTtsVoices) {
      const norm = normalizeLocaleCode(v?.language);
      if (!norm || map.has(norm)) continue;
      const info = getLanguageDisplayInfo(v?.language);
      map.set(norm, info);
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [allTtsVoices]);

  const filteredTtsLanguageOptions = useMemo(() => {
    if (!ttsLanguageSearch.trim()) return ttsLanguageOptions;
    const search = ttsLanguageSearch.toLowerCase();
    return ttsLanguageOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(search) ||
        option.value.toLowerCase().includes(search)
    );
  }, [ttsLanguageOptions, ttsLanguageSearch]);

  // Filter voices by language
  const getTtsVoices = () => {
    let filtered = allTtsVoices;
    if (ttsLanguageFilter) {
      filtered = filtered.filter(
        (v) => normalizeLocaleCode(v?.language) === ttsLanguageFilter
      );
    }
    const seen = new Set();
    return filtered.filter((v) => {
      if (!v?.id || seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });
  };

  const selectedTtsLanguageInfo = useMemo(() => {
    if (!ttsLanguageFilter) return null;
    return ttsLanguageOptions.find((opt) => opt.value === ttsLanguageFilter);
  }, [ttsLanguageFilter, ttsLanguageOptions]);

  // Filter voices by search
  const filteredTtsVoices = useMemo(() => {
    const voices = getTtsVoices();
    if (!ttsVoiceSearch.trim()) return voices;
    const search = ttsVoiceSearch.toLowerCase();
    return voices.filter(
      (v) =>
        (v.name || "").toLowerCase().includes(search) ||
        (v.id || "").toLowerCase().includes(search) ||
        (v.language || "").toLowerCase().includes(search)
    );
  }, [ttsVoiceSearch, getTtsVoices]);

  // Get selected voice info
  const selectedTtsVoiceInfo = useMemo(() => {
    if (!ttsVoice) return null;
    const voices = getTtsVoices();
    return voices.find((v) => v.id === ttsVoice);
  }, [ttsVoice, getTtsVoices]);

  // STT language options from TRANSCRIPTION_PROVIDERS
  const sttLanguageOptions = useMemo(() => {
    const provider = TRANSCRIPTION_PROVIDERS.find(p => p.model_name === sttModel);
    if (!provider?.languages?.length) return [];
    
    return provider.languages
      .map(lang => getLanguageDisplayInfo(lang))
      .sort((a, b) => {
        // Put "auto" and "auto_detect" first
        const aIsAuto = a.value === "auto" || a.value === "auto_detect";
        const bIsAuto = b.value === "auto" || b.value === "auto_detect";
        if (aIsAuto && !bIsAuto) return -1;
        if (!aIsAuto && bIsAuto) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [sttModel]);

  const filteredSttLanguageOptions = useMemo(() => {
    if (!sttLanguageSearch.trim()) return sttLanguageOptions;
    const search = sttLanguageSearch.toLowerCase();
    return sttLanguageOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(search) ||
        option.value.toLowerCase().includes(search)
    );
  }, [sttLanguageOptions, sttLanguageSearch]);

  const selectedSttLanguageInfo = useMemo(() => {
    if (!sttLanguage) return null;
    return sttLanguageOptions.find((opt) => opt.value === sttLanguage);
  }, [sttLanguage, sttLanguageOptions]);

  // Helper to update a creation step status
  const updateStepStatus = (stepId, status, error = null) => {
    setCreationSteps((prev) =>
      prev.map((step) =>
        step.id === stepId ? { ...step, status, error } : step
      )
    );
  };

  // Generate instructions from workflow stages
  const generateInstructions = () => {
    if (customInstructions.trim()) {
      return customInstructions;
    }
    
    let instructions = `# ${workflow?.name || 'AI Assistant'}\n\n`;
    instructions += workflow?.description || "You are a helpful AI assistant.";
    instructions += "\n\n";
    
    if (stages && stages.length > 0) {
      instructions += "## Conversation Flow:\n\n";
      
      stages.forEach((stage, stageIdx) => {
        instructions += `### Stage ${stageIdx + 1}: ${stage.name}\n`;
        if (stage.description) {
          instructions += `${stage.description}\n`;
        }
        instructions += "\n";
        
        if (stage.items && stage.items.length > 0) {
          stage.items.forEach((item) => {
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
    
    instructions += "\n## Call Context\n\n";
    instructions += "The call is taking place via the {{telnyx_conversation_channel}} channel on {{telnyx_current_time}}. ";
    instructions += "The agent is at {{telnyx_agent_target}}, and the client is at {{telnyx_end_user_target}}.\n";

    instructions += "\n## Available Tools:\n\n";
    instructions += "### Transfer Tool\n";
    instructions += "Use the **transfer** tool when:\n";
    instructions += "- The caller explicitly requests to speak with a human agent\n";
    instructions += "- The caller's issue is too complex for you to handle\n";
    instructions += "- You have collected all required information and need to transfer to the contact center\n";
    instructions += "- The caller is frustrated and insists on speaking with a person\n\n";
    
    instructions += "### Hangup Tool\n";
    instructions += "Use the **hangup** tool when:\n";
    instructions += "- The conversation has naturally concluded and the caller is satisfied\n";
    instructions += "- The caller says goodbye or indicates they want to end the call\n";
    instructions += "- The caller explicitly asks to hang up\n";
    instructions += "- There is no further assistance needed\n\n";
    
    instructions += "**Important:** Always confirm with the caller before using either tool. ";
    instructions += "For transfers, let them know they will be connected to a human agent. ";
    instructions += "For hangups, thank them for calling and confirm they don't need anything else.\n";
    
    return instructions;
  };

  // Create the AI agent
  async function handleCreate() {
    setCreating(true);
    let assistantId = null;
    let hasErrors = false;
    
    try {
      // Step 1: Create AI Assistant
      updateStepStatus("assistant", "running");
      const instructions = generateInstructions();
      
      const transferSipUri = selectedCallFlowId 
        ? `sip:username@${selectedCallFlowId}.sip.telnyx.com`
        : null;

      const tools = [
        {
          type: "hangup",
          timeout_ms: 5000,
          hangup: {
            description: "To be used whenever the conversation has ended and it would be appropriate to hangup the call.",
          },
        },
      ];

      if (transferSipUri) {
        tools.push({
          type: "transfer",
          timeout_ms: 5000,
          transfer: {
            from: "{{telnyx_end_user_target}}",
            targets: [
              {
                name: "contact_center",
                to: transferSipUri,
              },
            ],
            custom_headers: [
              {
                name: "X-AI-Call-ID",
                value: "{{call_control_id}}",
              },
            ],
          },
        });
      }

      // Detect ElevenLabs from voice string (more reliable than state)
      const voiceIsElevenLabs = ttsVoice && String(ttsVoice).toLowerCase().startsWith("elevenlabs");
      
      // Build voice settings
      const voiceSettings = {
        voice: ttsVoice,
        voice_speed: 1.0,
      };
      
      // Debug logging for ElevenLabs configuration
      console.log("[CreateAgentSheet] Voice config:", {
        ttsVoice,
        ttsProvider,
        isElevenLabs,
        voiceIsElevenLabs,
        elevenLabsApiKeyRef: elevenLabsApiKeyRef || "(empty)",
      });
      
      // Add ElevenLabs-specific settings (required for ElevenLabs voices)
      // Use voiceIsElevenLabs as primary check (detected from voice string)
      if (voiceIsElevenLabs || isElevenLabs) {
        // api_key_ref is REQUIRED for ElevenLabs - must match integration secret identifier
        // Use state value or fallback to known default
        const apiKeyRef = elevenLabsApiKeyRef || "elevenlabs-api-key";
        
        if (!elevenLabsApiKeyRef) {
          console.warn("[CreateAgentSheet] elevenLabsApiKeyRef state is empty, using fallback: elevenlabs-api-key");
        }
        
        voiceSettings.api_key_ref = apiKeyRef;
        // ElevenLabs-specific parameters - all must have values (not null)
        voiceSettings.temperature = 0.5;       // Controls emotional range/randomness (0-1)
        voiceSettings.similarity_boost = 0.5;  // How closely AI adheres to original voice (0-1)
        voiceSettings.style = 0;               // Style exaggeration (0 = no extra consumption)
        voiceSettings.use_speaker_boost = true; // Amplifies similarity to original speaker
        
        console.log("[CreateAgentSheet] ElevenLabs voice_settings:", voiceSettings);
      }

      // Build transcription config
      const transcriptionConfig = {
        model: sttModel,
        language: sttLanguage,
      };
      
      // Add region for Azure
      if (sttRequiresRegion && sttAzureRegion) {
        transcriptionConfig.region = sttAzureRegion;
      }

      const payload = {
        name: agentName.trim() || "Test Agent",
        model: selectedModel,
        instructions: instructions,
        greeting: "Hello! How can I help you today?",
        voice_settings: voiceSettings,
        transcription: transcriptionConfig,
        enabled_features: ["telephony"],
        telephony_settings: {
          supports_unauthenticated_web_calls: true,
          recording_settings: { channels: "dual", format: "mp3" },
          noise_suppression: noiseSuppressionEnabled ? noiseSuppressionEngine : "disabled",
        },
        silence_timeout_ms: 500,
        max_silence_count: 2,
        tools: tools,
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

      assistantId = data.assistant?.id;
      updateStepStatus("assistant", "success");
      setCreatedAgent(data.assistant);
      
      // Step 2: Enable telephony
      updateStepStatus("telephony", "running");
      if (assistantId) {
        try {
          const updateRes = await fetch(`/api/ai/assistants/${assistantId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              enabled_features: ["telephony"],
              telephony_settings: {
                supports_unauthenticated_web_calls: true,
                recording_settings: { channels: "dual", format: "mp3" },
              },
            }),
          });
          const updateData = await updateRes.json().catch(() => ({}));
          if (!updateRes.ok) {
            throw new Error(updateData?.error || `Failed to enable voice: ${updateRes.status}`);
          }
          updateStepStatus("telephony", "success");
        } catch (err) {
          console.error("Failed to enable voice channel:", err);
          updateStepStatus("telephony", "error", err.message);
          hasErrors = true;
        }
      } else {
        updateStepStatus("telephony", "skipped");
      }
      
      // Step 3: Sync Insights
      updateStepStatus("insights", "running");
      if (workflowId) {
        try {
          await fetch(`/api/admin/workflows/${workflowId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ai_assistant_id: assistantId }),
          });
          
          const insightRes = await fetch(`/api/admin/workflows/${workflowId}/sync-insights`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const insightData = await insightRes.json().catch(() => ({}));
          
          if (!insightRes.ok) {
            if (insightRes.status === 400 && insightData.error?.includes("no slot")) {
              updateStepStatus("insights", "skipped");
            } else {
              throw new Error(insightData.error || "Failed to sync insights");
            }
          } else {
            updateStepStatus("insights", "success");
          }
        } catch (err) {
          console.error("Failed to sync insights:", err);
          updateStepStatus("insights", "error", err.message);
          hasErrors = true;
        }
      } else {
        updateStepStatus("insights", "skipped");
      }
      
      // Step 4: Link to Workflow
      updateStepStatus("workflow", "running");
      if (workflowId && assistantId) {
        try {
          updateStepStatus("workflow", "success");
        } catch (err) {
          console.error("Failed to save assistant ID to workflow:", err);
          updateStepStatus("workflow", "error", err.message);
          hasErrors = true;
        }
      } else {
        updateStepStatus("workflow", "skipped");
      }
      
      if (onAgentCreated) {
        onAgentCreated(assistantId);
      }
    } catch (err) {
      setCreationSteps((prev) =>
        prev.map((step) =>
          step.status === "running" ? { ...step, status: "error", error: err.message } : step
        )
      );
      hasErrors = true;
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
              {creating || createdAgent ? (
                // Progress/Success state
                <div className="py-4 space-y-6">
                  <div className="space-y-3">
                    {creationSteps.map((step) => (
                      <div
                        key={step.id}
                        className="flex items-start gap-3 p-3 rounded-lg border bg-card"
                      >
                        <div className="mt-0.5">
                          {step.status === "pending" && (
                            <IconCircleDashed className="size-5 text-muted-foreground" />
                          )}
                          {step.status === "running" && (
                            <IconLoader2 className="size-5 text-blue-500 animate-spin" />
                          )}
                          {step.status === "success" && (
                            <IconCheck className="size-5 text-green-500" />
                          )}
                          {step.status === "error" && (
                            <IconCircleX className="size-5 text-red-500" />
                          )}
                          {step.status === "skipped" && (
                            <IconCircleDashed className="size-5 text-muted-foreground/50" />
                          )}
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-medium ${
                              step.status === "skipped" ? "text-muted-foreground" : ""
                            }`}>
                              {step.label}
                            </span>
                            {step.status === "skipped" && (
                              <Badge variant="secondary" className="text-xs">
                                Skipped
                              </Badge>
                            )}
                          </div>
                          {step.error && (
                            <p className="text-xs text-red-500 mt-1">{step.error}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  
                  {createdAgent && !creating && (
                    <div className="space-y-4">
                      <Separator />
                      <div className="text-center space-y-2">
                        <div className="mx-auto w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                          <IconCheck className="size-6 text-green-600 dark:text-green-400" />
                        </div>
                        <div>
                          <h3 className="text-lg font-semibold">Agent Created!</h3>
                          <p className="text-sm text-muted-foreground">
                            Your AI agent is ready for testing
                          </p>
                        </div>
                      </div>
                      <div className="bg-muted rounded-lg p-4">
                        <div className="text-xs text-muted-foreground">Agent ID</div>
                        <code className="text-sm font-mono break-all">{createdAgent.id}</code>
                      </div>
                      <Button
                        className="w-full"
                        onClick={() => onOpenChange(false)}
                      >
                        Close
                      </Button>
                    </div>
                  )}
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
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {/* Row 1: Provider + Model */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label>Provider</Label>
                            <Select 
                              value={ttsProvider} 
                              onValueChange={(v) => {
                                setTtsProvider(v);
                                const provider = ttsProviders.find(
                                  (p) => String(p?.id || "").toLowerCase() === String(v || "").toLowerCase()
                                );
                                const firstModel = provider?.models?.[0];
                                setTtsModel(firstModel?.id || "");
                                setTtsVoice("");
                                setTtsLanguageFilter("");
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select provider" />
                              </SelectTrigger>
                              <SelectContent>
                                {ttsProviders.map((provider) => (
                                  <SelectItem key={provider.id} value={provider.id}>
                                    {formatProviderLabel(provider.id)}
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
                                setTtsVoice("");
                                setTtsLanguageFilter("");
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select model" />
                              </SelectTrigger>
                              <SelectContent>
                                {getTtsModels()
                                  .filter((model) => model.id)
                                  .map((model) => (
                                    <SelectItem key={model.id} value={model.id}>
                                      {model.name || model.id}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* Row 2: Language Filter + Voice */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-2">
                            <Label>Language</Label>
                            <Popover
                              open={ttsLanguagePopoverOpen}
                              onOpenChange={setTtsLanguagePopoverOpen}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  className="w-full justify-between"
                                  disabled={loadingTts}
                                >
                                  <div className="flex items-center gap-2">
                                    {selectedTtsLanguageInfo ? (
                                      <>
                                        <span>{selectedTtsLanguageInfo.flag}</span>
                                        <span className="truncate">{selectedTtsLanguageInfo.label}</span>
                                      </>
                                    ) : (
                                      <>
                                        <IconWorld className="h-4 w-4" />
                                        <span>All languages</span>
                                      </>
                                    )}
                                  </div>
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                className="w-[300px] p-0"
                                align="start"
                              >
                                <Command>
                                  <CommandInput
                                    placeholder="Search languages..."
                                    value={ttsLanguageSearch}
                                    onValueChange={setTtsLanguageSearch}
                                    className="h-9"
                                  />
                                  <div
                                    className="max-h-[300px] overflow-y-auto overflow-x-hidden"
                                    onWheel={(e) => {
                                      const el = e.currentTarget;
                                      el.scrollTop += e.deltaY;
                                      e.preventDefault();
                                      e.stopPropagation();
                                    }}
                                  >
                                    <CommandEmpty>No language found.</CommandEmpty>
                                    <CommandGroup>
                                      <CommandItem
                                        value="__any__"
                                        onSelect={() => {
                                          setTtsLanguageFilter("");
                                          setTtsVoice("");
                                          setTtsLanguagePopoverOpen(false);
                                        }}
                                      >
                                        <IconCheck
                                          className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                                            !ttsLanguageFilter ? "opacity-100" : "opacity-0"
                                          }`}
                                        />
                                        <IconWorld className="size-4 mr-2" />
                                        <span>All languages</span>
                                      </CommandItem>
                                      {filteredTtsLanguageOptions.map((opt) => (
                                        <CommandItem
                                          key={opt.value}
                                          value={`${opt.label}-${opt.value}`}
                                          onSelect={() => {
                                            setTtsLanguageFilter(opt.value);
                                            setTtsVoice("");
                                            setTtsLanguagePopoverOpen(false);
                                          }}
                                        >
                                          <IconCheck
                                            className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                                              ttsLanguageFilter === opt.value
                                                ? "opacity-100"
                                                : "opacity-0"
                                            }`}
                                          />
                                          <span className="mr-2">{opt.flag}</span>
                                          <span>{opt.label}</span>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </div>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          </div>
                          
                          <div className="space-y-2">
                            <Label>Voice</Label>
                            <Popover
                              open={ttsVoicePopoverOpen}
                              onOpenChange={setTtsVoicePopoverOpen}
                            >
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  className="w-full justify-between"
                                  disabled={loadingTts}
                                >
                                  <span className="truncate">
                                    {selectedTtsVoiceInfo
                                      ? selectedTtsVoiceInfo.language
                                        ? `${selectedTtsVoiceInfo.name || selectedTtsVoiceInfo.id} (${selectedTtsVoiceInfo.language})`
                                        : selectedTtsVoiceInfo.name || selectedTtsVoiceInfo.id
                                      : "Select voice"}
                                  </span>
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[300px] p-0" align="start">
                                <Command>
                                  <CommandInput
                                    placeholder="Search voices..."
                                    value={ttsVoiceSearch}
                                    onValueChange={setTtsVoiceSearch}
                                    className="h-9"
                                  />
                                  <div
                                    className="max-h-[300px] overflow-y-auto overflow-x-hidden"
                                    onWheel={(e) => {
                                      const el = e.currentTarget;
                                      el.scrollTop += e.deltaY;
                                      e.preventDefault();
                                      e.stopPropagation();
                                    }}
                                  >
                                    <CommandEmpty>No voice found.</CommandEmpty>
                                    <CommandGroup>
                                      {filteredTtsVoices.map((voice) => (
                                        <CommandItem
                                          key={voice.id}
                                          value={`${voice.name}-${voice.id}`}
                                          onSelect={() => {
                                            setTtsVoice(voice.id);
                                            setTtsVoicePopoverOpen(false);
                                          }}
                                        >
                                          <IconCheck
                                            className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                                              ttsVoice === voice.id ? "opacity-100" : "opacity-0"
                                            }`}
                                          />
                                          <span>
                                            {voice.language
                                              ? `${voice.name || voice.id} (${voice.language})`
                                              : voice.name || voice.id}
                                          </span>
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </div>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          </div>
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
                    
                    <div className="space-y-3">
                      {/* Row 1: Model + Region (if Azure) */}
                      <div className={`grid gap-3 ${sttRequiresRegion ? "grid-cols-2" : "grid-cols-1"}`}>
                        <div className="space-y-2">
                          <Label>Model</Label>
                          <Select 
                            value={sttModel} 
                            onValueChange={(v) => {
                              setSttModel(v);
                              // Reset language to auto if available, else first language
                              const provider = TRANSCRIPTION_PROVIDERS.find(p => p.model_name === v);
                              if (provider?.languages?.includes("auto") || provider?.languages?.includes("auto_detect")) {
                                setSttLanguage(provider.languages.includes("auto") ? "auto" : "auto_detect");
                              } else if (provider?.languages?.length > 0) {
                                setSttLanguage(provider.languages[0]);
                              } else {
                                setSttLanguage("");
                              }
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select model" />
                            </SelectTrigger>
                            <SelectContent>
                              {TRANSCRIPTION_PROVIDERS.map((provider) => (
                                <SelectItem key={provider.model_name} value={provider.model_name}>
                                  {provider.label || provider.model_name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        
                        {/* Azure Region selector */}
                        {sttRequiresRegion && (
                          <div className="space-y-2">
                            <Label>Azure Region</Label>
                            <Select value={sttAzureRegion} onValueChange={setSttAzureRegion}>
                              <SelectTrigger>
                                <SelectValue placeholder="Select region" />
                              </SelectTrigger>
                              <SelectContent>
                                {AZURE_REGIONS.map((region) => (
                                  <SelectItem key={region.value} value={region.value}>
                                    {region.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                      
                      {/* Row 2: Language (with searchable popover like TTS) */}
                      {sttLanguageOptions.length > 0 && (
                        <div className="space-y-2">
                          <Label>Language</Label>
                          <Popover
                            open={sttLanguagePopoverOpen}
                            onOpenChange={setSttLanguagePopoverOpen}
                          >
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                role="combobox"
                                className="w-full justify-between"
                              >
                                <div className="flex items-center gap-2">
                                  {selectedSttLanguageInfo ? (
                                    <>
                                      <span>{selectedSttLanguageInfo.flag}</span>
                                      <span className="truncate">{selectedSttLanguageInfo.label}</span>
                                    </>
                                  ) : (
                                    <>
                                      <IconWorld className="h-4 w-4" />
                                      <span>Select language</span>
                                    </>
                                  )}
                                </div>
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-[300px] p-0" align="start">
                              <Command>
                                <CommandInput
                                  placeholder="Search languages..."
                                  value={sttLanguageSearch}
                                  onValueChange={setSttLanguageSearch}
                                  className="h-9"
                                />
                                <div
                                  className="max-h-[300px] overflow-y-auto overflow-x-hidden"
                                  onWheel={(e) => {
                                    const el = e.currentTarget;
                                    el.scrollTop += e.deltaY;
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }}
                                >
                                  <CommandEmpty>No language found.</CommandEmpty>
                                  <CommandGroup>
                                    {filteredSttLanguageOptions.map((opt) => (
                                      <CommandItem
                                        key={opt.value}
                                        value={`${opt.label}-${opt.value}`}
                                        onSelect={() => {
                                          setSttLanguage(opt.value);
                                          setSttLanguagePopoverOpen(false);
                                        }}
                                      >
                                        <IconCheck
                                          className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                                            sttLanguage === opt.value
                                              ? "opacity-100"
                                              : "opacity-0"
                                          }`}
                                        />
                                        <span className="mr-2">{opt.flag}</span>
                                        <span>{opt.label}</span>
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </div>
                              </Command>
                            </PopoverContent>
                          </Popover>
                          <p className="text-xs text-muted-foreground">
                            {sttLanguageOptions.length} language{sttLanguageOptions.length !== 1 ? "s" : ""} available for this model
                          </p>
                        </div>
                      )}
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

                  {/* Transfer Call Flow Section */}
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <IconPhoneCall className="size-4 text-telnyx-green" />
                      <h3 className="font-semibold">Transfer Destination</h3>
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Call Flow for Agent Transfer</Label>
                      {loadingCallFlows ? (
                        <Skeleton className="h-10 w-full" />
                      ) : callFlows.length === 0 ? (
                        <div className="text-sm text-muted-foreground p-3 border rounded-lg bg-muted/50">
                          No call flows available. Create a call flow first to enable agent transfers.
                        </div>
                      ) : (
                        <Select value={selectedCallFlowId} onValueChange={setSelectedCallFlowId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select call flow" />
                          </SelectTrigger>
                          <SelectContent>
                            {callFlows.map((flow) => (
                              <SelectItem key={flow.id} value={flow.id}>
                                {flow.name || flow.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      <p className="text-xs text-muted-foreground">
                        When the AI transfers a call, it will be routed to this call flow.
                        {selectedCallFlowId && (
                          <span className="block mt-1 font-mono text-xs">
                            SIP: sip:username@{selectedCallFlowId}.sip.telnyx.com
                          </span>
                        )}
                      </p>
                    </div>
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
          <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
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
