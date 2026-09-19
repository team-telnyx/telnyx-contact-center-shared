// Quality evidence is bounded and selected by work episode; no drafts or later replies.
export async function readMessageTranscript(db, workItemId) {
  const rows = (
    await db.query(
      `SELECT m.sender_role,m.body,m.created_at,e.status FROM acd_messages m
    LEFT JOIN cc_email_messages e ON e.message_id=m.id WHERE m.work_item_id=$1 ORDER BY m.seq LIMIT 501`,
      [workItemId],
    )
  ).rows;
  if (!rows.length)
    throw Object.assign(new Error("No conversation evidence to evaluate"), {
      status: 422,
    });
  const text = rows
    .map(
      (row) =>
        `[${new Date(row.created_at).toISOString()}] ${row.sender_role}${row.status ? " (" + row.status + ")" : ""}: ${row.body}`,
    )
    .join("\n\n");
  if (rows.length > 500 || text.length > 100000)
    throw Object.assign(
      new Error(
        "This conversation exceeds the automatic evaluation limit. Review it manually.",
      ),
      { status: 422 },
    );
  return {
    text,
    details: {
      source: "messaging",
      model: null,
      messageCount: rows.length,
      workItemId,
    },
  };
}
