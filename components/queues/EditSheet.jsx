"use client";

import React, { useMemo } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import { Skeleton } from "@/components/ui/skeleton";
import { IconEdit } from "@tabler/icons-react";
import { notify } from "@/components/ToastNotify";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  IconFileMusic,
  IconPlayerPlay,
  IconPlayerStop,
  IconStar,
  IconStarFilled,
  IconWorld,
  IconCheck,
} from "@tabler/icons-react";

// Helper functions for language filtering
function normalizeLocaleCode(code) {
  try {
    const s = String(code || "").replace(/_/g, "-");
    const m = s.match(/^([a-zA-Z]{2,3})-([a-zA-Z]{2}|\d{3})$/);
    if (!m) return null;
    const lang = m[1].toLowerCase();
    const region = m[2].toUpperCase();
    return `${lang}-${region}`;
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

const ROUTING_STRATEGIES = [
  { value: "FIFO", label: "FIFO" },
  { value: "Skill-based", label: "Skill-based" },
  { value: "Priority-based", label: "Priority-based" },
];

const OVERFLOW_ACTIONS = [
  { value: "transfer", label: "Transfer" },
  { value: "voicemail", label: "Voicemail" },
  { value: "hangup", label: "Hangup" },
];

const POSITION_INTERVALS = [
  { value: 30, label: "30 seconds" },
  { value: 60, label: "60 seconds" },
  { value: 120, label: "120 seconds" },
];

// Parse voice string (Provider.Model.VoiceId format)
function parseVoiceString(value) {
  const safe = String(value || "").trim();
  if (!safe) return { provider: "", model: "", voiceName: "" };
  const parts = safe.split(".");
  const provider = parts[0] || "";
  if (parts.length >= 3) {
    return {
      provider,
      model: parts[1] || "",
      voiceName: safe,
    };
  }
  if (parts.length === 2) {
    return {
      provider,
      model: "",
      voiceName: safe,
    };
  }
  return { provider, model: "", voiceName: safe };
}

// Build voice string
function buildVoiceString(provider, model, voiceName) {
  return voiceName || "";
}

// Star rating component for call priority (1-5 stars)
function StarRating({ value, onChange, maxStars = 5 }) {
  return (
    <div className="flex gap-1">
      {Array.from({ length: maxStars }, (_, i) => {
        const starValue = i + 1;
        const filled = starValue <= value;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onChange(starValue)}
            className="focus:outline-none"
            aria-label={`Set rating to ${starValue} stars`}
          >
            {filled ? (
              <IconStarFilled className="w-5 h-5 text-yellow-400" />
            ) : (
              <IconStar className="w-5 h-5 text-gray-300" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// Star rating component for queue priority (1-5 stars, minimum 1 star)
function QueuePriorityStarRating({ value = 1, onChange, maxStars = 5 }) {
  const currentValue = value && value >= 1 ? value : 1; // Ensure minimum is 1
  return (
    <div className="flex gap-1 items-center">
      {Array.from({ length: maxStars }, (_, i) => {
        const starValue = i + 1;
        const filled = starValue <= currentValue;
        return (
          <button
            key={i}
            type="button"
            onClick={() => {
              // Set to clicked star value (minimum is 1, cannot go below)
              onChange(starValue);
            }}
            className="focus:outline-none"
            aria-label={`Set priority to ${starValue} stars`}
          >
            {filled ? (
              <IconStarFilled className="w-4 h-4 text-yellow-400" />
            ) : (
              <IconStar className="w-4 h-4 text-gray-300" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Edit sheet component for Queues
 * @param {object} props
 * @param {boolean} props.open - Whether the sheet is open
 * @param {function} props.onOpenChange - Callback when sheet open state changes
 * @param {string} props.queueId - Queue ID to edit
 * @param {function} props.onSaveComplete - Callback when save is complete
 */
export default function EditSheet({
  open,
  onOpenChange,
  queueId,
  onSaveComplete,
}) {
  const [name, setName] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [routingStrategy, setRoutingStrategy] = React.useState("FIFO");
  const [maxWaitTimeSecs, setMaxWaitTimeSecs] = React.useState(600);
  const [maxSize, setMaxSize] = React.useState(100);
  const [timeoutSecs, setTimeoutSecs] = React.useState(300);
  const [agentAnswerTimeoutSecs, setAgentAnswerTimeoutSecs] =
    React.useState(30);
  const [overflowQueueId, setOverflowQueueId] = React.useState("");
  const [overflowAction, setOverflowAction] = React.useState("transfer");
  const [enabled, setEnabled] = React.useState(true);
  const [active, setActive] = React.useState(true);
  const [skillRequirements, setSkillRequirements] = React.useState({});
  const [priorityRules, setPriorityRules] = React.useState([]);
  const [assignedUserIds, setAssignedUserIds] = React.useState([]); // Array of user IDs
  const [availableQueues, setAvailableQueues] = React.useState([]);
  const [availableUsers, setAvailableUsers] = React.useState([]);
  const [availableWrapupCodes, setAvailableWrapupCodes] = React.useState([]);
  const [selectedWrapupCodes, setSelectedWrapupCodes] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  // Queue Audio Settings
  const [queueAudioMediaName, setQueueAudioMediaName] = React.useState("");
  const [queueAudioEnablePosition, setQueueAudioEnablePosition] =
    React.useState(false);
  const [queueAudioPositionInterval, setQueueAudioPositionInterval] =
    React.useState(60);
  const [queueAudioTtsVoice, setQueueAudioTtsVoice] =
    React.useState("AWS.Polly.Joanna");
  const [queueAudioTtsVoiceApiKeyRef, setQueueAudioTtsVoiceApiKeyRef] =
    React.useState("");
  const [mediaFiles, setMediaFiles] = React.useState([]);

  // Debug: Track mediaFiles changes
  React.useEffect(() => {
    console.log(
      "[Queue EditSheet] mediaFiles state changed:",
      mediaFiles.length,
      "files",
    );
    if (mediaFiles.length > 0) {
      console.log(
        "[Queue EditSheet] Media file names:",
        mediaFiles.map((f) => f.media_name),
      );
    }
  }, [mediaFiles]);

  const [ttsProviders, setTtsProviders] = React.useState([]);
  const [ttsSecrets, setTtsSecrets] = React.useState([]);
  const [ttsLoading, setTtsLoading] = React.useState(false);
  const [ttsProvider, setTtsProvider] = React.useState("AWS");
  const [ttsModel, setTtsModel] = React.useState("");
  const [ttsVoiceName, setTtsVoiceName] = React.useState("");
  const [ttsLanguageFilter, setTtsLanguageFilter] = React.useState("");
  const [ttsLanguageSearch, setTtsLanguageSearch] = React.useState("");
  const [ttsLanguagePopoverOpen, setTtsLanguagePopoverOpen] = React.useState(false);
  const [isPlayingMedia, setIsPlayingMedia] = React.useState(false);
  const audioRef = React.useRef(null);
  const [isTestingTts, setIsTestingTts] = React.useState(false);
  const ttsTestAudioRef = React.useRef(null);

  // New routing engine fields
  const [queuePriority, setQueuePriority] = React.useState(1); // Queue priority 1-5 stars
  const [defaultCallPriority, setDefaultCallPriority] = React.useState(3);
  const [skillRelaxationEnabled, setSkillRelaxationEnabled] =
    React.useState(false);
  const [skillRelaxationAfterSeconds, setSkillRelaxationAfterSeconds] =
    React.useState(60);
  const [skillRelaxationStrategy, setSkillRelaxationStrategy] =
    React.useState("progressive");
  const [slaAnswerThresholdSeconds, setSlaAnswerThresholdSeconds] =
    React.useState(20);
  const [slaTargetPercentage, setSlaTargetPercentage] = React.useState(80);
  const [userAssignmentsWithCapacity, setUserAssignmentsWithCapacity] =
    React.useState({}); // { userId: { priority } }

  // Get all voices for selected TTS provider and model (before language filtering)
  const allTtsVoices = useMemo(() => {
    const provider = ttsProviders.find((p) => p.id === ttsProvider || p.provider === ttsProvider);
    if (!provider?.models) return [];
    
    // If no model selected, get all voices from all models
    if (!ttsModel || ttsModel === "__default__") {
      const allVoices = [];
      for (const m of provider.models) {
        const modelVoices = typeof m === "object" && m.voices ? m.voices : [];
        allVoices.push(...modelVoices);
      }
      return allVoices.filter((v) => v?.id);
    }
    
    // Find specific model and return its voices
    const modelObj = provider.models.find(
      (m) => (typeof m === "object" ? m.id || m.name : m) === ttsModel
    );
    if (modelObj && typeof modelObj === "object" && modelObj.voices) {
      return modelObj.voices.filter((v) => v?.id);
    }
    return [];
  }, [ttsProviders, ttsProvider, ttsModel]);

  // Extract available languages from voices
  const ttsLanguageOptions = useMemo(() => {
    const map = new Map();
    let langNames = null;
    let regionNames = null;
    try {
      langNames = new Intl.DisplayNames(undefined, { type: "language" });
      regionNames = new Intl.DisplayNames(undefined, { type: "region" });
    } catch (_) {}

    for (const v of allTtsVoices) {
      const norm = normalizeLocaleCode(v?.language);
      if (!norm || map.has(norm)) continue;
      const [lang, region] = norm.split("-");
      let label = norm.toUpperCase();
      try {
        const ln = langNames?.of(lang) || lang.toUpperCase();
        const rn = regionNames?.of(region) || region.toUpperCase();
        label = `${ln} (${rn})`;
      } catch (_) {}
      const flag = regionToFlag(region);
      map.set(norm, { value: norm, label, flag });
    }
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
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
  const filteredTtsVoices = useMemo(() => {
    let filtered = allTtsVoices;
    if (ttsLanguageFilter) {
      filtered = filtered.filter(
        (v) => normalizeLocaleCode(v?.language) === ttsLanguageFilter
      );
    }
    return filtered;
  }, [allTtsVoices, ttsLanguageFilter]);

  // Get selected language display info
  const selectedTtsLanguageInfo = useMemo(() => {
    if (!ttsLanguageFilter) return null;
    return ttsLanguageOptions.find((opt) => opt.value === ttsLanguageFilter);
  }, [ttsLanguageFilter, ttsLanguageOptions]);

  // Load queue data when queueId changes
  React.useEffect(() => {
    async function loadQueue() {
      if (!queueId || !open) {
        // Reset form for new queue
        if (open && !queueId) {
          setName("");
          setDisplayName("");
          setDescription("");
          setRoutingStrategy("FIFO");
          setMaxWaitTimeSecs(600);
          setMaxSize(100);
          setTimeoutSecs(300);
          setAgentAnswerTimeoutSecs(30);
          setOverflowQueueId("");
          setOverflowAction("transfer");
          setEnabled(true);
          setActive(true);
          setSkillRequirements({});
          setPriorityRules([]);
          setAssignedUserIds([]);
          setSelectedWrapupCodes([]);
          setQueueAudioMediaName("");
          setQueueAudioEnablePosition(false);
          setQueueAudioPositionInterval(60);
          setQueueAudioTtsVoice("AWS.Polly.Joanna");
          setQueueAudioTtsVoiceApiKeyRef("");
          setTtsProvider("AWS");
          setTtsModel("");
          setTtsVoiceName("");
          setTtsLanguageFilter("");
          setQueuePriority(1);
          setDefaultCallPriority(3);
          setSkillRelaxationEnabled(false);
          setSkillRelaxationAfterSeconds(60);
          setSkillRelaxationStrategy("progressive");
          setSlaAnswerThresholdSeconds(20);
          setSlaTargetPercentage(80);
          setUserAssignmentsWithCapacity({});
        }
        return;
      }

      setLoading(true);
      try {
        const r = await fetch(
          `/api/admin/queues/${encodeURIComponent(queueId)}`,
          {
            cache: "no-store",
          },
        );
        const d = await r.json();
        if (r.ok) {
          setName(d.name || "");
          setDisplayName(d.display_name || "");
          setDescription(d.description || "");
          setRoutingStrategy(d.routing_strategy || "FIFO");
          setMaxWaitTimeSecs(d.max_wait_time_secs || 600);
          setMaxSize(d.max_size || 100);
          setTimeoutSecs(d.timeout_secs || 300);
          setAgentAnswerTimeoutSecs(d.agent_answer_timeout_secs || 30);
          setOverflowQueueId(d.overflow_queue_id || "");
          setOverflowAction(d.overflow_action || "transfer");
          setEnabled(d.enabled !== undefined ? d.enabled : true);
          setActive(d.active !== undefined ? Boolean(d.active) : true);
          // Load queue priority (1-5, default 1 if 0 or not set)
          const loadedPriority =
            d.priority !== undefined &&
            d.priority !== null &&
            d.priority >= 1 &&
            d.priority <= 5
              ? d.priority
              : 1;
          setQueuePriority(loadedPriority);
          setSkillRequirements(
            typeof d.skill_requirements === "string"
              ? JSON.parse(d.skill_requirements)
              : d.skill_requirements || {},
          );
          setPriorityRules(
            typeof d.priority_rules === "string"
              ? JSON.parse(d.priority_rules)
              : d.priority_rules || [],
          );
          // Extract user IDs from assignments and store capacity overrides
          const assignments = (d.userAssignments || []).filter(
            (ua) => ua.enabled !== false,
          );
          setAssignedUserIds(
            assignments.map((ua) => ua.user_id).filter(Boolean),
          );

          // Store assignment details (priority 1-5, default 1)
          const assignmentsMap = {};
          assignments.forEach((ua) => {
            if (ua.user_id) {
              const priority =
                ua.priority !== undefined &&
                ua.priority !== null &&
                ua.priority >= 1
                  ? ua.priority
                  : 1;
              assignmentsMap[ua.user_id] = {
                priority: priority,
              };
            }
          });
          setUserAssignmentsWithCapacity(assignmentsMap);

          // Load new routing engine fields
          setDefaultCallPriority(d.default_call_priority || 3);
          setSkillRelaxationEnabled(d.skill_relaxation_enabled || false);
          setSkillRelaxationAfterSeconds(
            d.skill_relaxation_after_seconds || 60,
          );
          setSkillRelaxationStrategy(
            d.skill_relaxation_strategy || "progressive",
          );
          setSlaAnswerThresholdSeconds(d.sla_answer_threshold_seconds || 20);
          setSlaTargetPercentage(d.sla_target_percentage || 80);
          setSelectedWrapupCodes(
            (d.wrapupCodes || [])
              .map((code) => code.wrapup_code_id)
              .filter(Boolean),
          );

          // Load queue audio settings
          setQueueAudioMediaName(d.queue_audio_media_name || "");
          setQueueAudioEnablePosition(d.queue_audio_enable_position || false);
          setQueueAudioPositionInterval(
            d.queue_audio_position_interval_secs || 60,
          );
          setQueueAudioTtsVoice(d.queue_audio_tts_voice || "AWS.Polly.Joanna");
          setQueueAudioTtsVoiceApiKeyRef(
            d.queue_audio_tts_voice_api_key_ref || "",
          );

          // Parse TTS voice string
          if (d.queue_audio_tts_voice) {
            const parts = d.queue_audio_tts_voice.split(".");
            setTtsProvider(parts[0] || "AWS");
            setTtsModel(parts.length >= 3 ? parts[1] : "");
            setTtsVoiceName(d.queue_audio_tts_voice);
          }
        } else {
          notify({
            title: "Failed to load queue",
            description: d?.error || "",
            variant: "error",
          });
        }
      } catch (err) {
        notify({
          title: "Failed to load queue",
          description: String(err.message || err),
          variant: "error",
        });
      } finally {
        setLoading(false);
      }
    }

    if (open && queueId) {
      loadQueue();
    }
  }, [queueId, open]);

  // Load available queues and users
  React.useEffect(() => {
    async function loadData() {
      if (!open) return;

      try {
        // Load queues for overflow selection
        const queuesRes = await fetch("/api/admin/queues?pageSize=1000", {
          cache: "no-store",
        });
        if (queuesRes.ok) {
          const queuesData = await queuesRes.json();
          setAvailableQueues(
            (queuesData.rows || []).filter((q) => q.id !== queueId),
          );
        }

        const wrapupRes = await fetch(
          "/api/admin/wrapup-codes?pageSize=1000&active=true",
          {
            cache: "no-store",
          },
        );
        if (wrapupRes.ok) {
          const wrapupData = await wrapupRes.json();
          setAvailableWrapupCodes(wrapupData.items || []);
        }

        // Load users for assignments
        const usersRes = await fetch("/api/admin/users?pageSize=1000", {
          cache: "no-store",
        });
        if (usersRes.ok) {
          const usersData = await usersRes.json();
          setAvailableUsers(usersData.rows || []);
        }

        // Load media files for queue audio
        try {
          const mediaRes = await fetch(
            "/api/admin/media-library?pageSize=1000",
            {
              cache: "no-store",
            },
          );
          if (mediaRes.ok) {
            const mediaData = await mediaRes.json();
            console.log("[Queue EditSheet] Media files response:", {
              itemsCount: mediaData.items?.length || 0,
              total: mediaData.total,
              sampleItems: mediaData.items?.slice(0, 3).map((item) => ({
                media_name: item.media_name,
                content_type: item.content_type,
              })),
            });
            const files = (mediaData.items || []).filter(
              (file) => file && file.media_name,
            );
            console.log(
              "[Queue EditSheet] Setting mediaFiles state with:",
              files.length,
              "files",
              files.map((f) => f.media_name),
            );
            if (files.length > 0) {
              setMediaFiles(files);
            } else {
              console.warn(
                "[Queue EditSheet] No valid media files after filtering",
              );
              setMediaFiles([]);
            }

            // Debug: Log after state update attempt
            setTimeout(() => {
              console.log(
                "[Queue EditSheet] mediaFiles state check (after setState):",
                files.length,
              );
            }, 100);
            if (mediaData.items && mediaData.items.length === 0) {
              console.warn(
                "[Queue EditSheet] No media files found. Check if files are uploaded and have audio content type or extension.",
              );
            }
          } else {
            const errorData = await mediaRes.json().catch(() => ({}));
            console.error(
              "[Queue EditSheet] Failed to load media files:",
              errorData.error || mediaRes.statusText,
            );
          }
        } catch (err) {
          console.error("[Queue EditSheet] Error loading media files:", err);
        }

        // Load TTS providers and voices
        setTtsLoading(true);
        try {
          const ttsRes = await fetch("/api/tts/voices", { cache: "no-store" });
          if (ttsRes.ok) {
            const ttsData = await ttsRes.json();
            if (ttsData?.ok) {
              setTtsProviders(ttsData.providers || []);
            }
          }
        } catch (err) {
          console.error("Failed to load TTS voices:", err);
        } finally {
          setTtsLoading(false);
        }

        // Load secrets for ElevenLabs
        if (ttsProvider === "ElevenLabs") {
          try {
            const secretsRes = await fetch("/api/admin/secrets?type=api_key", {
              cache: "no-store",
            });
            if (secretsRes.ok) {
              const secretsData = await secretsRes.json();
              setTtsSecrets(secretsData.items || []);
            }
          } catch (err) {
            console.error("Failed to load secrets:", err);
          }
        }
      } catch (err) {
        console.error("Failed to load data:", err);
      }
    }

    if (open) {
      loadData();
    }
  }, [open, queueId, ttsProvider]);

  // Update TTS voice string when provider/model/voice changes
  React.useEffect(() => {
    if (ttsVoiceName) {
      const voiceStr = buildVoiceString(ttsProvider, ttsModel, ttsVoiceName);
      setQueueAudioTtsVoice(voiceStr);
    }
  }, [ttsProvider, ttsModel, ttsVoiceName]);

  // Cleanup audio on unmount or when media changes
  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setIsPlayingMedia(false);
    };
  }, []);

  // Stop audio when media name changes
  React.useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsPlayingMedia(false);
  }, [queueAudioMediaName]);

  // Cleanup TTS test audio on unmount
  React.useEffect(() => {
    return () => {
      if (ttsTestAudioRef.current) {
        ttsTestAudioRef.current.pause();
        ttsTestAudioRef.current = null;
      }
      setIsTestingTts(false);
    };
  }, []);

  function toggleWrapupCode(codeId) {
    setSelectedWrapupCodes((prev) => {
      if (prev.includes(codeId)) {
        return prev.filter((id) => id !== codeId);
      }
      return [...prev, codeId];
    });
  }

  function toggleAllWrapupCodes() {
    const allSelected =
      availableWrapupCodes.length > 0 &&
      availableWrapupCodes.every((code) =>
        selectedWrapupCodes.includes(code.id),
      );
    if (allSelected) {
      // Deselect all
      setSelectedWrapupCodes([]);
    } else {
      // Select all
      setSelectedWrapupCodes(availableWrapupCodes.map((code) => code.id));
    }
  }

  async function onSave() {
    if (!name.trim()) {
      notify({
        title: "Queue name is required",
        variant: "error",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        displayName: displayName.trim() || null,
        description: description.trim() || null,
        routingStrategy,
        maxWaitTimeSecs: Number(maxWaitTimeSecs),
        maxSize: Number(maxSize),
        timeoutSecs: Number(timeoutSecs),
        agentAnswerTimeoutSecs: Number(agentAnswerTimeoutSecs),
        overflowQueueId: overflowQueueId || null,
        overflowAction,
        enabled,
        active,
        skillRequirements,
        priorityRules,
        wrapupCodes: selectedWrapupCodes,
        userAssignments: assignedUserIds.map((userId) => {
          const priority = userAssignmentsWithCapacity[userId]?.priority;
          return {
            userId,
            priority:
              priority !== undefined && priority !== null && priority >= 1
                ? priority
                : 1,
            enabled: true,
          };
        }),
        priority: queuePriority, // Queue priority 1-5 stars
        defaultCallPriority,
        skillRelaxationEnabled,
        skillRelaxationAfterSeconds,
        skillRelaxationStrategy,
        slaAnswerThresholdSeconds,
        slaTargetPercentage,
        queueAudioMediaName: queueAudioMediaName || null,
        queueAudioEnablePosition: queueAudioEnablePosition,
        queueAudioPositionIntervalSecs: Number(queueAudioPositionInterval),
        queueAudioTtsVoice: queueAudioTtsVoice || null,
        queueAudioTtsVoiceApiKeyRef: queueAudioTtsVoiceApiKeyRef || null,
      };

      let r;
      if (queueId) {
        // Update existing queue
        r = await fetch(`/api/admin/queues/${encodeURIComponent(queueId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        // Create new queue
        r = await fetch(`/api/admin/queues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      if (r.ok) {
        notify({
          title: "Queue updated",
          description: "The queue has been updated successfully",
          variant: "success",
        });
        onOpenChange(false);
        onSaveComplete && onSaveComplete();
      } else {
        const d = await r.json().catch(() => ({}));
        notify({
          title: "Failed to update queue",
          description: d?.error || "",
          variant: "error",
        });
      }
    } catch (err) {
      notify({
        title: "Failed to update queue",
        description: String(err.message || err),
        variant: "error",
      });
    } finally {
      setSaving(false);
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
            <IconEdit className="size-5" />
            {queueId ? "Edit Queue" : "Create Queue"}
          </SheetTitle>
        </SheetHeader>

        {/* Scrollable Content Section */}
        <div className="flex-1 overflow-y-auto">
          <Card className="mx-5 my-4">
            <CardContent className="p-6 space-y-4">
              {loading ? (
                <>
                  <Skeleton className="h-4 w-40 mb-3" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </>
              ) : (
                <>
                  {/* Queue Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Queue Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-medium">Enabled</Label>
                        <Switch
                          checked={enabled}
                          onCheckedChange={(v) => setEnabled(Boolean(v))}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="active" className="text-sm font-medium">
                          Active
                        </Label>
                        <Switch
                          checked={active}
                          onCheckedChange={(v) => setActive(Boolean(v))}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Basic Information */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Basic Information
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Name *</Label>
                        <Input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="queue-name"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Display Name</Label>
                        <Input
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Queue Display Name"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Description</Label>
                        <Input
                          value={description}
                          onChange={(e) => setDescription(e.target.value)}
                          placeholder="Queue description"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Routing Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Routing Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Routing Strategy</Label>
                        <Combobox
                          value={routingStrategy}
                          onChange={(v) => setRoutingStrategy(v)}
                          options={ROUTING_STRATEGIES}
                          placeholder="Select routing strategy"
                          searchable={false}
                        />
                      </div>
                      <div className="grid gap-3 grid-cols-2">
                        <div className="grid gap-2">
                          <Label className="text-sm">
                            Max Wait Time (secs)
                          </Label>
                          <Input
                            type="number"
                            value={maxWaitTimeSecs}
                            onChange={(e) =>
                              setMaxWaitTimeSecs(Number(e.target.value))
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label className="text-sm">Max Size</Label>
                          <Input
                            type="number"
                            value={maxSize}
                            onChange={(e) => setMaxSize(Number(e.target.value))}
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Timeout (secs)</Label>
                        <Input
                          type="number"
                          value={timeoutSecs}
                          onChange={(e) =>
                            setTimeoutSecs(Number(e.target.value))
                          }
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          Agent Answer Timeout (secs)
                        </Label>
                        <Input
                          type="number"
                          min="1"
                          value={agentAnswerTimeoutSecs}
                          onChange={(e) =>
                            setAgentAnswerTimeoutSecs(Number(e.target.value))
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          Time agent has to answer a call transferred from the
                          queue. If not answered in time, call will be
                          re-enqueued and agent status will be set to "Agent Not
                          Answering".
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Queue Priority Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Queue Priority Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Queue Priority</Label>
                        <div className="flex items-center gap-3">
                          <StarRating
                            value={
                              queuePriority >= 1 && queuePriority <= 5
                                ? queuePriority
                                : 1
                            }
                            onChange={setQueuePriority}
                            maxStars={5}
                          />
                          <span className="text-sm text-muted-foreground">
                            {queuePriority === 1 && "Low"}
                            {queuePriority === 2 && "Below Normal"}
                            {queuePriority === 3 && "Normal"}
                            {queuePriority === 4 && "Above Normal"}
                            {queuePriority === 5 && "High"}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Queue-level priority for routing (★=Low, ★★★=Normal,
                          ★★★★★=High). Higher priority queues are routed first.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Call Priority Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Call Priority Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Default Call Priority</Label>
                        <div className="flex items-center gap-3">
                          <StarRating
                            value={defaultCallPriority}
                            onChange={setDefaultCallPriority}
                            maxStars={5}
                          />
                          <span className="text-sm text-muted-foreground">
                            {defaultCallPriority === 1 && "Low"}
                            {defaultCallPriority === 2 && "Below Normal"}
                            {defaultCallPriority === 3 && "Normal"}
                            {defaultCallPriority === 4 && "Above Normal"}
                            {defaultCallPriority === 5 && "High"}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Default priority for calls entering this queue (★=Low,
                          ★★★=Normal, ★★★★★=High)
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Skill Relaxation Settings (only for Skill-based routing) */}
                  {routingStrategy === "Skill-based" && (
                    <>
                      <div>
                        <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                          Skill Relaxation Settings
                        </h3>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-sm font-medium">
                                Enable Skill Relaxation
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Gradually reduce skill requirements for calls
                                waiting beyond threshold
                              </p>
                            </div>
                            <Switch
                              checked={skillRelaxationEnabled}
                              onCheckedChange={setSkillRelaxationEnabled}
                            />
                          </div>
                          {skillRelaxationEnabled && (
                            <>
                              <div className="grid gap-2">
                                <Label className="text-sm">
                                  Relaxation After (seconds)
                                </Label>
                                <Input
                                  type="number"
                                  min="0"
                                  value={skillRelaxationAfterSeconds}
                                  onChange={(e) =>
                                    setSkillRelaxationAfterSeconds(
                                      Number(e.target.value),
                                    )
                                  }
                                />
                                <p className="text-xs text-muted-foreground">
                                  Wait time threshold before skill relaxation
                                  begins
                                </p>
                              </div>
                              <div className="grid gap-2">
                                <Label className="text-sm">
                                  Relaxation Strategy
                                </Label>
                                <Select
                                  value={skillRelaxationStrategy}
                                  onValueChange={setSkillRelaxationStrategy}
                                >
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="progressive">
                                      Progressive
                                    </SelectItem>
                                    <SelectItem value="fallback">
                                      Fallback
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                  {skillRelaxationStrategy === "fallback" ? (
                                    <>
                                      Fallback: Drop skills above 3 stars to 3
                                      stars (intermediate level) immediately
                                      after threshold. Skills at or below 3
                                      stars remain unchanged.
                                    </>
                                  ) : (
                                    <>
                                      Progressive: Reduce by 1 star every 30
                                      seconds (minimum 1 star)
                                    </>
                                  )}
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="border-t" />
                    </>
                  )}

                  {/* SLA Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Service Level Agreement (SLA)
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">
                          Answer Threshold (seconds)
                        </Label>
                        <Input
                          type="number"
                          min="1"
                          value={slaAnswerThresholdSeconds}
                          onChange={(e) =>
                            setSlaAnswerThresholdSeconds(Number(e.target.value))
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          Target time to answer calls (e.g., 20 seconds)
                        </p>
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Target Percentage</Label>
                        <Input
                          type="number"
                          min="0"
                          max="100"
                          value={slaTargetPercentage}
                          onChange={(e) =>
                            setSlaTargetPercentage(Number(e.target.value))
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          Target percentage of calls answered within threshold
                          (e.g., 80%)
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground italic">
                        Example: Answer 80% of calls within 20 seconds
                      </p>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Overflow Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Overflow Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Overflow Queue</Label>
                        <Combobox
                          value={overflowQueueId}
                          onChange={(v) => setOverflowQueueId(v)}
                          options={[
                            { value: "", label: "None" },
                            ...availableQueues.map((q) => ({
                              value: q.id,
                              label: q.display_name || q.name,
                            })),
                          ]}
                          placeholder="Select overflow queue"
                          searchable={false}
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label className="text-sm">Overflow Action</Label>
                        <Combobox
                          value={overflowAction}
                          onChange={(v) => setOverflowAction(v)}
                          options={OVERFLOW_ACTIONS}
                          placeholder="Select overflow action"
                          searchable={false}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* Wrapup Codes */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        Wrapup Codes
                      </h3>
                      {availableWrapupCodes.length > 0 && (
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                          <Checkbox
                            checked={
                              availableWrapupCodes.length > 0 &&
                              availableWrapupCodes.every((code) =>
                                selectedWrapupCodes.includes(code.id),
                              )
                            }
                            onCheckedChange={toggleAllWrapupCodes}
                          />
                          <span className="text-xs text-muted-foreground">
                            Select All
                          </span>
                        </label>
                      )}
                    </div>
                    {availableWrapupCodes.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No wrapup codes available.
                      </p>
                    ) : (
                      <div className="rounded border overflow-hidden">
                        <ScrollArea className="h-[300px]">
                          <div className="p-3 space-y-2">
                            {availableWrapupCodes.map((code) => (
                              <label
                                key={code.id}
                                className="flex items-start gap-2 text-sm"
                              >
                                <Checkbox
                                  checked={selectedWrapupCodes.includes(
                                    code.id,
                                  )}
                                  onCheckedChange={() =>
                                    toggleWrapupCode(code.id)
                                  }
                                />
                                <span className="leading-tight">
                                  <span className="font-medium">
                                    {code.name}
                                  </span>
                                  {code.description ? (
                                    <span className="block text-xs text-muted-foreground">
                                      {code.description}
                                    </span>
                                  ) : null}
                                </span>
                              </label>
                            ))}
                          </div>
                        </ScrollArea>
                      </div>
                    )}
                  </div>

                  <div className="border-t" />

                  {/* Queue Audio Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Queue Audio
                    </h3>
                    <div className="space-y-3">
                      {/* Media File Selection */}
                      <div className="grid gap-2">
                        <Label className="text-sm">Queue Hold Music</Label>
                        <div className="flex items-center gap-2">
                          <Select
                            key={`media-select-${mediaFiles.length}`}
                            value={queueAudioMediaName || "__none__"}
                            onValueChange={(value) => {
                              const actualValue =
                                value === "__none__" ? "" : value;
                              setQueueAudioMediaName(actualValue);
                              // Enable position announcements when media is selected
                              if (actualValue && !queueAudioEnablePosition) {
                                setQueueAudioEnablePosition(true);
                              }
                            }}
                          >
                            <SelectTrigger className="flex-1">
                              <SelectValue placeholder="Select media file (optional)" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">None</SelectItem>
                              {mediaFiles.length > 0 ? (
                                mediaFiles
                                  .filter((file) => file && file.media_name)
                                  .map((file) => (
                                    <SelectItem
                                      key={file.media_name}
                                      value={file.media_name}
                                    >
                                      <div className="flex items-center gap-2">
                                        <IconFileMusic className="size-4 text-telnyx-green" />
                                        {file.media_name}
                                      </div>
                                    </SelectItem>
                                  ))
                              ) : (
                                <SelectItem value="__loading__" disabled>
                                  {loading
                                    ? "Loading media files..."
                                    : "No media files available"}
                                </SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                          {queueAudioMediaName && (
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-9 w-9 shrink-0"
                              onClick={async () => {
                                if (isPlayingMedia) {
                                  // Stop playback
                                  setIsPlayingMedia(false);
                                  if (audioRef.current) {
                                    audioRef.current.pause();
                                    audioRef.current.currentTime = 0;
                                    audioRef.current = null;
                                  }
                                } else {
                                  // Start playback
                                  try {
                                    setIsPlayingMedia(true);
                                    const streamUrl = `/api/admin/media-library/${encodeURIComponent(
                                      queueAudioMediaName,
                                    )}/stream`;
                                    const audio = new Audio(streamUrl);
                                    audio.loop = true;
                                    audio.play().catch((err) => {
                                      console.error(
                                        "Failed to play audio:",
                                        err,
                                      );
                                      setIsPlayingMedia(false);
                                    });
                                    audio.addEventListener("ended", () => {
                                      setIsPlayingMedia(false);
                                    });
                                    audio.addEventListener("error", () => {
                                      setIsPlayingMedia(false);
                                    });
                                    audioRef.current = audio;
                                  } catch (err) {
                                    console.error("Error playing audio:", err);
                                    setIsPlayingMedia(false);
                                  }
                                }
                              }}
                            >
                              {isPlayingMedia ? (
                                <IconPlayerStop className="size-4" />
                              ) : (
                                <IconPlayerPlay className="size-4" />
                              )}
                            </Button>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Audio file to play on loop while call is waiting in
                          queue
                        </p>
                      </div>

                      {/* Position Announcements */}
                      {queueAudioMediaName && (
                        <>
                          <div className="flex items-center justify-between">
                            <div>
                              <Label className="text-sm font-medium">
                                Queue Position Announcements
                              </Label>
                              <p className="text-xs text-muted-foreground">
                                Announce caller's position in queue using TTS
                              </p>
                            </div>
                            <Switch
                              checked={queueAudioEnablePosition}
                              onCheckedChange={setQueueAudioEnablePosition}
                            />
                          </div>

                          {queueAudioEnablePosition && (
                            <>
                              {/* Position Announcement Interval */}
                              <div className="grid gap-2">
                                <Label className="text-sm">
                                  Announcement Interval
                                </Label>
                                <Select
                                  value={String(queueAudioPositionInterval)}
                                  onValueChange={(value) =>
                                    setQueueAudioPositionInterval(Number(value))
                                  }
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {POSITION_INTERVALS.map((interval) => (
                                      <SelectItem
                                        key={interval.value}
                                        value={String(interval.value)}
                                      >
                                        {interval.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                  How often to announce position in queue
                                </p>
                              </div>

                              {/* TTS Voice */}
                              <div className="space-y-3 pt-2 border-t">
                                <Label className="text-sm font-medium">
                                  TTS Voice
                                </Label>

                                {/* Provider */}
                                <div className="grid gap-2">
                                  <Label className="text-sm">
                                    Provider{" "}
                                    <span className="text-red-500">*</span>
                                  </Label>
                                  <Select
                                    value={ttsProvider}
                                    onValueChange={(value) => {
                                      setTtsProvider(value);
                                      setTtsModel("");
                                      setTtsVoiceName("");
                                      setTtsLanguageFilter("");
                                    }}
                                    disabled={ttsLoading}
                                  >
                                    <SelectTrigger className="w-full">
                                      <SelectValue
                                        placeholder={
                                          ttsLoading
                                            ? "Loading providers..."
                                            : "Select provider"
                                        }
                                      />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {ttsProviders
                                        .map((p) => {
                                          const providerKey =
                                            p?.id ||
                                            p?.provider ||
                                            p?.name ||
                                            "";
                                          const providerLabel =
                                            p?.name ||
                                            p?.provider ||
                                            p?.id ||
                                            "";
                                          if (
                                            !providerKey ||
                                            providerKey.trim() === ""
                                          )
                                            return null;
                                          return (
                                            <SelectItem
                                              key={providerKey}
                                              value={providerKey}
                                            >
                                              {providerLabel}
                                            </SelectItem>
                                          );
                                        })
                                        .filter(Boolean)}
                                    </SelectContent>
                                  </Select>
                                </div>

                                {/* Model */}
                                {(() => {
                                  const selectedProvider = ttsProviders.find(
                                    (p) =>
                                      p.id === ttsProvider ||
                                      p.provider === ttsProvider,
                                  );
                                  const models =
                                    selectedProvider?.models
                                      ?.map((m) => {
                                        if (typeof m === "string")
                                          return { id: m, name: m };
                                        return {
                                          id: m.id || m.name,
                                          name: m.name || m.id,
                                        };
                                      })
                                      .filter((m) => m.id) || [];

                                  if (models.length > 0) {
                                    return (
                                      <div className="grid gap-2">
                                        <Label className="text-sm">
                                          Model{" "}
                                          <span className="text-red-500">
                                            *
                                          </span>
                                        </Label>
                                        <Select
                                          value={
                                            ttsModel === ""
                                              ? "__default__"
                                              : ttsModel
                                          }
                                          onValueChange={(value) => {
                                            const actualModel =
                                              value === "__default__"
                                                ? ""
                                                : value;
                                            setTtsModel(actualModel);
                                            setTtsVoiceName("");
                                            setTtsLanguageFilter("");
                                          }}
                                          disabled={ttsLoading}
                                        >
                                          <SelectTrigger className="w-full">
                                            <SelectValue placeholder="Select model" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {selectedProvider?.models?.some(
                                              (m) => !m?.id && !m,
                                            ) && (
                                              <SelectItem value="__default__">
                                                Default
                                              </SelectItem>
                                            )}
                                            {models.map((m) => (
                                              <SelectItem
                                                key={m.id}
                                                value={m.id}
                                              >
                                                {m.name}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}

                                {/* Language Filter */}
                                {ttsLanguageOptions.length > 0 && (
                                  <div className="grid gap-2">
                                    <Label className="text-sm">Language Filter</Label>
                                    <Popover
                                      open={ttsLanguagePopoverOpen}
                                      onOpenChange={setTtsLanguagePopoverOpen}
                                    >
                                      <PopoverTrigger asChild>
                                        <Button
                                          variant="outline"
                                          role="combobox"
                                          className="w-full justify-between"
                                          disabled={ttsLoading}
                                        >
                                          <div className="flex items-center gap-2">
                                            {selectedTtsLanguageInfo ? (
                                              <>
                                                <span>{selectedTtsLanguageInfo.flag}</span>
                                                <span>{selectedTtsLanguageInfo.label}</span>
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
                                      <PopoverContent className="w-[300px] p-0" align="start">
                                        <Command>
                                          <CommandInput
                                            placeholder="Search languages..."
                                            value={ttsLanguageSearch}
                                            onValueChange={setTtsLanguageSearch}
                                            className="h-9"
                                          />
                                          <CommandEmpty>No language found.</CommandEmpty>
                                          <CommandGroup className="max-h-[300px] overflow-auto">
                                            <CommandItem
                                              value="__any__"
                                              onSelect={() => {
                                                setTtsLanguageFilter("");
                                                setTtsVoiceName("");
                                                setTtsLanguagePopoverOpen(false);
                                              }}
                                            >
                                              <IconCheck
                                                className={`mr-2 h-4 w-4 shrink-0 text-telnyx-green ${
                                                  !ttsLanguageFilter ? "opacity-100" : "opacity-0"
                                                }`}
                                              />
                                              <IconWorld className="size-4 mr-2" />
                                              <span>Any</span>
                                            </CommandItem>
                                            {filteredTtsLanguageOptions.map((opt) => (
                                              <CommandItem
                                                key={opt.value}
                                                value={`${opt.label}-${opt.value}`}
                                                onSelect={() => {
                                                  setTtsLanguageFilter(opt.value);
                                                  setTtsVoiceName("");
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
                                        </Command>
                                      </PopoverContent>
                                    </Popover>
                                    <p className="text-xs text-muted-foreground">
                                      Filter voices by language ({ttsLanguageOptions.length} language
                                      {ttsLanguageOptions.length !== 1 ? "s" : ""} available)
                                    </p>
                                  </div>
                                )}

                                {/* Voice */}
                                {filteredTtsVoices.length > 0 && (
                                  <div className="grid gap-2">
                                    <Label className="text-sm">
                                      Voice{" "}
                                      <span className="text-red-500">*</span>
                                    </Label>
                                    <div className="flex items-center gap-2">
                                      <div className="flex-1">
                                        <Combobox
                                          value={ttsVoiceName}
                                          onChange={(value) => {
                                            setTtsVoiceName(value);
                                            const voiceStr = buildVoiceString(
                                              ttsProvider,
                                              ttsModel,
                                              value
                                            );
                                            setQueueAudioTtsVoice(voiceStr);
                                          }}
                                          options={filteredTtsVoices
                                            .filter((v) => v?.id)
                                            .map((v) => ({
                                              value: v.id,
                                              label: v.language 
                                                ? `${v.name || v.id} (${v.language})`
                                                : v.name || v.id,
                                            }))}
                                          placeholder="Select voice"
                                          searchable={true}
                                        />
                                      </div>
                                      {ttsVoiceName && queueAudioTtsVoice && (
                                              <Button
                                                type="button"
                                                variant="outline"
                                                size="icon"
                                                className="h-9 w-9 shrink-0"
                                                onClick={async () => {
                                                  if (
                                                    isTestingTts &&
                                                    ttsTestAudioRef.current
                                                  ) {
                                                    // Stop playback
                                                    ttsTestAudioRef.current.pause();
                                                    ttsTestAudioRef.current.currentTime = 0;
                                                    ttsTestAudioRef.current =
                                                      null;
                                                    setIsTestingTts(false);
                                                    return;
                                                  }

                                                  // Generate random position between 1 and 20
                                                  const randomPosition =
                                                    Math.floor(
                                                      Math.random() * 20,
                                                    ) + 1;
                                                  const testMessage = `your current position in a queue is ${randomPosition}`;

                                                  try {
                                                    setIsTestingTts(true);

                                                    const response =
                                                      await fetch(
                                                        "/api/tts/speech",
                                                        {
                                                          method: "POST",
                                                          headers: {
                                                            "Content-Type":
                                                              "application/json",
                                                            "Cache-Control":
                                                              "no-cache, no-store, must-revalidate",
                                                          },
                                                          cache: "no-store",
                                                          body: JSON.stringify({
                                                            text: testMessage,
                                                            voice:
                                                              queueAudioTtsVoice,
                                                            voice_api_key_ref:
                                                              queueAudioTtsVoiceApiKeyRef ||
                                                              "",
                                                          }),
                                                        },
                                                      );

                                                    if (!response.ok) {
                                                      const errorData =
                                                        await response
                                                          .json()
                                                          .catch(() => ({}));
                                                      let errorMessage =
                                                        "Failed to generate speech";
                                                      if (errorData?.error) {
                                                        errorMessage =
                                                          errorData.error;
                                                      } else if (
                                                        errorData?.errors &&
                                                        Array.isArray(
                                                          errorData.errors,
                                                        ) &&
                                                        errorData.errors
                                                          .length > 0
                                                      ) {
                                                        const firstError =
                                                          errorData.errors[0];
                                                        errorMessage =
                                                          firstError.detail ||
                                                          firstError.title ||
                                                          errorMessage;
                                                      }
                                                      throw new Error(
                                                        errorMessage,
                                                      );
                                                    }

                                                    const audioBlob =
                                                      await response.blob();
                                                    const audioUrl =
                                                      URL.createObjectURL(
                                                        audioBlob,
                                                      );
                                                    const audioElement =
                                                      new Audio(audioUrl);

                                                    audioElement.onended =
                                                      () => {
                                                        setIsTestingTts(false);
                                                        ttsTestAudioRef.current =
                                                          null;
                                                        URL.revokeObjectURL(
                                                          audioUrl,
                                                        );
                                                      };

                                                    audioElement.onerror =
                                                      () => {
                                                        setIsTestingTts(false);
                                                        ttsTestAudioRef.current =
                                                          null;
                                                        URL.revokeObjectURL(
                                                          audioUrl,
                                                        );
                                                        notify({
                                                          title: "Error",
                                                          description:
                                                            "Error playing audio",
                                                          variant: "error",
                                                        });
                                                      };

                                                    ttsTestAudioRef.current =
                                                      audioElement;
                                                    await audioElement.play();
                                                  } catch (error) {
                                                    console.error(
                                                      "Error testing TTS:",
                                                      error,
                                                    );
                                                    notify({
                                                      title: "Error",
                                                      description:
                                                        error.message ||
                                                        "Failed to generate speech",
                                                      variant: "error",
                                                    });
                                                    setIsTestingTts(false);
                                                    ttsTestAudioRef.current =
                                                      null;
                                                  }
                                                }}
                                              >
                                                {isTestingTts ? (
                                                  <IconPlayerStop className="size-4" />
                                                ) : (
                                                  <IconPlayerPlay className="size-4" />
                                                )}
                                        </Button>
                                      )}
                                    </div>
                                    {ttsLanguageFilter && (
                                      <p className="text-xs text-muted-foreground">
                                        Showing {filteredTtsVoices.length} voice
                                        {filteredTtsVoices.length !== 1 ? "s" : ""} for{" "}
                                        {selectedTtsLanguageInfo?.label || ttsLanguageFilter}
                                      </p>
                                    )}
                                  </div>
                                )}

                                {/* API Key Reference (for ElevenLabs) */}
                                {ttsProvider === "ElevenLabs" && (
                                  <div className="grid gap-2">
                                    <Label className="text-sm">
                                      Voice API Key Reference
                                    </Label>
                                    <Select
                                      value={
                                        queueAudioTtsVoiceApiKeyRef ||
                                        "__none__"
                                      }
                                      onValueChange={(value) => {
                                        const actualValue =
                                          value === "__none__" ? "" : value;
                                        setQueueAudioTtsVoiceApiKeyRef(
                                          actualValue,
                                        );
                                      }}
                                    >
                                      <SelectTrigger className="w-full">
                                        <SelectValue placeholder="Select API key" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">
                                          None
                                        </SelectItem>
                                        {ttsSecrets.map((secret) => (
                                          <SelectItem
                                            key={secret.id}
                                            value={secret.identifier}
                                          >
                                            {secret.name || secret.identifier}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">
                                      API key reference for ElevenLabs voice
                                      provider
                                    </p>
                                  </div>
                                )}
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="border-t" />

                  {/* User Assignments */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      User Assignments
                    </h3>
                    {loading ? (
                      <div className="space-y-2">
                        <Skeleton className="h-9 w-full" />
                        <Skeleton className="h-9 w-full" />
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {availableUsers.length === 0 ? (
                          <p className="text-sm text-muted-foreground">
                            No users available.
                          </p>
                        ) : (
                          <div className="rounded border overflow-hidden">
                            <div className="p-3 max-h-[300px] overflow-y-auto">
                              <div className="grid grid-cols-2 gap-4">
                                {/* Header row */}
                                <div className="font-semibold text-sm text-muted-foreground pb-2 border-b">
                                  User
                                </div>
                                <div className="font-semibold text-sm text-muted-foreground pb-2 border-b">
                                  Priority
                                </div>

                                {/* User rows */}
                                {availableUsers.map((user) => {
                                  const isAssigned = assignedUserIds.includes(
                                    user.id,
                                  );
                                  const userName =
                                    [user.first_name, user.last_name]
                                      .filter(Boolean)
                                      .join(" ") || user.username;
                                  const assignment =
                                    userAssignmentsWithCapacity[user.id] || {};
                                  const priority =
                                    assignment.priority !== undefined &&
                                    assignment.priority !== null &&
                                    assignment.priority >= 1
                                      ? assignment.priority
                                      : 1;

                                  return (
                                    <React.Fragment key={user.id}>
                                      {/* User name column */}
                                      <div className="flex items-center gap-2 py-2">
                                        <Checkbox
                                          checked={isAssigned}
                                          onCheckedChange={(checked) => {
                                            if (checked) {
                                              setAssignedUserIds([
                                                ...assignedUserIds,
                                                user.id,
                                              ]);
                                              // Initialize assignment with defaults (priority 1 = minimum 1 star)
                                              setUserAssignmentsWithCapacity(
                                                (prev) => ({
                                                  ...prev,
                                                  [user.id]: {
                                                    priority: 1,
                                                  },
                                                }),
                                              );
                                            } else {
                                              setAssignedUserIds(
                                                assignedUserIds.filter(
                                                  (id) => id !== user.id,
                                                ),
                                              );
                                              // Remove assignment
                                              setUserAssignmentsWithCapacity(
                                                (prev) => {
                                                  const next = { ...prev };
                                                  delete next[user.id];
                                                  return next;
                                                },
                                              );
                                            }
                                          }}
                                          className="shrink-0"
                                        />
                                        <label
                                          htmlFor={`user-${user.id}`}
                                          className="text-sm font-medium cursor-pointer flex-1"
                                        >
                                          {userName}
                                        </label>
                                      </div>

                                      {/* Priority stars column */}
                                      <div className="flex items-center py-2">
                                        {isAssigned ? (
                                          <QueuePriorityStarRating
                                            value={priority}
                                            onChange={(newPriority) => {
                                              setUserAssignmentsWithCapacity(
                                                (prev) => ({
                                                  ...prev,
                                                  [user.id]: {
                                                    ...prev[user.id],
                                                    priority: newPriority,
                                                  },
                                                }),
                                              );
                                            }}
                                            maxStars={5}
                                          />
                                        ) : (
                                          <span className="text-xs text-muted-foreground">
                                            Not assigned
                                          </span>
                                        )}
                                      </div>
                                    </React.Fragment>
                                  );
                                })}
                              </div>
                              <p className="text-xs text-muted-foreground mt-3 pt-3 border-t">
                                Click stars to set agent priority within this
                                queue (1-5 stars). Higher priority agents are
                                routed calls first. Minimum is 1 star.
                              </p>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Fixed Footer */}
        <SheetFooter className="px-6 py-4 border-t flex flex-row justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || loading}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
