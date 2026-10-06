import fs from "node:fs";
import path from "node:path";
import { LocalSpeechWorker } from "./speech-worker.js";

export class LocalWhistle extends LocalSpeechWorker {
  constructor({ projectRoot, timeoutMs = 90_000, logger = null, metrics = null, keywords = [] } = {}) {
    const workerPath = path.join(projectRoot, "voice", "whistle_worker.py");
    const packagePath = path.join(projectRoot, ".venv-voice", "Lib", "site-packages", "needle");
    const weightsPath = findWeights(projectRoot);
    const enginePath = path.join(projectRoot, "models", "needle-engine", "libneedle.dll");
    super({
      projectRoot,
      backend: "whistle",
      model: "Cactus-Compute/whistle",
      workerPath,
      installed: () => fs.existsSync(packagePath) && Boolean(findWeights(projectRoot)) && fs.existsSync(enginePath),
      setupCommand: "setup-whistle.cmd",
      timeoutMs,
      logger,
      metrics,
      environment: {
        NEEDLE_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        WHISTLE_KEYWORDS: JSON.stringify(keywords),
        ...(weightsPath ? { NEEDLE_WHISTLE_WEIGHTS: weightsPath } : {}),
        ...(fs.existsSync(enginePath) ? { NEEDLE3_LIB_PATH: enginePath } : {}),
      },
    });
  }
}

function findWeights(projectRoot) {
  const candidates = [path.join(projectRoot, "models", "whistle", "whistle.cact"), path.join(projectRoot, "models", "whistle.cact")];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
