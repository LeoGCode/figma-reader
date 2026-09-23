// Minimal Chrome DevTools Protocol client over the built-in WebSocket (Node 22+).
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
type Listener = (params: any) => void;

export class CdpSession {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Listener>>();

  private ws: WebSocket;
  /** Settles when the socket closes (the browser or tab went away): long waits race it instead of timing out. */
  readonly closed: Promise<void>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    let onClosed!: () => void;
    this.closed = new Promise((r) => (onClosed = r));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners.get(msg.method) ?? []) l(msg.params);
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("CDP socket closed"));
      this.pending.clear();
      onClosed();
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot open CDP socket ${wsUrl}`)), { once: true });
    });
    return new CdpSession(ws);
  }

  get open() {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    // A message sent on a closing or closed socket is silently dropped and would only fail at the timeout.
    if (!this.open) return Promise.reject(new Error(`CDP ${method}: socket closed`));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Evaluate an expression in the page; returns the JSON value or throws the page exception. */
  async evaluate<T = any>(expression: string, timeoutMs = 60_000): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "page exception");
    }
    return r.result?.value as T;
  }

  async key(key: string, code: string, keyCode: number, modifiers = 0) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  close() {
    this.ws.close();
  }
}

export interface TargetInfo {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
