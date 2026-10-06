# Goffy

Goffy is a security-first, local-first female voice assistant for Windows. Ollama supplies the language model without a paid API, while an approval-aware server controls which actions can run on the laptop.

## Current milestone

- Typed conversations through Qwen3 on Ollama
- Local wake phrase ("Hey Goffy") and automatic speech-end detection
- Automatic selection of a locally installed female English voice
- Voice-controlled sleep, microphone shutdown, cancellation, and spoken-reply interruption
- Local transcription through faster-whisper or Cactus Whistle
- Spoken replies enabled by default using installed Windows voices
- Native Windows desktop window with a system-tray menu
- Global `Ctrl+Shift+Space` voice on/off shortcut
- Ollama can run on this Windows laptop or another machine on the private network
- Multi-turn local tool calling
- Instant local routing for common commands, without waiting for the language model
- Automatic local Ollama startup when the assistant launches
- Visible progress updates
- Local system status and time tools
- Directory listing restricted to configured roots
- Allowlisted application launching
- Human approval before opening external URLs
- Local activity log in the interface
- Structured, privacy-safe JSON application logs
- Prometheus metrics plus liveness and readiness checks
- No API key required for normal usage
- Optional legacy OpenAI Realtime mode is disabled by default

This is deliberately not an unrestricted shell. New capabilities should be added as narrow tools with explicit input validation and a documented risk level.

## Run it with Ollama

1. Install Node.js 22 or newer on the Windows laptop.
2. On the computer running Ollama, install the fast non-thinking model with `ollama pull qwen3:4b-instruct-2507-q4_K_M`. A stronger machine can use a larger instruct model instead.
3. Double-click `configure-local-model.cmd` on Windows.
4. If Ollama runs on Windows, keep `http://127.0.0.1:11434`. If it runs on Linux, enter its private-network address, such as `http://192.168.1.50:11434`.
5. Select **Test connection**, save the settings, and then double-click `start-assistant.cmd`.

## Add local voice input

1. Double-click `setup-local-voice.cmd`. It creates an isolated Python environment inside the project, installs faster-whisper, and downloads the `base.en` speech model.
2. Restart `start-assistant.cmd`.
3. Select **Enable voice** once. Goffy enters sleep mode and waits locally for “Hey Goffy.”
4. Say “Hey Goffy, open calculator,” or say the wake phrase by itself and then give a follow-up command.
5. Say “stop listening” or “go to sleep” to return to wake-only mode. Say “turn off the microphone” to release it completely.
6. Speak over a long answer to interrupt it. **Voice replies** can also be turned off independently.

Recorded audio is sent only to the local server, transcribed on this laptop, and deleted immediately after transcription. The persistent speech worker keeps the model loaded between commands for lower latency.

### Try the faster Whistle backend

After the local voice setup above, double-click `setup-whistle.cmd`. It installs the pinned Cactus runtime, downloads Whistle, disables its optional telemetry, and changes `STT_BACKEND` to `whistle` in the private `.env` file. Restart the assistant afterward.

Whistle is experimental in this project. If it cannot start or transcribe a recording, the server automatically retries that recording with faster-whisper. Set `STT_BACKEND=faster-whisper` to return to the established backend, or `STT_BACKEND=auto` to prefer Whistle only when it is installed. `STT_KEYWORDS` is a comma-separated list of product and application names that Whistle should favour.

## Run the native desktop version

1. Complete the Ollama and local voice setup above.
2. Double-click `setup-desktop.cmd` once. This installs the pinned Electron desktop runtime inside the project.
3. Double-click `start-desktop.cmd` whenever you want to run the assistant.
4. Close the window to keep the assistant available in the Windows system tray. Use the tray menu to reopen or quit it.
5. Press `Ctrl+Shift+Space` anywhere to turn hands-free listening on or off.

The desktop window runs the same local interface and permission-gated tools. Node integration is disabled in the window, browsing away from the local interface is blocked, and microphone access is allowed only for the local assistant origin. The original `start-assistant.cmd` browser launcher remains available.

The desktop setup also grants Electron's runtime the Windows read permission required by its secure application sandbox. If Windows rejects that permission, the setup window explains that it must be run once with **Run as administrator**. Startup errors are retained as timestamped `logs/desktop-error-*.log` files instead of disappearing with the launcher window.

When Google Chrome is installed, the launcher opens the assistant in a standalone app-style window without normal browser tabs or an address bar. It falls back to the default browser otherwise.

The interface is served only from `127.0.0.1`, so it is a local application page rather than a public website. The local server must stay running while the window is open. Messages are sent only to the configured Ollama server.

The Node application uses pinned production dependencies for structured logging and Prometheus metrics. `setup-desktop.cmd` installs them together with the desktop runtime.

### Using Ollama on Linux

Ollama normally listens only on its own machine. To use it from the Windows laptop, configure Ollama on Linux to listen on the private network (for example with `OLLAMA_HOST=0.0.0.0:11434`) and allow TCP port 11434 through the Linux firewall only for the private LAN. Never expose an unauthenticated Ollama port directly to the public internet.

The configuration window checks whether the server is reachable and whether the selected model is installed.

### Model and quantization choices

- `qwen3:4b-instruct-2507-q4_K_M` is the recommended default. It is quantized at roughly 2.5 GB and avoids the long internal reasoning generated by the standard thinking-oriented `qwen3:4b` tag.
- `qwen3:1.7b-q4_K_M` prioritizes speed and low memory, with lower reasoning and tool-selection quality.
- `qwen3:8b-q4_K_M` is stronger but its model file is about 5.2 GB, so this laptop cannot keep the whole model in its 4 GB GPU memory.
- `qwen3:30b-a3b-q4_K_M` is a mixture-of-experts model with only about 3B parameters active per token, but the quantized weights are still about 19 GB. It is appropriate only if the Linux Ollama host has much more memory.

For this assistant, a small dense quantized model is the practical default. The model field remains configurable so larger dense or MoE models can be benchmarked on the Linux host without changing the application.

## Example requests

- “What time is it?”
- “Tell me how much memory this laptop is using.”
- “List the files in the assistant project.”
- “Open Notepad.”
- “Open the OpenAI documentation.” (asks for approval)

## Architecture

```text
Windows chat interface
        |
        v
Local approval + tool server
        |
        +----> Ollama / Qwen3 (Windows or private Linux machine)
        |
        +----> Allowlisted laptop tools
```

The interface uses local voice-activity detection to identify the start and end of each spoken command. In sleep mode, transcripts without the wake phrase are discarded locally and never sent to the language model. During a spoken reply, echo cancellation plus a dedicated interruption detector lets the user cut Goffy off; she immediately stops speaking and opens a new listening turn. A persistent local speech worker keeps the transcription model loaded between commands. Whistle is the low-latency option and faster-whisper remains the fallback.

## Security model

Tools fall into two categories:

- `automatic`: read-only or tightly allowlisted local operations.
- `confirm`: actions with an external effect. The server creates a one-time approval request and will not execute until the user approves it in the interface.

Ollama mode does not require or load an OpenAI key. If a previously saved encrypted OpenAI key exists in `config/openai-key.dpapi`, it remains ignored unless `ENABLE_OPENAI_REALTIME=true` is explicitly configured. The encrypted blob remains excluded from Git.

No local secret can be guaranteed safe from malware, an administrator, or arbitrary code already running as your Windows account. If you suspect exposure, revoke the key immediately, create a replacement, and run `setup.ps1` again. Use a project-scoped key, set an expiration date, and configure a conservative spend limit.

See [SECURITY.md](SECURITY.md) before adding tools.

## Production observability

The local server exposes operational endpoints on the same loopback-only address:

- `GET /api/health/live` confirms that the process is running.
- `GET /api/health/ready` checks whether Ollama and the configured model are available and reports local speech separately.
- `GET /metrics` returns Prometheus-compatible process and application metrics.

Every HTTP response includes an `X-Request-ID`. Structured logs connect that identifier to request duration and outcome without recording prompts, transcripts, URLs, file paths, API keys, or authorization values. The Windows launchers write JSON logs to `logs/assistant.log`, which remains excluded from Git.

See [OBSERVABILITY.md](OBSERVABILITY.md) for the metric catalog, initial SLOs, privacy rules, and failure runbook.

## Roadmap

1. Add Prometheus and Grafana dashboards, alert rules, and distributed traces.
2. Replace transcript-based wake detection with a dedicated low-power wake-word model.
3. Add screen understanding and safe browser automation.
4. Add reminders, memory, calendar, and email connectors.
5. Package a signed installer and add automatic updates.

## Configuration

`OLLAMA_BASE_URL` selects the Ollama server. `OLLAMA_MODEL` selects the installed model. The defaults are `http://127.0.0.1:11434` and `qwen3:4b-instruct-2507-q4_K_M`.

`OLLAMA_KEEP_ALIVE` controls how long the model stays loaded; `-1` keeps it resident for faster follow-up turns. `OLLAMA_CONTEXT_SIZE` defaults to `4096` to reduce local processing overhead while retaining useful conversation context.

`OLLAMA_MAX_TOKENS` defaults to `256`, keeping normal voice answers concise and reducing local generation delay.

`WHISPER_MODEL`, `WHISPER_DEVICE`, and `WHISPER_COMPUTE_TYPE` customize local transcription. The reliable defaults are `base.en`, `cpu`, and `int8`.

`STT_BACKEND` selects `faster-whisper`, `whistle`, or `auto`. `STT_KEYWORDS` supplies up to 50 comma-separated terms for Whistle keyword biasing. Whistle telemetry is disabled by the application.

`ASSISTANT_ALLOWED_ROOTS` accepts absolute paths separated by semicolons. The project directory is always allowed. Directory traversal and symbolic-link escapes are rejected.

`LOG_LEVEL` controls structured log verbosity and defaults to `info`. `LOG_DESTINATION` optionally selects a JSON log file; the Windows launchers default to `logs/assistant.log`.
