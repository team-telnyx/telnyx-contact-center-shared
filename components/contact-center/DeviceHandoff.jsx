"use client";
import {ArrowLeftRight,Loader2} from 'lucide-react';
import {useDeviceHandoff} from '@/hooks/use-device-handoff';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';

export function DeviceHandoff({interactionId,onJoinVideo}) {
  const {state,error,busy,pending,command}=useDeviceHandoff(interactionId,onJoinVideo);
  if(!interactionId)return null;
  const h=state?.handoff,progress=h&&['running','compensating'].includes(h.state);
  const problem=error||h?.error;
  const waiting=h?.channel==='video'?'Connect video here to continue.':h?.step==='await_answer'?'Answer the incoming call on this device.':'Preparing the call on this device…';
  return <section className="space-y-3 rounded-2xl border bg-muted/20 p-3" aria-label="Call handoff">
    <div className="flex items-center gap-2 text-sm font-semibold"><ArrowLeftRight className="size-4"/>Call handoff</div>
    {!state&&!error?<Skeleton className="h-20 rounded-xl"/>:progress?<div className="space-y-2">
      <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin"/>{h.isTarget?waiting:`Taking over on ${h.targetLabel}…`}</p>
      <p className="text-xs text-muted-foreground">Keep this call open until the other device is connected. Ownership changes after confirmation.</p>
      {h.canJoin&&onJoinVideo&&<Button disabled={busy} onClick={()=>command({action:'join',id:h.id})}>Connect video here</Button>}
      {h.canCancel&&<Button variant="outline" disabled={busy} onClick={()=>command({action:'cancel',id:h.id})}>Cancel handoff</Button>}
    </div>:state?.canTakeOver?<div className="space-y-2">
      <p className="text-xs text-muted-foreground">Currently on {state.ownerLabel}. The current call stays connected until you answer here.</p>
      <Button variant="outline" className="rounded-xl" disabled={busy} onClick={()=>command({action:'take_over',expectedOwnerId:state.ownerId,expectedVersion:state.ownerVersion,commandId:crypto.randomUUID()})}>
        {busy?<Loader2 className="size-4 animate-spin"/>:<ArrowLeftRight className="size-4"/>}Take over here
      </Button>
    </div>:<p className="text-xs text-muted-foreground">{state?.unavailableReason||`Call on ${state?.ownerLabel||'another device'}. To move it, open this interaction on the other device and choose “Take over here”.`}</p>}
    {problem&&<p role="alert" className="text-xs text-destructive">{problem}</p>}
    {pending&&<Button variant="outline" disabled={busy} onClick={()=>command(pending)}>Check / retry handoff</Button>}
  </section>;
}
