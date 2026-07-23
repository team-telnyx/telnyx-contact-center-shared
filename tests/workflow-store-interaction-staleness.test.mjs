import assert from "node:assert/strict";
import test from "node:test";

// fetchSession/startWorkflow build a URL against window.location.origin.
global.window = { location: { origin: "http://localhost" } };

import useWorkflowStore from "../lib/stores/workflow-store.js";

function resetWorkflowStore() {
  useWorkflowStore.setState({
    activeInteractionId: null,
    session: null,
    workflowName: null,
    workflowCategory: null,
    stages: [],
    currentStageIndex: 0,
    itemStatuses: {},
    slotsFilled: {},
    totalItems: 0,
    completedItems: 0,
    skippedItems: 0,
    completionPercentage: 0,
    isLoading: false,
    isAnalyzing: false,
    _analyzingCount: 0,
    error: null,
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function mockJsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test("a late-arriving fetchSession response for a PREVIOUS interaction does not repopulate a newer call's cleared session", async () => {
  resetWorkflowStore();
  const store = useWorkflowStore.getState();

  const callADeferred = createDeferred();
  const callBDeferred = createDeferred();
  let fetchCallCount = 0;
  global.fetch = () => {
    fetchCallCount += 1;
    return fetchCallCount === 1 ? callADeferred.promise : callBDeferred.promise;
  };

  // Call A's session fetch goes out first but is slow (simulating network delay).
  const fetchAPromise = store.fetchSession("interaction-A");

  // Call A ends; Call B starts — mirrors what AgentAssistWorkflow's effect does
  // on every new interactionId.
  store.clearSession("interaction-B");
  const fetchBPromise = store.fetchSession("interaction-B");

  // Call B's request resolves quickly with its own, different data.
  callBDeferred.resolve(
    mockJsonResponse({
      session: {
        id: "session-B",
        interaction_id: "interaction-B",
        slots_filled: { patient_name: "Bob" },
      },
    })
  );
  await fetchBPromise;

  // Call A's slow response FINALLY arrives, carrying Call A's own (now stale) data.
  callADeferred.resolve(
    mockJsonResponse({
      session: {
        id: "session-A",
        interaction_id: "interaction-A",
        slots_filled: { patient_name: "Alice (stale)" },
      },
    })
  );
  await fetchAPromise;

  const state = useWorkflowStore.getState();
  assert.equal(state.session.id, "session-B");
  assert.deepEqual(state.slotsFilled, { patient_name: "Bob" });
});

test("a late-arriving analyzeTranscript response for a PREVIOUS interaction does not merge stale slots into a newer call", async () => {
  resetWorkflowStore();
  useWorkflowStore.setState({
    activeInteractionId: "interaction-A",
    session: { id: "session-A", interaction_id: "interaction-A" },
    slotsFilled: {},
  });
  const store = useWorkflowStore.getState();

  const analyzeDeferred = createDeferred();
  global.fetch = () => analyzeDeferred.promise;

  // Call A speaks; the analyze request is slow.
  const analyzePromise = store.analyzeTranscript("some transcript", "customer");

  // Call A ends, Call B starts with its own session before the analyze response lands.
  useWorkflowStore.setState({
    activeInteractionId: "interaction-B",
    session: { id: "session-B", interaction_id: "interaction-B" },
    slotsFilled: { patient_name: "Bob" },
  });

  // Call A's analyze response finally arrives, carrying Call A's extracted slots.
  analyzeDeferred.resolve(
    mockJsonResponse({
      updates: [],
      slotsFilled: { patient_name: "Alice (stale)", pickup_department: "ICU (stale)" },
      completionPercentage: 50,
    })
  );
  await analyzePromise;

  const state = useWorkflowStore.getState();
  assert.deepEqual(state.slotsFilled, { patient_name: "Bob" });
});

test("startWorkflow recovers from a 409 by fetching the session that already exists, instead of erroring", async () => {
  resetWorkflowStore();
  const store = useWorkflowStore.getState();

  let fetchCallCount = 0;
  global.fetch = (url, opts) => {
    fetchCallCount += 1;
    if (fetchCallCount === 1) {
      // The /start POST loses the race and gets a 409.
      return Promise.resolve(
        mockJsonResponse(
          { error: "Workflow session already exists for this interaction" },
          { ok: false, status: 409 }
        )
      );
    }
    // The store's recovery path calls fetchSession, which GETs the session.
    return Promise.resolve(
      mockJsonResponse({
        session: { id: "session-recovered", interaction_id: "interaction-A" },
        slots_filled: {},
      })
    );
  };

  const result = await store.startWorkflow("interaction-A", "workflow-1");

  assert.equal(result.id, "session-recovered");
  assert.equal(useWorkflowStore.getState().session.id, "session-recovered");
  assert.equal(useWorkflowStore.getState().error, null);
});

test("isAnalyzing stays true while ANY of several parallel analyzeTranscript calls is still in flight", async () => {
  resetWorkflowStore();
  useWorkflowStore.setState({
    activeInteractionId: "interaction-A",
    session: { id: "session-A", interaction_id: "interaction-A" },
  });
  const store = useWorkflowStore.getState();

  const deferredA = createDeferred();
  const deferredB = createDeferred();
  let fetchCallCount = 0;
  global.fetch = () => {
    fetchCallCount += 1;
    return fetchCallCount === 1 ? deferredA.promise : deferredB.promise;
  };

  // Two utterances analyzed in parallel (the fix under test) rather than
  // sequentially — this is exactly what AgentAssistWorkflow's Promise.all does.
  const p1 = store.analyzeTranscript("first utterance", "customer");
  const p2 = store.analyzeTranscript("second utterance", "customer");

  assert.equal(useWorkflowStore.getState().isAnalyzing, true);

  // The FIRST of the two calls finishes. A naive boolean would flip
  // isAnalyzing to false here even though the second call is still running.
  deferredA.resolve(mockJsonResponse({ updates: [], slotsFilled: {} }));
  await p1;
  assert.equal(
    useWorkflowStore.getState().isAnalyzing,
    true,
    "isAnalyzing must stay true while the second call is still in flight"
  );

  // Now the second (last) call finishes too.
  deferredB.resolve(mockJsonResponse({ updates: [], slotsFilled: {} }));
  await p2;
  assert.equal(useWorkflowStore.getState().isAnalyzing, false);
});
