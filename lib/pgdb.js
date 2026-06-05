import { getPostgresPool } from "./postgres.mjs";
import { randomUUID } from "crypto";

function nowIso() {
  return new Date().toISOString();
}

export const PgDb = {
  async upsertUserByUsername(username, fields) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = fields?.id || randomUUID();
    // Handle roles - use roles array exclusively
    const roles = fields.roles
      ? Array.isArray(fields.roles)
        ? fields.roles
        : [fields.roles]
      : ["agent"];

    const q = `
      INSERT INTO users (
        id, username, first_name, last_name, nick, language, theme, mobile,
        sms_number, voice_number, roles, verified, auth_strategy,
        refresh_tokens, telephony_credentials_id, telephony_user_name, reset_password_token,
        reset_password_token_expires, activation_token, activation_token_expires,
        profile_picture_uri, hash, salt, iterations, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23, $24, $25, $26
      )
      ON CONFLICT (username) DO UPDATE SET
        first_name=EXCLUDED.first_name,
        last_name=EXCLUDED.last_name,
        nick=EXCLUDED.nick,
        language=EXCLUDED.language,
        theme=EXCLUDED.theme,
        mobile=EXCLUDED.mobile,
        sms_number=EXCLUDED.sms_number,
        voice_number=EXCLUDED.voice_number,
        roles=EXCLUDED.roles,
        verified=EXCLUDED.verified,
        auth_strategy=EXCLUDED.auth_strategy,
        refresh_tokens=EXCLUDED.refresh_tokens,
        telephony_credentials_id=EXCLUDED.telephony_credentials_id,
        telephony_user_name=EXCLUDED.telephony_user_name,
        reset_password_token=EXCLUDED.reset_password_token,
        reset_password_token_expires=EXCLUDED.reset_password_token_expires,
        activation_token=EXCLUDED.activation_token,
        activation_token_expires=EXCLUDED.activation_token_expires,
        profile_picture_uri=EXCLUDED.profile_picture_uri,
        hash=EXCLUDED.hash,
        salt=EXCLUDED.salt,
        iterations=EXCLUDED.iterations,
        updated_at=EXCLUDED.updated_at
      RETURNING id;
    `;
    const vals = [
      id,
      username,
      fields.firstName || null,
      fields.lastName || null,
      fields.nick || null,
      fields.language || "en-US",
      fields.theme || "system",
      fields.mobile || null,
      fields.smsNumber || "Telnyx",
      fields.voiceNumber || null,
      roles,
      Boolean(fields.verified),
      fields.authStrategy || "local",
      fields.refreshToken ? JSON.stringify(fields.refreshToken) : null,
      fields.telephonyCredentialsId || null,
      fields.telephonyUserName || null,
      fields.resetPasswordToken || null,
      fields.resetPasswordTokenExpires || null,
      fields.activationToken || null,
      fields.activationTokenExpires || null,
      fields.profilePictureUri || null,
      fields.hash || null,
      fields.salt || null,
      typeof fields.iterations === "number" ? fields.iterations : 25000,
      nowIso(),
      nowIso(),
    ];
    const r = await pool.query(q, vals);
    const userId = r.rows?.[0]?.id || id;
    const { ensureAgentStatusState } = await import(
      "@/lib/contact-center/user-status"
    );
    await ensureAgentStatusState({
      userId: String(userId),
      username,
      status: fields.status || "Available",
    });
    return userId;
  },

  async listLanguages() {
    const pool = getPostgresPool();
    if (!pool) return [];
    const r = await pool.query(
      "SELECT id, language, value, flag, microsoft_voice, google_voice, amazon_voice, prompt_main_menu, prompt_wait, prompt_transfer, prompt_bot, prompt_disconnect, prompt_no_answer, prompt_enqueued, prompt_voicemail, prompt_ivr_error, prompt_bye FROM languages ORDER BY language ASC",
    );
    return r.rows || [];
  },

  async findUserByUsername(username) {
    const pool = getPostgresPool();
    if (!pool) return null;
    const r = await pool.query("SELECT * FROM users WHERE username=$1", [
      username,
    ]);
    return r.rows?.[0] || null;
  },

  async findUserById(id) {
    const pool = getPostgresPool();
    if (!pool) return null;
    // Ensure ID is a string for consistent comparison
    const idStr = String(id);
    const r = await pool.query("SELECT * FROM users WHERE id=$1", [idStr]);
    return r.rows?.[0] || null;
  },

  async updateUserById(id, set) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    if (!id) {
      throw new Error("User ID is required for update");
    }

    if (!set || Object.keys(set).length === 0) {
      return true;
    }

    const fields = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(set)) {
      // Skip undefined values
      if (v === undefined) continue;

      const col =
        k === "firstName"
          ? "first_name"
          : k === "lastName"
            ? "last_name"
            : k === "profilePictureUri"
              ? "profile_picture_uri"
              : k === "smsNumber"
                ? "sms_number"
                : k === "voiceNumber"
                  ? "voice_number"
                  : k === "refreshTokens"
                    ? "refresh_tokens"
                    : k === "telephonyCredentialsId"
                      ? "telephony_credentials_id"
                      : k === "telephonyUserName"
                        ? "telephony_user_name"
                        : k;
      fields.push(`${col}=$${i++}`);

      // Handle JSON columns - need to stringify arrays/objects
      if (k === "refresh_tokens" || k === "refreshTokens") {
        values.push(v ? JSON.stringify(v) : null);
      } else if (k === "roles" && Array.isArray(v)) {
        // Handle roles array
        values.push(v);
      } else if (k === "skills") {
        // Handle skills JSONB - can be string or object
        if (typeof v === "string") {
          values.push(v);
        } else if (v && typeof v === "object") {
          values.push(JSON.stringify(v));
        } else {
          values.push(null);
        }
      } else {
        values.push(v);
      }
    }

    if (fields.length === 0) {
      return true;
    }

    values.push(nowIso());
    // Ensure ID is a string for comparison
    const userIdStr = String(id);
    values.push(userIdStr);
    const q = `UPDATE users SET ${fields.join(", ")}, updated_at=$${
      values.length - 1
    } WHERE id=$${values.length}`;

    // First verify the user exists
    const verifyUser = await pool.query(
      "SELECT id, username FROM users WHERE id=$1",
      [userIdStr],
    );
    if (verifyUser.rows.length === 0) {
      throw new Error(`User not found with ID: ${userIdStr}`);
    }

    const result = await pool.query(q, values);

    if (result.rowCount === 0) {
      throw new Error(`Update failed: No rows matched ID ${userIdStr}`);
    }

    return true;
  },

  async insertMessage(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO messages (
        id, username, channel, direction, status, "to", "from", body, media_urls,
        telnyx_message_id, error_code, error_message, event_id, webhooks, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      ) RETURNING id
    `;
    const vals = [
      id,
      doc.username,
      doc.channel || "SMS",
      doc.direction,
      doc.status || "queued",
      doc.to,
      doc.from,
      doc.body || "",
      JSON.stringify(doc.mediaUrls || []),
      doc.telnyxMessageId || null,
      doc.errorCode || null,
      doc.errorMessage || null,
      doc.eventId || null,
      JSON.stringify(doc.webhooks || []),
      nowIso(),
      nowIso(),
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0]?.id || id;
  },

  async updateMessageById(id, set) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const fields = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(set)) {
      const col =
        k === "telnyxMessageId"
          ? "telnyx_message_id"
          : k === "errorMessage"
            ? "error_message"
            : k === "errorCode"
              ? "error_code"
              : k;
      fields.push(`${col}=$${i++}`);
      values.push(v);
    }
    values.push(nowIso());
    values.push(id);
    const q = `UPDATE messages SET ${fields.join(", ")}, updated_at=$${
      values.length - 1
    } WHERE id=$${values.length}`;
    await pool.query(q, values);
  },

  async updateMessageByTelnyxId(telnyxMessageId, set) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const fields = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(set)) {
      const col =
        k === "telnyxMessageId"
          ? "telnyx_message_id"
          : k === "errorMessage"
            ? "error_message"
            : k === "errorCode"
              ? "error_code"
              : k === "eventId"
                ? "event_id"
                : k;
      fields.push(`${col}=$${i++}`);
      values.push(v);
    }
    values.push(nowIso());
    values.push(telnyxMessageId);
    const q = `UPDATE messages SET ${fields.join(", ")}, updated_at=$${
      values.length - 1
    } WHERE telnyx_message_id=$${values.length}`;
    await pool.query(q, values);
  },

  async findMessages(filter, options = {}) {
    const pool = getPostgresPool();
    if (!pool) return { rows: [], count: 0 };
    const where = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(filter)) {
      if (v == null) continue;
      if (k === "body" && v?.$ilike) {
        where.push(`body ILIKE $${i++}`);
        vals.push(v.$ilike);
      } else if (k === "to") {
        where.push(`"to"=$${i++}`);
        vals.push(v);
      } else if (k === "from") {
        where.push(`"from"=$${i++}`);
        vals.push(v);
      } else {
        const col =
          k === "telnyxMessageId"
            ? "telnyx_message_id"
            : k === "eventId"
              ? "event_id"
              : k;
        where.push(`${col}=$${i++}`);
        vals.push(v);
      }
    }
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize || 20));
    const offset = (page - 1) * pageSize;
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM messages ${whereSql} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    const [rowsRes, countRes] = await Promise.all([
      pool.query(sql, vals),
      pool.query(`SELECT COUNT(*) AS c FROM messages ${whereSql}`, vals),
    ]);
    return {
      rows: rowsRes.rows || [],
      count: Number(countRes.rows?.[0]?.c || 0),
    };
  },

  async insertCall(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    try {
      const id = doc.id || randomUUID();
      const q = `
        INSERT INTO calls (
          id, username, call_control_id, call_leg_id, call_session_id, direction, state,
          "to", "from", start_time, answer_time, end_time, duration_seconds, billable_seconds,
          hangup_cause, hangup_source, client_state, connection_id, is_webrtc,
          error_code, error_message, webhooks, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
        ) RETURNING id
      `;
      const vals = [
        id,
        doc.username,
        doc.callControlId || null,
        doc.callLegId || null,
        doc.callSessionId || null,
        doc.direction || null,
        doc.state || "initiated",
        doc.to || null,
        doc.from || null,
        doc.startTime || null,
        doc.answerTime || null,
        doc.endTime || null,
        doc.durationSeconds || null,
        doc.billableSeconds || null,
        doc.hangupCause || null,
        doc.hangupSource || null,
        doc.clientState ? JSON.stringify(doc.clientState) : null,
        doc.connectionId || null,
        Boolean(doc.isWebrtc),
        doc.errorCode || null,
        doc.errorMessage || null,
        JSON.stringify(doc.webhooks || []),
        nowIso(),
        nowIso(),
      ];
      const r = await pool.query(q, vals);
      return r.rows?.[0]?.id || id;
    } catch (err) {
      // Handle case where calls table doesn't exist (non-critical)
      if (err.code === "42P01") {
        return null;
      }
      throw err;
    }
  },

  async updateCallById(id, set) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const fields = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(set)) {
      const col =
        k === "callControlId"
          ? "call_control_id"
          : k === "callLegId"
            ? "call_leg_id"
            : k === "callSessionId"
              ? "call_session_id"
              : k === "startTime"
                ? "start_time"
                : k === "answerTime"
                  ? "answer_time"
                  : k === "endTime"
                    ? "end_time"
                    : k === "durationSeconds"
                      ? "duration_seconds"
                      : k === "billableSeconds"
                        ? "billable_seconds"
                        : k === "hangupCause"
                          ? "hangup_cause"
                          : k === "hangupSource"
                            ? "hangup_source"
                            : k === "clientState"
                              ? "client_state"
                              : k === "connectionId"
                                ? "connection_id"
                                : k === "isWebrtc"
                                  ? "is_webrtc"
                                  : k === "errorCode"
                                    ? "error_code"
                                    : k === "errorMessage"
                                      ? "error_message"
                                      : k;
      fields.push(`${col}=$${i++}`);
      // Handle JSON columns
      if (k === "clientState" || k === "webhooks") {
        values.push(v ? JSON.stringify(v) : null);
      } else {
        values.push(v);
      }
    }
    values.push(nowIso());
    values.push(id);
    const q = `UPDATE calls SET ${fields.join(", ")}, updated_at=$${
      values.length - 1
    } WHERE id=$${values.length}`;
    await pool.query(q, values);
  },

  async updateCallByCallControlId(callControlId, set) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    try {
      const fields = [];
      const values = [];
      let i = 1;
      for (const [k, v] of Object.entries(set)) {
        const col =
          k === "callControlId"
            ? "call_control_id"
            : k === "callLegId"
              ? "call_leg_id"
              : k === "callSessionId"
                ? "call_session_id"
                : k === "startTime"
                  ? "start_time"
                  : k === "answerTime"
                    ? "answer_time"
                    : k === "endTime"
                      ? "end_time"
                      : k === "durationSeconds"
                        ? "duration_seconds"
                        : k === "billableSeconds"
                          ? "billable_seconds"
                          : k === "hangupCause"
                            ? "hangup_cause"
                            : k === "hangupSource"
                              ? "hangup_source"
                              : k === "clientState"
                                ? "client_state"
                                : k === "connectionId"
                                  ? "connection_id"
                                  : k === "isWebrtc"
                                    ? "is_webrtc"
                                    : k === "errorCode"
                                      ? "error_code"
                                      : k === "errorMessage"
                                        ? "error_message"
                                        : k;
        fields.push(`${col}=$${i++}`);
        // Handle JSON columns
        if (k === "clientState" || k === "webhooks") {
          values.push(v ? JSON.stringify(v) : null);
        } else {
          values.push(v);
        }
      }
      values.push(nowIso());
      values.push(callControlId);
      const q = `UPDATE calls SET ${fields.join(", ")}, updated_at=$${
        values.length - 1
      } WHERE call_control_id=$${values.length}`;
      await pool.query(q, values);
    } catch (err) {
      // Handle case where calls table doesn't exist (non-critical)
      if (err.code === "42P01") {
        return;
      }
      throw err;
    }
  },

  async findCallByCallControlId(callControlId) {
    const pool = getPostgresPool();
    if (!pool) return null;
    try {
      const r = await pool.query(
        "SELECT * FROM calls WHERE call_control_id=$1 LIMIT 1",
        [callControlId],
      );
      return r.rows?.[0] || null;
    } catch (err) {
      // Handle case where calls table doesn't exist (non-critical)
      if (err.code === "42P01") {
        // Table doesn't exist - return null gracefully
        return null;
      }
      throw err;
    }
  },

  async findCalls(filter, options = {}) {
    const pool = getPostgresPool();
    if (!pool) return { rows: [], count: 0 };
    const where = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(filter)) {
      if (v == null) continue;
      if (k === "to") {
        where.push(`"to"=$${i++}`);
        vals.push(v);
      } else if (k === "from") {
        where.push(`"from"=$${i++}`);
        vals.push(v);
      } else {
        const col =
          k === "callControlId"
            ? "call_control_id"
            : k === "callSessionId"
              ? "call_session_id"
              : k === "isWebrtc"
                ? "is_webrtc"
                : k;
        where.push(`${col}=$${i++}`);
        vals.push(v);
      }
    }
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize || 20));
    const offset = (page - 1) * pageSize;
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM calls ${whereSql} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    const [rowsRes, countRes] = await Promise.all([
      pool.query(sql, vals),
      pool.query(`SELECT COUNT(*) AS c FROM calls ${whereSql}`, vals),
    ]);
    return {
      rows: rowsRes.rows || [],
      count: Number(countRes.rows?.[0]?.c || 0),
    };
  },

  async insertVerifyEvent(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO verify_events (
        id, username, phone, channel, action, verification_id, status, success, error_message, payload, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
      ) RETURNING id`;
    const vals = [
      id,
      doc.username,
      doc.phone,
      doc.channel,
      doc.action,
      doc.verificationId || null,
      doc.status || null,
      Boolean(doc.success),
      doc.errorMessage || null,
      JSON.stringify(doc.payload || null),
      nowIso(),
      nowIso(),
    ];
    await pool.query(q, vals);
    return id;
  },

  async insertNumberLookup(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO number_lookups (
        id, username, phone, carrier_lookup, caller_name_lookup, success, status, error_message, payload, created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
      ) RETURNING id`;
    const vals = [
      id,
      doc.username,
      doc.phone,
      Boolean(doc.carrierLookup),
      Boolean(doc.callerNameLookup),
      Boolean(doc.success),
      doc.status || null,
      doc.errorMessage || null,
      JSON.stringify(doc.payload || null),
      nowIso(),
      nowIso(),
    ];
    await pool.query(q, vals);
    return id;
  },

  async upsertVisitorByUniqueId(uniqueId, doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO visitors (
        id, unique_id, first_name, last_name, organization, email, mobile, product_interests, notes, consent, expires_at, qr_code_data_url, created_at, updated_at, event_id, status, verification_id, activation_token, activation_token_expires
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
      ) ON CONFLICT (unique_id) DO UPDATE SET
        first_name=EXCLUDED.first_name,
        last_name=EXCLUDED.last_name,
        organization=EXCLUDED.organization,
        email=EXCLUDED.email,
        mobile=EXCLUDED.mobile,
        product_interests=EXCLUDED.product_interests,
        notes=EXCLUDED.notes,
        consent=EXCLUDED.consent,
        expires_at=EXCLUDED.expires_at,
        qr_code_data_url=EXCLUDED.qr_code_data_url,
        event_id=EXCLUDED.event_id,
        status=EXCLUDED.status,
        verification_id=EXCLUDED.verification_id,
        activation_token=EXCLUDED.activation_token,
        activation_token_expires=EXCLUDED.activation_token_expires,
        updated_at=EXCLUDED.updated_at
      RETURNING id`;
    const vals = [
      id,
      uniqueId,
      doc.firstName,
      doc.lastName,
      doc.organization,
      doc.email,
      doc.mobile,
      JSON.stringify(doc.productInterests || []),
      doc.notes || "",
      Boolean(doc.consent),
      doc.expiresAt ? new Date(doc.expiresAt).toISOString() : null,
      doc.qrCodeDataUrl || null,
      nowIso(),
      nowIso(),
      doc.eventId || null,
      doc.status || "registered",
      doc.verificationId || null,
      doc.activationToken || null,
      doc.activationTokenExpires
        ? new Date(doc.activationTokenExpires).toISOString()
        : null,
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0]?.id || id;
  },

  async updateVisitorVerificationId(uniqueId, verificationId) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const q = `
      UPDATE visitors 
      SET verification_id=$1, updated_at=$2 
      WHERE unique_id=$3 
      RETURNING id`;
    const vals = [verificationId, nowIso(), uniqueId];
    const r = await pool.query(q, vals);
    return r.rows?.[0]?.id;
  },

  async findVisitorByUniqueId(uniqueId) {
    const pool = getPostgresPool();
    if (!pool) return null;
    const r = await pool.query(
      "SELECT * FROM visitors WHERE unique_id=$1 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1",
      [uniqueId],
    );
    return r.rows?.[0] || null;
  },

  async updateVisitorStatus(uniqueId, status) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const q = `UPDATE visitors SET status = $1, updated_at = NOW() WHERE unique_id = $2`;
    await pool.query(q, [status, uniqueId]);
  },

  async findEventById(eventId) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const q = `SELECT * FROM events WHERE id = $1`;
    const r = await pool.query(q, [eventId]);
    return r.rows?.[0] || null;
  },

  async findVisitorByEmail(email) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const q = `SELECT * FROM visitors WHERE email = $1`;
    const r = await pool.query(q, [email.toLowerCase()]);
    return r.rows?.[0] || null;
  },

  async findVisitorByPhone(mobile) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const q = `SELECT * FROM visitors WHERE mobile = $1`;
    const r = await pool.query(q, [mobile]);
    return r.rows?.[0] || null;
  },

  async findVisitorByActivationToken(token) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const q = `SELECT * FROM visitors WHERE activation_token = $1 LIMIT 1`;
    const r = await pool.query(q, [token]);
    return r.rows?.[0] || null;
  },

  async updateVisitorByUniqueId(uniqueId, set) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const fields = [];
    const values = [];
    let i = 1;
    for (const [k, v] of Object.entries(set)) {
      const col =
        k === "firstName"
          ? "first_name"
          : k === "lastName"
            ? "last_name"
            : k === "activationToken"
              ? "activation_token"
              : k === "activationTokenExpires"
                ? "activation_token_expires"
                : k === "verificationId"
                  ? "verification_id"
                  : k === "qrCodeDataUrl"
                    ? "qr_code_data_url"
                    : k === "productInterests"
                      ? "product_interests"
                      : k === "eventId"
                        ? "event_id"
                        : k === "expiresAt"
                          ? "expires_at"
                          : k;
      fields.push(`${col}=$${i++}`);
      values.push(v);
    }
    values.push(nowIso());
    values.push(uniqueId);
    const q = `UPDATE visitors SET ${fields.join(", ")}, updated_at=$${
      values.length - 1
    } WHERE unique_id=$${values.length}`;
    await pool.query(q, values);
    return true;
  },

  // Visitor tracking methods
  async logVisitorAction({
    visitorId,
    eventId = null,
    actionType,
    actionCategory,
    actionLabel = null,
    actionDetails = {},
    pageUrl = null,
    referrerUrl = null,
    userAgent = null,
    ipAddress = null,
    sessionId = null,
    metadata = {},
    pageName = null,
    productName = null,
    useCaseName = null,
    portalLevel = null,
    durationSeconds = null,
  }) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const id = randomUUID();
    const finalActionLabel =
      actionLabel || this.getActionDisplayName(actionType);

    const q = `
      INSERT INTO visitor_log (
        id, visitor_id, event_id, action_type, action_category, action_label,
        action_details, page_url, referrer_url, user_agent, 
        ip_address, session_id, metadata, page_name, product_name, 
        use_case_name, portal_level, duration_seconds, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()
      )
    `;

    await pool.query(q, [
      id,
      visitorId,
      eventId,
      actionType,
      actionCategory,
      finalActionLabel,
      JSON.stringify(actionDetails),
      pageUrl,
      referrerUrl,
      userAgent,
      ipAddress,
      sessionId,
      JSON.stringify(metadata),
      pageName,
      productName,
      useCaseName,
      portalLevel,
      durationSeconds,
    ]);

    return id;
  },

  async getVisitorLogs(visitorId, limit = 100, offset = 0) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const q = `
      SELECT * FROM visitor_log 
      WHERE visitor_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3
    `;

    const r = await pool.query(q, [visitorId, limit, offset]);
    return r.rows || [];
  },

  async getVisitorAnalytics(eventId = null, startDate = null, endDate = null) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    let whereClause = "1=1";
    const params = [];
    let paramIndex = 1;

    if (eventId) {
      whereClause += ` AND event_id = $${paramIndex}`;
      params.push(eventId);
      paramIndex++;
    }

    if (startDate) {
      whereClause += ` AND created_at >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereClause += ` AND created_at <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    const q = `
      SELECT 
        action_category,
        action_type,
        COUNT(*) as count,
        COUNT(DISTINCT visitor_id) as unique_visitors,
        COUNT(DISTINCT session_id) as unique_sessions
      FROM visitor_log 
      WHERE ${whereClause}
      GROUP BY action_category, action_type
      ORDER BY count DESC
    `;

    const r = await pool.query(q, params);
    return r.rows || [];
  },

  async getEnhancedVisitorAnalytics(
    eventId = null,
    visitorId = null,
    startDate = null,
    endDate = null,
  ) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    let whereClause = "1=1";
    const params = [];
    let paramIndex = 1;

    if (eventId) {
      whereClause += ` AND v.event_id = $${paramIndex}`;
      params.push(eventId);
      paramIndex++;
    }

    if (visitorId) {
      whereClause += ` AND v.id = $${paramIndex}`;
      params.push(visitorId);
      paramIndex++;
    }

    if (startDate) {
      whereClause += ` AND vl.created_at >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereClause += ` AND vl.created_at <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    // Get visitor statistics - create a separate where clause for visitors table
    let visitorWhereClause = "1=1";
    const visitorParams = [];
    let visitorParamIndex = 1;

    if (eventId) {
      visitorWhereClause += ` AND v.event_id = $${visitorParamIndex}`;
      visitorParams.push(eventId);
      visitorParamIndex++;
    }

    if (visitorId) {
      visitorWhereClause += ` AND v.id = $${visitorParamIndex}`;
      visitorParams.push(visitorId);
      visitorParamIndex++;
    }

    const visitorStatsQuery = `
      SELECT 
        COUNT(*) as total_visitors,
        COUNT(CASE WHEN v.status = 'verified' THEN 1 END) as activated_visitors,
        COUNT(CASE WHEN EXISTS(SELECT 1 FROM visitor_log vl WHERE vl.visitor_id = v.unique_id) THEN 1 END) as logged_in_visitors,
        COUNT(CASE WHEN NOT EXISTS(SELECT 1 FROM visitor_log vl WHERE vl.visitor_id = v.unique_id) THEN 1 END) as never_logged_in
      FROM visitors v
      WHERE ${visitorWhereClause}
    `;

    const visitorStats = await pool.query(visitorStatsQuery, visitorParams);

    // Get action breakdown
    const actionBreakdownQuery = `
      SELECT 
        vl.action_category,
        vl.action_type,
        COUNT(*) as count,
        COUNT(DISTINCT vl.visitor_id) as unique_visitors,
        COUNT(DISTINCT vl.session_id) as unique_sessions
      FROM visitor_log vl
      JOIN visitors v ON vl.visitor_id = v.unique_id
      WHERE ${whereClause}
      GROUP BY vl.action_category, vl.action_type
      ORDER BY count DESC
    `;

    const actionBreakdown = await pool.query(actionBreakdownQuery, params);

    return {
      total_visitors: visitorStats.rows[0]?.total_visitors || 0,
      activated_visitors: visitorStats.rows[0]?.activated_visitors || 0,
      logged_in_visitors: visitorStats.rows[0]?.logged_in_visitors || 0,
      never_logged_in: visitorStats.rows[0]?.never_logged_in || 0,
      actionBreakdown: actionBreakdown.rows || [],
    };
  },

  async getVisitorFlowData(
    eventId = null,
    visitorId = null,
    startDate = null,
    endDate = null,
  ) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    let whereClause = "1=1";
    const params = [];
    let paramIndex = 1;

    if (eventId) {
      whereClause += ` AND v.event_id = $${paramIndex}`;
      params.push(eventId);
      paramIndex++;
    }

    if (visitorId) {
      whereClause += ` AND v.id = $${paramIndex}`;
      params.push(visitorId);
      paramIndex++;
    }

    if (startDate) {
      whereClause += ` AND vl.created_at >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereClause += ` AND vl.created_at <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    // Get all visitor actions for flow analysis
    const flowQuery = `
      SELECT 
        vl.action_type,
        vl.action_category,
        vl.action_label,
        vl.page_url,
        vl.page_name,
        vl.product_name,
        vl.use_case_name,
        vl.portal_level,
        COUNT(*) as action_count,
        COUNT(DISTINCT vl.visitor_id) as unique_visitors
      FROM visitor_log vl
      JOIN visitors v ON vl.visitor_id = v.unique_id
      WHERE ${whereClause}
        AND vl.action_type IN ('page_visit', 'page_exit')
        AND vl.page_name IS NOT NULL
      GROUP BY vl.action_type, vl.action_category, vl.action_label, vl.page_url, 
               vl.page_name, vl.product_name, vl.use_case_name, vl.portal_level
      ORDER BY action_count DESC
    `;

    const flowData = await pool.query(flowQuery, params);

    // Transform data for Sankey diagram with 3 levels: Entry -> Product -> Use Case
    const nodes = [];
    const links = [];
    const nodeMap = new Map();
    const linkMap = new Map();

    // Add entry node (hidden)
    const entryNode = { id: "entry", name: "", type: "entry", value: 0 };
    nodes.push(entryNode);
    nodeMap.set("entry", entryNode);

    // Group data by product and use case
    const productMap = new Map();
    const useCaseMap = new Map();
    const uniqueVisitorsSet = new Set();

    flowData.rows.forEach((row) => {
      const productName = row.product_name || "Other";
      const useCaseName = row.use_case_name || "General";

      // Track product nodes
      if (!productMap.has(productName)) {
        productMap.set(productName, {
          id: productName,
          name: productName,
          type: "product",
          value: 0,
          uniqueVisitors: new Set(),
          useCases: new Map(),
        });
      }

      // Track use case nodes
      if (!useCaseMap.has(useCaseName)) {
        useCaseMap.set(useCaseName, {
          id: useCaseName,
          name: useCaseName,
          type: "usecase",
          value: 0,
          uniqueVisitors: new Set(),
        });
      }

      // Update counts
      productMap.get(productName).value += parseInt(row.action_count);
      useCaseMap.get(useCaseName).value += parseInt(row.action_count);

      // Track product -> use case relationships
      if (!productMap.get(productName).useCases.has(useCaseName)) {
        productMap.get(productName).useCases.set(useCaseName, 0);
      }
      productMap
        .get(productName)
        .useCases.set(
          useCaseName,
          productMap.get(productName).useCases.get(useCaseName) +
            parseInt(row.action_count),
        );
    });

    // Add product nodes
    productMap.forEach((product) => {
      const node = {
        id: product.id,
        name: product.name,
        type: "product",
        value: product.value,
      };
      nodes.push(node);
      nodeMap.set(product.id, node);

      // Create link from entry to product
      const link = {
        source: "entry",
        target: product.id,
        value: product.value,
      };
      links.push(link);
    });

    // Add use case nodes and links
    useCaseMap.forEach((useCase) => {
      const node = {
        id: useCase.id,
        name: useCase.name,
        type: "usecase",
        value: useCase.value,
      };
      nodes.push(node);
      nodeMap.set(useCase.id, node);
    });

    // Create product -> use case links
    productMap.forEach((product) => {
      product.useCases.forEach((visitorCount, useCaseName) => {
        if (useCaseMap.has(useCaseName)) {
          // Use a minimum value to ensure visible links
          const linkValue = Math.max(visitorCount, 1);
          const link = {
            source: product.id,
            target: useCaseName,
            value: linkValue,
          };
          links.push(link);
        }
      });
    });

    // Calculate total unique visitors from the flow data
    const totalUniqueVisitors = await pool.query(
      `
      SELECT COUNT(DISTINCT vl.visitor_id) as unique_visitors
      FROM visitor_log vl
      JOIN visitors v ON vl.visitor_id = v.unique_id
      WHERE ${whereClause}
        AND vl.action_type IN ('page_visit', 'page_exit')
        AND vl.page_name IS NOT NULL
    `,
      params,
    );

    return {
      nodes,
      links,
      totalUniqueVisitors: parseInt(
        totalUniqueVisitors.rows[0]?.unique_visitors || 0,
      ),
      totalActions: flowData.rows.reduce(
        (sum, row) => sum + parseInt(row.action_count),
        0,
      ),
    };
  },

  getActionDisplayName(actionType) {
    const actionNames = {
      dashboard_access: "Dashboard",
      ai_chat_accessed: "AI Chat",
      ai_chat_message_sent: "AI Chat Message",
      voice_demo_accessed: "Voice Demo",
      voice_call_initiated: "Voice Call",
      messaging_demo_accessed: "Messaging Demo",
      sms_sent: "SMS Sent",
      verify_demo_accessed: "Verify Demo",
      verification_initiated: "Verification",
    };
    return actionNames[actionType] || actionType;
  },

  extractPageName(url) {
    if (!url) return "Unknown";

    // Extract meaningful page names from URLs
    if (url.includes("/dashboard")) return "Dashboard";
    if (url.includes("/ai-chat")) return "AI Chat";
    if (url.includes("/voice")) return "Voice Demo";
    if (url.includes("/messaging")) return "Messaging Demo";
    if (url.includes("/verify")) return "Verify Demo";
    if (url.includes("/success")) return "Success Page";
    if (url.includes("/verify/")) return "Verification";

    return "Other";
  },

  async getAllVisitors(eventId = null, limit = 100, offset = 0) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    let whereClause = "1=1";
    const params = [];
    let paramIndex = 1;

    if (eventId) {
      whereClause += ` AND event_id = $${paramIndex}`;
      params.push(eventId);
      paramIndex++;
    }

    const q = `
      SELECT 
        id,
        unique_id,
        first_name,
        last_name,
        email,
        mobile,
        status,
        created_at
      FROM visitors 
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;

    params.push(limit, offset);
    const r = await pool.query(q, params);
    return r.rows || [];
  },

  /**
   * Check visitor usage limits
   * @param {string} uniqueId - Visitor unique ID
   * @param {string} serviceType - Type of service (ai_turns, voice_minutes, sms, lookup, otp)
   * @param {number} amount - Amount to check (e.g., turns, minutes or count)
   * @returns {Promise<{allowed: boolean, current: number, limit: number, remaining: number}>}
   */
  async checkVisitorLimit(uniqueId, serviceType, amount = 1) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const usedField = `${serviceType}_used`;
    const limitField = `${serviceType}_limit`;

    const q = `
      SELECT ${usedField} as used, ${limitField} as limit_value
      FROM visitors 
      WHERE unique_id = $1
    `;

    const result = await pool.query(q, [uniqueId]);

    if (!result.rows[0]) {
      return {
        allowed: false,
        current: 0,
        limit: 0,
        remaining: 0,
        error: "Visitor not found",
      };
    }

    const current = result.rows[0].used || 0;
    const limit = result.rows[0].limit_value || 0;
    const remaining = Math.max(0, limit - current);
    const allowed = current + amount <= limit;

    return {
      allowed,
      current,
      limit,
      remaining,
    };
  },

  /**
   * Increment visitor usage counter
   * @param {string} uniqueId - Visitor unique ID
   * @param {string} serviceType - Type of service (ai_turns, voice_minutes, sms, lookup, otp)
   * @param {number} amount - Amount to increment (e.g., turns, minutes or count)
   * @returns {Promise<{success: boolean, current: number, limit: number}>}
   */
  async incrementVisitorUsage(uniqueId, serviceType, amount = 1) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const usedField = `${serviceType}_used`;
    const limitField = `${serviceType}_limit`;

    const q = `
      UPDATE visitors 
      SET ${usedField} = ${usedField} + $1,
          updated_at = NOW()
      WHERE unique_id = $2
      RETURNING ${usedField} as used, ${limitField} as limit_value
    `;

    const result = await pool.query(q, [amount, uniqueId]);

    if (!result.rows[0]) {
      return { success: false, current: 0, limit: 0 };
    }

    return {
      success: true,
      current: result.rows[0].used,
      limit: result.rows[0].limit_value,
    };
  },

  /**
   * Get visitor usage statistics
   * @param {string} uniqueId - Visitor unique ID
   * @returns {Promise<Object>} - Usage statistics for all services
   */
  async getVisitorUsageStats(uniqueId) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const q = `
      SELECT 
        ai_turns_used, ai_turns_limit,
        voice_minutes_used, voice_minutes_limit,
        sms_used, sms_limit,
        lookup_used, lookup_limit,
        otp_used, otp_limit
      FROM visitors 
      WHERE unique_id = $1
    `;

    const result = await pool.query(q, [uniqueId]);

    if (!result.rows[0]) {
      return null;
    }

    const row = result.rows[0];

    return {
      aiAssistants: {
        used: row.ai_turns_used || 0,
        limit: row.ai_turns_limit || 1000,
        remaining: Math.max(
          0,
          (row.ai_turns_limit || 1000) - (row.ai_turns_used || 0),
        ),
      },
      voiceCalls: {
        used: row.voice_minutes_used || 0,
        limit: row.voice_minutes_limit || 60,
        remaining: Math.max(
          0,
          (row.voice_minutes_limit || 60) - (row.voice_minutes_used || 0),
        ),
      },
      sms: {
        used: row.sms_used || 0,
        limit: row.sms_limit || 20,
        remaining: Math.max(0, (row.sms_limit || 20) - (row.sms_used || 0)),
      },
      numberLookups: {
        used: row.lookup_used || 0,
        limit: row.lookup_limit || 20,
        remaining: Math.max(
          0,
          (row.lookup_limit || 20) - (row.lookup_used || 0),
        ),
      },
      otpVerifications: {
        used: row.otp_used || 0,
        limit: row.otp_limit || 20,
        remaining: Math.max(0, (row.otp_limit || 20) - (row.otp_used || 0)),
      },
    };
  },

  /**
   * Update visitor limits
   * @param {string} uniqueId - Visitor unique ID
   * @param {Object} limits - Object containing limit values
   * @returns {Promise<boolean>}
   */
  async updateVisitorLimits(uniqueId, limits) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (limits.aiTurnsLimit !== undefined) {
      updates.push(`ai_turns_limit = $${paramIndex++}`);
      values.push(limits.aiTurnsLimit);
    }
    if (limits.voiceMinutesLimit !== undefined) {
      updates.push(`voice_minutes_limit = $${paramIndex++}`);
      values.push(limits.voiceMinutesLimit);
    }
    if (limits.smsLimit !== undefined) {
      updates.push(`sms_limit = $${paramIndex++}`);
      values.push(limits.smsLimit);
    }
    if (limits.lookupLimit !== undefined) {
      updates.push(`lookup_limit = $${paramIndex++}`);
      values.push(limits.lookupLimit);
    }
    if (limits.otpLimit !== undefined) {
      updates.push(`otp_limit = $${paramIndex++}`);
      values.push(limits.otpLimit);
    }

    if (updates.length === 0) return false;

    updates.push(`updated_at = NOW()`);
    values.push(uniqueId);

    const q = `
      UPDATE visitors 
      SET ${updates.join(", ")}
      WHERE unique_id = $${paramIndex}
    `;

    await pool.query(q, values);
    return true;
  },

  // Contact Center Functions
  async findQueueByName(name) {
    const pool = getPostgresPool();
    if (!pool) return null;
    // Use case-insensitive lookup to handle "Sales" vs "SALES"
    const r = await pool.query(
      "SELECT * FROM cc_queues WHERE UPPER(name) = UPPER($1)",
      [name],
    );
    return r.rows?.[0] || null;
  },

  async findQueueById(id) {
    const pool = getPostgresPool();
    if (!pool) return null;
    const r = await pool.query("SELECT * FROM cc_queues WHERE id = $1", [id]);
    return r.rows?.[0] || null;
  },

  async insertQueue(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO cc_queues (
        id, name, display_name, description,
        routing_strategy, max_wait_time_secs, max_size, timeout_secs,
        overflow_queue_id, overflow_action, priority, enabled,
        skill_requirements, priority_rules,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
      RETURNING id
    `;
    const vals = [
      id,
      doc.name,
      doc.displayName || doc.display_name || null,
      doc.description || null,
      doc.routingStrategy || doc.routing_strategy || "FIFO",
      doc.maxWaitTimeSecs || doc.max_wait_time_secs || 600,
      doc.maxSize || doc.max_size || 100,
      doc.timeoutSecs || doc.timeout_secs || 300,
      doc.overflowQueueId || doc.overflow_queue_id || null,
      doc.overflowAction || doc.overflow_action || "transfer",
      doc.priority || 0,
      doc.enabled !== undefined ? doc.enabled : true,
      doc.skillRequirements ? JSON.stringify(doc.skillRequirements) : "{}",
      doc.priorityRules ? JSON.stringify(doc.priorityRules) : "[]",
    ];
    await pool.query(q, vals);
    return id;
  },

  async listQueues(filter = {}) {
    const pool = getPostgresPool();
    if (!pool) return [];
    const where = [];
    const vals = [];
    let paramIndex = 1;

    if (filter.queueType !== undefined) {
      where.push(`queue_type = $${paramIndex++}`);
      vals.push(filter.queueType);
    }
    if (filter.ownerUsername !== undefined) {
      where.push(`owner_username = $${paramIndex++}`);
      vals.push(filter.ownerUsername);
    }
    if (filter.enabled !== undefined) {
      where.push(`enabled = $${paramIndex++}`);
      vals.push(filter.enabled);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const q = `SELECT * FROM cc_queues ${whereSql} ORDER BY priority DESC, name ASC`;
    const r = await pool.query(q, vals);
    return r.rows || [];
  },

  async findAgentQueueAssignment(agentUsername, queueId) {
    const pool = getPostgresPool();
    if (!pool) return null;

    // First, get the user ID from username
    const userResult = await pool.query(
      `SELECT id FROM users WHERE username = $1 LIMIT 1`,
      [agentUsername],
    );

    if (!userResult.rows || userResult.rows.length === 0) {
      return null;
    }

    const userId = userResult.rows[0].id;

    // Then get queue assignment using user_id
    const r = await pool.query(
      "SELECT * FROM cc_queue_user_assignments WHERE user_id = $1 AND queue_id = $2",
      [userId, queueId],
    );
    return r.rows?.[0] || null;
  },

  async insertAgentQueueAssignment(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    // Get user_id from username
    const agentUsername = doc.agentUsername || doc.agent_username;
    const userResult = await pool.query(
      `SELECT id FROM users WHERE username = $1 LIMIT 1`,
      [agentUsername],
    );

    if (!userResult.rows || userResult.rows.length === 0) {
      throw new Error(`User not found: ${agentUsername}`);
    }

    const userId = userResult.rows[0].id;
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO cc_queue_user_assignments (
        id, user_id, queue_id, priority,
        enabled, activated_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (queue_id, user_id) 
      DO UPDATE SET 
        enabled = EXCLUDED.enabled,
        activated_at = CASE WHEN EXCLUDED.enabled THEN NOW() ELSE cc_queue_user_assignments.activated_at END,
        deactivated_at = CASE WHEN NOT EXCLUDED.enabled THEN NOW() ELSE cc_queue_user_assignments.deactivated_at END,
        updated_at = NOW()
      RETURNING id
    `;
    const vals = [
      id,
      userId,
      doc.queueId || doc.queue_id,
      doc.priority || 0,
      doc.enabled !== undefined ? doc.enabled : true,
      doc.enabled !== undefined && doc.enabled
        ? new Date().toISOString()
        : null,
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0]?.id || id;
  },

  async listAgentQueueAssignments(agentUsername) {
    const pool = getPostgresPool();
    if (!pool) return [];

    // First, get the user ID from username
    const userResult = await pool.query(
      `SELECT id FROM users WHERE username = $1 LIMIT 1`,
      [agentUsername],
    );

    if (!userResult.rows || userResult.rows.length === 0) {
      return [];
    }

    const userId = userResult.rows[0].id;

    // Then get queue assignments using user_id
    const r = await pool.query(
      `SELECT qa.*, q.name as queue_name, q.display_name, q.routing_strategy as queue_type
       FROM cc_queue_user_assignments qa
       JOIN cc_queues q ON qa.queue_id = q.id
       WHERE qa.user_id = $1
       ORDER BY q.priority DESC, q.name ASC`,
      [userId],
    );
    return r.rows || [];
  },

  async findAgentsInQueue(queueName, status = null) {
    const pool = getPostgresPool();
    if (!pool) return [];
    const q = `
      SELECT DISTINCT u.*, qa.priority as queue_priority, ast.agent_status as current_agent_status
      FROM users u
      JOIN cc_queue_user_assignments qa ON u.id = qa.user_id
      JOIN cc_queues q ON qa.queue_id = q.id
      LEFT JOIN cc_agent_state ast ON ast.user_id = u.id
      WHERE q.name = $1 AND qa.enabled = true
        ${status ? "AND ast.agent_status = $2" : ""}
      ORDER BY qa.priority DESC, u.username ASC
    `;
    const vals = status ? [queueName, status] : [queueName];
    const r = await pool.query(q, vals);
    return r.rows || [];
  },

  async insertInteraction(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO cc_interactions (
        id, interaction_type, queue_name, queue_id, agent_username,
        call_control_id, call_session_id, direction, state, is_contact_center,
        from_number, to_number, from_name, to_name, required_skills, routing_metadata,
        flow_id, enqueued_at, assigned_at, answered_at, completed_at, abandoned_at,
        wait_time_seconds, handle_time_seconds, talk_time_seconds, transfer_count,
        transfer_history, hold_count, hold_duration_seconds, recording_url, notes,
        tags, wrapup_codes, metadata, priority
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
        $31, $32, $33, $34, $35
      ) RETURNING id
    `;
    const vals = [
      id,
      doc.interactionType || doc.interaction_type || "voice",
      doc.queueName || doc.queue_name,
      doc.queueId || doc.queue_id || null,
      doc.agentUsername || doc.agent_username || null,
      doc.callControlId || doc.call_control_id || null,
      doc.callSessionId || doc.call_session_id || null,
      doc.direction || null,
      doc.state || "queued",
      doc.isContactCenter !== undefined ? doc.isContactCenter : true,
      doc.fromNumber || doc.from_number || null,
      doc.toNumber || doc.to_number || null,
      doc.fromName || doc.from_name || null,
      doc.toName || doc.to_name || null,
      doc.requiredSkills ? JSON.stringify(doc.requiredSkills) : null,
      doc.routingMetadata ? JSON.stringify(doc.routingMetadata) : null,
      doc.flowId || doc.flow_id || null,
      doc.enqueuedAt || doc.enqueued_at || null,
      doc.assignedAt || doc.assigned_at || null,
      doc.answeredAt || doc.answered_at || null,
      doc.completedAt || doc.completed_at || null,
      doc.abandonedAt || doc.abandoned_at || null,
      doc.waitTimeSeconds || doc.wait_time_seconds || null,
      doc.handleTimeSeconds || doc.handle_time_seconds || null,
      doc.talkTimeSeconds || doc.talk_time_seconds || null,
      doc.transferCount || doc.transfer_count || 0,
      doc.transferHistory ? JSON.stringify(doc.transferHistory) : null,
      doc.holdCount || doc.hold_count || 0,
      doc.holdDurationSeconds || doc.hold_duration_seconds || 0,
      doc.recordingUrl || doc.recording_url || null,
      doc.notes || null,
      doc.tags ? JSON.stringify(doc.tags) : null,
      doc.wrapupCodes ? JSON.stringify(doc.wrapupCodes) : null,
      doc.metadata ? JSON.stringify(doc.metadata) : null,
      doc.priority !== undefined ? doc.priority : null,
    ];

    // Debug: Verify column and value counts match
    const columnCount = q.match(/INSERT INTO cc_interactions \(/)?.[0]
      ? q.match(/\) VALUES \(/)?.[0]
        ? q
            .split("INSERT INTO cc_interactions (")[1]
            .split(") VALUES (")[0]
            .split(",").length
        : 0
      : 0;
    const paramCount = (q.match(/\$(\d+)/g) || []).length;
    const valCount = vals.length;

    if (paramCount !== valCount) {
      console.error(
        `[pgdb] insertInteraction mismatch: ${paramCount} params but ${valCount} values`,
      );
      console.error(`[pgdb] SQL:`, q);
      console.error(`[pgdb] Values:`, vals);
      throw new Error(
        `Parameter count mismatch: ${paramCount} parameters but ${valCount} values`,
      );
    }

    await pool.query(q, vals);
    return id;
  },

  async findInteractionById(id) {
    const pool = getPostgresPool();
    if (!pool) return null;
    const r = await pool.query("SELECT * FROM cc_interactions WHERE id = $1", [
      id,
    ]);
    if (!r.rows?.[0]) return null;
    const row = r.rows[0];

    // Helper to safely parse JSON (handles both string and already-parsed objects)
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "object") return value; // Already parsed
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value; // Return as-is if not valid JSON
        }
      }
      return value;
    };

    return {
      ...row,
      required_skills: safeParse(row.required_skills),
      routing_metadata: safeParse(row.routing_metadata),
      transfer_history: safeParse(row.transfer_history),
      tags: safeParse(row.tags),
      wrapup_codes: safeParse(row.wrapup_codes),
      metadata: safeParse(row.metadata),
    };
  },

  async findInteractionByCallControlId(callControlId) {
    const pool = getPostgresPool();
    if (!pool) return null;
    const r = await pool.query(
      "SELECT * FROM cc_interactions WHERE call_control_id = $1 ORDER BY created_at DESC LIMIT 1",
      [callControlId],
    );
    if (!r.rows?.[0]) return null;
    const row = r.rows[0];

    // Helper to safely parse JSON (handles both string and already-parsed objects)
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "object") return value; // Already parsed
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value; // Return as-is if not valid JSON
        }
      }
      return value;
    };

    return {
      ...row,
      required_skills: safeParse(row.required_skills),
      routing_metadata: safeParse(row.routing_metadata),
      transfer_history: safeParse(row.transfer_history),
      tags: safeParse(row.tags),
      wrapup_codes: safeParse(row.wrapup_codes),
      metadata: safeParse(row.metadata),
    };
  },

  async findInteractionByCallSessionId(callSessionId) {
    const pool = getPostgresPool();
    if (!pool) return null;
    if (!callSessionId) return null;
    const r = await pool.query(
      "SELECT * FROM cc_interactions WHERE call_session_id = $1 ORDER BY created_at ASC LIMIT 1",
      [callSessionId],
    );
    if (!r.rows?.[0]) return null;
    const row = r.rows[0];

    // Helper to safely parse JSON (handles both string and already-parsed objects)
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "object") return value; // Already parsed
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value; // Return as-is if not valid JSON
        }
      }
      return value;
    };

    return {
      ...row,
      required_skills: safeParse(row.required_skills),
      routing_metadata: safeParse(row.routing_metadata),
      transfer_history: safeParse(row.transfer_history),
      tags: safeParse(row.tags),
      wrapup_codes: safeParse(row.wrapup_codes),
      metadata: safeParse(row.metadata),
    };
  },

  /**
   * Find the second call leg (PSTN leg) for an outbound WebRTC call
   * When an outbound call is made via WebRTC, there are two legs:
   * 1. First leg: WebRTC -> Voice API (is_webrtc = true, has X-RTC-CALLID header)
   * 2. Second leg: Voice API -> PSTN (is_webrtc = false, no X-RTC-CALLID header)
   * This function finds the second leg (PSTN leg) which should be used for transfer
   */
  async findSecondCallLegByCallSessionId(callSessionId, firstLegCallControlId) {
    const pool = getPostgresPool();
    if (!pool) return null;
    if (!callSessionId) return null;

    // Find all calls with the same call_session_id
    const r = await pool.query(
      "SELECT * FROM calls WHERE call_session_id = $1 AND call_control_id != $2 ORDER BY created_at ASC",
      [callSessionId, firstLegCallControlId || ""],
    );

    // Find the call that's NOT the WebRTC leg (is_webrtc = false or doesn't have X-RTC-CALLID)
    for (const call of r.rows || []) {
      // The second leg should be the PSTN leg (not WebRTC)
      if (!call.is_webrtc) {
        return call;
      }
    }

    // If no non-WebRTC call found, return the first non-matching call (should be the second leg)
    return r.rows?.[0] || null;
  },

  async updateInteractionById(id, updates) {
    const pool = getPostgresPool();
    if (!pool) return false;
    const set = [];
    const vals = [];
    let paramIndex = 1;

    const fields = {
      state: "state",
      agentUsername: "agent_username",
      assignedAt: "assigned_at",
      answeredAt: "answered_at",
      completedAt: "completed_at",
      abandonedAt: "abandoned_at",
      waitTimeSeconds: "wait_time_seconds",
      handleTimeSeconds: "handle_time_seconds",
      talkTimeSeconds: "talk_time_seconds",
      transferCount: "transfer_count",
      transferHistory: "transfer_history",
      holdCount: "hold_count",
      holdDurationSeconds: "hold_duration_seconds",
      recordingUrl: "recording_url",
      notes: "notes",
      tags: "tags",
      wrapupCodes: "wrapup_codes",
      metadata: "metadata",
      queueName: "queue_name",
      queueId: "queue_id",
      isContactCenter: "is_contact_center",
      enqueuedAt: "enqueued_at",
      requiredSkills: "required_skills",
      routingMetadata: "routing_metadata",
      fromNumber: "from_number",
      toNumber: "to_number",
      fromName: "from_name",
      toName: "to_name",
      callControlId: "call_control_id",
      callSessionId: "call_session_id",
      callLegId: "call_leg_id",
      priority: "priority",
    };

    for (const [key, dbField] of Object.entries(fields)) {
      if (updates[key] !== undefined) {
        let value = updates[key];
        if (
          key === "transferHistory" ||
          key === "tags" ||
          key === "metadata" ||
          key === "routingMetadata" ||
          key === "requiredSkills" ||
          key === "wrapupCodes"
        ) {
          value = value ? JSON.stringify(value) : null;
        }
        set.push(`${dbField} = $${paramIndex++}`);
        vals.push(value);
      }
    }

    if (set.length === 0) return false;
    set.push(`updated_at = NOW()`);
    vals.push(id);

    const q = `UPDATE cc_interactions SET ${set.join(
      ", ",
    )} WHERE id = $${paramIndex}`;
    await pool.query(q, vals);

    // Track call activities
    try {
      // Get the interaction to check if it's a call and get user info
      const interaction = await this.findInteractionById(id);
      if (interaction && interaction.agent_username) {
        // Find user by username
        const user = await this.findUserByUsername(interaction.agent_username);
        if (user) {
          // Track call start when answered
          if (updates.answeredAt && !interaction.answered_at) {
            await this.logUserActivity({
              userId: user.id,
              activityType: "call_start",
              activityValue: interaction.from_number || "Unknown",
              interactionId: id,
              queueId: interaction.queue_id,
              startedAt: updates.answeredAt,
              metadata: {
                callControlId: interaction.call_control_id,
                fromNumber: interaction.from_number,
                toNumber: interaction.to_number,
                queueName: interaction.queue_name,
              },
            });
          }

          // Track call end when completed
          if (updates.completedAt && !interaction.completed_at) {
            const callStartTime =
              interaction.answered_at ||
              interaction.assigned_at ||
              interaction.enqueued_at;
            const callEndTime = updates.completedAt;
            let durationSeconds = null;
            if (callStartTime && callEndTime) {
              durationSeconds = Math.floor(
                (new Date(callEndTime) - new Date(callStartTime)) / 1000,
              );
            }

            await this.logUserActivity({
              userId: user.id,
              activityType: "call_end",
              activityValue: interaction.from_number || "Unknown",
              interactionId: id,
              queueId: interaction.queue_id,
              startedAt: callStartTime,
              endedAt: callEndTime,
              durationSeconds:
                durationSeconds ||
                updates.talkTimeSeconds ||
                updates.handleTimeSeconds,
              metadata: {
                callControlId: interaction.call_control_id,
                fromNumber: interaction.from_number,
                toNumber: interaction.to_number,
                queueName: interaction.queue_name,
                talkTimeSeconds: updates.talkTimeSeconds,
                handleTimeSeconds: updates.handleTimeSeconds,
                waitTimeSeconds: updates.waitTimeSeconds,
              },
            });
          }
        }
      }
    } catch (activityError) {
      console.error(
        "[Interaction] Failed to log call activity:",
        activityError,
      );
      // Don't fail the update if activity logging fails
    }

    return true;
  },

  async listAgentInteractions(agentUsernameOrFilter, filter = {}) {
    const pool = getPostgresPool();
    if (!pool) return [];

    // Handle both old signature (agentUsername, filter) and new signature (filter object)
    let agentUsername;
    if (typeof agentUsernameOrFilter === "string") {
      agentUsername = agentUsernameOrFilter;
    } else if (
      typeof agentUsernameOrFilter === "object" &&
      agentUsernameOrFilter !== null
    ) {
      // New signature: first param is filter object
      filter = agentUsernameOrFilter;
      agentUsername = filter.agentUsername;
    } else {
      return [];
    }

    if (!agentUsername || typeof agentUsername !== "string") {
      return [];
    }

    // Get agent's activated queues (for filtering shared queue interactions)
    const assignments = await this.listAgentQueueAssignments(agentUsername);
    const activatedQueueIds = new Set(
      assignments.filter((a) => a.enabled).map((a) => a.queue_id),
    );

    // Get private queue name for the agent
    const privateQueueName = agentUsername.split("@")[0].toUpperCase();
    const privateQueue = await this.findQueueByName(privateQueueName);
    if (privateQueue) {
      activatedQueueIds.add(privateQueue.id);
    }

    const where = [];
    const vals = [];
    let paramIndex = 1;

    // Filter by queue activation: only show interactions from queues the agent is activated in
    // OR interactions assigned directly to the agent (for outbound calls)
    // Exclude transfer legs (is_transfer_leg in metadata), consult calls (is_consult_call), and non-contact-center interactions
    if (activatedQueueIds.size > 0) {
      const queueIdsArray = Array.from(activatedQueueIds);
      where.push(`(
        (queue_id = ANY($${paramIndex}) AND is_contact_center = true)
        OR (agent_username = $${paramIndex + 1} AND is_contact_center = true)
      )
      AND NOT (metadata->>'is_transfer_leg' = 'true')
      AND NOT (metadata->>'is_consult_call' = 'true')`);
      vals.push(queueIdsArray);
      vals.push(agentUsername);
      paramIndex += 2;
    } else {
      // No activated queues, only show direct assignments (outbound calls) that are contact center
      where.push(`agent_username = $${paramIndex++}`);
      vals.push(agentUsername);
      where.push(`is_contact_center = true`);
      where.push(`NOT (metadata->>'is_transfer_leg' = 'true')`);
      where.push(`NOT (metadata->>'is_consult_call' = 'true')`);
    }

    if (filter.state) {
      where.push(`state = $${paramIndex++}`);
      vals.push(filter.state);
    }
    if (filter.interactionType) {
      where.push(`interaction_type = $${paramIndex++}`);
      vals.push(filter.interactionType);
    }

    // Filter for active interactions only (not completed/abandoned)
    if (filter.activeOnly) {
      // Exclude completed and abandoned states, but keep answered/connected/active states
      where.push(
        `state NOT IN ('completed', 'abandoned', 'hangup', 'ended', 'destroy', 'idle', 'terminated')`,
      );
      // Also exclude interactions with completed_at or abandoned_at set
      where.push(`completed_at IS NULL`);
      where.push(`abandoned_at IS NULL`);
      // Keep interactions in active states: queued, ringing, answered, connected, active, bridging, etc.
    }

    // Always exclude timeout re-enqueued interactions - these should never be shown to the agent
    // They have been re-enqueued and are no longer assigned to this agent
    // Check if timeout_re_enqueued is NULL or not equal to 'true' (handles NULL metadata gracefully)
    where.push(`COALESCE(metadata->>'timeout_re_enqueued', '') != 'true'`);

    // Also exclude interactions where agent_username is NULL (they were unassigned, e.g., after timeout)
    // This ensures that if a call times out and agent_username is cleared, it won't show up
    where.push(`agent_username IS NOT NULL`);

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const q = `SELECT * FROM cc_interactions ${whereSql} ORDER BY created_at DESC LIMIT $${paramIndex}`;
    vals.push(filter.limit || 50);
    const r = await pool.query(q, vals);

    // Helper to safely parse JSON (handles both string and already-parsed objects)
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "object") return value; // Already parsed
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return value; // Return as-is if not valid JSON
        }
      }
      return value;
    };

    return r.rows.map((row) => ({
      ...row,
      required_skills: safeParse(row.required_skills),
      routing_metadata: safeParse(row.routing_metadata),
      transfer_history: safeParse(row.transfer_history),
      tags: safeParse(row.tags),
      metadata: safeParse(row.metadata),
    }));
  },

  async insertAgentStatusHistory(doc) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = doc.id || randomUUID();
    const q = `
      INSERT INTO cc_agent_status_history (
        id, agent_username, status, previous_status, interaction_id,
        reason, duration_seconds, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING id
    `;
    const vals = [
      id,
      doc.agentUsername || doc.agent_username,
      doc.status,
      doc.previousStatus || doc.previous_status || null,
      doc.interactionId || doc.interaction_id || null,
      doc.reason || null,
      doc.durationSeconds || doc.duration_seconds || null,
    ];
    await pool.query(q, vals);
    return id;
  },

  async findLastCompletedInteraction(agentUsername) {
    const pool = getPostgresPool();
    if (!pool) return null;
    const r = await pool.query(
      `SELECT * FROM cc_interactions 
       WHERE agent_username = $1 AND state = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
      [agentUsername],
    );
    return r.rows?.[0] || null;
  },

  async findAgentSkills(agentUsername) {
    const pool = getPostgresPool();
    if (!pool) return [];
    const r = await pool.query(
      "SELECT * FROM cc_agent_skills WHERE agent_username = $1",
      [agentUsername],
    );
    return r.rows || [];
  },

  // Activity Monitoring Functions
  async logUserSession({
    userId,
    sessionToken = null,
    loginAt = null,
    logoutAt = null,
    ipAddress = null,
    userAgent = null,
  }) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = randomUUID();
    const loginTime = loginAt || nowIso();
    const logoutTime = logoutAt || null;
    let durationSeconds = null;
    if (logoutTime && loginTime) {
      durationSeconds = Math.floor(
        (new Date(logoutTime) - new Date(loginTime)) / 1000,
      );
    }

    const q = `
      INSERT INTO cc_user_sessions (
        id, user_id, session_token, login_at, logout_at, duration_seconds,
        ip_address, user_agent, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
      RETURNING id
    `;
    const vals = [
      id,
      userId,
      sessionToken,
      loginTime,
      logoutTime,
      durationSeconds,
      ipAddress,
      userAgent,
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0]?.id || id;
  },

  async updateUserSessionLogout(sessionToken, logoutAt = null) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const logoutTime = logoutAt || nowIso();

    const q = `
      UPDATE cc_user_sessions
      SET logout_at = $1,
          duration_seconds = CASE
            WHEN login_at IS NOT NULL THEN EXTRACT(EPOCH FROM ($1 - login_at))::INTEGER
            ELSE NULL
          END,
          updated_at = NOW()
      WHERE session_token = $2 AND logout_at IS NULL
      RETURNING id, user_id, login_at
    `;
    const r = await pool.query(q, [logoutTime, sessionToken]);
    return r.rows?.[0] || null;
  },

  async logUserActivity({
    userId,
    activityType,
    activityValue = null,
    previousValue = null,
    metadata = {},
    interactionId = null,
    queueId = null,
    startedAt = null,
    endedAt = null,
    durationSeconds = null,
  }) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = randomUUID();

    // Calculate duration if both start and end times are provided
    let calculatedDuration = durationSeconds;
    if (!calculatedDuration && startedAt && endedAt) {
      calculatedDuration = Math.floor(
        (new Date(endedAt) - new Date(startedAt)) / 1000,
      );
    }

    const q = `
      INSERT INTO cc_user_activity_log (
        id, user_id, activity_type, activity_value, previous_value,
        metadata, interaction_id, queue_id, started_at, ended_at,
        duration_seconds, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING id
    `;
    const vals = [
      id,
      userId,
      activityType,
      activityValue,
      previousValue,
      JSON.stringify(metadata),
      interactionId,
      queueId,
      startedAt || nowIso(),
      endedAt,
      calculatedDuration,
    ];
    const r = await pool.query(q, vals);
    const activityId = r.rows?.[0]?.id || id;

    // Update time tracking aggregates asynchronously (don't block)
    this.updateTimeTrackingAggregates(userId, activityType, {
      activityValue,
      startedAt: startedAt || nowIso(),
      endedAt,
      durationSeconds: calculatedDuration,
    }).catch((err) => {
      console.error("[Activity] Failed to update time tracking:", err);
    });

    return activityId;
  },

  async updateTimeTrackingAggregates(userId, activityType, data = {}) {
    const pool = getPostgresPool();
    if (!pool) return;

    const now = new Date();
    const trackingDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const trackingHour = now.getHours();

    // First, ensure the record exists
    try {
      await pool.query(
        `INSERT INTO cc_user_time_tracking (id, user_id, tracking_date, tracking_hour, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         ON CONFLICT (user_id, tracking_date, tracking_hour) DO NOTHING`,
        [randomUUID(), userId, trackingDate, trackingHour],
      );
    } catch (err) {
      // Ignore errors on insert - record might already exist
    }

    // Build update SQL based on activity type
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (activityType === "login") {
      updates.push("login_count = login_count + 1");
    } else if (activityType === "logout") {
      const duration = data.durationSeconds || 0;
      if (duration > 0) {
        updates.push("logged_in_seconds = logged_in_seconds + $" + paramIndex);
        values.push(duration);
        paramIndex++;
      }
    } else if (activityType === "status_change") {
      updates.push("status_change_count = status_change_count + 1");
      const status = data.activityValue;
      const duration = data.durationSeconds || 0;
      if (duration > 0) {
        if (status === "Available") {
          updates.push(
            "status_available_seconds = status_available_seconds + $" +
              paramIndex,
          );
          values.push(duration);
          paramIndex++;
        } else if (status === "Busy") {
          updates.push(
            "status_busy_seconds = status_busy_seconds + $" + paramIndex,
          );
          values.push(duration);
          paramIndex++;
        } else if (status === "Away") {
          updates.push(
            "status_away_seconds = status_away_seconds + $" + paramIndex,
          );
          values.push(duration);
          paramIndex++;
        } else if (status === "On Queue") {
          updates.push(
            "status_on_queue_seconds = status_on_queue_seconds + $" +
              paramIndex,
          );
          values.push(duration);
          paramIndex++;
        } else if (status === "Off Queue") {
          updates.push(
            "status_off_queue_seconds = status_off_queue_seconds + $" +
              paramIndex,
          );
          values.push(duration);
          paramIndex++;
        }
      }
    } else if (activityType === "queue_activate") {
      updates.push("queue_activation_count = queue_activation_count + 1");
      const duration = data.durationSeconds || 0;
      if (duration > 0) {
        updates.push(
          "queue_active_seconds = queue_active_seconds + $" + paramIndex,
        );
        values.push(duration);
        paramIndex++;
      }
    } else if (activityType === "queue_deactivate") {
      updates.push("queue_deactivation_count = queue_deactivation_count + 1");
    } else if (activityType === "call_end") {
      updates.push("call_count = call_count + 1");
      const duration = data.durationSeconds || 0;
      if (duration > 0) {
        updates.push("call_seconds = call_seconds + $" + paramIndex);
        values.push(duration);
        paramIndex++;
      }
    }

    if (updates.length === 0) return;

    // Update the record
    values.push(userId, trackingDate, trackingHour);
    const q = `
      UPDATE cc_user_time_tracking
      SET ${updates.join(", ")}, updated_at = NOW()
      WHERE user_id = $${paramIndex} AND tracking_date = $${
        paramIndex + 1
      } AND tracking_hour = $${paramIndex + 2}
    `;

    try {
      await pool.query(q, values);
    } catch (err) {
      console.error("[TimeTracking] Update error:", err);
    }
  },

  async getUserActivityLog(userId, options = {}) {
    const pool = getPostgresPool();
    if (!pool) return { rows: [], count: 0 };

    const where = ["user_id = $1"];
    const vals = [userId];
    let paramIndex = 2;

    if (options.activityType) {
      where.push(`activity_type = $${paramIndex++}`);
      vals.push(options.activityType);
    }

    if (options.startDate) {
      where.push(`created_at >= $${paramIndex++}`);
      vals.push(options.startDate);
    }

    if (options.endDate) {
      where.push(`created_at <= $${paramIndex++}`);
      vals.push(options.endDate);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;
    const page = Math.max(1, options.page || 1);
    const pageSize = Math.min(100, Math.max(1, options.pageSize || 50));
    const offset = (page - 1) * pageSize;

    const sql = `
      SELECT * FROM cc_user_activity_log
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    vals.push(pageSize, offset);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(sql, vals),
      pool.query(
        `SELECT COUNT(*) AS c FROM cc_user_activity_log ${whereSql}`,
        vals.slice(0, -2),
      ),
    ]);

    return {
      rows: rowsRes.rows || [],
      count: Number(countRes.rows?.[0]?.c || 0),
    };
  },

  async getUserTimeTracking(userId, options = {}) {
    const pool = getPostgresPool();
    if (!pool) return { rows: [], summary: null };

    const where = ["user_id = $1"];
    const vals = [userId];
    let paramIndex = 2;

    if (options.startDate) {
      where.push(`tracking_date >= $${paramIndex++}`);
      vals.push(options.startDate);
    }

    if (options.endDate) {
      where.push(`tracking_date <= $${paramIndex++}`);
      vals.push(options.endDate);
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    // Get detailed records
    const detailSql = `
      SELECT * FROM cc_user_time_tracking
      ${whereSql}
      ORDER BY tracking_date DESC, tracking_hour DESC
    `;

    // Get summary aggregates
    const summarySql = `
      SELECT
        SUM(logged_in_seconds) as total_logged_in_seconds,
        SUM(active_seconds) as total_active_seconds,
        SUM(break_seconds) as total_break_seconds,
        SUM(call_seconds) as total_call_seconds,
        SUM(queue_active_seconds) as total_queue_active_seconds,
        SUM(status_available_seconds) as total_status_available_seconds,
        SUM(status_busy_seconds) as total_status_busy_seconds,
        SUM(status_away_seconds) as total_status_away_seconds,
        SUM(status_on_queue_seconds) as total_status_on_queue_seconds,
        SUM(status_off_queue_seconds) as total_status_off_queue_seconds,
        SUM(login_count) as total_login_count,
        SUM(status_change_count) as total_status_change_count,
        SUM(queue_activation_count) as total_queue_activation_count,
        SUM(queue_deactivation_count) as total_queue_deactivation_count,
        SUM(call_count) as total_call_count
      FROM cc_user_time_tracking
      ${whereSql}
    `;

    const [detailRes, summaryRes] = await Promise.all([
      pool.query(detailSql, vals),
      pool.query(summarySql, vals.slice(0, -2)),
    ]);

    return {
      rows: detailRes.rows || [],
      summary: summaryRes.rows?.[0] || null,
    };
  },

  // Contact management functions
  async findContactById(id) {
    const pool = getPostgresPool();
    if (!pool) return null;
    const r = await pool.query(
      `SELECT * FROM contacts WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    return r.rows?.[0] || null;
  },

  async findContactByPhoneNumber(phoneNumber) {
    const pool = getPostgresPool();
    if (!pool) {
      return null;
    }
    if (!phoneNumber) {
      return null;
    }

    // Normalize phone number for search (remove spaces, dashes, etc.)
    const normalizedPhone = phoneNumber.trim();
    const searchPattern = `%${normalizedPhone}%`;

    // Search in all phone columns
    const r = await pool.query(
      `SELECT * FROM contacts 
       WHERE (phone ILIKE $1 OR mobile ILIKE $1 OR business_phone_1 ILIKE $1 
              OR business_phone_2 ILIKE $1 OR home_phone_1 ILIKE $1 OR home_phone_2 ILIKE $1)
       AND deleted_at IS NULL 
       ORDER BY last_interaction_at DESC NULLS LAST, created_at DESC 
       LIMIT 1`,
      [searchPattern],
    );

    const contact = r.rows?.[0] || null;

    return contact;
  },

  async findContactByEmail(email) {
    const pool = getPostgresPool();
    if (!pool) return null;
    // Search in email columns
    const r = await pool.query(
      `SELECT * FROM contacts 
       WHERE (email_address_1 ILIKE $1 OR email_address_2 ILIKE $1)
       AND deleted_at IS NULL 
       ORDER BY last_interaction_at DESC NULLS LAST, created_at DESC 
       LIMIT 1`,
      [`%${email}%`],
    );
    return r.rows?.[0] || null;
  },

  async listContacts(filters = {}) {
    const pool = getPostgresPool();
    if (!pool) return { rows: [], count: 0 };

    const {
      page = 1,
      pageSize = 20,
      q,
      phone,
      email,
      company,
      tag,
      category,
    } = filters;

    const offset = (page - 1) * pageSize;
    const where = ["deleted_at IS NULL"];
    const vals = [];
    let i = 1;

    if (q) {
      where.push(
        `(first_name ILIKE $${i} OR last_name ILIKE $${i} OR display_name ILIKE $${i} OR company_name ILIKE $${i} OR notes ILIKE $${i})`,
      );
      vals.push(`%${q}%`);
      i += 1;
    }
    if (phone) {
      where.push(
        `(phone ILIKE $${i} OR mobile ILIKE $${i} OR business_phone_1 ILIKE $${i} OR business_phone_2 ILIKE $${i} OR home_phone_1 ILIKE $${i} OR home_phone_2 ILIKE $${i})`,
      );
      vals.push(`%${phone}%`);
      i += 1;
    }
    if (email) {
      where.push(
        `(email_address_1 ILIKE $${i} OR email_address_2 ILIKE $${i})`,
      );
      vals.push(`%${email}%`);
      i += 1;
    }
    if (company) {
      where.push(`company_name ILIKE $${i}`);
      vals.push(`%${company}%`);
      i += 1;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rowsSql = `SELECT * FROM contacts ${whereSql} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    const [rowsRes, countRes] = await Promise.all([
      pool.query(rowsSql, vals),
      pool.query(`SELECT COUNT(*) AS c FROM contacts ${whereSql}`, vals),
    ]);

    return {
      rows: rowsRes.rows || [],
      count: Number(countRes.rows?.[0]?.c || 0),
    };
  },

  async createContact(data) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const id = data.id || randomUUID();
    const now = new Date().toISOString();

    const query = `
      INSERT INTO contacts (
        id, first_name, last_name, display_name, company_name, job_title, department,
        phone, mobile, business_phone_1, business_phone_2, home_phone_1, home_phone_2,
        email_address_1, email_address_2,
        address_street, address_city, address_state, address_zip, address_country,
        notes, created_by, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
      ) RETURNING *
    `;
    const result = await pool.query(query, [
      id,
      data.first_name || null,
      data.last_name || null,
      data.display_name || null,
      data.company_name || null,
      data.job_title || null,
      data.department || null,
      data.phone || null,
      data.mobile || null,
      data.business_phone_1 || null,
      data.business_phone_2 || null,
      data.home_phone_1 || null,
      data.home_phone_2 || null,
      data.email_address_1 || null,
      data.email_address_2 || null,
      data.address_street || null,
      data.address_city || null,
      data.address_state || null,
      data.address_zip || null,
      data.address_country || null,
      data.notes || null,
      data.created_by || null,
      now,
      now,
    ]);
    return result.rows[0];
  },

  async updateContact(id, data) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    const updates = [];
    const vals = [];
    let i = 1;

    const maybeSet = (key, val, json = false) => {
      if (val !== undefined) {
        updates.push(`${key}=$${i}`);
        vals.push(json ? JSON.stringify(val) : val);
        i += 1;
      }
    };

    maybeSet("first_name", data.first_name);
    maybeSet("last_name", data.last_name);
    maybeSet("display_name", data.display_name);
    maybeSet("company_name", data.company_name);
    maybeSet("job_title", data.job_title);
    maybeSet("department", data.department);
    maybeSet("phone", data.phone);
    maybeSet("mobile", data.mobile);
    maybeSet("business_phone_1", data.business_phone_1);
    maybeSet("business_phone_2", data.business_phone_2);
    maybeSet("home_phone_1", data.home_phone_1);
    maybeSet("home_phone_2", data.home_phone_2);
    maybeSet("email_address_1", data.email_address_1);
    maybeSet("email_address_2", data.email_address_2);
    maybeSet("address_street", data.address_street);
    maybeSet("address_city", data.address_city);
    maybeSet("address_state", data.address_state);
    maybeSet("address_zip", data.address_zip);
    maybeSet("address_country", data.address_country);
    maybeSet("notes", data.notes);
    maybeSet("updated_by", data.updated_by);

    if (updates.length === 0) {
      throw new Error("Nothing to update");
    }

    updates.push(`updated_at=$${i}`);
    vals.push(new Date().toISOString());
    i += 1;
    vals.push(id);

    const query = `UPDATE contacts SET ${updates.join(
      ", ",
    )} WHERE id=$${i} AND deleted_at IS NULL RETURNING *`;
    const result = await pool.query(query, vals);
    if (result.rows.length === 0) {
      throw new Error("Contact not found");
    }
    return result.rows[0];
  },

  async deleteContact(id) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");
    // Soft delete
    const result = await pool.query(
      `UPDATE contacts SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
      [id],
    );
    if (result.rows.length === 0) {
      throw new Error("Contact not found");
    }
    return true;
  },

  async updateContactInteractionStats(contactId) {
    const pool = getPostgresPool();
    if (!pool) return;
    // Update interaction count and last interaction time
    // Search across all phone number columns
    await pool.query(
      `UPDATE contacts 
       SET interaction_count = (
         SELECT COUNT(*) FROM cc_interactions 
         WHERE (from_number = phone OR from_number = mobile 
                OR from_number = business_phone_1 OR from_number = business_phone_2
                OR from_number = home_phone_1 OR from_number = home_phone_2
                OR to_number = phone OR to_number = mobile 
                OR to_number = business_phone_1 OR to_number = business_phone_2
                OR to_number = home_phone_1 OR to_number = home_phone_2)
       ),
       last_interaction_at = (
         SELECT MAX(created_at) FROM cc_interactions 
         WHERE (from_number = phone OR from_number = mobile 
                OR from_number = business_phone_1 OR from_number = business_phone_2
                OR from_number = home_phone_1 OR from_number = home_phone_2
                OR to_number = phone OR to_number = mobile 
                OR to_number = business_phone_1 OR to_number = business_phone_2
                OR to_number = home_phone_1 OR to_number = home_phone_2)
       )
       WHERE id = $1`,
      [contactId],
    );
  },
};
