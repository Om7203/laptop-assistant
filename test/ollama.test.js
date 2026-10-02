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
  const result = await assistant.send("Hello");
  assert.equal(result.status, "completed");
  assert.equal(result.message, "Hello from the local model.");
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

  const result = await assistant.send("What time is it?");
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
