/**
 * SLA (Service Level Agreement) Tracker
 * Tracks and calculates SLA compliance metrics for queues
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

/**
 * Record SLA metric for a call
 * @param {string} interactionId - Interaction ID
 * @param {string} queueId - Queue ID
 * @param {number} waitTimeSeconds - Wait time in seconds
 * @param {boolean} answered - Whether the call was answered
 */
export async function recordCallSLA(
  interactionId,
  queueId,
  waitTimeSeconds,
  answered
) {
  try {
    const pool = getPostgresPool();
    if (!pool) return;

    // Get queue configuration
    const queueResult = await pool.query(
      `SELECT sla_answer_threshold_seconds, sla_target_percentage 
       FROM cc_queues WHERE id = $1`,
      [queueId]
    );

    if (!queueResult.rows || queueResult.rows.length === 0) {
      return; // Queue not found
    }

    const queue = queueResult.rows[0];
    const thresholdSeconds = queue.sla_answer_threshold_seconds || 20;
    const withinSLA = waitTimeSeconds <= thresholdSeconds;

    const today = new Date().toISOString().split("T")[0];

    // Upsert daily SLA metrics
    await pool.query(
      `INSERT INTO cc_queue_sla_metrics (
        queue_id, date, total_calls, calls_answered, calls_within_sla,
        calls_abandoned, avg_speed_of_answer_seconds, sla_compliance_percentage
      ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7)
      ON CONFLICT (queue_id, date) DO UPDATE SET
        total_calls = cc_queue_sla_metrics.total_calls + 1,
        calls_answered = cc_queue_sla_metrics.calls_answered + $3,
        calls_within_sla = cc_queue_sla_metrics.calls_within_sla + $4,
        calls_abandoned = cc_queue_sla_metrics.calls_abandoned + $5,
        avg_speed_of_answer_seconds = (
          (cc_queue_sla_metrics.avg_speed_of_answer_seconds * cc_queue_sla_metrics.calls_answered + $6) /
          (cc_queue_sla_metrics.calls_answered + $3)
        ),
        sla_compliance_percentage = (
          (cc_queue_sla_metrics.calls_within_sla + $4)::DECIMAL /
          (cc_queue_sla_metrics.total_calls + 1)::DECIMAL * 100
        ),
        updated_at = NOW()`,
      [
        queueId,
        today,
        answered ? 1 : 0,
        answered && withinSLA ? 1 : 0,
        answered ? 0 : 1,
        waitTimeSeconds,
        answered && withinSLA
          ? ((answered && withinSLA ? 1 : 0) / (answered ? 1 : 0)) * 100
          : 0,
      ]
    );
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }
}

/**
 * Get daily SLA metrics for a queue
 * @param {string} queueId - Queue ID
 * @param {string} date - Date in YYYY-MM-DD format (defaults to today)
 * @returns {Promise<Object|null>} SLA metrics or null
 */
export async function getDailySLAMetrics(queueId, date = null) {
  try {
    const pool = getPostgresPool();
    if (!pool) return null;

    const targetDate = date || new Date().toISOString().split("T")[0];

    const result = await pool.query(
      `SELECT * FROM cc_queue_sla_metrics 
       WHERE queue_id = $1 AND date = $2`,
      [queueId, targetDate]
    );

    return result.rows[0] || null;
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return null;
  }
}

/**
 * Get SLA compliance for a date range
 * @param {string} queueId - Queue ID
 * @param {string} startDate - Start date in YYYY-MM-DD format
 * @param {string} endDate - End date in YYYY-MM-DD format
 * @returns {Promise<Object>} SLA compliance summary
 */
export async function getQueueSLACompliance(queueId, startDate, endDate) {
  try {
    const pool = getPostgresPool();
    if (!pool) return null;

    const result = await pool.query(
      `SELECT 
        SUM(total_calls) as total_calls,
        SUM(calls_answered) as calls_answered,
        SUM(calls_within_sla) as calls_within_sla,
        SUM(calls_abandoned) as calls_abandoned,
        AVG(avg_speed_of_answer_seconds) as avg_speed_of_answer_seconds,
        AVG(sla_compliance_percentage) as avg_sla_compliance_percentage
       FROM cc_queue_sla_metrics
       WHERE queue_id = $1 AND date >= $2 AND date <= $3`,
      [queueId, startDate, endDate]
    );

    return result.rows[0] || null;
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return null;
  }
}

/**
 * Update average handle time for a queue
 * @param {string} queueId - Queue ID
 */
export async function updateAverageHandleTime(queueId) {
  try {
    const pool = getPostgresPool();
    if (!pool) return;

    // Calculate average handle time from recent completed calls (last 100)
    const result = await pool.query(
      `SELECT AVG(handle_time_seconds) as avg_handle_time
       FROM cc_interactions
       WHERE queue_id = $1 
         AND state = 'completed'
         AND handle_time_seconds > 0
         AND completed_at >= NOW() - INTERVAL '7 days'
       ORDER BY completed_at DESC
       LIMIT 100`,
      [queueId]
    );

    const avgHandleTime = result.rows[0]?.avg_handle_time || 180;

    // Update queue with new average handle time
    await pool.query(
      `UPDATE cc_queues 
       SET avg_handle_time_seconds = $1, last_avg_calculated_at = NOW()
       WHERE id = $2`,
      [Math.round(avgHandleTime), queueId]
    );
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
  }
}
