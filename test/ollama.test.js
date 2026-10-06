import assert from "node:assert/strict";
import test from "node:test";
import { OllamaAssistant, toOllamaTools } from "../src/ollama.js";
import { TOOL_DEFINITIONS, ToolRuntime } from "../src/tools.js";

test("converts tool definitions to Ollama's function schema", () => {
  const tools = toOllamaTools(TOOL_DEFINITIONS);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "get_local_time");
  assert.equal(tools[0].name, undefined);
});

test("returns a normal local model response", async () => {
  const assistant = createAssistant([
    { message: { role: "assistant", content: "Hello from the local model." } },
  ]);
  const result = await assistant.send("Tell me something useful.");
  assert.equal(result.status, "completed");
  assert.equal(result.message, "Hello from the local model.");
});

test("answers a simple greeting without invoking the model", async () => {
  let calls = 0;
  const runtime = new ToolRuntime({ projectRoot: process.cwd() });
  const assistant = new OllamaAssistant({
    runtime,
    fetchImpl: async () => { calls += 1; throw new Error("should not be called"); },
  });
  const result = await assistant.send("Hi!");
  assert.equal(result.message, "Hi! How can I help?");
  assert.equal(result.model, "local-fast-path");
  assert.equal(calls, 0);
});

test("routes a common application command without model latency", async () => {
  let calls = 0;
  const requested = [];
  const runtime = {
    request: async (name, args) => {
      requested.push({ name, args });
      return { status: "completed", message: "Opened calculator." };
    },
  };
  const assistant = new OllamaAssistant({
    runtime,
    fetchImpl: async () => { calls += 1; throw new Error("should not be called"); },
  });
  const result = await assistant.send("Please open the calculator.");
  assert.equal(result.message, "Opened calculator.");
  assert.equal(result.model, "local-command-router");
  assert.deepEqual(requested, [{ name: "open_application", args: { application: "calculator" } }]);
  assert.equal(calls, 0);
});

test("describes installed capabilities without invoking the model", async () => {
  let calls = 0;
  const runtime = new ToolRuntime({ projectRoot: process.cwd() });
  const assistant = new OllamaAssistant({
    runtime,
    fetchImpl: async () => { calls += 1; throw new Error("should not be called"); },
  });
  const result = await assistant.send("What can you do?");
  assert.match(result.message, /Calculator|Voice input/);
  assert.equal(calls, 0);
});

test("executes an automatic tool and sends its result back to Ollama", async () => {
  const requests = [];
  const assistant = createAssistant([
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ type: "function", function: { name: "get_local_time", arguments: {} } }],
      },
    },
    { message: { role: "assistant", content: "I checked the local time." } },
  ], requests);

  const result = await assistant.send("Use the appropriate tool to determine the local time.");
  assert.equal(result.message, "I checked the local time.");
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.tool_name === "get_local_time"));
});

test("pauses a sensitive tool for approval and continues after denial", async () => {
  const assistant = createAssistant([
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          type: "function",
          function: { name: "open_url", arguments: { url: "https://example.com/" } },
        }],
      },
    },
    { message: { role: "assistant", content: "I did not open the site." } },
  ]);

  const pending = await assistant.send("Open example.com");
  assert.equal(pending.status, "approval_required");
  const result = await assistant.decide(pending.approval_id, false);
  assert.equal(result.message, "I did not open the site.");
});

function createAssistant(responses, requests = []) {
  const runtime = new ToolRuntime({ projectRoot: process.cwd() });
  const queue = [...responses];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const payload = queue.shift();
    return new Response(JSON.stringify(payload), {
      status: payload ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  };
  return new OllamaAssistant({ runtime, fetchImpl, timeoutMs: 1_000 });
}
