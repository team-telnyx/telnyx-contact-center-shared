import { normalizeFormDefinition, slugifyFormName } from "./form-schema.js";

const MEDIA = {
  supportHero: {
    filename: "pexels-form-support-hero.jpg",
    url: "https://images.pexels.com/photos/3184465/pexels-photo-3184465.jpeg?auto=compress&cs=tinysrgb&w=1600",
    title: "Support team collaborating",
    display_name: "Support team collaborating",
    content_type: "image/jpeg",
    metadata: { source: "pexels", seed: true, photographer: "fauxels", pexelsPhotoId: 3184465, tags: ["support", "team", "office"] },
  },
  onboardingHero: {
    filename: "pexels-form-onboarding-hero.jpg",
    url: "https://images.pexels.com/photos/3184292/pexels-photo-3184292.jpeg?auto=compress&cs=tinysrgb&w=1600",
    title: "Customer onboarding workshop",
    display_name: "Customer onboarding workshop",
    content_type: "image/jpeg",
    metadata: { source: "pexels", seed: true, photographer: "fauxels", pexelsPhotoId: 3184292, tags: ["onboarding", "workshop", "customers"] },
  },
  leadHero: {
    filename: "pexels-form-sales-hero.jpg",
    url: "https://images.pexels.com/photos/3182812/pexels-photo-3182812.jpeg?auto=compress&cs=tinysrgb&w=1600",
    title: "Sales discovery meeting",
    display_name: "Sales discovery meeting",
    content_type: "image/jpeg",
    metadata: { source: "pexels", seed: true, photographer: "fauxels", pexelsPhotoId: 3182812, tags: ["sales", "meeting", "discovery"] },
  },
  escalationHero: {
    filename: "pexels-form-escalation-hero.jpg",
    url: "https://images.pexels.com/photos/3184460/pexels-photo-3184460.jpeg?auto=compress&cs=tinysrgb&w=1600",
    title: "Operations escalation room",
    display_name: "Operations escalation room",
    content_type: "image/jpeg",
    metadata: { source: "pexels", seed: true, photographer: "fauxels", pexelsPhotoId: 3184460, tags: ["operations", "escalation", "team"] },
  },
  agentAvatar: {
    filename: "pexels-form-agent-avatar.jpg",
    url: "https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg?auto=compress&cs=tinysrgb&w=800",
    title: "Agent avatar portrait",
    display_name: "Agent avatar portrait",
    content_type: "image/jpeg",
    metadata: { source: "pexels", seed: true, photographer: "Andrea Piacquadio", pexelsPhotoId: 774909, tags: ["avatar", "agent"] },
  },
};

export const FORM_TEMPLATE_MEDIA_ASSETS = Object.values(MEDIA);

export const FORM_DATA_ACTION_FLOW_IDS = {
  kbLookup: "flow_form_submit_kb_lookup",
  contactUpsert: "flow_form_submit_contact_upsert",
  taskCreate: "flow_form_submit_task_create",
};

function option(label, value = slugifyFormName(label).replace(/-/g, "_")) {
  return { label, value };
}

function field(id, type, label, extra = {}) {
  return { id, type, label, required: false, placeholder: "", ...extra };
}

function dataField(id, type, label, variableName, extra = {}) {
  return field(id, type, label, { variableName, ...extra });
}

function template(slug, name, description, category, fields, extra = {}) {
  const rootFields = extra.pages?.flatMap((page) => page.fields || []) || fields.map((f) => f.id).filter((id) => !fields.some((f) => Object.values(f.props || {}).flat?.().includes?.(id)));
  return normalizeFormDefinition({
    id: slug,
    slug,
    name,
    description,
    category,
    status: "template",
    version: 1,
    schema: {
      fields,
      pages: extra.pages || [{ id: "page_1", title: "Details", description: "", icon: "IconForms", fields: rootFields }],
      showNavigationButtons: extra.showNavigationButtons ?? true,
    },
    layout: { order: fields.map((f) => f.id) },
    theme: { density: "comfortable", primary: "#2563eb", pageTabActiveBorderColor: "#2563eb", ...(extra.theme || {}) },
    bindings: {},
    actions: [{ type: "submit", label: "Submit" }],
    queue_ids: [],
    queue_names: extra.queue_names || [],
    auto_open: Boolean(extra.auto_open),
  });
}

const contactConsentFields = [
  field("hero_contact", "hero", "Support intake", { props: { quote: "QUICK INTAKE", title: "Capture the essentials without slowing the call", description: "A clean single-page form for contact details, intent, consent, and the fastest knowledge-base lookup.", align: "left", padding: "xl", imageUrl: MEDIA.supportHero.url, imageTitle: MEDIA.supportHero.title, imageMode: "background", imageScale: 110 } }),
  dataField("customer_name", "text", "Customer name", "customer_name", { required: true, placeholder: "Full name" }),
  dataField("customer_email", "text", "Email", "customer_email", { required: true, placeholder: "name@example.com" }),
  dataField("inquiry_type", "select", "Inquiry type", "inquiry_type", { required: true, options: [option("Billing"), option("Technical"), option("Sales"), option("Account access")] }),
  dataField("kb_query", "text", "Knowledge search query", "kb_query", { placeholder: "e.g. porting status, invoice dispute, SIP setup" }),
  dataField("marketing_consent", "checkbox", "Customer accepts follow-up communication", "marketing_consent", { required: true, helpText: "Only check after explicit consent." }),
  field("button_kb_lookup", "button", "Search KB articles", { props: { variant: "primary", dataActionFlowId: FORM_DATA_ACTION_FLOW_IDS.kbLookup, dataActionLabel: "KB Articles lookup from form" } }),
];

const consentCenterFields = [
  field("section_consent", "section", "Consent preferences", { helpText: "Record channel-level opt-ins with a short audit note.", props: { padding: "lg", children: ["consent_badge", "consent_name", "consent_email", "consent_sms", "consent_voice", "consent_notes"] } }),
  field("consent_badge", "badge", "Compliance", { props: { text: "GDPR friendly", variant: "secondary", size: "lg", color: "#16a34a" } }),
  dataField("consent_name", "text", "Customer name", "customer_name", { required: true }),
  dataField("consent_email", "switch", "Email opt-in", "email_opt_in", { defaultValue: true, props: { onText: "Allowed", offText: "Not allowed", switchActiveTrackColor: "#16a34a", switchThumbColor: "#ffffff" } }),
  dataField("consent_sms", "switch", "SMS opt-in", "sms_opt_in", { props: { onText: "Allowed", offText: "Not allowed", switchActiveTrackColor: "#0ea5e9", switchThumbColor: "#ffffff" } }),
  dataField("consent_voice", "radio", "Voice call consent", "voice_consent", { required: true, options: [option("Opted in", "opted_in"), option("Opted out", "opted_out"), option("Not asked", "not_asked")] }),
  dataField("consent_notes", "textarea", "Audit note", "consent_notes", { placeholder: "Phrase used by the customer, source, and timestamp context" }),
];

const appointmentFields = [
  field("card_booking", "card", "Callback booking", { props: { title: "Schedule a precise follow-up", description: "Collect the best time, channel, and urgency in one compact card.", padding: "lg", imageUrl: MEDIA.supportHero.url, imageTitle: MEDIA.supportHero.title, imageScale: 100, children: ["callback_name", "callback_phone", "preferred_datetime", "callback_channel", "urgency_slider", "booking_notes"] } }),
  dataField("callback_name", "text", "Customer name", "customer_name", { required: true }),
  dataField("callback_phone", "text", "Callback phone", "callback_phone", { required: true, placeholder: "+48..." }),
  dataField("preferred_datetime", "datetime", "Preferred date and time", "preferred_callback_time", { required: true, props: { mode: "datetime" } }),
  dataField("callback_channel", "select", "Channel", "callback_channel", { options: [option("Voice"), option("SMS"), option("Email"), option("WhatsApp")] }),
  dataField("urgency_slider", "slider", "Urgency", "callback_urgency", { defaultValue: 40, props: { min: 0, max: 100, step: 5, sliderRangeColor: "#f97316", sliderThumbColor: "#ea580c", sliderTrackColor: "#fed7aa" } }),
  dataField("booking_notes", "textarea", "Reason for callback", "callback_reason"),
];

const onboardingFields = [
  field("hero_onboarding", "hero", "Onboarding", { props: { quote: "WELCOME", title: "Launch a high-touch onboarding journey", description: "A medium-complex multi-page template with media, avatar, channel preferences, targets, and a contact data action.", align: "left", padding: "xl", imageUrl: MEDIA.onboardingHero.url, imageTitle: MEDIA.onboardingHero.title, imageMode: "inline", imageScale: 105 } }),
  field("welcome_card", "card", "Welcome card", { props: { title: "Your onboarding desk", description: "Personalize the first touch before creating or updating the contact record.", padding: "lg", children: ["agent_avatar", "welcome_copy"] } }),
  field("agent_avatar", "avatar", "CS", { props: { src: MEDIA.agentAvatar.url, alt: "Customer success agent", fallback: "CS", size: "xl", shape: "circle", imageScale: 100, borderColor: "#2563eb" } }),
  field("welcome_copy", "richtext", "Use this form to prepare an implementation plan and capture clean CRM data.", { props: { richtext: "Confirm the customer profile, choose an onboarding plan, set success targets, and submit to create/update the contact source.", size: "md", padding: "sm" } }),
  dataField("company_name", "text", "Company", "company_name", { required: true }),
  dataField("contact_name", "text", "Primary contact", "contact_name", { required: true }),
  dataField("contact_email", "text", "Email", "contact_email", { required: true }),
  dataField("company_size", "radio", "Company size", "company_size", { options: [option("1-50"), option("51-250"), option("251-1000"), option("1000+")] }),
  dataField("plan", "select", "Plan", "plan", { options: [option("Starter"), option("Growth"), option("Enterprise"), option("Custom")] }),
  dataField("enable_sms_updates", "switch", "Enable SMS updates", "enable_sms_updates", { props: { onText: "SMS enabled", offText: "Email only", switchActiveTrackColor: "#2563eb", switchThumbColor: "#ffffff" } }),
  dataField("success_target", "slider", "Success target", "success_target", { defaultValue: 80, props: { min: 0, max: 100, step: 5, sliderRangeColor: "#22c55e", sliderThumbColor: "#16a34a", sliderTrackColor: "#dcfce7" } }),
  dataField("onboarding_datetime", "datetime", "Preferred kickoff", "preferred_onboarding_time", { props: { mode: "datetime" } }),
  field("caller_context", "context_value", "Caller number", { contextPath: "caller.from_number" }),
  field("ready_badge", "badge", "Ready", { props: { text: "Ready for Success", size: "lg", color: "#2563eb" } }),
  dataField("confirmation_notes", "textarea", "Confirmation notes", "confirmation_notes"),
  field("button_contact_upsert", "button", "Create/update contact", { props: { variant: "primary", dataActionFlowId: FORM_DATA_ACTION_FLOW_IDS.contactUpsert, dataActionLabel: "Contacts create/update from form" } }),
];

const leadFields = [
  field("hero_lead", "hero", "Lead qualification", { props: { quote: "DISCOVERY", title: "Qualify demand while the conversation is warm", description: "Capture fit, urgency, budget, and next step with a polished sales layout.", align: "left", padding: "xl", imageUrl: MEDIA.leadHero.url, imageTitle: MEDIA.leadHero.title, imageMode: "background", imageScale: 115 } }),
  field("lead_grid", "grid", "Qualification grid", { props: { columns: 2, rows: 2, gap: 16, padding: "lg", borderWidth: 1, borderColor: "#bfdbfe", cells: { "0:0": ["lead_company", "lead_contact"], "0:1": ["lead_value_card"], "1:0": ["lead_pain"], "1:1": ["lead_next_step"] }, layoutByChild: { lead_value_card: { columnSpan: 1, rowSpan: 2 } } } }),
  dataField("lead_company", "text", "Company", "company_name", { required: true }),
  dataField("lead_contact", "text", "Contact", "contact_name", { required: true }),
  field("lead_value_card", "card", "Qualification", { props: { title: "Deal profile", description: "Fit and timing signals", padding: "md", children: ["deal_size", "timeline", "budget_confirmed"] } }),
  dataField("deal_size", "select", "Estimated value", "estimated_value", { options: [option("< $10k", "under_10k"), option("$10k-$50k", "10k_50k"), option("$50k-$250k", "50k_250k"), option("$250k+", "250k_plus")] }),
  dataField("timeline", "radio", "Timeline", "buying_timeline", { options: [option("Now"), option("This quarter"), option("6+ months"), option("Researching")] }),
  dataField("budget_confirmed", "switch", "Budget confirmed", "budget_confirmed", { props: { onText: "Confirmed", offText: "Unknown", switchActiveTrackColor: "#7c3aed" } }),
  dataField("lead_pain", "textarea", "Primary pain", "primary_pain"),
  dataField("lead_next_step", "datetime", "Next meeting", "next_meeting_time", { props: { mode: "datetime" } }),
];

const diagnosticsFields = [
  field("diag_header", "hero", "Technical diagnostics", { props: { quote: "RUNBOOK", title: "Triage technical issues with guided context", description: "Use structured diagnostics, capture environment facts, and search KB articles directly from the form.", align: "left", padding: "lg", imageUrl: MEDIA.supportHero.url, imageTitle: MEDIA.supportHero.title, imageMode: "inline", imageScale: 95 } }),
  field("diag_accordion", "accordion", "Troubleshooting prompts", { props: { type: "single", collapsible: true, variant: "card", padding: "sm", items: [{ title: "Before escalating", content: "Confirm affected service, region, timestamps, request IDs, and whether the issue is reproducible.", defaultOpen: true }, { title: "Useful evidence", content: "Logs, screenshots, call_control_id, SIP trace IDs, and exact error responses." }] } }),
  dataField("service", "select", "Service", "service", { required: true, options: [option("Voice API"), option("Messaging"), option("Verify"), option("Portal"), option("Networking")] }),
  dataField("severity", "radio", "Severity", "severity", { options: [option("Low"), option("Medium"), option("High"), option("Critical")] }),
  dataField("request_id", "text", "Request/call ID", "request_id", { placeholder: "call_control_id, message_id, request_id" }),
  dataField("issue_summary", "textarea", "Issue summary", "issue_summary", { required: true }),
  dataField("article_search", "text", "KB search", "kb_query", { placeholder: "e.g. webhook signature, AMD, SIP 403" }),
  field("button_diag_kb", "button", "Find matching article", { props: { variant: "secondary", dataActionFlowId: FORM_DATA_ACTION_FLOW_IDS.kbLookup, dataActionLabel: "KB Articles lookup from form" } }),
];

const escalationFields = [
  field("esc_hero", "hero", "Escalation command center", { props: { quote: "PRIORITY WORKFLOW", title: "Turn messy escalations into structured action", description: "A multi-page workflow form with nested layout, operational context, evidence, hidden IDs, and a task-creation data action.", align: "left", padding: "xl", imageUrl: MEDIA.escalationHero.url, imageTitle: MEDIA.escalationHero.title, imageMode: "background", imageScale: 120 } }),
  field("esc_stats", "stats", "Escalation stats", { props: { padding: "sm", items: [{ title: "15m", description: "Target first response", icon: "IconClock", iconColor: "#2563eb" }, { title: "3", description: "Required evidence points", icon: "IconClipboardCheck", iconColor: "#16a34a" }, { title: "P1", description: "Critical route available", icon: "IconAlertTriangle", iconColor: "#dc2626" }] } }),
  field("esc_grid", "grid", "Customer and issue", { props: { columns: 3, rows: 2, gap: 16, padding: "lg", borderWidth: 1, borderColor: "#cbd5e1", cells: { "0:0": ["esc_customer_card"], "0:1": ["esc_issue_card"], "0:2": ["esc_status_card"], "1:0": ["esc_evidence"], "1:1": [], "1:2": [] }, layoutByChild: { esc_evidence: { columnSpan: 3, rowSpan: 1 } } } }),
  field("esc_customer_card", "card", "Customer", { props: { title: "Customer", description: "Who is impacted?", padding: "md", children: ["esc_customer_name", "esc_customer_email", "esc_account_id"] } }),
  dataField("esc_customer_name", "text", "Customer name", "customer_name", { required: true }),
  dataField("esc_customer_email", "text", "Email", "customer_email"),
  dataField("esc_account_id", "text", "Account ID", "account_id"),
  field("esc_issue_card", "card", "Issue", { props: { title: "Issue profile", description: "Impact and category", padding: "md", children: ["esc_category", "esc_priority", "esc_business_impact"] } }),
  dataField("esc_category", "select", "Category", "category", { options: [option("Voice"), option("Messaging"), option("Billing"), option("Portal"), option("Other")] }),
  dataField("esc_priority", "radio", "Priority", "priority", { required: true, options: [option("P1 Critical", "urgent"), option("P2 High", "high"), option("P3 Normal", "medium"), option("P4 Low", "low")] }),
  dataField("esc_business_impact", "slider", "Business impact", "business_impact", { defaultValue: 75, props: { min: 0, max: 100, step: 5, sliderRangeColor: "#dc2626", sliderThumbColor: "#b91c1c", sliderTrackColor: "#fee2e2" } }),
  field("esc_status_card", "card", "Status", { props: { title: "Status", description: "Routing details", padding: "md", children: ["esc_acknowledged", "esc_due_at", "esc_badge"] } }),
  dataField("esc_acknowledged", "switch", "Customer acknowledged SLA", "sla_acknowledged", { props: { onText: "Acknowledged", offText: "Pending", switchActiveTrackColor: "#16a34a" } }),
  dataField("esc_due_at", "datetime", "Target resolution", "target_resolution_time", { props: { mode: "datetime" } }),
  field("esc_badge", "badge", "Escalation", { props: { text: "Task action enabled", size: "lg", color: "#dc2626" } }),
  dataField("esc_evidence", "textarea", "Evidence and timeline", "evidence", { required: true, placeholder: "Symptoms, timestamps, IDs, reproduction steps, customer quote" }),
  field("esc_guidance", "accordion", "Guidance", { props: { type: "multiple", variant: "card", padding: "md", items: [{ title: "What makes this P1?", content: "Customer production outage, safety risk, regulatory exposure, or broad service impact.", defaultOpen: true }, { title: "Minimum evidence", content: "At least one customer quote, one technical identifier, and a timestamped reproduction or monitor event." }] } }),
  field("esc_payload", "codeblock", "Payload example", { props: { language: "json", showLineNumbers: true, maxHeight: 260, padding: "md", code: JSON.stringify({ customer_name: "Acme Corp", priority: "p1", evidence: "call_control_id=...", action: "create_task" }, null, 2) } }),
  dataField("esc_interaction_id", "hidden", "Interaction ID", "interaction_id", { defaultValue: "{{interaction.id}}" }),
  field("esc_actions", "flex", "Actions", { props: { direction: "row", wrap: true, gap: 12, justify: "flex-end", padding: "md", children: ["button_create_task", "button_search_kb"] } }),
  field("button_create_task", "button", "Create escalation task", { props: { variant: "primary", dataActionFlowId: FORM_DATA_ACTION_FLOW_IDS.taskCreate, dataActionLabel: "Tasks create from form" } }),
  field("button_search_kb", "button", "Search KB", { props: { variant: "secondary", dataActionFlowId: FORM_DATA_ACTION_FLOW_IDS.kbLookup, dataActionLabel: "KB Articles lookup from form" } }),
];

const handoffFields = [
  field("handoff_label", "badge", "AI Assist", { props: { text: "AI handoff", variant: "secondary", size: "lg", color: "#7c3aed" } }),
  field("caller", "context_value", "Caller", { contextPath: "caller.from_number" }),
  dataField("ai_summary", "textarea", "AI summary", "ai_summary", { required: true }),
  dataField("detected_intent", "text", "Detected intent", "detected_intent"),
  dataField("sentiment", "select", "Sentiment", "sentiment", { options: [option("Positive"), option("Neutral"), option("Frustrated"), option("Escalated")] }),
  dataField("agent_reviewed", "checkbox", "Agent reviewed and corrected this summary", "agent_reviewed", { required: true }),
];

export const FORM_TEMPLATES = [
  template("support-contact-consent", "Support contact + consent", "Simple single-page support intake with consent capture and a KB lookup action.", "Support", contactConsentFields, { queue_names: ["Support"], showNavigationButtons: false, theme: { primary: "#2563eb", pageTabActiveBorderColor: "#2563eb" } }),
  template("marketing-consent-center", "Marketing consent center", "Compact compliance template for channel preferences and audit notes.", "Compliance", consentCenterFields, { showNavigationButtons: false, theme: { primary: "#16a34a", pageTabActiveBorderColor: "#16a34a" } }),
  template("callback-appointment-booking", "Callback appointment booking", "Medium-light scheduling card with date/time, channel, urgency, and notes.", "Scheduling", appointmentFields, { showNavigationButtons: false, theme: { primary: "#f97316", pageTabActiveBorderColor: "#f97316" } }),
  template("customer-onboarding-welcome", "Customer onboarding welcome", "Polished three-page onboarding form with hero, avatar, badge, switch, slider, datetime, and contact data action.", "Customer Success", onboardingFields, { queue_names: ["Customer Success"], pages: [{ id: "welcome", title: "Welcome", icon: "IconSparkles", fields: ["hero_onboarding", "welcome_card"] }, { id: "profile", title: "Profile", icon: "IconBuilding", fields: ["company_name", "contact_name", "contact_email", "company_size", "plan", "enable_sms_updates", "success_target", "onboarding_datetime"] }, { id: "confirm", title: "Confirm", icon: "IconCircleCheck", fields: ["caller_context", "ready_badge", "confirmation_notes", "button_contact_upsert"] }], theme: { primary: "#2563eb", pageTabActiveBorderColor: "#2563eb" } }),
  template("lead-qualification-studio", "Lead qualification studio", "Sales discovery template with hero image, grid layout, deal profile card, and qualification signals.", "Sales", leadFields, { queue_names: ["Sales"], theme: { primary: "#7c3aed", pageTabActiveBorderColor: "#7c3aed" } }),
  template("technical-support-diagnostics", "Technical support diagnostics", "Runbook-style diagnostics form with accordion guidance and KB lookup button.", "Support", diagnosticsFields, { queue_names: ["Support"], theme: { primary: "#0891b2", pageTabActiveBorderColor: "#0891b2" } }),
  template("customer-escalation-workflow", "Customer escalation workflow", "Complex multi-page escalation form using nested grid/cards/flex, stats, accordion, code block, hidden field, images, and data actions.", "Operations", escalationFields, { queue_names: ["Escalations"], pages: [{ id: "overview", title: "Overview", icon: "IconDashboard", fields: ["esc_hero", "esc_stats"] }, { id: "details", title: "Details", icon: "IconClipboardList", fields: ["esc_grid"] }, { id: "guidance", title: "Guidance", icon: "IconLifebuoy", fields: ["esc_guidance", "esc_payload", "esc_interaction_id"] }, { id: "submit", title: "Submit", icon: "IconSend", fields: ["esc_actions"] }], theme: { primary: "#dc2626", pageTabActiveBorderColor: "#dc2626" } }),
  template("ai-handoff-summary-review", "AI handoff summary review", "Review an AI-generated handoff before transferring to a human agent.", "AI Assist", handoffFields, { auto_open: true, showNavigationButtons: false, theme: { primary: "#7c3aed", pageTabActiveBorderColor: "#7c3aed" } }),
];

function node(id, type, label, x, y, config = {}) {
  return { id, type: "voiceNode", position: { x, y }, data: { label, nodeType: type, config } };
}

function edge(id, source, target, sourceHandle = "0") {
  return { id, source, target, sourceHandle, targetHandle: null, type: "smoothstep" };
}

export const FORM_DATA_ACTION_FLOWS = [
  {
    id: FORM_DATA_ACTION_FLOW_IDS.kbLookup,
    username: "system",
    name: "Form Submit · KB Articles lookup",
    description: "Sample data action: reads KB Articles using the submitted kb_query/search field and returns a form status.",
    nodes: [
      node("form_submit", "form_submit", "Form Submit", 0, 80, { description: "Search KB Articles from a submitted form", payloadVariable: "form_payload" }),
      node("kb_lookup", "data_action", "Search KB Articles", 320, 80, { dataSource: "kb_articles", action: "list", queryParams: { q: "{{form_payload.variables.kb_query}}", status: "Published", pageSize: "5" }, responseVariable: "kb_articles_result" }),
      node("kb_status", "form_submit_status", "Return KB result status", 680, 80, { status: "success", message: "KB lookup completed. Check the data action response for matching articles.", responseVariable: "form_submit_status" }),
    ],
    edges: [edge("form_submit-kb_lookup", "form_submit", "kb_lookup"), edge("kb_lookup-kb_status", "kb_lookup", "kb_status", "0")],
    variables: {},
    metadata: { seed: true, formDataAction: true, dataSource: "kb_articles", action: "list" },
  },
  {
    id: FORM_DATA_ACTION_FLOW_IDS.contactUpsert,
    username: "system",
    name: "Form Submit · Contacts create/update",
    description: "Sample data action: creates a contact from submitted onboarding/contact fields.",
    nodes: [
      node("form_submit", "form_submit", "Form Submit", 0, 80, { description: "Create/update a contact from submitted form data", payloadVariable: "form_payload" }),
      node("contact_create", "data_action", "Create contact", 320, 80, { dataSource: "contacts", action: "create", fields: { display_name: "{{form_payload.variables.contact_name}}", company_name: "{{form_payload.variables.company_name}}", email_address_1: "{{form_payload.variables.contact_email}}", phone: "{{form_payload.variables.callback_phone}}", notes: "Onboarding plan: {{form_payload.variables.plan}}. Notes: {{form_payload.variables.confirmation_notes}}" }, responseVariable: "contact_result" }),
      node("contact_status", "form_submit_status", "Return contact status", 680, 80, { status: "success", message: "Contact data action completed.", responseVariable: "form_submit_status" }),
    ],
    edges: [edge("form_submit-contact_create", "form_submit", "contact_create"), edge("contact_create-contact_status", "contact_create", "contact_status", "0")],
    variables: {},
    metadata: { seed: true, formDataAction: true, dataSource: "contacts", action: "create" },
  },
  {
    id: FORM_DATA_ACTION_FLOW_IDS.taskCreate,
    username: "system",
    name: "Form Submit · Tasks create escalation",
    description: "Sample data action: creates a task from escalation form data and returns a form status.",
    nodes: [
      node("form_submit", "form_submit", "Form Submit", 0, 80, { description: "Create a task from escalation form data", payloadVariable: "form_payload" }),
      node("task_create", "data_action", "Create task", 320, 80, { dataSource: "tasks", action: "create", fields: { title: "Escalation: {{form_payload.variables.customer_name}} - {{form_payload.variables.category}}", description: "Priority: {{form_payload.variables.priority}}\nImpact: {{form_payload.variables.business_impact}}\nEvidence: {{form_payload.variables.evidence}}", task_type: "escalation", status: "open", priority: "{{form_payload.variables.priority}}", caller_name: "{{form_payload.variables.customer_name}}", caller_email: "{{form_payload.variables.customer_email}}", metadata: { source: "form_builder_seed", interaction_id: "{{form_payload.variables.interaction_id}}" } }, responseVariable: "task_result" }),
      node("task_status", "form_submit_status", "Return task status", 680, 80, { status: "success", message: "Escalation task created from form data.", responseVariable: "form_submit_status" }),
    ],
    edges: [edge("form_submit-task_create", "form_submit", "task_create"), edge("task_create-task_status", "task_create", "task_status", "0")],
    variables: {},
    metadata: { seed: true, formDataAction: true, dataSource: "tasks", action: "create" },
  },
];

export function getFormTemplates() {
  return FORM_TEMPLATES.map((tpl) => normalizeFormDefinition(tpl));
}

export function getFormTemplateMediaAssets() {
  return FORM_TEMPLATE_MEDIA_ASSETS.map((asset) => ({ ...asset, metadata: { ...(asset.metadata || {}), formTemplateSeed: true } }));
}

export function getFormDataActionFlows() {
  return FORM_DATA_ACTION_FLOWS.map((flow) => ({ ...flow, nodes: flow.nodes.map((node) => ({ ...node })), edges: flow.edges.map((edge) => ({ ...edge })) }));
}
