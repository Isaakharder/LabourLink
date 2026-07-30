interface QueuedAction {
  id: string; // = the action's own idempotencyKey
  path: string;
  body: unknown;
}

const QUEUE_KEY = "labourlink_pending_actions";

function readQueue(): QueuedAction[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedAction[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function getPendingCount(): number {
  return readQueue().length;
}

export function enqueue(action: QueuedAction): void {
  writeQueue([...readQueue(), action]);
}

function dequeue(id: string): void {
  writeQueue(readQueue().filter((a) => a.id !== id));
}

// A network-layer failure (offline, connection refused, DNS) vs. a real
// HTTP response — only the former is safe to blindly retry. An HTTP 4xx
// means the server already understood and rejected the request; retrying it
// unchanged would just repeat the same rejection forever.
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

// Replays queued actions in order using the same idempotencyKey each one
// was created with, so a request that actually succeeded server-side before
// the network dropped doesn't get duplicated on retry. Stops at the first
// still-offline failure and leaves the remainder queued for next time.
export async function flushQueue(
  send: (path: string, body: unknown) => Promise<unknown>
): Promise<void> {
  for (const action of readQueue()) {
    try {
      await send(action.path, action.body);
      dequeue(action.id);
    } catch (err) {
      if (isNetworkError(err)) return;
      dequeue(action.id); // server rejected it even on retry — drop rather than loop forever
    }
  }
}
