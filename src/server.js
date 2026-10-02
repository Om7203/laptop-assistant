import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS, ToolError, ToolRuntime } from "./tools.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, "..");
loadEnv(path.join(projectRoot, ".env"));

const publicRoot = path.join(projectRoot, "public");
const port = numberFromEnv(process.env.PORT, 3199);
const host = "127.0.0.1";
const allowedRoots = (process.env.ASSISTANT_ALLOWED_ROOTS ?? "")
  .split(";")
  .map((item) => item.trim())
  .filter(Boolean);
const runtime = new ToolRuntime({ projectRoot, allowedRoots });

const server = http.createServer(async (request, response) => {
  try {
    setSecurityHeaders(response);

    if (request.method === "GET" && request.url === "/api/health") {
      return json(response, 200, {
        status: "ok",
        realtime_configured: Boolean(process.env.OPENAI_API_KEY),
        model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
      });
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
    console.error(error);
    return json(response, status, { error: code, message: error.message ?? "Unexpected server error." });
  }
});

server.listen(port, host, () => {
  console.log(`Laptop Assistant is ready at http://${host}:${port}`);
  if (!process.env.OPENAI_API_KEY) console.log("Voice is disabled until OPENAI_API_KEY is added to .env.");
});

async function createRealtimeSession(request, response) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json(response, 503, { error: "missing_api_key", message: "Add OPENAI_API_KEY to .env first." });

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
  response.statusCode = upstream.status;
  response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/sdp");
  const location = upstream.headers.get("location");
  if (location) response.setHeader("X-Realtime-Location", location);
  response.end(body);
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
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
