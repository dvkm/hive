// hive desktop app: a native window onto the local hive server, plus what a
// browser tab can't do — native macOS notifications from the server's
// notification stream and a dock badge counting open decisions + checkpoints.
// The server itself stays the LaunchAgent (dev.hive.server); this app is a
// client only and reconnects politely when the daemon is down.
const { app, BrowserWindow, Notification, shell } = require("electron");
const http = require("node:http");

const BASE = process.env.HIVE_URL || "http://127.0.0.1:4700";
const SMOKE = !!process.env.HIVE_SMOKE; // load, print ok, quit — used by CI/verification

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1c1c1e",
    webPreferences: { contextIsolation: true },
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
  win.show();
  win.loadURL(BASE + path).catch(() => {});
}

// ---- native notifications from the server's SSE stream ----
// The server already decides what deserves attention (decisions, blocked
// agents, failures, incidents — enqueue() in notifications.ts) and broadcasts
// each as {type:"notification"}. We surface exactly those natively.
function subscribe() {
  const req = http.get(BASE + "/api/stream", { headers: { Accept: "text/event-stream" } }, (res) => {
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
  if (msg.type === "notification" && msg.notification) {
    const n = msg.notification;
    const note = new Notification({
      title: n.title || "hive",
      body: n.body || "",
      silent: n.urgency !== "urgent",
    });
    note.on("click", () => goto(n.decision_id ? "/decisions" : n.task_id ? `/tasks/${n.task_id}` : "/"));
    note.show();
  }
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

app.whenReady().then(() => {
  createWindow();
  subscribe();
  refreshBadge();
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
