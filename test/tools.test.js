import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolError, ToolRuntime } from "../src/tools.js";

test("returns local system status", async () => {
  const runtime = new ToolRuntime({ projectRoot: process.cwd() });
  const result = await runtime.request("get_system_status");
  assert.equal(result.status, "completed");
  assert.ok(result.cpu_count > 0);
  assert.ok(result.memory_total_gb > 0);
});

test("lists files inside the project root", async () => {
  const runtime = new ToolRuntime({ projectRoot: process.cwd() });
  const result = await runtime.request("list_directory", { directory: "." });
  assert.equal(result.status, "completed");
  assert.ok(result.entries.some((entry) => entry.name === "package.json"));
});

test("rejects directory traversal outside allowed roots", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-test-"));
  const project = path.join(sandbox, "project");
  await fs.mkdir(project);
  const runtime = new ToolRuntime({ projectRoot: project });

  await assert.rejects(
    runtime.request("list_directory", { directory: ".." }),
    (error) => error instanceof ToolError && error.code === "path_not_allowed",
  );
});

test("external URLs require a one-time approval", async () => {
  const runtime = new ToolRuntime({ projectRoot: process.cwd() });
  const request = await runtime.request("open_url", { url: "https://example.com/path" });
  assert.equal(request.status, "approval_required");

  const denied = await runtime.decide(request.approval_id, false);
  assert.equal(denied.status, "denied");

  const reused = await runtime.decide(request.approval_id, true);
  assert.equal(reused.status, "denied");
});

test("rejects non-web URL protocols before approval", async () => {
  const runtime = new ToolRuntime({ projectRoot: process.cwd() });
  await assert.rejects(
    runtime.request("open_url", { url: "file:///C:/Windows/System32" }),
    (error) => error instanceof ToolError && error.code === "protocol_not_allowed",
  );
});
