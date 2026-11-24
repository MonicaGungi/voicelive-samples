# Voice Live Universal Assistant — JavaScript Backend

Node.js (Express) backend for the Voice Live Universal Assistant, using the `@azure/ai-voicelive` SDK (1.0.0-beta.3).

## Prerequisites

- Node.js 22+
- Azure Voice Live resource with endpoint URL
- Azure CLI logged in (`az login`) or an API key

## Local Existing Voice Agent

The local profile uses this sample's Express relay and browser audio worklets with
Microsoft's `@azure/ai-projects` native voice-agent SDK. It requires Node.js 22+.
The older Voice Live agent integration is for **text** agents, not `kind: voice`.
See [Microsoft's connection guidance](https://learn.microsoft.com/azure/foundry/agents/how-to/migrate-from-voice-live#update-the-client-connection).

The ignored `.env` in this directory configures the existing agent. Required values:

```dotenv
VOICELIVE_LOCAL_ONLY=true
VOICELIVE_PROMPT_ROLE_TESTING=true
PORT=8000
AZURE_EXISTING_AGENT_ID=resource-planner-voice-agent
AZURE_EXISTING_AIPROJECT_ENDPOINT=https://resource-planner-voice-resource.services.ai.azure.com/api/projects/resource-planner-voice-agent
```

From the repository root in PowerShell:

```powershell
cd voice-live-universal-assistant/javascript
npm.cmd install
az login
az account set --subscription 4170b6e1-6b11-4782-96fb-b6e622dcc5c1
npm.cmd start
```

Open http://localhost:8000. Audio mode is selected by default; select **Start voice session**
and allow microphone access to begin.
The voice button toggles between **Start voice session** and **End voice session**.
Ending releases the microphone and connection and finalizes pending memory saves.
There is no separate End or Start chat button. **Mute/Unmute** controls microphone
input while spoken responses continue. Speaking interrupts queued playback using
the saved agent's turn-detection and interruption settings.

Select the **T** icon to switch to text mode. The chat composer and conversation
history appear, microphone capture stops, and spoken playback is silenced. Type
a message and select the send icon (or press Enter). Sending from a disconnected
page starts a session without requesting microphone access. Shift+Enter inserts
a newline. A first message sent during the saved opening greeting waits until
the greeting finishes.

Project memory is checkpointed automatically after completed turns and a short
pause; extraction runs in the background without closing voice or chat. Changing
project/interview automatically finalizes the previous session. Closing the page
releases microphone capture and triggers backend cleanup and a final memory save.
Automatic saving does not require ending a session manually. The voice toggle and Mute controls are
hidden in text mode; the first typed message starts chat automatically.

Select the waveform icon to return to audio mode. An active conversation keeps
the same connection and history while microphone capture and spoken playback
resume. The mode resets to audio when the page is reloaded. These are local UI
and playback settings; the saved agent's instructions and tools are unchanged.

The backend binds only to `127.0.0.1`, requires same-origin browser connections,
and uses `AzureCliCredential`. No token or API key is sent to the browser. The
browser has voice controls and text chat, with no avatar. Chat history stays in
the page and isn't saved by this application. Local sessions set
`store: false` to disable conversation recording; resource-level tracing policies
remain under your Azure configuration.

The agent is read, never created or updated. Its immutable version, instructions,
tools, model, voice, greeting, and turn detection remain managed by Foundry.
If the selected version includes a saved WebRTC avatar with audio streaming disabled, for local
audio playback, the adapter requests `output_audit_audio: true` **for that session
only** and translates the runtime's avatar type spelling. It never negotiates
avatar WebRTC or displays video. Removing the avatar from the saved definition
would require another agent version; this application does not do that.

Run offline checks with `npm.cmd test`. The live speech check is opt-in: it uses
Azure and may incur usage charges. On Windows, generate its non-sensitive audio
fixture in the temporary directory first:

```powershell
Add-Type -AssemblyName System.Speech
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$speech.SetOutputToWaveFile((Join-Path $env:TEMP 'voicelive-smoke.wav'), $format)
$speech.Speak('Hello. Please say hello back in one short sentence.')
$speech.Dispose()
node --env-file=.env --test localConfig.test.js
```

The live test streams PCM speech at microphone speed and requires an actual audio
reply after the user turn, not merely a successful WebSocket handshake.

## Quick Start

### Persistent Requirements Memory (Local Profile)

The local profile resolves the highest active, published numeric version of the
existing voice agent at the start of each session. For an unpinned project with a
knowledge mapping, it selects the highest version whose attached MCP tool matches
that project. Add `:VERSION` to
`AZURE_EXISTING_AGENT_ID` to pin a specific version. The agent's existing toolbox
and skill remain unchanged. Memory uses the official Projects SDK's
`beta.memoryStores.searchMemories` and `updateMemories` APIs against the existing
`requirements-memory` store. It does not attach the unsupported
`memory_search_preview` tool to the voice agent or create any agent/version.
See [Microsoft's memory setup guide](https://learn.microsoft.com/azure/foundry/agents/how-to/memory-usage).

Enterprise NOVA is added in the tracked [projects.config.json](projects.config.json),
not by creating an agent or another project-list database. The application also
discovers knowledge bases on the Search services referenced by the existing
configuration. Every authenticated user in the configured tenant can see active
projects. Discovered projects without a compatible knowledge binding are marked
unavailable for interviews; they never fall back to another project's knowledge.
Cloud memory is private:
each user and project receives a `{project-id}-{employee-id}` scope. The server
obtains the employee ID from Microsoft Graph using the authenticated user's
delegated token, verifies that the Graph profile matches the signed-in tenant and
user, and records the mapping in the existing local SQLite database. Employee IDs
are visible in Foundry scope names and are not authorization credentials.

This POC requires the Foundry memory store to be reserved exclusively for the
configured Entra tenant. SQLite binds the short-scope registry to the first tenant,
rejects duplicate or changed employee IDs among registered users, and rejects an
unregistered short scope that already contains Foundry records. It cannot verify
the entire directory's uniqueness or prevent another deployment from using the
same Foundry store; administrators must enforce those policies. Employee IDs must
start with a letter or digit and contain at most 16 ASCII letters, digits, hyphens,
or underscores. The former shared `Enterprise-NOVA` scope
is no longer read or written; its records are not deleted. The existing SQLite
database continues to hold local interview transcripts and conversation IDs.

New memories are written to the short scope. Previous `nova-v2-...` and
`requirements-v1-...` private scopes are also searched for the same user and
project, without copying or deleting old records. The `employee_memory_scopes`
table stores tenant ID, user object ID, project ID, employee ID, scope, and
optional first and last names for a future authorized administrator lookup. Names
come only from validated Entra profile claims, can be missing, and never affect
access or scope. The mapping is created when an authorized interview starts;
historical users appear as they return. No administrator search endpoint is
enabled. Protect the SQLite database with OS access controls and use a
SQLite-aware backup to preserve mappings and legacy scope keys.

Each session also receives bounded recent excerpts from other local interviews
owned by the same authenticated user in the same project (up to 120 turns,
12,000 serialized characters, and 2,000 characters per turn). These are separate
from cloud memories and are not a complete interview archive. Other
users' private transcripts are excluded. Local continuity requires the same
interview database; it remains available when cloud retrieval fails.

Startup runs the personal interview-memory lookups concurrently and does not retry pending
cloud extraction before connecting. Unsynced local transcript excerpts remain
available; cloud uploads still happen at turn checkpoints, session end, or manual
retry. Connection time also includes agent lookup, authentication, and the saved
automatic greeting finishing. Disabling that greeting in Foundry removes that
provider-side startup work; suppressing its playback locally does not.

Returning to a selected interview creates a new native connection but resumes the
same local interview. Its transcript supplies the previously stated role and last
topic; onboarding is not restarted. A new interview receives the same user's
earlier project excerpts and continues relevant unresolved topics. Continuity is
sent as a reference conversation item with `createResponse: false`, as well as
session context, so loading history does not itself request an answer.

For managed interviews, the saved agent's automatic startup greeting is allowed
to finish but its text and audio are not forwarded or recorded. Input becomes
ready afterward. This avoids repeated greetings without cancelling the provider
response or modifying the saved agent. Existing historical greeting records are
not deleted.

Use the same server and interview database when testing continuity. Separate
local servers can use different SQLite files even when their project names match.

Shared project descriptions come from the selected project's configured knowledge
MCP tool, not from personal chat-summary memory. The configured label and endpoint
must match the saved voice agent's attached MCP tool; an unmapped or mismatched
project is rejected before connecting to prevent cross-project knowledge exposure.
Enterprise NOVA remains mapped to its existing Foundry IQ knowledge base.
An MCP initialization failure is logged as `[KNOWLEDGE]`; check the Foundry
connection and Azure AI Search permissions or networking if retrieval fails.

#### Project Documents

Users can create projects with the plus button and upload documents using the
project documents button after an administrator configures the project's knowledge
binding. The dialog shows the project ID when setup is incomplete. Project
visibility is shared among authenticated users; interview transcripts and memory
remain private to the signed-in user and project.

For each user-created project, an administrator must preconfigure a separate
Foundry IQ file knowledge source and knowledge base, and publish a version of the
same voice agent that retains the existing discovery toolbox and skill and attaches
only that knowledge base. Add the following entry to the optional
`projectBindings` array in [projects.config.json](projects.config.json), then
restart the local server. The values come from the actual project and Foundry
configuration, not from project names:

```json
{
  "projectId": "user-created-project-id",
  "agentVersion": "19",
  "knowledgeToolLabel": "project-knowledge",
  "knowledgeToolEndpoint": "https://your-search.search.windows.net/knowledgebases/project-knowledge/mcp",
  "knowledgeSource": "project-files"
}
```

Each binding must use a distinct knowledge base and file source. Before uploads
and interviews, the server verifies that the knowledge base contains only its
configured file source and that existing configured projects do not use that
source. It also checks the agent version's MCP endpoint before connecting. The
administrator must restrict who can change Foundry knowledge-base definitions,
agent versions, and the local configuration. Publishing a version changes the
agent's latest version for other applications; this app selects the latest
compatible version for unpinned configured projects. The app does not publish
agent versions or create knowledge bases, sources, storage accounts, or model
deployments.

Uploads go directly to the configured Foundry IQ file knowledge source, using the
backend's Azure CLI identity. Foundry indexes the file synchronously; the dialog
reports success only after the service confirms it. Files are limited to 10 MB.
Search permissions must allow the backend to inspect knowledge bases and upload
files, and the existing Foundry connection identity must be able to retrieve the
new knowledge base. A file source can use the existing embedding deployment if
the administrator configures its model authentication; credentials from existing
sources are not copied. A model-free, minimal file source is also supported by
Foundry IQ. File source indexes and model calls can incur charges.

For a greeting with an unknown role, the agent asks the role first. After the
role reply, it briefly describes known project context and asks one expectations
question, then uses the existing discovery skill for adaptive follow-ups. Earlier
user contributions inform the question without being treated as new approvals.

### Microsoft Entra sign-in and roles

With `VOICELIVE_ENTRA_AUTH=true`, users sign in in the browser. The backend verifies
each access token's signature, tenant, audience, issuing client, delegated scope,
and expiry before using `tid:oid` as the user ID. Interviews and cloud memory are
keyed by that user and the selected project. The user declares an interview role
in conversation; it is not an authorization claim. A new voice interview asks for
the role aloud, while a resumed interview continues its existing conversation.
Foundry calls still use the backend's
Azure CLI credential; sign in with `az login` as before.

App registration (single tenant):

1. **Authentication**: add a **Single-page application** redirect URI
  `http://localhost:8000/auth/redirect`. Open the app at `http://localhost:8000`,
  not `127.0.0.1`.
2. **Expose an API**: set the Application ID URI to `api://<client-id>` and add
  a delegated scope named `access_as_user`.
3. **API permissions**: add the app's own `access_as_user` permission and grant
  consent. Add Microsoft Graph delegated **User.Read** and grant user or admin
  consent according to tenant policy; the application calls `/me` to retrieve
  the employee ID for the signed-in user.
4. In **Enterprise applications**, check that **Assignment required?** is set to
  **No**. Tenant consent policies or Conditional Access may still require admin
  action. No application roles, groups claims, or individual assignments are
  required by this application.

Then set:

```dotenv
VOICELIVE_ENTRA_AUTH=true
ENTRA_TENANT_ID=<tenant-id>
ENTRA_CLIENT_ID=<application-client-id>
```

Roles are free-form interview context and do not grant project access or approval
authority. Previous interviews remain available only to their owner within the same
project. Existing private memory records remain in their original scopes; the former
shared `Enterprise-NOVA` scope is preserved but not read in private-memory mode.
Restart the backend after changing configuration.

Required local environment settings:

```dotenv
VOICELIVE_MEMORY_ENABLED=true
AZURE_MEMORY_STORE_NAME=requirements-memory
```

1. Select **New project** (+), enter a distinct product/project name, and select it.
2. Leave **New interview** selected for a fresh conversation, or select a prior
	interview to continue it. Audio and text modes use the same project/interview.
3. Memory sync runs automatically after completed turns. Changing project/interview
  or closing the page also saves pending text. Extraction can take about a minute;
  don't treat a failed save as successful recall.
4. Start a new interview in the same project to retrieve relevant memories.

To remove a duplicate project, select it, choose the trash icon beside **Project**,
and confirm **Remove project**. This archives the project for all its members; it
does not erase local interviews or Foundry memories and does not delete Azure
resources. Only the owner can remove a project, and active interviews or memory
saves must finish first. Existing duplicate names have short ID suffixes so you
can distinguish them. New duplicate names for the same owner are rejected.
Archived projects are excluded from project lists and cannot be opened through
the interview APIs; retained data is not a permanent privacy-deletion operation.

The existing store's configured extraction details already prioritize business
goals, requirements, confirmed decisions, constraints, assumptions, dependencies,
and unresolved questions, and exclude passwords, credentials, and sensitive
personal information. These store-level feature defaults are immutable; the app
does not recreate your store. The backend retrieves scoped relevant context before
connecting and adds it as reference conversation data with `createResponse: false`.
It never sends replacement `instructions` or `tools` in `session.update`.

**Identity and authorization:** the backend derives the user ID from the trusted
Azure CLI token's tenant ID and object ID, never from browser parameters or headers.
Memory scopes are a versioned SHA-256 hash of `[userId, projectId]`. Project IDs are
server-generated UUIDs. Every project/interview operation also checks SQLite project
membership; knowing a scope or interview ID does not grant access. Shared-project
members retain separate per-user memories and interviews. Project owners can grant
membership through `POST /memory/projects/{projectId}/members` with
`{"userId":"<tenantId>:<objectId>"}`. Only the authenticated project owner can do so.
An operator can obtain these IDs with `az account show --query tenantId` and
`az ad signed-in-user show --query id`; do not provide tokens or passwords.

This remains a **single-CLI-identity, loopback-only development app**. People sharing
that CLI account are the same authenticated user. Multi-user hosting requires
actual end-user authentication before adapting the identity resolver; this sample
does not claim that a project selector authenticates a person. The memory routes
are disabled outside local-only mode. Existing portal memories in other scope
namespaces are not imported automatically because their ownership is unknown.

Dropdown initialization warms the CLI credential on backend startup and uses Azure
Identity's `getBearerTokenProvider` to reuse and refresh tokens instead of launching
Azure CLI separately for every local metadata request. The running backend stays
bound to its first trusted tenant/object identity and rejects a different identity
on refresh; **restart the backend when switching CLI accounts**. Project membership
checks still run for every request. Startup returns authorized projects and the
remembered project's interviews together. Metadata responses use
`Cache-Control: no-store`; project lists and transcripts are not cached in browser
storage. A cold CLI login can still take several seconds, during which dropdowns
show disabled loading placeholders rather than empty selectable lists.

**Durability and privacy:** local interview IDs, actual Foundry `conversation_id`
values, and both sides of the text transcript are stored in SQLite under
`%LOCALAPPDATA%/VoiceLiveRequirements/` (or `~/.local/share/VoiceLiveRequirements/`).
The filename is derived from the Foundry project endpoint. Set
`VOICELIVE_INTERVIEW_DB` to choose another backend path. This avoids writing
transcripts into the OneDrive-synced repository. The database is plaintext and
relies on OS account access controls and disk protection. Do not enter secrets.
Use an encrypted, access-controlled database and explicit retention/deletion
policy before production. Browser storage contains only the last selected project
ID, not transcripts or credentials. Raw-audio recording remains off (`store:false`).

**Interview resume:** Foundry voice realtime currently exposes no documented
reconnect-to-existing-conversation-ID option in this SDK. The app preserves each
real `conv_...` ID separately for correlation, and continues an interview through a
new native voice connection with authorized recent transcript (up to 60 messages,
24,000 characters) and retrieved project memory. It does not pretend a local UUID
is a Foundry conversation ID or invent a `conversation_id` handshake parameter.

Selecting a previous interview loads its saved local transcript immediately;
switch to **T** to view the messages without starting a new session. The details
endpoint returns only transcripts authorized for the current CLI user and project.
Starting or ending a resumed voice session keeps that history visible in text mode.

Failed extraction leaves unexported transcripts in the database. The next session
retries them before retrieving memories. Concurrent interviews for the same
user/project are blocked while active or saving. A failed search/update shows an
explicit warning while voice remains usable; a cross-scope result fails closed.

The compact workspace keeps project/interview selection at the top and the audio
or text controls at the bottom. **Session details** (...) contains the real Foundry
conversation ID and technical memory diagnostics. A failed cloud update is labelled
**Saved locally**, not **Synced**. **Retry sync** calls the authorization-checked
`POST /memory/projects/{projectId}/retry` endpoint; it does not change model
credentials or IAM, and only marks a transcript exported after extraction succeeds.

**Known Azure-side blocker observed during live verification:** `requirements-memory`
returned `ResourceError` / downstream HTTP 401 for its `text-embedding-3-small`
deployment: the model resource's key or token was rejected. Your local CLI can read
the memory store, but the memory service cannot authenticate to the embedding model.
Subsequent extraction retries also returned downstream 401 for `gpt-5.6-sol`.
The UI identifies the failing model and retains every pending interview for retry.
The service recommends Account Managed Identity for a connected model resource, or
re-adding a key-based connection after key rotation. Have the resource owner inspect
the actual model binding/connection and permissions; don't rotate credentials or
change IAM blindly. Until repaired, the offline recall/isolation tests pass but
**live persistent recall is not verified**. No agent, toolbox, memory-store
definition, model connection, or IAM setting was changed by this implementation.

Run all offline tests with `npm.cmd test`. The live memory test uses isolated
synthetic data, two real voice sessions, and the actual memory APIs; it may incur
Azure charges and removes only its newly generated test scope afterward. Generate
its two audio fixtures on Windows:

```powershell
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$fixtures = @(@{Name='voicelive-memory-budget.wav';Text='For this project the approved annual budget is forty two thousand dollars and single sign on is mandatory. Please confirm these requirements.'}, @{Name='voicelive-memory-question.wav';Text='What annual budget and mandatory sign in requirement did we agree on in the previous interview?'})
foreach ($fixture in $fixtures) {
  $speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $speech.SetOutputToWaveFile((Join-Path $env:TEMP $fixture.Name), $format)
  $speech.Speak($fixture.Text)
  $speech.Dispose()
}
node --env-file=.env --input-type=module -e "process.env.VOICELIVE_TEST_MEMORY='true'; await import('./memoryService.test.js');"
Startup runs the personal interview-memory lookups concurrently and does not retry pending

Implementation files: `memoryService.js` owns scoped search/update and durable retry;
`interviewStore.js` owns project authorization and interview records;
`nativeVoiceHandler.js` captures final transcripts, stores Foundry IDs, and injects
context; `app.js` resolves the trusted identity and exposes guarded local routes.

```bash
cd javascript

# Install dependencies
npm install

# Configure environment
cp .env.sample .env
# Edit .env with your Azure Voice Live endpoint and credentials

# Run the server
npm start
# Or with auto-reload:
npm run dev
```

Open the frontend at `http://localhost:8000`

## Architecture

The JavaScript backend replicates the same WebSocket API contract as the [Python backend](../python/):

```
Frontend (React+Vite) → WebSocket → app.js → voiceHandler.js → Azure Voice Live SDK
```

| File | Purpose |
|------|---------|
| `app.js` | Express server, REST endpoints, WebSocket routing, static serving, CORS |
| `voiceHandler.js` | SDK bridge — VoiceLive client/session management, event handling |

The JavaScript backend follows SDK-idiomatic patterns using a `VoiceHandler` class with typed
builder methods that return the appropriate SDK configuration objects:

- `_getVoice()` → `{ type: "azure-standard"|"openai", name }` voice config
- `_getTurnDetection()` → VAD config object
- `_getTranscriptionOptions()` → transcription config (model mode only)
- `_getInterimResponseConfig()` → interim response config or `null`
- `_buildModelSessionConfig()` → full session config for model mode (includes transcription, temperature, instructions)
- `_buildAgentSessionConfig()` → leaner session config for agent mode (voice, VAD, echo/noise, interim response only)

## WebSocket Protocol

Connect to `ws://localhost:8000/ws/{clientId}` and exchange JSON messages:

**Client → Server:**
- `{ "type": "start_session", "mode": "model", "model": "gpt-realtime", ... }` — start voice session
- `{ "type": "audio_chunk", "data": "<base64 PCM16>" }` — stream microphone audio
- `{ "type": "interrupt" }` — cancel current response
- `{ "type": "stop_session" }` — end session

**Server → Client:**
- `{ "type": "session_started", "config": { ... } }`
- `{ "type": "audio_data", "data": "<base64 PCM16>", "sampleRate": 24000 }`
- `{ "type": "transcript", "role": "user"|"assistant", "text": "...", "isFinal": bool }`
- `{ "type": "status", "state": "listening"|"thinking"|"speaking" }`
- `{ "type": "stop_playback" }`
- `{ "type": "session_stopped" }`
- `{ "type": "error", "message": "..." }`

## REST Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /config` | Server configuration (mode, model, voice, etc.) |
| `GET /languages` | Available STT locales |

## Connection Modes

Set `VOICELIVE_MODE` in `.env`:

| Mode    | Description                                      |
|---------|--------------------------------------------------|
| `model` | Connects directly to a model (e.g. gpt-realtime) — default |
| `agent` | Connects via Foundry Agent Service               |

## Settings

All settings are configurable from the frontend UI. Default values can be set via `.env`:

| Setting | Env Variable | Default |
|---------|-------------|---------|
| Mode | `VOICELIVE_MODE` | `model` |
| Model | `VOICELIVE_MODEL` | `gpt-realtime` |
| Voice | `VOICELIVE_VOICE` | `en-US-Ava:DragonHDLatestNeural` |
| Temperature | `VOICELIVE_TEMPERATURE` | `0.7` |
| VAD Type | `VOICELIVE_VAD_TYPE` | `azure_semantic` |
| Instructions | `VOICELIVE_INSTRUCTIONS` | _(empty)_ |
| Agent Name | `AZURE_VOICELIVE_AGENT_NAME` | _(required for agent mode)_ |
| Project | `AZURE_VOICELIVE_PROJECT` | _(required for agent mode)_ |

## Local Development

Build the frontend first, then run the backend:

```bash
# Build frontend (from repo root)
cd frontend && npm install && npm run build && cd ..

# Run JavaScript backend
cd javascript
cp .env.sample .env
# Edit .env with your endpoint
npm install
npm run dev
```

The server serves the built frontend from `./static/` or `../frontend/dist/`.

## Notes

No JavaScript-specific limitations at this time. All frontend features are supported.
