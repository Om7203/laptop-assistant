const WAKE_PHRASES = ["hey laptop assistant", "hey assistant", "okay assistant", "ok assistant", "laptop assistant"];

export function classifyVoiceControl(text) {
  const normalized = normalizeVoiceText(text);
  if (!normalized) return { type: "empty" };
  const command = normalized.replace(/^please\s+/, "").replace(/\s+please$/, "");

  if (matches(command, [
    "turn off the microphone", "turn off microphone", "disable the microphone", "disable microphone",
    "disconnect the microphone", "microphone off", "shut down voice control",
  ])) return { type: "microphone_off" };

  if (matches(command, [
    "stop listening", "go to sleep", "sleep now", "enter sleep mode", "wait for the wake word", "thats all",
  ])) return { type: "sleep" };

  if (matches(command, ["stop talking", "be quiet", "silence", "mute yourself"])) {
    return { type: "stop_speaking" };
  }

  if (matches(command, ["cancel", "cancel that", "never mind", "nevermind", "abort"])) {
    return { type: "cancel" };
  }

  return { type: "command", text: text.trim() };
}

export function extractWakeCommand(text) {
  const normalized = normalizeVoiceText(text);
  for (const phrase of WAKE_PHRASES) {
    if (normalized === phrase) return { detected: true, command: "" };
    if (normalized.startsWith(`${phrase} `)) {
      return { detected: true, command: normalized.slice(phrase.length).trim() };
    }
  }
  return { detected: false, command: "" };
}

export function normalizeVoiceText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matches(value, choices) {
  return choices.includes(value);
}
