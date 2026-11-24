const startButton = document.querySelector('#start');
const muteButton = document.querySelector('#mute');
const status = document.querySelector('#status');
const connection = document.querySelector('#connection');
const canvas = document.querySelector('#wave');
const drawing = canvas.getContext('2d');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const sendButton = document.querySelector('#send');
const messages = document.querySelector('#messages');
const chatError = document.querySelector('#chat-error');
const audioModeButton = document.querySelector('#mode-audio');
const textModeButton = document.querySelector('#mode-text');
const chatSection = document.querySelector('.chat');
const visual = document.querySelector('.visual');
const projectSelect = document.querySelector('#project');
const interviewSelect = document.querySelector('#interview');
const newProjectButton = document.querySelector('#new-project');
const removeProjectButton = document.querySelector('#remove-project');
const memoryStatus = document.querySelector('#memory-status');
const memoryBanner = document.querySelector('#memory-banner');
const memorySummary = document.querySelector('#memory-summary');
const memoryDiagnostic = document.querySelector('#memory-diagnostic');
const retryMemoryButton = document.querySelector('#retry-memory');
const sessionDetails = document.querySelector('#session-details');
const sessionDetailsToggle = document.querySelector('#session-details-toggle');
const conversationLabel = document.querySelector('#conversation-id');
const copyConversationButton = document.querySelector('#copy-conversation');
let memoryEnabled = false;
let configurationReady = false;
let conversationId = '';
let retryingMemory = false;
let removingProject = false;
let projectToRemove = '';
let projectsLoading = true;
let interviewsLoading = true;
let interviewRequestId = 0;
let auth = null;
const messageElements = new Map();
let current = null;
let mode = 'audio';

function updateControls() {
  const audio = mode === 'audio';
  document.body.dataset.mode = mode;
  audioModeButton.setAttribute('aria-pressed', String(audio));
  textModeButton.setAttribute('aria-pressed', String(!audio));
  audioModeButton.disabled = textModeButton.disabled = Boolean(current && (!current.ready || current.stopping));
  chatSection.hidden = audio;
  chatForm.hidden = audio;
  visual.hidden = !audio;
  document.querySelector('.controls').hidden = !audio;
  startButton.hidden = !audio;
  muteButton.hidden = !audio;
  muteButton.disabled = !current?.stream;
  const voiceActive = Boolean(current?.stream);
  const ending = Boolean(current?.stopping);
  const voiceLabel = ending ? 'Ending...' : voiceActive ? 'End voice session' : 'Start voice session';
  startButton.innerHTML = `<i data-lucide="${voiceActive || ending ? 'square' : 'mic'}" aria-hidden="true"></i><span>${voiceLabel}</span>`;
  startButton.title = voiceLabel;
  startButton.setAttribute('aria-pressed', String(voiceActive));
  startButton.classList.toggle('is-recording', voiceActive);
  const listsLoading = memoryEnabled && (projectsLoading || interviewsLoading);
  startButton.disabled = listsLoading || removingProject || retryingMemory || !configurationReady || (memoryEnabled && !projectSelect.value) || Boolean(current && (!current.ready || current.stopping || !audio || current.microphonePending));
  const selectionBlocked = Boolean(current && (!current.ready || current.stopping)) || retryingMemory || removingProject;
  projectSelect.disabled = projectsLoading || selectionBlocked;
  interviewSelect.disabled = projectsLoading || interviewsLoading || !projectSelect.value || selectionBlocked;
  newProjectButton.disabled = projectsLoading || selectionBlocked;
  projectSelect.setAttribute('aria-busy', String(projectsLoading));
  interviewSelect.setAttribute('aria-busy', String(interviewsLoading));
  removeProjectButton.hidden = projectSelect.selectedOptions[0]?.dataset.owner !== 'true';
  removeProjectButton.disabled = listsLoading || Boolean(current && (!current.ready || current.stopping)) || retryingMemory || removingProject || !projectSelect.value;
  retryMemoryButton.disabled = Boolean(current) || retryingMemory || removingProject || !projectSelect.value;
  window.lucide.createIcons();
  updateComposer();
}

function stopMicrophone(session) {
  session.capture?.disconnect();
  session.capture = null;
  session.stream?.getTracks().forEach((track) => track.stop());
  session.stream = null;
  session.buffer = new Int16Array(0);
  cancelAnimationFrame(session.animation);
  drawing.clearRect(0, 0, canvas.width, canvas.height);
  setMuted(session, false);
}

async function selectMode(next) {
  if (mode === next) return;
  mode = next;
  const session = current;
  if (session) {
    session.playback?.port.postMessage(null);
    if (mode === 'text') stopMicrophone(session);
    else if (session.ready) await activateMicrophone(session);
    if (current === session && !session.busy && (mode === 'text' || session.stream)) status.textContent = mode === 'audio' ? 'Listening' : 'Connected';
  }
  updateControls();
  if (mode === 'text') chatInput.focus();
}

function updateComposer() {
  sendButton.disabled = (memoryEnabled && (projectsLoading || interviewsLoading)) || removingProject || retryingMemory || !configurationReady || (memoryEnabled && !projectSelect.value) || !chatInput.value.trim() || Boolean(current && (!current.ready || current.stopping || current.busy || current.pendingText));
}

function setMemoryState(state, message = '') {
  memoryDiagnostic.textContent = message || { idle: 'Cloud memory not loaded', loaded: 'Project memory loaded', saved: 'Project memory synced' }[state] || state;
  memoryBanner.dataset.state = state;
  memoryBanner.hidden = state !== 'error';
  retryMemoryButton.hidden = state !== 'error';
  if (state === 'error') {
    memoryStatus.textContent = 'Cloud memory needs attention';
    memorySummary.textContent = /authenticat|model connection|credentials/i.test(message)
      ? 'Azure rejected the memory model connection. Your interview is saved on this device.'
      : 'Cloud sync is unavailable. Your interview is saved on this device.';
  } else {
    memoryStatus.textContent = state === 'saving' ? 'Syncing project memory' : 'Loading project memory';
    memorySummary.textContent = 'Interview text remains saved on this device.';
  }
  updateControls();
}

async function signIn({ tenantId, clientId, apiScope }) {
  const redirectUri = `${location.origin}/auth/redirect`;
  const client = new window.msal.PublicClientApplication({
    auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}`, redirectUri, postLogoutRedirectUri: redirectUri },
    cache: { cacheLocation: 'sessionStorage' },
  });
  await client.initialize();
  const result = await client.handleRedirectPromise();
  const account = result?.account || client.getAllAccounts().find(item => item.tenantId === tenantId);
  if (!account) {
    status.textContent = 'Redirecting to Microsoft sign-in...';
    await client.loginRedirect({ scopes: [apiScope], extraScopesToConsent: ['User.Read'] });
    return null;
  }
  client.setActiveAccount(account);
  try {
    await client.acquireTokenSilent({ scopes: ['User.Read'], account });
  } catch (error) {
    if (error instanceof window.msal.InteractionRequiredAuthError) {
      await client.acquireTokenRedirect({ scopes: ['User.Read'], account });
      return null;
    }
    throw new Error('Unable to access your Microsoft Entra profile. Check Microsoft Graph User.Read consent.');
  }
  document.querySelector('#account-name').textContent = account.name || account.username;
  document.querySelector('#account-name').hidden = false;
  document.querySelector('#sign-out').hidden = false;
  return { client, account, apiScope, idToken: result?.idToken || account.idToken || '', idTokenExpires: result?.idTokenClaims?.exp || account.idTokenClaims?.exp || 0 };
}

async function accessToken() {
  if (!auth) return '';
  try {
    const result = await auth.client.acquireTokenSilent({ scopes: [auth.apiScope], account: auth.account });
    if (result.idToken) {
      auth.idToken = result.idToken;
      auth.idTokenExpires = result.idTokenClaims?.exp || 0;
    }
    return result.accessToken;
  } catch (error) {
    if (error instanceof window.msal.InteractionRequiredAuthError) {
      await auth.client.acquireTokenRedirect({ scopes: [auth.apiScope], account: auth.account });
      throw new Error('Redirecting to Microsoft sign-in...');
    }
    throw new Error('Unable to renew your Microsoft sign-in. Refresh the page and try again.');
  }
}

async function graphAccessToken() {
  if (!auth) throw new Error('Microsoft Entra sign-in is required.');
  try {
    return (await auth.client.acquireTokenSilent({ scopes: ['User.Read'], account: auth.account })).accessToken;
  } catch (error) {
    if (error instanceof window.msal.InteractionRequiredAuthError) {
      await auth.client.acquireTokenRedirect({ scopes: ['User.Read'], account: auth.account });
      throw new Error('Redirecting to Microsoft sign-in...');
    }
    throw new Error('Unable to access your Microsoft Entra profile. Check Microsoft Graph User.Read consent.');
  }
}

async function memoryRequest(path, options = {}) {
  const headers = { ...options.headers };
  if (auth) headers.Authorization = `Bearer ${await accessToken()}`;
  if (auth && path.endsWith('/retry')) headers['X-Graph-Authorization'] = `Bearer ${await graphAccessToken()}`;
  const response = await fetch(path, { ...options, headers });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Interview request failed.');
  return result;
}

function updateInterviewOption(interview) {
  const statuses = { save_failed: 'Saved locally', completed: 'Synced', active: 'In progress', interrupted: 'Paused', saving: 'Syncing', new: 'New' };
  const date = new Date(interview.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let option = [...interviewSelect.options].find(item => item.value === interview.id);
  if (!option) { option = new Option('', interview.id); interviewSelect.append(option); }
  option.textContent = `${date} - ${statuses[interview.status] || interview.status} (${interview.id.slice(0, 6)})`;
}

function renderInterviews(items, selected = '') {
  interviewSelect.replaceChildren(new Option('New interview', ''));
  interviewSelect.dataset.projectId = projectSelect.value;
  for (const interview of items) updateInterviewOption(interview);
  if ([...interviewSelect.options].some(option => option.value === selected)) interviewSelect.value = selected;
}

function showInterviewError(error) {
  status.textContent = 'Unable to load interviews. Check the local server connection.';
  chatError.textContent = error.message || status.textContent;
  chatError.hidden = false;
}

async function loadInterviews(selected = '') {
  const requestId = ++interviewRequestId;
  const projectId = projectSelect.value;
  interviewsLoading = true;
  const retainOptions = interviewSelect.dataset.projectId === projectId;
  if (!retainOptions) interviewSelect.replaceChildren(new Option('Loading interviews...', ''));
  updateControls();
  try {
    const items = projectId ? (await memoryRequest(`/memory/projects/${encodeURIComponent(projectId)}/interviews`)).interviews : [];
    if (requestId !== interviewRequestId || projectSelect.value !== projectId) return;
    renderInterviews(items, selected);
    interviewsLoading = false;
    updateControls();
    await loadInterviewDetails();
    const failed = items.find(interview => interview.status === 'save_failed');
    if (!interviewSelect.value && failed) setMemoryState('error', failed.memory_error || 'Cloud sync failed; interview saved locally.');
  } catch (error) {
    if (requestId === interviewRequestId && !retainOptions) interviewSelect.replaceChildren(new Option('Unable to load interviews', ''));
    throw error;
  } finally {
    if (requestId === interviewRequestId) { interviewsLoading = false; updateControls(); }
  }
}

async function loadInterviewDetails() {
  sessionDetails.hidden = true;
  sessionDetailsToggle.setAttribute('aria-expanded', 'false');
  const projectId = projectSelect.value;
  const interviewId = interviewSelect.value;
  conversationId = '';
  conversationLabel.textContent = 'No conversation selected';
  copyConversationButton.disabled = true;
  setMemoryState('idle');
  messages.replaceChildren();
  messageElements.clear();
  if (!projectId || !interviewId) return;
  const result = await memoryRequest(`/memory/projects/${encodeURIComponent(projectId)}/interviews/${encodeURIComponent(interviewId)}`);
  if (projectSelect.value !== projectId || interviewSelect.value !== interviewId || current) return;
  for (const message of result.transcript || []) showChatMessage(message);
  conversationId = result.conversationIds.at(-1) || '';
  conversationLabel.textContent = conversationId ? `Conversation: ${conversationId}` : 'No conversation ID available';
  copyConversationButton.disabled = !conversationId;
  setMemoryState(result.interview.memory_error ? 'error' : 'idle', result.interview.memory_error || (result.interview.status === 'completed' ? 'Project memory synced' : 'Interview saved on this device'));
}

async function loadProjects(selected = '') {
  const remembered = selected;
  projectsLoading = interviewsLoading = true;
  ++interviewRequestId;
  projectSelect.replaceChildren(new Option('Loading projects...', ''));
  interviewSelect.replaceChildren(new Option('Loading interviews...', ''));
  updateControls();
  try {
    const result = await memoryRequest(`/memory/projects?projectId=${encodeURIComponent(remembered)}`);
    const discoveryStatus = document.querySelector('#role-status');
    discoveryStatus.textContent = result.discoveryWarning || '';
    discoveryStatus.hidden = !result.discoveryWarning;
    projectSelect.replaceChildren(new Option('Select a project', ''));
    const nameCounts = new Map();
    for (const project of result.projects) {
      const name = project.name.trim().toLowerCase();
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    }
    for (const project of result.projects) {
      const duplicate = nameCounts.get(project.name.trim().toLowerCase()) > 1;
      const displayName = duplicate ? `${project.name} (${project.id.slice(0, 6)})` : project.name;
      const option = new Option(project.knowledgeConfigured ? displayName : `${displayName} (knowledge unavailable)`, project.id);
      option.dataset.owner = String(Boolean(project.isOwner));
      projectSelect.append(option);
    }
    if (result.projects.some(project => project.id === remembered)) projectSelect.value = remembered;
    projectsLoading = false;
    if (Array.isArray(result.interviews) && result.selectedProjectId === projectSelect.value) {
      renderInterviews(result.interviews);
      interviewsLoading = false;
      updateControls();
      await loadInterviewDetails();
      const failed = result.interviews.find(interview => interview.status === 'save_failed');
      if (failed) setMemoryState('error', failed.memory_error || 'Cloud sync failed; interview saved locally.');
    } else {
      await loadInterviews();
    }
  } catch (error) {
    projectSelect.replaceChildren(new Option('Unable to load projects', ''));
    interviewSelect.replaceChildren(new Option('Unable to load interviews', ''));
    throw error;
  } finally {
    projectsLoading = interviewsLoading = false;
    updateControls();
  }
}

async function initializeMemory() {
  status.textContent = 'Loading workspace...';
  try {
    const config = await memoryRequest('/config');
    if (config.entraAuth) {
      auth = await signIn(config.entraAuth);
      if (!auth) return;
    }
    memoryEnabled = Boolean(config.memoryEnabled);
    document.querySelector('#interview-controls').hidden = !memoryEnabled;
    if (memoryEnabled) await loadProjects();
    else projectsLoading = interviewsLoading = false;
    configurationReady = true;
    status.textContent = 'Ready';
  } catch (error) {
    status.textContent = error.message;
    setMemoryState('error', error.message);
  }
  updateControls();
}

function showChatMessage(message) {
  let element = messageElements.get(message.id);
  if (!element) {
    element = document.createElement('article');
    element.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
    const label = document.createElement('strong');
    label.textContent = message.role === 'user' ? 'You' : 'Business Analyst';
    element.append(label, document.createElement('p'));
    messages.append(element);
    messageElements.set(message.id, element);
  }
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  element.querySelector('p').textContent = message.text;
  if (nearBottom || message.role === 'user') messages.scrollTop = messages.scrollHeight;
}

function send(session, message) {
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
}

function setMuted(session, muted) {
  session.muted = muted;
  session.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  session.buffer = new Int16Array(0);
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButton.title = muted ? 'Unmute microphone' : 'Mute microphone';
  muteButton.innerHTML = `<i data-lucide="${muted ? 'mic' : 'mic-off'}" aria-hidden="true"></i><span>${muted ? 'Unmute' : 'Mute'}</span>`;
  window.lucide.createIcons();
}

function endSession(message = 'Ready') {
  const session = current;
  current = null;
  if (session) {
    clearTimeout(session.timeout);
    send(session, { type: 'stop_session' });
    session.socket?.close();
    stopMicrophone(session);
    session.playback?.port.postMessage(null);
    session.playback?.disconnect();
    session.context?.close().catch(() => {});
    cancelAnimationFrame(session.animation);
  }
  drawing.clearRect(0, 0, canvas.width, canvas.height);
  startButton.disabled = false;
  muteButton.disabled = true;
  setMuted({}, false);
  status.textContent = message;
  connection.textContent = 'Disconnected';
  if (session?.pendingText) chatInput.value = session.pendingText;
  updateControls();
  if (memoryEnabled && !session?.selectionChange && !session?.unloading) loadInterviews(session?.interviewId || interviewSelect.value).catch(showInterviewError);
  session?.onStopped?.();
}

async function closeForSelectionChange() {
  if (!current) return;
  const session = current;
  session.selectionChange = true;
  if (session.closed) return session.closed;
  session.closed = new Promise((resolve) => { session.onStopped = resolve; });
  requestEndSession();
  return session.closed;
}

function requestEndSession() {
  if (!current || current.stopping) return;
  if (!memoryEnabled) return endSession();
  const session = current;
  session.stopping = true;
  stopMicrophone(session);
  session.playback?.port.postMessage(null);
  status.textContent = 'Saving interview...';
  setMemoryState('saving');
  clearTimeout(session.timeout);
  session.timeout = setTimeout(() => endSession('Memory save is still processing. The transcript is retained on the backend.'), 210000);
  send(session, { type: 'stop_session' });
  updateControls();
}

function draw(session) {
  if (current !== session || mode !== 'audio' || !session.stream) return;
  const samples = new Uint8Array(session.analyser.fftSize);
  session.analyser.getByteTimeDomainData(samples);
  drawing.clearRect(0, 0, canvas.width, canvas.height);
  drawing.strokeStyle = session.muted ? '#a4ada8' : getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#0d0d0d';
  drawing.lineWidth = 2;
  drawing.beginPath();
  samples.forEach((value, index) => {
    const position = index / (samples.length - 1) * canvas.width;
    const amplitude = canvas.height / 2 + (value - 128) * 1.8;
    if (index === 0) drawing.moveTo(position, amplitude);
    else drawing.lineTo(position, amplitude);
  });
  drawing.stroke();
  session.animation = requestAnimationFrame(() => draw(session));
}

async function enableMicrophone(session) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 24000, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  if (current !== session || mode !== 'audio') { stream.getTracks().forEach((track) => track.stop()); return; }
  session.stream = stream;
  session.capture = new AudioWorkletNode(session.context, 'audio-capture-processor');
  session.analyser = session.context.createAnalyser();
  session.analyser.fftSize = 512;
  const source = session.context.createMediaStreamSource(stream);
  source.connect(session.capture);
  source.connect(session.analyser);
  session.capture.connect(session.context.destination);
  session.capture.port.onmessage = ({ data }) => {
    if (current !== session || mode !== 'audio' || !session.ready || session.muted) return;
    const incoming = new Int16Array(data.buffer);
    const merged = new Int16Array(session.buffer.length + incoming.length);
    merged.set(session.buffer);
    merged.set(incoming, session.buffer.length);
    let offset = 0;
    while (offset + 2400 <= merged.length) {
      const chunk = merged.slice(offset, offset + 2400);
      const bytes = new Uint8Array(chunk.buffer);
      send(session, { type: 'audio_chunk', data: btoa(String.fromCharCode(...bytes)) });
      offset += 2400;
    }
    session.buffer = merged.slice(offset);
  };
  draw(session);
}

async function startSession(pendingText = '') {
  if (current) return;
  if (!configurationReady || (memoryEnabled && !projectSelect.value)) return;
  const session = { muted: false, ready: false, pendingText, projectId: projectSelect.value, requestedInterviewId: interviewSelect.value, buffer: new Int16Array(0) };
  current = session;
  if (!session.requestedInterviewId) {
    messages.replaceChildren();
    messageElements.clear();
  }
  chatError.hidden = true;
  updateComposer();
  startButton.disabled = true;
  status.textContent = 'Connecting...';
  connection.textContent = 'Connecting';
  updateControls();
  session.timeout = setTimeout(() => {
    if (current === session && !session.ready) endSession('Connection timed out. Check the backend and Azure CLI sign-in.');
  }, memoryEnabled ? 210000 : 60000);
  try {
    session.context = new AudioContext({ sampleRate: 24000 });
    await session.context.resume();
    await Promise.all([
      session.context.audioWorklet.addModule('/audio-capture-worklet.js'),
      session.context.audioWorklet.addModule('/audio-playback-worklet.js'),
    ]);
    if (current !== session) return;
    session.playback = new AudioWorkletNode(session.context, 'audio-playback-processor');
    session.playback.connect(session.context.destination);
    if (mode === 'audio') await enableMicrophone(session);
    if (current !== session) return;
    const token = await accessToken();
    const graphToken = await graphAccessToken();
    if (current !== session) return;
    session.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/${crypto.randomUUID()}`);
    session.initialTextSentByServer = memoryEnabled && Boolean(session.pendingText);
    session.socket.onopen = () => {
      if (token) send(session, { type: 'authenticate', access_token: token, graph_token: graphToken, id_token: auth?.idTokenExpires > Date.now() / 1000 ? auth.idToken : undefined });
      send(session, {
        type: 'start_session',
        project_id: session.projectId,
        interview_id: session.requestedInterviewId || undefined,
        initial_text: session.initialTextSentByServer ? session.pendingText : undefined,
        request_agent_turn: mode === 'audio' && !session.requestedInterviewId && !session.pendingText,
      });
    };
    session.socket.onmessage = ({ data }) => {
      if (current !== session) return;
      const message = JSON.parse(data);
      if (message.type === 'memory_status') {
        if (!message.background || message.state !== 'saving') setMemoryState(message.state, message.message || '');
        if (message.state === 'error') session.memoryError = true;
        if (message.state === 'saved') session.memoryError = false;
      } else if (message.type === 'interview_info') {
        session.interviewId = message.interview_id;
        updateInterviewOption({ id: session.interviewId, updated_at: new Date().toISOString(), status: 'active' });
        interviewSelect.value = session.interviewId;
        conversationId = message.conversation_id;
        conversationLabel.textContent = `Conversation: ${conversationId}`;
        copyConversationButton.disabled = false;
      } else if (message.type === 'session_started') {
        clearTimeout(session.timeout);
        session.ready = true;
        connection.textContent = 'Connected';
        status.textContent = mode === 'audio' ? 'Listening' : 'Connected';
        if (session.pendingText && !session.initialTextSentByServer) send(session, { type: 'send_text', text: session.pendingText });
        updateControls();
      } else if (message.type === 'audio_data') {
        if (mode !== 'audio' || session.stopping) return;
        const bytes = Uint8Array.from(atob(message.data), (character) => character.charCodeAt(0));
        session.playback.port.postMessage(bytes.buffer, [bytes.buffer]);
      } else if (message.type === 'stop_playback') {
        session.playback.port.postMessage(null);
      } else if (message.type === 'status') {
        if (session.stopping) return;
        session.busy = message.state === 'thinking' || message.state === 'speaking';
        const states = mode === 'audio' ? { listening: 'Listening', thinking: 'Thinking...', speaking: 'Speaking' } : { listening: 'Connected', thinking: 'Thinking...', speaking: 'Replying...' };
        status.textContent = states[message.state] || 'Connected';
        updateComposer();
      } else if (message.type === 'transcript') {
        showChatMessage(message);
        if (message.source === 'text') session.pendingText = '';
        updateComposer();
      } else if (message.type === 'chat_error') {
        chatError.textContent = message.message;
        chatError.hidden = false;
        if (session.pendingText) chatInput.value = session.pendingText;
        session.pendingText = '';
        updateComposer();
      } else if (message.type === 'error') {
        endSession(message.message || 'The voice connection failed.');
      } else if (message.type === 'session_stopped') {
        endSession(session.memoryError ? 'Interview saved on this device' : 'Ready');
      }
    };
    session.socket.onerror = () => { if (current === session) endSession('Cannot reach the local voice server.'); };
    session.socket.onclose = () => { if (current === session) endSession('Connection closed.'); };
  } catch (error) {
    if (current === session) endSession(error.name === 'NotAllowedError' ? 'Microphone access was denied.' : error.message);
  }
}

async function activateMicrophone(session) {
  if (session.microphonePending || session.stream) return;
  session.microphonePending = true;
  updateControls();
  try {
    await session.context.resume();
    await enableMicrophone(session);
  } catch (error) {
    if (current !== session) return;
    const message = error.name === 'NotAllowedError' ? 'Microphone access was denied.' : error.message;
    status.textContent = message;
    chatError.textContent = message;
    chatError.hidden = false;
  } finally {
    session.microphonePending = false;
    updateControls();
  }
}

startButton.addEventListener('click', async () => {
  if (current?.stream) return requestEndSession();
  if (!current) return startSession();
  if (mode === 'audio' && current.ready) await activateMicrophone(current);
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || sendButton.disabled) return;
  chatInput.value = '';
  chatError.hidden = true;
  if (!current) {
    startSession(text);
  } else {
    current.playback?.port.postMessage(null);
    current.pendingText = text;
    send(current, { type: 'send_text', text });
    updateComposer();
  }
});
chatInput.addEventListener('input', updateComposer);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

audioModeButton.addEventListener('click', () => selectMode('audio'));
document.querySelector('#sign-out').addEventListener('click', async () => {
  if (!auth) return;
  await closeForSelectionChange();
  await auth.client.logoutRedirect({ account: auth.account });
});
textModeButton.addEventListener('click', () => selectMode('text'));
muteButton.addEventListener('click', () => { if (current) setMuted(current, !current.muted); });
window.addEventListener('pagehide', () => { if (current) current.unloading = true; endSession(); });
window.lucide.createIcons();
updateControls();
projectSelect.addEventListener('change', async () => {
  await closeForSelectionChange();
  localStorage.setItem('requirements-project', projectSelect.value);
  messages.replaceChildren();
  messageElements.clear();
  conversationLabel.textContent = '';
  copyConversationButton.disabled = true;
  try { await loadInterviews(); }
  catch (error) { showInterviewError(error); }
  updateControls();
});
const projectDialog = document.querySelector('#project-dialog');
const removeProjectDialog = document.querySelector('#remove-project-dialog');
removeProjectButton.addEventListener('click', async () => {
  if (retryingMemory || removingProject || !projectSelect.value || removeProjectButton.hidden) return;
  await closeForSelectionChange();
  projectToRemove = projectSelect.value;
  document.querySelector('#remove-project-name').textContent = projectSelect.selectedOptions[0].textContent;
  document.querySelector('#remove-project-error').hidden = true;
  removeProjectDialog.showModal();
  document.querySelector('#cancel-remove-project').focus();
});
document.querySelector('#cancel-remove-project').addEventListener('click', () => removeProjectDialog.close());
document.querySelector('#remove-project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (removingProject || !projectToRemove || projectSelect.value !== projectToRemove) return;
  const submit = event.submitter;
  removingProject = true;
  submit.disabled = true;
  updateControls();
  try {
    await memoryRequest(`/memory/projects/${encodeURIComponent(projectToRemove)}/archive`, { method: 'POST' });
    if (localStorage.getItem('requirements-project') === projectToRemove) localStorage.removeItem('requirements-project');
    projectToRemove = '';
    messages.replaceChildren();
    messageElements.clear();
    chatInput.value = '';
    await loadProjects();
    await loadInterviewDetails();
    status.textContent = 'Ready';
    removeProjectDialog.close();
  } catch (error) {
    const label = document.querySelector('#remove-project-error');
    label.textContent = error.message;
    label.hidden = false;
  } finally { removingProject = false; submit.disabled = false; updateControls(); }
});
interviewSelect.addEventListener('change', async () => {
  const selected = interviewSelect.value;
  await closeForSelectionChange();
  messages.replaceChildren();
  messageElements.clear();
  try { await loadInterviews(selected); }
  catch (error) { showInterviewError(error); }
});
newProjectButton.addEventListener('click', async () => { await closeForSelectionChange(); document.querySelector('#project-error').hidden = true; projectDialog.showModal(); document.querySelector('#project-name').focus(); });
document.querySelector('#cancel-project').addEventListener('click', () => projectDialog.close());
document.querySelector('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const project = await memoryRequest('/memory/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('#project-name').value }) });
    localStorage.setItem('requirements-project', project.id);
    await loadProjects(project.id);
    projectDialog.close();
    document.querySelector('#project-name').value = '';
  } catch (error) {
    const label = document.querySelector('#project-error');
    label.textContent = error.message;
    label.hidden = false;
  } finally { submit.disabled = false; }
});
copyConversationButton.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(conversationId); copyConversationButton.title = 'Conversation ID copied'; }
  catch { memoryDiagnostic.textContent = 'Clipboard access was denied.'; memoryDiagnostic.hidden = false; }
});
sessionDetailsToggle.addEventListener('click', () => {
  sessionDetails.hidden = !sessionDetails.hidden;
  sessionDetailsToggle.setAttribute('aria-expanded', String(!sessionDetails.hidden));
});
retryMemoryButton.addEventListener('click', async () => {
  if (retryingMemory || current || !projectSelect.value) return;
  retryingMemory = true;
  setMemoryState('saving');
  try {
    const result = await memoryRequest(`/memory/projects/${encodeURIComponent(projectSelect.value)}/retry`, { method: 'POST' });
    await loadInterviews(interviewSelect.value);
    setMemoryState('saved', `${result.updated} interview(s) synced to Foundry.`);
  } catch (error) {
    setMemoryState('error', error.message);
  } finally { retryingMemory = false; updateControls(); }
});
initializeMemory();