import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AssistantMetrics, createLogger, normalizeRoute } from "../src/observability.js";

test("normalizes dynamic and unknown routes to bounded metric labels", () => {
  assert.equal(normalizeRoute("/api/approvals/2f7e6dda-0e8e-4f9f-bada-9ca7b5ed8e3b?secret=yes"), "/api/approvals/:id");
  assert.equal(normalizeRoute("/private/file/name"), "/other");
});

test("exports Prometheus metrics without request identifiers", async () => {
  const metrics = new AssistantMetrics({ collectDefaults: false, version: "test" });
  const finish = metrics.startHttp("POST", "/api/chat?message=private");
  finish(200);
  metrics.observeOllama("chat", "success", 0.25);
  const output = await metrics.render();
  assert.match(output, /laptop_assistant_http_requests_total/);
  assert.match(output, /route="\/api\/chat"/);
  assert.match(output, /laptop_assistant_ollama_request_duration_seconds/);
  assert.doesNotMatch(output, /private|request_id|message=/);
});

test("redacts sensitive fields from structured logs", async () => {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => { output += chunk.toString(); });
  const logger = createLogger({ stream });
  logger.info({ request_id: "safe-id", prompt: "private prompt", authorization: "Bearer secret" }, "request.received");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(output, /safe-id/);
  assert.match(output, /\[REDACTED\]/);
  assert.doesNotMatch(output, /private prompt|Bearer secret/);
});
