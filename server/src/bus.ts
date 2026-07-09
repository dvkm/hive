// Minimal in-process pub/sub for SSE. Every event / state change / decision
// update is broadcast here; the /api/stream endpoint fans it out to clients.
type Client = { id: string; send: (data: string) => void };

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
