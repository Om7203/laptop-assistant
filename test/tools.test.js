import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decryptWindowsCredential, resolveOpenAIKey } from "../src/secrets.js";
import { ToolError, ToolRuntime } from "../src/tools.js";

test("prefers an injected environment key without writing it to disk", () => {
  const result = resolveOpenAIKey({
    projectRoot: process.cwd(),
    environment: { OPENAI_API_KEY: "test-key-from-environment" },
  });
  assert.equal(result, "test-key-from-environment");
});

test("decrypts a Windows DPAPI credential for the current user", { skip: process.platform !== "win32" }, async (context) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-secret-test-"));
  const credentialFile = path.join(sandbox, "test.dpapi");
  const script = [
    "$secure = ConvertTo-SecureString 'temporary-test-secret' -AsPlainText -Force",
    "$encrypted = ConvertFrom-SecureString -SecureString $secure",
    "[IO.File]::WriteAllText($args[0], $encrypted)",
  ].join("; ");
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, credentialFile]);
  } catch (error) {
    if (error.code === "EPERM") {
      context.skip("The current test sandbox blocks child PowerShell processes.");
      return;
    }
    throw error;
  }
  assert.equal(decryptWindowsCredential(credentialFile), "temporary-test-secret");
});

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
