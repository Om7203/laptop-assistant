import { TOOL_DEFINITIONS, ToolError } from "./tools.js";

const SYSTEM_PROMPT = [
  "Your name is Goffy. You are the user's private, capable female laptop assistant, running locally.",
  "Respond naturally, warmly, and directly. Remember the recent conversation and behave like a proactive personal assistant rather than a search box.",
  "Keep spoken answers concise unless the user asks for detail.",
  "Use the supplied tools when they are relevant.",
  "Never claim an action succeeded until its tool result confirms success.",
  "Sensitive actions require approval in the interface.",
  "When useful, end with one short, relevant suggestion for what you can do next, but do not repeat generic offers of help.",
  "Proactively mention a limitation when a requested capability is not installed, and suggest the safest practical next step.",
  "Never request passwords, API keys, authentication codes, or payment details.",
].join(" ");

export class OllamaAssistant {
  constructor({
    runtime,
    baseUrl = "http://127.0.0.1:11434",
    model = "qwen3:4b",
    fetchImpl = globalThis.fetch,
    timeoutMs = 120_000,
    keepAlive = "-1",
    contextSize = 4_096,
    maxTokens = 256,
    logger = null,
    metrics = null,
  } = {}) {
    if (!runtime) throw new Error("A tool runtime is required.");
    this.runtime = runtime;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.keepAlive = normalizeKeepAlive(keepAlive);
    this.contextSize = contextSize;
    this.maxTokens = maxTokens;
    this.logger = logger;
    this.metrics = metrics;
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.pendingApprovals = new Map();
    this.busy = false;
  }

  reset() {
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.pendingApprovals.clear();
  }

  async warm() {
    const started = process.hrtime.bigint();
    try {
      const response = await this.fetch(new URL("/api/chat", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [],
          stream: false,
          keep_alive: this.keepAlive,
          options: { num_ctx: this.contextSize },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const outcome = response.ok ? "success" : "http_error";
      this.recordRequest("warmup", outcome, started);
      return { ready: response.ok, message: response.ok ? "Model loaded." : `Ollama returned HTTP ${response.status}.` };
    } catch (error) {
      this.recordRequest("warmup", transportOutcome(error), started);
      return { ready: false, message: `Ollama is not reachable at ${this.baseUrl}.` };
    }
  }

  async status() {
    const started = process.hrtime.bigint();
    try {
      const response = await this.fetch(new URL("/api/tags", this.baseUrl), {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) {
        this.recordRequest("status", "http_error", started);
        return { reachable: false, model: this.model, message: `Ollama returned HTTP ${response.status}.` };
      }
      const payload = await response.json();
      const models = Array.isArray(payload.models) ? payload.models.map((item) => item.name || item.model).filter(Boolean) : [];
      const result = {
        reachable: true,
        model: this.model,
        model_available: models.some((name) => modelMatches(name, this.model)),
        installed_models: models,
      };
      this.recordRequest("status", "success", started);
      return result;
    } catch (error) {
      this.recordRequest("status", transportOutcome(error), started);
      return {
        reachable: false,
        model: this.model,
        message: `Ollama is not reachable at ${this.baseUrl}.`,
      };
    }
  }

  async send(text) {
    const message = typeof text === "string" ? text.trim() : "";
    if (!message || message.length > 20_000) throw new ToolError("invalid_message", "Enter a message under 20,000 characters.");
    if (this.pendingApprovals.size) throw new ToolError("approval_pending", "Approve or deny the pending action first.");
    const command = await fastCommand(message, this.runtime);
    if (command) return { status: "completed", ...command, model: "local-command-router" };
    const instant = instantReply(message);
    if (instant) return { status: "completed", message: instant, model: "local-fast-path" };
    return this.withLock(async () => {
      this.messages.push({ role: "user", content: message });
      this.trimHistory();
      return this.runAgent();
    });
  }

  async decide(approvalId, approved) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new ToolError("approval_not_found", "That local assistant approval expired or was already handled.");
    this.pendingApprovals.delete(approvalId);

    return this.withLock(async () => {
      const result = await this.runtime.decide(approvalId, approved);
      this.appendToolResult(pending.toolName, result);
      const nextApproval = await this.executeToolCalls(pending.remainingCalls);
      return nextApproval || this.runAgent();
    });
  }

  async runAgent() {
    for (let round = 0; round < 6; round += 1) {
      const response = await this.callOllama();
      const assistantMessage = normalizeAssistantMessage(response.message);
      this.messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (!toolCalls.length) {
        return {
          status: "completed",
          message: assistantMessage.content?.trim() || "Done.",
          model: this.model,
        };
      }

      const approval = await this.executeToolCalls(toolCalls);
      if (approval) return approval;
    }
    throw new ToolError("tool_loop_limit", "The local model requested too many consecutive tool actions.");
  }

  async executeToolCalls(toolCalls) {
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      const name = call?.function?.name;
      const args = normalizeArguments(call?.function?.arguments);
      let result;
      try {
        result = await this.runtime.request(name, args);
      } catch (error) {
        result = { status: "failed", error: error.code || "tool_error", message: error.message };
      }

      if (result.status === "approval_required") {
        this.pendingApprovals.set(result.approval_id, {
          toolName: name,
          remainingCalls: toolCalls.slice(index + 1),
        });
        return { ...result, source: "local_chat" };
      }
      this.appendToolResult(name, result);
    }
    return null;
  }

  appendToolResult(name, result) {
    this.messages.push({ role: "tool", tool_name: name, content: JSON.stringify(result) });
  }

  async callOllama() {
    const started = process.hrtime.bigint();
    let response;
    try {
      response = await this.fetch(new URL("/api/chat", this.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: this.messages,
          tools: toOllamaTools(TOOL_DEFINITIONS),
          stream: false,
          think: false,
          keep_alive: this.keepAlive,
          options: {
            num_ctx: this.contextSize,
            num_predict: this.maxTokens,
            temperature: 0.2,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.recordRequest("chat", transportOutcome(error), started);
      throw new ToolError(
        "ollama_unreachable",
        `Ollama is not reachable at ${this.baseUrl}. Start Ollama or configure the Linux server address.`,
      );
    }

    const body = await response.text();
    let payload;
    try { payload = JSON.parse(body); } catch { payload = null; }
    if (!response.ok) {
      this.recordRequest("chat", "http_error", started);
      const detail = payload?.error || `Ollama returned HTTP ${response.status}.`;
      throw new ToolError("ollama_error", String(detail).slice(0, 500));
    }
    if (!payload?.message) {
      this.recordRequest("chat", "invalid_response", started);
      throw new ToolError("ollama_error", "Ollama returned an incomplete chat response.");
    }
    this.recordRequest("chat", "success", started);
    return payload;
  }

  recordRequest(operation, outcome, started) {
    const seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
    this.metrics?.observeOllama(operation, outcome, seconds);
    this.logger?.info({
      event: "ollama.request.completed",
      operation,
      outcome,
      duration_ms: Math.round(seconds * 1000),
      model: this.model,
    });
  }

  trimHistory() {
    if (this.messages.length <= 31) return;
    this.messages = [this.messages[0], ...this.messages.slice(-30)];
  }

  async withLock(operation) {
    if (this.busy) throw new ToolError("assistant_busy", "The local assistant is already processing a request.");
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}

export function toOllamaTools(definitions) {
  return definitions.map(({ name, description, parameters }) => ({
    type: "function",
    function: { name, description, parameters },
  }));
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("OLLAMA_BASE_URL must use http or https.");
  parsed.username = "";
  parsed.password = "";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeKeepAlive(value) {
  const normalized = String(value ?? "").trim();
  if (/^-?\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  return normalized || "30m";
}

function normalizeAssistantMessage(message) {
  return {
    role: "assistant",
    content: typeof message?.content === "string" ? message.content : "",
    ...(Array.isArray(message?.tool_calls) ? { tool_calls: message.tool_calls } : {}),
  };
}

function normalizeArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function modelMatches(installed, configured) {
  return installed === configured || installed === `${configured}:latest` || `${installed}:latest` === configured;
}

function instantReply(text) {
  const normalized = text.toLowerCase().replace(/[!.,?]+$/g, "").trim();
  if (new Set(["hi", "hello", "hey", "hi there", "hello there", "good morning", "good afternoon", "good evening"]).has(normalized)) {
    return "Hi, I’m Goffy. What can I do for you?";
  }
  if (new Set(["help", "what can you do", "what can you do for me", "show capabilities", "show me what you can do"]).has(normalized)) {
    return [
      "I’m Goffy, your private local assistant. I can answer questions and maintain a conversation using your local Qwen model.",
      "I can open Calculator, Notepad, Paint, Settings, and File Explorer; report the time and system status; list files in approved folders; and open websites after you approve them.",
      "Voice input and spoken replies run locally. Try saying: “Open calculator” or “Give me my system status.”",
    ].join("\n\n");
  }
  return null;
}

async function fastCommand(text, runtime) {
  const normalized = text.toLowerCase().replace(/[!.,?]+$/g, "").replace(/\s+/g, " ").trim();
  const appMatch = normalized.match(/^(?:please )?(?:open|launch|start)(?: the)? (calculator|notepad|paint|settings|file explorer|explorer)$/);
  if (appMatch) {
    const application = appMatch[1] === "file explorer" ? "explorer" : appMatch[1];
    const result = await runtime.request("open_application", { application });
    return { message: result.message || `Opened ${application}.` };
  }
  if (/^(?:please )?(?:tell me )?(?:what(?:'s| is) the time|what time is it|current time)$/.test(normalized)) {
    const result = await runtime.request("get_local_time", {});
    return { message: `It’s ${new Date(result.iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` };
  }
  if (/^(?:please )?(?:give me |show me |check )?(?:my |the )?(?:system status|computer status|laptop status)$/.test(normalized)) {
    const result = await runtime.request("get_system_status", {});
    return { message: `Your laptop has ${result.cpu_count} CPU threads and is using ${result.memory_used_gb} GB of ${result.memory_total_gb} GB memory. It has been running for ${formatUptime(result.uptime_seconds)}.` };
  }
  return null;
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function transportOutcome(error) {
  return new Set(["AbortError", "TimeoutError"]).has(error?.name) ? "timeout" : "unreachable";
}
