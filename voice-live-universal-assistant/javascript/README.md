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
existing voice agent at the start of each session. Add `:VERSION` to
`AZURE_EXISTING_AGENT_ID` to pin a specific version. The agent's existing toolbox
and skill remain unchanged. Memory uses the official Projects SDK's
`beta.memoryStores.searchMemories` and `updateMemories` APIs against the existing
`requirements-memory` store. It does not attach the unsupported
`memory_search_preview` tool to the voice agent or create any agent/version.
See [Microsoft's memory setup guide](https://learn.microsoft.com/azure/foundry/agents/how-to/memory-usage).

Enterprise NOVA is added in the tracked [projects.config.json](projects.config.json),
not by creating an agent or another project-list database. Its `memoryScope` is the
exact existing `Enterprise-NOVA` scope. `accessGroupIds` requires membership in the
existing `ResourcePlanner-Users` group. This authorization check is separate from
the shared project memory scope. The existing SQLite database continues to hold
local interview transcripts and conversation IDs.

Each session also receives bounded recent excerpts from other local interviews
owned by the same authenticated user in the same project (up to 120 turns,
12,000 serialized characters, and 2,000 characters per turn). These are separate
from shared project memories and are not a complete interview archive. Other
users' private transcripts are excluded. Local continuity requires the same
interview database; it remains available when cloud retrieval fails.

Startup runs the three memory lookups concurrently and does not retry pending
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

For a greeting with an unknown role, the agent asks the role first. After the
role reply, it briefly describes known project context and asks one expectations
question, then uses the existing discovery skill for adaptive follow-ups. Earlier
user contributions inform the question without being treated as new approvals.

The current CLI token has no app roles and no Stakeholder, HR, or Developer groups.
For temporary local testing, `VOICELIVE_PROMPT_ROLE_TESTING=true` allows the user to
name one of those perspectives at any point in the conversation. This switch requires
`VOICELIVE_LOCAL_ONLY=true`, binds the app to loopback, and does not change Entra
claims. Turn it off after testing. For normal use, an admin must configure verified
Entra group object IDs in `roleGroupIds` or exact app-role claim strings in
`roleAppValues` in `projects.config.json`. For example:

```json
"roleGroupIds": {
  "stakeholder": ["<Stakeholder Entra group object ID>"],
  "hr": ["<HR Entra group object ID>"],
  "developer": ["<Developer Entra group object ID>"]
}
```

Exactly one mapped role is required in normal use. In local prompt-role test mode,
the agent reuses the latest perspective explicitly stated by this user in the
same project, including earlier interviews. A current explicit role change takes
precedence; it asks only if the role is missing or ambiguous. Shared project memory
without user attribution and assistant guesses are not role evidence. This does
not grant authorization or modify Entra claims.
The role adds generic interview perspective and one-question-
at-a-time guidance; Enterprise NOVA requirements come from the existing memory store,
the agent, and its attached discovery skill. Restart the backend after changing the
configuration.

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
```

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
