import Prometheus from "@prometheus-io/client";
import pino from "pino";

const { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } = Prometheus;

const REDACTED_PATHS = [
  "api_key",
  "apiKey",
  "authorization",
  "headers.authorization",
  "key",
  "message",
  "prompt",
  "text",
  "transcript",
  "url",
  "*.api_key",
  "*.apiKey",
  "*.authorization",
  "*.key",
  "*.message",
  "*.prompt",
  "*.text",
  "*.transcript",
  "*.url",
];

export function createLogger({ level = process.env.LOG_LEVEL || "info", stream, destination = process.env.LOG_DESTINATION } = {}) {
  const options = {
    name: "laptop-assistant",
    level,
    base: { service: "laptop-assistant" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: "[REDACTED]" },
  };
  const output = stream || (destination ? pino.destination({ dest: destination, mkdir: true, sync: false }) : null);
  return output ? pino(options, output) : pino(options);
}

export class AssistantMetrics {
  constructor({ collectDefaults = true, version = "development" } = {}) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: "laptop-assistant" });
    if (collectDefaults) collectDefaultMetrics({ register: this.registry, prefix: "laptop_assistant_" });

    const registers = [this.registry];
    this.buildInfo = new Gauge({
      name: "laptop_assistant_build_info",
      help: "Build information for Laptop Assistant.",
      labelNames: ["version"],
      registers,
    });
    this.buildInfo.set({ version }, 1);

    this.httpRequests = new Counter({
      name: "laptop_assistant_http_requests_total",
      help: "Completed HTTP requests.",
      labelNames: ["method", "route", "status_class"],
      registers,
    });
    this.httpDuration = new Histogram({
      name: "laptop_assistant_http_request_duration_seconds",
      help: "HTTP request duration in seconds.",
      labelNames: ["method", "route"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 120],
      registers,
    });
    this.httpInFlight = new Gauge({
      name: "laptop_assistant_http_requests_in_flight",
      help: "HTTP requests currently being handled.",
      registers,
    });
    this.ollamaRequests = new Counter({
      name: "laptop_assistant_ollama_requests_total",
      help: "Requests made to Ollama.",
      labelNames: ["operation", "outcome"],
      registers,
    });
    this.ollamaDuration = new Histogram({
      name: "laptop_assistant_ollama_request_duration_seconds",
      help: "Ollama request duration in seconds.",
      labelNames: ["operation", "outcome"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
      registers,
    });
    this.speechRequests = new Counter({
      name: "laptop_assistant_speech_transcriptions_total",
      help: "Local speech transcription attempts.",
      labelNames: ["backend", "outcome"],
      registers,
    });
    this.speechDuration = new Histogram({
      name: "laptop_assistant_speech_transcription_duration_seconds",
      help: "End-to-end local transcription duration in seconds.",
      labelNames: ["backend", "outcome"],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90],
      registers,
    });
    this.speechStartupDuration = new Histogram({
      name: "laptop_assistant_speech_worker_startup_duration_seconds",
      help: "Speech worker startup duration in seconds.",
      labelNames: ["backend", "outcome"],
      buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90],
      registers,
    });
    this.toolExecutions = new Counter({
      name: "laptop_assistant_tool_executions_total",
      help: "Tool requests grouped by allowlisted tool and outcome.",
      labelNames: ["tool", "outcome"],
      registers,
    });
    this.approvalDecisions = new Counter({
      name: "laptop_assistant_approval_decisions_total",
      help: "Sensitive-action approval outcomes.",
      labelNames: ["decision"],
      registers,
    });
  }

  startHttp(method, route) {
    const safeMethod = knownValue(method, ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], "OTHER");
    const safeRoute = normalizeRoute(route);
    const started = process.hrtime.bigint();
    this.httpInFlight.inc();
    let finished = false;
    return (statusCode = 500) => {
      if (finished) return;
      finished = true;
      const seconds = elapsedSeconds(started);
      const statusClass = `${Math.floor(Number(statusCode) / 100) || 5}xx`;
      this.httpInFlight.dec();
      this.httpRequests.inc({ method: safeMethod, route: safeRoute, status_class: statusClass });
      this.httpDuration.observe({ method: safeMethod, route: safeRoute }, seconds);
      return seconds;
    };
  }

  observeOllama(operation, outcome, seconds) {
    const labels = {
      operation: knownValue(operation, ["chat", "status", "warmup"], "other"),
      outcome: knownValue(outcome, ["success", "timeout", "unreachable", "http_error", "invalid_response"], "error"),
    };
    this.ollamaRequests.inc(labels);
    this.ollamaDuration.observe(labels, seconds);
  }

  observeSpeech(backend, outcome, seconds) {
    const labels = {
      backend: knownValue(backend, ["faster-whisper", "whistle"], "unknown"),
      outcome: knownValue(outcome, ["success", "empty", "timeout", "worker_error"], "error"),
    };
    this.speechRequests.inc(labels);
    this.speechDuration.observe(labels, seconds);
  }

  observeSpeechStartup(backend, outcome, seconds) {
    this.speechStartupDuration.observe({
      backend: knownValue(backend, ["faster-whisper", "whistle"], "unknown"),
      outcome: outcome === "success" ? "success" : "error",
    }, seconds);
  }

  observeTool(tool, outcome) {
    const safeTool = knownValue(tool, ["get_local_time", "get_system_status", "list_directory", "open_application", "open_url"], "unknown");
    const safeOutcome = knownValue(outcome, ["completed", "approval_required", "denied", "failed"], "failed");
    this.toolExecutions.inc({ tool: safeTool, outcome: safeOutcome });
  }

  observeApproval(decision) {
    this.approvalDecisions.inc({ decision: knownValue(decision, ["approved", "denied", "expired"], "unknown") });
  }

  async render() {
    return this.registry.metrics();
  }

  get contentType() {
    return this.registry.contentType;
  }
}

export function normalizeRoute(value = "/unknown") {
  let pathname;
  try { pathname = new URL(value, "http://localhost").pathname; } catch { return "/invalid"; }
  if (/^\/api\/chat\/approvals\/[^/]+$/.test(pathname)) return "/api/chat/approvals/:id";
  if (/^\/api\/approvals\/[^/]+$/.test(pathname)) return "/api/approvals/:id";
  const known = new Set([
    "/", "/index.html", "/app.js", "/styles.css", "/api/health", "/api/health/live", "/api/health/ready",
    "/api/ollama/status", "/api/voice/status", "/api/transcribe", "/api/chat", "/api/chat/reset",
    "/api/tools/execute", "/metrics", "/session",
  ]);
  return known.has(pathname) ? pathname : "/other";
}

export function elapsedSeconds(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000_000;
}

function knownValue(value, allowed, fallback) {
  const normalized = String(value ?? "");
  return allowed.includes(normalized) ? normalized : fallback;
}
