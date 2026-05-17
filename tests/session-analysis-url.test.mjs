import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionAnalysisRequestUrl } from "../lib/contact-center/session-analysis-url.js";

test("session analysis URL uses call_session_id instead of interaction id when available", () => {
  const url = buildSessionAnalysisRequestUrl({
    conversation: {
      id: "8585887-07bb-4c03-9f3c-78366bd974a8",
      call_session_id: "b437049e-522c-11f1-b561-02420a1f0a69",
      created_at: "2026-05-17T20:12:45.000Z",
    },
    useDemoApiKey: false,
  });

  assert.match(url, /\/api\/ai\/conversations\/b437049e-522c-11f1-b561-02420a1f0a69\/session-analysis\?/);
  assert.doesNotMatch(url, /8585887-07bb-4c03-9f3c-78366bd974a8/);
  assert.match(url, /record_type=ai-voice-assistant/);
  assert.match(url, /date_time=2026-05-17/);
});

test("session analysis URL falls back to conversation id and preserves demo key flag", () => {
  const url = buildSessionAnalysisRequestUrl({
    conversation: { id: "conversation-1" },
    useDemoApiKey: true,
  });

  assert.match(url, /\/api\/ai\/conversations\/conversation-1\/session-analysis\?/);
  assert.match(url, /useDemoApiKey=true/);
});
