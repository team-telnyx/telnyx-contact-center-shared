import crypto from "crypto";
import { getPostgresPool } from "@/lib/postgres.mjs";

function normalizeTool(tool) {
  if (tool?.type === "function" && tool.function) {
    return {
      name: tool.function.name || "",
      description: tool.function.description || "",
      input_schema: tool.function.parameters || tool.function.input_schema || tool.function.inputSchema || {},
      output_schema: tool.function.output_schema || tool.function.outputSchema || null,
      type: tool.type,
    };
  }
  return {
    name: tool?.name || "",
    title: tool?.title || tool?.annotations?.title || null,
    description: tool?.description || "",
    input_schema: tool?.input_schema || tool?.inputSchema || tool?.parameters || {},
    output_schema: tool?.output_schema || tool?.outputSchema || null,
    type: tool?.type || "function",
  };
}

function schemaHash(schema) {
  return crypto.createHash("sha256").update(JSON.stringify(schema || {})).digest("hex");
}

function rowToServer(row, tools = undefined) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    type: row.type,
    url: row.url,
    auth_type: row.auth_type || "none",
    auth_header_name: row.auth_header_name || null,
    auth_scheme: row.auth_scheme || null,
    auth_secret_name: row.auth_secret_name || row.api_key_ref || null,
    api_key_ref: row.auth_secret_name || row.api_key_ref || null,
    headers: row.headers || {},
    allowed_tools: Array.isArray(row.allowed_tools) ? row.allowed_tools : [],
    enabled: row.enabled !== false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tools,
  };
}

function rowToTool(row) {
  if (!row) return null;
  return {
    id: row.id,
    mcp_server_id: row.mcp_server_id,
    name: row.name,
    title: row.title || null,
    description: row.description || "",
    input_schema: row.input_schema || {},
    inputSchema: row.input_schema || {},
    output_schema: row.output_schema || null,
    schema_hash: row.schema_hash || null,
    enabled: row.enabled !== false,
    last_discovered_at: row.last_discovered_at,
  };
}

export function normalizeMcpTools(tools) {
  const raw = Array.isArray(tools?.tools) ? tools.tools : Array.isArray(tools) ? tools : [];
  return raw.map(normalizeTool).filter((tool) => tool.name);
}

export async function listMcpServers({ includeTools = false } = {}) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  const result = await pool.query(`
    SELECT * FROM mcp_servers
    WHERE deleted_at IS NULL
    ORDER BY name ASC, created_at DESC
  `);
  if (!includeTools) return result.rows.map((row) => rowToServer(row));
  const ids = result.rows.map((row) => row.id);
  const toolsByServer = new Map();
  if (ids.length > 0) {
    const tools = await pool.query(`
      SELECT * FROM mcp_server_tools
      WHERE mcp_server_id = ANY($1) AND enabled = true
      ORDER BY name ASC
    `, [ids]);
    tools.rows.forEach((row) => {
      if (!toolsByServer.has(row.mcp_server_id)) toolsByServer.set(row.mcp_server_id, []);
      toolsByServer.get(row.mcp_server_id).push(rowToTool(row));
    });
  }
  return result.rows.map((row) => rowToServer(row, toolsByServer.get(row.id) || []));
}

export async function getMcpServer(id, { includeTools = false } = {}) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  const result = await pool.query(`
    SELECT * FROM mcp_servers
    WHERE id = $1 AND deleted_at IS NULL
  `, [id]);
  const server = rowToServer(result.rows[0]);
  if (!server || !includeTools) return server;
  server.tools = await listMcpServerTools(id, { enabledOnly: false });
  return server;
}

export async function createMcpServer(data = {}) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  const allowedTools = Array.isArray(data.allowed_tools) ? data.allowed_tools : [];
  const result = await pool.query(`
    INSERT INTO mcp_servers (
      name, description, type, url, auth_type, auth_header_name, auth_scheme,
      auth_secret_name, headers, allowed_tools, enabled, created_by, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13)
    RETURNING *
  `, [
    String(data.name || "").trim(),
    data.description ? String(data.description) : null,
    String(data.type || "sse").trim(),
    String(data.url || "").trim(),
    String(data.auth_type || (data.api_key_ref ? "bearer" : "none")).trim(),
    data.auth_header_name ? String(data.auth_header_name).trim() : null,
    data.auth_scheme ? String(data.auth_scheme).trim() : null,
    data.auth_secret_name || data.api_key_ref ? String(data.auth_secret_name || data.api_key_ref).trim() : null,
    JSON.stringify(data.headers && typeof data.headers === "object" ? data.headers : {}),
    JSON.stringify(allowedTools),
    data.enabled !== false,
    data.created_by || null,
    data.updated_by || data.created_by || null,
  ]);
  const server = rowToServer(result.rows[0]);
  if (Array.isArray(data.tools) && data.tools.length > 0) {
    await upsertMcpServerTools(server.id, data.tools);
    server.tools = await listMcpServerTools(server.id);
  }
  return server;
}

export async function updateMcpServer(id, data = {}) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  const allowedTools = Array.isArray(data.allowed_tools) ? data.allowed_tools : [];
  const result = await pool.query(`
    UPDATE mcp_servers SET
      name = $2,
      description = $3,
      type = $4,
      url = $5,
      auth_type = $6,
      auth_header_name = $7,
      auth_scheme = $8,
      auth_secret_name = $9,
      headers = $10::jsonb,
      allowed_tools = $11::jsonb,
      enabled = $12,
      updated_by = $13,
      updated_at = NOW()
    WHERE id = $1 AND deleted_at IS NULL
    RETURNING *
  `, [
    id,
    String(data.name || "").trim(),
    data.description ? String(data.description) : null,
    String(data.type || "sse").trim(),
    String(data.url || "").trim(),
    String(data.auth_type || (data.api_key_ref ? "bearer" : "none")).trim(),
    data.auth_header_name ? String(data.auth_header_name).trim() : null,
    data.auth_scheme ? String(data.auth_scheme).trim() : null,
    data.auth_secret_name || data.api_key_ref ? String(data.auth_secret_name || data.api_key_ref).trim() : null,
    JSON.stringify(data.headers && typeof data.headers === "object" ? data.headers : {}),
    JSON.stringify(allowedTools),
    data.enabled !== false,
    data.updated_by || null,
  ]);
  const server = rowToServer(result.rows[0]);
  if (!server) return null;
  if (Array.isArray(data.tools)) {
    await upsertMcpServerTools(server.id, data.tools);
    server.tools = await listMcpServerTools(server.id, { enabledOnly: false });
  }
  return server;
}

export async function deleteMcpServer(id) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  await pool.query(`UPDATE mcp_servers SET deleted_at = NOW(), updated_at = NOW(), enabled = false WHERE id = $1`, [id]);
}

export async function listMcpServerTools(serverId, { enabledOnly = true } = {}) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  const result = await pool.query(`
    SELECT * FROM mcp_server_tools
    WHERE mcp_server_id = $1 ${enabledOnly ? "AND enabled = true" : ""}
    ORDER BY name ASC
  `, [serverId]);
  return result.rows.map(rowToTool);
}

export async function getMcpServerTool(serverId, toolName) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  const result = await pool.query(`
    SELECT * FROM mcp_server_tools
    WHERE mcp_server_id = $1 AND name = $2 AND enabled = true
  `, [serverId, toolName]);
  return rowToTool(result.rows[0]);
}

export async function upsertMcpServerTools(serverId, tools = []) {
  const pool = getPostgresPool();
  if (!pool) throw new Error("Postgres not configured");
  const normalized = normalizeMcpTools(tools);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const tool of normalized) {
      const inputSchema = tool.input_schema || {};
      await client.query(`
        INSERT INTO mcp_server_tools (
          mcp_server_id, name, title, description, input_schema, output_schema, schema_hash, enabled, last_discovered_at
        ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,true,NOW())
        ON CONFLICT (mcp_server_id, name) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          input_schema = EXCLUDED.input_schema,
          output_schema = EXCLUDED.output_schema,
          schema_hash = EXCLUDED.schema_hash,
          enabled = true,
          last_discovered_at = NOW(),
          updated_at = NOW()
      `, [
        serverId,
        tool.name,
        tool.title || null,
        tool.description || null,
        JSON.stringify(inputSchema),
        tool.output_schema ? JSON.stringify(tool.output_schema) : null,
        schemaHash(inputSchema),
      ]);
    }
    if (normalized.length > 0) {
      await client.query(`
        UPDATE mcp_server_tools
        SET enabled = false, updated_at = NOW()
        WHERE mcp_server_id = $1 AND name <> ALL($2)
      `, [serverId, normalized.map((tool) => tool.name)]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return listMcpServerTools(serverId, { enabledOnly: false });
}
