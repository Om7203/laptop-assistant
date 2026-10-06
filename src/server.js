import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AssistantMetrics, createLogger, normalizeRoute } from "./observability.js";
import { OllamaAssistant } from "./ollama.js";
import { resolveOpenAIKey } from "./secrets.js";
import { TOOL_DEFINITIONS, ToolError, ToolRuntime } from "./tools.js";
import { LocalSpeechRecognition, parseKeywords } from "./speech.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, "..");
loadEnv(path.join(projectRoot, ".env"));
const logger = createLogger();
const metrics = new AssistantMetrics({ version: "0.7.0" });
const enableOpenAIRealtime = process.env.ENABLE_OPENAI_REALTIME === "true";
const openaiApiKey = enableOpenAIRealtime ? resolveOpenAIKey({ projectRoot }) : "";

const publicRoot = path.join(projectRoot, "public");
const port = numberFromEnv(process.env.PORT, 3199);
const host = "127.0.0.1";
const allowedRoots = (process.env.ASSISTANT_ALLOWED_ROOTS ?? "")
  .split(";")
  .map((item) => item.trim())
  .filter(Boolean);
const runtime = new ToolRuntime({ projectRoot, allowedRoots, logger, metrics });
const localAssistant = new OllamaAssistant({
  runtime,
  baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  model: process.env.OLLAMA_MODEL || "qwen3:4b-instruct-2507-q4_K_M",
  keepAlive: process.env.OLLAMA_KEEP_ALIVE || "-1",
  contextSize: numberFromEnv(process.env.OLLAMA_CONTEXT_SIZE, 4_096),
  maxTokens: numberFromEnv(process.env.OLLAMA_MAX_TOKENS, 256),
  logger,
  metrics,
});
const localSpeech = new LocalSpeechRecognition({
  projectRoot,
  backend: process.env.STT_BACKEND || "faster-whisper",
  whisperModel: process.env.WHISPER_MODEL || "base.en",
  keywords: parseKeywords(process.env.STT_KEYWORDS || "Goffy,Goofy,Hey Goffy,Ollama,Qwen,Notepad,Calculator"),
  logger,
  metrics,
});
let lastSessionError = null;

const server = http.createServer(async (request, response) => {
  const requestId = randomUUID();
  const route = normalizeRoute(request.url);
  const finishMetrics = metrics.startHttp(request.method, request.url);
  let requestFinished = false;
  const finishRequest = () => {
    if (requestFinished) return;
    requestFinished = true;
    const durationSeconds = finishMetrics(response.statusCode || 500);
    logger.info({
      event: "http.request.completed",
      request_id: requestId,
      method: request.method,
      route,
      status_code: response.statusCode,
      duration_ms: Math.round(durationSeconds * 1000),
    });
  };
  response.once("finish", finishRequest);
  response.once("close", finishRequest);
  try {
    setSecurityHeaders(response);
    response.setHeader("X-Request-ID", requestId);

    if (request.method === "GET" && request.url === "/api/health/live") {
      return json(response, 200, { status: "alive", uptime_seconds: Math.round(process.uptime()), version: "0.7.0" });
    }

    if (request.method === "GET" && request.url === "/api/health/ready") {
      const ollama = await localAssistant.status();
      const voice = localSpeech.status();
      const ready = Boolean(ollama.reachable && ollama.model_available);
      return json(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
        components: {
          ollama: { ready, reachable: ollama.reachable, model_available: ollama.model_available, model: ollama.model },
          speech: { ready: voice.installed, installed: voice.installed, worker_loaded: voice.ready, backend: voice.active_backend, model: voice.model },
        },
      });
    }

    if (request.method === "GET" && request.url === "/metrics") {
      response.statusCode = 200;
      response.setHeader("Content-Type", metrics.contentType);
      response.end(await metrics.render());
      return;
    }

    if (request.method === "GET" && request.url === "/api/health") {
      return json(response, 200, {
        status: "ok",
        api_version: 7,
        backend: "ollama",
        ollama_model: localAssistant.model,
        realtime_configured: enableOpenAIRealtime && Boolean(openaiApiKey),
        model: localAssistant.model,
        realtime_model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
        last_session_error: lastSessionError,
      });
    }

    if (request.method === "GET" && request.url === "/api/ollama/status") {
      return json(response, 200, await localAssistant.status());
    }

    if (request.method === "GET" && request.url === "/api/voice/status") {
      return json(response, 200, localSpeech.status());
    }

    if (request.method === "POST" && request.url === "/api/transcribe") {
      const contentType = request.headers["content-type"] || "audio/webm";
      if (!String(contentType).toLowerCase().startsWith("audio/")) {
        return json(response, 415, { error: "unsupported_audio", message: "An audio recording is required." });
      }
      const audio = await readBuffer(request, 15_000_000);
      const result = await localSpeech.transcribe(audio, contentType);
      return json(response, 200, { status: "completed", ...result });
    }

    if (request.method === "POST" && request.url === "/api/chat") {
      const payload = await readJson(request);
      return json(response, 200, await localAssistant.send(payload.message));
    }

    if (request.method === "POST" && request.url === "/api/chat/reset") {
      localAssistant.reset();
      return json(response, 200, { status: "completed" });
    }

    const chatApprovalMatch = request.url?.match(/^\/api\/chat\/approvals\/([0-9a-f-]+)$/i);
    if (request.method === "POST" && chatApprovalMatch) {
      const payload = await readJson(request);
      const result = await localAssistant.decide(chatApprovalMatch[1], payload.decision === "approve");
      return json(response, 200, result);
    }

    if (request.method === "POST" && request.url === "/session") {
      return createRealtimeSession(request, response);
    }

    if (request.method === "POST" && request.url === "/api/tools/execute") {
      const payload = await readJson(request);
      const result = await runtime.request(payload.name, payload.arguments ?? {});
      return json(response, 200, result);
    }

    const approvalMatch = request.url?.match(/^\/api\/approvals\/([0-9a-f-]+)$/i);
    if (request.method === "POST" && approvalMatch) {
      const payload = await readJson(request);
      const result = await runtime.decide(approvalMatch[1], payload.decision === "approve");
      return json(response, 200, result);
    }

    if (request.method === "GET") return serveStatic(request, response);
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof ToolError ? 400 : error.statusCode ?? 500;
    const code = error instanceof ToolError ? error.code : "server_error";
    logger.error({
      event: "http.request.failed",
      request_id: requestId,
      method: request.method,
      route,
      error_code: code,
      error_name: error?.name || "Error",
    });
    return json(response, status, { error: code, message: error.message ?? "Unexpected server error." });
  }
});

export async function startServer() {
  if (server.listening) return { host, port, url: `http://${host}:${port}` };
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  logger.info({ event: "server.started", host, port, model: localAssistant.model, realtime_enabled: enableOpenAIRealtime });
  void localAssistant.warm().then((warmup) => {
    logger.info({ event: "ollama.warmup.completed", ready: warmup.ready });
  });
  return { host, port, url: `http://${host}:${port}` };
}

export async function stopServer() {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const launchedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (launchedDirectly) await startServer();

async function createRealtimeSession(request, response) {
  const apiKey = openaiApiKey;
  if (!apiKey) {
    return json(response, 503, {
      error: "missing_api_key",
      message: "The encrypted API key was not loaded. Close the assistant and run start-assistant.cmd again.",
    });
  }

  const sdp = await readBody(request, 1_000_000);
  const session = {
    type: "realtime",
    model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
    instructions: [
      "You are a concise, dependable voice assistant running on the user's Windows laptop.",
      "Use tools when they are relevant. Never claim an action succeeded until the tool reports success.",
      "Before a tool call, briefly say what you are about to do. After it completes, report the result.",
      "If a tool requires approval, calmly tell the user an approval card is waiting on screen.",
      "Do not request secrets, passwords, authentication codes, or payment details.",
      "The current tool set is intentionally limited. Be honest when a capability is not available yet.",
    ].join(" "),
    audio: {
      input: { turn_detection: { type: "server_vad" } },
      output: { voice: process.env.OPENAI_VOICE || "marin" },
    },
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
  };

  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(session));

  const upstream = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Safety-Identifier": stableSafetyIdentifier(),
    },
    body: form,
  });

  const body = await upstream.text();
  if (!upstream.ok) {
    lastSessionError = sanitizeUpstreamError(upstream.status, body);
    logger.error({
      event: "openai.realtime.session.failed",
      upstream_status: lastSessionError.status,
      upstream_code: lastSessionError.code,
      upstream_type: lastSessionError.type,
    });
  } else {
    lastSessionError = null;
  }
  response.statusCode = upstream.status;
  response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/sdp");
  const location = upstream.headers.get("location");
  if (location) response.setHeader("X-Realtime-Location", location);
  response.end(body);
}

function sanitizeUpstreamError(status, body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = null; }
  const error = parsed?.error ?? parsed;
  return {
    status,
    code: typeof error?.code === "string" ? error.code : null,
    type: typeof error?.type === "string" ? error.type : null,
    message: typeof error?.message === "string" ? error.message.slice(0, 500) : `OpenAI returned HTTP ${status}.`,
  };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const decoded = decodeURIComponent(requested);
  const filePath = path.resolve(publicRoot, `.${decoded}`);
  const relative = path.relative(publicRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return json(response, 403, { error: "forbidden" });

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return json(response, 404, { error: "not_found" });

  response.statusCode = 200;
  response.setHeader("Content-Type", mimeType(filePath));
  fs.createReadStream(filePath).pipe(response);
}

function readBody(request, limit) {
  return readBuffer(request, limit).then((buffer) => buffer.toString("utf8"));
}

function readBuffer(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readJson(request) {
  const raw = await readBody(request, 100_000);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    const error = new Error("Invalid JSON request.");
    error.statusCode = 400;
    throw error;
  }
}

function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.openai.com; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function mimeType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  }[path.extname(filePath)] || "application/octet-stream";
}

function numberFromEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function stableSafetyIdentifier() {
  const source = `${process.env.USERNAME || "local-user"}@${process.env.COMPUTERNAME || "windows"}`;
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `local-${(hash >>> 0).toString(16)}`;
}
