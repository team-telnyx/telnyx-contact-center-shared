import { validateSubmissionData } from "./form-schema";
export async function createFormSubmission(pool, { form, data, context, interaction, status = "submitted" }) {
  const validation = validateSubmissionData(form, data || {}); const finalStatus = validation.ok ? status : "draft";
  const { rows } = await pool.query(`INSERT INTO form_submissions (form_id, form_version, interaction_id, call_control_id, call_session_id, queue_name, agent_username, status, data, context_snapshot, validation_errors, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $8 = 'submitted' THEN NOW() ELSE NULL END) RETURNING *`, [form.id, form.version || 1, interaction?.id || null, interaction?.call_control_id || context?.interaction?.call_control_id || null, interaction?.call_session_id || context?.interaction?.call_session_id || null, interaction?.queue_name || context?.interaction?.queue_name || null, interaction?.agent_username || context?.interaction?.agent_username || null, finalStatus, JSON.stringify(data || {}), JSON.stringify(context || {}), JSON.stringify(validation.errors)]);
  return { submission: rows[0], validation };
}
