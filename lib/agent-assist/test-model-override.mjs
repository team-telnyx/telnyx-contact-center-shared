// Per-test model override for the workflow "Test AI Agent" page.
//
// The page lets the operator pick, for one test run, the model used for slot
// analysis and for the simulated caller, from the same Telnyx catalogue as
// Admin → AI Copilot. The workflow's saved model is never changed. The server
// accepts only a model id that is in that catalogue (or the workflow's own
// model), so a request cannot route traffic to an arbitrary model string.

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class TestModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "TestModelError";
    this.status = 400;
  }
}

/**
 * @param {unknown} requested  model id from the request body (optional)
 * @param {{ workflowModel?: string|null, loadCatalog: () => Promise<{models?: {id: string}[]}> }} options
 * @returns {Promise<{ model: string|null, source: "workflow"|"test" }>}
 *   `model` is null when no override was requested.
 */
export async function resolveTestModel(requested, { workflowModel = null, loadCatalog }) {
  if (requested === undefined || requested === null || requested === "") return { model: null, source: "workflow" };
  if (typeof requested !== "string" || !MODEL_ID.test(requested)) {
    throw new TestModelError("Choose a model from the Telnyx model list.");
  }
  if (workflowModel && requested === workflowModel) return { model: requested, source: "workflow" };
  const catalog = await loadCatalog();
  const ids = new Set((Array.isArray(catalog?.models) ? catalog.models : []).map((model) => model?.id).filter(Boolean));
  // An unavailable catalogue does not block a test: Telnyx still rejects an
  // unknown model id, and the error is shown to the operator.
  if (ids.size && !ids.has(requested)) {
    throw new TestModelError(`The model ${requested} is not in the Telnyx model list.`);
  }
  return { model: requested, source: "test" };
}
