// hive daemon entrypoint. Bun.serve on 127.0.0.1:4700 (override HIVE_PORT).
import { openDb, defaultDbPath } from "./db.ts";
import { makeHandler } from "./api.ts";

const port = Number(process.env.HIVE_PORT || 4700);
const dbPath = defaultDbPath();
const db = openDb(dbPath);
const handle = makeHandler(db);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0, // keep SSE connections open
  fetch: handle,
});

console.log(`[hive] server on http://${server.hostname}:${server.port}  db=${dbPath}`);
