import { normalizeFormDefinition, slugifyFormName } from "./form-schema";

function field(id, type, label, extra = {}) {
  return { id, type, label, required: false, placeholder: "", ...extra };
}

function template(slug, name, description, category, fields, extra = {}) {
  return normalizeFormDefinition({
    id: slug,
    slug,
    name,
    description,
    category,
    status: "template",
    version: 1,
    schema: { fields },
    layout: { order: fields.map((f) => f.id) },
    theme: { density: "comfortable" },
    bindings: extra.bindings || {},
    actions: [{ type: "submit", label: "Save" }],
    queue_ids: [],
    queue_names: extra.queue_names || [],
    auto_open: Boolean(extra.auto_open),
  });
}

export const FORM_TEMPLATES = [
  template("customer-verification", "Customer verification", "Confirm identity before account changes or sensitive support actions.", "Verification", [
    field("section_identity", "section", "Identity check", { helpText: "Ask only what is needed for the policy." }),
    field("customer_name", "text", "Customer name", { required: true, placeholder: "Full name" }),
    field("phone_number", "text", "Verified phone number", { required: true, placeholder: "+1..." }),
    field("account_last4", "text", "Account last 4", { placeholder: "Last four digits" }),
    field("verification_result", "select", "Verification result", { required: true, options: ["Verified", "Partial match", "Failed"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("notes", "textarea", "Verification notes"),
  ]),
  template("sales-lead-capture", "Sales lead capture", "Capture qualification notes and next steps for a prospective customer.", "Sales", [
    field("section_lead", "section", "Lead details"),
    field("company", "text", "Company", { required: true }),
    field("contact_name", "text", "Contact name", { required: true }),
    field("email", "text", "Email", { required: true, placeholder: "name@example.com" }),
    field("use_case", "textarea", "Use case"),
    field("timeline", "select", "Buying timeline", { options: ["Now", "This quarter", "6+ months", "Researching"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("next_step", "text", "Next step"),
  ], { queue_names: ["Sales"] }),
  template("support-ticket", "Support ticket", "Create a structured support case from a call or chat.", "Support", [
    field("section_issue", "section", "Issue summary"),
    field("customer", "text", "Customer / account", { required: true }),
    field("issue_type", "select", "Issue type", { options: ["Billing", "Technical", "Porting", "Messaging", "Voice"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("priority", "radio", "Priority", { required: true, options: ["Low", "Normal", "High", "Urgent"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("description", "textarea", "Description", { required: true }),
    field("requested_resolution", "textarea", "Requested resolution"),
  ], { queue_names: ["Support"] }),
  template("appointment-booking", "Appointment booking", "Schedule a callback or service appointment.", "Scheduling", [
    field("section_booking", "section", "Booking request"),
    field("customer_name", "text", "Customer name", { required: true }),
    field("contact_phone", "text", "Contact phone", { required: true }),
    field("preferred_date", "text", "Preferred date"),
    field("preferred_window", "select", "Preferred time window", { options: ["Morning", "Afternoon", "Evening"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("appointment_reason", "textarea", "Reason"),
  ]),
  template("marketing-consent", "Marketing consent", "Record opt-in/out and channel preferences.", "Compliance", [
    field("section_consent", "section", "Consent capture"),
    field("customer_name", "text", "Customer name", { required: true }),
    field("email", "text", "Email"),
    field("sms_number", "text", "SMS number"),
    field("consent", "radio", "Consent decision", { required: true, options: ["Opt in", "Opt out"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("channels", "textarea", "Allowed channels / notes"),
  ]),
  template("payment-callback-request", "Payment callback request", "Collect safe details for a billing callback without storing card data.", "Billing", [
    field("section_payment", "section", "Callback details"),
    field("customer_name", "text", "Customer name", { required: true }),
    field("callback_number", "text", "Callback number", { required: true }),
    field("billing_account", "text", "Billing account reference"),
    field("amount_context", "text", "Amount/context"),
    field("safe_note", "label", "Do not enter card numbers or CVV in this form."),
    field("agent_notes", "textarea", "Agent notes"),
  ], { queue_names: ["Billing"] }),
  template("order-status", "Order status", "Track order lookup details and customer-facing status.", "Operations", [
    field("section_order", "section", "Order lookup"),
    field("order_id", "text", "Order ID", { required: true }),
    field("customer_name", "text", "Customer name"),
    field("status", "select", "Current status", { options: ["New", "Processing", "Shipped", "Delayed", "Delivered"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("eta", "text", "ETA"),
    field("follow_up", "checkbox", "Follow up needed", { placeholder: "Create follow-up task" }),
  ]),
  template("complaint-intake", "Complaint intake", "Capture complaint category, severity, and requested resolution.", "Quality", [
    field("section_complaint", "section", "Complaint details"),
    field("customer_name", "text", "Customer name", { required: true }),
    field("category", "select", "Category", { required: true, options: ["Service", "Billing", "Agent conduct", "Product", "Other"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("severity", "radio", "Severity", { options: ["Low", "Medium", "High"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("summary", "textarea", "Complaint summary", { required: true }),
    field("requested_resolution", "textarea", "Requested resolution"),
  ]),
  template("ai-handoff-summary-review", "AI handoff summary review", "Review an AI-generated handoff before transferring to a human agent.", "AI Assist", [
    field("section_handoff", "section", "Handoff summary"),
    field("caller", "context_value", "Caller", { contextPath: "caller.from_number" }),
    field("ai_summary", "textarea", "AI summary", { required: true }),
    field("intent", "text", "Detected intent"),
    field("sentiment", "select", "Sentiment", { options: ["Positive", "Neutral", "Frustrated", "Escalated"].map((x) => ({ label: x, value: slugifyFormName(x) })) }),
    field("agent_reviewed", "checkbox", "Agent reviewed", { required: true, placeholder: "I reviewed and corrected this summary" }),
  ], { auto_open: true }),
];

export function getFormTemplates() {
  return FORM_TEMPLATES.map((tpl) => normalizeFormDefinition(tpl));
}
