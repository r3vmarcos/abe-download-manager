const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const APP_NAME = "Abe download manager";
const ROOT = path.resolve(__dirname, "..");

let backend = null;
let win = null;
let tray = null;
let trayHintShown = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function resolvePaths() {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return {
      command: path.join(res, "backend", "abe-backend.exe"),
      args: [],
      cwd: path.join(res, "backend"),
      staticDir: path.join(res, "frontend"),
      ffmpegDir: path.join(res, "ffmpeg"),
    };
  }
  // Desenvolvimento: usa o venv do backend e o frontend já compilado.
  return {
    command: path.join(ROOT, "backend", ".venv", "Scripts", "python.exe"),
    args: [path.join(ROOT, "backend", "main.py")],
    cwd: path.join(ROOT, "backend"),
    staticDir: path.join(ROOT, "frontend", "dist"),
    ffmpegDir: path.join(__dirname, "ffmpeg"),
  };
}

function startBackend(port) {
  const p = resolvePaths();
  const downloads = path.join(app.getPath("downloads"), "abe_download_manager");
  fs.mkdirSync(downloads, { recursive: true });

  backend = spawn(p.command, p.args, {
    cwd: p.cwd,
    windowsHide: true,
    env: {
      ...process.env,
      ABE_PORT: String(port),
      ABE_DOWNLOADS_DIR: downloads,
      ABE_STATIC_DIR: p.staticDir,
      ABE_FFMPEG_DIR: p.ffmpegDir,
      PYTHONUTF8: "1",
    },
  });
  backend.on("error", (err) => {
    dialog.showErrorBox(APP_NAME, `Não foi possível iniciar o servidor interno.\n\n${err.message}`);
    app.quit();
  });
  backend.on("exit", (code) => {
    backend = null;
    if (!app.isQuitting) {
      dialog.showErrorBox(APP_NAME, `O servidor interno foi encerrado (código ${code}).`);
      app.quit();
    }
  });
}

function stopBackend() {
  if (!backend || !backend.pid) return;
  const pid = backend.pid;
  backend = null;
  // Encerra a árvore inteira (inclui ffmpeg em execução).
  execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
}

function waitForServer(port, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error("O servidor interno não respondeu."));
      else setTimeout(attempt, 300);
    };
    attempt();
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    title: APP_NAME,
    backgroundColor: "#6ec6f0",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();

  // Links externos abrem no navegador padrão, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  // Fechar a janela minimiza para a bandeja: downloads em andamento continuam.
  win.on("close", (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    win.hide();
    if (tray && !trayHintShown) {
      trayHintShown = true;
      try {
        tray.displayBalloon({
          title: APP_NAME,
          content: "O app continua na bandeja. Clique no ícone para abrir ou use Sair no menu.",
        });
      } catch {
        /* balão indisponível */
      }
    }
  });

  win.loadURL(url);
  win.on("closed", () => {
    win = null;
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, "build", "icon.ico"));
  } catch {
    return;
  }
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir", click: showWindow },
      {
        label: "Sair",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", showWindow);
}

ipcMain.handle("restart", () => {
  app.isQuitting = true;
  stopBackend();
  app.relaunch();
  app.exit(0);
});

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Escolher pasta de destino",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(async () => {
    try {
      const port = await freePort();
      startBackend(port);
      await waitForServer(port);
      createWindow(`http://127.0.0.1:${port}`);
      createTray();
    } catch (err) {
      dialog.showErrorBox(APP_NAME, String(err.message || err));
      app.quit();
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    stopBackend();
  });
  // Com a bandeja, o app só encerra por "Sair" (ou reinício).
  app.on("window-all-closed", () => {
    if (app.isQuitting) app.quit();
  });
}
