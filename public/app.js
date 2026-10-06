const connectButton = document.querySelector("#connect-button");
const speechToggle = document.querySelector("#speech-toggle");
const statusDot = document.querySelector("#status-dot");
const statusLabel = document.querySelector("#status-label");
const commandForm = document.querySelector("#command-form");
const commandInput = document.querySelector("#command-input");
const sendButton = commandForm.querySelector("button");
const conversation = document.querySelector("#conversation");
const activity = document.querySelector("#activity");
const approvals = document.querySelector("#approvals");
const clearActivity = document.querySelector("#clear-activity");
const suggestions = document.querySelector("#suggestions");

let peerConnection;
let dataChannel;
let microphoneStream;
let assistantDraft = "";
let openAIRealtimeAvailable = false;
let speechRepliesEnabled = "speechSynthesis" in window;
let localVoiceInstalled = false;
let localRecorder;
let localRecordingChunks = [];
let localStatusText = "Local AI ready";
let handsFreeEnabled = false;
let voiceBusy = false;
let listeningPaused = false;
let recordingShouldSend = false;
let audioContext;
let analyser;
let microphoneSource;
let vadFrame;
let recordingStartedAt = 0;
let speechCandidateAt = 0;
let speechStartedAt = 0;
let lastSpeechAt = 0;
let noiseFloor = 0.006;

const SILENCE_TO_SEND_MS = 950;
const SPEECH_CONFIRM_MS = 160;
const MIN_SPEECH_MS = 260;
const MAX_RECORDING_MS = 30_000;

checkLocalBackend();
speechToggle.addEventListener("click", toggleSpeechReplies);
if (!("speechSynthesis" in window)) speechToggle.disabled = true;

connectButton.addEventListener("click", handleVoiceButton);
commandForm.addEventListener("submit", sendTextCommand);
clearActivity.addEventListener("click", () => (activity.innerHTML = ""));
suggestions?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-prompt]");
  if (!button) return;
  commandInput.value = button.dataset.prompt;
  commandForm.requestSubmit();
});
globalThis.desktopAssistant?.onPushToTalk(() => {
  logActivity("Global push-to-talk shortcut pressed");
  void handleVoiceButton();
});

async function connect() {
  if (!openAIRealtimeAvailable) return;
  setConnectionState("connecting", "Connecting…");
  connectButton.disabled = true;

  try {
    peerConnection = new RTCPeerConnection();
    const remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    peerConnection.ontrack = (event) => (remoteAudio.srcObject = event.streams[0]);

    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    microphoneStream.getTracks().forEach((track) => peerConnection.addTrack(track, microphoneStream));

    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", () => {
      setConnectionState("connected", "Listening");
      connectButton.textContent = "Disconnect";
      connectButton.disabled = false;
      commandInput.disabled = false;
      sendButton.disabled = false;
      document.body.classList.add("listening");
      logActivity("Voice session connected");
    });
    dataChannel.addEventListener("message", (event) => handleRealtimeEvent(JSON.parse(event.data)));
    dataChannel.addEventListener("close", () => disconnect(false));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const sessionResponse = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offer.sdp,
    });
    if (!sessionResponse.ok) {
      const contentType = sessionResponse.headers.get("content-type") || "";
      const detail = contentType.includes("json") ? await sessionResponse.json() : { message: await sessionResponse.text() };
      throw new Error(detail.message || detail.error?.message || detail.error?.code || "Could not start the voice session.");
    }

    await peerConnection.setRemoteDescription({ type: "answer", sdp: await sessionResponse.text() });
  } catch (error) {
    const message = friendlyConnectionError(error);
    addMessage("assistant", `Connection failed: ${message}`);
    logActivity(`Connection failed: ${message}`);
    disconnect();
  }
}

async function handleVoiceButton() {
  if (openAIRealtimeAvailable) {
    if (peerConnection) disconnect();
    else await connect();
    return;
  }
  if (!localVoiceInstalled) return;
  if (handsFreeEnabled) stopHandsFreeListening();
  else await startHandsFreeListening();
}

async function startHandsFreeListening() {
  try {
    handsFreeEnabled = true;
    if (!microphoneStream) {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.35;
      microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
      microphoneSource.connect(analyser);
    }
    await beginListeningTurn();
    logActivity("Hands-free listening enabled");
  } catch (error) {
    handsFreeEnabled = false;
    const message = friendlyConnectionError(error);
    addMessage("assistant", `Microphone failed: ${message}`);
    logActivity(`Microphone failed: ${message}`);
  }
}

async function beginListeningTurn() {
  if (!handsFreeEnabled || voiceBusy || listeningPaused || !microphoneStream) return;
  window.speechSynthesis?.cancel();
  const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((type) => MediaRecorder.isTypeSupported(type));
  localRecordingChunks = [];
  recordingShouldSend = false;
  localRecorder = new MediaRecorder(microphoneStream, preferredType ? { mimeType: preferredType } : undefined);
  localRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) localRecordingChunks.push(event.data);
  });
  localRecorder.addEventListener("stop", transcribeLocalRecording, { once: true });
  localRecorder.start(250);
  recordingStartedAt = performance.now();
  speechCandidateAt = 0;
  speechStartedAt = 0;
  lastSpeechAt = 0;
  connectButton.disabled = false;
  connectButton.textContent = "Stop listening";
  document.body.classList.add("listening");
  setConnectionState("listening", "Listening · speak when ready");
  monitorVoiceActivity();
}

function monitorVoiceActivity() {
  cancelAnimationFrame(vadFrame);
  const samples = new Uint8Array(analyser.frequencyBinCount);
  const tick = (now) => {
    if (!handsFreeEnabled || voiceBusy || localRecorder?.state !== "recording") return;
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const centered = (sample - 128) / 128;
      sum += centered * centered;
    }
    const level = Math.sqrt(sum / samples.length);
    if (!speechStartedAt) noiseFloor = Math.min(0.03, noiseFloor * 0.98 + Math.min(level, 0.03) * 0.02);
    const threshold = Math.max(0.016, noiseFloor * 2.8);

    if (level > threshold) {
      if (!speechCandidateAt) speechCandidateAt = now;
      if (!speechStartedAt && now - speechCandidateAt >= SPEECH_CONFIRM_MS) {
        speechStartedAt = speechCandidateAt;
        setConnectionState("hearing", "I hear you…");
      }
      if (speechStartedAt) lastSpeechAt = now;
    } else {
      speechCandidateAt = 0;
    }

    if (speechStartedAt && now - lastSpeechAt >= SILENCE_TO_SEND_MS && lastSpeechAt - speechStartedAt >= MIN_SPEECH_MS) {
      finishListeningTurn(true);
      return;
    }
    if (now - recordingStartedAt >= MAX_RECORDING_MS) {
      finishListeningTurn(Boolean(speechStartedAt));
      return;
    }
    vadFrame = requestAnimationFrame(tick);
  };
  vadFrame = requestAnimationFrame(tick);
}

function finishListeningTurn(send) {
  cancelAnimationFrame(vadFrame);
  if (localRecorder?.state !== "recording") return;
  recordingShouldSend = send;
  voiceBusy = send;
  if (send) {
    connectButton.textContent = "Understanding…";
    setConnectionState("working", "Understanding…");
  }
  localRecorder.stop();
}

function stopHandsFreeListening() {
  handsFreeEnabled = false;
  listeningPaused = false;
  recordingShouldSend = false;
  cancelAnimationFrame(vadFrame);
  if (localRecorder?.state === "recording") localRecorder.stop();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneSource?.disconnect();
  void audioContext?.close();
  microphoneStream = null;
  microphoneSource = null;
  analyser = null;
  audioContext = null;
  voiceBusy = false;
  document.body.classList.remove("listening", "hearing", "working", "speaking");
  connectButton.disabled = false;
  connectButton.textContent = "Start listening";
  setConnectionState("connected", localStatusText);
  logActivity("Hands-free listening stopped");
}

async function transcribeLocalRecording() {
  const type = localRecorder?.mimeType || localRecordingChunks[0]?.type || "audio/webm";
  const recording = new Blob(localRecordingChunks, { type });
  localRecorder = null;
  localRecordingChunks = [];
  document.body.classList.remove("listening");

  if (!recordingShouldSend) {
    voiceBusy = false;
    if (handsFreeEnabled && !listeningPaused) await beginListeningTurn();
    return;
  }

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": type },
      body: recording,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || result.error || "Transcription failed.");
    const text = result.text?.trim();
    if (!text) throw new Error("I could not hear any speech. Please try again.");
    addMessage("user", text);
    const backend = result.backend || "local speech";
    const fallback = result.fallback_from ? ` after ${result.fallback_from} fallback` : "";
    logActivity(`Transcribed with ${backend}${fallback} in ${result.duration_ms ?? "?"} ms`);
    await sendLocalCommand(text);
  } catch (error) {
    if (!/could not hear any speech/i.test(error.message)) addMessage("assistant", `Voice input failed: ${error.message}`);
    logActivity(`Voice input failed: ${error.message}`);
  } finally {
    voiceBusy = false;
    if (handsFreeEnabled) await beginListeningTurn();
    else {
      connectButton.disabled = false;
      connectButton.textContent = "Start listening";
      setConnectionState("connected", localStatusText);
    }
  }
}

function friendlyConnectionError(error) {
  if (error?.name === "NotAllowedError") {
    return "Microphone access was blocked. Allow microphone access for 127.0.0.1, then try again.";
  }
  if (error?.name === "NotFoundError") {
    return "No microphone was found. Connect or enable a microphone, then try again.";
  }
  if (error?.name === "NotReadableError") {
    return "The microphone is busy or unavailable. Close other apps using it, then try again.";
  }
  return error?.message || "Could not start the voice session.";
}

function disconnect(log = true) {
  dataChannel?.close();
  peerConnection?.close();
  microphoneStream?.getTracks().forEach((track) => track.stop());
  dataChannel = null;
  peerConnection = null;
  microphoneStream = null;
  assistantDraft = "";
  document.body.classList.remove("listening");
  setConnectionState("offline", "Offline");
  connectButton.textContent = "Connect voice";
  connectButton.disabled = false;
  commandInput.disabled = false;
  sendButton.disabled = false;
  if (log) logActivity("Voice session disconnected");
}

async function sendTextCommand(event) {
  event.preventDefault();
  const text = commandInput.value.trim();
  if (!text) return;

  addMessage("user", text);
  commandInput.value = "";

  if (dataChannel?.readyState === "open") {
    dataChannel.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    }));
    dataChannel.send(JSON.stringify({ type: "response.create" }));
    return;
  }

  const resumeListening = handsFreeEnabled;
  if (resumeListening) await pauseHandsFreeForTypedCommand();
  try {
    await sendLocalCommand(text);
  } finally {
    if (resumeListening && handsFreeEnabled) {
      listeningPaused = false;
      voiceBusy = false;
      await beginListeningTurn();
    }
  }
}

async function pauseHandsFreeForTypedCommand() {
  listeningPaused = true;
  voiceBusy = true;
  recordingShouldSend = false;
  cancelAnimationFrame(vadFrame);
  if (localRecorder?.state !== "recording") return;
  await new Promise((resolve) => {
    localRecorder.addEventListener("stop", resolve, { once: true });
    localRecorder.stop();
  });
  voiceBusy = true;
}

async function sendLocalCommand(text) {
  const started = performance.now();
  commandInput.disabled = true;
  sendButton.disabled = true;
  setConnectionState("working", "Working on it…");
  const workingMessage = addMessage("assistant", "Working on that…", { transient: true });
  logActivity("Assistant is working");
  try {
    let result = await postJson("/api/chat", { message: text });
    while (result.status === "approval_required") {
      logActivity(`Approval requested: ${result.summary}`);
      result = await waitForApproval(result, true);
    }
    const reply = result.message || "Done.";
    workingMessage.remove();
    addMessage("assistant", reply);
    logActivity(`Answered with ${result.model || "Ollama"} in ${Math.round(performance.now() - started)} ms`);
    commandInput.disabled = false;
    sendButton.disabled = false;
    await speakReply(reply);
  } catch (error) {
    workingMessage.remove();
    addMessage("assistant", `Local assistant error: ${error.message}`);
    logActivity(`Local assistant error: ${error.message}`);
  } finally {
    commandInput.disabled = false;
    sendButton.disabled = false;
    if (!handsFreeEnabled) setConnectionState("connected", localStatusText);
    commandInput.focus();
  }
}

async function handleRealtimeEvent(event) {
  if (event.type === "response.output_audio_transcript.delta" || event.type === "response.output_text.delta") {
    assistantDraft += event.delta || "";
    updateAssistantDraft(assistantDraft);
    return;
  }

  if (event.type === "response.output_audio_transcript.done" || event.type === "response.output_text.done") {
    if (assistantDraft.trim()) finalizeAssistantDraft(assistantDraft);
    assistantDraft = "";
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    await handleToolCall(event);
    return;
  }

  if (event.type === "error") {
    const message = event.error?.message || "Realtime session error.";
    addMessage("assistant", message);
    logActivity(message);
  }
}

async function handleToolCall(event) {
  let args = {};
  try { args = JSON.parse(event.arguments || "{}"); } catch { /* server will validate */ }
  logActivity(`Requested tool: ${friendlyName(event.name)}`);

  try {
    let result = await postJson("/api/tools/execute", { name: event.name, arguments: args });
    if (result.status === "approval_required") result = await waitForApproval(result);
    logActivity(`${friendlyName(event.name)}: ${result.status}`);
    sendToolResult(event.call_id, result);
  } catch (error) {
    logActivity(`${friendlyName(event.name)} failed`);
    sendToolResult(event.call_id, { status: "failed", message: error.message });
  }
}

function waitForApproval(request, localChat = false) {
  return new Promise((resolve) => {
    const card = document.createElement("section");
    card.className = "approval";
    card.innerHTML = `
      <strong>Approval required</strong>
      <p></p>
      <div class="approval-actions">
        <button class="approve" type="button">Approve once</button>
        <button class="deny" type="button">Deny</button>
      </div>`;
    card.querySelector("p").textContent = request.summary;
    approvals.prepend(card);

    const decide = async (decision) => {
      card.querySelectorAll("button").forEach((button) => (button.disabled = true));
      try {
        const endpoint = localChat ? `/api/chat/approvals/${request.approval_id}` : `/api/approvals/${request.approval_id}`;
        const result = await postJson(endpoint, { decision });
        card.remove();
        resolve(result);
      } catch (error) {
        card.remove();
        resolve({ status: "failed", message: error.message });
      }
    };
    card.querySelector(".approve").addEventListener("click", () => decide("approve"));
    card.querySelector(".deny").addEventListener("click", () => decide("deny"));
  });
}

function sendToolResult(callId, result) {
  dataChannel.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
  }));
  dataChannel.send(JSON.stringify({ type: "response.create" }));
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.error || "Request failed.");
  return result;
}

function addMessage(role, text, { transient = false } = {}) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  if (transient) article.classList.add("transient");
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = role === "user" ? "YOU" : "ASSISTANT";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  article.append(label, paragraph);
  conversation.append(article);
  scrollConversation();
  return article;
}

function updateAssistantDraft(text) {
  let draft = conversation.querySelector(".message.draft");
  if (!draft) {
    draft = addMessage("assistant", "");
    draft.classList.add("draft");
  }
  draft.querySelector("p").textContent = text;
  scrollConversation();
}

function finalizeAssistantDraft(text) {
  const draft = conversation.querySelector(".message.draft");
  if (draft) {
    draft.classList.remove("draft");
    draft.querySelector("p").textContent = text;
    scrollConversation();
  } else {
    addMessage("assistant", text);
  }
}

function logActivity(text) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const label = document.createElement("span");
  label.textContent = text;
  item.append(time, label);
  activity.prepend(item);
}

function setConnectionState(state, label) {
  statusLabel.textContent = label;
  statusDot.className = `status-dot ${state}`;
  document.body.classList.toggle("hearing", state === "hearing");
  document.body.classList.toggle("working", state === "working");
  document.body.classList.toggle("speaking", state === "speaking");
}

async function checkLocalBackend() {
  try {
    const health = await fetch("/api/health").then((response) => response.json());
    openAIRealtimeAvailable = Boolean(health.realtime_configured);
    const voice = await fetch("/api/voice/status").then((response) => response.json());
    localVoiceInstalled = Boolean(voice.installed) && "MediaRecorder" in window && Boolean(navigator.mediaDevices?.getUserMedia);
    connectButton.disabled = !(openAIRealtimeAvailable || localVoiceInstalled);
    connectButton.textContent = openAIRealtimeAvailable ? "Connect voice" : localVoiceInstalled ? "Start listening" : "Set up local mic";
    logActivity(voice.installed ? `Local voice ready: ${voice.active_backend || voice.backend}` : (voice.message || "Local voice status checked"));

    const local = await fetch("/api/ollama/status").then((response) => response.json());
    if (!local.reachable) {
      setConnectionState("offline", "Ollama offline");
      logActivity(local.message || "Ollama is offline");
    } else if (!local.model_available) {
      setConnectionState("offline", "Model missing");
      logActivity(`Install ${local.model} on the Ollama server`);
    } else {
      localStatusText = `Local · ${local.model}`;
      setConnectionState("connected", localStatusText);
      logActivity(`Local model ready: ${local.model}`);
    }
  } catch {
    setConnectionState("offline", "Local server error");
  }
}

function toggleSpeechReplies() {
  speechRepliesEnabled = !speechRepliesEnabled;
  speechToggle.setAttribute("aria-pressed", String(speechRepliesEnabled));
  speechToggle.textContent = `Voice replies: ${speechRepliesEnabled ? "On" : "Off"}`;
  if (!speechRepliesEnabled) window.speechSynthesis.cancel();
  logActivity(`Spoken replies ${speechRepliesEnabled ? "enabled" : "disabled"}`);
}

function speakReply(text) {
  if (!speechRepliesEnabled || !("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.03;
    utterance.onstart = () => setConnectionState("speaking", "Speaking…");
    utterance.onend = resolve;
    utterance.onerror = resolve;
    window.speechSynthesis.speak(utterance);
  });
}

function scrollConversation() {
  requestAnimationFrame(() => conversation.scrollTo({ top: conversation.scrollHeight, behavior: "smooth" }));
}

function friendlyName(name = "tool") {
  return name.replaceAll("_", " ");
}
