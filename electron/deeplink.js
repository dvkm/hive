// hive:// URL routing, kept out of main.js so it can be checked without Electron.
//   hive://task/1247          a task by number or id
//   hive://decision/dec_abc   the decision card, scrolled to and highlighted
//   hive://quiz/<task-id>     the understanding check on that task
//   hive://open?path=/inbox   any app route, escape hatch
// Returns the app route to load, or null when the URL is not one of ours.
function routeFor(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "hive:") return null;
  const arg = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (url.hostname === "task" && arg) return `/tasks/${arg}`;
  if (url.hostname === "decision" && arg) return `/decisions#dcard-${arg}`;
  // The understanding check renders on the task page.
  if (url.hostname === "quiz" && arg) return `/tasks/${arg}`;
  if (url.hostname === "open") {
    const path = url.searchParams.get("path") || "/";
    return path.startsWith("/") ? path : "/";
  }
  return null;
}

module.exports = { routeFor };

// node electron/deeplink.js — self-check.
if (require.main === module) {
  const assert = require("node:assert");
  assert.equal(routeFor("hive://task/1247"), "/tasks/1247");
  assert.equal(routeFor("hive://task/1b75826af9fb"), "/tasks/1b75826af9fb");
  assert.equal(routeFor("hive://decision/dec_ab12"), "/decisions#dcard-dec_ab12");
  assert.equal(routeFor("hive://quiz/1b75826af9fb"), "/tasks/1b75826af9fb");
  assert.equal(routeFor("hive://open?path=/inbox"), "/inbox");
  assert.equal(routeFor("hive://open"), "/");
  // an absolute URL smuggled into path must not escape the app
  assert.equal(routeFor("hive://open?path=https://evil.example"), "/");
  assert.equal(routeFor("hive://task/"), null);
  assert.equal(routeFor("hive://nope/1"), null);
  assert.equal(routeFor("https://example.com/tasks/1"), null);
  assert.equal(routeFor("not a url"), null);
  console.log("deeplink routing ok");
}
