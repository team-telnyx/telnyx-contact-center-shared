import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UiLocaleProvider, useUiLocale } from '../../components/i18n/UiLocaleProvider';
import { useUiText } from '../../components/i18n/use-ui-text';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '../../components/ui/sheet';
import { Input } from '../../components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../components/ui/select';
import english from '../../messages/en-US.json';
import { messageId } from '../../lib/i18n/locales.mjs';
import { DEFAULT_AGENT_STATUSES } from '../../lib/i18n/status-labels.mjs';
import { StatusSelector } from '../../components/contact-center/StatusSelector';
import InteractionStateBadge from '../../components/contact-center/InteractionStateBadge';
import { CampaignActivationSelector } from '../../components/contact-center/CampaignActivationSelector';
import LiveInteractionsView from '../../components/contact-center/LiveInteractionsView';
import MultichannelDashboard from '../../components/contact-center/MultichannelDashboard';
import EmojiPickerPanel from '../../components/messaging/EmojiPickerPanel';
import { UiText } from '../../components/i18n/use-ui-text';
const fixture = window.fixture = {
  mounts: 0,
  unmounts: 0,
  changes: []
};
const campaigns = [
  {id:'campaigns',name:'Campaigns',mode:'preview',status:'running',activated:true},
  {id:'available',name:'Available',mode:'progressive',status:'paused',activated:true},
  {id:'save',name:'Save',mode:'preview',status:'stopped',activated:false},
];
const originalFetch = window.fetch.bind(window);
window.fetch = (url, ...args) => {
  const json = data => Promise.resolve(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  if (url === '/api/user/statuses') return json({ statuses: [...DEFAULT_AGENT_STATUSES.map(status => ({ ...status, user_selectable: true })), { name: 'Training for client A', user_selectable: true }] });
  if (url === '/api/contact-center/agent/campaigns') {
    fixture.campaignRequest = JSON.parse(args[0].body);
    return json({ok:true,campaigns:campaigns.map(c=>({...c,activated:fixture.campaignRequest.campaignIds.includes(c.id)}))});
  }
  if (String(url).startsWith('/api/contact-center/monitor/interactions?')) return json({
    timestamp: new Date().toISOString(), totals:{interactions:1,legs:0}, interactions:[{
      id:'native-row',workItemId:'native-work',channel:'voice',kind:'queue',state:'queued',
      customerName:'Save',queueName:'Available',agentName:'Training',fromNumber:'+12025550123',toNumber:'+12025550124',
      requiredSkills:{skill:3},skillNames:{skill:'Campaigns'},priority:2,createdAt:new Date().toISOString(),
      capabilities:{conversation:false,supervision:false},sla:{state:'met'},
    }],
  });
  if (String(url).startsWith('/api/contact-center/reporting?')) return json({
    timestamp:new Date().toISOString(),scope:{timezone:'UTC'},
    totals:{received:0,closed:0,waiting:0,offered:0,handling:0},
    filters:{queues:[{id:'native-queue',name:'Queue',display_name:'Save'}]},
    channels:[{channel:'voice',received:0,closed:0,completed:0,abandoned:0,failed:0,sla:{denominator:0}}],
    trend:[],queues:[],workforce:[],slaTrend:[],breaches:[],
    sla:{denominator:0,met:0,breached:0,unserved:0,pending:0,atRisk:0,not_configured:0,disabled:0,excluded:0,unavailable:0},
  });
  return originalFetch(url, ...args);
};
function CoveragePanel() {
  return <section data-testid="coverage" className="space-y-8">
    <CampaignActivationSelector campaigns={campaigns} />
    <div className="h-[650px]"><LiveInteractionsView /></div>
    <div data-testid="report"><MultichannelDashboard /></div>
    <div data-testid="emoji-picker"><EmojiPickerPanel onEmojiSelect={value => { fixture.emoji = value; }} /></div>
  </section>;
}

function TerminologyPanel() {
  const t = useUiText();
  const [status, setStatus] = useState('Available');
  return <div data-testid="terminology">
    <StatusSelector value={status} pendingStatus="Vacation" onChange={value => { fixture.selectedAgentStatus = value; setStatus(value); }} />
    <span data-testid="call-action">{t('Call', undefined, 'phone action')}</span>
    <span data-testid="call-noun">{t('Call')}</span>
    <span data-testid="open-action"><UiText context="action">Open</UiText></span>
    <span data-testid="open-state">{t('Open')}</span>
    <InteractionStateBadge state="held" /><InteractionStateBadge state="queued" />
  </div>;
}
function StatefulPanel() {
  const t = useUiText();
  const [draft, setDraft] = useState('customer draft');
  useEffect(() => {
    fixture.mounts++;
    return () => {
      fixture.unmounts++;
    };
  }, []);
  return <><h1 data-testid="heading">{t('Interface language')}</h1><Input data-testid="draft" value={draft} onChange={e => setDraft(e.target.value)} /><Input data-testid="phone" type="tel" defaultValue="+971501234567" /><span data-testid="customer" dir="auto">مرحبا Alice +971501234567</span><span data-testid="number">{12345.67.toLocaleString(t.locale)}</span></>;
}
function App() {
  const {
    changeLocale,
    locale
  } = useUiLocale();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    fixture.changeLocale = changeLocale;
    fixture.openPanel = () => setOpen(true);
  }, [changeLocale]);
  return <><div data-testid="locale">{locale}</div><StatefulPanel /><TerminologyPanel /><CoveragePanel /><Select defaultValue="Available" onValueChange={v => fixture.changes.push(v)}><SelectTrigger data-testid="status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Available">Available</SelectItem><SelectItem value="Away">Away</SelectItem></SelectContent></Select><Sheet open={open} onOpenChange={setOpen}><SheetContent data-testid="sheet"><SheetTitle>تفاصيل</SheetTitle><SheetDescription>Arabic layout preview</SheetDescription></SheetContent></Sheet></>;
}
const root = createRoot(document.getElementById('root'));
const rtl = new URLSearchParams(window.location.search).has('rtl');
root.render(<UiLocaleProvider locale={rtl ? 'ar-SA' : 'en-US'} messages={rtl ? {
  ui: {
    ...english.ui,
    [messageId('Interface language')]: 'لغة الواجهة'
  }
} : undefined}><App /></UiLocaleProvider>);
