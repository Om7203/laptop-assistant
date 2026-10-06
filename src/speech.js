import { LocalWhisper } from "./whisper.js";
import { LocalWhistle } from "./whistle.js";

const SUPPORTED_BACKENDS = new Set(["faster-whisper", "whistle", "auto"]);

export class LocalSpeechRecognition {
  constructor({ projectRoot, backend = "faster-whisper", logger = null, metrics = null, whisperModel = "base.en", keywords = [] } = {}) {
    this.requestedBackend = SUPPORTED_BACKENDS.has(backend) ? backend : "faster-whisper";
    this.logger = logger;
    this.providers = {
      "faster-whisper": new LocalWhisper({ projectRoot, model: whisperModel, logger, metrics }),
      whistle: new LocalWhistle({ projectRoot, logger, metrics, keywords }),
    };
  }

  primary() {
    if (this.requestedBackend === "auto") return this.providers.whistle.isInstalled() ? this.providers.whistle : this.providers["faster-whisper"];
    return this.providers[this.requestedBackend];
  }

  status() {
    const primary = this.primary();
    const providers = Object.fromEntries(Object.entries(this.providers).map(([name, provider]) => [name, provider.status()]));
    return {
      ...primary.status(),
      requested_backend: this.requestedBackend,
      active_backend: primary.backend,
      fallback_backend: primary.backend === "whistle" ? "faster-whisper" : null,
      providers,
    };
  }

  async transcribe(audio, contentType) {
    const primary = this.primary();
    try {
      return await primary.transcribe(audio, contentType);
    } catch (error) {
      const fallback = this.providers["faster-whisper"];
      if (primary.backend !== "whistle" || !fallback.isInstalled() || /recording was empty|recording is too large/i.test(error.message)) throw error;
      this.logger?.warn({ event: "speech.fallback.activated", from_backend: primary.backend, to_backend: fallback.backend, error_name: error?.name || "Error" });
      const result = await fallback.transcribe(audio, contentType);
      return { ...result, fallback_from: primary.backend };
    }
  }
}

export function parseKeywords(value = "") {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean).slice(0, 50);
}
