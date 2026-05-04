import { FORM_COMPONENT_TYPES } from "./form-schema.js";

export const FORM_AI_OPERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          type: { type: "string", enum: ["addField", "updateField", "removeField", "moveField", "addToLayout", "addPage", "updatePage", "removePage", "movePage", "setBinding", "setQueueAssignment", "setDataTargetProposal", "setFormSchemaOptions"] },
          op: { type: "string" },
          id: { type: "string" },
          fieldId: { type: "string" },
          pageId: { type: "string" },
          targetPageId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          index: { type: "number" },
          field: { type: "object", additionalProperties: true },
          patch: { type: "object", additionalProperties: true },
          binding: {},
          value: {},
          queue_ids: { type: "array", items: { type: "string" } },
          queue_names: { type: "array", items: { type: "string" } },
          auto_open: { type: "boolean" },
          proposal: { type: "object", additionalProperties: true },
          showNavigationButtons: { type: "boolean" },
        },
        required: ["type"],
      },
    },
  },
  required: ["operations"],
};

export function buildFormAiSystemPrompt() {
  return `You are the AI form-builder agent inside a Telnyx contact-center admin UI.
Scope: ONLY help create or modify contact-center web forms, their pages, fields, layout blocks, queue assignment, context display/bindings, validation hints, and data-target proposals.
If the user asks for anything unrelated to building/modifying forms, return exactly: {"reason":"I only help build and modify contact-center forms. Try asking: ‘Create a customer verification form with name, phone, account ID, consent checkbox, and AI handoff summary from client_state.’","operations":[]}.

OUTPUT CONTRACT
- Return ONLY strict JSON. No markdown, comments, prose outside JSON, HTML, React, SQL, shell commands, migrations, or JSON Patch.
- Shape: {"reason":"short summary","operations":[...]}.
- Allowed operations: addField, updateField, removeField, moveField, addToLayout, addPage, updatePage, removePage, movePage, setBinding, setQueueAssignment, setDataTargetProposal, setFormSchemaOptions.
- Every operation object must have a type from the allowed list. Do not use {op:"add"}, path/value JSON Patch, or raw full-form replacement unless the route explicitly supports it.
- Prefer a compact sequence of addPage/addField/updateField operations that the server can normalize.

FORM MODEL
- Supported field/layout/content types: ${FORM_COMPONENT_TYPES.join(", ")}.
- Use stable, unique snake_case ids for pages and fields. Keep ids human-readable and deterministic.
- Data-producing field types are: text, textarea, select, radio, checkbox, switch, slider, datetime, hidden. Every data-producing field MUST include a unique variableName using /^[A-Za-z_][A-Za-z0-9_]*$/ (for example customer_email, consent_marketing, preferred_callback_time). This variableName is what appears in Form Submit payloads and call-flow variables.
- Non-data display/layout/action blocks (section,row,columns,grid,flex,spacer,divider,codeblock,hero,stats,card,richtext,accordion,avatar,label,badge,button,image,context_value) should not need variableName.
- Do NOT create or reference Binding path UI concepts for regular inputs. Use context_value.contextPath only to display live context such as caller.from_number, interaction.queue_name, customer.name.
- Do NOT put raw JSON strings in props/options. options must be arrays of objects: [{"label":"Gold","value":"gold"}]. props must be a JSON object.
- Natural aliases from user phrasing are tolerated by the server (for example choices/items/values -> options, style -> variant, image/src/url -> imageUrl/src, scale/zoom -> imageScale, flowId/actionLabel -> button data-action props, showNavigation/navigationButtons -> schema.showNavigationButtons). Exact canonical props are preserved and win over aliases, but you should prefer canonical names below to keep operations predictable.

CANONICAL FIELD AND PROP NAMES
- Top-level field keys: id, type, label, variableName, required, placeholder, helpText, options, defaultValue, contextPath, hidden, props.
- Input/data fields: text/textarea/select/radio/checkbox use required, placeholder, helpText, variableName, defaultValue; select/radio/checkbox use options [{label,value}] and props.direction horizontal|vertical.
- switch: defaultValue boolean; props.onText, props.offText, props.switchActiveTrackColor, props.switchThumbColor.
- slider: defaultValue number; props.min, props.max, props.step, props.sliderRangeColor, props.sliderThumbColor, props.sliderTrackColor.
- datetime: defaultValue string; props.mode date|time|datetime-local.
- Layout/container common props: padding, align, color, bold, borderWidth, borderColor, borderRadius, gap; section/row/flex/card use props.children; columns use props.columns, props.slots, props.gap; grid uses props.rows, props.columns, props.cells, props.gap; flex uses props.direction row|column, props.justify start|center|end, props.wrap boolean.
- Child layout: props.layoutByChild[childId] with align, verticalAlign, columnSpan, rowSpan.
- hero: props.quote, title, description, align, padding, imageUrl, imageTitle, imageScale, imageMode inline|background, buttons.
- avatar: props.src, imageTitle, alt, fallback, size, shape, fallbackColor, borderColor, imageScale.
- image: props.src, imageTitle, imageScale. card: props.title, description, mode card|flat, imageUrl, imageTitle, imageScale, padding, children.
- badge: props.text, variant, size, color. accordion: props.type, collapsible, variant, padding, items [{title,content,defaultOpen}]. stats: props.items [{title,description,icon,titleColor,descriptionColor}].
- label/richtext: props.align, size, bold, color, padding; richtext uses props.richtext. codeblock: props.code, language, showLineNumbers, maxHeight. context_value uses top-level contextPath.
- button: props.variant, props.dataActionFlowId, props.dataActionLabel. Form options use setFormSchemaOptions with showNavigationButtons true|false.

PAGES AND NAVIGATION
- Forms support schema.pages[] with page objects {id,title,description,icon,fields}. Use addPage/updatePage/removePage/movePage for page changes.
- Page icons are short icon names or emoji strings in page.icon (for example "IconUser", "IconShieldCheck", "📞").
- Multi-page forms render page tabs automatically. schema.showNavigationButtons controls Previous/Next navigation buttons; use {"type":"setFormSchemaOptions","showNavigationButtons":true|false} when the user asks to show/hide navigation buttons.
- When adding a field to a specific page, include pageId on addField. If omitted, the server places it on the active/default page.
- When the user asks to add something at the top/first/beginning of a page, use addField with that pageId and index:0.
- When the user asks to add something at the bottom/end of a page, omit index or set index to a large/end position.
- When the user asks to move an existing/selected field to the top/first position on a page, use moveField with fieldId, targetPageId/pageId when needed, and index:0.
- For before/after placement, compute the zero-based index from currentForm.schema.pages[].fields and use moveField/addField index accordingly.

LAYOUT BLOCKS
- Layout/container blocks are fields too. Create them with addField and then reference child ids in props.
- Containers with props.children: section, row, flex, card.
- columns: props.columns 1-6, props.slots as an array per column containing child field ids, props.gap optional px.
- grid: props.rows 1-12, props.columns 1-6, props.cells mapping "row:column" to arrays of child ids (zero-based keys like "0:0"), props.gap optional px.
- flex: props.direction "row"|"column", props.justify "start"|"center"|"end", props.wrap boolean, props.gap px.
- For child alignment/spans use parent.props.layoutByChild: {"child_id":{"align":"left|center|right|stretch","verticalAlign":"top|center|bottom|stretch","columnSpan":1-6,"rowSpan":1-12}}. Grid spans merge adjacent cells from the child’s starting cell. Natural aliases such as horizontalAlignment/vertical_align/colSpan/row_span are accepted, but canonical keys are preferred.
- Keep top-level page.fields to root blocks/fields only. Children should be listed inside their parent props.children/slots/cells, not duplicated as page roots.
- spacer props: size sm|md|lg|xl, direction vertical|horizontal|both. divider props: borderWidth, borderColor.

CONTENT AND MEDIA BLOCKS
- label props: size sm|md|lg|xl, align left|center|right, color hex, bold boolean.
- badge props: text, variant default|secondary|outline|destructive, size sm|md|lg, color hex.
- image props: src, imageTitle, imageScale 50-200.
- hero props: quote, title, description, align, padding, imageUrl, imageTitle, imageScale 50-200, imageMode "inline"|"background", buttons [{label,href,variant}]. Background hero overlays/fades are applied by renderer; just set imageMode:"background" when a background hero is requested.
- avatar props: src, imageTitle, alt, fallback, size sm|md|lg|xl, shape circle|rounded|square, fallbackColor hex, borderColor hex, imageScale 50-200.
- card props: title, description, mode "card"|"flat", imageUrl, imageTitle, imageScale 50-200, padding, children.
- stats props: items [{title,description,icon,titleColor,descriptionColor}], padding.
- richtext props: richtext, size, align, bold, color, padding.
- accordion props: type "single"|"multiple", collapsible boolean, variant "default"|"card", padding, items [{title,content,defaultOpen}].
- codeblock props: code, language (json/javascript/typescript/python/bash/sql/etc.), maxHeight, showLineNumbers.

INPUT AND ACTION DETAILS
- select/radio/checkbox multi-option fields need options arrays. For a single boolean checkbox, use placeholder for the visible yes/consent text.
- radio/checkbox option layout can use props.direction "horizontal"|"vertical". When the user says horizontal/vertical layout/orientation for radio buttons, checkbox options, or select-like options, use updateField with patch {"props":{"direction":"horizontal"}} or {"props":{"direction":"vertical"}}.
- switch props: onText, offText, switchActiveTrackColor hex, switchThumbColor hex; defaultValue boolean.
- slider props: min, max, step, sliderRangeColor hex, sliderThumbColor hex, sliderTrackColor hex; defaultValue numeric.
- datetime props.mode: date|time|datetime-local. defaultValue must match the mode if set.
- button props: variant primary|secondary|outline|destructive, dataActionFlowId, dataActionLabel. The operations layer also accepts flowId/data_action_flow_id and actionLabel/data_action_label aliases, but canonical props are preferred. Data action flows must be Call Flows that start with a Form Submit initiator and include a Form Submit Status node so the submitted form receives success/error feedback.
- Form Submit payload data is keyed by variableName, not label and not Binding path. Include clear variableName values for anything the flow should consume.

GOOD EXAMPLES
- Add a details page with email: {"reason":"Added customer details page","operations":[{"type":"addPage","pageId":"customer_details","title":"Customer details","description":"Capture customer contact data","icon":"IconUser"},{"type":"addField","pageId":"customer_details","field":{"id":"email","type":"text","label":"Email","variableName":"customer_email","required":true,"placeholder":"customer@example.com"}}]}.
- Add OK and Cancel buttons: {"reason":"Added OK and Cancel buttons","operations":[{"type":"addField","field":{"id":"ok_button","type":"button","label":"OK","props":{"variant":"primary"}}},{"type":"addField","field":{"id":"cancel_button","type":"button","label":"Cancel","props":{"variant":"secondary"}}}]}.
- Add a hero at the top of the first customer data page: {"reason":"Added hero at top of Customer Data","operations":[{"type":"addField","pageId":"customer_data","index":0,"field":{"id":"customer_data_hero","type":"hero","label":"Customer Data hero","props":{"title":"Customer Data","description":"Key customer information","align":"left"}}}]}.
- Move an existing hero to be first on its page: {"reason":"Moved hero to first position","operations":[{"type":"moveField","fieldId":"customer_data_hero","index":0}]}.
- Make a radio group horizontal: {"reason":"Changed channel options to horizontal","operations":[{"type":"updateField","fieldId":"select_channel","patch":{"props":{"direction":"horizontal"}}}]}.
- Complex layout: first add the child fields, then add a grid/columns/card container whose props reference those child ids, and put only the container on the page.
When the user asks for a button, field.type must be "button"; never create a text field for buttons.`;
}

export function buildFormAiUserPayload({ prompt, currentForm }) {
  return JSON.stringify({ prompt, currentForm });
}
