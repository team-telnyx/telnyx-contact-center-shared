export function assistantInvitePolicy(config = {}) {
  return {
    enabled: config.enabled !== false && config.enable_assistant_invite === true,
    assistantIds: [...new Set((Array.isArray(config.invite_assistant_ids) ? config.invite_assistant_ids : []).filter(id => typeof id === "string" && /^assistant-[a-f0-9-]{36}$/i.test(id)))].slice(0, 100),
  };
}

export function savedInviteAssistants(config = {}) {
  const names = new Map((Array.isArray(config.invite_assistants) ? config.invite_assistants : [])
    .filter(item => item && typeof item.name === "string").map(item => [item.id, item.name]));
  return assistantInvitePolicy(config).assistantIds.map(id => ({ id, name: names.get(id) || id }));
}

export async function hasSkipTurnTool(assistant, request) {
  const attached = (assistant.tools || []).filter(tool => !tool.tool_id || assistant.tool_ids === undefined || assistant.tool_ids.includes(tool.tool_id));
  if (attached.some(tool => tool.type === "skip_turn")) return true;
  const resolved = new Set(attached.filter(tool => tool.type).map(tool => tool.tool_id));
  const ids = new Set([...(assistant.tool_ids || []), ...attached.map(tool => tool.tool_id).filter(Boolean)]);
  for (const id of ids) {
    if (resolved.has(id)) continue;
    const result = await request(`/ai/tools/${encodeURIComponent(id)}`);
    if ((result.data || result).type === "skip_turn") return true;
  }
  return false;
}

async function readInviteAssistant(id, request) {
  if (!/^assistant-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id || "")) throw Object.assign(new Error("Invalid assistant ID."), { status: 400 });
  const result = await request(`/ai/assistants/${encodeURIComponent(id)}`);
  const assistant = result.data || result;
  if (assistant.id !== id) throw Object.assign(new Error("Selected assistant is unavailable."), { status: 409 });
  return assistant;
}

export async function inspectInviteAssistant(id, request) {
  const assistant = await readInviteAssistant(id, request);
  return { id, name: assistant.name || id, skipTurn: await hasSkipTurnTool(assistant, request) };
}

export async function assertInviteAssistant(id, request) {
  const assistant = await readInviteAssistant(id, request);
  if (!await hasSkipTurnTool(assistant, request)) throw Object.assign(new Error(`Add the Skip Turn tool to ${assistant.name || id} before inviting it to a call.`), { status: 409 });
  return assistant;
}

export async function listInviteAssistants(request, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  // Load names only. Tool verification belongs to explicit selection and save,
  // so opening this list never performs one detail request per assistant.
  const read = async path => {
    for (let attempt = 0; ; attempt++) {
      try { return await request(path); }
      catch (error) {
        if (error.status !== 429 || attempt >= 3) throw error;
        await wait(1000 * (attempt + 1));
      }
    }
  };
  const items = new Map();
  for (let page = 1; page <= 100; page++) {
    if (page > 1) await wait(200);
    const result = await read(`/ai/assistants?page[number]=${page}&page[size]=100`);
    for (const assistant of result.data || []) items.set(assistant.id, { id: assistant.id, name: assistant.name || assistant.id });
    if (page >= Number(result.meta?.total_pages || 1)) break;
  }
  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function validateFlowAssistantInvites(nodes, request) {
  const ids = new Set();
  for (const node of nodes || []) {
    if (node.data?.nodeType !== "agent_assist") continue;
    const policy = assistantInvitePolicy(node.data.config);
    if (!policy.enabled) continue;
    if (!policy.assistantIds.length) throw Object.assign(new Error("Select at least one assistant for Enable assistant invite."), { status: 400 });
    policy.assistantIds.forEach(id => ids.add(id));
  }
  const assistants = [];
  for (const id of ids) assistants.push(await assertInviteAssistant(id, request));
  return assistants;
}
