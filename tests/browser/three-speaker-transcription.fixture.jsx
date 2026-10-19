import React from 'react';
import { createRoot } from 'react-dom/client';
import { TestBubble as WorkflowBubble } from '../../components/contact-center/AgentAssistWorkflow.jsx';
import { TestBubble as HistoryBubble } from '../../components/contact-center/WorkflowHistoryView.jsx';
import { TestBubble as KnowledgeBubble } from '../../components/contact-center/AgentAssist.jsx';

const messages = [
  { track: 'inbound', transcript: 'Could you explain the available options?' },
  { track: 'outbound', transcript: 'I will ask our assistant to help us.' },
  { track: 'assistant', transcript: 'Of course. I can explain the options while your agent stays on the call.' },
];
createRoot(document.getElementById('root')).render(
  <div style={{ display: 'flex', gap: 24, padding: 24 }}>
    {[[WorkflowBubble, 'Live Transcription'], [HistoryBubble, 'Conversation history'], [KnowledgeBubble, 'Knowledge assist']].map(([Bubble, name]) => (
      <section key={name} data-testid="transcript-column" style={{ width: 420, padding: 16, background: '#141414', border: '1px solid #333', borderRadius: 12 }}>
        <h2 style={{ fontSize: 18, marginBottom: 24 }}>{name}</h2>
        <div className="space-y-5">
          {messages.map((message, index) => <Bubble key={message.track} transcription={{ ...message, id: String(index), isFinal: true, timestamp: '2026-10-18T20:00:00Z', confidence: message.track === 'assistant' ? null : 0.98 }} />)}
        </div>
      </section>
    ))}
  </div>,
);
