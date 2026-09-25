import React from "react";
import { createRoot } from "react-dom/client";
import WidgetTestHostPage from "../../components/widget-admin/WidgetTestHostPage.jsx";

const last = location.pathname.split("/").filter(Boolean).at(-1);
const section = ["products", "checkout", "support", "account"].includes(last)
  ? last
  : "overview";

window.__testBootId = Math.random();
createRoot(document.getElementById("app")).render(
  React.createElement(WidgetTestHostPage, {
    initialSection: section,
    widgetId: new URLSearchParams(location.search).get("widget") || "",
  }),
);
