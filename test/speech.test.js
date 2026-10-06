import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalSpeechRecognition, parseKeywords } from "../src/speech.js";

test("uses faster-whisper by default and reports both providers", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-speech-test-"));
  const speech = new LocalSpeechRecognition({ projectRoot });
  const status = speech.status();
  assert.equal(status.requested_backend, "faster-whisper");
  assert.equal(status.active_backend, "faster-whisper");
  assert.deepEqual(Object.keys(status.providers).sort(), ["faster-whisper", "whistle"]);
});

test("auto mode keeps the installed Whisper backend when Whistle is unavailable", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-speech-test-"));
  await fs.mkdir(path.join(projectRoot, ".venv-voice", "Scripts"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "voice"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, ".venv-voice", "Scripts", "python.exe"), "");
  await fs.writeFile(path.join(projectRoot, "voice", "whisper_worker.py"), "");
  await fs.writeFile(path.join(projectRoot, "voice", "whistle_worker.py"), "");
  const speech = new LocalSpeechRecognition({ projectRoot, backend: "auto" });
  assert.equal(speech.status().active_backend, "faster-whisper");
});

test("normalizes and bounds Whistle keyword configuration", () => {
  const values = Array.from({ length: 60 }, (_, index) => ` term-${index} `).join(",");
  const keywords = parseKeywords(values);
  assert.equal(keywords.length, 50);
  assert.equal(keywords[0], "term-0");
});
