"use client";

import { DeviceHandoff } from './DeviceHandoff';
import useActiveCallStore from '@/lib/stores/active-call-store';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeftRight, CheckCircle2, Loader2, Monitor, Smartphone } from 'lucide-react';
import { selectVoiceEndpoint, refreshVoiceEndpoints, subscribeVoiceEndpoints, voiceEndpointRegistration } from '@/lib/telephony/endpoint-client';
import { voiceEndpointOptions } from '@/lib/telephony/endpoint-options.mjs';
import { useTelnyx } from '@/components/telephony-provider';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function VoiceEndpointSelector() {
  const activeInteractionId=useActiveCallStore(s=>s.contactCenter?.interactionId);
  const callStatus=useActiveCallStore(s=>s.status);
  const [state, setState] = useState(null);
  const [switchingId, setSwitchingId] = useState(null);
  const selecting = useRef(false);
  const [selectionError, setSelectionError] = useState('');
  const { status, error: connectionError, reconnect } = useTelnyx();
  useEffect(() => subscribeVoiceEndpoints(setState), []);

  const error = selectionError || connectionError;
  const loading = !state && !error && status === 'connecting';
  const own = voiceEndpointRegistration()?.id;
  const selected = state?.endpoints.find(device => device.id === state.endpointId);
  const options = voiceEndpointOptions(state, own);

  async function choose(device) {
    if (selecting.current || !device.reachable || device.id === state?.endpointId) return;
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

  return <div className="space-y-3" data-testid="voice-endpoint-selector">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">Calls on</h3>
      <span className="truncate text-xs text-muted-foreground">{selected?.label || (state ? 'Choose a device' : '')}</span>
    </div>
    {loading ? <div className="grid grid-cols-2 gap-2" aria-label="Loading voice devices">
      <Skeleton className="h-32 rounded-2xl" /><Skeleton className="h-32 rounded-2xl" />
    </div> : options.length ? <div className="grid grid-cols-2 gap-2" role="group" aria-label="Call devices" aria-busy={Boolean(switchingId)}>
      {options.map(option => {
        const {target: device, active, needsReconnect, canChoose, detail} = option;
        const tone = needsReconnect ? 'text-amber-700 dark:text-amber-300'
          : active ? 'text-emerald-700 dark:text-telnyx-green' : 'text-muted-foreground';
        const switching = device.id === switchingId;
        const Icon = device.kind === 'ios' ? Smartphone : Monitor;
        return <button key={option.kind} type="button" aria-pressed={active}
          data-endpoint-id={device.id} disabled={Boolean(switchingId) || !canChoose}
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
            {switching ? 'Switching…' : detail}
            {device.id === own && <span className="mt-0.5 block text-muted-foreground">This browser</span>}
          </span>
        </button>;
      })}
    </div> : <p className="text-sm text-muted-foreground">{state ? 'No call devices available.' : 'Voice device unavailable.'}</p>}
    {state?.handoffs?.some(h=>h.target_id===own)&&<p role="status" className="rounded-xl border border-telnyx-green/40 p-3 text-sm">A video call is ready to move here. Open it in Inbox and select Accept video here.</p>}
    {activeInteractionId&&['active','connected','answered','held'].includes(callStatus)&&<DeviceHandoff interactionId={activeInteractionId}/>}
    <p className="text-xs leading-relaxed text-muted-foreground">Switch phones when no voice or video interaction is in progress. Both apps stay synchronized.</p>
    <span className="sr-only" role="status">{switchingId ? 'Switching call device…' : selected ? `Calls on ${selected.label}` : ''}</span>
    {error && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
    {!loading && (!state || connectionError) && <Button type="button" variant="outline" size="sm" className="w-full text-xs"
      disabled={status === 'connecting'} onClick={() => { setSelectionError(''); reconnect(); }}>
      Retry voice connection
    </Button>}
  </div>;
}
