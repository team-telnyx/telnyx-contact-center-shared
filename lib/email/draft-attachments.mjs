import { emailError } from './provider.mjs';

// The caller must obtain work through authorizeInteractionRead first. Drafts
// remain private to live supervisor reads and the currently assigned agent.
export async function readSupervisorDraftAttachment(db, work, { agentId, index, version, draftId='legacy', draftScope='legacy' }) {
  if (!work.can_preview_drafts || work.channel !== 'email' || work.state !== 'active' || work.terminal_at)
    throw emailError('Draft attachment not found', 404);
  if (!/^\d+$/.test(String(index)) || Number(index) >= 20 || !/^[1-9]\d*$/.test(String(version)))
    throw emailError('Draft attachment not found', 404);
  const row = (await db.query(`SELECT d.version::text,d.content->'attachments'->$3::int AS file
    FROM cc_email_drafts d JOIN acd_work_items w ON w.id=d.work_item_id
    WHERE d.work_item_id=$1 AND d.agent_id=$2 AND d.draft_id=$4 AND d.draft_scope=$5 AND w.channel='email' AND w.state='active' AND w.terminal_at IS NULL
      AND EXISTS(SELECT 1 FROM acd_text_assignments a WHERE a.work_item_id=d.work_item_id
        AND a.agent_id=d.agent_id AND a.state='active')`, [work.id, agentId, Number(index), draftId, draftScope])).rows[0];
  if (typeof row?.file?.content !== 'string') throw emailError('Draft attachment not found', 404);
  if (row.version !== String(version)) throw emailError('The draft changed. Close this preview and open the current attachment.', 409);
  return { file: row.file, bytes: Buffer.from(row.file.content, 'base64'), conversationId: work.conversation_id };
}
