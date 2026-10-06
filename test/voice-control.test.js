import test from "node:test";
import assert from "node:assert/strict";
import { classifyVoiceControl, extractWakeCommand } from "../public/voice-control.js";

test("recognizes voice lifecycle controls locally", () => {
  assert.equal(classifyVoiceControl("Stop listening.").type, "sleep");
  assert.equal(classifyVoiceControl("Please go to sleep").type, "sleep");
  assert.equal(classifyVoiceControl("Turn off the microphone").type, "microphone_off");
  assert.equal(classifyVoiceControl("Stop talking!").type, "stop_speaking");
  assert.equal(classifyVoiceControl("Never mind").type, "cancel");
});

test("does not confuse ordinary requests with lifecycle controls", () => {
  assert.deepEqual(classifyVoiceControl("Stop the music"), { type: "command", text: "Stop the music" });
});

test("extracts a command following a local wake phrase", () => {
  assert.deepEqual(extractWakeCommand("Hey Goffy, open calculator"), {
    detected: true,
    command: "open calculator",
  });
  assert.deepEqual(extractWakeCommand("Okay Goffy"), { detected: true, command: "" });
  assert.deepEqual(extractWakeCommand("Hey Goofy, open notepad"), { detected: true, command: "open notepad" });
  assert.deepEqual(extractWakeCommand("Goffy, what time is it?"), {
    detected: true,
    command: "what time is it",
  });
  assert.deepEqual(extractWakeCommand("Someone else is talking"), { detected: false, command: "" });
});
