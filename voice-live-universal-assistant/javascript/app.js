/**
 * Express WebSocket server for Azure Voice Live.
 * Supports Agent mode (Foundry Agent Service) and Model mode (direct gpt-realtime / BYOM).
 */

import "dotenv/config";
import express from "express";
import expressWs from "express-ws";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AzureKeyCredential } from "@azure/core-auth";
import { AzureCliCredential, DefaultAzureCredential } from "@azure/identity";
import { VoiceHandler } from "./voiceHandler.js";
import { NativeVoiceHandler } from "./nativeVoiceHandler.js";
import { configureLocalAgent, isPromptRoleTestingEnabled } from "./localConfig.js";
import { AIProjectClient } from "@azure/ai-projects";
import { FoundryMemory, InterviewMemory, memoryFailure } from "./memoryService.js";
import { InterviewStore } from "./interviewStore.js";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createLocalClaimsResolver } from "./localIdentity.js";
import { loadProjectBindings, loadProjectConfig, projectAccess } from "./projectConfig.js";
import { ProjectKnowledge } from "./projectKnowledge.js";
import { bearerToken, createEntraTokenVerifier, EntraAuthError, loadEntraConfig, resolveEmployeeIdentity } from "./entraAuth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
configureLocalAgent(process.env);
const localOnly = process.env.VOICELIVE_LOCAL_ONLY === "true";
const entraConfig = loadEntraConfig(process.env);
const verifyEntraToken = entraConfig ? createEntraTokenVerifier(entraConfig) : null;
const promptRoleTesting = !entraConfig && isPromptRoleTestingEnabled(process.env);
const memoryEnabled = localOnly && process.env.VOICELIVE_MEMORY_ENABLED === "true";
const interviewPath = process.env.VOICELIVE_INTERVIEW_DB || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "VoiceLiveRequirements", `${createHash("sha256").update(process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT || "").digest("hex").slice(0, 20)}.sqlite`);
const interviews = memoryEnabled ? new InterviewStore(interviewPath) : null;
let interviewMemory;
let resolveLocalClaims;
const configuredProjects = memoryEnabled ? loadProjectConfig() : [];
const configuredProjectMap = new Map(configuredProjects.map(project => [project.id, project]));
const projectBindings = memoryEnabled ? loadProjectBindings() : [];
const projectBindingMap = new Map(projectBindings.map(binding => [binding.projectId, binding]));
let discoveredProjectMap = new Map();

async function localIdentity() {
  if (!memoryEnabled) throw new Error("Local memory is not enabled.");
  if (!resolveLocalClaims) resolveLocalClaims = createLocalClaimsResolver(getCredential());
  return resolveLocalClaims();
}

async function localUserId() {
  return (await localIdentity()).userId;
}

function requestIdentity(token) {
  return verifyEntraToken ? verifyEntraToken(token) : localIdentity();
}

function authorizeProject(identity, projectId) {
  if (!identity?.userId) throw new Error("Project access denied.");
  const configured = configuredProjectMap.get(projectId);
  if (configured) {
    if (!projectAccess(configured, identity)) throw new Error("Project access denied.");
    interviews.registerConfiguredProject(configured.id, configured.name);
    interviews.addProjectMember(identity.userId, configured.id);
    return configured;
  }
  interviews.joinActiveProjects(identity.userId);
  interviews.authorize(identity.userId, projectId);
  const discovered = discoveredProjectMap.get(projectId);
  if (discovered) return discovered;
  const binding = projectBindingMap.get(projectId);
  return binding ? { ...binding, name: interviews.projects(identity.userId).find(project => project.id === projectId)?.name } : null;
}

async function visibleProjects(identity) {
  let discoveryWarning = "";
  try {
    const origins = [...new Set(configuredProjects.filter(project => project.knowledgeToolEndpoint).map(project => new URL(project.knowledgeToolEndpoint).origin))];
    const bases = (await Promise.all(origins.map(origin => getProjectKnowledge().discover(origin)))).flat();
    const configuredEndpoints = new Set(configuredProjects.filter(project => project.knowledgeToolEndpoint).map(project => project.knowledgeToolEndpoint.toLowerCase()));
    discoveredProjectMap = new Map(bases.filter(base => !configuredEndpoints.has(base.knowledgeToolEndpoint.toLowerCase()) && !configuredProjectMap.has(base.id) && !projectBindingMap.has(base.id)).map(base => [base.id, { ...base, discovered: true }]));
  } catch (error) {
    discoveryWarning = "Knowledge base discovery is unavailable. Existing projects are still shown.";
    console.warn("[KNOWLEDGE] Discovery failed:", error.message);
  }
  for (const project of configuredProjects) {
    if (projectAccess(project, identity)) {
      interviews.registerConfiguredProject(project.id, project.name);
      interviews.addProjectMember(identity.userId, project.id);
    }
  }
  for (const project of discoveredProjectMap.values()) interviews.registerConfiguredProject(project.id, project.name);
  interviews.joinActiveProjects(identity.userId);
  const discoveredNames = new Set([...discoveredProjectMap.values()].map(project => project.name));
  const projects = interviews.projects(identity.userId)
    .filter(project => !configuredProjectMap.has(project.id) || projectAccess(configuredProjectMap.get(project.id), identity))
    // Hide entries registered under the former hashed ID of a knowledge base that is now listed by name.
    .filter(project => discoveredProjectMap.has(project.id) || !(/^kb-[0-9a-f]{32}$/.test(project.id) && discoveredNames.has(project.name)))
    .map(project => {
      return { ...project, knowledgeConfigured: configuredProjectMap.has(project.id) || projectBindingMap.has(project.id) || discoveredProjectMap.has(project.id), role: null, roleConfigured: true, roleRequired: false, roleTestMode: false };
    });
  return { projects, discoveryWarning };
}

function getInterviewMemory() {
  if (!interviewMemory) {
    const client = new AIProjectClient(process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT, getCredential());
    interviewMemory = new InterviewMemory(new FoundryMemory(client, process.env.AZURE_MEMORY_STORE_NAME || "requirements-memory", interviews), interviews);
  }
  return interviewMemory;
}

let projectKnowledge;
function getProjectKnowledge() {
  if (!projectKnowledge) projectKnowledge = new ProjectKnowledge(getCredential(), configuredProjects);
  return projectKnowledge;
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------
let _credential = null;

function getCredential() {
  if (!_credential) {
    const apiKey = process.env.AZURE_VOICELIVE_API_KEY;
    if (localOnly) {
      _credential = new AzureCliCredential();
      console.log("[AUTH] Using Azure CLI credential (local only)");
    } else if (apiKey) {
      _credential = new AzureKeyCredential(apiKey);
      console.log("[AUTH] Using API key credential");
    } else {
      _credential = new DefaultAzureCredential();
      console.log("[AUTH] Using DefaultAzureCredential");
    }
  }
  return _credential;
}

// ---------------------------------------------------------------------------
// Agent routing
// ---------------------------------------------------------------------------
// Session fields that choose which Foundry resource, project, agent, or managed
// identity the server's own credential is used against. These come from server
// configuration only. A WebSocket client can override them only when the
// deployment explicitly opts in with VOICELIVE_ALLOW_CLIENT_AGENT_OVERRIDE=true
// (intended for trusted local development, never for a publicly reachable app).
const AGENT_ROUTING_FIELDS = {
  agent_name: "AZURE_VOICELIVE_AGENT_NAME",
  project: "AZURE_VOICELIVE_PROJECT",
  agent_version: "AZURE_VOICELIVE_AGENT_VERSION",
  foundry_resource_override: "AZURE_VOICELIVE_FOUNDRY_RESOURCE_OVERRIDE",
  auth_identity_client_id: "AZURE_VOICELIVE_AUTH_IDENTITY_CLIENT_ID",
};

// /ws requires a signed-in user by default. In Azure Container Apps, built-in
// authentication (Easy Auth) sets this header after signing the user in; external
// requests cannot set it. Set VOICELIVE_ALLOW_ANONYMOUS=true only for trusted local
// development where no authentication layer is in front of the app.
const PRINCIPAL_ID_HEADER = "x-ms-client-principal-id";
const AUTH_REQUIRED_MESSAGE =
  "Authentication required. Sign in to the app, or set VOICELIVE_ALLOW_ANONYMOUS=true " +
  "for trusted local development.";
// WebSocket close code for a policy violation (RFC 6455)
const WS_POLICY_VIOLATION = 1008;

function allowAnonymous() {
  return (
    (process.env.VOICELIVE_ALLOW_ANONYMOUS || "false").trim().toLowerCase() ===
    "true"
  );
}

function isAuthenticated(req) {
  if (allowAnonymous()) return true;
  return Boolean((req.headers[PRINCIPAL_ID_HEADER] || "").trim());
}

function allowClientAgentOverride() {
  return (
    (process.env.VOICELIVE_ALLOW_CLIENT_AGENT_OVERRIDE || "false")
      .trim()
      .toLowerCase() === "true"
  );
}

function resolveAgentRouting(clientId, frontendConfig) {
  const allowOverride = allowClientAgentOverride();
  const resolved = {};
  const ignored = [];
  for (const [field, envName] of Object.entries(AGENT_ROUTING_FIELDS)) {
    const clientValue = frontendConfig[field];
    if (allowOverride && clientValue) {
      resolved[field] = clientValue;
      continue;
    }
    if (clientValue) ignored.push(field);
    resolved[field] = process.env[envName] || "";
  }
  if (ignored.length > 0) {
    console.warn(
      `[WS] Ignoring client-supplied ${ignored.join(", ")} for ${clientId}; ` +
        "set VOICELIVE_ALLOW_CLIENT_AGENT_OVERRIDE=true to allow (trusted local use only)"
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
expressWs(app);

// CORS
app.use((_req, res, next) => {
  if (localOnly) {
    const host = _req.headers.host;
    const allowedHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
    if (!allowedHosts.includes(host) || (_req.headers.origin && !allowedHosts.some((value) => _req.headers.origin === `http://${value}`))) {
      return res.status(403).json({ message: "Local origin required" });
    }
    return next();
  }
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.use(express.json());

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "healthy", service: "voicelive-websocket" });
});

app.get("/config", (_req, res) => {
  if (localOnly) {
    const entraAuth = entraConfig ? { tenantId: entraConfig.tenantId, clientId: entraConfig.clientId, apiScope: entraConfig.apiScope } : null;
    return res.json({ mode: "agent", authMethod: entraConfig ? "entra" : "azure_cli", authRequired: Boolean(entraConfig), entraAuth, memoryEnabled, promptRoleTesting });
  }
  res.json({
    mode: process.env.VOICELIVE_MODE || "model",
    model: process.env.VOICELIVE_MODEL || "gpt-realtime",
    voice:
      process.env.VOICELIVE_VOICE || "en-US-Ava:DragonHDLatestNeural",
    voiceType: process.env.VOICELIVE_VOICE_TYPE || "azure-standard",
    transcribeModel:
      process.env.VOICELIVE_TRANSCRIBE_MODEL || "gpt-4o-transcribe",
    instructions:
      process.env.VOICELIVE_INSTRUCTIONS ||
      "You are a helpful AI assistant. Respond naturally and conversationally. Keep your responses concise but engaging.",
    agentName: process.env.AZURE_VOICELIVE_AGENT_NAME || "",
    project: process.env.AZURE_VOICELIVE_PROJECT || "",
    authMethod: process.env.AZURE_VOICELIVE_API_KEY
      ? "api_key"
      : "default_credential",
    allowClientAgentOverride: allowClientAgentOverride(),
    authRequired: !allowAnonymous(),
  });
});

if (memoryEnabled) {
  app.use("/memory", async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try { req.memoryIdentity = await requestIdentity(bearerToken(req.headers.authorization)); req.memoryUserId = req.memoryIdentity.userId; next(); }
    catch (error) { res.status(401).json({ message: error instanceof EntraAuthError ? error.message : "Sign in with Azure CLI to access interview memory." }); }
  });
  app.get("/memory/projects", async (req, res) => {
    try {
      const { projects, discoveryWarning } = await visibleProjects(req.memoryIdentity);
      const selected = projects.find(project => project.id === req.query.projectId);
      res.json({ projects, discoveryWarning, selectedProjectId: selected?.id || "", interviews: selected ? interviews.list(req.memoryUserId, selected.id) : [] });
    } catch (error) { res.status(503).json({ message: error.message }); }
  });
  app.post("/memory/projects", (req, res) => {
    try { res.status(201).json(interviews.createProject(req.memoryUserId, req.body.name)); }
    catch (error) { res.status(400).json({ message: error.message }); }
  });
  app.get("/memory/projects/:projectId/documents", async (req, res) => {
    try { authorizeProject(req.memoryIdentity, req.params.projectId); }
    catch { return res.status(403).json({ message: "Project access denied." }); }
    const binding = projectBindingMap.get(req.params.projectId);
    if (!binding) return res.status(409).json({ message: "A project knowledge base and agent version must be configured before uploading documents." });
    try { res.json({ documents: await getProjectKnowledge().list(binding) }); }
    catch (error) { res.status(503).json({ message: error.message }); }
  });
  app.post("/memory/projects/:projectId/documents", (req, res, next) => {
    try { authorizeProject(req.memoryIdentity, req.params.projectId); }
    catch { return res.status(403).json({ message: "Project access denied." }); }
    if (!projectBindingMap.has(req.params.projectId)) return res.status(409).json({ message: "A project knowledge base and agent version must be configured before uploading documents." });
    express.raw({ type: "application/octet-stream", limit: "10mb" })(req, res, error => {
      if (error) return res.status(error.status || 400).json({ message: "Document upload failed. The maximum file size is 10 MB." });
      next();
    });
  }, async (req, res) => {
    try { res.status(201).json(await getProjectKnowledge().upload(projectBindingMap.get(req.params.projectId), req.query.name, req.body)); }
    catch (error) { res.status(400).json({ message: error.message }); }
  });
  app.post("/memory/projects/:projectId/archive", (req, res) => {
    try { res.json(interviews.archiveProject(req.memoryUserId, req.params.projectId)); }
    catch (error) { res.status(error.message.startsWith("End all interviews") ? 409 : 403).json({ message: error.message }); }
  });
  app.get("/memory/projects/:projectId/interviews", (req, res) => {
    try { authorizeProject(req.memoryIdentity, req.params.projectId); res.json({ interviews: interviews.list(req.memoryUserId, req.params.projectId) }); }
    catch { res.status(403).json({ message: "Project access denied." }); }
  });
  app.post("/memory/projects/:projectId/retry", async (req, res) => {
    try { authorizeProject(req.memoryIdentity, req.params.projectId); }
    catch { return res.status(403).json({ message: "Project access denied." }); }
    if (interviews.busy(req.memoryUserId, req.params.projectId)) return res.status(409).json({ message: "End the active interview before retrying memory." });
    try {
      if (!entraConfig) throw new EntraAuthError("Microsoft Entra sign-in is required to retrieve your employee ID.");
      const identity = await resolveEmployeeIdentity(req.memoryIdentity, bearerToken(req.headers["x-graph-authorization"]), entraConfig);
      await getInterviewMemory().memory.bindEmployeeScope(identity, req.params.projectId);
    } catch (error) { return res.status(403).json({ message: error.message }); }
    try { res.json(await getInterviewMemory().retry(req.memoryUserId, req.params.projectId)); }
    catch (error) { res.status(503).json(memoryFailure(error)); }
  });
  app.get("/memory/projects/:projectId/interviews/:interviewId", (req, res) => {
    try {
      const context = { userId: req.memoryUserId, projectId: req.params.projectId, interviewId: req.params.interviewId };
      authorizeProject(req.memoryIdentity, context.projectId);
      const interview = interviews.get(context.userId, context.projectId, context.interviewId);
      const transcript = interviews.transcript(context).map(({ item_id, role, content }) => ({ id: item_id, role, text: content, isFinal: true, historical: true }));
      res.json({ interview, conversationIds: interviews.conversationIds(context), transcript });
    } catch { res.status(403).json({ message: "Interview access denied." }); }
  });
  app.post("/memory/projects/:projectId/members", (req, res) => {
    try {
      authorizeProject(req.memoryIdentity, req.params.projectId);
      if (typeof req.body.userId !== "string" || !/^[0-9a-f-]{36}:[0-9a-f-]{36}$/i.test(req.body.userId)) throw new Error("Expected a tenantId:objectId member identity.");
      interviews.grantAccess(req.memoryUserId, req.params.projectId, req.body.userId);
      res.sendStatus(204);
    } catch (error) { res.status(403).json({ message: error.message }); }
  });
}

// ---------------------------------------------------------------------------
// Speech-to-text locale discovery (cached)
// ---------------------------------------------------------------------------
let _sttLocalesCache = null;

async function fetchSttLocales() {
  if (_sttLocalesCache) return _sttLocalesCache;

  const endpoint = (process.env.AZURE_VOICELIVE_ENDPOINT || "").replace(
    /\/$/,
    ""
  );
  if (!endpoint) return [];

  const apiVersion = process.env.SPEECH_API_VERSION || "2025-10-15";
  const url = `${endpoint}/speechtotext/transcriptions/locales?api-version=${apiVersion}`;

  try {
    const headers = {};
    const apiKey = process.env.AZURE_VOICELIVE_API_KEY;
    if (apiKey) {
      headers["Ocp-Apim-Subscription-Key"] = apiKey;
    } else {
      const credential = getCredential();
      const token = await credential.getToken(
        "https://cognitiveservices.azure.com/.default"
      );
      headers["Authorization"] = `Bearer ${token.token}`;
    }

    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // API returns {"Submit": [...], "Transcribe": [...]} — merge all unique locales
    const allLocales = new Set();
    for (const locales of Object.values(data)) {
      if (Array.isArray(locales)) {
        locales.forEach((l) => allLocales.add(l));
      }
    }
    _sttLocalesCache = [...allLocales].sort();
    console.log(
      `[LANG] Fetched ${_sttLocalesCache.length} STT locales from API`
    );
    return _sttLocalesCache;
  } catch (err) {
    console.warn(`[LANG] Failed to fetch STT locales: ${err.message}`);
    return [];
  }
}

app.get("/languages", async (_req, res) => {
  try {
    const locales = await fetchSttLocales();
    res.json({ azureSpeechLocales: locales });
  } catch (err) {
    res.json({ azureSpeechLocales: [] });
  }
});

// ---------------------------------------------------------------------------
// Active handlers per client
// ---------------------------------------------------------------------------
const _handlers = new Map();

async function cleanupClient(clientId) {
  const handler = _handlers.get(clientId);
  if (handler) {
    _handlers.delete(clientId);
    await handler.stop();
  }
}

// ---------------------------------------------------------------------------
// WebSocket endpoint
// ---------------------------------------------------------------------------

app.ws("/ws/:clientId", (ws, req) => {
  const clientId = localOnly ? randomUUID() : req.params.clientId;
  if (localOnly && req.headers.origin !== `http://${req.headers.host}`) {
    ws.close(WS_POLICY_VIOLATION, "Local origin required");
    return;
  }
  if (!isAuthenticated(req)) {
    console.warn(`[WS] Rejected unauthenticated WebSocket for ${clientId}`);
    ws.send(JSON.stringify({ type: "error", message: AUTH_REQUIRED_MESSAGE }));
    ws.close(WS_POLICY_VIOLATION, "Authentication required");
    return;
  }
  console.log(`[WS] Client ${clientId} connected`);
  let authentication = null;
  const authTimer = verifyEntraToken ? setTimeout(() => { if (!authentication) ws.close(WS_POLICY_VIOLATION, "Authentication required"); }, 15000) : null;
  const rejectSocket = (message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "error", message }));
    ws.close(WS_POLICY_VIOLATION, "Authentication required");
  };

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());
      let identity;
      if (verifyEntraToken) {
        if (message.type === "authenticate") {
          if (authentication) return rejectSocket("This connection is already authenticated.");
          // Assigned before awaiting so later messages wait for this verification.
          authentication = verifyEntraToken(message.access_token, message.id_token)
            .then(identity => resolveEmployeeIdentity(identity, message.graph_token, entraConfig));
          try { await authentication; clearTimeout(authTimer); }
          catch (error) { rejectSocket(error instanceof EntraAuthError ? error.message : "Sign-in failed."); }
          return;
        }
        if (!authentication) return rejectSocket("Sign in with Microsoft Entra to continue.");
        try { identity = await authentication; } catch { return; }
      }
      await handleMessage(clientId, message, ws, identity);
    } catch (err) {
      console.error(`[WS] Error handling message from ${clientId}:`, err);
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    console.log(`[WS] Client ${clientId} disconnected`);
    cleanupClient(clientId).catch((error) => console.error("[MEMORY] Disconnect cleanup failed:", error.message));
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error for ${clientId}:`, err);
    cleanupClient(clientId).catch((error) => console.error("[MEMORY] Error cleanup failed:", error.message));
  });
});

async function handleMessage(clientId, message, ws, identity) {
  const msgType = message.type;

  if (msgType === "start_session") {
    const config = localOnly ? { proactive_greeting: false, project_id: message.project_id, interview_id: message.interview_id, initial_text: message.initial_text, request_agent_turn: message.request_agent_turn === true } : { ...message };
    delete config.type;
    await startSession(clientId, config, ws, identity);
  } else if (msgType === "stop_session") {
    await stopSession(clientId, ws);
  } else if (msgType === "audio_chunk") {
    const handler = _handlers.get(clientId);
    if (handler) await handler.sendAudio(message.data || "");
  } else if (msgType === "send_text") {
    const handler = _handlers.get(clientId);
    try {
      if (!handler) throw new Error("Start a session before sending a message.");
      await handler.sendText(message.text || "");
    } catch (error) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "chat_error", message: error.message }));
    }
  } else if (msgType === "interrupt") {
    const handler = _handlers.get(clientId);
    if (handler) await handler.interrupt();
  } else {
    console.warn(`[WS] Unknown message type from ${clientId}: ${msgType}`);
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function sendToClient(ws, clientId) {
  return (msg) => {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      console.error(`[WS] Failed to send to ${clientId}:`, err);
    }
  };
}

async function startSession(clientId, frontendConfig, ws, verifiedIdentity) {
  let memoryContext;
  try {
    await cleanupClient(clientId);
    const endpoint = process.env.AZURE_VOICELIVE_ENDPOINT;
    if (!endpoint) throw new Error("Missing AZURE_VOICELIVE_ENDPOINT");

    const credential = getCredential();
    const send = sendToClient(ws, clientId);
    const agentRouting = resolveAgentRouting(clientId, frontendConfig);
    if (memoryEnabled) {
      const identity = verifiedIdentity;
      if (!verifyEntraToken || !identity) throw new EntraAuthError("Microsoft Entra sign-in is required to retrieve your employee ID.");
      if (ws.readyState !== 1) return;
      const configured = authorizeProject(identity, frontendConfig.project_id);
      const binding = projectBindingMap.get(frontendConfig.project_id);
      if (binding) await getProjectKnowledge().verify(binding);
      await getInterviewMemory().memory.bindEmployeeScope(identity, frontendConfig.project_id);
      if (ws.readyState !== 1) return;
      if (configured) {
        memoryContext = interviews.open(identity.userId, frontendConfig.project_id, frontendConfig.interview_id);
        Object.assign(memoryContext, {
          projectName: configured.name,
          knowledgeToolEndpoint: configured.knowledgeToolEndpoint,
          firstName: identity.firstName || String(identity.name || "").trim().split(/\s+/)[0] || "",
        });
      } else {
        memoryContext = interviews.open(identity.userId, frontendConfig.project_id, frontendConfig.interview_id);
        memoryContext.firstName = identity.firstName || String(identity.name || "").trim().split(/\s+/)[0] || "";
      }
    }

    // Build typed session config — frontend values override .env defaults
    const config = {
      voiceOnly: localOnly,
      requestAgentTurn: memoryEnabled && frontendConfig.request_agent_turn === true && !frontendConfig.interview_id && !frontendConfig.initial_text,
      initialText: typeof frontendConfig.initial_text === "string" ? frontendConfig.initial_text.trim() : "",
      memorySession: memoryContext ? { coordinator: getInterviewMemory(), context: memoryContext } : undefined,
      projectEndpoint: process.env.AZURE_EXISTING_AIPROJECT_ENDPOINT,
      mode: frontendConfig.mode || process.env.VOICELIVE_MODE || "model",
      model: frontendConfig.model || process.env.VOICELIVE_MODEL || "gpt-realtime",
      voice:
        frontendConfig.voice ||
        process.env.VOICELIVE_VOICE ||
        "en-US-Ava:DragonHDLatestNeural",
      voiceType:
        frontendConfig.voice_type ||
        process.env.VOICELIVE_VOICE_TYPE ||
        "azure-standard",
      transcribeModel:
        frontendConfig.transcribe_model ||
        process.env.VOICELIVE_TRANSCRIBE_MODEL ||
        "gpt-4o-transcribe",
      inputLanguage: frontendConfig.input_language || "",
      instructions:
        frontendConfig.instructions ||
        process.env.VOICELIVE_INSTRUCTIONS ||
        "",
      temperature: parseFloat(
        frontendConfig.temperature ??
          process.env.VOICELIVE_TEMPERATURE ??
          "0.7"
      ),
      vadType:
        frontendConfig.vad_type ||
        process.env.VOICELIVE_VAD_TYPE ||
        "azure_semantic",
      noiseReduction: frontendConfig.noise_reduction ?? true,
      echoCancellation: frontendConfig.echo_cancellation ?? true,
      agentName: agentRouting.agent_name,
      projectName: agentRouting.project,
      agentVersion: agentRouting.agent_version,
      knowledge: memoryContext ? getProjectKnowledge() : undefined,
      conversationId: frontendConfig.conversation_id || "",
      foundryResourceOverride: agentRouting.foundry_resource_override,
      authIdentityClientId: agentRouting.auth_identity_client_id,
      proactiveGreeting: frontendConfig.proactive_greeting ?? true,
      greetingType: frontendConfig.greeting_type || "llm",
      greetingText: frontendConfig.greeting_text || "",
      interimResponse: frontendConfig.interim_response ?? false,
      interimResponseType: frontendConfig.interim_response_type || "llm",
      interimTriggerTool: frontendConfig.interim_trigger_tool ?? true,
      interimTriggerLatency: frontendConfig.interim_trigger_latency ?? true,
      interimLatencyMs: frontendConfig.interim_latency_ms ?? 100,
      interimInstructions: frontendConfig.interim_instructions || "",
      interimStaticTexts: frontendConfig.interim_static_texts || "",
    };

    const Handler = localOnly ? NativeVoiceHandler : VoiceHandler;
    const handler = new Handler(
      clientId,
      endpoint,
      credential,
      send,
      config
    );
    _handlers.set(clientId, handler);
    await handler.start();

    console.log(
      `[APP] Session started for ${clientId} in ${config.mode} mode`
    );
  } catch (err) {
    if (memoryContext) interviews.setStatus(memoryContext, "interrupted", "Session setup failed; retained data can be resumed.");
    console.error(`[APP] Failed to start session for ${clientId}:`, err);
    try {
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({ type: "error", message: String(err.message || err) })
        );
      }
    } catch (_) {
      // ignore send failure
    }
  }
}

async function stopSession(clientId, ws) {
  await cleanupClient(clientId);
  try {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "session_stopped" }));
    }
  } catch (_) {
    // ignore
  }
  console.log(`[APP] Session stopped for ${clientId}`);
}

// ---------------------------------------------------------------------------
// Static files — checked after API routes
// ---------------------------------------------------------------------------
const staticCandidates = [
  ...(localOnly ? [join(__dirname, "local-ui")] : []),
  join(__dirname, "static"),
  join(__dirname, "..", "frontend", "dist"),
];

let staticDir = null;
for (const candidate of staticCandidates) {
  if (existsSync(candidate)) {
    staticDir = candidate;
    break;
  }
}

if (staticDir) {
  if (localOnly) {
    app.use(express.static(join(__dirname, "..", "frontend", "public")));
    app.get("/lucide.js", (_req, res) => res.sendFile(join(__dirname, "node_modules", "lucide", "dist", "umd", "lucide.js")));
    app.get("/msal-browser.js", (_req, res) => res.sendFile(join(__dirname, "node_modules", "@azure", "msal-browser", "lib", "msal-browser.min.js")));
    app.get("/msal-redirect-bridge.js", (_req, res) => res.sendFile(join(__dirname, "node_modules", "@azure", "msal-browser", "lib", "redirect-bridge", "msal-redirect-bridge.min.js")));
    app.get("/auth/redirect", (_req, res) => {
      res.set("Cache-Control", "no-store");
      res.sendFile(join(__dirname, "local-ui", "auth-redirect.html"));
    });
  }
  app.use(express.static(staticDir));
  // SPA fallback — serve index.html for unmatched routes
  app.get("*", (_req, res) => {
    res.sendFile(join(staticDir, "index.html"));
  });
  console.log(`[STATIC] Serving static files from ${staticDir}`);
} else {
  app.get("/", (_req, res) => {
    res.json({ message: "Voice Live WebSocket Server", version: "1.0.0" });
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown() {
  console.log("[APP] Shutting down…");
  for (const [clientId] of _handlers) {
    await cleanupClient(clientId);
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "8000", 10);

if (memoryEnabled && !entraConfig) localUserId().catch(() => console.warn("[AUTH] Local identity warm-up failed; sign in with Azure CLI before loading interviews."));

app.listen(PORT, localOnly ? "127.0.0.1" : "0.0.0.0", () => {
  console.log(`[APP] Voice Live WebSocket server listening at http://localhost:${PORT}`);
});
