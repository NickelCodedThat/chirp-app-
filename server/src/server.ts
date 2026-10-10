import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Connection, Hub } from "./hub.ts";
import type { ServerMessage } from "./protocol.ts";

// WebSocket transport for the Hub. Control messages are text, audio is binary.
// Kept deliberately thin: all behavior lives in the Hub.

export type LabServer = {
  readonly port: number;
  close(): Promise<void>;
};

export type LabServerOptions = {
  hub: Hub;
  host: string;
  port: number;
  authTimeoutMs?: number;
  tickMs?: number;
};

class WsConnection implements Connection {
  readonly id = randomUUID();
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
  }
  send(msg: ServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
  sendBinary(wire: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(wire, { binary: true });
  }
  close(): void {
    // Give the final message a moment to flush before closing.
    setTimeout(() => this.ws.close(), 10).unref();
  }
}

export async function startLabServer(opts: LabServerOptions): Promise<LabServer> {
  const { hub } = opts;
  const wss = new WebSocketServer({ host: opts.host, port: opts.port, maxPayload: 4_096 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  wss.on("connection", (ws) => {
    const conn = new WsConnection(ws);
    hub.onOpen(conn);
    const authTimer = setTimeout(() => {
      if (!hub.isAuthed(conn)) ws.close();
    }, opts.authTimeoutMs ?? 5_000);
    ws.on("message", (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (isBinary) hub.onBinary(conn, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      else hub.onText(conn, buf.toString("utf8"));
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      hub.onClose(conn);
    });
    ws.on("error", () => ws.close());
  });

  const timer = setInterval(() => hub.tick(), opts.tickMs ?? 100);
  timer.unref();

  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    port,
    async close() {
      clearInterval(timer);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
