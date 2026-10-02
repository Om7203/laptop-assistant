const connectButton = document.querySelector("#connect-button");
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

connectButton.addEventListener("click", () => (peerConnection ? disconnect() : connect()));
commandForm.addEventListener("submit", sendTextCommand);
clearActivity.addEventListener("click", () => (activity.innerHTML = ""));

async function connect() {
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
  commandInput.disabled = true;
  sendButton.disabled = true;
  if (log) logActivity("Voice session disconnected");
}

function sendTextCommand(event) {
  event.preventDefault();
  const text = commandInput.value.trim();
  if (!text || dataChannel?.readyState !== "open") return;

  addMessage("user", text);
  dataChannel.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  }));
  dataChannel.send(JSON.stringify({ type: "response.create" }));
  commandInput.value = "";
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

function waitForApproval(request) {
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
        const result = await postJson(`/api/approvals/${request.approval_id}`, { decision });
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

function friendlyName(name = "tool") {
  return name.replaceAll("_", " ");
}
