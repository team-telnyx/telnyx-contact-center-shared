import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import CobrowseAgentModal from "../../components/contact-center/CobrowseAgentModal.jsx";
import CobrowseInteractionWorkspace from "../../components/contact-center/CobrowseInteractionWorkspace.jsx";

function App() {
  const [open, setOpen] = useState(true);
  const [event, setEvent] = useState("");
  const [autoOpen, setAutoOpen] = useState(false);
  useEffect(() => {
    const changed = (message) => { setEvent(JSON.stringify(message.detail)); if (message.detail?.open) setAutoOpen(true); };
    window.addEventListener("contact-center:cobrowse-changed", changed);
    return () => window.removeEventListener("contact-center:cobrowse-changed", changed);
  }, []);
  return <>
    <button type="button" id="open-dialog" onClick={() => setOpen(true)}>Open co-browsing</button>
    <output id="cobrowse-event">{event}</output>
    <div style={{ pointerEvents: "none" }}>
      {open && <CobrowseAgentModal interaction={{ id: "test-work", state: "active" }} onClose={() => setOpen(false)} />}
    </div>
    <CobrowseInteractionWorkspace interaction={{ id: "test-work", channel: "chat", state: "active" }} autoOpen={autoOpen}>
      <div id="chat-content">Chat stays mounted</div>
    </CobrowseInteractionWorkspace>
  </>;
}

createRoot(document.getElementById("app")).render(<App />);
