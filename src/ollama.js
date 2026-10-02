import { TOOL_DEFINITIONS, ToolError } from "./tools.js";

const SYSTEM_PROMPT = [
  "You are a concise, dependable assistant running locally for the user.",
  "Use the supplied tools when they are relevant.",
  "Never claim an action succeeded until its tool result confirms success.",
  "Sensitive actions require approval in the interface.",
  "Never request passwords, API keys, authentication codes, or payment details.",
].join(" ");

export class OllamaAssistant {
  constructor({
    runtime,
    baseUrl = "http://127.0.0.1:11434",
    model = "qwen3:4b",
    fetchImpl = globalThis.fetch,
    timeoutMs = 120_000,
  } = {}) {
    if (!runtime) throw new Error("A tool runtime is required.");
    this.runtime = runtime;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.pendingApprovals = new Map();
    this.busy = false;
  }

  reset() {
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.pendingApprovals.clear();
  }

  async status() {
    try {
      const response = await this.fetch(new URL("/api/tags", this.baseUrl), {
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return { reachable: false, model: this.model, message: `Ollama returned HTTP ${response.status}.` };
      const payload = await response.json();
      const models = Array.isArray(payload.models) ? payload.models.map((item) => item.name || item.model).filter(Boolean) : [];
      return {
        reachable: true,
        model: this.model,
        model_available: models.some((name) => modelMatches(name, this.model)),
        installed_models: models,
      };
    } catch {
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
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ToolError(
        "ollama_unreachable",
        `Ollama is not reachable at ${this.baseUrl}. Start Ollama or configure the Linux server address.`,
      );
    }

    const body = await response.text();
    let payload;
    try { payload = JSON.parse(body); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload?.error || `Ollama returned HTTP ${response.status}.`;
      throw new ToolError("ollama_error", String(detail).slice(0, 500));
    }
    if (!payload?.message) throw new ToolError("ollama_error", "Ollama returned an incomplete chat response.");
    return payload;
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
