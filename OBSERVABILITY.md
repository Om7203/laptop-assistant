# Observability and operations

Laptop Assistant treats observability as part of the product. Telemetry is local by default and designed to diagnose failures without collecting conversation content.

## Operational endpoints

| Endpoint | Purpose | Success |
| --- | --- | --- |
| `/api/health/live` | Process liveness | HTTP 200 while the server can answer requests |
| `/api/health/ready` | Dependency readiness | HTTP 200 when Ollama is reachable and the configured model is installed |
| `/metrics` | Prometheus scrape endpoint | HTTP 200 with Prometheus text exposition |

Whisper is reported as a separate readiness component because typed chat remains useful when local speech is not installed. The legacy `/api/health` endpoint remains available to the interface.

## Metric catalog

Application metrics use the `laptop_assistant_` prefix:

- `http_requests_total`, `http_request_duration_seconds`, and `http_requests_in_flight`
- `ollama_requests_total` and `ollama_request_duration_seconds`
- `whisper_transcriptions_total` and `whisper_transcription_duration_seconds`
- `whisper_startup_duration_seconds`
- `tool_executions_total`
- `approval_decisions_total`
- `build_info`

The Prometheus client also exports process CPU, memory, event-loop, garbage-collection, and Node.js runtime metrics with the `laptop_assistant_process_` prefix.

Metric labels are deliberately bounded. Request IDs, prompts, model replies, transcripts, URLs, filenames, directory paths, user identifiers, and error messages are never labels.

## Structured logs

Logs are newline-delimited JSON. Important event names include:

- `server.started`
- `http.request.completed`
- `http.request.failed`
- `ollama.request.completed`
- `whisper.worker.startup.completed`
- `whisper.transcription.completed`
- `tool.execution.completed`

Known secret and content fields are automatically redacted. HTTP logs contain only the request ID, method, normalized route, status code, and duration. The launchers write to `logs/assistant.log`; the directory is ignored by Git.

## Initial service objectives

These are engineering targets, not claims about historical production traffic:

- 99.5% successful local API requests when required dependencies are healthy.
- P95 server overhead below 100 ms, excluding Ollama inference and Whisper transcription.
- P95 liveness response below 250 ms.
- No secret or conversation content in logs or metric labels.
- Every failed Ollama, Whisper, and tool operation produces a bounded outcome metric.

The Grafana phase will turn these into recording rules, dashboards, and alerts after enough local baseline data exists.

## Failure runbook

### Liveness fails

1. Check whether the Node or Electron process is running.
2. Inspect the latest sanitized JSON log events.
3. Check whether another process owns port 3199.
4. Restart the assistant and confirm `/api/health/live` returns HTTP 200.

### Readiness returns HTTP 503

1. Inspect `components.ollama` in the readiness response.
2. Confirm Ollama is running on the configured host.
3. Confirm the configured model appears in `ollama list`.
4. If Ollama runs on Linux, confirm the private-network address and firewall rule.
5. Retry readiness before restarting the desktop application.

### Voice input fails

1. Inspect `components.whisper` in the readiness response.
2. Run `setup-local-voice.cmd` if the model is not installed.
3. Check `whisper.worker.startup.completed` and `whisper.transcription.completed` outcomes.
4. Confirm Windows microphone permission and that another application is not holding the device.

### Tool failures increase

1. Group `tool_executions_total` by the bounded `tool` and `outcome` labels.
2. Correlate the time window with sanitized `tool.execution.completed` events.
3. Reproduce using the narrow tool input rather than granting broader permissions.
4. Add a regression test before changing the allowlist or validation boundary.
