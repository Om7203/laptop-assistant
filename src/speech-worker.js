import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export class LocalSpeechWorker {
  constructor({ projectRoot, backend, model, workerPath, installed, setupCommand, environment = {}, timeoutMs = 90_000, logger = null, metrics = null }) {
    this.projectRoot = projectRoot;
    this.backend = backend;
    this.model = model;
    this.workerPath = workerPath;
    this.pythonPath = path.join(projectRoot, ".venv-voice", "Scripts", "python.exe");
    this.installedCheck = installed;
    this.setupCommand = setupCommand;
    this.environment = environment;
    this.timeoutMs = timeoutMs;
    this.process = null;
    this.startPromise = null;
    this.pending = new Map();
    this.ready = false;
    this.logger = logger;
    this.metrics = metrics;
  }

  isInstalled() {
    return fs.existsSync(this.pythonPath) && fs.existsSync(this.workerPath) && this.installedCheck();
  }

  status() {
    const installed = this.isInstalled();
    return {
      backend: this.backend,
      installed,
      ready: installed && this.ready,
      model: this.model,
      mode: "push_to_talk",
      message: installed
        ? (this.ready ? `${this.backend} speech recognition is ready.` : `${this.backend} will load on first use.`)
        : `Run ${this.setupCommand} first.`,
    };
  }

  async transcribe(audio, contentType = "audio/webm") {
    const started = process.hrtime.bigint();
    let audioPath;
    try {
      if (!Buffer.isBuffer(audio) || audio.length < 128) throw new Error("The microphone recording was empty.");
      if (audio.length > 15_000_000) throw new Error("The microphone recording is too large. Keep voice commands under 30 seconds.");
      await this.start();

      const id = randomUUID();
      audioPath = path.join(os.tmpdir(), `laptop-assistant-${id}${audioExtension(contentType)}`);
      await fsp.writeFile(audioPath, audio);
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Local ${this.backend} transcription timed out.`));
        }, this.timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.process.stdin.write(`${JSON.stringify({ id, path: audioPath })}\n`);
      });
      this.recordTranscription("success", started);
      return { ...result, backend: this.backend };
    } catch (error) {
      const outcome = /empty/i.test(error.message) ? "empty" : /timed out/i.test(error.message) ? "timeout" : "worker_error";
      this.recordTranscription(outcome, started);
      throw error;
    } finally {
      if (audioPath) await fsp.rm(audioPath, { force: true }).catch(() => {});
    }
  }

  async start() {
    if (this.ready && this.process && !this.process.killed) return;
    if (this.startPromise) return this.startPromise;
    if (!this.isInstalled()) throw new Error(`${this.backend} is not installed. Run ${this.setupCommand} first.`);

    this.startPromise = new Promise((resolve, reject) => {
      const workerStarted = process.hrtime.bigint();
      let startupRecorded = false;
      const recordStartup = (outcome) => {
        if (startupRecorded) return;
        startupRecorded = true;
        const seconds = Number(process.hrtime.bigint() - workerStarted) / 1_000_000_000;
        this.metrics?.observeSpeechStartup(this.backend, outcome, seconds);
        this.logger?.info({ event: "speech.worker.startup.completed", backend: this.backend, outcome, duration_ms: Math.round(seconds * 1000), model: this.model });
      };
      const child = spawn(this.pythonPath, [this.workerPath], {
        cwd: this.projectRoot,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.environment },
      });
      this.process = child;
      let startupSettled = false;
      const failStartup = (error) => {
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timer);
        this.startPromise = null;
        recordStartup("error");
        reject(error);
      };
      const timer = setTimeout(() => {
        failStartup(new Error(`${this.backend} took too long to start.`));
        child.kill();
      }, this.timeoutMs);

      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.type === "ready") {
          clearTimeout(timer);
          startupSettled = true;
          this.ready = true;
          this.startPromise = null;
          recordStartup("success");
          resolve();
          return;
        }
        if (message.type === "startup_error") {
          failStartup(new Error(`${this.backend} could not start: ${message.error}`));
          child.kill();
          return;
        }
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message);
      });

      child.stderr.on("data", () => this.logger?.warn({ event: "speech.worker.stderr", backend: this.backend }));
      child.on("exit", () => {
        failStartup(new Error(`${this.backend} stopped while starting.`));
        this.ready = false;
        this.process = null;
        this.startPromise = null;
        const error = new Error(`${this.backend} stopped unexpectedly.`);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      });
      child.on("error", failStartup);
    });
    return this.startPromise;
  }

  recordTranscription(outcome, started) {
    const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    this.metrics?.observeSpeech(this.backend, outcome, seconds);
    this.logger?.info({ event: "speech.transcription.completed", backend: this.backend, outcome, duration_ms: Math.round(seconds * 1000), model: this.model });
  }
}

function audioExtension(contentType) {
  const normalized = String(contentType).toLowerCase();
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mp4") || normalized.includes("m4a")) return ".m4a";
  return ".webm";
}
