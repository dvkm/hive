// hive desktop app: a native window onto the local hive server, plus what a
// browser tab can't do — native macOS notifications from the server's
// notification stream and a dock badge counting open decisions + checkpoints.
// The server itself stays the LaunchAgent (dev.hive.server); this app is a
// client only and reconnects politely when the daemon is down.
const { app, BrowserWindow, Notification, shell, screen, ipcMain } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { routeFor } = require("./deeplink.js");
const { shouldUpdate } = require("./versionCheck.js");

const BASE = process.env.HIVE_URL || "http://127.0.0.1:4700";
const SMOKE = !!process.env.HIVE_SMOKE; // load, print ok, quit — used by CI/verification
const OWN_VERSION = require("./package.json").version;

let win = null;
let launchedByDeeplink = false;
const pendingUrls = [];
// Notification ids already rendered. The server can deliver the same one over
// the stream and (on a cold start) through the hive:// URL; show it once.
const shown = new Set();

function createWindow() {
  // Clamp the initial size to the display's work area. At a fixed 1440x920 the
  // window is taller/wider than a small laptop screen (e.g. 1440x900), so its
  // resize edges fall off-screen and can't be grabbed — it reads as "can't
  // resize the window." Fitting the work area keeps every edge reachable.
  const { width: aw, height: ah } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, aw),
    height: Math.min(920, ah),
    minWidth: 640,
    minHeight: 480,
    resizable: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1c1c1e",
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.js") },
  });
  // External links (PRs, evidence raw files on other hosts) open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(BASE)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
  loadWithRetry();
  win.on("focus", () => checkForShellUpdate());
  win.on("closed", () => (win = null));
}

// The daemon may be restarting (deploys kickstart it); retry instead of
// showing Chromium's error page.
let retryTimer = null;
function loadWithRetry() {
  if (!win) return;
  win.loadURL(BASE).catch(() => {
    win?.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          `<body style="background:#1c1c1e;color:#ddd;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
             <div style="text-align:center"><h2>hive server not reachable</h2>
             <p style="opacity:.7">waiting for ${BASE} — retrying…</p></div></body>`
        )
    );
    clearTimeout(retryTimer);
    retryTimer = setTimeout(loadWithRetry, 3000);
  });
}

function goto(path) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  win.focus();
  win.loadURL(BASE + path).catch(() => {});
}

// ---- hive:// deeplinks ----
// Registered by the app bundle (electron/package.json "protocols"). Anything
// can open one — Terminal, another app, a notification click:
//   hive://task/1247          a task by number or id
//   hive://decision/dec_abc   the decision card, scrolled to and highlighted
//   hive://quiz/<task-id>     the understanding check on that task
//   hive://open?path=/inbox   any app route, escape hatch
//   hive://notify?...         internal: render a notification on a cold start
// Route mapping lives in deeplink.js (checked by `node electron/deeplink.js`).
function handleUrl(rawUrl) {
  // hive://notify is internal: the server uses it to hand a whole notification
  // to a cold-started app, and it is not a navigation.
  if (rawUrl.startsWith("hive://notify")) {
    const url = new URL(rawUrl);
    showNotification({
      id: url.searchParams.get("id"),
      title: url.searchParams.get("title") || "hive",
      body: url.searchParams.get("body") || "",
      path: url.searchParams.get("path") || "/",
    });
    return;
  }
  const route = routeFor(rawUrl);
  if (route) goto(route);
}

// One native macOS notification. Electron routes it through the app bundle, so
// it carries the hive icon and obeys Do Not Disturb / Focus like any other app.
function showNotification(n) {
  if (n.id) {
    if (shown.has(n.id)) return;
    shown.add(n.id);
  }
  const report = (payload) => {
    if (!n.id) return;
    fetch(`${BASE}/api/notifications/${encodeURIComponent(n.id)}/delivery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  };
  const note = new Notification({ title: n.title || "hive", body: n.body || "" });
  note.on("click", () => goto(n.path && n.path.startsWith("/") ? n.path : "/"));
  // macOS refusing is the failure the director actually hit. Report it instead
  // of swallowing it: `hive notify --test` prints the reason.
  note.on("failed", (_event, error) => {
    console.error("[hive] notification failed:", error);
    report({ error: String(error) });
  });
  // `show` is the only honest delivery signal: it fires when macOS accepted it.
  note.on("show", () => report({ shown: true }));
  note.show();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  launchedByDeeplink = true;
  if (app.isReady()) handleUrl(url);
  else pendingUrls.push(url);
});

// A second copy (three builds of this bundle can exist across worktrees) would
// double every notification and split the deeplinks. Hand its URLs to the
// original and quit.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", (_event, argv) => {
  const url = argv.find((a) => a.startsWith("hive://"));
  if (url) handleUrl(url);
  else if (win) goto("/");
});

// ---- live state from the server's SSE stream ----
function subscribe() {
  const req = http.get(BASE + "/api/stream?client=app", { headers: { Accept: "text/event-stream" } }, (res) => {
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        try {
          handle(JSON.parse(data));
        } catch {
          /* non-JSON frame (hello/heartbeat) */
        }
      }
    });
    res.on("end", () => setTimeout(subscribe, 3000));
    res.on("error", () => setTimeout(subscribe, 5000));
  });
  req.on("error", () => setTimeout(subscribe, 5000));
}

function handle(msg) {
  // The server pushes one `notify` frame per notification it wants rendered
  // natively. This is the primary delivery path: no shell-out, no bundle-id
  // lookup, and it reaches THIS running copy rather than whichever build
  // LaunchServices happens to pick.
  if (msg.type === "notify") showNotification(msg);
  // Anything that can change the inbox count refreshes the badge.
  if (["decision", "event", "task", "notification"].includes(msg.type)) refreshBadge();
}

// ---- dock badge: open decisions + open checkpoints ----
let badgeTimer = null;
function refreshBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    try {
      const [d, c] = await Promise.all([
        fetch(BASE + "/api/decisions?status=open").then((r) => r.json()),
        fetch(BASE + "/api/checkpoints").then((r) => r.json()),
      ]);
      const n = (Array.isArray(d) ? d.length : 0) + (c?.checkpoints?.length ?? 0);
      app.dock?.setBadge(n > 0 ? String(n) : "");
    } catch {
      /* server down — leave the badge alone */
    }
  }, 500); // debounce bursts
}

// ---- shell self-update (HIVE-420) ----
// Only shell files (this file, deeplink.js, ...) need a reinstall; web/server
// changes need none, since this window just loads BASE. Poll the server for
// the shell version its own repo checkout expects and offer a one-click
// reinstall when the running app is behind.
let lastShellCheckAt = 0;
const SHELL_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let lastShellRepoPath = null;

async function checkForShellUpdate() {
  if (Date.now() - lastShellCheckAt < SHELL_CHECK_INTERVAL_MS) return;
  lastShellCheckAt = Date.now();
  try {
    const res = await fetch(`${BASE}/api/shell-version`);
    const data = await res.json();
    lastShellRepoPath = data.repo_path || null;
    if (shouldUpdate(OWN_VERSION, data.version)) showShellUpdateBanner();
  } catch {
    /* server unreachable or too old for this endpoint — try again next hour */
  }
}

function showShellUpdateBanner() {
  if (!win) return;
  win.webContents
    .executeJavaScript(
      `(function(){
        if (document.getElementById('hive-shell-update-banner')) return;
        var b = document.createElement('div');
        b.id = 'hive-shell-update-banner';
        b.textContent = 'App shell update available: Restart to update';
        b.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#2c2c2e;color:#fff;padding:8px 14px;border-radius:8px;font:13px -apple-system,system-ui;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)';
        b.onclick = function () {
          b.textContent = 'Updating…';
          window.hiveShell.relaunchUpdate();
        };
        window.hiveShell.onRelaunchError(function (message) {
          b.textContent = 'Update failed: ' + message;
          b.onclick = null;
        });
        document.body.appendChild(b);
      })();`
    )
    .catch(() => {});
}

// Runs electron/install-app.sh from the repo the server told us about, then
// relaunches on success. Any failure is reported back to the banner, never
// crashes the running app.
ipcMain.on("shell-update-relaunch", (event) => {
  if (!lastShellRepoPath) {
    event.sender.send("shell-update-relaunch-error", "no repo path from the server");
    return;
  }
  const scriptDir = path.join(lastShellRepoPath, "electron");
  const child = spawn("./install-app.sh", { cwd: scriptDir, shell: true });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (e) => event.sender.send("shell-update-relaunch-error", String(e.message || e)));
  child.on("exit", (code) => {
    if (code === 0) {
      app.relaunch();
      app.exit();
    } else {
      event.sender.send("shell-update-relaunch-error", stderr.trim() || `install script exited ${code}`);
    }
  });
});

app.whenReady().then(() => {
  // Dev runs (`electron .`) are not launched from the bundle, so claim the
  // scheme explicitly; from the built app this is already true.
  app.setAsDefaultProtocolClient("hive");
  if (!launchedByDeeplink || SMOKE) createWindow();
  pendingUrls.splice(0).forEach(handleUrl);
  subscribe();
  refreshBadge();
  checkForShellUpdate();
  if (SMOKE) {
    win.webContents.once("did-finish-load", () => {
      console.log("SMOKE_OK " + win.webContents.getURL());
      setTimeout(() => app.quit(), 500);
    });
    setTimeout(() => {
      console.error("SMOKE_TIMEOUT");
      app.exit(1);
    }, 15000);
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Menu-bar-less utility semantics: keep running for notifications + badge.
  // Cmd+Q quits; closing the window just hides the board.
});
