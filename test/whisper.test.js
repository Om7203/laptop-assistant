import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalWhisper } from "../src/whisper.js";

test("reports a clear setup state when local speech is not installed", async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-whisper-test-"));
  const whisper = new LocalWhisper({ projectRoot });
  const status = whisper.status();
  assert.equal(status.installed, false);
  assert.match(status.message, /setup-local-voice\.cmd/);
});

test("rejects an empty microphone recording before starting the worker", async () => {
  const whisper = new LocalWhisper({ projectRoot: process.cwd() });
  await assert.rejects(whisper.transcribe(Buffer.alloc(0)), /recording was empty/);
});
