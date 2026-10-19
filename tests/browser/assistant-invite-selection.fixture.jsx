import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantInviteSettings } from "../../components/voice-flow/AssistantInviteSettings";

const ids = Array.from({ length: 20 }, (_, index) => `assistant-00000000-0000-0000-0000-${String(index).padStart(12, "0")}`);
window.fixture = { ids, listRequests: 0, checks: [], pending: new Map() };
window.fetch = async url => {
  const id = new URL(url, location.href).searchParams.get("assistantId");
  if (!id) { fixture.listRequests++; return { ok: true, json: async () => ({ items: ids.map((id, index) => ({ id, name: `Assistant ${index}` })) }) }; }
  fixture.checks.push(id);
  // Deliberately allow a late response after abort to verify stale results
  // cannot select an assistant after disabling or changing the edited node.
  return new Promise(resolve => fixture.pending.set(id, (skipTurn, ok = true) => resolve({ ok, json: async () => ok ? { item: { id, skipTurn } } : { error: "Verification unavailable" } })));
};
function Fixture() {
  const [config, setConfig] = useState({ enabled: true, enable_assistant_invite: true, invite_assistant_ids: [ids[0]], otherSetting: "original" });
  const [nodeId, setNodeId] = useState(0);
  useEffect(() => {
    fixture.config = config;
    fixture.nodeId = nodeId;
    fixture.editOther = () => setConfig(previous => ({ ...previous, otherSetting: "edited" }));
    fixture.changeNode = () => { setNodeId(value => value + 1); setConfig({ enabled: true, enable_assistant_invite: true, invite_assistant_ids: [] }); };
  }, [config, nodeId]);
  return <AssistantInviteSettings key={nodeId} config={config} onChange={setConfig} />;
}
createRoot(document.getElementById("root")).render(<Fixture />);
