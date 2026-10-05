import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const APP_ALLOWLIST = Object.freeze({
  calculator: "calc.exe",
  notepad: "notepad.exe",
  explorer: "explorer.exe",
  paint: "mspaint.exe",
  settings: "ms-settings:",
});

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "get_local_time",
    description: "Get the user's current local date, time, and timezone.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "get_system_status",
    description: "Get basic, non-sensitive laptop status such as operating system, uptime, CPU count, and memory usage.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "list_directory",
    description: "List files and folders in an allowed local directory. Use '.' for the assistant project.",
    parameters: {
      type: "object",
      properties: { directory: { type: "string", description: "An allowed absolute path or '.'" } },
      required: ["directory"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_application",
    description: "Open an allowlisted Windows application.",
    parameters: {
      type: "object",
      properties: {
        application: {
          type: "string",
          enum: Object.keys(APP_ALLOWLIST),
          description: "The application to open.",
        },
      },
      required: ["application"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_url",
    description: "Open an http or https URL in the default browser. This always requires user approval.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The complete URL to open." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export class ToolRuntime {
  constructor({ projectRoot, allowedRoots = [], approvalTtlMs = 120_000, logger = null, metrics = null } = {}) {
    this.projectRoot = path.resolve(projectRoot ?? process.cwd());
    this.allowedRoots = [...new Set([this.projectRoot, ...allowedRoots.map((root) => path.resolve(root))])];
    this.approvalTtlMs = approvalTtlMs;
    this.approvals = new Map();
    this.logger = logger;
    this.metrics = metrics;
  }

  async request(name, args = {}) {
    try {
      let result;
      if (name === "open_url") {
        const url = validateWebUrl(args.url);
        const approvalId = randomUUID();
        this.approvals.set(approvalId, {
          name,
          args: { url },
          expiresAt: Date.now() + this.approvalTtlMs,
        });
        result = {
          status: "approval_required",
          approval_id: approvalId,
          summary: `Open ${url} in the default browser`,
        };
      } else {
        result = await this.execute(name, args);
      }
      this.recordTool(name, result.status);
      return result;
    } catch (error) {
      this.recordTool(name, "failed", error.code || "tool_error");
      throw error;
    }
  }

  async decide(approvalId, approved) {
    const pending = this.approvals.get(approvalId);
    this.approvals.delete(approvalId);

    if (!pending || pending.expiresAt < Date.now()) {
      this.metrics?.observeApproval("expired");
      this.recordTool(pending?.name, "denied");
      return { status: "denied", message: "The approval expired or was already used." };
    }
    if (!approved) {
      this.metrics?.observeApproval("denied");
      this.recordTool(pending.name, "denied");
      return { status: "denied", message: "The user declined this action." };
    }
    this.metrics?.observeApproval("approved");
    try {
      const result = await this.execute(pending.name, pending.args, { approved: true });
      this.recordTool(pending.name, result.status);
      return result;
    } catch (error) {
      this.recordTool(pending.name, "failed", error.code || "tool_error");
      throw error;
    }
  }

  recordTool(name, outcome, errorCode = null) {
    this.metrics?.observeTool(name, outcome);
    this.logger?.info({
      event: "tool.execution.completed",
      tool: TOOL_DEFINITIONS.some((tool) => tool.name === name) ? name : "unknown",
      outcome,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }

  async execute(name, args = {}, context = {}) {
    switch (name) {
      case "get_local_time": {
        const now = new Date();
        return {
          status: "completed",
          iso: now.toISOString(),
          local: now.toLocaleString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      }
      case "get_system_status": {
        const total = os.totalmem();
        const free = os.freemem();
        return {
          status: "completed",
          platform: os.platform(),
          release: os.release(),
          architecture: os.arch(),
          cpu_count: os.cpus().length,
          uptime_seconds: Math.round(os.uptime()),
          memory_total_gb: roundGb(total),
          memory_used_gb: roundGb(total - free),
          memory_free_gb: roundGb(free),
        };
      }
      case "list_directory":
        return this.listDirectory(args.directory);
      case "open_application":
        return openApplication(args.application);
      case "open_url":
        if (!context.approved) throw new ToolError("approval_required", "This action requires approval.");
        return openUrl(args.url);
      default:
        throw new ToolError("unknown_tool", `Unknown tool: ${name}`);
    }
  }

  async listDirectory(directory) {
    if (typeof directory !== "string" || directory.length > 1024) {
      throw new ToolError("invalid_argument", "A valid directory is required.");
    }

    const requested = path.resolve(this.projectRoot, directory);
    const real = await fs.realpath(requested).catch(() => {
      throw new ToolError("not_found", "That directory does not exist.");
    });

    if (!this.allowedRoots.some((root) => isWithin(root, real))) {
      throw new ToolError("path_not_allowed", "That directory is outside the configured allowed roots.");
    }

    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new ToolError("not_a_directory", "The requested path is not a directory.");

    const entries = await fs.readdir(real, { withFileTypes: true });
    return {
      status: "completed",
      directory: real,
      entries: entries.slice(0, 100).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      })),
      truncated: entries.length > 100,
    };
  }
}

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

function openApplication(application) {
  if (typeof application !== "string") throw new ToolError("invalid_argument", "Application is required.");
  const executable = APP_ALLOWLIST[application.toLowerCase()];
  if (!executable) throw new ToolError("app_not_allowed", "That application is not allowlisted.");

  if (executable.endsWith(":")) {
    spawn("explorer.exe", [executable], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } else {
    spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
  return { status: "completed", message: `Opened ${application}.` };
}

function openUrl(value) {
  const url = validateWebUrl(value);
  spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { status: "completed", message: `Opened ${url}.` };
}

function validateWebUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new ToolError("invalid_url", "A valid URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ToolError("invalid_url", "The URL could not be parsed.");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new ToolError("protocol_not_allowed", "Only http and https URLs are allowed.");
  }
  return parsed.toString();
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function roundGb(bytes) {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}
