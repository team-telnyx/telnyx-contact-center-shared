"use client";
import { assertVisionCapability } from "@/lib/ai/vision-capabilities.mjs";
import { isLibraryAssistantTool } from "@/lib/ai/tool-library.js";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useMemo, useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ASSISTANT_TOOL_TYPES } from "@/config/assistant-tools";
import {
  TELNYX_API_ACTIONS,
  THIRD_PARTY_API_ACTIONS,
} from "@/config/demo-entities";
import {
  CONTACT_CENTER_DATA_SOURCES,
  getContactCenterDataSourceActions,
} from "@/config/contact-center-data-sources";
import { Card, CardContent } from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconPencil,
  IconTrash,
  IconDatabaseSearch,
  IconSquareRoundedPlus,
  IconHelpCircle,
  IconCheck,
  IconFlask,
  IconVariable,
  IconPlugConnected,
  IconRefresh,
  IconExternalLink,
  IconServerBolt,
  IconTools,
  IconLink,
  IconLinkOff,
} from "@tabler/icons-react";
import { createDefaultTool } from "@/lib/ai/assistant-tool-defaults.mjs";
import AssistantSectionTabs from "./AssistantSectionTabs";
import { AssistantA2ASettings, AssistantObservabilitySettings } from "./AssistantIntegrationSettings";
import MCPServersSection from "@/components/assistants/MCPServersSection";
import DynamicVariablesTestSheet from "@/components/assistants/DynamicVariablesTestSheet";
import WebhookTestSheet from "@/components/assistants/tools/WebhookTestSheet";
import AssistantToolEditSheet, {
  getAssistantToolDisplay,
  labelForAssistantToolType,
  renderAssistantToolIcon,
} from "@/components/assistants/AssistantToolEditSheet";
import {
  mergeLibraryToolsIntoAssistantTools,
  assistantToolToLibraryPayload,
} from "@/lib/ai/tool-library";
// VariablesDialog removed

const MERGE_LINK_SCRIPT_SRC = "https://ah-cdn.merge.dev/initialize.js";
const MERGE_LINK_TENANT_CONFIG = { apiBaseURL: "https://ah-api.merge.dev" };

function getIntegrationDisplayName(integration) {
  return String(
    integration?.display_name ||
      integration?.name ||
      integration?.integration_name ||
      integration?.slug ||
      integration?.id ||
      ""
  );
}

export default function IntegrationsTab({ localTab = "tools", onLocalTabChange, values, setValues, assistantId }) {
  const tUi = useUiText();
  const [varsOpen, setVarsOpen] = useState(false);
  const [dynamicVarsTestOpen, setDynamicVarsTestOpen] = useState(false);
  const [instructionsAdded, setInstructionsAdded] = useState(false);

  // Detect initial preset and memory limit from existing webhook URL or template data
  const detectPresetFromUrl = (url, target, limit) => {
    if (!url) {
      if (target === "contacts")
        return { preset: "contacts", limit: limit || 5 };
      return { preset: "custom", limit: 1 };
    }

    if (url.includes("/api/contacts/dynamic-variables/")) {
      const match = url.match(/\/api\/contacts\/dynamic-variables\/(\d+)/);
      return { preset: "contacts", limit: match ? parseInt(match[1], 10) : 1 };
    }

    return { preset: "custom", limit: 1 };
  };

  const initialState = detectPresetFromUrl(
    values?.dynamic_variables_webhook_url,
    values?.dynamic_variables_target,
    values?.memory_limit
  );
  const [webhookPreset, setWebhookPreset] = useState(initialState.preset);
  const [memoryLimit, setMemoryLimit] = useState(initialState.limit);

  // Auto-generate webhook URL if we have template data but no URL
  useEffect(() => {
    if (!values?.dynamic_variables_webhook_url && webhookPreset !== "custom") {
      const url = generateWebhookUrl(webhookPreset, memoryLimit);
      setValues((v) => ({
        ...v,
        dynamic_variables_webhook_url: url,
      }));
    }
  }, [
    webhookPreset,
    memoryLimit,
    values?.dynamic_variables_webhook_url,
    setValues,
  ]);

  const dynamicVariables = values?.dynamic_variables || {};
  const entries = useMemo(
    () => Object.entries(dynamicVariables || {}),
    [dynamicVariables]
  );

  const existingToolTypes = useMemo(() => {
    const list = Array.isArray(values?.tools) ? values.tools : [];
    const map = new Map();
    for (const t of list) {
      const type = t?.type || "";
      map.set(type, (map.get(type) || 0) + 1);
    }
    return map;
  }, [values?.tools]);

  const assistantVariableNames = useMemo(() => {
    const systemVariables = [
      "telnyx_current_time",
      "telnyx_conversation_channel",
      "telnyx_agent_target",
      "telnyx_end_user_target",
      "telnyx_shaken_stir_attestation",
      "call_control_id",
    ];
    const customVariables = Object.keys(values?.dynamic_variables || {}).filter(Boolean);
    return Array.from(new Set([...systemVariables, ...customVariables]));
  }, [values?.dynamic_variables]);

  const [addingTool, setAddingTool] = useState(false);
  const [addToolError, setAddToolError] = useState("");
  const [newToolType, setNewToolType] = useState("");
  const [webhookEntity, setWebhookEntity] = useState("custom");
  const [webhookAction, setWebhookAction] = useState("");
  const [librarySheetOpen, setLibrarySheetOpen] = useState(false);
  const [libraryTools, setLibraryTools] = useState([]);
  const [libraryToolsLoading, setLibraryToolsLoading] = useState(false);
  const [libraryToolsError, setLibraryToolsError] = useState("");
  const [librarySearch, setLibrarySearch] = useState("");
  const [selectedLibraryToolIds, setSelectedLibraryToolIds] = useState([]);
  const [externalProviders, setExternalProviders] = useState([]);
  const [externalProviderConnections, setExternalProviderConnections] = useState([]);
  const [externalProvidersLoading, setExternalProvidersLoading] = useState(false);
  const [externalProvidersError, setExternalProvidersError] = useState("");
  const [providerCategoryFilter, setProviderCategoryFilter] = useState("all");
  const [connectingProvider, setConnectingProvider] = useState("");
  const [pendingExternalProviderToolsProvider, setPendingExternalProviderToolsProvider] = useState(null);

  // Generate webhook URL based on preset and memory limit
  const generateWebhookUrl = (preset, limit) => {
    if (preset === "custom") {
      return values.dynamic_variables_webhook_url || "";
    }
    // Use NEXT_PUBLIC_APP_BASE_URL if set, otherwise construct from window.location
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_BASE_URL ||
      (typeof window !== "undefined" ? window.location.origin : "");
    if (preset === "contacts") {
      return `${baseUrl}/api/contacts/dynamic-variables/${limit}`;
    }
    return "";
  };

  // Generate dynamic variables based on entity schema
  const generateDynamicVariablesFromPreset = (preset) => {
    if (preset === "custom") {
      return {};
    }

    const entity = CONTACT_CENTER_DATA_SOURCES.find((item) => item.id === preset);
    if (!entity?.dynamicVariables?.length) {
      return {};
    }

    return Object.fromEntries(entity.dynamicVariables.map((name) => [name, null]));
  };

  // Update webhook URL when preset or limit changes
  const handlePresetChange = (newPreset) => {
    setWebhookPreset(newPreset);
    if (newPreset !== "custom") {
      const url = generateWebhookUrl(newPreset, memoryLimit);
      const autoVars = generateDynamicVariablesFromPreset(newPreset);

      setValues((v) => ({
        ...v,
        dynamic_variables_webhook_url: url,
        dynamic_variables_target: newPreset,
        dynamic_variables: autoVars,
      }));
    } else {
      setValues((v) => ({ ...v, dynamic_variables_target: undefined }));
    }
  };

  const handleMemoryLimitChange = (newLimit) => {
    setMemoryLimit(newLimit);
    if (webhookPreset !== "custom") {
      const url = generateWebhookUrl(webhookPreset, newLimit);
      setValues((v) => ({
        ...v,
        dynamic_variables_webhook_url: url,
      }));
    }
  };

  function upsertDynamicVariable(name, rawValue) {
    const key = String(name || "").trim();
    setValues((v) => {
      const dv = { ...(v.dynamic_variables || {}) };
      if (!key) return v;
      dv[key] = rawValue;
      return { ...v, dynamic_variables: dv };
    });
  }

  function removeDynamicVariable(name) {
    setValues((v) => {
      const dv = { ...(v.dynamic_variables || {}) };
      delete dv[name];
      return { ...v, dynamic_variables: dv };
    });
  }

  // Generate instructions text from dynamic variables
  function addDynamicVariablesToInstructions() {
    const dynamicVars = values?.dynamic_variables || {};
    const varKeys = Object.keys(dynamicVars);

    if (varKeys.length === 0) {
      return; // No variables to add
    }

    // Find the entity configuration to get descriptions
    const entity = CONTACT_CENTER_DATA_SOURCES.find((e) => e.id === webhookPreset);
    if (!entity || !entity.schema) {
      return;
    }

    // Build the instruction text
    let instructionText = "The following dynamic variables should be used:\n";
    const varDescriptions = [];

    varKeys.forEach((varKey) => {
      const fieldDef = entity.schema[varKey];
      if (fieldDef) {
        // Create descriptive text based on field description
        const desc = fieldDef.description || varKey;
        // Convert description to lowercase and remove "provided by" parts for cleaner text
        const cleanDesc = desc
          .replace(/provided by the (customer|patient)/i, "")
          .replace(/customer's|patient's/i, "")
          .trim();

        // Format: "first name is {{first_name}}"
        const varName = varKey.replace(/_/g, " ");
        varDescriptions.push(`${varName} is {{${varKey}}}`);
      } else {
        // Fallback if no description found
        varDescriptions.push(`{{${varKey}}}`);
      }
    });

    instructionText += varDescriptions.join(", ") + ".\n\n";

    // Prepend to existing instructions
    setValues((v) => {
      const currentInstructions = v.instructions || "";
      return {
        ...v,
        instructions: instructionText + currentInstructions,
      };
    });

    // Show success feedback
    setInstructionsAdded(true);
    setTimeout(() => {
      setInstructionsAdded(false);
    }, 2000); // Hide after 2 seconds
  }

  async function addTool(type) {
    if (!type || addingTool) return;
    setAddingTool(true);
    setAddToolError("");

    if (type === "vision") {
      try {
        const response = await fetch("/api/ai/models", {cache:"no-store"});
        const catalog = await response.json();
        if (!response.ok) throw new Error("Unable to verify Vision model support. Please retry.");
        assertVisionCapability(values, catalog.models || [], {buffered:true});
      } catch(error) { setAddToolError(error.message); setAddingTool(false); return; }
    }
    // For webhook tools, check if we should generate config
    let def;
    if (type === "webhook" && webhookEntity !== "custom" && webhookAction) {
      // Call server-side API to generate webhook config
      try {
        const baseUrl =
          process.env.NEXT_PUBLIC_APP_BASE_URL ||
          (typeof window !== "undefined" ? window.location.origin : "");

        const response = await fetch("/api/assistants/webhook-configs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            entityId: webhookEntity,
            actionId: webhookAction,
            baseUrl,
          }),
        });

        if (!response.ok) {
          throw new Error("Webhook configuration unavailable");
        } else {
          def = await response.json();
        }
      } catch (error) {
        setAddToolError(tUi("The webhook could not be added. Please try again."));
        setAddingTool(false);
        return;
      }
    } else if (type === "webhook") {
      def = createDefaultTool("webhook");
    } else {
      def = createDefaultTool(type);
    }

    setAddingTool(false);
    if (!def) return;

    setValues((v) => {
      const tools = Array.isArray(v.tools) ? v.tools : [];
      // enforce singleton for non-webhook types
      const cfg = ASSISTANT_TOOL_TYPES.find((t) => t.type === type);
      if (cfg?.singleton && tools.some((t) => t?.type === type)) return v;
      // Each custom function must have a unique name, including repeated additions.
      let next = def;
      if (type === "webhook" && webhookEntity === "custom") {
        const names = new Set(tools.map(tool => tool.webhook?.name || tool.function?.name || tool.client_side_tool?.name || tool.update_dynamic_variables?.name));
        let name = "custom_webhook", suffix = 2;
        while (names.has(name)) name = `custom_webhook_${suffix++}`;
        next = { ...def, webhook: { ...def.webhook, name } };
      }
      return { ...v, tools: [...tools, next] };
    });

    // Reset state
    setNewToolType("");
    setWebhookEntity("custom");
    setWebhookAction("");
  }

  async function loadLibraryTools() {
    setLibraryToolsLoading(true);
    setLibraryToolsError("");
    try {
      const res = await fetch("/api/ai/tools?all=true", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to fetch library tools");
      }

      setLibraryTools(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      console.error(err);
      setLibraryToolsError(err?.message || String(err));
    } finally {
      setLibraryToolsLoading(false);
    }
  }

  function openLibrarySheet() {
    setSelectedLibraryToolIds([]);
    setLibrarySearch("");
    setLibrarySheetOpen(true);
    loadLibraryTools();
  }

  function toggleLibraryTool(toolId, checked) {
    setSelectedLibraryToolIds((ids) => {
      const next = new Set(ids);
      if (checked) next.add(toolId);
      else next.delete(toolId);
      return Array.from(next);
    });
  }

  function addSelectedLibraryTools() {
    const selected = libraryTools.filter((tool) =>
      selectedLibraryToolIds.includes(tool.id)
    );
    if (!selected.length) return;
    setValues((v) => ({
      ...v,
      tools: mergeLibraryToolsIntoAssistantTools(v.tools, selected),
    }));
    setLibrarySheetOpen(false);
    setSelectedLibraryToolIds([]);
  }

  async function saveToolToLibrary(_index, tool, saveToLibraryDisplayName) {
    const payload = assistantToolToLibraryPayload(tool, saveToLibraryDisplayName);
    if (!payload) throw new Error("Cannot build Tools Library payload");

    const res = await fetch("/api/ai/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
      throw new Error(data?.error || "Failed to add tool to Tools Library");
    }

    return data?.tool || data?.data || data;
  }

  const filteredLibraryTools = useMemo(() => {
    const text = librarySearch.trim().toLowerCase();
    if (!text) return libraryTools;
    return libraryTools.filter((tool) => {
      const haystack = [
        tool?.id,
        tool?.display_name,
        tool?.name,
        tool?.type,
        tool?.tool_definition?.description,
        tool?.[tool?.type]?.description,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(text);
    });
  }, [librarySearch, libraryTools]);

  const connectedExternalProviders = useMemo(() => {
    const byIntegrationId = new Map();
    const byName = new Map();
    for (const connection of externalProviderConnections) {
      if (connection?.integration_id) byIntegrationId.set(connection.integration_id, connection);
      if (connection?.integration_name) byName.set(connection.integration_name, connection);
    }
    return { byIntegrationId, byName };
  }, [externalProviderConnections]);

  async function loadExternalProviders(options = {}) {
    const showLoading = options?.showLoading !== false;
    if (showLoading) setExternalProvidersLoading(true);
    setExternalProvidersError("");
    try {
      const res = await fetch("/api/ai/integrations", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to load integrations");
      }
      setExternalProviders(Array.isArray(data.integrations) ? data.integrations : []);
      setExternalProviderConnections(Array.isArray(data.connections) ? data.connections : []);
      return data;
    } catch (err) {
      console.error(err);
      setExternalProvidersError(err?.message || String(err));
    } finally {
      if (showLoading) setExternalProvidersLoading(false);
    }
  }

  useEffect(() => {
    loadExternalProviders();
  }, []);

  async function loadMergeLinkSdk() {
    if (typeof window === "undefined") return null;
    if (window.AgentHandlerLink) return window.AgentHandlerLink;
    if (window.MergeLink) return window.MergeLink;
    await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${MERGE_LINK_SCRIPT_SRC}"]`);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = MERGE_LINK_SCRIPT_SRC;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
    return window.AgentHandlerLink || window.MergeLink || null;
  }

  async function refreshExternalProvidersUntilConnected(provider, maxAttempts = 6) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const data = await loadExternalProviders({ showLoading: false });
      const connections = Array.isArray(data?.connections) ? data.connections : [];
      const integrations = Array.isArray(data?.integrations) ? data.integrations : [];
      const connection = connections.find(
        (item) => item?.integration_id === provider?.id || item?.integration_name === provider?.name
      );
      const integration = integrations.find(
        (item) => item?.id === provider?.id || item?.name === provider?.name
      );
      if (connection || integration?.status === "connected") return true;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
    return false;
  }

  async function completeExternalProviderConnection(provider) {
    const integrationName = provider?.name;
    if (!integrationName) return;

    const completeRes = await fetch(
      "/api/ai/integrations/connections/actions/complete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integration_name: integrationName,
          allowed_tools: [],
        }),
      }
    );
    const completeData = await completeRes.json().catch(() => ({}));
    if (!completeRes.ok || completeData?.ok === false) {
      throw new Error(
        completeData?.error || "Failed to complete integration connection"
      );
    }
  }

  async function connectExternalProvider(provider) {
    const integrationName = provider?.name;
    if (!integrationName) return;
    setConnectingProvider(integrationName);
    setExternalProvidersError("");
    try {
      const tokenRes = await fetch("/api/ai/integrations/tokens/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integration_name: integrationName }),
      });
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || tokenData?.ok === false || !tokenData?.token) {
        throw new Error(tokenData?.error || "Failed to acquire integration link token");
      }

      const mergeLink = await loadMergeLinkSdk();
      if (!mergeLink?.initialize || !mergeLink?.openLink) {
        throw new Error("Merge Link SDK failed to load");
      }

      const refreshAfterLink = async () => {
        setPendingExternalProviderToolsProvider(provider);
        try {
          await completeExternalProviderConnection(provider);
          const connected = await refreshExternalProvidersUntilConnected(provider);
          if (!connected) await loadExternalProviders({ showLoading: false });
        } catch (err) {
          console.error(err);
          setExternalProvidersError(err?.message || String(err));
          await loadExternalProviders({ showLoading: false });
        }
      };
      let mergeLinkSucceeded = false;
      const handleMergeLinkSuccess = () => {
        mergeLinkSucceeded = true;
      };
      const handleMergeLinkExit = () => {
        if (mergeLinkSucceeded) {
          window.setTimeout(() => {
            void refreshAfterLink();
          }, 0);
          return;
        }
        void loadExternalProviders({ showLoading: false });
      };

      mergeLink.initialize({
        linkToken: tokenData.token,
        tenantConfig: MERGE_LINK_TENANT_CONFIG,
        onSuccess: handleMergeLinkSuccess,
        onExit: handleMergeLinkExit,
      });
      mergeLink.openLink({
        linkToken: tokenData.token,
        onSuccess: handleMergeLinkSuccess,
        onExit: handleMergeLinkExit,
      });
    } catch (err) {
      console.error(err);
      setExternalProvidersError(err?.message || String(err));
    } finally {
      setConnectingProvider("");
    }
  }

  function toggleExternalProviderForAssistant(provider, enabled, selectedToolsOverride = null) {
    const integrationId = provider?.id;
    if (!integrationId) return;
    setValues((v) => {
      const current = Array.isArray(v.integrations) ? v.integrations : [];
      if (!enabled) {
        return {
          ...v,
          integrations: current.filter((item) => item?.integration_id !== integrationId),
        };
      }

      const selectedTools = Array.isArray(selectedToolsOverride)
        ? selectedToolsOverride
        : Array.isArray(provider?.available_tools)
        ? provider.available_tools
        : [];
      const nextIntegration = {
        integration_id: integrationId,
        allowed_list: selectedTools,
      };
      const exists = current.some((item) => item?.integration_id === integrationId);
      return {
        ...v,
        integrations: exists
          ? current.map((item) =>
              item?.integration_id === integrationId ? nextIntegration : item
            )
          : [...current, nextIntegration],
      };
    });
  }

  function removeToolAt(index) {
    setValues((v) => {
      const tools = Array.isArray(v.tools) ? v.tools : [];
      const next = tools.filter((_, i) => i !== index);
      return { ...v, tools: next };
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AssistantSectionTabs value={localTab} onValueChange={onLocalTabChange} label="Integration settings" tabs={[{id:'tools',label:'Tools'},{id:'connections',label:'MCP & integrations'},{id:'a2a',label:'A2A agents'},{id:'variables',label:'Dynamic variables'},{id:'observability',label:'Observability'}]}>{active => <div className="w-full space-y-5 pb-4">
      <Accordion type="multiple" value={['dynamic-variables','tools','external-providers','mcp-servers']} className="space-y-3">
        {active === "variables" && <AccordionItem value="dynamic-variables" className="rounded-xl border bg-card px-4">
          <AccordionTrigger className="hover:no-underline">
            <SectionHeading
              icon={<IconVariable className="h-5 w-5 text-telnyx-green" />}
              title={tUi("Dynamic Variables")}
              description={tUi("Configure webhook-backed variables available to the assistant.")}
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-4 pb-5">
            <div className="w-full space-y-4">
              <div className="grid grid-cols-12 gap-2 items-end">
                <div className="col-span-6" data-setting-path="dynamic_variables_webhook_url">
                  <label className="text-xs">{tUi("Dynamic Variables Webhook URL")}</label>
                </div>
                <div className="col-span-3">
                  <label className="text-xs">{tUi("Target")}</label>
                </div>
                <div className="col-span-3">
                  <label className="text-xs">{tUi("Memory Limit")}</label>
                </div>
              </div>
              <div className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-6">
                  <Input
                    value={values.dynamic_variables_webhook_url || ""}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        dynamic_variables_webhook_url: e.target.value || "",
                      }))
                    }
                    placeholder="https://example.com/dynamic-variables"
                    disabled={webhookPreset !== "custom"}
                  />
                </div>
                <div className="col-span-3">
                  <Select value={webhookPreset} onValueChange={handlePresetChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="custom">{tUi("Custom")}</SelectItem>
                      <SelectItem value="contacts">{tUi("Contacts")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-3">
                  <Select
                    value={String(memoryLimit)}
                    onValueChange={(val) => handleMemoryLimitChange(Number(val))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1</SelectItem>
                      <SelectItem value="2">2</SelectItem>
                      <SelectItem value="3">3</SelectItem>
                      <SelectItem value="4">4</SelectItem>
                      <SelectItem value="5">5</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="block space-y-2 text-xs" data-setting-path="dynamic_variables_webhook_timeout_ms">{tUi("Variable lookup timeout (ms)")}<Input type="number" min={1} max={10000} className="w-36" value={values.dynamic_variables_webhook_timeout_ms ?? ""} placeholder="1500" onChange={e => setValues(current => ({ ...current, dynamic_variables_webhook_timeout_ms: e.target.value === "" ? undefined : Number(e.target.value) }))} /></label>
              {entries.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {entries.map(([name], index) => (
                    <span
                      key={index}
                      className="text-xs border px-2 py-0.5 rounded text-telnyx-green border-telnyx-green"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => setVarsOpen(true)}>{tUi("Manage Dynamic Variables")}</Button>
              {values.dynamic_variables_webhook_url && (
                <Button type="button" variant="outline" onClick={() => setDynamicVarsTestOpen(true)}>
                  <IconFlask className="h-4 w-4 mr-2" />{tUi("Test Webhook")}</Button>
              )}
              {webhookPreset !== "custom" && entries.length > 0 && (
                <Button
                  type="button"
                  variant={instructionsAdded ? "default" : "outline"}
                  onClick={addDynamicVariablesToInstructions}
                  className={instructionsAdded ? "bg-telnyx-green hover:bg-telnyx-green text-white" : ""}
                >
                  {instructionsAdded ? (
                    <>
                      <IconCheck className="h-4 w-4 mr-2" />{tUi("Added")}</>
                  ) : (
                    tUi("Add to Instructions")
                  )}
                </Button>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>}

        {active === "tools" && <AccordionItem value="tools" className="rounded-xl border bg-card px-4">
          <AccordionTrigger className="hover:no-underline">
            <SectionHeading
              icon={<IconTools className="h-5 w-5 text-telnyx-green" />}
              title={tUi("Tools")}
              description={tUi("Add built-in assistant tools and reusable tools from your library.")}
            />
          </AccordionTrigger>
          <AccordionContent className="space-y-3 pb-5">
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="w-44"><label className="text-xs">{tUi("Tool Type")}</label></div>
                {newToolType === "webhook" && (
                  <>
                    <div className="w-44"><label className="text-xs">{tUi("Entity")}</label></div>
                    <div className="w-44"><label className="text-xs">{tUi("Action")}</label></div>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={newToolType}
                  onValueChange={(val) => {
                    setNewToolType(val);
                    if (val !== "webhook") {
                      setWebhookEntity("custom");
                      setWebhookAction("");
                    }
                  }}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue placeholder={tUi("Select tool type")} />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSISTANT_TOOL_TYPES.map((t) => {
                      const count = existingToolTypes.get(t.type) || 0;
                      const disabled = t.singleton && count >= 1;
                      return (
                        <SelectItem key={t.type} value={t.type} disabled={disabled}>
                          {tUi(t.label)}{disabled ? tUi(" (already added)") : ""}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {newToolType === "webhook" && (
                  <>
                    <Select value={webhookEntity} onValueChange={(val) => { setWebhookEntity(val); setWebhookAction(""); }}>
                      <SelectTrigger className="w-44"><SelectValue placeholder={tUi("Select entity")} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="custom">{tUi("Custom")}</SelectItem>
                        <SelectItem value="telnyx_apis">{tUi("Telnyx APIs")}</SelectItem>
                        <SelectItem value="third_party_apis">{tUi("3rd Party APIs")}</SelectItem>
                        {CONTACT_CENTER_DATA_SOURCES.map((entity) => (
                          <SelectItem key={entity.id} value={entity.id}>{entity.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={webhookAction} onValueChange={setWebhookAction} disabled={webhookEntity === "custom"}>
                      <SelectTrigger className="w-80"><SelectValue placeholder={tUi("Select action")} /></SelectTrigger>
                      <SelectContent>
                        {webhookEntity === "telnyx_apis"
                          ? TELNYX_API_ACTIONS.map((action) => (<SelectItem key={action.id} value={action.id}>{tUi(action.description)}</SelectItem>))
                          : webhookEntity === "third_party_apis"
                          ? THIRD_PARTY_API_ACTIONS.map((action) => (<SelectItem key={action.id} value={action.id}>{tUi(action.description)}</SelectItem>))
                          : getContactCenterDataSourceActions(webhookEntity).map((action) => {
                              const entity = CONTACT_CENTER_DATA_SOURCES.find((e) => e.id === webhookEntity);
                              const entitySingular = entity ? entity.label.toLowerCase().slice(0, -1) : "";
                              const entityPlural = entity ? entity.label.toLowerCase() : "";
                              const description = action.description.replace("{entity}", entitySingular).replace("{entities}", entityPlural);
                              return <SelectItem key={action.id} value={action.id}>{description}</SelectItem>;
                            })}
                      </SelectContent>
                    </Select>
                  </>
                )}
                <Button
                  type="button"
                  onClick={() => addTool(newToolType)}
                  disabled={addingTool || !newToolType || (newToolType === "webhook" && webhookEntity !== "custom" && !webhookAction)}
                >{tUi(addingTool ? "Adding…" : "Add Tool")}</Button>
                <Button type="button" variant="outline" onClick={openLibrarySheet}>{tUi("Add from Library")}</Button>
              </div>
            </div>
            {addToolError ? <p role="alert" className="text-sm text-destructive">{addToolError}</p> : null}
            <ToolsCardsGrid
              tools={Array.isArray(values?.tools) ? values.tools : []}
              assistantId={assistantId}
              availableVariables={assistantVariableNames}
              onChangeTool={(index, next) =>
                setValues((v) => {
                  const tools = Array.isArray(v.tools) ? [...v.tools] : [];
                  tools[index] = next;
                  return { ...v, tools };
                })
              }
              onRemoveTool={(index) => removeToolAt(index)}
              onSaveToolToLibrary={saveToolToLibrary}
            />
          </AccordionContent>
        </AccordionItem>}

        {active === "connections" && <AccordionItem value="external-providers" className="rounded-xl border bg-card px-4">
          <AccordionTrigger className="hover:no-underline">
            <SectionHeading
              icon={<IconPlugConnected className="h-5 w-5 text-telnyx-green" />}
              title={tUi("External Providers")}
              description={tUi("Connect Merge-backed apps like GitHub, Linear, Salesforce, Notion, and more.")}
            />
          </AccordionTrigger>
          <AccordionContent className="pb-5">
            <ExternalProvidersSection
              integrations={externalProviders}
              connections={externalProviderConnections}
              connectedExternalProviders={connectedExternalProviders}
              loading={externalProvidersLoading}
              error={externalProvidersError}
              categoryFilter={providerCategoryFilter}
              setCategoryFilter={setProviderCategoryFilter}
              selectedIntegrations={Array.isArray(values?.integrations) ? values.integrations : []}
              connectingProvider={connectingProvider}
              pendingExternalProviderToolsProvider={pendingExternalProviderToolsProvider}
              onPendingProviderToolsHandled={() => setPendingExternalProviderToolsProvider(null)}
              onRefresh={loadExternalProviders}
              onConnect={connectExternalProvider}
              onToggleAssistantIntegration={toggleExternalProviderForAssistant}
            />
          </AccordionContent>
        </AccordionItem>}

        {active === "connections" && <AccordionItem value="mcp-servers" className="rounded-xl border bg-card px-4">
          <AccordionTrigger className="hover:no-underline">
            <SectionHeading
              icon={<IconServerBolt className="h-5 w-5 text-telnyx-green" />}
              title={tUi("MCP Servers")}
              description={tUi("Attach Model Context Protocol servers to extend assistant capabilities.")}
            />
          </AccordionTrigger>
          <AccordionContent className="pb-5">
            <MCPServersSection values={values} setValues={setValues} />
          </AccordionContent>
        </AccordionItem>}
      </Accordion>
      {active === 'a2a' ? <AssistantA2ASettings values={values} setValues={setValues} /> : null}
      {active === 'observability' ? <AssistantObservabilitySettings values={values} setValues={setValues} /> : null}

      </div>}</AssistantSectionTabs>
      {/* Add from Library Sheet */}
      <Sheet open={librarySheetOpen} onOpenChange={setLibrarySheetOpen}>
        <SheetContent className="w-[90vw] sm:w-[800px] h-full flex flex-col overflow-hidden">
          <SheetHeader>
            <SheetTitle className="inline-flex items-center gap-2">
              <IconDatabaseSearch className="h-5 w-5 text-telnyx-green" />{tUi("Add from Library")}</SheetTitle>
            <SheetDescription>{tUi("Select reusable tools to attach to this assistant. Duplicates are skipped automatically.")}</SheetDescription>
          </SheetHeader>

          <div className="mx-4 mt-4 flex-1 min-h-0 flex flex-col gap-3">
            <Input
              value={librarySearch}
              onChange={(e) => setLibrarySearch(e.target.value)}
              placeholder={tUi("Search tools by name, type, or ID…")}
            />
            <div className="rounded-lg border bg-background flex-1 min-h-0 overflow-y-auto">
              {libraryToolsLoading ? (
                <div className="p-6 text-sm text-muted-foreground">{tUi("Loading library tools…")}</div>
              ) : libraryToolsError ? (
                <div className="p-6 text-sm text-red-500">{libraryToolsError}</div>
              ) : filteredLibraryTools.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">{tUi("No library tools found.")}</div>
              ) : (
                <div className="divide-y">
                  {filteredLibraryTools.map((tool) => {
                    const selected = selectedLibraryToolIds.includes(tool.id);
                    const definition = tool?.tool_definition || tool?.[tool?.type] || {};
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        key={tool.id}
                        onClick={() => toggleLibraryTool(tool.id, !selected)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleLibraryTool(tool.id, !selected);
                          }
                        }}
                        className="w-full text-left p-4 hover:bg-muted/50 transition-colors flex items-start gap-3 cursor-pointer"
                      >
                        <Checkbox
                          checked={selected}
                          onCheckedChange={(checked) =>
                            toggleLibraryTool(tool.id, Boolean(checked))
                          }
                          onClick={(event) => event.stopPropagation()}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {renderAssistantToolIcon(tool.type)}
                            <span className="font-medium text-sm truncate">
                              {tool.display_name || tool.name || tUi("Unnamed tool")}
                            </span>
                            <Badge variant="secondary" className="text-[11px]">
                              {tUi(labelForAssistantToolType(tool.type))}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground line-clamp-2">
                            {definition?.description || definition?.name || tUi("No description")}
                          </div>
                          <div className="text-[11px] font-mono text-muted-foreground truncate">
                            {tool.id}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="border-t p-4 flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setLibrarySheetOpen(false)}
            >{tUi("Cancel")}</Button>
            <Button
              type="button"
              onClick={addSelectedLibraryTools}
              disabled={selectedLibraryToolIds.length === 0}
            >{tUi("Add Selected Tools (")}{selectedLibraryToolIds.length})
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Dynamic Variables Sheet */}
      <Sheet open={varsOpen} onOpenChange={setVarsOpen}>
        <SheetContent className="w-[600px] sm:w-[700px] overflow-hidden flex flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <IconVariable className="h-5 w-5 text-telnyx-green" />{tUi("Manage Dynamic Variables")}</SheetTitle>
            <SheetDescription>{tUi("Configure variables that can be used in your assistant's responses")}</SheetDescription>
          </SheetHeader>

          <div className="flex-1 mt-0 mb-4">
            <div className="mx-4">
              <DynamicVariablesEditor
                entries={entries}
                onUpsert={upsertDynamicVariable}
                onRemove={removeDynamicVariable}
              />
            </div>
          </div>

          <div className="border-t p-4 flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setVarsOpen(false)}
            >{tUi("Cancel")}</Button>
            <Button type="button" onClick={() => setVarsOpen(false)}>{tUi("Save")}</Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Dynamic Variables Test Sheet */}
      <DynamicVariablesTestSheet
        open={dynamicVarsTestOpen}
        onOpenChange={setDynamicVarsTestOpen}
        webhookUrl={values.dynamic_variables_webhook_url}
        entries={entries}
      />
    </div>
  );
}

const INTEGRATION_CATEGORY_LABELS = {
  accounting_finance: "Accounting & Finance",
  communication_collaboration: "Communication & Collaboration",
  customer_support: "Customer Support",
  design_ux: "Design & UX",
  ecommerce_payments: "Ecommerce & Payments",
  engineering_product: "Engineering & Product",
  file_storage_productivity: "File Storage & Productivity",
  hr_recruiting: "HR & Recruiting",
  it_operations: "IT Operations",
  knowledge_documentation: "Knowledge & Documentation",
  sales_crm: "Sales & CRM",
  scheduling: "Scheduling",
  work_management: "Work Management",
};

function SectionHeading({ icon, title, description }) {
  return (
    <div className="flex items-start gap-3 text-left">
      <div className="mt-0.5 rounded-lg border bg-muted/40 p-2">{icon}</div>
      <div className="space-y-0.5">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs font-normal text-muted-foreground">{description}</div>
      </div>
    </div>
  );
}

function ExternalProvidersSection({
  integrations,
  connections,
  connectedExternalProviders,
  loading,
  error,
  categoryFilter,
  setCategoryFilter,
  selectedIntegrations,
  connectingProvider,
  pendingExternalProviderToolsProvider,
  onPendingProviderToolsHandled,
  onRefresh,
  onConnect,
  onToggleAssistantIntegration,
}) {
  const tUi = useUiText();
  const categories = useMemo(() => {
    const set = new Set();
    for (const integration of integrations) {
      for (const category of integration?.categories || []) set.add(category);
    }
    return ["all", ...Array.from(set).sort()];
  }, [integrations]);

  const filtered = useMemo(() => {
    const filteredIntegrations = categoryFilter === "all"
      ? integrations
      : integrations.filter((integration) =>
          (integration?.categories || []).includes(categoryFilter)
        );

    return [...filteredIntegrations].sort((a, b) =>
      getIntegrationDisplayName(a).localeCompare(getIntegrationDisplayName(b), undefined, {
        sensitivity: "base",
        numeric: true,
      })
    );
  }, [categoryFilter, integrations]);

  const selectedIds = useMemo(
    () => new Set(selectedIntegrations.map((item) => item?.integration_id).filter(Boolean)),
    [selectedIntegrations]
  );

  const selectedIntegrationsById = useMemo(() => {
    const map = new Map();
    for (const item of selectedIntegrations) {
      if (item?.integration_id) map.set(item.integration_id, item);
    }
    return map;
  }, [selectedIntegrations]);

  const [toolsDialogProvider, setToolsDialogProvider] = useState(null);
  const [selectedExternalProviderTools, setSelectedExternalProviderTools] = useState([]);
  const [deleteProviderDialog, setDeleteProviderDialog] = useState({
    open: false,
    provider: null,
    connection: null,
    blockingAssistants: [],
    usageChecked: false,
    loading: false,
    deleting: false,
    error: "",
  });
  const toolsDialogTools = Array.isArray(toolsDialogProvider?.available_tools)
    ? toolsDialogProvider.available_tools
    : [];

  function openExternalProviderToolsDialog(provider) {
    const existing = selectedIntegrationsById.get(provider?.id);
    const providerTools = Array.isArray(provider?.available_tools)
      ? provider.available_tools
      : [];
    setToolsDialogProvider(provider);
    setSelectedExternalProviderTools(
      Array.isArray(existing?.allowed_list) ? existing.allowed_list : providerTools
    );
  }

  useEffect(() => {
    if (!pendingExternalProviderToolsProvider) return;
    const nextProvider =
      integrations.find(
        (item) =>
          item?.id === pendingExternalProviderToolsProvider?.id ||
          item?.name === pendingExternalProviderToolsProvider?.name
      ) || pendingExternalProviderToolsProvider;
    const connection =
      connectedExternalProviders.byIntegrationId.get(nextProvider?.id) ||
      connectedExternalProviders.byName.get(nextProvider?.name) ||
      connections.find((item) => item?.integration_id === nextProvider?.id);
    const connected = nextProvider?.status === "connected" || Boolean(connection);
    if (!connected) return;
    openExternalProviderToolsDialog(nextProvider);
    onPendingProviderToolsHandled?.();
  }, [
    pendingExternalProviderToolsProvider,
    integrations,
    connections,
    connectedExternalProviders,
    onPendingProviderToolsHandled,
  ]);

  function toggleExternalProviderTool(tool, checked) {
    setSelectedExternalProviderTools((current) => {
      const next = new Set(current);
      if (checked) next.add(tool);
      else next.delete(tool);
      return Array.from(next);
    });
  }

  function saveExternalProviderToolsSelection() {
    if (!toolsDialogProvider) return;
    const selectedTools = selectedExternalProviderTools;
    if (selectedTools.length === 0) return;
    onToggleAssistantIntegration(toolsDialogProvider, true, selectedTools);
    setToolsDialogProvider(null);
    setSelectedExternalProviderTools([]);
  }

  function isProviderUsedByAnyAssistant(assistant, provider) {
    const integrations = Array.isArray(assistant?.integrations) ? assistant.integrations : [];
    return integrations.some(
      (item) =>
        item?.integration_id === provider?.id ||
        item?.integration_name === provider?.name ||
        item?.name === provider?.name
    );
  }

  async function confirmExternalProviderDelete(provider, connection) {
    if (!provider || !connection?.id) return;
    setDeleteProviderDialog({
      open: true,
      provider,
      connection,
      blockingAssistants: [],
      usageChecked: false,
      loading: true,
      deleting: false,
      error: "",
    });

    try {
      const res = await fetch("/api/ai/assistants?all=true", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to check assistant usage");
      }
      const assistants = Array.isArray(data?.items) ? data.items : [];
      const blockingAssistants = assistants.filter((assistant) =>
        isProviderUsedByAnyAssistant(assistant, provider)
      );
      setDeleteProviderDialog((current) => ({
        ...current,
        blockingAssistants,
        usageChecked: true,
        loading: false,
      }));
    } catch (err) {
      console.error(err);
      setDeleteProviderDialog((current) => ({
        ...current,
        loading: false,
        error: err?.message || String(err),
      }));
    }
  }

  async function deleteExternalProviderConnection() {
    if (
      !deleteProviderDialog.connection?.id ||
      !deleteProviderDialog.usageChecked ||
      deleteProviderDialog.blockingAssistants.length > 0
    ) return;
    setDeleteProviderDialog((current) => ({ ...current, deleting: true, error: "" }));
    try {
      const res = await fetch(
        `/api/ai/integrations/connections/${encodeURIComponent(deleteProviderDialog.connection.id)}`,
        { method: "DELETE" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || "Failed to delete integration connection");
      }
      setDeleteProviderDialog({
        open: false,
        provider: null,
        connection: null,
        blockingAssistants: [],
        usageChecked: false,
        loading: false,
        deleting: false,
        error: "",
      });
      await onRefresh?.({ showLoading: false });
    } catch (err) {
      console.error(err);
      setDeleteProviderDialog((current) => ({
        ...current,
        deleting: false,
        error: err?.message || String(err),
      }));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium">{tUi("Add Integration")}</div>
          <p className="text-xs text-muted-foreground">{tUi("Connected providers can be attached to this assistant. Hover the help icon to preview available tools.")}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <IconRefresh className="mr-2 h-4 w-4" />{tUi("Refresh")}</Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((category) => {
          const active = categoryFilter === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => setCategoryFilter(category)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? "bg-telnyx-green text-white shadow-sm"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              }`}
            >
              {category === "all" ? tUi("All") : (INTEGRATION_CATEGORY_LABELS[category] ? tUi(INTEGRATION_CATEGORY_LABELS[category]) : category)}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border bg-muted/20 p-8 text-center text-sm text-muted-foreground">{tUi("Loading external providers…")}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-muted/20 p-8 text-center text-sm text-muted-foreground">{tUi("No integrations found for this filter.")}</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          {filtered.map((integration) => {
            const tools = Array.isArray(integration?.available_tools)
              ? integration.available_tools
              : [];
            const connection =
              connectedExternalProviders.byIntegrationId.get(integration.id) ||
              connectedExternalProviders.byName.get(integration.name) ||
              connections.find((item) => item?.integration_id === integration.id);
            const connected = integration?.status === "connected" || Boolean(connection);
            const selected = selectedIds.has(integration.id);
            const busy = connectingProvider === integration.name;

            return (
              <Card
                key={integration.id || integration.name}
                className={`group relative overflow-hidden border-muted-foreground/20 bg-card transition-all hover:-translate-y-0.5 hover:border-telnyx-green/60 hover:shadow-lg ${
                  selected ? "border-telnyx-green/80 ring-1 ring-telnyx-green/40" : ""
                }`}
              >
                <CardContent className="flex h-full min-h-[150px] flex-col justify-between p-4">
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-white p-1.5">
                          {integration.logo_url ? (
                            <img src={integration.logo_url} alt="" className="h-full w-full object-contain" />
                          ) : (
                            <IconPlugConnected className="h-5 w-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">
                            {getIntegrationDisplayName(integration)}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {(integration.categories || []).slice(0, 2).map((category) => (
                              <Badge key={category} variant="secondary" className="text-[10px] font-normal">
                                {(INTEGRATION_CATEGORY_LABELS[category] ? tUi(INTEGRATION_CATEGORY_LABELS[category]) : category)}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
                      {connected && (
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge className="bg-telnyx-green/15 text-telnyx-green hover:bg-telnyx-green/15">{tUi("Connected")}</Badge>
                          {selected && (
                            <IconLink
                              className="h-4 w-4 text-fuchsia-500"
                              title={tUi("Integration is added to this assistant")}
                            />
                          )}
                        </div>
                      )}
                    </div>

                    <p className="line-clamp-2 min-h-9 text-xs text-muted-foreground">
                      {integration.description || tUi("Connect this provider to expose its actions as assistant tools.")}
                    </p>

                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>{tools.length}{tUi(" tools")}</span>
                      <HoverCard openDelay={100} closeDelay={100}>
                        <HoverCardTrigger asChild>
                          <button type="button" className="rounded-full text-muted-foreground hover:text-foreground">
                            <IconHelpCircle className="h-4 w-4" />
                          </button>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-[min(760px,calc(100vw-2rem))] max-w-none bg-popover text-popover-foreground">
                          <div className="space-y-2">
                            <div className="font-medium">{tUi("Available tools:")}</div>
                            {tools.length === 0 ? (
                              <div className="text-xs text-muted-foreground">{tUi("No tools advertised.")}</div>
                            ) : (
                              <ul className="grid max-h-[28rem] grid-cols-1 gap-x-6 gap-y-1.5 overflow-y-auto pr-1 text-xs lg:grid-cols-2">
                                {tools.map((tool) => (
                                  <li key={tool} className="ml-4 list-outside list-disc break-all font-mono leading-relaxed" title={tool}>
                                    {tool}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                  </div>

                  <div className="mt-4 ml-auto flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      size="icon"
                      variant={connected ? "outline" : "default"}
                      onClick={() => onConnect(integration)}
                      disabled={busy}
                      aria-label={connected ? tUi("Reconnect provider") : tUi("Connect provider")}
                      title={connected ? tUi("Reconnect provider") : busy ? tUi("Opening…") : tUi("Connect provider")}
                    >
                      <IconExternalLink className="h-4 w-4" />
                    </Button>
                    {selected ? (
                      <>
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          onClick={() => openExternalProviderToolsDialog(integration)}
                          aria-label={tUi("Configure allowed tools")}
                          title={tUi("Configure allowed tools")}
                        >
                          <IconTools className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="default"
                          onClick={() => onToggleAssistantIntegration(integration, false)}
                          className="bg-telnyx-green hover:bg-telnyx-green"
                          aria-label={tUi("Remove from assistant")}
                          title={tUi("Remove from assistant")}
                        >
                          <IconLinkOff className="h-4 w-4" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        disabled={!connected}
                        onClick={() => openExternalProviderToolsDialog(integration)}
                        aria-label={tUi("Add to assistant")}
                        title={tUi("Add to assistant")}
                      >
                        <IconSquareRoundedPlus className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      disabled={!connection?.id || selected}
                      onClick={() => confirmExternalProviderDelete(integration, connection)}
                      aria-label={tUi("Delete provider connection")}
                      title={
                        selected
                          ? tUi("Remove this integration from the assistant before deleting the connection")
                          : tUi("Delete provider connection")
                      }
                      className="text-red-500 hover:text-red-600"
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog
        open={deleteProviderDialog.open}
        onOpenChange={(open) => {
          if (!open && !deleteProviderDialog.deleting) {
            setDeleteProviderDialog({
              open: false,
              provider: null,
              connection: null,
              blockingAssistants: [],
              usageChecked: false,
              loading: false,
              deleting: false,
              error: "",
            });
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tUi("Delete Integration Connection")}</DialogTitle>
            <DialogDescription>{tUi("This only removes the provider account connection. It will not delete assistants or provider-side data.")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="font-medium">
                {getIntegrationDisplayName(deleteProviderDialog.provider) || tUi("Integration")}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{tUi("Connection ID: ")}{deleteProviderDialog.connection?.id || "—"}
              </div>
            </div>
            {deleteProviderDialog.loading && (
              <p className="text-muted-foreground">{tUi("Checking assistant usage…")}</p>
            )}
            {deleteProviderDialog.blockingAssistants.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-600 dark:text-amber-400">
                <p className="font-medium">{tUi("Cannot delete this integration. Assistants using it: {value0}.", {value0: deleteProviderDialog.blockingAssistants.length})}
                </p>
                <ul className="mt-2 list-inside list-disc text-xs">
                  {deleteProviderDialog.blockingAssistants.slice(0, 5).map((assistant) => (
                    <li key={assistant?.id || assistant?.name}>
                      {assistant?.name || assistant?.id || tUi("Unnamed assistant")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {deleteProviderDialog.error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-500">
                {deleteProviderDialog.error}
              </div>
            )}
            {!deleteProviderDialog.loading && deleteProviderDialog.usageChecked && deleteProviderDialog.blockingAssistants.length === 0 && (
              <p className="text-muted-foreground">{tUi("Delete this linked provider connection? You can reconnect it later if needed.")}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                setDeleteProviderDialog({
                  open: false,
                  provider: null,
                  connection: null,
                  blockingAssistants: [],
                  usageChecked: false,
                  loading: false,
                  deleting: false,
                  error: "",
                })
              }
              disabled={deleteProviderDialog.deleting}
            >{tUi("Cancel")}</Button>
            <Button
              type="button"
              variant="destructive"
              onClick={deleteExternalProviderConnection}
              disabled={
                deleteProviderDialog.loading ||
                deleteProviderDialog.deleting ||
                !deleteProviderDialog.usageChecked ||
                deleteProviderDialog.blockingAssistants.length > 0 ||
                !deleteProviderDialog.connection?.id
              }
            >
              {deleteProviderDialog.deleting ? tUi("Deleting…") : tUi("Delete connection")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(toolsDialogProvider)}
        onOpenChange={(open) => {
          if (!open) {
            setToolsDialogProvider(null);
            setSelectedExternalProviderTools([]);
          }
        }}
      >
        <DialogContent className="p-0 gap-0 sm:max-w-2xl overflow-hidden">
          <DialogHeader className="px-6 py-5 border-b">
            <DialogTitle className="text-xl">{tUi("Allowed Tools")}</DialogTitle>
            <DialogDescription>{tUi("Select the tools that you want to allow for this assistant.")}</DialogDescription>
          </DialogHeader>
          <div className="px-6 py-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {selectedExternalProviderTools.length}{tUi(" items selected")}</div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedExternalProviderTools(toolsDialogTools)}
                  disabled={toolsDialogTools.length === 0}
                >{tUi("Select All")}</Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedExternalProviderTools([])}
                  disabled={selectedExternalProviderTools.length === 0}
                >{tUi("Clear")}</Button>
              </div>
            </div>
            <div className="max-h-[55vh] overflow-y-auto rounded-lg border bg-background">
              {toolsDialogTools.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">{tUi("This provider does not advertise any tools.")}</div>
              ) : (
                <div className="divide-y">
                  {toolsDialogTools.map((tool) => {
                    const selected = selectedExternalProviderTools.includes(tool);
                    return (
                      <label
                        key={tool}
                        className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={selected}
                          onCheckedChange={(checked) =>
                            toggleExternalProviderTool(tool, Boolean(checked))
                          }
                        />
                        <span className="font-mono text-xs">{tool}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            {selectedExternalProviderTools.length === 0 ? (
              <p className="text-xs text-destructive">{tUi("Select at least one tool before saving this integration.")}</p>
            ) : null}
          </div>
          <DialogFooter className="px-6 py-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setToolsDialogProvider(null);
                setSelectedExternalProviderTools([]);
              }}
            >{tUi("Cancel")}</Button>
            <Button
              type="button"
              onClick={saveExternalProviderToolsSelection}
              disabled={selectedExternalProviderTools.length === 0}
            >{tUi("Save Tools")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToolsCardsGrid({
  tools,
  assistantId,
  availableVariables,
  onChangeTool,
  onRemoveTool,
  onSaveToolToLibrary,
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {tools.map((tool, index) => (
        <ToolCard
          key={index}
          tool={tool}
          assistantId={assistantId}
          availableVariables={availableVariables}
          onChange={(next) => onChangeTool(index, next)}
          onRemove={() => onRemoveTool(index)}
          onSaveToLibrary={(displayName) =>
            onSaveToolToLibrary(index, tool, displayName)
          }
        />
      ))}
    </div>
  );
}

function ToolCard({
  tool,
  assistantId,
  availableVariables,
  onChange,
  onRemove,
  onSaveToLibrary,
}) {
  const tUi = useUiText();
  const [open, setOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [saveToLibraryDialogOpen, setSaveToLibraryDialogOpen] = useState(false);
  const [saveToLibraryDisplayName, setSaveToLibraryDisplayName] = useState("");
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [saveToLibraryError, setSaveToLibraryError] = useState("");
  const type = tool?.type || "";
  const { name, description } = getAssistantToolDisplay(tool);
  const shared = isLibraryAssistantTool(tool);

  // Check if test icon should be shown (only for webhook tools with assistantId and tool_id)
  const canShowTestIcon = type === "webhook" && assistantId && tool?.tool_id;
  const testWebhookConfig = tool?.webhook;
  const saveToLibraryInputId = `save-tool-display-name-${type || "tool"}`;

  function openSaveToLibraryDialog() {
    setSaveToLibraryDisplayName(tool?.display_name || name || "");
    setSaveToLibraryError("");
    setSaveToLibraryDialogOpen(true);
  }

  async function handleSaveToLibrary() {
    const displayName = saveToLibraryDisplayName.trim();
    if (savingToLibrary || !displayName) return;
    setSavingToLibrary(true);
    setSaveToLibraryError("");
    try {
      await onSaveToLibrary?.(displayName);
      setSaveToLibraryDialogOpen(false);
      setSaveToLibraryDisplayName("");
    } catch (error) {
      console.error("Failed to add tool to Tools Library", error);
      setSaveToLibraryError(error?.message || "Failed to add to Tools Library");
    } finally {
      setSavingToLibrary(false);
    }
  }

  return (
    <Card>
      <CardContent className="px-3 py-1">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="text-sm font-medium inline-flex items-center gap-1">
              {renderAssistantToolIcon(type)}
              {tUi(labelForAssistantToolType(type))}
            </div>
            <div className="text-sm">{name}</div>
            <div className="text-xs text-muted-foreground line-clamp-2">
              {type === "vision" ? tUi(description) : description}
            </div>
            {shared && <p className="text-xs text-muted-foreground mt-1">{tUi("Shared tool · managed in Tools Library")}</p>}
            {saveToLibraryError && (
              <div className="text-xs text-red-500 line-clamp-2">
                {saveToLibraryError}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {canShowTestIcon && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="inline-flex items-center text-blue-500 hover:text-blue-600"
                      aria-label={tUi("Test webhook tool")}
                      onClick={() => {
                        setTestOpen(true);
                      }}
                    >
                      <IconFlask className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{tUi("Test webhook tool")}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-md border border-border text-telnyx-green hover:border-telnyx-green hover:bg-telnyx-green/10"
                    aria-label={tUi("Add tool to Tools Library")}
                    onClick={openSaveToLibraryDialog}
                  >
                    <IconSquareRoundedPlus className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{tUi("Add to Tools Library")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="inline-flex items-center text-telnyx-green"
                    aria-label={tUi(shared ? "Edit in Tools Library" : "Edit tool")}
                    disabled={shared}
                    title={shared ? tUi("Shared definitions are managed in Tools Library. Detach this tool to remove it from this assistant.") : undefined}
                    onClick={() => setOpen(true)}
                    type="button"
                  >
                    <IconPencil className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{tUi("Edit tool")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <AssistantToolEditSheet
              open={open}
              onOpenChange={setOpen}
              tool={tool}
              onSave={onChange}
              assistantId={assistantId}
              availableVariables={availableVariables}
            />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="inline-flex items-center text-red-500 hover:text-red-600"
                    aria-label={tUi("Delete tool")}
                    onClick={onRemove}
                  >
                    <IconTrash className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{tUi("Delete tool")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </CardContent>

      <Dialog
        open={saveToLibraryDialogOpen}
        onOpenChange={(nextOpen) => {
          setSaveToLibraryDialogOpen(nextOpen);
          if (!nextOpen) setSaveToLibraryError("");
        }}
      >
        <DialogContent className="p-0 gap-0 sm:max-w-2xl overflow-hidden">
          <DialogHeader className="px-6 py-5 border-b">
            <DialogTitle className="text-xl">{tUi("Save Tool to Library")}</DialogTitle>
          </DialogHeader>
          <div className="px-6 py-5 space-y-4">
            <DialogDescription className="text-base text-foreground">{tUi("Save this tool to your library to reuse it across multiple assistants.")}</DialogDescription>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor={saveToLibraryInputId}
                  className="text-sm font-medium inline-flex items-center gap-1"
                >{tUi("Display Name")}<IconHelpCircle className="size-4 text-muted-foreground" />
                </label>
                <span className="text-sm italic text-muted-foreground">{tUi("Required")}</span>
              </div>
              <Input
                id={saveToLibraryInputId}
                value={saveToLibraryDisplayName}
                onChange={(event) => setSaveToLibraryDisplayName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleSaveToLibrary();
                  }
                }}
                autoFocus
              />
              {saveToLibraryError && (
                <p className="text-xs text-red-500">{saveToLibraryError}</p>
              )}
            </div>
          </div>
          <DialogFooter className="px-6 py-4 border-t">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSaveToLibraryDialogOpen(false)}
              disabled={savingToLibrary}
            >{tUi("Cancel")}</Button>
            <Button
              type="button"
              onClick={handleSaveToLibrary}
              disabled={savingToLibrary || !saveToLibraryDisplayName.trim()}
            >
              {savingToLibrary ? tUi("Saving…") : tUi("Save to Library")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Webhook Test Sheet */}
      {type === "webhook" && (
        <WebhookTestSheet
          open={testOpen}
          onOpenChange={setTestOpen}
          webhookConfig={testWebhookConfig}
          assistantId={assistantId}
          toolId={tool?.tool_id || `tool-${crypto.randomUUID()}`}
        />
      )}
    </Card>
  );
}

function WebhookEditor({ tool, onChange }) {
  const tUi = useUiText();
  const wh = tool?.webhook || {};
  function update(partial) {
    onChange({ ...tool, webhook: { ...(tool?.webhook || {}), ...partial } });
  }
  const headers = Array.isArray(wh.headers) ? wh.headers : [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="text-xs">{tUi("Name")}</label>
          <Input
            value={wh.name || ""}
            onChange={(e) => update({ name: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs">{tUi("Method")}</label>
          <Select
            value={wh.method || "POST"}
            onValueChange={(val) => update({ method: val })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {"GET POST PUT DELETE PATCH".split(" ").map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <label className="text-xs">{tUi("Description")}</label>
          <Input
            value={wh.description || ""}
            onChange={(e) => update({ description: e.target.value })}
          />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs">{tUi("URL")}</label>
          <Input
            value={wh.url || wh.webhook_url || ""}
            onChange={(e) =>
              update({ url: e.target.value, webhook_url: e.target.value })
            }
          />
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-xs">{tUi("Headers")}</div>
        <div className="space-y-2">
          {headers.map((h, i) => (
            <div
              key={i}
              className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
            >
              <Input
                className="md:col-span-5"
                placeholder={tUi("Header name")}
                value={h?.name || ""}
                onChange={(e) => {
                  const next = headers.map((x, idx) =>
                    idx === i ? { ...x, name: e.target.value } : x
                  );
                  update({ headers: next });
                }}
              />
              <Input
                className="md:col-span-5"
                placeholder={tUi("Header value")}
                value={h?.value || ""}
                onChange={(e) => {
                  const next = headers.map((x, idx) =>
                    idx === i ? { ...x, value: e.target.value } : x
                  );
                  update({ headers: next });
                }}
              />
              <div className="md:col-span-2 flex justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    update({ headers: headers.filter((_, idx) => idx !== i) })
                  }
                >{tUi("Remove")}</Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            onClick={() =>
              update({ headers: [...headers, { name: "", value: "" }] })
            }
          >{tUi("Add Header")}</Button>
        </div>
      </div>
    </div>
  );
}

function HandoffEditor({ tool, onChange }) {
  const tUi = useUiText();
  const ho = tool?.handoff || {};
  function update(partial) {
    onChange({ ...tool, handoff: { ...(tool?.handoff || {}), ...partial } });
  }
  const list = Array.isArray(ho.ai_assistants) ? ho.ai_assistants : [];
  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs">{tUi("Voice Mode")}</label>
        <Select
          value={ho.voice_mode || "unified"}
          onValueChange={(val) => update({ voice_mode: val })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unified">{tUi("Unified")}</SelectItem>
            <SelectItem value="distinct">{tUi("Distinct")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <div className="text-xs">{tUi("Handoff Targets (Assistants)")}</div>
        {list.map((t, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-6"
              placeholder={tUi("Name")}
              value={t?.name || ""}
              onChange={(e) => {
                const next = list.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x
                );
                update({ ai_assistants: next });
              }}
            />
            <Input
              className="md:col-span-4"
              placeholder={tUi("Assistant ID")}
              value={t?.id || ""}
              onChange={(e) => {
                const next = list.map((x, idx) =>
                  idx === i ? { ...x, id: e.target.value } : x
                );
                update({ ai_assistants: next });
              }}
            />
            <div className="md:col-span-2 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  update({ ai_assistants: list.filter((_, idx) => idx !== i) })
                }
              >{tUi("Remove")}</Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          onClick={() =>
            update({ ai_assistants: [...list, { name: "", id: "" }] })
          }
        >{tUi("Add Assistant")}</Button>
      </div>
    </div>
  );
}

function TransferEditor({ tool, onChange }) {
  const tUi = useUiText();
  const tr = tool?.transfer || {};
  function update(partial) {
    onChange({ ...tool, transfer: { ...(tool?.transfer || {}), ...partial } });
  }
  const targets = Array.isArray(tr.targets) ? tr.targets : [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="md:col-span-2">
          <label className="text-xs">{tUi("From")}</label>
          <Input
            value={tr.from || ""}
            onChange={(e) => update({ from: e.target.value })}
            placeholder="+13125551234"
          />
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-xs">{tUi("Targets")}</div>
        {targets.map((t, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-6"
              placeholder={tUi("Name")}
              value={t?.name || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x
                );
                update({ targets: next });
              }}
            />
            <Input
              className="md:col-span-4"
              placeholder={tUi("To (E.164 or SIP URI)")}
              value={t?.to || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, to: e.target.value } : x
                );
                update({ targets: next });
              }}
            />
            <div className="md:col-span-2 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  update({ targets: targets.filter((_, idx) => idx !== i) })
                }
              >{tUi("Remove")}</Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          onClick={() =>
            update({ targets: [...targets, { name: "", to: "" }] })
          }
        >{tUi("Add Target")}</Button>
      </div>
    </div>
  );
}

function ReferEditor({ tool, onChange }) {
  const tUi = useUiText();
  const rf = tool?.refer || {};
  function update(partial) {
    onChange({ ...tool, refer: { ...(tool?.refer || {}), ...partial } });
  }
  const targets = Array.isArray(rf.targets) ? rf.targets : [];
  const sipHeaders = Array.isArray(rf.sip_headers) ? rf.sip_headers : [];
  const customHeaders = Array.isArray(rf.custom_headers)
    ? rf.custom_headers
    : [];
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-xs">{tUi("Targets")}</div>
        {targets.map((t, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-3"
              placeholder={tUi("Name")}
              value={t?.name || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x
                );
                update({ targets: next });
              }}
            />
            <Input
              className="md:col-span-4"
              placeholder={tUi("SIP Address (sip:user@domain)")}
              value={t?.sip_address || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, sip_address: e.target.value } : x
                );
                update({ targets: next });
              }}
            />
            <Input
              className="md:col-span-2"
              placeholder={tUi("SIP Auth Username")}
              value={t?.sip_auth_username || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, sip_auth_username: e.target.value } : x
                );
                update({ targets: next });
              }}
            />
            <Input
              className="md:col-span-2"
              placeholder={tUi("SIP Auth Password")}
              value={t?.sip_auth_password || ""}
              onChange={(e) => {
                const next = targets.map((x, idx) =>
                  idx === i ? { ...x, sip_auth_password: e.target.value } : x
                );
                update({ targets: next });
              }}
            />
            <div className="md:col-span-1 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  update({ targets: targets.filter((_, idx) => idx !== i) })
                }
              >{tUi("Remove")}</Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          onClick={() =>
            update({ targets: [...targets, { name: "", sip_address: "" }] })
          }
        >{tUi("Add Target")}</Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs">{tUi("SIP Headers (User-to-User or Diversion)")}</div>
        {sipHeaders.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Select
              value={h?.name || "User-to-User"}
              onValueChange={(val) => {
                const next = sipHeaders.map((x, idx) =>
                  idx === i ? { ...x, name: val } : x
                );
                update({ sip_headers: next });
              }}
            >
              <SelectTrigger className="md:col-span-3">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="User-to-User">{tUi("User-to-User")}</SelectItem>
                <SelectItem value="Diversion">{tUi("Diversion")}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="md:col-span-8"
              placeholder={tUi("Header value")}
              value={h?.value || ""}
              onChange={(e) => {
                const next = sipHeaders.map((x, idx) =>
                  idx === i ? { ...x, value: e.target.value } : x
                );
                update({ sip_headers: next });
              }}
            />
            <div className="md:col-span-1 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  update({
                    sip_headers: sipHeaders.filter((_, idx) => idx !== i),
                  })
                }
              >{tUi("Remove")}</Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          onClick={() =>
            update({
              sip_headers: [...sipHeaders, { name: "User-to-User", value: "" }],
            })
          }
        >{tUi("Add SIP Header")}</Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs">{tUi("Custom Headers")}</div>
        {customHeaders.map((h, i) => (
          <div
            key={i}
            className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center"
          >
            <Input
              className="md:col-span-4"
              placeholder={tUi("Header name")}
              value={h?.name || ""}
              onChange={(e) => {
                const next = customHeaders.map((x, idx) =>
                  idx === i ? { ...x, name: e.target.value } : x
                );
                update({ custom_headers: next });
              }}
            />
            <Input
              className="md:col-span-7"
              placeholder={tUi("Header value")}
              value={h?.value || ""}
              onChange={(e) => {
                const next = customHeaders.map((x, idx) =>
                  idx === i ? { ...x, value: e.target.value } : x
                );
                update({ custom_headers: next });
              }}
            />
            <div className="md:col-span-1 flex justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  update({
                    custom_headers: customHeaders.filter((_, idx) => idx !== i),
                  })
                }
              >{tUi("Remove")}</Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          onClick={() =>
            update({
              custom_headers: [...customHeaders, { name: "", value: "" }],
            })
          }
        >{tUi("Add Custom Header")}</Button>
      </div>
    </div>
  );
}

function DtmfEditor({ tool, onChange }) {
  const tUi = useUiText();
  // Minimal editor; schema allows arbitrary properties, but none are required
  return (
    <div className="text-xs text-muted-foreground">{tUi("No configuration required.")}</div>
  );
}

function HangupEditor({ tool, onChange }) {
  const tUi = useUiText();
  const hp = tool?.hangup || {};
  function update(partial) {
    onChange({ ...tool, hangup: { ...(tool?.hangup || {}), ...partial } });
  }
  return (
    <div>
      <label className="text-xs">{tUi("Description (optional)")}</label>
      <Textarea
        rows={2}
        value={hp.description || ""}
        onChange={(e) => update({ description: e.target.value })}
      />
    </div>
  );
}

function DynamicVariablesEditor({ entries, onUpsert, onRemove }) {
  const tUi = useUiText();
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingIndex, setEditingIndex] = useState(null);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");

  function handleAdd() {
    if (!newName.trim()) return;
    onUpsert(newName.trim(), newValue);
    setNewName("");
    setNewValue("");
  }

  function handleEdit(index, name, value) {
    setEditingIndex(index);
    setEditName(name);
    setEditValue(String(value));
  }

  function handleSaveEdit() {
    if (!editName.trim()) return;
    onUpsert(editName.trim(), editValue);
    setEditingIndex(null);
    setEditName("");
    setEditValue("");
  }

  function handleCancelEdit() {
    setEditingIndex(null);
    setEditName("");
    setEditValue("");
  }

  function handleKeyPress(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (editingIndex !== null) {
        handleSaveEdit();
      } else {
        handleAdd();
      }
    }
    if (e.key === "Escape") {
      if (editingIndex !== null) {
        handleCancelEdit();
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">{tUi("Dynamic variables are key-value pairs that can be used in your assistant's responses. They can be populated from webhooks or set manually.")}</div>

      {/* Add New Variable Card */}
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">{tUi("Add New Variable")}</div>
            <div className="h-px bg-border flex-1" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{tUi("Variable Name")}</label>
              <Input
                placeholder={tUi("e.g., user_name, company_id")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyPress={handleKeyPress}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">{tUi("Description")}</label>
              <Input
                placeholder={tUi("e.g., Customer's first name")}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyPress={handleKeyPress}
              />
            </div>
          </div>
          <Button
            type="button"
            onClick={handleAdd}
            disabled={!newName.trim()}
            className="w-full"
          >{tUi("Add Variable")}</Button>
        </CardContent>
      </Card>

      {/* Existing Variables Section */}
      <div className="space-y-3">
        <div className="text-sm font-medium">{tUi("Existing Variables")}</div>
        <Card>
          <CardContent className="pt-0">
            {entries.length === 0 ? (
              <div className="text-center py-8 border rounded-lg bg-muted/20">
                <div className="text-sm text-muted-foreground mb-2">{tUi("No dynamic variables configured")}</div>
                <div className="text-xs text-muted-foreground">{tUi("Add variables above to get started")}</div>
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto space-y-2">
                {entries.map(([name, value], index) => (
                  <div
                    key={index}
                    className={`group border rounded-lg transition-all ${
                      editingIndex === index
                        ? "border-telnyx-green bg-telnyx-green/5"
                        : "border-border hover:border-telnyx-green/50 hover:bg-telnyx-green/2"
                    }`}
                  >
                    {editingIndex === index ? (
                      // Edit Mode
                      <div className="p-4 space-y-3">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-xs text-muted-foreground">{tUi("Variable Name")}</label>
                            <Input
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyPress={handleKeyPress}
                              autoFocus
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs text-muted-foreground">{tUi("Value")}</label>
                            <Input
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyPress={handleKeyPress}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            onClick={handleSaveEdit}
                            disabled={!editName.trim()}
                          >{tUi("Save Changes")}</Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={handleCancelEdit}
                          >{tUi("Cancel")}</Button>
                        </div>
                      </div>
                    ) : (
                      // View Mode
                      <div className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <div className="text-sm font-medium text-telnyx-green">
                                {name}
                              </div>
                              <div className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{tUi("variable")}</div>
                            </div>
                            <div className="text-sm text-muted-foreground break-words">
                              {String(value) || (
                                <span className="italic">{tUi("No value set")}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 ml-4">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEdit(index, name, value)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              <IconPencil className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => onRemove(name)}
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600"
                            >
                              <IconTrash className="size-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
