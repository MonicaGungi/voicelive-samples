import { AIProjectClient } from "@azure/ai-projects";
import { AzureCliCredential } from "@azure/identity";

const endpoint = process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT;
const agent = process.env.AZURE_EXISTING_AGENT_ID?.split(":")[0] || "resource-planner-voice-agent";
const storeName = process.env.AZURE_MEMORY_STORE_NAME || "requirements-memory";
const client = new AIProjectClient(endpoint, new AzureCliCredential());
const log = (k, v) => console.log(k, typeof v === "string" ? v : JSON.stringify(v));
const section = (s) => console.log(`\n=== ${s} ===`);

async function listAll(iter, max = 200) { const out = []; for await (const x of iter) { out.push(x); if (out.length >= max) break; } return out; }

section("A. conversations before");
let before = [];
try { before = await listAll(client.beta.voiceAgents.conversations.list(agent)); log("count", before.length); } catch (e) { log("list error", `${e.statusCode} ${e.message}`); }

section("B. voice session store:true + metadata + text input");
let convId;
try {
  const session = await client.beta.voiceAgents.realtime.connect(agent, { transport: "websocket", store: true, connectionTimeoutInMs: 30000 });
  const types = new Map();
  let done = 0;
  const timer = setTimeout(() => session.dispose().catch(() => {}), 60000);
  (async () => { await session.closed; })();
  for await (const ev of session) {
    types.set(ev.type, (types.get(ev.type) || 0) + 1);
    if (ev.type === "session.created") {
      convId = ev.conversation_id;
      log("session.created conversation_id", convId);
      log("session.created keys", Object.keys(ev));
      await session.configureSession({ type: "realtime", metadata: { spike_user: "tenant:oid-test", spike_project: "proj-test" } });
      await session.sendText("Spike test. Please just reply with one short sentence.");
    }
    if (ev.type === "session.updated") log("session.updated metadata", ev.session?.metadata);
    if (ev.type === "response.done") { done++; if (done >= 1) break; }
    if (ev.type === "error") log("error event", ev);
  }
  clearTimeout(timer);
  log("event types", Object.fromEntries(types));
  await session.dispose().catch(() => {});
} catch (e) { log("session error", `${e.statusCode ?? ""} ${e.message}`); }

section("C. list / get / items");
try {
  const after = await listAll(client.beta.voiceAgents.conversations.list(agent));
  log("count after", after.length);
  log("new ids", after.filter(c => !before.some(b => b.id === c.id)).map(c => ({ id: c.id, status: c.status, metadata: c.metadata })));
  log("list item shape keys", after[0] ? Object.keys(after[0]) : []);
  if (convId) {
    const got = await client.beta.voiceAgents.conversations.get(agent, convId);
    log("get", { id: got.id, status: got.status, metadata: got.metadata });
    const items = await listAll(client.beta.voiceAgents.conversations.listItems(agent, convId));
    log("items", items.map(i => ({ type: i.type, role: i.role, content: (i.content || []).map(c => ({ type: c.type, text: c.text?.slice?.(0, 80), transcript: c.transcript?.slice?.(0, 80) })) })));
  }
} catch (e) { log("C error", `${e.statusCode ?? ""} ${e.message}`); }

section("D. memory: explicit memory vs extraction");
const scope = `spike-${Date.now()}`;
try {
  const created = await client.beta.memoryStores.createMemory(storeName, scope, "Stakeholder role for project proj-test: Head of Finance", "user_profile");
  log("created", { id: created.memory_id, kind: created.kind });
  const created2 = await client.beta.memoryStores.createMemory(storeName, scope, "Stakeholder role for project proj-test (procedural): Head of Finance", "procedural");
  log("created2", { id: created2.memory_id, kind: created2.kind });
  const snap = async () => (await listAll(client.beta.memoryStores.listMemories(storeName, scope))).map(m => ({ id: m.memory_id, kind: m.kind, content: m.content }));
  log("before extraction", await snap());
  const poller = client.beta.memoryStores.updateMemories(storeName, scope, {
    updateDelayInSecs: 0,
    items: [
      { type: "message", role: "user", content: "Actually I am the CTO and I prefer short, bulleted summaries. We discussed an invoicing API requirement." },
      { type: "message", role: "assistant", content: "Noted. Recording the invoicing API requirement." },
    ],
  });
  const res = await poller.pollUntilDone();
  log("update result", res);
  log("after extraction 1", await snap());
  const poller2 = client.beta.memoryStores.updateMemories(storeName, scope, {
    updateDelayInSecs: 0,
    items: [{ type: "message", role: "user", content: "Correction: my role is Chief Product Officer, not CTO, and not Head of Finance." }],
  });
  await poller2.pollUntilDone();
  log("after extraction 2 (contradiction)", await snap());
  const listed = await listAll(client.beta.memoryStores.listMemories(storeName, scope, { kind: "user_profile" }));
  log("kind filter user_profile count", listed.length);
} catch (e) { log("D error", `${e.statusCode ?? ""} ${e.message}`); }

section("E. long scope name");
const longScope = `spike-${"x".repeat(150)}`;
try {
  const m = await client.beta.memoryStores.createMemory(storeName, longScope, "long scope test", "user_profile");
  log("long scope (156 chars) accepted", m.memory_id);
  await client.beta.memoryStores.deleteScope(storeName, longScope);
} catch (e) { log("long scope error", `${e.statusCode ?? ""} ${e.message}`); }

section("cleanup");
try { await client.beta.memoryStores.deleteScope(storeName, scope); log("scope deleted", scope); } catch (e) { log("scope delete error", e.message); }
try { if (convId) { await client.beta.voiceAgents.conversations.delete(agent, convId); log("conversation deleted", convId); } } catch (e) { log("conv delete error", e.message); }
