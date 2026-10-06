import fs from "node:fs";
import path from "node:path";
import { LocalSpeechWorker } from "./speech-worker.js";

export class LocalWhisper extends LocalSpeechWorker {
  constructor({ projectRoot, model = "base.en", timeoutMs = 90_000, logger = null, metrics = null } = {}) {
    const workerPath = path.join(projectRoot, "voice", "whisper_worker.py");
    super({
      projectRoot,
      backend: "faster-whisper",
      model,
      workerPath,
      installed: () => fs.existsSync(workerPath),
      setupCommand: "setup-local-voice.cmd",
      timeoutMs,
      logger,
      metrics,
      environment: {
        WHISPER_MODEL: model,
        WHISPER_MODEL_DIR: path.join(projectRoot, "models", "whisper"),
        WHISPER_DEVICE: process.env.WHISPER_DEVICE || "cpu",
        WHISPER_COMPUTE_TYPE: process.env.WHISPER_COMPUTE_TYPE || "int8",
        HF_HOME: process.env.HF_HOME || path.join(projectRoot, "models", "huggingface"),
        HF_HUB_DISABLE_XET: "1",
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
      },
    });
  }
}
