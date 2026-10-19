"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { hasLiveVoiceCall } from '@/lib/telephony/phone-indicator.mjs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HandoffEntryCard } from './handoff/HandoffEntry';
import useActiveCallStore from '@/lib/stores/active-call-store';
import { useEffect, useRef, useState } from 'react';
import { Activity, Globe, RefreshCw, AlertCircle, ArrowLeftRight, CheckCircle2, Loader2, Monitor, Smartphone, Tablet } from 'lucide-react';
import { selectVoiceEndpoint, refreshVoiceEndpoints, subscribeVoiceEndpoints, voiceEndpointRegistration } from '@/lib/telephony/endpoint-client';
import { voiceEndpointOptions } from '@/lib/telephony/endpoint-options.mjs';
import { useTelnyx } from '@/components/telephony-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function VoiceEndpointSelector({ onOpenQuality }) {
  const tUi = useUiText();
  const activeInteractionId=useActiveCallStore(s=>s.contactCenter?.interactionId);
  const callStatus=useActiveCallStore(s=>s.status);
  const currentCall=useActiveCallStore(s=>s.call);
  const [state, setState] = useState(null);
  const [switchingId, setSwitchingId] = useState(null);
  const selecting = useRef(false);
  const [selectionError, setSelectionError] = useState('');
  const { status, error: connectionError, reconnect, region, setRegion, regions, client } = useTelnyx();
  const onCall = hasLiveVoiceCall({status: callStatus, call: currentCall}, client);
  const configureDisabled = onCall || status === 'connecting' || Boolean(switchingId);
  useEffect(() => subscribeVoiceEndpoints(setState), []);

  const error = selectionError || connectionError;
  const loading = !state && !error && status === 'connecting';
  const own = voiceEndpointRegistration()?.id;
  const selected = state?.endpoints.find(device => device.id === state.endpointId);
  const options = voiceEndpointOptions(state, own);

  async function choose(device) {
    if (onCall || selecting.current || !device.reachable || device.id === state?.endpointId) return;
    selecting.current = true;
    setSwitchingId(device.id);
    setSelectionError('');
    try { await selectVoiceEndpoint(device.id); }
    catch (err) {
      setSelectionError(err.message);
      await refreshVoiceEndpoints().catch(() => {});
    } finally {
      selecting.current = false;
      setSwitchingId(null);
    }
  }

  return <div className="space-y-3" data-help-id="phone.devices" data-testid="voice-endpoint-selector">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">{tUi("Calls on")}</h3>
      <span className="truncate text-xs text-muted-foreground">{selected?.label || (state ? tUi("Choose a device") : '')}</span>
    </div>
    {state && !state.endpointId && <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">{tUi("Choose a call device before receiving voice calls.")}</p>}
    {loading ? <div className="grid grid-cols-2 gap-2" aria-label={tUi("Loading voice devices")}>
      <Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-32 rounded-2xl" />
    </div> : options.length ? <div className="grid grid-cols-2 gap-2" role="group" aria-label={tUi("Call devices")} aria-busy={Boolean(switchingId)}>
      {options.map(option => {
        const {target: device, active, needsReconnect, canChoose, detail} = option;
        const tone = needsReconnect ? 'text-amber-700 dark:text-amber-300'
          : active ? 'text-emerald-700 dark:text-telnyx-green' : 'text-muted-foreground';
        const switching = device.id === switchingId;
        const Icon = option.kind === 'web' ? Monitor : option.formFactor === 'tablet' ? Tablet : Smartphone;
        return <button key={option.key} type="button" aria-pressed={active}
          data-endpoint-id={device.id} disabled={onCall || Boolean(switchingId) || !canChoose}
          onClick={() => choose(device)}
          className={cn('flex min-h-32 min-w-0 flex-col gap-2 rounded-2xl border p-3 text-left shadow-sm backdrop-blur-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green disabled:cursor-default',
            needsReconnect ? 'border-amber-500/50 bg-amber-500/10' : active ? 'border-telnyx-green/70 bg-telnyx-green/10' : 'border-border bg-muted/40 enabled:hover:border-telnyx-green/50 enabled:hover:bg-telnyx-green/5',
            !device.reachable && !active && 'opacity-50')}>
          <span className={cn('flex w-full items-center justify-between', tone)}>
            <Icon className="h-7 w-7" aria-hidden="true" />
            {switching ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
              : needsReconnect ? <AlertCircle className="h-4 w-4" aria-hidden="true" />
                : active ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                : <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />}
          </span>
          <span className="w-full break-words text-sm font-semibold">{option.label}</span>
          <span className={cn('mt-auto text-xs', tone)}>
            {switching ? tUi("Switching…") : detail}
            {device.id === own && <span className="mt-0.5 block text-muted-foreground">{tUi("This browser")}</span>}
          </span>
        </button>;
      })}
    </div> : <p className="text-sm text-muted-foreground">{state ? tUi("No call devices available.") : tUi("Voice device unavailable.")}</p>}
    <div className="space-y-2">
      <Select value={region} disabled={configureDisabled} onValueChange={setRegion}>
        <SelectTrigger aria-label={tUi("Connection region")} className="h-11 w-full rounded-2xl bg-muted/40 shadow-sm backdrop-blur-xl">
          <Globe className="h-4 w-4 text-emerald-500" aria-hidden="true" /><SelectValue />
        </SelectTrigger>
        <SelectContent className="z-[1200]">
          {(regions || []).map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <Button type="button" variant="outline" className="h-11 rounded-full bg-muted/40 text-xs shadow-sm backdrop-blur-xl"
        disabled={configureDisabled} onClick={() => { setSelectionError(''); reconnect(); }}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />{tUi(" Reconnect")}</Button>
      <Button type="button" variant="outline" className="h-11 rounded-full bg-muted/40 text-xs shadow-sm backdrop-blur-xl" onClick={onOpenQuality}>
        <Activity className="h-4 w-4" aria-hidden="true" />{tUi(" Statistics")}</Button>
    </div>
    {state?.handoffs?.some(h=>h.target_id===own)&&<p role="status" className="rounded-xl border border-telnyx-green/40 p-3 text-sm">{tUi("A video call is ready to move here. Open it in Inbox and select Accept video here.")}</p>}
    <HandoffEntryCard callInteractionId={activeInteractionId}/>
    <span className="sr-only" role="status">{switchingId ? tUi("Switching call device…") : selected ? tUi("Calls on {value0}", { value0: selected.label }) : ''}</span>
    {error && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}

  </div>;
}
