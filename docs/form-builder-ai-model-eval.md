# Form Builder AI model evaluation

Date: 2026-05-04  
Endpoint: Telnyx Chat Completions `/v2/ai/chat/completions` only. No direct OpenAI API calls were used.

## What was evaluated

The harness in `scripts/test-form-ai-models.mjs` sends the same Form Builder system instructions used by the admin AI route and validates returned operation JSON by:

1. parsing strict JSON,
2. validating operation types,
3. applying operations with `applyFormOperations`,
4. validating/normalizing with the Form Builder schema,
5. auditing variable names, unsupported types, duplicate child roots, image scale bounds, and data-action button wiring.

Prompt levels:

- **Simple**: contact/consent form with text/select/checkbox fields.
- **Medium**: multi-page onboarding form with hero/card/avatar/media/richtext plus radio/select/switch/slider/datetime and page icons/navigation.
- **Complex**: multi-page escalation workflow with nested grid/columns/flex/cards, accordion, stats, badge, images, codeblock, hidden field, many data fields, and data-action button.

Each model was tested with plain `response_format: { type: "json_object" }` and with Telnyx `guided_json` where feasible.

## Summary

| Model | Valid normalized outputs | Unguided valid | Guided valid | Avg. score | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `moonshotai/Kimi-K2.6` | 2/6 | 1/3 | 1/3 | 27 | Simple form succeeded. Medium/complex responses were not parseable JSON despite HTTP 200. |
| `zai-org/GLM-5.1-FP8` | 4/6 | 2/3 | 2/3 | 60 | Simple and medium succeeded. Complex responses became non-JSON/truncated prose. |
| `meta-llama/Llama-3.3-70B-Instruct` | 6/6 | 3/3 | 3/3 | 95 | Most reliable across guided and unguided. Complex form passed with data-action button and no variableName/layout audit errors. |
| `openai/gpt-5.5` | 0/6 | 0/3 | 0/3 | 0 | Blocked: Telnyx returned `model openai/gpt-5.5 could not be found.` |
| `openai/gpt-5.2` | 3/6 | 3/3 | 0/3 | 48 | `json_object` mode produced the highest-quality complex form (61 fields, 5 pages, 2 data-action buttons). Guided mode failed because upstream OpenAI rejected `guided_json`. |

## GPT-5.5 retest addendum (2026-05-04 11:45 CEST)

Retested `openai/gpt-5.5` through Telnyx Chat Completions only using `scripts/test-form-ai-models.mjs --models=openai/gpt-5.5` against the same simple/medium/complex prompts and both `json_object` and `guided_json` modes.

Result: **still unavailable** for this Telnyx account. All 6 calls returned HTTP 404 with the exact error: `model openai/gpt-5.5 could not be found.` Valid outputs: `0/6`, average score: `0`.

Comparison remains unchanged: there is no measurable GPT-5.5 improvement yet because Telnyx does not expose that model identifier here. `meta-llama/Llama-3.3-70B-Instruct` remains the most reliable (`6/6`, avg. `95`), while `openai/gpt-5.2` remains the best GPT-family option observed through Telnyx (`3/6`, avg. `48`, strong unguided `json_object`, unsupported `guided_json`).

## Recommendation

- **Best overall for reliable valid JSON across both modes:** `meta-llama/Llama-3.3-70B-Instruct`.
- **Best quality when using Telnyx `response_format: { type: "json_object" }` without `guided_json`:** `openai/gpt-5.2`.
- Keep the runtime fallback added in the route: try `guided_json`, then retry without it when the provider reports unsupported schema/guided parameters. This is required for OpenAI-hosted models through Telnyx.

## Guided JSON findings

- Telnyx accepts `guided_json` in the Chat Completions schema, but provider support varies by model/backend.
- `meta-llama/Llama-3.3-70B-Instruct` worked with and without `guided_json`.
- Kimi and GLM did not error on `guided_json`, but the harder prompts still returned invalid JSON content.
- `openai/gpt-5.2` returned HTTP 422 with: `From Openai's API: Unknown parameter: 'guided_json'.` The production route now retries with `response_format: { type: "json_object" }` only for these cases.

## Notable blockers/errors

- `openai/gpt-5.5` is unavailable for this Telnyx account. Telnyx model listing showed `openai/gpt-5`, `openai/gpt-5.1`, and `openai/gpt-5.2`; `openai/gpt-5.2` was evaluated as the available GPT-5-family replacement.
- Kimi medium/complex and GLM complex failed JSON parsing even though the HTTP request succeeded.
- No secrets or raw model responses are committed; detailed local JSON results were written under `tmp/` during evaluation and are intentionally excluded from this report.
