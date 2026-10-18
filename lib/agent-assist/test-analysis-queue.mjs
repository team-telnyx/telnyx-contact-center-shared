/**
 * Test AI Agent analysis queue.
 *
 * A sequential FIFO of conversation lines (chat messages or voice transcript
 * items) waiting for workflow slot analysis. The module is pure: it knows
 * nothing about React or fetch. The caller injects `analyze` and receives the
 * merged workflow state through `onUpdate`.
 *
 * Why it exists (the internal documentation,
 * section 3.1): the page used to analyse messages inside a `useEffect` keyed
 * on the `messages` array. React ran the effect's cleanup whenever a new
 * message arrived while an analysis was still in flight, the finished result
 * was discarded, but the message had already been marked as analysed. Every
 * customer answer whose analysis took longer than the assistant's reply was
 * lost. Here a new line only ever appends to the queue; nothing that is
 * already queued or in flight is cancelled by it.
 *
 * Semantics (mirroring the agent desktop, lib/stores/workflow-store.js):
 * - one line is analysed at a time, in arrival order;
 * - each job carries the last `contextLines` final lines that preceded it,
 *   speaker-labelled, so bare answers ("Around 85 euros") can be attributed
 *   to the agent's question;
 * - `completed` and `suggested` updates are both applied to item statuses;
 *   a suggestion never downgrades an item that is already completed, except
 *   a caller correction (`is_correction`), which reopens it for review while
 *   `slotsFilled` keeps the old value until the new one is confirmed;
 * - `slotsFilled` is merged (never replaced), so an older response cannot
 *   wipe a slot a newer one already filled;
 * - `idle()` resolves once the queue is empty and nothing is in flight, so a
 *   driver loop can await analysis instead of polling.
 */

export const DEFAULT_CONTEXT_LINES = 4;
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Map a chat role or transcript track to the analyzer's speaker vocabulary.
 * @param {string} roleOrSpeaker "user" | "assistant" | "customer" | "agent" | "inbound" | "outbound"
 * @returns {"customer"|"agent"|null}
 */
export function toAnalysisSpeaker(roleOrSpeaker) {
  switch (roleOrSpeaker) {
    case "user":
    case "customer":
    case "inbound":
      return "customer";
    case "assistant":
    case "agent":
    case "outbound":
      return "agent";
    default:
      return null;
  }
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Normalise a page message / transcript item into a queue line.
 * Returns null for lines that must not be analysed (system notes, empty text,
 * unknown speakers).
 */
export function toAnalysisLine(message) {
  if (!message || typeof message !== "object") return null;
  const speaker = toAnalysisSpeaker(message.speaker ?? message.role);
  if (!speaker) return null;
  const text = typeof message.content === "string" ? message.content : message.text;
  if (!hasText(text)) return null;
  const id = message.id === undefined || message.id === null ? null : String(message.id);
  return { id, speaker, text: text.trim() };
}

/**
 * Pure reducer: apply one analyze-test response to the workflow state.
 *
 * @param {{ itemStatuses: object, slotsFilled: object }} state
 * @param {{ updates?: Array<object>, slotsFilled?: object }} result
 * @returns {{ itemStatuses: object, slotsFilled: object, changed: boolean }}
 */
export function applyAnalysisResult(state, result) {
  const itemStatuses = { ...(state?.itemStatuses || {}) };
  const slotsFilled = { ...(state?.slotsFilled || {}) };
  let changed = false;

  for (const update of Array.isArray(result?.updates) ? result.updates : []) {
    if (!update || !update.item_id) continue;
    const previous = itemStatuses[update.item_id];

    if (update.status === "pending" || update.cleared_reason) {
      // The analyzer un-collected an item (a correction that duplicated
      // another slot, for example). Reopen it so the checklist un-crosses it.
      itemStatuses[update.item_id] = {
        status: "pending",
        extracted_value: null,
        value: null,
        confidence_score: null,
        low_confidence: false,
        is_correction: false,
        alternatives: [],
        source_text: null,
      };
      changed = true;
      continue;
    }

    if (update.status === "completed") {
      itemStatuses[update.item_id] = {
        status: "completed",
        extracted_value: update.extracted_value,
        value: update.extracted_value,
        confidence_score: update.confidence,
        confidence_threshold: update.confidence_threshold,
        low_confidence: false,
        is_correction: false,
        alternatives: [],
        source_text: update.source_text ?? null,
      };
      changed = true;
      continue;
    }

    if (update.status === "suggested") {
      // A below-threshold extraction. Shown to the tester (amber, with the
      // confidence) but never counted as completed and never written to
      // slotsFilled: the route only adds completed values there, and the
      // simulated caller must keep answering until the value is confirmed.
      // A caller correction of a completed slot (analyze-test returns it as
      // `suggested` with `is_correction`, an earlier fix) is the one suggestion that
      // replaces a completed status: it reopens the item for review. The old
      // value stays in slotsFilled until the correction is confirmed.
      const isCorrection = update.is_correction === true;
      if (previous?.status === "completed" && !isCorrection) continue;
      itemStatuses[update.item_id] = {
        status: "suggested",
        extracted_value: update.extracted_value,
        value: update.extracted_value,
        confidence_score: update.confidence,
        confidence_threshold: update.confidence_threshold,
        low_confidence: update.low_confidence === true,
        is_correction: isCorrection,
        alternatives: Array.isArray(update.alternatives) ? update.alternatives : [],
        source_text: update.source_text ?? null,
      };
      changed = true;
    }
  }

  if (result?.slotsFilled && typeof result.slotsFilled === "object") {
    for (const [slot, value] of Object.entries(result.slotsFilled)) {
      if (slotsFilled[slot] !== value) {
        slotsFilled[slot] = value;
        changed = true;
      }
    }
  }

  return { itemStatuses, slotsFilled, changed };
}

/**
 * @typedef {object} TestAnalysisJob
 * @property {string} messageId
 * @property {string} transcript
 * @property {"customer"|"agent"} speaker
 * @property {Array<{speaker: "customer"|"agent", text: string}>} recentContext
 * @property {object} itemStatuses  snapshot sent to the analyzer
 * @property {object} slotsFilled   snapshot sent to the analyzer
 * @property {AbortSignal} signal   aborted by `reset()`
 */

/**
 * Create a queue.
 *
 * @param {object} options
 * @param {(job: TestAnalysisJob) => Promise<{updates?: Array<object>, slotsFilled?: object}>} options.analyze
 * @param {(event: {itemStatuses: object, slotsFilled: object, message: object, result: object, changed: boolean}) => void} [options.onUpdate]
 * @param {(error: Error, job: TestAnalysisJob) => void} [options.onError]
 * @param {(busy: boolean) => void} [options.onBusyChange]
 * @param {number} [options.contextLines=4]
 * @param {number} [options.maxAttempts=2]
 */
export function createTestAnalysisQueue({
  analyze,
  onUpdate,
  onError,
  onBusyChange,
  contextLines = DEFAULT_CONTEXT_LINES,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  if (typeof analyze !== "function") {
    throw new TypeError("createTestAnalysisQueue requires an analyze(job) function");
  }

  let queue = [];
  let history = []; // every accepted line, in order: { id, speaker, text }
  let seenIds = new Set();
  let state = { itemStatuses: {}, slotsFilled: {} };
  let running = false;
  let busy = false;
  let generation = 0;
  let anonymousCounter = 0;
  let inFlight = null; // { controller, generation }
  let idleWaiters = [];

  const setBusy = (next) => {
    if (busy === next) return;
    busy = next;
    try {
      onBusyChange?.(next);
    } catch (err) {
      onError?.(err, null);
    }
  };

  const resolveIdle = () => {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const isIdle = () => !running && queue.length === 0;

  async function runJob(job) {
    const controller = new AbortController();
    const jobGeneration = generation;
    inFlight = { controller, generation: jobGeneration };
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
      try {
        result = await analyze({ ...job, signal: controller.signal });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (jobGeneration !== generation || controller.signal.aborted) break;
      }
    }
    inFlight = null;
    if (jobGeneration !== generation) return; // reset() happened: discard
    if (lastError) {
      onError?.(lastError, job);
      return;
    }
    const next = applyAnalysisResult(state, result || {});
    state = { itemStatuses: next.itemStatuses, slotsFilled: next.slotsFilled };
    try {
      onUpdate?.({
        itemStatuses: state.itemStatuses,
        slotsFilled: state.slotsFilled,
        message: job.message,
        result: result || {},
        changed: next.changed,
      });
    } catch (err) {
      onError?.(err, job);
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    setBusy(true);
    try {
      while (queue.length > 0) {
        const job = queue.shift();
        await runJob(job);
      }
    } finally {
      running = false;
      setBusy(false);
      if (queue.length === 0) resolveIdle();
      else void drain();
    }
  }

  function enqueue(message) {
    const line = toAnalysisLine(message);
    if (!line) return false;
    const id = line.id ?? `anonymous-${(anonymousCounter += 1)}`;
    if (seenIds.has(id)) return false;
    seenIds.add(id);

    const recentContext = history
      .slice(-Math.max(0, contextLines))
      .map(({ speaker, text }) => ({ speaker, text }));
    history.push({ id, speaker: line.speaker, text: line.text });

    queue.push({
      messageId: id,
      message,
      transcript: line.text,
      speaker: line.speaker,
      recentContext,
      get itemStatuses() {
        return { ...state.itemStatuses };
      },
      get slotsFilled() {
        return { ...state.slotsFilled };
      },
    });
    void drain();
    return true;
  }

  function sync(messages) {
    let added = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
      if (enqueue(message)) added += 1;
    }
    return added;
  }

  function idle() {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  function reset() {
    generation += 1;
    queue = [];
    history = [];
    seenIds = new Set();
    state = { itemStatuses: {}, slotsFilled: {} };
    if (inFlight) {
      try {
        inFlight.controller.abort(new Error("Test analysis queue reset"));
      } catch {
        // AbortController.abort never throws in practice; keep reset total.
      }
    }
    resolveIdle();
    if (!running) setBusy(false);
  }

  return {
    enqueue,
    sync,
    idle,
    reset,
    isBusy: () => running,
    size: () => queue.length,
    getState: () => ({
      itemStatuses: { ...state.itemStatuses },
      slotsFilled: { ...state.slotsFilled },
    }),
    getHistory: () => history.map((line) => ({ ...line })),
  };
}
