// Ghost Call Cleanup - Detects and fixes interactions left in incorrect states after crashes
// This runs on backend startup to clean up "ghost calls" that may appear in supervisor monitoring

import { getPostgresPool } from "@/lib/postgres.mjs";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { PgDb } from "@/lib/pgdb.js";

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

// Active states that should be checked
const ACTIVE_STATES = [
  "queued",
  "ringing",
  "answered",
  "connected",
  "active",
  "bridging",
  "hold",
  "transferring",
];

// Maximum age for an active interaction before marking as stale (2 hours)
const MAX_ACTIVE_AGE_HOURS = 2;

// Maximum talk time for a call before marking as stale (1 hour)
// Calls answered for longer than this are considered ghost calls
const MAX_TALK_TIME_HOURS = 1;

// Maximum talk time to record when cleaning up ghost calls (2 hours)
// Prevents reporting unrealistic talk times for calls that have been stuck for days
const MAX_RECORDED_TALK_TIME_HOURS = 2;

/**
 * Check if a call is still active via Telnyx API
 * @param {string} callControlId - The call control ID to check
 * @returns {Promise<{exists: boolean|null, isActive: boolean|null, state?: string}>}
 */
async function checkCallStatus(callControlId) {
  if (!callControlId || !TELNYX_API_KEY) {
    return { exists: false, isActive: false };
  }

  try {
    const url = buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}`);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      // 404 means call doesn't exist
      if (response.status === 404) {
        return { exists: false, isActive: false };
      }
      // Other errors - log but assume call might still exist
      console.warn(
        `[GhostCallCleanup] Failed to check call ${callControlId}: ${response.status}`,
      );
      return { exists: null, isActive: null }; // Unknown
    }

    const data = await response.json();
    const callData = data.data || data;
    const state = callData.state || callData.status || "unknown";
    const isAlive = callData.is_alive !== false; // Default to true if not specified

    // Check if call is in a terminal state
    const isTerminal = [
      "hangup",
      "ended",
      "destroy",
      "idle",
      "terminated",
      "completed",
      "abandoned",
    ].includes(state?.toLowerCase());

    return {
      exists: true,
      isActive: isAlive && !isTerminal,
      state: state,
    };
  } catch (error) {
    console.error(
      `[GhostCallCleanup] Error checking call ${callControlId}:`,
      error.message,
    );
    return { exists: null, isActive: null }; // Unknown - don't update
  }
}

/**
 * Clean up ghost calls - mark inactive calls as abandoned/completed
 * @returns {Promise<{cleaned: number, skipped: number, errors: number}>}
 */
export async function cleanupGhostCalls() {
  const pool = getPostgresPool();
  if (!pool) {
    console.warn(
      "[GhostCallCleanup] PostgreSQL not configured, skipping cleanup",
    );
    return { cleaned: 0, errors: 0, skipped: 0 };
  }

  if (!TELNYX_API_KEY) {
    console.warn(
      "[GhostCallCleanup] TELNYX_API_KEY not configured, skipping cleanup",
    );
    return { cleaned: 0, errors: 0, skipped: 0 };
  }

  try {
    console.log("[GhostCallCleanup] Starting ghost call cleanup...");

    // Find all interactions in active states that don't have completed_at or abandoned_at
    const maxAge = new Date();
    maxAge.setHours(maxAge.getHours() - MAX_ACTIVE_AGE_HOURS);

    // Calculate max answered age for talk time check
    const maxAnsweredAge = new Date();
    maxAnsweredAge.setHours(maxAnsweredAge.getHours() - MAX_TALK_TIME_HOURS);

    const query = `
      SELECT 
        id, 
        call_control_id, 
        state, 
        answered_at, 
        enqueued_at,
        created_at,
        updated_at
      FROM cc_interactions
      WHERE state = ANY($1::text[])
        AND completed_at IS NULL
        AND abandoned_at IS NULL
        AND (
          call_control_id IS NOT NULL 
          OR created_at < $2
          OR (answered_at IS NOT NULL AND answered_at < $3)
        )
      ORDER BY created_at ASC
    `;

    const result = await pool.query(query, [
      ACTIVE_STATES,
      maxAge.toISOString(),
      maxAnsweredAge.toISOString(),
    ]);
    const interactions = result.rows || [];

    console.log(
      `[GhostCallCleanup] Found ${interactions.length} potentially stale interactions`,
    );

    let cleaned = 0;
    let errors = 0;
    let skipped = 0;

    // Track statistics for detailed logging
    const statsByOriginalState = {};
    const statsByReason = {
      stale: 0,
      callNotFound: 0,
      callInactive: 0,
      noCallControlId: 0,
      excessiveTalkTime: 0,
      excessiveTalkTimeApiUnknown: 0,
    };
    const statsByFinalState = {
      completed: 0,
      abandoned: 0,
    };

    // Process in batches to avoid overwhelming the API
    const BATCH_SIZE = 10;
    for (let i = 0; i < interactions.length; i += BATCH_SIZE) {
      const batch = interactions.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (interaction) => {
          try {
            let shouldClean = false;
            let finalState = "abandoned";
            const now = new Date().toISOString();

            // Track original state for statistics
            const originalState = interaction.state || "unknown";
            if (!statsByOriginalState[originalState]) {
              statsByOriginalState[originalState] = 0;
            }

            // Check if interaction is too old (stale)
            const createdAt = new Date(interaction.created_at);
            const ageHours =
              (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);

            // Check if call has been answered for too long (ghost call indicator)
            let answeredDurationHours = 0;
            if (interaction.answered_at) {
              const answeredAt = new Date(interaction.answered_at);
              answeredDurationHours =
                (Date.now() - answeredAt.getTime()) / (1000 * 60 * 60);
            }

            let cleanupReason = null;

            // Priority 1: Check if call has been answered for too long (strongest indicator of ghost call)
            if (
              interaction.answered_at &&
              answeredDurationHours > MAX_TALK_TIME_HOURS
            ) {
              shouldClean = true;
              finalState = "completed";
              cleanupReason = "excessiveTalkTime";
              console.log(
                `[GhostCallCleanup] Marking interaction ${interaction.id} (state: ${originalState}) as completed due to excessive talk time (${answeredDurationHours.toFixed(1)}h)`,
              );
            } else if (ageHours > MAX_ACTIVE_AGE_HOURS) {
              // Priority 2: Check if interaction is too old (stale)
              shouldClean = true;
              finalState = interaction.answered_at ? "completed" : "abandoned";
              cleanupReason = interaction.call_control_id
                ? "stale"
                : "noCallControlId";
              console.log(
                `[GhostCallCleanup] Marking stale interaction ${interaction.id} (state: ${originalState}) as ${finalState} (age: ${ageHours.toFixed(1)}h)`,
              );
            } else if (interaction.call_control_id) {
              // Check Telnyx API if call_control_id exists
              const callStatus = await checkCallStatus(
                interaction.call_control_id,
              );

              if (callStatus.exists === false) {
                // Call doesn't exist in Telnyx - mark as abandoned/completed
                shouldClean = true;
                finalState = interaction.answered_at
                  ? "completed"
                  : "abandoned";
                cleanupReason = "callNotFound";
                console.log(
                  `[GhostCallCleanup] Call ${interaction.call_control_id} not found, marking interaction ${interaction.id} (state: ${originalState}) as ${finalState}`,
                );
              } else if (
                callStatus.exists === true &&
                callStatus.isActive === false
              ) {
                // Call exists but is not active - mark as completed
                shouldClean = true;
                finalState = interaction.answered_at
                  ? "completed"
                  : "abandoned";
                cleanupReason = "callInactive";
                console.log(
                  `[GhostCallCleanup] Call ${interaction.call_control_id} is inactive (state: ${callStatus.state}), marking interaction ${interaction.id} (state: ${originalState}) as ${finalState}`,
                );
              } else if (
                callStatus.exists === null ||
                callStatus.isActive === null
              ) {
                // API check failed or returned unknown - check if call has been answered too long
                if (
                  interaction.answered_at &&
                  answeredDurationHours > MAX_TALK_TIME_HOURS
                ) {
                  // Even if API check failed, if call has been answered for too long, clean it up
                  shouldClean = true;
                  finalState = "completed";
                  cleanupReason = "excessiveTalkTimeApiUnknown";
                  console.log(
                    `[GhostCallCleanup] Marking interaction ${interaction.id} (state: ${originalState}) as completed due to excessive talk time (${answeredDurationHours.toFixed(1)}h) despite API check failure`,
                  );
                } else {
                  // Call is still active or status unknown - skip
                  skipped++;
                }
              } else {
                // Call is still active - skip
                skipped++;
              }
            } else {
              // No call_control_id - can't verify, but if it's old enough, mark as stale
              if (ageHours > MAX_ACTIVE_AGE_HOURS) {
                shouldClean = true;
                finalState = interaction.answered_at
                  ? "completed"
                  : "abandoned";
                cleanupReason = "noCallControlId";
                console.log(
                  `[GhostCallCleanup] Interaction ${interaction.id} (state: ${originalState}) has no call_control_id and is stale, marking as ${finalState}`,
                );
              } else {
                skipped++;
              }
            }

            if (shouldClean) {
              // Calculate times if needed
              const updates = {
                state: finalState,
              };

              if (finalState === "completed") {
                updates.completedAt = now;
                // Calculate handle/talk time if answered_at exists
                if (interaction.answered_at) {
                  const answeredAt = new Date(interaction.answered_at);
                  const completedAt = new Date(now);
                  let talkTimeSeconds = Math.floor(
                    (completedAt - answeredAt) / 1000,
                  );

                  // Cap talk time at reasonable maximum to avoid reporting unrealistic values
                  // for calls that have been stuck for days
                  const maxTalkTimeSeconds =
                    MAX_RECORDED_TALK_TIME_HOURS * 60 * 60;
                  if (talkTimeSeconds > maxTalkTimeSeconds) {
                    console.log(
                      `[GhostCallCleanup] Capping talk time for interaction ${interaction.id} from ${talkTimeSeconds}s to ${maxTalkTimeSeconds}s`,
                    );
                    talkTimeSeconds = maxTalkTimeSeconds;
                  }

                  updates.talkTimeSeconds = Math.max(0, talkTimeSeconds);

                  if (interaction.enqueued_at) {
                    const enqueuedAt = new Date(interaction.enqueued_at);
                    const waitTimeSeconds = Math.floor(
                      (answeredAt - enqueuedAt) / 1000,
                    );
                    updates.waitTimeSeconds = Math.max(0, waitTimeSeconds);
                    updates.handleTimeSeconds =
                      updates.waitTimeSeconds + updates.talkTimeSeconds;
                  } else {
                    updates.handleTimeSeconds = updates.talkTimeSeconds;
                  }
                }
              } else {
                updates.abandonedAt = now;
                // Calculate wait time if enqueued_at exists
                if (interaction.enqueued_at) {
                  const enqueuedAt = new Date(interaction.enqueued_at);
                  const abandonedAt = new Date(now);
                  updates.waitTimeSeconds = Math.floor(
                    (abandonedAt - enqueuedAt) / 1000,
                  );
                }
              }

              await PgDb.updateInteractionById(interaction.id, updates);
              cleaned++;

              // Update statistics
              statsByOriginalState[originalState]++;
              if (cleanupReason) {
                statsByReason[cleanupReason]++;
              }
              statsByFinalState[finalState]++;

              // Update state manager if needed
              try {
                const { completeCall } =
                  await import("@/lib/contact-center/state-manager.js");
                completeCall(interaction.id, now, finalState === "abandoned");
              } catch (stateError) {
                // State manager update is optional
                console.warn(
                  `[GhostCallCleanup] Failed to update state manager for ${interaction.id}:`,
                  stateError.message,
                );
              }
            }
          } catch (error) {
            console.error(
              `[GhostCallCleanup] Error processing interaction ${interaction.id}:`,
              error,
            );
            errors++;
          }
        }),
      );

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < interactions.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Build detailed summary message
    const summaryLines = [
      `[GhostCallCleanup] Cleanup complete: ${cleaned} records cleaned up, ${skipped} skipped, ${errors} errors`,
    ];

    if (cleaned > 0) {
      summaryLines.push(
        `[GhostCallCleanup] Records cleaned up by original incorrect state:`,
      );
      Object.entries(statsByOriginalState)
        .sort((a, b) => b[1] - a[1])
        .forEach(([state, count]) => {
          summaryLines.push(`  - ${state}: ${count} record(s)`);
        });

      summaryLines.push(`[GhostCallCleanup] Records cleaned up by reason:`);
      Object.entries(statsByReason)
        .filter(([, count]) => count > 0)
        .forEach(([reason, count]) => {
          const reasonLabel =
            reason === "stale"
              ? "Stale (older than 2 hours)"
              : reason === "callNotFound"
                ? "Call not found in Telnyx"
                : reason === "callInactive"
                  ? "Call inactive in Telnyx"
                  : reason === "excessiveTalkTime"
                    ? "Excessive talk time (>1 hour)"
                    : reason === "excessiveTalkTimeApiUnknown"
                      ? "Excessive talk time (>1 hour, API check failed)"
                      : "No call_control_id (stale)";
          summaryLines.push(`  - ${reasonLabel}: ${count} record(s)`);
        });

      summaryLines.push(
        `[GhostCallCleanup] Records cleaned up by final state:`,
      );
      Object.entries(statsByFinalState)
        .filter(([, count]) => count > 0)
        .forEach(([state, count]) => {
          summaryLines.push(`  - ${state}: ${count} record(s)`);
        });
    }

    console.log(summaryLines.join("\n"));

    return {
      cleaned,
      skipped,
      errors,
      statsByOriginalState,
      statsByReason,
      statsByFinalState,
    };
  } catch (error) {
    console.error("[GhostCallCleanup] Fatal error during cleanup:", error);
    return { cleaned: 0, errors: 1, skipped: 0 };
  }
}
