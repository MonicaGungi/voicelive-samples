import { test } from "node:test";
import assert from "node:assert/strict";
import { FoundryMemory, InterviewMemory, memoryScope, memoryFailure } from "./memoryService.js";
import { InterviewStore } from "./interviewStore.js";
import { NativeVoiceHandler } from "./nativeVoiceHandler.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("discovery accepts a later role reply and orients before exploring gaps", () => {
  const memory = new FoundryMemory({ beta: { memoryStores: {} } });
  const context = memory.context("Selected project", [], null, true);
  assert.match(context, /including in a later turn/);
  assert.match(context, /ONE question about what they expect this project to achieve/);
  assert.match(context, /Give this orientation only once/);
  assert.match(context, /Reuse an explicitly stated prior role without asking again/);
  assert.match(context, /Current explicit role statements take precedence/);
  assert.match(context, /not authorization/);
  assert.doesNotMatch(context, /names in their first request/);
});

test("scopes are stable and cannot collide across users or projects", () => {
  assert.equal(memoryScope("alice", "planner"), memoryScope("alice", "planner"));
  assert.notEqual(memoryScope("alice", "planner"), memoryScope("bob", "planner"));
  assert.notEqual(memoryScope("alice", "planner"), memoryScope("alice", "other"));
  assert.throws(() => memoryScope("", "planner"));
  assert.throws(() => memoryScope("alice", "../planner"));
});

test("startup searches run concurrently without waiting for cloud saves and retain partial results", async () => {
  const store = new InterviewStore(":memory:");
  const project = store.createProject("alice", "Planner");
  const context = store.open("alice", project.id);
  store.record(context, "unsynced", "user", "Local expectation: fewer corrections.");
  const pendingSearches = [];
  let saves = 0;
  const coordinator = new InterviewMemory({
    load: () => new Promise((resolve, reject) => pendingSearches.push({ resolve, reject })),
    save: async () => { saves++; },
    context: () => "",
  }, store);
  try {
    const preparing = coordinator.prepare(context, "Hi");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pendingSearches.length, 3);
    assert.equal(saves, 0);
    pendingSearches[0].resolve([{ kind: "chat_summary", content: "Known project goal" }]);
    pendingSearches[1].reject(new Error("Search unavailable"));
    pendingSearches[2].resolve([]);
    const prepared = await preparing;
    assert.equal(prepared.memories.length, 1);
    assert.match(prepared.warning, /saved locally/);
    assert.match(prepared.continuityContext, /fewer corrections/);
    assert.equal(store.transcript(context, true).length, 1);
  } finally { store.close(); }
});

test("a fresh session recalls the preceding session only within its user and project", async () => {
  const saved = new Map();
  const api = {
    updateMemories(name, scope, options) {
      assert.equal(name, "requirements-memory");
      assert.equal(options.updateDelayInSecs, 0);
      return { pollUntilDone: async () => {
        saved.set(scope, options.items.map((item) => ({ memory_item: { scope, kind: "chat_summary", content: item.content } })));
        return { memory_operations: [] };
      } };
    },
    async searchMemories(name, scope) { return { memories: saved.get(scope) || [] }; },
  };
  const client = { beta: { memoryStores: api } };
  await new FoundryMemory(client).save("alice", "planner", [{ role: "user", content: "The approved budget is USD 42000 and SSO is required." }, { role: "assistant", content: "Confirmed: USD 42000 and SSO." }]);
  const nextSession = new FoundryMemory(client);
  const recalled = await nextSession.load("alice", "planner");
  assert.match(nextSession.context("planner", recalled), /42000/);
  assert.deepEqual(await nextSession.load("bob", "planner"), []);
  assert.deepEqual(await nextSession.load("alice", "other"), []);
});

test("rejects out-of-scope search responses rather than injecting foreign context", async () => {
  const memory = new FoundryMemory({ beta: { memoryStores: { searchMemories: async () => ({ memories: [{ memory_item: { scope: "another-user", content: "private" } }] }) } } });
  await assert.rejects(memory.load("alice", "planner"), /outside the authorized scope/);
});

test("project authorization is separate from scopes and shared membership cannot expose another user's interview", () => {
  const store = new InterviewStore(":memory:");
  try {
    const project = store.createProject("alice", "Product A");
    const other = store.createProject("alice", "Product B");
    const context = store.open("alice", project.id);
    store.recordConversation(context, "conv_test123");
    store.record(context, "turn1", "user", "Budget is 42000.");
    assert.throws(() => store.open("bob", project.id), /access denied/);
    assert.throws(() => store.grantAccess("bob", project.id, "bob"), /owner/);
    store.grantAccess("alice", project.id, "bob");
    assert.throws(() => store.get("bob", project.id, context.interviewId), /access denied/);
    assert.throws(() => store.get("alice", other.id, context.interviewId), /access denied/);
    assert.deepEqual(store.conversationIds(context), ["conv_test123"]);
    assert.equal(store.transcript(context)[0].content, "Budget is 42000.");
    store.markExported(context, store.transcript(context, true));
    assert.deepEqual(store.transcript(context, true), []);
  } finally { store.close(); }
});

test("memory outages retain transcripts for retry while scope violations remain fatal", async () => {
  const store = new InterviewStore(":memory:");
  const project = store.createProject("alice", "Planner");
  const context = store.open("alice", project.id);
  let unavailable = true;
  const memory = new FoundryMemory({ beta: { memoryStores: {
    searchMemories: async (name, scope) => {
      if (unavailable) throw new Error("Embedding resource authentication failed");
      return { memories: [{ memory_item: { scope: "foreign", content: "private" } }] };
    },
    updateMemories: () => ({ pollUntilDone: async () => { if (unavailable) throw new Error("Extraction failed"); return {}; } }),
  } } });
  const coordinator = new InterviewMemory(memory, store);
  try {
    const unavailableContext = await coordinator.prepare(context);
    assert.match(unavailableContext.warning, /saved locally/);
    assert.match(unavailableContext.context, /No stored project requirements were returned/);
    assert.match(unavailableContext.context, /one focused question/i);
    store.record(context, "user1", "user", "Confirmed budget 42000.");
    await assert.rejects(coordinator.finish(context), /Extraction failed/);
    assert.equal(store.transcript(context, true).length, 1);
    assert.equal(store.get("alice", project.id, context.interviewId).status, "save_failed");
    unavailable = false;
    await coordinator.flush(context);
    assert.equal(store.transcript(context, true).length, 0);
    await assert.rejects(coordinator.prepare(context), /outside the authorized scope/);
  } finally { store.close(); }
});

test("preparation includes only this user's earlier project interviews even without cloud recall", async () => {
  const store = new InterviewStore(":memory:");
  const project = store.createProject("alice", "Shared project");
  const other = store.createProject("alice", "Other project");
  const writes = [];
  const memory = new FoundryMemory({ beta: { memoryStores: {
    searchMemories: async () => { throw new Error("Memory unavailable"); },
    updateMemories: (name, scope) => {
      writes.push(scope);
      return { pollUntilDone: async () => ({}) };
    },
  } } });
  try {
    const first = store.open("alice", project.id);
    store.record(first, "first", "user", "I am HR. I expect fewer manual approvals.");
    store.record(first, "reply", "assistant", "Who approves exceptions?");
    store.setStatus(first, "completed");
    const second = store.open("alice", project.id);
    store.record(second, "second", "user", "Approval exceptions are still unresolved.");
    store.setStatus(second, "completed");
    store.grantAccess("alice", project.id, "bob");
    const foreignUser = store.open("bob", project.id);
    store.record(foreignUser, "private", "user", "BOB_PRIVATE");
    const foreignProject = store.open("alice", other.id);
    store.record(foreignProject, "unrelated", "user", "OTHER_PROJECT_PRIVATE");
    const current = { ...store.open("alice", project.id), memoryScope: "Shared-scope" };
    const coordinator = new InterviewMemory(memory, store);
    const newInterview = await coordinator.prepare(current, "Hi, I'm continuing as HR");
    assert.equal(newInterview.resumed, false);
    assert.equal(newInterview.continuingProject, true);
    assert.match(newInterview.continuityContext, /NEW INTERVIEW, RETURNING PROJECT USER/);
    assert.match(newInterview.continuityContext, /fewer manual approvals/);
    assert.match(newInterview.continuityContext, /I am HR/);
    assert.match(newInterview.continuityContext, /reuse their latest explicitly stated role/);
    assert.match(newInterview.continuityContext, /Explicit role change overrides/);
    assert.match(newInterview.continuityContext, /FIRST explain the known project purpose/);
    assert.match(newInterview.continuityContext, /THEN ask one question/);
    assert.match(newInterview.continuityContext, /Merely repeating the same role does not trigger/);
    store.record(current, "current", "user", "CURRENT_INTERVIEW");
    const prepared = await coordinator.prepare(current, "Hi");
    assert.equal(prepared.resumed, true);
    assert.match(prepared.continuityContext, /RESUMED INTERVIEW/);
    assert.match(prepared.continuityContext, /Retain the role/);
    assert.match(prepared.continuityContext, /Explicit role change overrides/);
    assert.match(prepared.context, /Do not skip the project-context sentence, greet again/);
    assert.match(prepared.context, /Earlier interviews by this same authenticated user/);
    assert.match(prepared.context, /fewer manual approvals/);
    assert.match(prepared.context, /Approval exceptions are still unresolved/);
    assert.match(prepared.context, /Assistant statements are not user confirmation/);
    assert.doesNotMatch(prepared.context, /BOB_PRIVATE|OTHER_PROJECT_PRIVATE/);
    assert.deepEqual(prepared.history.map(item => item.content), ["CURRENT_INTERVIEW"]);
    assert.equal(store.priorInterviewHistory(current).length, 3);
    assert.throws(() => store.priorInterviewHistory({ ...current, userId: "bob" }), /access denied/);
    assert.deepEqual(writes, []);
    for (let index = 0; index < 130; index++) store.record(first, `long-${index}`, "user", "x".repeat(4000));
    assert.equal(store.priorInterviewHistory(current).length, 120);
    const bounded = await coordinator.prepare(current);
    const priorJson = bounded.context.split("recency alone does not supersede a confirmed decision.\n")[1].split("\n\n")[0];
    assert.ok(priorJson.length <= 12001);
    const excerpts = JSON.parse(priorJson);
    assert.ok(excerpts.length > 0);
    assert.ok(excerpts.every(item => item.truncated && item.content.length === 2000));
  } finally { store.close(); }
});

test("project removal is owner-only, blocks active interviews, and preserves archived data", () => {
  const store = new InterviewStore(":memory:");
  try {
    const project = store.createProject("alice", "Duplicate test");
    const keep = store.createProject("alice", "Keep this project");
    assert.throws(() => store.createProject("alice", " duplicate TEST "), /already have/);
    store.grantAccess("alice", project.id, "bob");
    assert.throws(() => store.archiveProject("bob", project.id), /owner/);
    const context = store.open("bob", project.id);
    store.record(context, "user1", "user", "Keep this interview.");
    store.recordConversation(context, "conv_archive123");
    assert.throws(() => store.archiveProject("alice", project.id), /End all interviews/);
    store.setStatus(context, "saving");
    assert.throws(() => store.archiveProject("alice", project.id), /wait for memory saves/);
    store.setStatus(context, "completed");
    assert.deepEqual(store.archiveProject("alice", project.id), { archived: true });
    assert.deepEqual(store.projects("alice").map(item => item.id), [keep.id]);
    assert.deepEqual(store.projects("bob"), []);
    assert.throws(() => store.open("alice", project.id), /access denied/);
    assert.throws(() => store.get("bob", project.id, context.interviewId), /access denied/);
    assert.equal(store.db.prepare("SELECT content FROM transcripts WHERE interview_id=?").get(context.interviewId).content, "Keep this interview.");
    assert.equal(store.db.prepare("SELECT foundry_id FROM conversations WHERE interview_id=?").get(context.interviewId).foundry_id, "conv_archive123");
    assert.ok(store.createProject("alice", "Duplicate test").id);
  } finally { store.close(); }
});

test("downstream model authentication errors produce actionable messages without leaking raw details", () => {
  const inner = { deployment: "resource/deployments/text-embedding-3-small", details: { status_code: 401 } };
  const error = new Error(`Memory search failed: ${JSON.stringify({ code: "ResourceError", message: JSON.stringify(inner) })}`);
  const failure = memoryFailure(error);
  assert.equal(failure.code, "model_authentication");
  assert.match(failure.message, /text-embedding-3-small/);
  assert.match(failure.message, /resource owner/);
  assert.doesNotMatch(failure.message, /resource\/deployments/);
  assert.match(memoryFailure(new Error(`Extraction failed: ${JSON.stringify({ message: "Provided resource failed", deployment: "resource/deployments/gpt-5.6-sol", details: { status_code: 401 } })}`)).message, /gpt-5.6-sol/);
});

test("manual memory retry enforces project access and only clears pending transcripts after success", async () => {
  const store = new InterviewStore(":memory:");
  const project = store.createProject("alice", "Planner");
  const context = store.open("alice", project.id);
  let fail = true;
  const coordinator = new InterviewMemory({ save: async () => { if (fail) throw new Error("401 authentication"); }, load: async () => [] }, store);
  try {
    store.record(context, "turn1", "user", "SSO is mandatory.");
    await assert.rejects(coordinator.retry("bob", project.id), /access denied/);
    await assert.rejects(coordinator.retry("alice", project.id), /End the active interview/);
    store.setStatus(context, "save_failed");
    await assert.rejects(coordinator.retry("alice", project.id), /authentication/);
    assert.equal(store.transcript(context, true).length, 1);
    assert.match(store.get("alice", project.id, context.interviewId).memory_error, /resource owner/);
    fail = false;
    assert.deepEqual(await coordinator.retry("alice", project.id), { updated: 1, records: 0 });
    assert.equal(store.transcript(context, true).length, 0);
    assert.equal(store.get("alice", project.id, context.interviewId).status, "completed");
  } finally { store.close(); }
});

test("interview IDs, Foundry conversation IDs, and pending transcripts survive a backend restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-memory-restart-"));
  const path = join(directory, "interviews.sqlite");
  let store = new InterviewStore(path);
  try {
    const project = store.createProject("alice", "Planner");
    const context = store.open("alice", project.id);
    store.recordConversation(context, "conv_persisted123");
    store.record(context, "turn1", "user", "Confirmed SSO requirement.");
    store.close();
    store = new InterviewStore(path);
    assert.equal(store.get("alice", project.id, context.interviewId).status, "interrupted");
    const resumed = store.open("alice", project.id, context.interviewId);
    assert.equal(resumed.interviewId, context.interviewId);
    assert.deepEqual(store.conversationIds(resumed), ["conv_persisted123"]);
    assert.equal(store.transcript(resumed, true)[0].content, "Confirmed SSO requirement.");
    assert.throws(() => store.open("alice", project.id), /active interview/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("voice-session transcripts are saved and recalled in a new native voice session without overriding instructions or tools", async () => {
  const store = new InterviewStore(":memory:");
  const saved = new Map();
  const client = { beta: { memoryStores: {
    updateMemories(name, scope, options) { return { pollUntilDone: async () => {
      saved.set(scope, options.items.map((item) => ({ memory_item: { scope, kind: "chat_summary", content: item.content } })));
      return { memory_operations: [] };
    } }; },
    async searchMemories(name, scope) { return { memories: saved.get(scope) || [] }; },
  } } };
  const coordinator = new InterviewMemory(new FoundryMemory(client), store);
  const project = store.createProject("alice", "Resource Planner");
  const makeVoice = (context) => {
    const injected = [];
    const sessionUpdates = [];
    let end;
    const closed = new Promise((resolve) => { end = resolve; });
    const session = {
      async *[Symbol.asyncIterator]() { yield { type: "session.created", conversation_id: `conv_${context.interviewId}` }; await closed; },
      async sendText(text, options) { injected.push({ text, options }); },
      async configureSession(update) { sessionUpdates.push(update); },
      async dispose() { end(); },
    };
    const handler = new NativeVoiceHandler("test", "", {}, () => {}, {
      projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
      agentName: "existing", agentVersion: "10", memorySession: { coordinator, context },
    });
    handler.client = { agents: { getVersion: async () => ({ definition: { kind: "voice", instructions: "Original requirements agent instructions" } }) }, beta: { voiceAgents: { realtime: { connect: async (name, options) => {
      assert.equal(name, "existing");
      assert.equal(options.agentVersionOverride, "10");
      return session;
    } } } } };
    return { handler, injected, sessionUpdates };
  };
  try {
    const first = makeVoice(store.open("alice", project.id));
    await first.handler.start();
    first.handler.handleEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "voice1", transcript: "Our confirmed budget is USD 42000 and SSO is required." });
    first.handler.handleEvent({ type: "response.output_audio_transcript.done", item_id: "answer1", transcript: "Confirmed: USD 42000 and SSO." });
    await first.handler.stop();
    await first.handler.processing;
    const second = makeVoice(store.open("alice", project.id));
    await second.handler.start();
    assert.match(second.sessionUpdates[0].instructions, /Original requirements agent instructions/);
    assert.match(second.sessionUpdates[0].instructions, /42000/);
    assert.match(second.sessionUpdates[0].instructions, /SSO/);
    assert.equal(Object.hasOwn(second.sessionUpdates[0], "tools"), false);
    assert.equal(second.injected.length, 1);
    assert.equal(second.injected[0].options.createResponse, false);
    assert.match(second.injected[0].text, /42000/);
    assert.match(second.injected[0].text, /NEW INTERVIEW, RETURNING PROJECT USER/);
    await second.handler.stop();
    await second.handler.processing;
  } finally { store.close(); }
});

test("completed turns sync memory without ending the active voice or chat session", async () => {
  const store = new InterviewStore(":memory:");
  const project = store.createProject("alice", "Continuous interview");
  const context = store.open("alice", project.id);
  let updates = 0;
  const memory = { save: async () => { updates++; }, load: async () => [], context: () => "" };
  const coordinator = new InterviewMemory(memory, store);
  const messages = [];
  const handler = new NativeVoiceHandler("continuous", "", {}, message => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    memorySession: { coordinator, context },
  });
  try {
    handler.isRunning = true;
    store.record(context, "user1", "user", "Confirmed budget is 42000.");
    handler.activeResponse = true;
    await handler.checkpointMemory();
    assert.equal(updates, 0);
    handler.handleEvent({ type: "response.done", response: { status: "completed" } });
    assert.ok(handler.checkpointTimer);
    await handler.checkpointMemory();
    assert.equal(updates, 1);
    assert.equal(store.get("alice", project.id, context.interviewId).status, "active");
    assert.equal(handler.isRunning, true);
    assert.equal(messages.some(message => message.type === "session_stopped"), false);
    assert.ok(messages.some(message => message.type === "memory_status" && message.state === "saved" && message.background));
    assert.equal(store.transcript(context, true).length, 0);
    handler.handleEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "late-user", transcript: "Also require SSO." });
    assert.ok(handler.checkpointTimer);
    await handler.checkpointMemory();
    assert.equal(updates, 2);
    assert.equal(store.transcript(context, true).length, 0);
    await handler.stop();
    assert.equal(store.get("alice", project.id, context.interviewId).status, "completed");
  } finally { clearTimeout(handler.checkpointTimer); store.close(); }
});

test("live voice session recalls requirements from a preceding session through Foundry memory", {
  skip: process.env.VOICELIVE_TEST_MEMORY !== "true",
  timeout: 420000,
}, async () => {
  const { AIProjectClient } = await import("@azure/ai-projects");
  const { AzureCliCredential } = await import("@azure/identity");
  const { randomUUID } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setTimeout: paceAudio } = await import("node:timers/promises");
  const { configureLocalAgent } = await import("./localConfig.js");
  const env = { ...process.env };
  configureLocalAgent(env);
  const credential = new AzureCliCredential();
  const client = new AIProjectClient(env.AZURE_EXISTING_AIPROJECT_ENDPOINT, credential);
  const memory = new FoundryMemory(client, "requirements-memory");
  const store = new InterviewStore(":memory:");
  const userId = `automated-memory-recall-${randomUUID()}`;
  const project = store.createProject(userId, "Synthetic memory recall verification");
  const coordinator = new InterviewMemory(memory, store);
  const speech = async (name) => {
    const wave = await readFile(join(tmpdir(), name));
    for (let offset = 12; offset + 8 <= wave.length;) {
      const size = wave.readUInt32LE(offset + 4);
      if (wave.toString("ascii", offset, offset + 4) === "data") return wave.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + size % 2;
    }
    throw new Error("Speech fixture must contain 24 kHz mono PCM16 data.");
  };
  const runVoice = async (fixture) => {
    let acceptSession;
    let acceptReply;
    let rejectSession;
    let rejectReply;
    let sawUserTurn = false;
    let audioBytes = 0;
    let finalText = "";
    let recalled = 0;
    const ready = new Promise((resolve, reject) => { acceptSession = resolve; rejectSession = reject; });
    const reply = new Promise((resolve, reject) => { acceptReply = resolve; rejectReply = reject; });
    reply.catch(() => {});
    const context = store.open(userId, project.id);
    const handler = new NativeVoiceHandler("memory-live", "", credential, (message) => {
      if (message.type === "session_started") acceptSession();
      if (message.type === "memory_status" && message.state === "loaded") recalled = message.count;
      if (message.type === "status" && message.state === "thinking") sawUserTurn = true;
      if (sawUserTurn && message.type === "audio_data") audioBytes += Buffer.from(message.data, "base64").length;
      if (sawUserTurn && message.type === "transcript" && message.role === "assistant" && message.isFinal) finalText = message.text;
      if (finalText && audioBytes > 0) acceptReply();
      if (message.type === "error") { rejectSession(new Error(message.message)); rejectReply(new Error(message.message)); }
    }, {
      projectEndpoint: env.AZURE_EXISTING_AIPROJECT_ENDPOINT,
      agentName: env.AZURE_VOICELIVE_AGENT_NAME,
      agentVersion: env.AZURE_VOICELIVE_AGENT_VERSION,
      memorySession: { coordinator, context },
    });
    const timer = setTimeout(() => { rejectSession(new Error("Voice connection timed out")); rejectReply(new Error("Voice recall response timed out")); }, 90000);
    try {
      await handler.start();
      await ready;
      const input = Buffer.concat([Buffer.alloc(24000), await speech(fixture), Buffer.alloc(96000)]);
      for (let offset = 0; offset < input.length; offset += 4800) {
        await handler.sendAudio(input.subarray(offset, offset + 4800).toString("base64"));
        await paceAudio(100);
      }
      await reply;
    } finally {
      clearTimeout(timer);
      await handler.stop();
      await handler.processing;
    }
    assert.equal(store.get(userId, project.id, context.interviewId).status, "completed");
    assert.ok(store.conversationIds(context).length > 0);
    return { text: finalText, audioBytes, recalled };
  };
  try {
    await runVoice("voicelive-memory-budget.wav");
    const recalled = await memory.load(userId, project.id);
    assert.match(JSON.stringify(recalled), /42[,.]?000|forty.two thousand/i);
    const response = await runVoice("voicelive-memory-question.wav");
    assert.ok(response.recalled > 0);
    assert.match(response.text, /42[,.]?000|forty.two thousand/i);
    assert.match(response.text, /SSO|single.sign.on/i);
    console.log(`Live Foundry recall verified: ${response.audioBytes} audio bytes, ${response.recalled} memory records.`);
    assert.deepEqual(await memory.load(userId, `${project.id}-other`), []);
    assert.deepEqual(await memory.load(`${userId}-other`, project.id), []);
  } finally {
    await client.beta.memoryStores.deleteScope("requirements-memory", memoryScope(userId, project.id));
    store.close();
  }
});

test("configured projects use the exact existing memory scope for retrieval and updates", async () => {
  const calls = [];
  const scope = "Enterprise-NOVA";
  const firstQuestion = "My role is HR. Review existing requirements and identify missing HR requirements.";
  const api = {
    async searchMemories(name, receivedScope, request) {
      calls.push({ operation: "search", name, scope: receivedScope, query: request.items[0].content, maxMemories: request.options.max_memories, hasAbortSignal: request.abortSignal instanceof AbortSignal });
      const content = request.items[0].content;
      const records = content.startsWith("Project overview")
        ? [
            { kind: "chat_summary", content: "Existing Enterprise NOVA overview: Employee Management and HR Operations Portal." },
            { kind: "chat_summary", content: "No requirements were provided in this conversation." },
          ]
        : content.startsWith("Documented policies")
          ? [{ kind: "chat_summary", content: "Confirmed HR policy requirement: PTO, sick leave, and manager approval." }]
          : [{ kind: "chat_summary", content: "No requirements were provided in this conversation." }];
      return { memories: records.map(item => ({ memory_item: { ...item, scope: receivedScope } })) };
    },
    updateMemories(name, receivedScope, options) {
      calls.push({ operation: "update", name, scope: receivedScope, items: options.items });
      return { pollUntilDone: async () => ({ memory_operations: [] }) };
    },
  };
  const store = new InterviewStore(":memory:");
  store.registerConfiguredProject("enterprise-nova", "Enterprise NOVA");
  store.addProjectMember("alice", "enterprise-nova");
  const context = store.open("alice", "enterprise-nova");
  context.memoryScope = scope;
  context.projectName = "Enterprise NOVA";
  const memory = new FoundryMemory({ beta: { memoryStores: api } });
  const coordinator = new InterviewMemory(memory, store);
  try {
    const prepared = await coordinator.prepare(context, firstQuestion);
    assert.match(prepared.context, /Existing Enterprise NOVA overview/);
    assert.match(prepared.context, /PTO, sick leave, and manager approval/);
    assert.doesNotMatch(prepared.context, /No requirements were provided in this conversation/);
    assert.equal(prepared.recalled, 2);
    assert.equal(prepared.querySource, "project-context-and-initial-user-message");
    store.record(context, "nova-user", "user", "Confirmed NOVA budget USD 90000.");
    await coordinator.finish(context);
    const nextInterview = store.open("alice", "enterprise-nova");
    nextInterview.memoryScope = scope;
    nextInterview.projectName = "Enterprise NOVA";
    await coordinator.prepare(nextInterview, firstQuestion);
    const expectedQueries = [
      "Project overview and existing requirements, business goals, constraints, and decisions for Enterprise NOVA.",
      "Documented policies, workflow rules, approval conditions, and unresolved requirements for Enterprise NOVA.",
      firstQuestion,
    ];
    assert.deepEqual(calls.filter(call => call.operation === "search").map(call => ({ name: call.name, scope: call.scope, query: call.query, maxMemories: call.maxMemories, hasAbortSignal: call.hasAbortSignal })), [
      ...expectedQueries.map(query => ({ name: "requirements-memory", scope, query, maxMemories: 10, hasAbortSignal: true })),
      ...expectedQueries.map(query => ({ name: "requirements-memory", scope, query, maxMemories: 10, hasAbortSignal: true })),
    ]);
    assert.deepEqual(calls.filter(call => call.operation === "update").map(call => ({ name: call.name, scope: call.scope })), [
      { name: "requirements-memory", scope },
    ]);
    const roleContext = memory.context("Enterprise NOVA", [], "stakeholder");
    assert.match(roleContext, /Business Stakeholder/);
    assert.match(roleContext, /ask only one primary question/);
    assert.match(roleContext, /Distinguish confirmed decisions from proposals or unknowns/);
    assert.doesNotMatch(roleContext, /Employees should|leave requests|SSO/);
    const promptRoleContext = memory.context("Enterprise NOVA", [], null, true);
    assert.match(promptRoleContext, /explicitly named by this user in this conversation or their own earlier interviews/);
    assert.match(promptRoleContext, /Ask which perspective to use only when no explicit role is available/);
    assert.match(promptRoleContext, /For a greeting, respond briefly/);
    assert.match(promptRoleContext, /do not begin an unsolicited requirements review/);
  } finally { store.close(); }
});