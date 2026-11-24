import { AIProjectClient } from "@azure/ai-projects";
import { AzureCliCredential } from "@azure/identity";

const endpoint = process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT;
const agent = process.env.AZURE_EXISTING_AGENT_ID?.split(":")[0] || "resource-planner-voice-agent";
const storeName = process.env.AZURE_MEMORY_STORE_NAME || "requirements-memory";
const client = new AIProjectClient(endpoint, new AzureCliCredential());
const log = (k, v) => console.log(k, typeof v === "string" ? v : JSON.stringify(v));
const section = (s) => console.log(`\n=== ${s} ===`);
async function listAll(iter, max = 200) { const out = []; for await (const x of iter) { out.push(x); if (out.length >= max) break; } return out; }

section("F. agent definition store flag + existing conversations (read-only)");
try {
  const versions = await listAll(client.agents.listVersions(agent));
  const latest = versions.sort((a, b) => Number(b.version) - Number(a.version))[0];
  const v = await client.agents.getVersion(agent, latest.version, { requestOptions: { headers: { "foundry-features": "VoiceAgents=V1Preview" } } });
  log("agent version", latest.version);
  log("definition.store", v.definition.store);
} catch (e) { log("F error", `${e.statusCode ?? ""} ${e.message}`); }
try {
  const all = await listAll(client.beta.voiceAgents.conversations.list(agent));
  log("existing count", all.length);
  log("with metadata", all.filter(c => c.metadata && Object.keys(c.metadata).length).length);
  const dates = all.map(c => c.created_at).sort();
  log("oldest/newest", [dates[0], dates[dates.length - 1]]);
} catch (e) { log("list error", e.message); }

async function runSession(opts, steps) {
  const session = await client.beta.voiceAgents.realtime.connect(agent, { transport: "websocket", connectionTimeoutInMs: 30000, ...opts });
  const types = new Map(); let convId; let done = 0; let sent = false;
  const timer = setTimeout(() => session.dispose().catch(() => {}), 60000);
  for await (const ev of session) {
    types.set(ev.type, (types.get(ev.type) || 0) + 1);
    if (ev.type === "session.created") { convId = ev.conversation_id; await steps.onCreated?.(session, ev); }
    if (ev.type === "response.done") { done++; if (!sent) { sent = true; await session.sendText("Spike test. Reply with one short sentence."); } else break; }
    if (ev.type === "error") log("error", ev.error?.message);
  }
  clearTimeout(timer); await session.dispose().catch(() => {});
  return { convId, types: Object.fromEntries(types) };
}

section("G. store:true, metadata via session.update + query, wait for greeting then text turn");
const created = [];
try {
  const r = await runSession({ store: true, query: { metadata: "spike" } }, { onCreated: async (s) => { await s.configureSession({ type: "realtime", metadata: { spike_user: "u1", spike_project: "p1" } }); } });
  created.push(r.convId); log("G result", r);
  const got = await client.beta.voiceAgents.conversations.get(agent, r.convId);
  log("G metadata", got.metadata ?? null);
  const items = await listAll(client.beta.voiceAgents.conversations.listItems(agent, r.convId));
  log("G items", items.map(i => ({ type: i.type, role: i.role, c: (i.content || []).map(c => `${c.type}:${(c.text || c.transcript || "").slice(0, 60)}`) })));
} catch (e) { log("G error", `${e.statusCode ?? ""} ${e.message}`); }

section("H. attempt resume via query param conversation_id");
try {
  const r = await runSession({ store: true, query: { conversation_id: created[0] } }, {});
  created.push(r.convId); log("H new conv id", r.convId); log("H same as previous", r.convId === created[0]);
} catch (e) { log("H error", `${e.statusCode ?? ""} ${e.message}`); }

section("I. memory extraction vs explicit memory");
const scope = `spike-${Date.now()}`;
try {
  await client.beta.memoryStores.createMemory(storeName, scope, "Stakeholder role for project proj-test: Head of Finance", "user_profile");
  const snap = async () => (await listAll(client.beta.memoryStores.listMemories(storeName, scope))).map(m => ({ id: m.memory_id.slice(-6), kind: m.kind, content: m.content }));
  log("before", await snap());
  await client.beta.memoryStores.updateMemories(storeName, scope, { updateDelayInSecs: 0, items: [
    { type: "message", role: "user", content: "I prefer short bulleted summaries. We discussed an invoicing API requirement for the finance team." },
    { type: "message", role: "assistant", content: "Noted the invoicing API requirement." },
  ] }).pollUntilDone();
  log("after unrelated extraction", await snap());
  await client.beta.memoryStores.updateMemories(storeName, scope, { updateDelayInSecs: 0, items: [
    { type: "message", role: "user", content: "Correction: my role on this project is Chief Product Officer, not Head of Finance." },
  ] }).pollUntilDone();
  log("after contradicting extraction", await snap());
} catch (e) { log("I error", `${e.statusCode ?? ""} ${e.message}`); }

section("cleanup");
try { await client.beta.memoryStores.deleteScope(storeName, scope); log("scope deleted", scope); } catch (e) { log("scope delete", e.message); }
for (const id of created.filter(Boolean)) { try { await client.beta.voiceAgents.conversations.delete(agent, id); log("deleted", id); } catch (e) { log("conv delete", e.message); } }
