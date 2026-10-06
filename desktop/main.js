import { app, BrowserWindow, Menu, Tray, globalShortcut, nativeImage, session } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, stopServer } from "../src/server.js";

const assistantUrl = "http://127.0.0.1:3199";
const voiceShortcut = "CommandOrControl+Shift+Space";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopDataPath = path.join(projectRoot, "config", "electron-user-data");
fs.mkdirSync(desktopDataPath, { recursive: true });
app.setPath("userData", desktopDataPath);
let mainWindow;
let tray;
let quitting = false;
let ownsServer = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

app.setName("Laptop Assistant");
if (!hasSingleInstanceLock) app.quit();

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Laptop Assistant",
    width: 1180,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    backgroundColor: "#07110f",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(assistantUrl);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`Laptop Assistant window failed to load (${code}): ${description}`);
    app.exit(1);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Laptop Assistant window stopped: ${details.reason}`);
    app.exit(1);
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(assistantUrl).origin) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow?.isVisible()) mainWindow.hide();
  else showWindow();
}

function requestPushToTalk() {
  showWindow();
  mainWindow?.webContents.send("desktop:push-to-talk");
}

function createTray() {
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAACTSURBVHgBpZKBCYAgEEV/TeAIjuIIbdQIuUGt0CS1gW1iZ2jIVaTnhw+Cvs8/OYDJA4Y8kR3ZR2/kmazxJbpUEfQ/Dm/UG7wVwHkjlQdMFfDdJMFaACebnjJGyDWgcnZu1/lrCrl6NCoEHJBrDwEr5NrT6ko/UV8xdLAC2N49mlc5CylpYh8wCwqrvbBGLoKGvz8Bfq0QPWEUo/EAAAAASUVORK5CYII=",
  );
  tray = new Tray(icon);
  tray.setToolTip("Laptop Assistant");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Assistant", click: showWindow },
    { label: `Toggle voice (${voiceShortcut.replace("CommandOrControl", "Ctrl")})`, click: requestPushToTalk },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", toggleWindow);
  tray.on("double-click", showWindow);
}

function configureMicrophonePermission() {
  const localOrigin = new URL(assistantUrl).origin;
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    permission === "media" && requestingOrigin === localOrigin && webContents === mainWindow?.webContents
  ));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details.requestingUrl ? new URL(details.requestingUrl).origin : "";
    const mediaTypes = details.mediaTypes ?? [];
    const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
    callback(permission === "media" && audioOnly && origin === localOrigin && webContents === mainWindow?.webContents);
  });
}

async function ensureServer() {
  try {
    const response = await fetch(`${assistantUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (response.ok && health.api_version === 6) return;
  } catch {
    // The desktop app owns the server when no compatible instance is already running.
  }
  await startServer();
  ownsServer = true;
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  configureMicrophonePermission();
  await ensureServer();
  createWindow();
  createTray();
  const registered = globalShortcut.register(voiceShortcut, requestPushToTalk);
  if (!registered) console.warn(`Could not register ${voiceShortcut}; it may be used by another application.`);
}).catch((error) => {
  console.error("Laptop Assistant desktop startup failed:", error);
  app.exit(1);
});

app.on("activate", showWindow);
app.on("second-instance", showWindow);
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
  if (ownsServer) void stopServer();
});
