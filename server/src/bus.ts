// Minimal in-process pub/sub for SSE. Every event / state change / decision
// update is broadcast here; the /api/stream endpoint fans it out to clients.
// `app: true` marks the Electron desktop client (it subscribes with
// /api/stream?client=app). Notification delivery needs to tell it apart from
// browser tabs: a tab cannot raise a native macOS notification.
type Client = { id: string; send: (data: string) => void; app?: boolean };

const clients = new Set<Client>();

export function addClient(c: Client): void {
  clients.add(c);
}

export function removeClient(c: Client): void {
  clients.delete(c);
}

export function clientCount(): number {
  return clients.size;
}

// How many desktop app clients are attached. Zero means nothing can render a
// native notification right now, so delivery falls back to launching the app.
export function appClientCount(): number {
  let n = 0;
  for (const c of clients) if (c.app) n++;
  return n;
}

// msg is a plain object; it is JSON-encoded once and pushed to every client.
export function broadcast(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    try {
      c.send(data);
    } catch {
      clients.delete(c);
    }
  }
}
