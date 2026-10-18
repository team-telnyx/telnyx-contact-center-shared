"use client";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import VideoConferenceHistory from "./VideoConferenceHistory";
import TelnyxAvatarLibrary from "@/components/assistants/TelnyxAvatarLibrary";
import { DEFAULT_VIDEO_AI, VISION_SOURCE_TYPES } from "@/lib/video/conference-config.mjs";

export default function VideoConferenceSettings({ video, assistants, onChange, widgetId }) {
  const tUi = useUiText(), ai = video.ai || DEFAULT_VIDEO_AI;
  const [inventory, setInventory] = useState({ status: "loading" });
  const [profiles, setProfiles] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [assistantSearch, setAssistantSearch] = useState("");
  const assistantListRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/widgets/video-options", { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setInventory({ status: "ready", ...data });
    }).catch(e => { if (!controller.signal.aborted) setInventory({ status: "error", error: e.message }); });
    return () => controller.abort();
  }, [attempt]);
  async function checkProfiles() {
    setProfiles({status:"loading"});
    try { const r=await fetch(`/api/admin/widgets/video-options?widgetId=${encodeURIComponent(widgetId)}`,{cache:"no-store"});const d=await r.json();if(!r.ok)throw Error(d.error);setProfiles({status:"ready",items:d.profiles}); }
    catch(error){setProfiles({status:"error",error:error.message});}
  }
  const routing = patch => onChange({ ...video, routing: { ...video.routing, ...patch } });
  const assistant = patch => onChange({ ...video, ai: { ...ai, ...patch } });
  const vision = patch => assistant({ vision: { ...ai.vision, ...patch } });
  const selectedAssistants = assistants.filter(item => item.id === ai.assistantId || ai.allowAgentInvite && ai.allowedAssistantIds.includes(item.id));
  const missingVisionTools = selectedAssistants.filter(item => item.visionTool !== "present");
  const assistantQuery = assistantSearch.trim().toLocaleLowerCase(tUi.locale);
  const availableAssistants = assistants.filter(item => item.id !== ai.assistantId && item.name.toLocaleLowerCase(tUi.locale).includes(assistantQuery));
  function select(label, value, options, change, disabled = false) {
    return <label className="grid gap-1 text-sm"><span>{label}</span><select disabled={disabled} className="h-10 w-full rounded-md border bg-background px-2" value={value || ""} onChange={e => change(e.target.value)}>{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
  }
  function toggle(label, checked, change) { return <label className="flex items-center justify-between gap-3 text-sm"><span>{label}</span><Switch checked={checked} onCheckedChange={change} /></label>; }
  return <div className="min-w-0 space-y-4" data-video-conference-settings>
    {select(tUi("Start the video call with"), video.routing.destination || "queue", [["queue", tUi("Video queue")], ["agent", tUi("Specific agent")], ["assistant", tUi("AI assistant")]], destination => routing({ destination }))}
    {inventory.status === "loading" ? <div role="status" aria-label={tUi("Loading video destinations")}><Skeleton className="h-10 w-full" /></div>
      : inventory.status === "error" ? <div role="alert"><p>{inventory.error}</p><button type="button" onClick={() => { setInventory({ status: "loading" }); setAttempt(a => a + 1); }}>{tUi("Retry")}</button></div>
      : <>
        {select(tUi("Video queue / fallback queue"), video.routing.queueId, [["", tUi("Select a queue")], ...inventory.queues.map(q => [q.id, q.name])], queueId => routing({ queueId, queueName: inventory.queues.find(q => q.id === queueId)?.name || "" }))}
        {video.routing.destination === "agent" && <>
          {select(tUi("Destination agent"), video.routing.agentId, [["", tUi("Select an agent")], ...inventory.agents.filter(a => a.queue_id === video.routing.queueId).map(a => [a.id, [a.first_name, a.last_name].filter(Boolean).join(" ") || a.username || a.id])], agentId => routing({ agentId }))}
          <label className="grid gap-1 text-sm">{tUi("Agent offer timeout (seconds)")}<input className="h-10 rounded-md border bg-background px-2" type="number" min="10" max="120" value={video.routing.offerTimeoutSecs || 30} onChange={e => routing({ offerTimeoutSecs: Number(e.target.value) })} /></label>
          <p className="text-xs text-muted-foreground">{tUi("If the agent is unavailable, declines or does not answer, the call goes to the fallback video queue.")}</p>
        </>}
        {!inventory.workerAvailable && <p role="status" className="text-xs text-amber-700">{tUi("The video AI service is unavailable or at capacity. If the assistant cannot start, the call ends with an error. Try again later.")}</p>}
      </>}
    {toggle(tUi("Allow agents to invite an assistant"), ai.allowAgentInvite, allowAgentInvite => assistant({ allowAgentInvite }))}
    {(video.routing.destination === "assistant" || ai.allowAgentInvite) && <>
      {select(tUi("Video AI assistant"), ai.assistantId, [["", tUi("Select an assistant")], ...assistants.map(a => [a.id, a.name])], assistantId => assistant({ assistantId }))}
      <p className="text-xs text-muted-foreground">{tUi("Video uses its own assistant profile. Publishing preserves the source assistant and its voice and chat settings.")}</p>
      {ai.allowAgentInvite && <fieldset className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-medium">{tUi("Additional assistants agents may invite")}</legend>
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input type="search" value={assistantSearch} placeholder={tUi("Search assistants…")} aria-label={tUi("Search assistants…")} className="h-9 ps-9" onChange={event => {
            setAssistantSearch(event.target.value);
            if (assistantListRef.current) assistantListRef.current.scrollTop = 0;
          }} />
        </div>
        <div ref={assistantListRef} className="max-h-[182px] overflow-y-auto overscroll-contain rounded-md border" data-video-assistant-list>
          {availableAssistants.length ? availableAssistants.map(item => <label key={item.id} className="flex h-9 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-muted/50 focus-within:bg-muted/50">
            <Checkbox checked={ai.allowedAssistantIds.includes(item.id)} onCheckedChange={checked => assistant({ allowedAssistantIds: checked ? [...ai.allowedAssistantIds, item.id] : ai.allowedAssistantIds.filter(id => id !== item.id) })} />
            <span className="min-w-0 truncate" title={item.name}>{item.name}</span>
          </label>) : <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{tUi("No matching assistant.")}</p>}
        </div>
      </fieldset>}
      {select(tUi("AI after the agent joins"), ai.afterAgentJoins, [["muted", tUi("Stay visible, muted")], ["active", tUi("Stay active")], ["leave", tUi("Leave the conference")]], afterAgentJoins => assistant({ afterAgentJoins }))}
      {toggle(tUi("Show a Telnyx avatar"), ai.avatar.enabled, enabled => assistant({ avatar: { ...ai.avatar, enabled } }))}
      {ai.avatar.enabled && <>
        <TelnyxAvatarLibrary selectedId={ai.avatar.avatarId} onSelect={entry => assistant({ avatar: { ...ai.avatar, avatarId: entry.id, name: entry.name, previewUrl: entry.previewUrl } })} />
        {select(tUi("Avatar background"), ai.avatar.backgroundId, [["studio", tUi("Studio")], ["office", tUi("Office")], ["reception", tUi("Reception")]], backgroundId => assistant({ avatar: { ...ai.avatar, backgroundId } }))}
      </>}
      {select(tUi("Vision"), ai.vision.mode, [["disabled", tUi("Disabled")], ["uploads", tUi("Uploaded images only")], ["live", tUi("Uploaded images and live video")]], mode => vision({ mode }), ai.vision.mode === "disabled" && assistants.find(a=>a.id===ai.assistantId)?.bufferedVision?.status !== "supported")}
      <p className="text-xs text-muted-foreground">{assistants.find(a=>a.id===ai.assistantId)?.bufferedVision?.reason || tUi("Select an assistant with a verified Vision model.")} {tUi("Recommended: Kimi-K2.6.")}</p>
      {ai.vision.mode !== "disabled" && <div className="space-y-2 rounded-md border p-3 text-xs">
        {missingVisionTools.length ? <p role="status" className="text-amber-700">{tUi("Vision tool is missing or unverified for:")} {missingVisionTools.map(item => item.name).join(", ")}. {tUi("Add the tool in the assistant settings or enable adding it when this widget is published.")}</p>
          : selectedAssistants.length ? <p>{tUi("Vision tool is available on the selected assistants.")}</p> : <p>{tUi("Select an assistant")}</p>}
        {toggle(tUi("Add Vision tool on publish"), ai.vision.addToolOnPublish === true, addToolOnPublish => vision({ addToolOnPublish }))}
        <p className="text-muted-foreground">{tUi("Publishing verifies Vision on the dedicated video profile. This option adds missing tools to that profile and preserves the source assistant.")}</p>
        {missingVisionTools.map(item => <a className="block underline" key={item.id} href={`/admin/ai-assistants/${encodeURIComponent(item.id)}?section=integrations`} target="_blank" rel="noreferrer">{tUi("Open assistant tools")}: {item.name}</a>)}
      </div>}
      {ai.vision.mode === "live" && <>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{tUi("Allowed Vision sources")}</legend>{VISION_SOURCE_TYPES.map(source => <label key={source} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ai.vision.allowedSources.includes(source)} onChange={e => vision({ allowedSources: e.target.checked ? [...ai.vision.allowedSources, source] : ai.vision.allowedSources.filter(s => s !== source) })} />{({"customer-camera":tUi("Customer camera"),"agent-camera":tUi("Agent camera"),"customer-screen":tUi("Customer shared screen"),"agent-screen":tUi("Agent shared screen")})[source]}</label>)}</fieldset>
        {select(tUi("Vision source selection"), ai.vision.selection, [["automatic", tUi("Automatic: shared screen, then preferred camera")], ["manual", tUi("Manual")]], selection => vision({ selection }))}
        {select(tUi("Preferred camera"), ai.vision.preferredCamera, [["customer-camera", tUi("Customer camera")], ["agent-camera", tUi("Agent camera")]], preferredCamera => vision({ preferredCamera }))}
        {toggle(tUi("Let the assigned agent control Vision"), ai.vision.agentControls, agentControls => vision({ agentControls }))}
        <p className="text-xs text-muted-foreground">{tUi("Each participant explicitly allows AI to see their camera or screen. One source is analyzed at a time, approximately every two seconds. A manually selected source pauses when it disappears.")}</p>
      </>}
      {widgetId && <div className="space-y-2 text-xs"><button type="button" className="underline" onClick={checkProfiles}>{tUi("Check published assistant profiles")}</button>
        {profiles?.status==="loading"&&<Skeleton className="h-12 w-full"/>}
        {profiles?.status==="error"&&<p role="alert">{profiles.error}</p>}
        {profiles?.status==="ready"&&(!profiles.items.length?<p>{tUi("Publish to create the video assistant profile")}</p>:profiles.items.map(p=><p key={p.sourceAssistantId}>{p.name}: {tUi(p.status!=="ready"?"Unavailable":p.sourceChanged?"Source changed. Publish again to update the video profile.":"Published profile is up to date")}</p>))}
      </div>}
      {widgetId && <a className="block text-sm underline" href={`/admin/widgets/test-host?widget=${encodeURIComponent(widgetId)}`} target="_blank" rel="noreferrer">{tUi("Test the published video widget")}</a>}
    </>}
    {widgetId && <VideoConferenceHistory widgetId={widgetId}/>}
  </div>;
}
