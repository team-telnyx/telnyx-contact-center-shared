"use client";

import React from "react";
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
import { IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
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
import { IconFileMusic, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";

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
  const [overflowQueueId, setOverflowQueueId] = React.useState("");
  const [overflowAction, setOverflowAction] = React.useState("transfer");
  const [priority, setPriority] = React.useState(0);
  const [enabled, setEnabled] = React.useState(true);
  const [active, setActive] = React.useState(true);
  const [skillRequirements, setSkillRequirements] = React.useState({});
  const [priorityRules, setPriorityRules] = React.useState([]);
  const [userAssignments, setUserAssignments] = React.useState([]);
  const [availableQueues, setAvailableQueues] = React.useState([]);
  const [availableUsers, setAvailableUsers] = React.useState([]);
  const [availableWrapupCodes, setAvailableWrapupCodes] = React.useState([]);
  const [selectedWrapupCodes, setSelectedWrapupCodes] = React.useState([]);
  const [saving, setSaving] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  
  // Queue Audio Settings
  const [queueAudioMediaName, setQueueAudioMediaName] = React.useState("");
  const [queueAudioEnablePosition, setQueueAudioEnablePosition] = React.useState(false);
  const [queueAudioPositionInterval, setQueueAudioPositionInterval] = React.useState(60);
  const [queueAudioTtsVoice, setQueueAudioTtsVoice] = React.useState("AWS.Polly.Joanna");
  const [queueAudioTtsVoiceApiKeyRef, setQueueAudioTtsVoiceApiKeyRef] = React.useState("");
  const [mediaFiles, setMediaFiles] = React.useState([]);
  
  // Debug: Track mediaFiles changes
  React.useEffect(() => {
    console.log("[Queue EditSheet] mediaFiles state changed:", mediaFiles.length, "files");
    if (mediaFiles.length > 0) {
      console.log("[Queue EditSheet] Media file names:", mediaFiles.map(f => f.media_name));
    }
  }, [mediaFiles]);
  
  const [ttsProviders, setTtsProviders] = React.useState([]);
  const [ttsSecrets, setTtsSecrets] = React.useState([]);
  const [ttsLoading, setTtsLoading] = React.useState(false);
  const [ttsProvider, setTtsProvider] = React.useState("AWS");
  const [ttsModel, setTtsModel] = React.useState("");
  const [ttsVoiceName, setTtsVoiceName] = React.useState("");
  const [isPlayingMedia, setIsPlayingMedia] = React.useState(false);
  const audioRef = React.useRef(null);
  const [isTestingTts, setIsTestingTts] = React.useState(false);
  const ttsTestAudioRef = React.useRef(null);

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
          setOverflowQueueId("");
          setOverflowAction("transfer");
          setPriority(0);
          setEnabled(true);
          setActive(true);
          setSkillRequirements({});
          setPriorityRules([]);
          setUserAssignments([]);
          setSelectedWrapupCodes([]);
          setQueueAudioMediaName("");
          setQueueAudioEnablePosition(false);
          setQueueAudioPositionInterval(60);
          setQueueAudioTtsVoice("AWS.Polly.Joanna");
          setQueueAudioTtsVoiceApiKeyRef("");
          setTtsProvider("AWS");
          setTtsModel("");
          setTtsVoiceName("");
        }
        return;
      }

      setLoading(true);
      try {
        const r = await fetch(
          `/api/admin/queues/${encodeURIComponent(queueId)}`,
          {
            cache: "no-store",
          }
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
          setOverflowQueueId(d.overflow_queue_id || "");
          setOverflowAction(d.overflow_action || "transfer");
          setPriority(d.priority || 0);
          setEnabled(d.enabled !== undefined ? d.enabled : true);
          setActive(d.active !== undefined ? Boolean(d.active) : true);
          setActive(d.active !== undefined ? Boolean(d.active) : true);
          setSkillRequirements(
            typeof d.skill_requirements === "string"
              ? JSON.parse(d.skill_requirements)
              : d.skill_requirements || {}
          );
          setPriorityRules(
            typeof d.priority_rules === "string"
              ? JSON.parse(d.priority_rules)
              : d.priority_rules || []
          );
          setUserAssignments(
            (d.userAssignments || []).map((ua) => ({
              userId: ua.user_id,
              username: ua.username,
              name:
                [ua.first_name, ua.last_name].filter(Boolean).join(" ") ||
                ua.nick ||
                ua.username,
              priority: ua.priority || 0,
              enabled: ua.enabled !== undefined ? ua.enabled : true,
            }))
          );
          setSelectedWrapupCodes(
            (d.wrapupCodes || [])
              .map((code) => code.wrapup_code_id)
              .filter(Boolean)
          );
          
          // Load queue audio settings
          setQueueAudioMediaName(d.queue_audio_media_name || "");
          setQueueAudioEnablePosition(d.queue_audio_enable_position || false);
          setQueueAudioPositionInterval(d.queue_audio_position_interval_secs || 60);
          setQueueAudioTtsVoice(d.queue_audio_tts_voice || "AWS.Polly.Joanna");
          setQueueAudioTtsVoiceApiKeyRef(d.queue_audio_tts_voice_api_key_ref || "");
          
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
            (queuesData.rows || []).filter((q) => q.id !== queueId)
          );
        }

        const wrapupRes = await fetch(
          "/api/admin/wrapup-codes?pageSize=1000&active=true",
          {
            cache: "no-store",
          }
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
          const mediaRes = await fetch("/api/admin/media-library?pageSize=1000", {
            cache: "no-store",
          });
          if (mediaRes.ok) {
            const mediaData = await mediaRes.json();
            console.log("[Queue EditSheet] Media files response:", {
              itemsCount: mediaData.items?.length || 0,
              total: mediaData.total,
              sampleItems: mediaData.items?.slice(0, 3).map(item => ({
                media_name: item.media_name,
                content_type: item.content_type
              }))
            });
            const files = (mediaData.items || []).filter(file => file && file.media_name);
            console.log("[Queue EditSheet] Setting mediaFiles state with:", files.length, "files", files.map(f => f.media_name));
            if (files.length > 0) {
              setMediaFiles(files);
            } else {
              console.warn("[Queue EditSheet] No valid media files after filtering");
              setMediaFiles([]);
            }
            
            // Debug: Log after state update attempt
            setTimeout(() => {
              console.log("[Queue EditSheet] mediaFiles state check (after setState):", files.length);
            }, 100);
            if (mediaData.items && mediaData.items.length === 0) {
              console.warn("[Queue EditSheet] No media files found. Check if files are uploaded and have audio content type or extension.");
            }
          } else {
            const errorData = await mediaRes.json().catch(() => ({}));
            console.error("[Queue EditSheet] Failed to load media files:", errorData.error || mediaRes.statusText);
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

  function addUserAssignment() {
    if (availableUsers.length === 0) return;
    const firstUser = availableUsers[0];
    setUserAssignments([
      ...userAssignments,
      {
        userId: firstUser.id,
        username: firstUser.username,
        name:
          [firstUser.first_name, firstUser.last_name]
            .filter(Boolean)
            .join(" ") ||
          firstUser.nick ||
          firstUser.username,
        priority: 0,
        enabled: true,
      },
    ]);
  }

  function removeUserAssignment(index) {
    setUserAssignments(userAssignments.filter((_, i) => i !== index));
  }

  function updateUserAssignment(index, field, value) {
    const updated = [...userAssignments];
    updated[index] = { ...updated[index], [field]: value };
    setUserAssignments(updated);
  }

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
        selectedWrapupCodes.includes(code.id)
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
        overflowQueueId: overflowQueueId || null,
        overflowAction,
        priority: Number(priority),
        enabled,
        active,
        skillRequirements,
        priorityRules,
        wrapupCodes: selectedWrapupCodes,
        userAssignments: userAssignments.map((ua) => ({
          userId: ua.userId,
          priority: Number(ua.priority),
          enabled: ua.enabled,
        })),
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

                  {/* Queue Settings */}
                  <div>
                    <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                      Queue Settings
                    </h3>
                    <div className="space-y-3">
                      <div className="grid gap-2">
                        <Label className="text-sm">Priority</Label>
                        <Input
                          type="number"
                          value={priority}
                          onChange={(e) => setPriority(Number(e.target.value))}
                        />
                      </div>
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
                                selectedWrapupCodes.includes(code.id)
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
                                  checked={selectedWrapupCodes.includes(code.id)}
                                  onCheckedChange={() => toggleWrapupCode(code.id)}
                                />
                                <span className="leading-tight">
                                  <span className="font-medium">{code.name}</span>
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
                              const actualValue = value === "__none__" ? "" : value;
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
                                    <SelectItem key={file.media_name} value={file.media_name}>
                                      <div className="flex items-center gap-2">
                                        <IconFileMusic className="size-4 text-telnyx-green" />
                                        {file.media_name}
                                      </div>
                                    </SelectItem>
                                  ))
                              ) : (
                                <SelectItem value="__loading__" disabled>
                                  {loading ? "Loading media files..." : "No media files available"}
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
                                    const streamUrl = `/api/admin/media-library/${encodeURIComponent(queueAudioMediaName)}/stream`;
                                    const audio = new Audio(streamUrl);
                                    audio.loop = true;
                                    audio.play().catch((err) => {
                                      console.error("Failed to play audio:", err);
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
                          Audio file to play on loop while call is waiting in queue
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
                                    Provider <span className="text-red-500">*</span>
                                  </Label>
                                  <Select
                                    value={ttsProvider}
                                    onValueChange={(value) => {
                                      setTtsProvider(value);
                                      setTtsModel("");
                                      setTtsVoiceName("");
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
                                            p?.id || p?.provider || p?.name || "";
                                          const providerLabel =
                                            p?.name || p?.provider || p?.id || "";
                                          if (!providerKey || providerKey.trim() === "")
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
                                      p.provider === ttsProvider
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
                                          Model <span className="text-red-500">*</span>
                                        </Label>
                                        <Select
                                          value={
                                            ttsModel === ""
                                              ? "__default__"
                                              : ttsModel
                                          }
                                          onValueChange={(value) => {
                                            const actualModel =
                                              value === "__default__" ? "" : value;
                                            setTtsModel(actualModel);
                                            setTtsVoiceName("");
                                          }}
                                          disabled={ttsLoading}
                                        >
                                          <SelectTrigger className="w-full">
                                            <SelectValue placeholder="Select model" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {selectedProvider?.models?.some(
                                              (m) => !m?.id && !m
                                            ) && (
                                              <SelectItem value="__default__">
                                                Default
                                              </SelectItem>
                                            )}
                                            {models.map((m) => (
                                              <SelectItem key={m.id} value={m.id}>
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

                                {/* Voice */}
                                {(() => {
                                  const selectedProvider = ttsProviders.find(
                                    (p) =>
                                      p.id === ttsProvider ||
                                      p.provider === ttsProvider
                                  );
                                  const allVoices = [];
                                  if (selectedProvider?.models) {
                                    if (!ttsModel || ttsModel === "__default__") {
                                      for (const m of selectedProvider.models) {
                                        const modelVoices =
                                          typeof m === "object" && m.voices
                                            ? m.voices
                                            : [];
                                        allVoices.push(...modelVoices);
                                      }
                                    } else {
                                      const modelObj = selectedProvider.models.find(
                                        (m) =>
                                          (typeof m === "object"
                                            ? m.id || m.name
                                            : m) === ttsModel
                                      );
                                      if (
                                        modelObj &&
                                        typeof modelObj === "object" &&
                                        modelObj.voices
                                      ) {
                                        allVoices.push(...modelObj.voices);
                                      }
                                    }
                                  }
                                  const voices = allVoices.filter((v) => v?.id);

                                  if (voices.length > 0) {
                                    return (
                                      <div className="grid gap-2">
                                        <Label className="text-sm">
                                          Voice <span className="text-red-500">*</span>
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
                                              options={voices
                                                .filter((v) => v?.id)
                                                .map((v) => ({
                                                  value: v.id,
                                                  label: v.name || v.id,
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
                                                if (isTestingTts && ttsTestAudioRef.current) {
                                                  // Stop playback
                                                  ttsTestAudioRef.current.pause();
                                                  ttsTestAudioRef.current.currentTime = 0;
                                                  ttsTestAudioRef.current = null;
                                                  setIsTestingTts(false);
                                                  return;
                                                }

                                                // Generate random position between 1 and 20
                                                const randomPosition = Math.floor(Math.random() * 20) + 1;
                                                const testMessage = `your current position in a queue is ${randomPosition}`;

                                                try {
                                                  setIsTestingTts(true);

                                                  const response = await fetch("/api/tts/speech", {
                                                    method: "POST",
                                                    headers: {
                                                      "Content-Type": "application/json",
                                                      "Cache-Control": "no-cache, no-store, must-revalidate",
                                                    },
                                                    cache: "no-store",
                                                    body: JSON.stringify({
                                                      text: testMessage,
                                                      voice: queueAudioTtsVoice,
                                                      voice_api_key_ref: queueAudioTtsVoiceApiKeyRef || "",
                                                    }),
                                                  });

                                                  if (!response.ok) {
                                                    const errorData = await response.json().catch(() => ({}));
                                                    let errorMessage = "Failed to generate speech";
                                                    if (errorData?.error) {
                                                      errorMessage = errorData.error;
                                                    } else if (
                                                      errorData?.errors &&
                                                      Array.isArray(errorData.errors) &&
                                                      errorData.errors.length > 0
                                                    ) {
                                                      const firstError = errorData.errors[0];
                                                      errorMessage = firstError.detail || firstError.title || errorMessage;
                                                    }
                                                    throw new Error(errorMessage);
                                                  }

                                                  const audioBlob = await response.blob();
                                                  const audioUrl = URL.createObjectURL(audioBlob);
                                                  const audioElement = new Audio(audioUrl);

                                                  audioElement.onended = () => {
                                                    setIsTestingTts(false);
                                                    ttsTestAudioRef.current = null;
                                                    URL.revokeObjectURL(audioUrl);
                                                  };

                                                  audioElement.onerror = () => {
                                                    setIsTestingTts(false);
                                                    ttsTestAudioRef.current = null;
                                                    URL.revokeObjectURL(audioUrl);
                                                    notify({
                                                      title: "Error",
                                                      description: "Error playing audio",
                                                      variant: "error",
                                                    });
                                                  };

                                                  ttsTestAudioRef.current = audioElement;
                                                  await audioElement.play();
                                                } catch (error) {
                                                  console.error("Error testing TTS:", error);
                                                  notify({
                                                    title: "Error",
                                                    description: error.message || "Failed to generate speech",
                                                    variant: "error",
                                                  });
                                                  setIsTestingTts(false);
                                                  ttsTestAudioRef.current = null;
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
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}

                                {/* API Key Reference (for ElevenLabs) */}
                                {ttsProvider === "ElevenLabs" && (
                                  <div className="grid gap-2">
                                    <Label className="text-sm">
                                      Voice API Key Reference
                                    </Label>
                                    <Select
                                      value={queueAudioTtsVoiceApiKeyRef || "__none__"}
                                      onValueChange={(value) => {
                                        const actualValue = value === "__none__" ? "" : value;
                                        setQueueAudioTtsVoiceApiKeyRef(actualValue);
                                      }}
                                    >
                                      <SelectTrigger className="w-full">
                                        <SelectValue placeholder="Select API key" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="__none__">None</SelectItem>
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
                                      API key reference for ElevenLabs voice provider
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
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        User Assignments
                      </h3>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addUserAssignment}
                      >
                        <IconPlus className="size-4 mr-1" />
                        Add User
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {userAssignments.map((ua, index) => (
                        <div
                          key={index}
                          className="flex items-center gap-2 p-2 border rounded"
                        >
                          <div className="flex-1 grid grid-cols-3 gap-2">
                            <Combobox
                              value={ua.userId}
                              onChange={(v) =>
                                updateUserAssignment(index, "userId", v)
                              }
                              options={availableUsers.map((u) => ({
                                value: u.id,
                                label:
                                  [u.first_name, u.last_name]
                                    .filter(Boolean)
                                    .join(" ") ||
                                  u.nick ||
                                  u.username,
                              }))}
                              placeholder="Select user"
                              searchable={true}
                              contentClassName="w-[300px]"
                            />
                            <Input
                              type="number"
                              placeholder="Priority"
                              value={ua.priority}
                              onChange={(e) =>
                                updateUserAssignment(
                                  index,
                                  "priority",
                                  Number(e.target.value)
                                )
                              }
                              className="w-20"
                            />
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={ua.enabled}
                                onCheckedChange={(v) =>
                                  updateUserAssignment(index, "enabled", v)
                                }
                              />
                              <Label className="text-xs">Enabled</Label>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeUserAssignment(index)}
                          >
                            <IconTrash className="size-4 text-red-500" />
                          </Button>
                        </div>
                      ))}
                      {userAssignments.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">
                          No users assigned. Click "Add User" to assign users to
                          this queue.
                        </p>
                      )}
                    </div>
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
