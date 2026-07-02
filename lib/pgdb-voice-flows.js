import { getPostgresPool } from "./postgres.mjs";
import { randomUUID } from "crypto";

function nowIso() {
  return new Date().toISOString();
}

export const VoiceFlowDb = {
  /**
   * Create a new voice flow
   */
  async createFlow(username, flowData) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const id = flowData?.id || randomUUID();
    const q = `
      INSERT INTO voice_flows (
        id, username, name, description, telnyx_voice_app_id, webhook_url, nodes, edges, variables, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )
      RETURNING *;
    `;
    const vals = [
      id,
      username,
      flowData.name || "Untitled Flow",
      flowData.description || null,
      flowData.telnyx_voice_app_id || null,
      flowData.webhook_url || null,
      JSON.stringify(flowData.nodes || []),
      JSON.stringify(flowData.edges || []),
      JSON.stringify(flowData.variables || {}),
      JSON.stringify(flowData.metadata || {}),
      nowIso(),
      nowIso(),
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0] || null;
  },

  /**
   * Get flow by ID for a specific user
   * If username is null, returns flow by ID only (for public access like HTTP triggers or admin access)
   */
  async getFlowById(id, username) {
    const pool = getPostgresPool();
    if (!pool) return null;

    let query, params;
    if (username === null || username === undefined) {
      // Public/admin access - no username filter
      query = "SELECT * FROM voice_flows WHERE id=$1";
      params = [id];
    } else {
      // User-specific access
      query = "SELECT * FROM voice_flows WHERE id=$1 AND username=$2";
      params = [id, username];
    }

    const r = await pool.query(query, params);
    const flow = r.rows?.[0] || null;

    // Get assigned phone numbers
    if (flow) {
      const phoneNumbers = await this.getFlowPhoneNumbers(id);
      flow.phone_numbers = phoneNumbers;
    }

    return flow;
  },

  /**
   * List flows for a user with optional filters and pagination
   * If username is null, lists all flows (for admin users)
   */
  async listFlows(username, filters = {}, pagination = {}) {
    const pool = getPostgresPool();
    if (!pool) return { items: [], total: 0 };

    const { name } = filters;
    const { page = 1, pageSize = 10 } = pagination;
    const offset = (page - 1) * pageSize;

    let whereClause = "";
    const params = [];
    let paramIndex = 1;

    // If username is null, list all flows (admin access)
    if (username !== null && username !== undefined) {
      whereClause = "WHERE username=$1";
      params.push(username);
      paramIndex = 2;
    }

    if (name) {
      if (whereClause) {
        whereClause += ` AND name ILIKE $${paramIndex}`;
      } else {
        whereClause = `WHERE name ILIKE $${paramIndex}`;
      }
      params.push(`%${name}%`);
      paramIndex++;
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM voice_flows ${whereClause}`;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows?.[0]?.total || "0", 10);

    // Get paginated results
    const dataQuery = `
      SELECT * FROM voice_flows
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(pageSize, offset);
    const dataResult = await pool.query(dataQuery, params);

    // Return flows without phone numbers - they will be fetched from Telnyx API
    const items = dataResult.rows || [];

    return {
      items,
      total,
    };
  },

  /**
   * Update a flow
   * If username is null, updates flow without username check (for admin access)
   */
  async updateFlow(id, username, updates) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const setClauses = [];
    const params = [id];
    let paramIndex = 2;
    
    // Only add username filter if username is provided (non-admin access)
    const whereClause = username !== null && username !== undefined
      ? "WHERE id=$1 AND username=$2"
      : "WHERE id=$1";
    
    if (username !== null && username !== undefined) {
      params.push(username);
      paramIndex = 3;
    }

    if (updates.name !== undefined) {
      setClauses.push(`name=$${paramIndex}`);
      params.push(updates.name);
      paramIndex++;
    }

    if (updates.description !== undefined) {
      setClauses.push(`description=$${paramIndex}`);
      params.push(updates.description);
      paramIndex++;
    }

    if (updates.telnyx_voice_app_id !== undefined) {
      setClauses.push(`telnyx_voice_app_id=$${paramIndex}`);
      params.push(updates.telnyx_voice_app_id);
      paramIndex++;
    }

    if (updates.webhook_url !== undefined) {
      setClauses.push(`webhook_url=$${paramIndex}`);
      params.push(updates.webhook_url);
      paramIndex++;
    }

    if (updates.nodes !== undefined) {
      setClauses.push(`nodes=$${paramIndex}`);
      params.push(JSON.stringify(updates.nodes));
      paramIndex++;
    }

    if (updates.edges !== undefined) {
      setClauses.push(`edges=$${paramIndex}`);
      params.push(JSON.stringify(updates.edges));
      paramIndex++;
    }

    if (updates.variables !== undefined) {
      setClauses.push(`variables=$${paramIndex}`);
      params.push(JSON.stringify(updates.variables));
      paramIndex++;
    }

    if (updates.metadata !== undefined) {
      setClauses.push(`metadata=$${paramIndex}`);
      params.push(JSON.stringify(updates.metadata));
      paramIndex++;
    }

    setClauses.push(`updated_at=$${paramIndex}`);
    params.push(nowIso());

    const q = `
      UPDATE voice_flows
      SET ${setClauses.join(", ")}
      ${whereClause}
      RETURNING *;
    `;

    const r = await pool.query(q, params);
    return r.rows?.[0] || null;
  },

  /**
   * Delete a flow
   * If username is null, deletes flow without username check (for admin access)
   */
  async deleteFlow(id, username) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    let query, params;
    if (username !== null && username !== undefined) {
      query = "DELETE FROM voice_flows WHERE id=$1 AND username=$2 RETURNING id, telnyx_voice_app_id";
      params = [id, username];
    } else {
      query = "DELETE FROM voice_flows WHERE id=$1 RETURNING id, telnyx_voice_app_id";
      params = [id];
    }

    const r = await pool.query(query, params);
    return r.rows?.[0] || null;
  },

  /**
   * Duplicate a flow
   */
  async duplicateFlow(id, username, newName) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    // Get original flow
    const original = await this.getFlowById(id, username);
    if (!original) throw new Error("Flow not found");

    // Create duplicate with new ID and name (without voice app - user needs to create new one)
    const newId = randomUUID();
    const q = `
      INSERT INTO voice_flows (
        id, username, name, description, telnyx_voice_app_id, webhook_url, nodes, edges, variables, metadata, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )
      RETURNING *;
    `;
    const vals = [
      newId,
      username,
      newName || `${original.name} (Copy)`,
      original.description,
      null, // Duplicates don't get voice app - user must create new one
      null, // Duplicates don't get webhook URL
      original.nodes,
      original.edges,
      original.variables,
      original.metadata,
      nowIso(),
      nowIso(),
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0] || null;
  },

  /**
   * Assign phone number to flow
   */
  async assignPhoneNumber(flowId, phoneNumberId, phoneNumber, assignedBy) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const id = randomUUID();
    const q = `
      INSERT INTO voice_flow_phone_numbers (
        id, flow_id, phone_number_id, phone_number, assigned_by, assigned_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
      ON CONFLICT (flow_id, phone_number_id) DO UPDATE SET
        updated_at = EXCLUDED.updated_at
      RETURNING *;
    `;
    const vals = [
      id,
      flowId,
      phoneNumberId,
      phoneNumber,
      assignedBy,
      nowIso(),
      nowIso(),
      nowIso(),
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0] || null;
  },

  /**
   * Unassign phone number from flow
   */
  async unassignPhoneNumber(flowId, phoneNumberId) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const r = await pool.query(
      "DELETE FROM voice_flow_phone_numbers WHERE flow_id=$1 AND phone_number_id=$2 RETURNING id",
      [flowId, phoneNumberId]
    );
    return r.rows?.[0] || null;
  },

  /**
   * Get all phone numbers assigned to a flow
   */
  async getFlowPhoneNumbers(flowId) {
    const pool = getPostgresPool();
    if (!pool) return [];

    const r = await pool.query(
      "SELECT * FROM voice_flow_phone_numbers WHERE flow_id=$1 ORDER BY assigned_at DESC",
      [flowId]
    );
    return r.rows || [];
  },

  /**
   * Get all phone numbers assigned to a voice application (via flows)
   */
  async getPhoneNumbersByVoiceAppId(voiceAppId) {
    const pool = getPostgresPool();
    if (!pool) return [];

    const r = await pool.query(
      `SELECT vfpn.* FROM voice_flow_phone_numbers vfpn
       INNER JOIN voice_flows vf ON vf.id = vfpn.flow_id
       WHERE vf.telnyx_voice_app_id = $1`,
      [voiceAppId]
    );
    return r.rows || [];
  },

  /**
   * Create a flow execution record
   */
  async createFlowExecution(
    flowId,
    callControlId,
    initialNodeId = null,
    initialVariables = {}
  ) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const id = randomUUID();
    const q = `
      INSERT INTO voice_flow_executions (
        id, flow_id, call_control_id, current_node_id, variables, execution_history, status, started_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      )
      RETURNING *;
    `;
    const vals = [
      id,
      flowId,
      callControlId,
      initialNodeId,
      JSON.stringify(initialVariables),
      JSON.stringify([]),
      "active",
      nowIso(),
    ];
    const r = await pool.query(q, vals);
    return r.rows?.[0] || null;
  },

  /**
   * Get flow execution by call control ID
   */
  async getFlowExecution(callControlId) {
    const pool = getPostgresPool();
    if (!pool) return null;

    const r = await pool.query(
      "SELECT * FROM voice_flow_executions WHERE call_control_id=$1 ORDER BY started_at DESC LIMIT 1",
      [callControlId]
    );
    return r.rows?.[0] || null;
  },

  /**
   * Update flow execution
   */
  async updateFlowExecution(callControlId, updates) {
    const pool = getPostgresPool();
    if (!pool) throw new Error("Postgres not configured");

    const setClauses = [];
    const params = [callControlId];
    let paramIndex = 2;

    if (updates.current_node_id !== undefined) {
      setClauses.push(`current_node_id=$${paramIndex}`);
      params.push(updates.current_node_id);
      paramIndex++;
    }

    if (updates.variables !== undefined) {
      setClauses.push(`variables=$${paramIndex}`);
      params.push(JSON.stringify(updates.variables));
      paramIndex++;
    }

    if (updates.execution_history !== undefined) {
      setClauses.push(`execution_history=$${paramIndex}`);
      params.push(JSON.stringify(updates.execution_history));
      paramIndex++;
    }

    if (updates.status !== undefined) {
      setClauses.push(`status=$${paramIndex}`);
      params.push(updates.status);
      paramIndex++;
    }

    if (updates.completed_at !== undefined) {
      setClauses.push(`completed_at=$${paramIndex}`);
      params.push(updates.completed_at);
      paramIndex++;
    }

    if (setClauses.length === 0) {
      return null;
    }

    const q = `
      UPDATE voice_flow_executions
      SET ${setClauses.join(", ")}
      WHERE call_control_id=$1
      RETURNING *;
    `;

    const r = await pool.query(q, params);
    return r.rows?.[0] || null;
  },
};
