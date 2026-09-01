// Stand-in for a test run that gets cut short. Spawns a real hive server through
// spawnGuarded, announces the pid, then hangs forever waiting to be killed. The
// server's own stdout is inherited, so whoever runs this sees the "[hive] server
// on http://..." line and can read the port it bound.
import { spawnGuarded } from "../spawnGuarded.ts";

const entry = new URL("../../src/index.ts", import.meta.url).pathname;
const { proc } = spawnGuarded([process.execPath, "run", entry], {
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});
console.log(`SERVER_PID ${proc.pid}`);
await new Promise(() => {}); // never resolves: only a kill ends this runner
