// Pure version-compare helper for the shell self-update banner, kept out of
// Electron so it's testable with plain `node` (see deeplink.js for the pattern).
function shouldUpdate(currentVersion, remoteVersion) {
  return !!remoteVersion && remoteVersion !== currentVersion;
}

module.exports = { shouldUpdate };

// node electron/versionCheck.js — self-check.
if (require.main === module) {
  const assert = require("node:assert");
  assert.equal(shouldUpdate("0.1.0", "0.1.0"), false);
  assert.equal(shouldUpdate("0.1.0", "0.2.0"), true);
  assert.equal(shouldUpdate("0.1.0", null), false);
  assert.equal(shouldUpdate("0.1.0", undefined), false);
  assert.equal(shouldUpdate("0.1.0", ""), false);
  console.log("version-compare ok");
}
