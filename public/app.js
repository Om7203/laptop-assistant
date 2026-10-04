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

let peerConnection;
let dataChannel;
let microphoneStream;
let assistantDraft = "";
let openAIRealtimeAvailable = false;
let speechRepliesEnabled = false;
let localVoiceInstalled = false;
let localRecorder;
let localRecordingChunks = [];
let localRecordingTimer;
let localStatusText = "Local AI ready";

checkLocalBackend();
speechToggle.addEventListener("click", toggleSpeechReplies);
if (!("speechSynthesis" in window)) speechToggle.disabled = true;

connectButton.addEventListener("click", handleVoiceButton);
commandForm.addEventListener("submit", sendTextCommand);
clearActivity.addEventListener("click", () => (activity.innerHTML = ""));

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
  if (localRecorder?.state === "recording") stopLocalRecording();
  else await startLocalRecording();
}

async function startLocalRecording() {
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    localRecordingChunks = [];
    localRecorder = new MediaRecorder(microphoneStream, preferredType ? { mimeType: preferredType } : undefined);
    localRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) localRecordingChunks.push(event.data);
    });
    localRecorder.addEventListener("stop", transcribeLocalRecording, { once: true });
    localRecorder.start();
    connectButton.textContent = "Stop & send";
    document.body.classList.add("listening");
    setConnectionState("connected", "Listening…");
    logActivity("Local microphone recording started");
    localRecordingTimer = setTimeout(stopLocalRecording, 30_000);
  } catch (error) {
    const message = friendlyConnectionError(error);
    addMessage("assistant", `Microphone failed: ${message}`);
    logActivity(`Microphone failed: ${message}`);
  }
}

function stopLocalRecording() {
  if (localRecorder?.state !== "recording") return;
  clearTimeout(localRecordingTimer);
  connectButton.disabled = true;
  connectButton.textContent = "Transcribing…";
  setConnectionState("connecting", "Transcribing locally…");
  localRecorder.stop();
}

async function transcribeLocalRecording() {
  const type = localRecorder?.mimeType || localRecordingChunks[0]?.type || "audio/webm";
  const recording = new Blob(localRecordingChunks, { type });
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneStream = null;
  localRecorder = null;
  localRecordingChunks = [];
  document.body.classList.remove("listening");

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
    logActivity(`Transcribed locally in ${result.duration_ms ?? "?"} ms`);
    await sendLocalCommand(text);
  } catch (error) {
    addMessage("assistant", `Voice input failed: ${error.message}`);
    logActivity(`Voice input failed: ${error.message}`);
  } finally {
    connectButton.disabled = false;
    connectButton.textContent = "Push to talk";
    setConnectionState("connected", localStatusText);
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

  await sendLocalCommand(text);
}

async function sendLocalCommand(text) {
  commandInput.disabled = true;
  sendButton.disabled = true;
  logActivity("Local model is thinking");
  try {
    let result = await postJson("/api/chat", { message: text });
    while (result.status === "approval_required") {
      logActivity(`Approval requested: ${result.summary}`);
      result = await waitForApproval(result, true);
    }
    const reply = result.message || "Done.";
    addMessage("assistant", reply);
    speakReply(reply);
    logActivity(`Answered locally with ${result.model || "Ollama"}`);
  } catch (error) {
    addMessage("assistant", `Local assistant error: ${error.message}`);
    logActivity(`Local assistant error: ${error.message}`);
  } finally {
    commandInput.disabled = false;
    sendButton.disabled = false;
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

function addMessage(role, text) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = role === "user" ? "YOU" : "ASSISTANT";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  article.append(label, paragraph);
  conversation.append(article);
  conversation.scrollTop = conversation.scrollHeight;
  return article;
}

function updateAssistantDraft(text) {
  let draft = conversation.querySelector(".message.draft");
  if (!draft) {
    draft = addMessage("assistant", "");
    draft.classList.add("draft");
  }
  draft.querySelector("p").textContent = text;
}

function finalizeAssistantDraft(text) {
  const draft = conversation.querySelector(".message.draft");
  if (draft) {
    draft.classList.remove("draft");
    draft.querySelector("p").textContent = text;
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
  statusDot.classList.toggle("live", state === "connected");
}

async function checkLocalBackend() {
  try {
    const health = await fetch("/api/health").then((response) => response.json());
    openAIRealtimeAvailable = Boolean(health.realtime_configured);
    const voice = await fetch("/api/voice/status").then((response) => response.json());
    localVoiceInstalled = Boolean(voice.installed) && "MediaRecorder" in window && Boolean(navigator.mediaDevices?.getUserMedia);
    connectButton.disabled = !(openAIRealtimeAvailable || localVoiceInstalled);
    connectButton.textContent = openAIRealtimeAvailable ? "Connect voice" : localVoiceInstalled ? "Push to talk" : "Set up local mic";
    logActivity(voice.message || "Local voice status checked");

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
  if (!speechRepliesEnabled || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1;
  window.speechSynthesis.speak(utterance);
}

function friendlyName(name = "tool") {
  return name.replaceAll("_", " ");
}
