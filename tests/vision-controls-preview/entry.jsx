import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ConferenceAiControls from '../../components/video/ConferenceAiControls.jsx';
import { VideoLayoutSwitch } from '../../components/video/VideoStage.jsx';
import { AiChatImageDrafts, useAiChatImages } from '../../components/widget/AiChatImages.jsx';
import { IconVideo, IconHome, IconX, IconMicrophone, IconPhoneOff, IconUser, IconSend, IconPaperclip } from '@tabler/icons-react';

const palette = { surface: '#ffffff', text: '#192629', border: '#dce4e4', primary: '#00cfa4', onPrimary: '#002c23' };
const vision = { mode: 'live', allowedSources: ['customer-camera', 'customer-screen', 'agent-camera', 'agent-screen'], selection: 'automatic', agentControls: true };
const sources = vision.allowedSources.map(type => ({ key: type, type, role: type.split('-')[0], streamKey: type.endsWith('screen') ? 'screen' : 'camera', participantId: type.split('-')[0], available: true, consented: true }));
function PreviewControls({ role, track }) {
  const [ai, setAi] = useState({ state: 'connected', desiredState: 'active', ownConsent: { camera: true, screen: false }, visionConfig: vision, vision: { selection: 'automatic', effectiveSourceKey: 'customer-camera' }, sources });
  const [notice, setNotice] = useState('');
  async function onAction(body) {
    if (body.action === 'consent') setAi(a => ({ ...a, ownConsent: { ...a.ownConsent, [body.source]: body.enabled } }));
    else if (body.action === 'active' || body.action === 'muted') setAi(a => ({ ...a, desiredState: body.action }));
    else if (body.action === 'vision-source') setAi(a => ({ ...a, vision: { selection: body.automatic ? 'automatic' : 'manual', requestedSourceKey: body.sourceKey, effectiveSourceKey: body.automatic ? 'customer-camera' : body.sourceKey } }));
    else setNotice('Preview only — no request sent.');
  }
  const room = { local: { video: track }, localScreen: track, remote: sources.map(s => ({ participantId: s.participantId, key: s.streamKey, videoTrack: track })) };
  return <><ConferenceAiControls role={role} agentConnected={role === 'agent'} ai={ai} config={{ assistantId: 'preview', vision }} room={room} onAction={onAction} palette={role === 'customer' ? palette : undefined} />{notice && <p className="mt-2 text-xs opacity-60">{notice}</p>}</>;
}
function Stage({ agent = false }) {
  return <div className="relative overflow-hidden rounded-2xl bg-[#101517]" style={{ height: agent ? 410 : 290 }}>
    <img src="/elena.png" alt="Elena avatar preview" className="h-full w-full object-cover" />
    <span className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-xs text-white">Elena</span>
    <div className="absolute bottom-3 right-3 grid h-20 w-28 place-items-center rounded-xl border border-white/20 bg-[#223b40] text-white"><IconUser size={30} /><span className="absolute left-2 top-1 text-[10px]">{agent ? 'Customer' : 'You'}</span></div>
    <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-3 rounded-full bg-black/70 px-3 py-2 text-white"><IconMicrophone size={22} /><span className="rounded-full bg-red-500 p-1"><IconPhoneOff size={22} /></span><IconVideo size={22} /></div>
  </div>;
}
function ChatPreview() {
  const draft = useAiChatImages(); const input = useRef(null); const [sending, setSending] = useState(false); const [sent, setSent] = useState(false);
  useEffect(() => { let active = true; fetch('/sample.png').then(r => r.blob()).then(blob => { if (active) draft.add([new File([blob], 'vision-sample.png', { type: 'image/png' })]); }); return () => { active = false; }; }, []);
  return <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 text-slate-900"><h2 className="mb-3 text-sm font-semibold">Chat · image preview</h2>
    {sent && <div className="mb-3 ms-auto w-40 rounded-xl bg-emerald-100 p-2"><img src="/sample.png" alt="Sent sample" className="rounded-lg" />{sending && <span className="text-xs">Sending…</span>}</div>}
    <AiChatImageDrafts images={sending || sent ? [] : draft.images} remove={draft.remove} busy={sending} />
    <div className="flex items-center gap-2"><button title="Choose preview image" onClick={() => input.current.click()}><IconPaperclip size={20} /></button><input ref={input} type="file" accept="image/*" hidden onChange={e => { draft.clear(); draft.add(e.target.files); setSent(false); }} /><span className="flex-1 rounded-full border px-3 py-2 text-xs text-slate-400">Type your message…</span><button aria-label="Preview image submission" className="rounded-full bg-emerald-200 p-2" disabled={!draft.images.length || sent} onClick={() => {setSending(true);setSent(true);setTimeout(() => {setSending(false);draft.clear();},1500);}}><IconSend size={20} /></button></div>
    <p className="mt-3 text-[11px] text-slate-500">Local preview. The sample stays in this browser.</p>
  </section>;
}
function App() {
  const [track, setTrack] = useState(null);
  const [layout, setLayout] = useState('pip');
  useEffect(() => { const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180; const c = canvas.getContext('2d'); c.fillStyle='#d5f4ed';c.fillRect(0,0,320,180);c.fillStyle='#00a482';c.fillRect(24,24,90,90);c.fillStyle='#26364a';c.font='bold 36px sans-serif';c.fillText('VISION',130,90);const stream=canvas.captureStream(1);setTrack(stream.getVideoTracks()[0]);return () => stream.getTracks().forEach(t=>t.stop()); }, []);
  return <main className="mx-auto max-w-[1500px] p-7"><header className="mb-6 flex items-end justify-between gap-4"><div><p className="mb-1 text-xs font-semibold uppercase tracking-widest text-emerald-700">Vision controls</p><h1 className="text-2xl font-semibold text-slate-900">Widget & agent desktop</h1></div><p className="max-w-xs text-right text-xs text-slate-500">Interactive UI preview · actual application components<br />Simulated session · no Telnyx calls</p></header>
    <div className="grid items-start gap-7 min-[1100px]:grid-cols-[390px_minmax(0,1fr)]"><div><h2 className="mb-2 text-xs font-semibold text-slate-500">CUSTOMER WIDGET · 390 PX</h2><div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm"><header className="flex items-center gap-3 bg-[#00cfa4] p-4 text-[#002c23]"><IconVideo size={20} /><div className="flex-1"><strong className="text-base">How can we help?</strong><p className="text-xs">Talk to an agent over video</p></div><IconHome size={20} /><IconX size={20} /></header><div className="@container space-y-3 p-3"><p className="w-fit rounded-full bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800">● Connected to AI assistant</p><div className="flex min-w-0 items-center gap-2 overflow-x-auto p-0.5 [--video-toolbar-button-size:clamp(24px,calc((100cqw_-_18px)/13),32px)]"><PreviewControls role="customer" track={track} /><VideoLayoutSwitch toolbar palette={palette} layout={layout} onChange={setLayout} labels={{ layoutRemote: "Agent only", layoutSplit: "Side by side", layoutPip: "Picture in picture", layoutSpotlight: "Spotlight", layout: "Layout" }} /></div><Stage /></div></div><ChatPreview /></div>
    <section className="dark"><h2 className="mb-2 text-xs font-semibold text-slate-500">CONTACT CENTER · AGENT</h2><div className="rounded-2xl border border-[#252525] bg-[#101010] p-4 text-white"><header className="mb-3 flex flex-wrap items-center gap-3 border-b border-white/10 pb-3">
      <h3 className="text-sm font-semibold">Video call</h3>
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
        <div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto p-0.5"><PreviewControls role="agent" track={track} />
        <VideoLayoutSwitch toolbar layout={layout} onChange={setLayout} labels={{ layoutRemote: "Customer only", layoutSplit: "Side by side", layoutPip: "Picture in picture", layoutSpotlight: "Spotlight", layout: "Layout" }} /></div>
        <div className="ms-auto flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-950 text-emerald-300"><IconUser size={18} /></span>
          <div className="min-w-0"><p className="truncate text-xs font-semibold">Website visitor</p><p className="text-[10px] text-neutral-500">Sales · AI assistant in the room</p></div>
          <span className="shrink-0 rounded-full bg-emerald-950 px-2 py-1 text-[10px] text-emerald-300">Connected</span>
        </div>
      </div>
    </header><Stage agent /><p className="mt-4 text-xs text-neutral-500">Assistant transcript</p></div></section></div>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
