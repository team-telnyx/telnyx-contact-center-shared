"use client";
import { useEffect, useRef, useState } from 'react';
import { BellRing, Play, Square, Volume2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { InteractionChannel } from '@/components/contact-center/InteractionChannel';
import { channelDefinition } from '@/lib/acd/channel-registry.mjs';
import { NOTIFICATION_CHANNELS, NOTIFICATION_SOUNDS } from '@/lib/contact-center/notification-sounds.mjs';
import { createNotificationSoundPlayer } from '@/lib/contact-center/notification-sound-player.mjs';
import { notify } from '@/components/ToastNotify';

export default function NotificationSoundSettings({ value, onChange, loading, disabled, embedded = false }) {
  const player = useRef(null), selection = useRef(null);
  const [preview, setPreview] = useState(null);
  const latest = useRef(value);
  useEffect(() => { latest.current = value; }, [value]);
  useEffect(() => {
    const instance = createNotificationSoundPlayer({
      onFinished: () => {
        // Keep Stop visible during the one-second loop gap.
        if (selection.current && !latest.current.channels[selection.current.channel].loop) {
          selection.current = null; setPreview(null);
        }
      },
      onBlocked: blocked => { if (blocked) notify({ title: 'Sound preview blocked', description: 'Press Play again to enable audio.', variant: 'warning' }); },
      onError: () => { selection.current = null; setPreview(null); notify({ title: 'Sound unavailable', description: 'Could not load the selected ringtone.', variant: 'error' }); },
    });
    player.current = instance;
    return () => { selection.current = null; instance.dispose(); player.current = null; };
  }, []);
  useEffect(() => {
    if (!preview || !player.current) return;
    player.current.update([{ offer_id: preview.id, channel: preview.channel, state: 'ringing' }], {
      ...value, channels: { ...value.channels, [preview.channel]: { ...value.channels[preview.channel], enabled: true } },
    });
  }, [value, preview]);
  function togglePreview(channel) {
    selection.current = null; player.current?.update([], null);
    if (preview?.channel === channel) { setPreview(null); return; }
    const next = { channel, id: `preview-${crypto.randomUUID()}` };
    selection.current = next; setPreview(next);
    // Start in the click handler to retain the browser's audio permission.
    player.current?.update([{ offer_id: next.id, channel, state: 'ringing' }], {
      ...value, channels: { ...value.channels, [channel]: { ...value.channels[channel], enabled: true } },
    });
    player.current?.unlock();
  }
  function updateChannel(channel, patch) {
    onChange({ ...value, channels: { ...value.channels, [channel]: { ...value.channels[channel], ...patch } } });
  }
  const Root = embedded ? "div" : Card;
  const Body = embedded ? "div" : CardContent;
  return <Root className={embedded ? "min-w-0" : "border bg-card shadow-sm"}>
    {!embedded && <CardHeader>
      <div className="flex items-start gap-3"><span className="rounded-lg border bg-background p-2"><BellRing className="size-5" /></span>
        <div><CardTitle>Interaction sounds</CardTitle><p className="mt-1 text-sm text-muted-foreground">Notify agents when a new messaging interaction is offered. Settings apply to all agents.</p></div>
      </div>
    </CardHeader>}
    <Body className="space-y-5">
      {loading ? <div role="status" aria-label="Loading interaction sounds" className="space-y-3"><Skeleton className="h-8 w-2/3" />{NOTIFICATION_CHANNELS.map(channel => <Skeleton key={channel} className="h-24 w-full" />)}</div> : <>
        <div className="flex flex-wrap items-center gap-4">
          <Label htmlFor="notification-volume" className="flex items-center gap-2"><Volume2 className="size-4" />Volume</Label>
          <input id="notification-volume" type="range" min={0} max={100} step={5} value={value.volume} disabled={disabled}
            onChange={event => onChange({ ...value, volume: Number(event.target.value) })} className="h-5 min-w-0 flex-1 accent-primary" />
          <output htmlFor="notification-volume" className="w-12 text-sm tabular-nums">{value.volume}%</output>
        </div>
        <div className="divide-y rounded-xl border">
          {NOTIFICATION_CHANNELS.map(channel => {
            const config = value.channels[channel], definition = channelDefinition(channel), active = preview?.channel === channel;
            return <div key={channel} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2"><InteractionChannel channel={channel} label />{!definition.released && <Badge variant="outline">Future channel</Badge>}</div>
                <div className="flex items-center gap-2"><Label htmlFor={`sound-enabled-${channel}`}>Enabled</Label><Switch id={`sound-enabled-${channel}`} aria-label={`Enable ${definition.label} sound`} checked={config.enabled} onCheckedChange={enabled => updateChannel(channel, { enabled })} disabled={disabled} /></div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-40 flex-1">
                  <Select value={config.sound} onValueChange={sound => updateChannel(channel, { sound })} disabled={disabled}>
                    <SelectTrigger className="w-full" aria-label={`${definition.label} ringtone`}><SelectValue /></SelectTrigger>
                    <SelectContent>{NOTIFICATION_SOUNDS.map(sound => <SelectItem key={sound.id} value={sound.id}>{sound.name} · {sound.duration.toFixed(1)}s</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Button type="button" variant="outline" onClick={() => togglePreview(channel)} disabled={disabled || value.volume === 0} aria-label={`${active ? 'Stop' : 'Play'} ${definition.label} ringtone`}>
                  {active ? <Square className="size-4" /> : <Play className="size-4" />}{active ? 'Stop' : 'Play'}
                </Button>
                <div className="flex items-center gap-2"><Switch id={`sound-loop-${channel}`} checked={config.loop} onCheckedChange={loop => updateChannel(channel, { loop })} disabled={disabled} /><Label htmlFor={`sound-loop-${channel}`}>Loop</Label></div>
              </div>
            </div>;
          })}
        </div>
        <p className="text-xs text-muted-foreground">10 short ringtones, 3.2–4 seconds each. Loop repeats with a 1-second pause until the offer is accepted, declined or expires. Play previews the selected loop setting.</p>
        <p className="text-xs text-muted-foreground">Voice uses the WebRTC ringtone. WhatsApp and SMS selections are ready for when those channels become available.</p>
      </>}
    </Body>
  </Root>;
}
