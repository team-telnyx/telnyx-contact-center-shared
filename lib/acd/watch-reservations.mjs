// Keep Core capacity mutations behind the ACD boundary. The Watch session
// remains the source of evidence for whether an uncertain dial is finished.
export async function activateWatchReservation(db, id) {
  await db.query("UPDATE acd_reservations SET state='active' WHERE id=$1 AND purpose='watch_outbound'", [id]);
}

export async function releaseWatchReservation(pool, id, confirmed = false) {
await pool.query(`UPDATE acd_reservations r SET state='released',released_at=now(),released_reason='watch_call_ended'
        FROM watch_audio_sessions s WHERE r.id=s.id AND s.id=$1 AND r.purpose='watch_outbound'
        AND ($2 OR s.dial_started_at IS NULL OR s.call_state='ended' OR s.expires_at<now())`,[id,confirmed]);
}
