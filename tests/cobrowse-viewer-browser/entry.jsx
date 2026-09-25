import React from "react";
import { createRoot } from "react-dom/client";
import CobrowseAgentViewer from "../../components/contact-center/CobrowseAgentViewer.jsx";

createRoot(document.getElementById("app")).render(
  <CobrowseAgentViewer interaction={{ id: "test-work" }} session={{ id: "session-1", state: "active",
    controlAvailable: true,
    controlLevel: new URLSearchParams(location.search).get("control") === "observe" ? "observe" : "assist",
    canControl: true }} />,
);
