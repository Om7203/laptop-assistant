# Laptop Assistant

A security-first, local-first assistant for Windows. Ollama supplies the language model without a paid API, while an approval-aware server controls which actions can run on the laptop.

## Current milestone

- Typed conversations through Qwen3 on Ollama
- Ollama can run on this Windows laptop or another machine on the private network
- Multi-turn local tool calling
- Visible progress updates
- Local system status and time tools
- Directory listing restricted to configured roots
- Allowlisted application launching
- Human approval before opening external URLs
- Local activity log in the interface
- No API key required for normal usage
- Optional legacy OpenAI Realtime mode is disabled by default

This is deliberately not an unrestricted shell. New capabilities should be added as narrow tools with explicit input validation and a documented risk level.

## Run it with Ollama

1. Install Node.js 22 or newer on the Windows laptop.
2. On the computer running Ollama, install the model with `ollama pull qwen3:4b`. A stronger machine can use `qwen3:8b` instead.
3. Double-click `configure-local-model.cmd` on Windows.
4. If Ollama runs on Windows, keep `http://127.0.0.1:11434`. If it runs on Linux, enter its private-network address, such as `http://192.168.1.50:11434`.
5. Select **Test connection**, save the settings, and then double-click `start-assistant.cmd`.

When Google Chrome is installed, the launcher opens the assistant in a standalone app-style window without normal browser tabs or an address bar. It falls back to the default browser otherwise.

The interface is served only from `127.0.0.1`, so it is a local application page rather than a public website. The local server must stay running while the window is open. Messages are sent only to the configured Ollama server.

The Node application itself has no npm dependencies to install.

### Using Ollama on Linux

Ollama normally listens only on its own machine. To use it from the Windows laptop, configure Ollama on Linux to listen on the private network (for example with `OLLAMA_HOST=0.0.0.0:11434`) and allow TCP port 11434 through the Linux firewall only for the private LAN. Never expose an unauthenticated Ollama port directly to the public internet.

The configuration window checks whether the server is reachable and whether the selected model is installed.

### Model and quantization choices

- `qwen3:4b` is the default. Ollama's current package is already Q4_K_M quantized at roughly 2.5–2.6 GB, which fits this laptop's 4 GB RTX 3050 much better than an 8-bit or FP16 build.
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

The next voice milestone adds browser microphone recording, local faster-whisper transcription, and local operating-system speech output. Typed local chat and tool calling come first so the model/action path can be tested without any cloud dependency.

## Security model

Tools fall into two categories:

- `automatic`: read-only or tightly allowlisted local operations.
- `confirm`: actions with an external effect. The server creates a one-time approval request and will not execute until the user approves it in the interface.

Ollama mode does not require or load an OpenAI key. If a previously saved encrypted OpenAI key exists in `config/openai-key.dpapi`, it remains ignored unless `ENABLE_OPENAI_REALTIME=true` is explicitly configured. The encrypted blob remains excluded from Git.

No local secret can be guaranteed safe from malware, an administrator, or arbitrary code already running as your Windows account. If you suspect exposure, revoke the key immediately, create a replacement, and run `setup.ps1` again. Use a project-scoped key, set an expiration date, and configure a conservative spend limit.

See [SECURITY.md](SECURITY.md) before adding tools.

## Roadmap

1. Add faster-whisper microphone transcription and local speech output.
2. Package as a Windows tray application and add push-to-talk.
3. Add a local wake word.
4. Add screen understanding and safe browser automation.
5. Add reminders, memory, calendar, and email connectors.
6. Add signed releases and an automatic updater.

## Configuration

`OLLAMA_BASE_URL` selects the Ollama server. `OLLAMA_MODEL` selects the installed model. The defaults are `http://127.0.0.1:11434` and `qwen3:4b`.

`ASSISTANT_ALLOWED_ROOTS` accepts absolute paths separated by semicolons. The project directory is always allowed. Directory traversal and symbolic-link escapes are rejected.
