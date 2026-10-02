# Laptop Assistant

A security-first, realtime voice assistant for Windows. It listens through the browser, speaks naturally, reports what it is doing, and can call a small set of local tools through an approval-aware server on your laptop.

## Milestone 1

- Realtime voice conversation with interruption support
- Typed commands in the same session
- Spoken and visible progress updates
- Local system status and time tools
- Directory listing restricted to configured roots
- Allowlisted application launching
- Human approval before opening external URLs
- Local activity log in the interface
- API key encrypted with Windows Data Protection API and kept out of the browser and Git history

This is deliberately not an unrestricted shell. New capabilities should be added as narrow tools with explicit input validation and a documented risk level.

## Run it

1. Install Node.js 22 or newer.
2. Right-click `setup.ps1`, choose **Run with PowerShell**, and enter your OpenAI API key when asked. The key entry stays visually blank.
3. Double-click `start-assistant.cmd`.
4. Select **Connect voice** and allow microphone access.

The launcher decrypts the credential inside PowerShell, passes it only to the local server process, waits for a healthy startup, and then opens the interface. If an older assistant server is running without a credential, the launcher restarts that server automatically.

Developers can instead provide `OPENAI_API_KEY` as a process environment variable and run `npm start`.

No package installation is required for this milestone.

## Example requests

- “What time is it?”
- “Tell me how much memory this laptop is using.”
- “List the files in the assistant project.”
- “Open Notepad.”
- “Open the OpenAI documentation.” (asks for approval)

## Security model

Tools fall into two categories:

- `automatic`: read-only or tightly allowlisted local operations.
- `confirm`: actions with an external effect. The server creates a one-time approval request and will not execute until the user approves it in the interface.

The setup script encrypts the API key with Windows Data Protection API (DPAPI) and stores the encrypted blob in `config/openai-key.dpapi`. Windows ties decryption to the same signed-in account. The blob is ignored by Git, the standard API key never enters browser code, and the assistant's model tools cannot read files or environment variables. The local server decrypts the key only when it starts so it can authenticate API requests.

No local secret can be guaranteed safe from malware, an administrator, or arbitrary code already running as your Windows account. If you suspect exposure, revoke the key immediately, create a replacement, and run `setup.ps1` again. Use a project-scoped key, set an expiration date, and configure a conservative spend limit.

See [SECURITY.md](SECURITY.md) before adding tools.

## Roadmap

1. Package as a Windows tray application and add push-to-talk.
2. Add a local wake word and optional offline transcription.
3. Add screen understanding and safe browser automation.
4. Add reminders, memory, calendar, and email connectors.
5. Add signed releases and an automatic updater.

## Configuration

`ASSISTANT_ALLOWED_ROOTS` accepts absolute paths separated by semicolons. The project directory is always allowed. Directory traversal and symbolic-link escapes are rejected.

The default realtime model and voice can be changed with `OPENAI_REALTIME_MODEL` and `OPENAI_VOICE`.
