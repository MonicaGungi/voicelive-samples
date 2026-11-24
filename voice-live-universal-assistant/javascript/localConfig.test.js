import { test } from "node:test";
import assert from "node:assert/strict";
import { configureLocalAgent, isPromptRoleTestingEnabled } from "./localConfig.js";
import { NativeVoiceHandler } from "./nativeVoiceHandler.js";
import { createLocalClaimsResolver, createLocalIdentityResolver } from "./localIdentity.js";
import { loadProjectConfig, loadProjectBindings, projectAccess } from "./projectConfig.js";
import { ProjectKnowledge } from "./projectKnowledge.js";
import { bearerToken, createEntraTokenVerifier, loadEntraConfig, resolveEmployeeIdentity } from "./entraAuth.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("routes the existing versioned agent without changing instructions or tools", () => {
  const env = {
    VOICELIVE_LOCAL_ONLY: "true",
    AZURE_EXISTING_AIPROJECT_ENDPOINT: "https://resource-planner-voice-resource.services.ai.azure.com/api/projects/resource-planner-voice-agent",
    AZURE_EXISTING_AGENT_ID: "resource-planner-voice-agent:8",
  };
  configureLocalAgent(env);
  assert.equal(env.AZURE_VOICELIVE_ENDPOINT, "https://resource-planner-voice-resource.services.ai.azure.com");
  assert.equal(env.AZURE_VOICELIVE_PROJECT, "resource-planner-voice-agent");
  assert.equal(env.AZURE_VOICELIVE_AGENT_NAME, "resource-planner-voice-agent");
  assert.equal(env.AZURE_VOICELIVE_AGENT_VERSION, "8");
  assert.equal(env.VOICELIVE_MODE, "agent");
  assert.equal(env.VOICELIVE_ALLOW_CLIENT_AGENT_OVERRIDE, "false");
  assert.equal(env.VOICELIVE_INSTRUCTIONS, undefined);
});

test("allows the local profile to resolve the agent's latest version dynamically", () => {
  const env = {
    VOICELIVE_LOCAL_ONLY: "true",
    AZURE_EXISTING_AIPROJECT_ENDPOINT: "https://resource-planner-voice-resource.services.ai.azure.com/api/projects/resource-planner-voice-agent",
    AZURE_EXISTING_AGENT_ID: "resource-planner-voice-agent",
  };
  configureLocalAgent(env);
  assert.equal(env.AZURE_VOICELIVE_AGENT_NAME, "resource-planner-voice-agent");
  assert.equal(env.AZURE_VOICELIVE_AGENT_VERSION, undefined);
});

test("rejects invalid routing instead of falling back to a model or latest agent", () => {
  assert.throws(() => configureLocalAgent({
    VOICELIVE_LOCAL_ONLY: "true",
    AZURE_EXISTING_AIPROJECT_ENDPOINT: "https://example.com/api/projects/demo",
    AZURE_EXISTING_AGENT_ID: "demo",
  }));
});

test("leaves the shared sample unchanged outside local mode", () => {
  const env = { VOICELIVE_MODE: "model" };
  configureLocalAgent(env);
  assert.deepEqual(env, { VOICELIVE_MODE: "model" });
});

test("local identity reuses Azure Identity's cached token for repeated and concurrent requests", async () => {
  let acquisitions = 0;
  const token = `header.${Buffer.from(JSON.stringify({ tid: "tenant", oid: "alice" })).toString("base64url")}.signature`;
  const resolveIdentity = createLocalIdentityResolver({ getToken: async () => {
    acquisitions++;
    return { token, expiresOnTimestamp: Date.now() + 3600000 };
  } });
  assert.deepEqual(await Promise.all([resolveIdentity(), resolveIdentity(), resolveIdentity()]), ["tenant:alice", "tenant:alice", "tenant:alice"]);
  assert.equal(await resolveIdentity(), "tenant:alice");
  assert.equal(acquisitions, 1);
});

test("local identity rejects missing claims and cannot silently switch the running backend's user", async () => {
  let claims = { tid: "tenant", oid: "alice" };
  const resolveIdentity = createLocalIdentityResolver({}, async () => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`);
  assert.equal(await resolveIdentity(), "tenant:alice");
  claims = { tid: "tenant", oid: "bob" };
  await assert.rejects(resolveIdentity(), /Restart the backend/);
  claims = { tid: "tenant" };
  await assert.rejects(resolveIdentity(), /Entra user identity/);
});

test("native sessions pin the existing version and only override live audio delivery", async () => {
  const updates = [];
  let connectionOptions;
  const handler = new NativeVoiceHandler("test", "", {}, () => {}, {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing", agentVersion: "8",
  });
  const session = {
    async *[Symbol.asyncIterator]() {},
    configureSession: async (update) => { updates.push(update); },
    dispose: async () => {},
  };
  handler.client = {
    agents: { getVersion: async (name, version) => {
      assert.equal(name, "existing");
      assert.equal(version, "8");
      return { definition: { kind: "voice", avatar: { character: "rowan", type: "video_avatar", output_audit_audio: false } } };
    } },
    beta: { voiceAgents: { realtime: { connect: async (name, options) => {
      assert.equal(name, "existing");
      connectionOptions = options;
      return session;
    } } } },
  };
  await handler.start();
  assert.equal(connectionOptions.agentVersionOverride, "8");
  assert.equal(connectionOptions.store, false);
  assert.deepEqual(updates, [{ type: "realtime", avatar: { character: "rowan", type: "video-avatar", output_audit_audio: true } }]);
  await handler.stop();
});

test("voice sessions require the generic knowledge function and no MCP knowledge tool", async () => {
  const endpoint = "https://example.search.windows.net/knowledgebases/nova/mcp";
  const fn = { type: "function", name: "search_project_knowledge" };
  const mcp = { type: "mcp", server_label: "nova-kb", server_url: endpoint };
  async function check(context, tools) {
    let connected = 0;
    const messages = [];
    let release;
    const closed = new Promise(resolve => { release = resolve; });
    const handler = new NativeVoiceHandler("kb-test", "", {}, message => messages.push(message), {
      projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
      agentName: "existing", agentVersion: "18",
      memorySession: { context, coordinator: {
        prepare: async () => ({ context: "", history: [], memories: [], recalled: 0 }),
        finish: async () => {},
        store: {},
      } },
    });
    handler.client = {
      agents: { getVersion: async () => ({ definition: { kind: "voice", tools } }) },
      beta: { voiceAgents: { realtime: { connect: async () => {
        connected++;
        return { async *[Symbol.asyncIterator]() { await closed; }, async dispose() { release(); } };
      } } } },
    };
    await handler.start();
    if (connected) { await handler.stop(); await handler.processing; }
    return { connected, messages };
  }
  const configured = { knowledgeToolEndpoint: endpoint };
  assert.equal((await check(configured, [fn])).connected, 1);
  assert.equal((await check({}, [])).connected, 1);
  for (const [context, tools] of [
    [configured, [fn, mcp]],
    [configured, [mcp]],
    [configured, []],
    [configured, [fn, fn]],
    [{}, [mcp]],
  ]) {
    const result = await check(context, tools);
    assert.equal(result.connected, 0);
    assert.ok(result.messages.some(message => message.type === "error" && /knowledge retrieval/.test(message.message)));
  }
});

test("knowledge calls use only the session project's endpoint and ignore model-supplied targets", async () => {
  const novaEndpoint = "https://example.search.windows.net/knowledgebases/nova/mcp";
  async function call(context, args, name = "search_project_knowledge") {
    const retrieved = [];
    const outputs = [];
    const handler = new NativeVoiceHandler("kb-call", "", {}, () => {}, {
      projectEndpoint: "https://example.services.ai.azure.com/api/projects/test", agentName: "existing",
      knowledge: { retrieve: async (endpoint, query) => { retrieved.push([endpoint, query]); return `facts for ${endpoint}`; } },
      memorySession: { context, coordinator: {} },
    });
    handler.isRunning = true;
    handler.session = { sendToolOutput: async (id, output) => outputs.push([id, JSON.parse(output)]) };
    await handler.answerToolCall({ call_id: "c1", name, arguments: JSON.stringify(args) });
    await handler.answerToolCall({ call_id: "c1", name, arguments: JSON.stringify(args) });
    return { retrieved, outputs };
  }
  const ok = await call({ knowledgeToolEndpoint: novaEndpoint, projectName: "NOVA" }, { query: "scope", knowledge_base: "it-helpdesk-knowledge", project_id: "other" });
  assert.deepEqual(ok.retrieved, [[novaEndpoint, "scope"]]);
  assert.equal(ok.outputs.length, 1);
  assert.match(ok.outputs[0][1].results, /nova/);
  assert.equal((await call({ knowledgeToolEndpoint: novaEndpoint }, { query: "" })).retrieved.length, 0);
  assert.equal((await call({ knowledgeToolEndpoint: novaEndpoint }, { query: "x" }, "other_tool")).retrieved.length, 0);
  const none = await call({}, { query: "x" });
  assert.equal(none.retrieved.length, 0);
  assert.ok(none.outputs[0][1].error);
});

test("role tool saves by the session's user and project and ignores model-supplied identity", async () => {
  const saved = [];
  const outputs = [];
  const handler = new NativeVoiceHandler("role-call", "", {}, () => {}, {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test", agentName: "existing",
    memorySession: { context: { userId: "tenant:alice", projectId: "nova" }, coordinator: { store: { saveProjectRole: (user, project, role) => { saved.push([user, project, role]); return role.trim(); } } } },
  });
  handler.isRunning = true;
  handler.session = { sendToolOutput: async (id, output) => outputs.push([id, JSON.parse(output)]) };
  await handler.answerToolCall({ call_id: "r1", name: "save_project_role", arguments: JSON.stringify({ role: " HR Lead ", user_id: "mallory", project_id: "other" }) });
  assert.deepEqual(saved, [["tenant:alice", "nova", " HR Lead "]]);
  assert.deepEqual(outputs, [["r1", { saved: true, role: "HR Lead" }]]);
});

test("unpinned projects use the latest agent version", async () => {
  const definitions = {
    "20": { definition: { tools: [{ type: "function", name: "search_project_knowledge" }] } },
    "18": { definition: { tools: [{ type: "mcp", server_label: "original", server_url: "https://example.search.windows.net/knowledgebases/original/mcp" }] } },
  };
  let selected;
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const handler = new NativeVoiceHandler("version-test", "", {}, () => {}, {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test", agentName: "existing",
    memorySession: { context: { knowledgeToolEndpoint: "https://example.search.windows.net/knowledgebases/original/mcp" }, coordinator: {
      prepare: async () => ({ context: "", history: [], recalled: 0 }), finish: async () => {}, store: {},
    } },
  });
  handler.client = {
    agents: { async *listVersions() { yield { version: "18" }; yield { version: "20" }; }, getVersion: async (_name, version) => definitions[version] },
    beta: { voiceAgents: { realtime: { connect: async (_name, options) => {
      selected = options.agentVersionOverride;
      return { async *[Symbol.asyncIterator]() { await closed; }, async dispose() { release(); } };
    } } } },
  };
  await handler.start();
  assert.equal(selected, "20");
  await handler.stop();
  await handler.processing;
});

test("startup resolves the agent while private memory is loading", async () => {
  let releaseMemory;
  let agentResolved = false;
  let connected = false;
  const pendingMemory = new Promise(resolve => { releaseMemory = resolve; });
  let releaseSession;
  const closed = new Promise(resolve => { releaseSession = resolve; });
  const handler = new NativeVoiceHandler("parallel-start", "", {}, () => {}, {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing", agentVersion: "18",
    memorySession: { context: {}, coordinator: {
      prepare: () => pendingMemory,
      finish: async () => {},
      store: {},
    } },
  });
  handler.client = {
    agents: { getVersion: async () => { agentResolved = true; return { definition: { kind: "voice" } }; } },
    beta: { voiceAgents: { realtime: { connect: async () => {
      connected = true;
      return { async *[Symbol.asyncIterator]() { await closed; }, async dispose() { releaseSession(); } };
    } } } },
  };
  const starting = handler.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(agentResolved, true);
  assert.equal(connected, false);
  releaseMemory({ context: "", history: [], memories: [], recalled: 0 });
  await starting;
  assert.equal(connected, true);
  assert.equal(handler.resolvedAgentVersion, "18");
  await handler.stop();
  await handler.processing;
});

test("resolves the newest active published agent version on every session", async () => {
  let versions = [
    { version: "11", status: "active" },
    { version: "12", status: "active" },
    { version: "13", status: "active", draft: true },
    { version: "14", status: "failed" },
  ];
  let listCalls = 0;
  const fetchedVersions = [];
  const connectedVersions = [];
  const handler = new NativeVoiceHandler("latest-test", "", {}, () => {}, {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing",
  });
  handler.client = {
    agents: {
      async *listVersions() { listCalls++; yield* versions; },
      async getVersion(name, version) {
        fetchedVersions.push(version);
        return { definition: { kind: "voice" } };
      },
    },
    beta: { voiceAgents: { realtime: { connect: async (name, options) => {
      connectedVersions.push(options.agentVersionOverride);
      let release;
      const closed = new Promise(resolve => { release = resolve; });
      return {
        async *[Symbol.asyncIterator]() { await closed; },
        async dispose() { release(); },
      };
    } } } },
  };

  const startAndStop = async () => {
    await handler.start();
    await handler.stop();
    await handler.processing;
  };
  await startAndStop();
  versions = [...versions, { version: "15", status: "active" }];
  await startAndStop();

  assert.equal(listCalls, 2);
  assert.deepEqual(fetchedVersions, ["12", "15"]);
  assert.deepEqual(connectedVersions, ["12", "15"]);
});

test("chat relays streamed replies and speech transcripts while preserving interruptions", async () => {
  const messages = [];
  const handler = new NativeVoiceHandler("test", "", {}, (message) => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
  });
  handler.handleEvent({ type: "response.output_audio_transcript.delta", item_id: "reply", delta: "Hello" });
  handler.handleEvent({ type: "response.output_audio_transcript.delta", item_id: "reply", delta: " there" });
  handler.handleEvent({ type: "response.output_audio_transcript.done", item_id: "reply", transcript: "Hello there" });
  handler.handleEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: "speech", transcript: "Hi" });
  handler.handleEvent({ type: "input_audio_buffer.speech_started" });
  assert.deepEqual(messages.filter((message) => message.role === "assistant").map((message) => message.text), ["Hello", "Hello there", "Hello there"]);
  assert.equal(messages.find((message) => message.role === "user").text, "Hi");
  assert.equal(messages.some((message) => message.type === "stop_playback"), true);
  handler.handleEvent({ type: "response.done", response: { status: "failed", status_details: { error: { message: "Test error" } } } });
  assert.equal(messages.at(-1).message, "Test error");
});

test("typed chat uses the existing session, validates input, and queues during the greeting", async () => {
  const messages = [];
  const sent = [];
  const handler = new NativeVoiceHandler("test", "", {}, (message) => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
  });
  await assert.rejects(handler.sendText("Hi"), /Start a session/);
  handler.isRunning = true;
  handler.ready = true;
  handler.session = { sendText: async (text) => sent.push(text) };
  await handler.sendText("  Hi  ");
  assert.deepEqual(sent, ["Hi"]);
  assert.equal(messages[0].text, "Hi");
  assert.equal(messages[0].source, "text");
  await assert.rejects(handler.sendText(" "), /4000/);
  await assert.rejects(handler.sendText("a".repeat(4001)), /4000/);
  handler.activeResponse = true;
  await handler.sendText("Hi again");
  assert.deepEqual(sent, ["Hi"]);
  await assert.rejects(handler.sendText("Another message"), /already waiting/);
  handler.handleEvent({ type: "response.done", response: { status: "completed" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, ["Hi", "Hi again"]);
  assert.equal(messages.at(-1).text, "Hi again");
});

test("a greeting with retrieved memory does not force a requirements review", async () => {
  const sent = [];
  const messages = [];
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const session = {
    async sendText(text) { sent.push(text); },
    async configureSession() {},
    async *[Symbol.asyncIterator]() { await closed; },
    async dispose() { release(); },
  };
  const handler = new NativeVoiceHandler("greeting-test", "", {}, message => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing", agentVersion: "14", initialText: "Hi",
    memorySession: {
      context: {},
      coordinator: {
        store: { record() {} },
        async prepare(context, query) {
          assert.equal(query, "Hi");
          return { context: "Project context", memories: [{ kind: "chat_summary", content: "Project requirements" }], history: [], recalled: 1, warning: "" };
        },
        async finish() {},
      },
    },
  });
  handler.client = {
    agents: { getVersion: async () => ({ definition: { kind: "voice" } }) },
    beta: { voiceAgents: { realtime: { connect: async () => session } } },
  };

  await handler.start();
  assert.deepEqual(sent, ["Project context", "Hi"]);
  assert.equal(messages.find(message => message.source === "text").text, "Hi");
  await handler.stop();
  await handler.processing;
});

test("reopened interviews drain the automatic greeting without displaying, playing or recording it", async () => {
  const messages = [];
  const recorded = [];
  const sent = [];
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const handler = new NativeVoiceHandler("resume-test", "", {}, message => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing", agentVersion: "15",
    memorySession: {
      context: {},
      coordinator: {
        store: { record: (...args) => recorded.push(args), recordConversation() {} },
        async prepare() {
          return { context: "Manager first, then HR.", resumed: true, history: [{ item_id: "old-user", role: "user", content: "Manager first, then HR." }], memories: [], recalled: 0 };
        },
        async finish() {},
      },
    },
  });
  handler.client = {
    agents: { getVersion: async () => ({ definition: { kind: "voice", greeting: { type: "llm_generated" } } }) },
    beta: { voiceAgents: { realtime: { connect: async () => ({
      async configureSession() {},
      async sendText(text, options) { sent.push({ text, options }); },
      async *[Symbol.asyncIterator]() { await closed; },
      async dispose() { release(); },
    }) } } },
  };
  await handler.start();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.createResponse, false);
  assert.match(sent[0].text, /Manager first, then HR/);
  handler.handleEvent({ type: "session.created", conversation_id: "conv_resume" });
  assert.equal(handler.ready, undefined);
  handler.handleEvent({ type: "response.created" });
  handler.handleEvent({ type: "response.output_audio.delta", delta: new Uint8Array([1, 2]) });
  handler.handleEvent({ type: "response.output_audio_transcript.delta", item_id: "greeting", delta: "Hello" });
  handler.handleEvent({ type: "response.output_audio_transcript.done", item_id: "greeting", transcript: "Hello! What project?" });
  handler.handleEvent({ type: "response.output_text.done", item_id: "greeting-text", text: "Hello! What project?" });
  assert.equal(messages.some(message => message.type === "audio_data"), false);
  assert.equal(messages.filter(message => message.type === "transcript").length, 1);
  assert.equal(recorded.length, 0);
  handler.handleEvent({ type: "response.done", response: { status: "completed" } });
  assert.equal(handler.ready, true);
  assert.equal(messages.filter(message => message.type === "session_started").length, 1);
  handler.handleEvent({ type: "response.created" });
  handler.handleEvent({ type: "response.output_audio.delta", delta: new Uint8Array([1, 2]) });
  handler.handleEvent({ type: "response.output_audio_transcript.done", item_id: "answer", transcript: "What should HR validate?" });
  assert.equal(messages.filter(message => message.type === "audio_data").length, 1);
  assert.equal(recorded.length, 1);
  await handler.stop();
  await handler.processing;
});

test("new voice interviews let the agent speak first without app-supplied instructions", async () => {
  const requests = [];
  const messages = [];
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const handler = new NativeVoiceHandler("role-prompt", "", {}, message => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing", agentVersion: "15", requestAgentTurn: true,
    memorySession: { context: {}, coordinator: {
      store: { record() {}, recordConversation() {} },
      prepare: async () => ({ context: "", history: [], memories: [], recalled: 0, resumed: false }),
      finish: async () => {},
    } },
  });
  handler.client = {
    agents: { getVersion: async () => ({ definition: { kind: "voice", greeting: { type: "llm_generated" } } }) },
    beta: { voiceAgents: { realtime: { connect: async () => ({
      async requestResponse(options) { requests.push(options); },
      async *[Symbol.asyncIterator]() { await closed; },
      async dispose() { release(); },
    }) } } },
  };
  await handler.start();
  handler.handleEvent({ type: "session.created", conversation_id: "conv_role" });
  handler.handleEvent({ type: "response.created" });
  assert.equal(requests.length, 0);
  handler.handleEvent({ type: "response.done", response: { status: "completed" } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0], undefined);
  handler.handleEvent({ type: "response.created" });
  handler.handleEvent({ type: "response.output_audio.delta", delta: new Uint8Array([1, 2]) });
  handler.handleEvent({ type: "response.output_audio_transcript.done", item_id: "role", transcript: "What's your role?" });
  assert.ok(messages.some(message => message.type === "audio_data"));
  assert.ok(messages.some(message => message.text === "What's your role?"));
  handler.handleEvent({ type: "response.done", response: { status: "completed" } });
  assert.equal(requests.length, 1);
  await handler.stop();
  await handler.processing;
});

test("large returning-user context stays within the internal turn limit", async () => {
  const sent = [];
  const messages = [];
  const initialText = "x".repeat(4000);
  let release;
  const closed = new Promise(resolve => { release = resolve; });
  const handler = new NativeVoiceHandler("large-recap", "", {}, message => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing", agentVersion: "18", initialText,
    memorySession: { context: {}, coordinator: {
      store: { record() {}, recordConversation() {} },
      prepare: async () => ({ context: "", history: [], recalled: 1, resumed: false, continuingProject: true, memories: [{ kind: "chat_summary", content: "m".repeat(10000) }] }),
      finish: async () => {},
    } },
  });
  handler.client = {
    agents: { getVersion: async () => ({ definition: { kind: "voice", greeting: { type: "llm_generated" } } }) },
    beta: { voiceAgents: { realtime: { connect: async () => ({
      async configureSession() {},
      async sendText(text) { sent.push(text); },
      async *[Symbol.asyncIterator]() { await closed; },
      async dispose() { release(); },
    }) } } },
  };
  await handler.start();
  handler.handleEvent({ type: "session.created", conversation_id: "conv_large" });
  handler.handleEvent({ type: "response.created" });
  handler.handleEvent({ type: "response.done", response: { status: "completed" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length <= 16000);
  assert.equal(messages.filter(message => message.source === "text").length, 1);
  assert.equal(messages.find(message => message.source === "text").text, initialText);
  await handler.stop();
  await handler.processing;
});

test("initial typed question retrieves project memory before being sent once to the native agent", async () => {
  const calls = [];
  const messages = [];
  const question = "My role is HR. Review existing requirements and identify missing HR requirements.";
  const retrievedMemories = [{ kind: "chat_summary", content: `Confirmed NOVA PTO and approval rules. ${"Additional project policy context. ".repeat(180)}` }];
  const session = {
    async sendText(text, options) { calls.push({ type: "send", text, options }); },
    async configureSession(update) { calls.push({ type: "configure", update }); },
    async cancelResponse() { calls.push({ type: "cancel" }); },
    async *[Symbol.asyncIterator]() { await new Promise(resolve => { this.release = resolve; }); },
    async dispose() { this.release?.(); },
  };
  const context = { userId: "alice", projectId: "enterprise-nova", interviewId: "interview-1" };
  const handler = new NativeVoiceHandler("test", "", {}, message => messages.push(message), {
    projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
    agentName: "existing", agentVersion: "11", initialText: question,
    memorySession: {
      context,
      coordinator: {
        store: {
          record: (_context, id, role, text) => calls.push({ type: "record", id, role, text }),
          recordConversation: (_context, conversationId) => calls.push({ type: "conversation", conversationId }),
        },
        prepare: async (_context, query) => {
          calls.push({ type: "prepare", query });
          return { context: "Retrieved HR project memory", memories: retrievedMemories, history: [], recalled: 7, warning: "" };
        },
        finish: async () => {},
      },
    },
  });
  handler.client = {
    agents: { getVersion: async () => ({ definition: { kind: "voice", instructions: "Original agent instructions", greeting: { type: "llm_generated", prompt: "Read the instructions" } } }) },
    beta: { voiceAgents: { realtime: { connect: async () => session } } },
  };

  await handler.start();
  assert.deepEqual(calls.filter(call => call.type === "prepare"), [{ type: "prepare", query: question }]);
  const configureIndex = calls.findIndex(call => call.type === "configure");
  const questionIndex = calls.findIndex(call => call.type === "record" && call.text === question);
  assert.equal(configureIndex, -1);
  assert.deepEqual(calls.filter(call => call.type === "send")[0], { type: "send", text: "Retrieved HR project memory", options: { createResponse: false } });
  assert.ok(questionIndex >= 0);
  assert.equal(calls.filter(call => call.type === "send").length, 1);
  handler.handleEvent({ type: "session.created", conversation_id: "conv_initial123" });
  handler.handleEvent({ type: "response.created" });
  assert.equal(calls.some(call => call.type === "cancel"), false);
  handler.handleEvent({ type: "response.done", response: { status: "completed" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.filter(call => call.type === "send").slice(1).map(({ text, options }) => ({ text, options })), [
    { text: question, options: undefined },
  ]);
  assert.equal(messages.find(message => message.source === "text").text, question);
  assert.equal(calls.filter(call => call.type === "record" && call.text === question).length, 1);
  assert.equal(messages.find(message => message.type === "memory_status" && message.state === "loaded").count, 7);

  await handler.stop();
  await handler.processing;
});

test("live existing agent returns spoken audio", {
  skip: !process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT,
  timeout: 90000,
}, async () => {
  const { AzureCliCredential } = await import("@azure/identity");
  const { readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setTimeout: paceAudio } = await import("node:timers/promises");
  const wave = await readFile(join(tmpdir(), "voicelive-smoke.wav"));
  let pcm;
  for (let offset = 12; offset + 8 <= wave.length;) {
    const size = wave.readUInt32LE(offset + 4);
    if (wave.toString("ascii", offset, offset + 4) === "data") {
      pcm = wave.subarray(offset + 8, offset + 8 + size);
      break;
    }
    offset += 8 + size + size % 2;
  }
  assert.ok(pcm?.length, "Generate the local 24 kHz PCM16 speech fixture before running the live test");
  const env = { ...process.env };
  configureLocalAgent(env);
  let acceptSession;
  let rejectSession;
  let acceptAudio;
  let rejectAudio;
  let userTurnStarted = false;
  const connected = new Promise((resolve, reject) => { acceptSession = resolve; rejectSession = reject; });
  const audio = new Promise((resolve, reject) => { acceptAudio = resolve; rejectAudio = reject; });
  audio.catch(() => {});
  const handler = new NativeVoiceHandler("live-smoke", env.AZURE_VOICELIVE_ENDPOINT, new AzureCliCredential(), (message) => {
    eventTypes.add(message.type);
    if (message.type === "session_started") acceptSession();
    if (message.type === "status" && message.state === "thinking") userTurnStarted = true;
    if (message.type === "audio_data" && message.data && userTurnStarted) acceptAudio(Buffer.from(message.data, "base64").length);
    if (message.type === "error") {
      rejectSession(new Error(message.message));
      rejectAudio(new Error(message.message));
    }
  }, {
    mode: "agent", voiceOnly: true, proactiveGreeting: false,
    projectEndpoint: env.AZURE_EXISTING_AIPROJECT_ENDPOINT,
    agentName: env.AZURE_VOICELIVE_AGENT_NAME,
    projectName: env.AZURE_VOICELIVE_PROJECT,
    agentVersion: env.AZURE_VOICELIVE_AGENT_VERSION,
  });
  const eventTypes = new Set();
  const timer = setTimeout(() => {
    rejectSession(new Error("Azure session timed out"));
    rejectAudio(new Error(`Azure audio output timed out; events: ${[...eventTypes].join(", ")}`));
  }, 80000);
  try {
    await handler.start();
    await connected;
    const input = Buffer.concat([Buffer.alloc(24000), pcm, Buffer.alloc(96000)]);
    for (let offset = 0; offset < input.length; offset += 4800) {
      await handler.sendAudio(input.subarray(offset, offset + 4800).toString("base64"));
      await paceAudio(100);
    }
    assert.ok(await audio > 0);
  } finally {
    clearTimeout(timer);
    await handler.stop();
  }
});

test("Enterprise NOVA permits authenticated users without group or role claims", () => {
  const project = loadProjectConfig().find(item => item.id === "enterprise-nova");
  assert.equal(Object.hasOwn(project, "memoryScope"), false);
  assert.equal(projectAccess(project, { userId: "tenant:user", groupIds: [] }), true);
  assert.equal(projectAccess(project, { groupIds: ["e490af10-dd7e-4cea-9ae6-a6a86773e990"] }), false);
  const directory = mkdtempSync(join(tmpdir(), "project-config-"));
  try {
    const path = join(directory, "projects.json");
    writeFileSync(path, JSON.stringify({ projects: [{ id: "shared", name: "Shared", memoryScope: "Shared", accessGroupIds: ["e490af10-dd7e-4cea-9ae6-a6a86773e990"] }] }));
    assert.throws(() => loadProjectConfig(path), /must not set memoryScope/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Entra configuration requires explicit tenant and client IDs and stays local-only", () => {
  const tenant = "6f487de7-f318-4a52-bda7-2da4e1982644";
  const client = "11111111-2222-3333-4444-555555555555";
  assert.equal(loadEntraConfig({}), null);
  assert.throws(() => loadEntraConfig({ VOICELIVE_ENTRA_AUTH: "true", VOICELIVE_LOCAL_ONLY: "true", ENTRA_TENANT_ID: tenant }), /ENTRA_CLIENT_ID/);
  assert.throws(() => loadEntraConfig({ VOICELIVE_ENTRA_AUTH: "true", ENTRA_TENANT_ID: tenant, ENTRA_CLIENT_ID: client }), /VOICELIVE_LOCAL_ONLY/);
  assert.deepEqual(loadEntraConfig({ VOICELIVE_ENTRA_AUTH: "true", VOICELIVE_LOCAL_ONLY: "true", ENTRA_TENANT_ID: tenant, ENTRA_CLIENT_ID: client }), {
    tenantId: tenant, clientId: client, apiScope: `api://${client}/access_as_user`, audience: `api://${client}`, scopeName: "access_as_user",
  });
  assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerToken("Basic abc"), undefined);
});

test("Graph employee ID comes from the authenticated user's matching profile", async () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const objectId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const clientId = "22222222-2222-2222-2222-222222222222";
  const identity = { userId: `${tenantId}:${objectId}` };
  const token = payload => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  const graphToken = token({ tid: tenantId, oid: objectId, appid: clientId });
  const graph = async (url, options) => {
    assert.equal(url, "https://graph.microsoft.com/v1.0/me?$select=id,employeeId");
    assert.equal(options.headers.authorization, `Bearer ${graphToken}`);
    return { ok: true, json: async () => ({ id: objectId, employeeId: "KUS08" }) };
  };
  assert.equal((await resolveEmployeeIdentity(identity, graphToken, { tenantId, clientId }, graph)).employeeId, "KUS08");
  await assert.rejects(resolveEmployeeIdentity(identity, graphToken, { tenantId, clientId }, async () => ({ ok: false })), /User.Read/);
  await assert.rejects(resolveEmployeeIdentity(identity, graphToken, { tenantId, clientId }, async () => ({ ok: true, json: async () => ({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", employeeId: "KUS08" }) })), /does not match/);
  await assert.rejects(resolveEmployeeIdentity(identity, graphToken, { tenantId, clientId }, async () => ({ ok: true, json: async () => ({ id: objectId, employeeId: null }) })), /employee ID/);
  await assert.rejects(resolveEmployeeIdentity(identity, token({ tid: "other", oid: objectId, appid: clientId }), { tenantId, clientId }, async () => ({ ok: true, json: async () => ({ id: objectId, employeeId: "KUS08" }) })), /does not match/);
  await assert.rejects(resolveEmployeeIdentity(identity, token({ tid: tenantId, oid: objectId, appid: "other" }), { tenantId, clientId }, async () => ({ ok: true, json: async () => ({ id: objectId, employeeId: "KUS08" }) })), /does not match/);
});

test("Entra access tokens are verified for signature, tenant, audience, client, scope and expiry", async () => {
  const tenant = "6f487de7-f318-4a52-bda7-2da4e1982644";
  const client = "11111111-2222-3333-4444-555555555555";
  const user = "e8b38048-bebe-4cea-b2d8-8c56ead2820b";
  const config = loadEntraConfig({ VOICELIVE_ENTRA_AUTH: "true", VOICELIVE_LOCAL_ONLY: "true", ENTRA_TENANT_ID: tenant, ENTRA_CLIENT_ID: client });
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const verify = createEntraTokenVerifier(config, createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "RS256" }] }));
  const sign = (claims = {}, { key = privateKey, issuer = `https://login.microsoftonline.com/${tenant}/v2.0`, audience = client, expires = "5m" } = {}) =>
    new SignJWT({ tid: tenant, oid: user, azp: client, scp: "access_as_user", name: "Monica", roles: ["NOVA.HR"], groups: ["e490af10-dd7e-4cea-9ae6-a6a86773e990"], ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(key);

  assert.deepEqual(await verify(await sign()), { userId: `${tenant}:${user}`, name: "Monica", firstName: "", lastName: "", roles: ["NOVA.HR"], groupIds: ["e490af10-dd7e-4cea-9ae6-a6a86773e990"], groupOverage: false });
  const named = await verify(await sign({ given_name: "Monica", family_name: "Gungi" }));
  assert.equal(named.firstName, "Monica");
  assert.equal(named.lastName, "Gungi");
  const profile = await verify(await sign(), await sign({ given_name: "Monica", family_name: "Gungi", scp: undefined, azp: undefined }));
  assert.equal(profile.firstName, "Monica");
  assert.equal(profile.lastName, "Gungi");
  await assert.rejects(verify(await sign(), await sign({ oid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", given_name: "Other" })), /profile is invalid/);
  await assert.rejects(verify(await sign(), await sign({}, { key: other.privateKey })), /profile is invalid/);
  await assert.rejects(verify(await sign(), await sign({}, { audience: "another-api" })), /profile is invalid/);
  const noAssignments = await verify(await sign({ roles: undefined, groups: undefined, hasgroups: true }));
  assert.equal(noAssignments.userId, `${tenant}:${user}`);
  assert.deepEqual(noAssignments.roles, []);
  assert.deepEqual(noAssignments.groupIds, []);
  assert.equal(projectAccess(loadProjectConfig()[0], noAssignments), true);
  assert.equal((await verify(await sign({ azp: undefined, appid: client }, { issuer: `https://sts.windows.net/${tenant}/`, audience: `api://${client}` }))).userId, `${tenant}:${user}`);
  await assert.rejects(verify(await sign({}, { key: other.privateKey })), /invalid or expired/);
  await assert.rejects(verify(await sign({}, { audience: "another-api" })), /invalid or expired/);
  await assert.rejects(verify(await sign({}, { issuer: "https://login.microsoftonline.com/another-tenant/v2.0" })), /invalid or expired/);
  await assert.rejects(verify(await sign({}, { expires: Math.floor(Date.now() / 1000) - 600 })), /invalid or expired/);
  await assert.rejects(verify(await sign({ tid: "00000000-0000-0000-0000-000000000000" })), /configured tenant/);
  await assert.rejects(verify(await sign({ azp: "99999999-2222-3333-4444-555555555555" })), /different application/);
  await assert.rejects(verify(await sign({ scp: "User.Read" })), /delegated API scope/);
  await assert.rejects(verify(await sign({ scp: undefined, roles: ["NOVA.HR"] })), /delegated API scope/);
  await assert.rejects(verify("not-a-token"), /Sign in/);
  assert.equal((await verify(await sign({ groups: undefined, hasgroups: true }))).groupOverage, true);
});

test("local CLI identity exposes token claims without using them as interview roles", async () => {
  const claims = { tid: "tenant", oid: "user", groups: ["resource-group"], roles: ["Enterprise.HR"] };
  const resolve = createLocalClaimsResolver({}, async () => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`);
  assert.deepEqual(await resolve(), { userId: "tenant:user", roles: ["Enterprise.HR"], groupIds: ["resource-group"], groupOverage: false });
});

test("prompt-selected role testing is opt-in and restricted to local-only mode", () => {
  assert.equal(isPromptRoleTestingEnabled({}), false);
  assert.equal(isPromptRoleTestingEnabled({ VOICELIVE_LOCAL_ONLY: "true", VOICELIVE_PROMPT_ROLE_TESTING: "true" }), true);
  assert.throws(() => isPromptRoleTestingEnabled({ VOICELIVE_PROMPT_ROLE_TESTING: "true" }), /only available in local-only mode/);
});

test("project bindings require distinct trusted knowledge sources and pinned versions", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-bindings-"));
  const path = join(directory, "projects.json");
  const configured = { id: "existing", name: "Existing", knowledgeToolLabel: "existing", knowledgeToolEndpoint: "https://example.search.windows.net/knowledgebases/existing/mcp" };
  const binding = { projectId: "user-project", agentVersion: "19", knowledgeToolLabel: "project-kb", knowledgeToolEndpoint: "https://example.search.windows.net/knowledgebases/project-kb/mcp", knowledgeSource: "project-source" };
  try {
    const check = projectBindings => writeFileSync(path, JSON.stringify({ projects: [configured], projectBindings }));
    check([binding]);
    assert.deepEqual(loadProjectBindings(path), [binding]);
    for (const invalid of [
      { ...binding, agentVersion: "latest" },
      { ...binding, knowledgeToolEndpoint: "https://external.example/knowledgebases/project-kb/mcp" },
      { ...binding, knowledgeToolEndpoint: configured.knowledgeToolEndpoint },
      { ...binding, projectId: configured.id },
    ]) { check([invalid]); assert.throws(() => loadProjectBindings(path)); }
    check([binding, { ...binding, projectId: "another", knowledgeToolEndpoint: "https://example.search.windows.net/knowledgebases/another/mcp" }]);
    assert.throws(() => loadProjectBindings(path), /own knowledge base and source/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("project document upload verifies isolated file sources", async () => {
  const binding = { knowledgeToolEndpoint: "https://example.search.windows.net/knowledgebases/project/mcp", knowledgeSource: "project-source" };
  const protectedProjects = [{ knowledgeToolEndpoint: "https://example.search.windows.net/knowledgebases/existing/mcp" }];
  let protectedSource = "existing-source";
  let uploaded = false;
  const service = new ProjectKnowledge({ getToken: async () => ({ token: "token" }) }, protectedProjects, async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer token");
    let value;
    if (url.includes("knowledgebases('project')")) value = { knowledgeSources: [{ name: "project-source" }] };
    else if (url.includes("knowledgebases('existing')")) value = { knowledgeSources: [{ name: protectedSource }] };
    else if (url.includes("/files") && options.method === "POST") {
      assert.equal(options.body.get("metadata").type, "application/json");
      assert.deepEqual(JSON.parse(await options.body.get("metadata").text()), { fileName: "requirements.txt" });
      uploaded = true;
      value = { fileId: "file-1", fileName: "requirements.txt" };
    }
    else if (url.includes("/files")) value = { value: [{ fileId: "file-1", fileName: "requirements.txt" }] };
    else value = { kind: "file" };
    return { ok: true, json: async () => value };
  });
  assert.deepEqual(await service.upload(binding, "requirements.txt", Buffer.from("requirements")), { id: "file-1", name: "requirements.txt", error: null });
  assert.equal(uploaded, true);
  assert.equal((await service.list(binding))[0].name, "requirements.txt");
  await assert.rejects(() => service.upload(binding, "../requirements.txt", Buffer.from("x")), /filename/);
  protectedSource = binding.knowledgeSource;
  uploaded = false;
  await assert.rejects(() => service.upload(binding, "requirements.txt", Buffer.from("x")), /existing project/);
  assert.equal(uploaded, false);
});

test("knowledge retrieval sends intents first and falls back to messages", async () => {
  const bodies = [];
  const make = rejectIntents => new ProjectKnowledge({ getToken: async () => ({ token: "token" }) }, [], async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    assert.ok(url.startsWith("https://example.search.windows.net/knowledgebases('kb-one')/retrieve"));
    if (body.intents && rejectIntents) return { ok: false, status: 400 };
    return { ok: true, json: async () => ({ response: [{ content: [{ type: "text", text: "facts" }] }] }) };
  });
  const endpoint = "https://example.search.windows.net/knowledgebases/kb-one/mcp";
  assert.equal(await make(false).retrieve(endpoint, "overview"), "facts");
  assert.deepEqual(bodies.map(body => Object.keys(body)[0]), ["intents"]);
  bodies.length = 0;
  assert.equal(await make(true).retrieve(endpoint, "overview"), "facts");
  assert.deepEqual(bodies.map(body => Object.keys(body)[0]), ["intents", "messages"]);
  await assert.rejects(() => make(false).retrieve("https://attacker.example/knowledgebases/kb-one/mcp", "x"), /Invalid project knowledge endpoint/);
});

test("knowledge retrieval retries without the reranker threshold when results are empty", async () => {
  const bodies = [];
  const service = new ProjectKnowledge({ getToken: async () => ({ token: "token" }) }, [], async (url, options) => {
    if (url.includes("/knowledgesources(")) return { ok: true, json: async () => ({ kind: "file" }) };
    if (!options?.body) return { ok: true, json: async () => ({ knowledgeSources: [{ name: "src" }] }) };
    const body = JSON.parse(options.body);
    bodies.push(body);
    const text = body.knowledgeSourceParams ? "facts" : "[]";
    return { ok: true, json: async () => ({ response: [{ content: [{ type: "text", text }] }] }) };
  });
  const endpoint = "https://example.search.windows.net/knowledgebases/kb-one/mcp";
  assert.equal(await service.retrieve(endpoint, "overview"), "facts");
  assert.deepEqual(bodies[1].knowledgeSourceParams, [{ knowledgeSourceName: "src", kind: "file", rerankerThreshold: 0 }]);
});

test("knowledge discovery uses stable IDs and rejects untrusted continuation URLs", async () => {
  const requests = [];
  let malicious = false;
  const service = new ProjectKnowledge({ getToken: async () => ({ token: "token" }) }, [], async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, "Bearer token");
    const page = new URL(url).searchParams.get("page");
    return { ok: true, json: async () => page
      ? { value: [{ name: "project-b" }] }
      : { value: [{ name: "project-a" }], "@odata.nextLink": malicious ? "https://attacker.example/knowledgebases?page=2" : "/knowledgebases?api-version=2026-10-01&page=2" } };
  });
  const projects = await service.discover("https://example.search.windows.net");
  assert.deepEqual(projects.map(project => project.name), ["project-a", "project-b"]);
  assert.notEqual(projects[0].id, projects[1].id);
  assert.deepEqual(await service.discover("https://example.search.windows.net"), projects);
  malicious = true;
  await assert.rejects(() => service.discover("https://example.search.windows.net"), /continuation/);
  assert.equal(requests.some(url => url.includes("attacker.example")), false);
});