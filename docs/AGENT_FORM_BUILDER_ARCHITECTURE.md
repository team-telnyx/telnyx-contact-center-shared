# Agent Form Builder — MVP Architecture

Date: 2026-05-02  
Status: first MVP slice implemented

## Product decision

We are building a **custom form builder engine** for the contact-center app. We will not embed Form.io, Puck, Craft.js, GrapesJS, SurveyJS, react-grid-layout, or another ready-made form-builder package.

Forms are canonical JSON definitions that can be edited in two ways from day one:

1. a simple visual builder in the admin UI,
2. AI-generated declarative operations that mutate the same JSON.

AI is allowed to produce only our domain operations / JSON schema changes. It must not generate raw HTML, React, CSS, SQL, or arbitrary JavaScript.

## Data model

Forms are stored in PostgreSQL:

- `form_definitions` — current canonical form definition, status, queue assignment, auto-open flag.
- `form_versions` — immutable snapshots when a form is published.
- `form_submissions` — shared JSONB submission table for all forms.

Submissions intentionally go into one predefined JSONB table. We are not creating separate tables per form in the MVP.

Queue assignment is handled on the form definition with `queue_ids` and `queue_names`. Published forms with no queue assignment are globally available; otherwise the agent desktop filters by the active interaction queue.

## Canonical form JSON

The MVP schema lives in `lib/forms/form-schema.js`:

- supported components: label, text, textarea, select, radio, checkbox, button, image, context_value, hidden,
- `schema.fields[]` is the canonical component list,
- `layout.order[]` controls visual ordering,
- `bindings` maps fields to safe context paths,
- `actions` is reserved for submit / future workflow or webhook actions,
- `theme` is token-based only; no arbitrary CSS strings.

## Runtime context

`lib/forms/form-context.js` builds a safe limited context from `cc_interactions`, including interaction identifiers, queue, caller metadata, routing metadata, selected `client_state` keys, and Agent Assist config.

The renderer receives this context and initial values from `/api/contact-center/forms/[id]/render`.

## APIs

Admin:

- `GET/POST /api/admin/forms`
- `GET/PUT/DELETE /api/admin/forms/[id]` (`DELETE` archives)
- `POST /api/admin/forms/[id]/publish`
- `POST /api/admin/forms/[id]/ai`

Agent desktop:

- `GET /api/contact-center/forms?queueName=&queueId=&formIds=`
- `GET /api/contact-center/forms/[id]/render?interactionId=`
- `GET/POST /api/contact-center/forms/[id]/submissions`

The AI endpoint currently includes a deterministic scaffold unless live Telnyx Chat Completion is explicitly wired and gated. It returns operations plus the resulting validated form and never exposes secrets.

## UI integration

- Admin landing page: `app/(portal)/admin/forms/page.jsx` — card grid with a maximum of three cards per row, compact form thumbnails, status/category/queue badges, and Edit/Publish/Archive actions.
- Custom editor route: `app/(portal)/admin/forms/[id]/page.jsx`
- Puck-like custom shell: `components/forms/FormEditor.jsx` — built with project UI components/Tailwind only, not Puck. It has a top action bar, far-left rail (AI / Blocks / Fields / Outline), switching left panel, central selectable canvas, and right properties panel.
- Legacy/simple builder component: `components/forms/FormBuilder.jsx`
- Runtime renderer: `components/forms/FormRenderer.jsx`
- Agent desktop view: `components/contact-center/AgentFormsView.jsx`
- Data Sources tile: `components/contact-center/AgentDataSources.jsx`
- Agent Assist forms mode: `components/contact-center/InteractionDetail.jsx`
- Agent Assist config editor/schema: `components/voice-flow/AgentAssistNodeEditor.jsx`, `config/voice-flow-nodes.js`

Forms can be opened manually from the Forms tile, filtered by active queue. Agent Assist can also select forms (`assist_type=forms`) so forms auto-open in the interaction detail pane.

The admin editing direction is intentionally **PuckEditor-like but custom**: AI-assisted changes and visual editing operate on the same canonical JSON draft, with explicit add/select/move/duplicate/remove controls in this iteration instead of adding a third-party drag-and-drop form-builder dependency.

## Next steps

1. Replace deterministic AI scaffold with the project-standard Telnyx Chat Completion helper once the model/env contract is settled.
2. Add richer validation types and conditional visibility.
3. Add autosave draft submissions.
4. Add form analytics/export screens over JSONB submissions.
5. Add stronger published-version rendering so historical submissions always use the matching version snapshot.

## Feature slice: AI, templates, media, and layout blocks

- **AI edits** now call Telnyx Chat Completions at `/v2/ai/chat/completions` when `TELNYX_CHAT_API_KEY` or `TELNYX_API_KEY` is configured. The model is controlled by `FORM_BUILDER_AI_MODEL`/`TELNYX_CHAT_MODEL`; the endpoint can be overridden with `TELNYX_CHAT_COMPLETIONS_URL`.
- The AI contract is intentionally narrow: it may return only canonical form operations (`addField`, `updateField`, `removeField`, `moveField`, `addToLayout`, `setBinding`, `setQueueAssignment`, `setDataTargetProposal`). It must not return raw HTML, React, SQL, shell commands, or migrations. If the key is missing or the call fails, the route uses a deterministic fallback operation and reports that clearly.
- **Layout components** are first-class schema field types: `section`, `row`, `columns`, and `grid`. They remain backward-compatible with the existing flat `layout.order` array and render as visual structural blocks in both the builder canvas and runtime renderer.
- **Templates** live in `form_templates` and are seeded by `ensurePostgresSchema()` from `lib/forms/form-templates.js`/`lib/forms/form-builder-seeds.js`. The editor rail includes a Templates panel with 8 polished seeded examples plus seeded Pexels media metadata and 3 Form Submit data-action call flows; selecting one creates a new draft form from the template.
- **Media** is managed through `/api/admin/forms/media`. Uploads are written to `/public/media` using safe generated filenames, a 5MB limit, and image-only content type validation. The editor Media rail lists uploaded images and can add an image block to the current form.
- **Drag and drop** uses `@dnd-kit/core`: Blocks remain clickable, and can also be dragged from the Blocks rail into the canvas droppable area to append a canonical field/layout block.
