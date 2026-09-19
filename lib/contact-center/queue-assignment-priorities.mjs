// Change priorities without recreating memberships or resetting activation time.
export async function updateAssignmentPriorities(pool, queueId, assignments, { inTransaction = false } = {}) {
  if (!Array.isArray(assignments) || assignments.length === 0 || new Set(assignments.map(a => a?.userId)).size !== assignments.length ||
      assignments.some(a => !a?.userId || !Number.isInteger(a.priority) || a.priority < 1 || a.priority > 5)) {
    throw Object.assign(new Error('assignmentPriorities requires distinct userId and integer priority 1–5'), { status: 400 });
  }
  const ownTransaction = !inTransaction;
  const db = ownTransaction ? await pool.connect() : pool;
  try {
    if (ownTransaction) await db.query('BEGIN');
    const members = await db.query('SELECT user_id FROM cc_queue_user_assignments WHERE queue_id=$1 AND user_id=ANY($2::text[]) FOR UPDATE', [queueId, assignments.map(a=>a.userId)]);
    if (members.rows.length !== assignments.length) throw Object.assign(new Error('Queue assignment not found'), { status: 400 });
    for (const a of assignments) await db.query('UPDATE cc_queue_user_assignments SET priority=$3,updated_at=now() WHERE queue_id=$1 AND user_id=$2', [queueId,a.userId,a.priority]);
    if (ownTransaction) await db.query('COMMIT');
  } catch (error) { if (ownTransaction) await db.query('ROLLBACK'); throw error; } finally { if (ownTransaction) db.release(); }
}
