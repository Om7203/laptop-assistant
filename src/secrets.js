import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function resolveOpenAIKey({ projectRoot, environment = process.env } = {}) {
  if (environment.OPENAI_API_KEY?.trim()) return environment.OPENAI_API_KEY.trim();

  const credentialFile = path.join(projectRoot ?? process.cwd(), "config", "openai-key.dpapi");
  if (!fs.existsSync(credentialFile)) return "";
  return decryptWindowsCredential(credentialFile);
}

export function decryptWindowsCredential(credentialFile) {
  if (process.platform !== "win32") return "";

  const script = [
    "$encrypted = [IO.File]::ReadAllText($args[0])",
    "$secure = ConvertTo-SecureString $encrypted",
    "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }",
    "finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
  ].join("; ");

  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script, credentialFile],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    ).trim();
  } catch {
    return "";
  }
}
