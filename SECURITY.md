# Security policy

This application controls a real computer. Treat every new tool as a security boundary.

## Rules for tool authors

- Never expose an unrestricted terminal or arbitrary PowerShell command tool.
- Validate all arguments on the server, even if the model schema also validates them.
- Use allowlists for applications, protocols, directories, and external services.
- Require fresh confirmation for deletion, installation, messaging, purchasing, authentication, account changes, or any action that cannot be trivially undone.
- Do not place API keys, passwords, cookies, tokens, or private keys in prompts, logs, browser code, or Git.
- Keep approval tokens short-lived and single-use.
- Return the smallest result needed by the model.

## Current boundaries

- The HTTP server binds to loopback only.
- Directory listing is restricted to configured roots.
- Application launching uses a fixed server-side map.
- External URLs accept only `https:` and `http:` and require approval.
- The server limits request body sizes.
- The browser receives no standard OpenAI API key.

## Reporting

Until a private reporting address is configured, do not open a public issue containing secrets or personal data. Rotate any credential that may have been exposed.
