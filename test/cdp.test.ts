// A browser can die mid-command: CDP calls must fail as soon as the socket closes, not after their timeout.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { CdpSession } from "../src/cdp.ts";

/** Smallest WebSocket server that accepts the handshake and then hands the raw socket to the test. */
function wsServer(): Promise<{ url: string; server: Server; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.push(socket as Socket);
    allSockets.push(socket as Socket);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    r({ url: `ws://127.0.0.1:${port}`, server, sockets });
  }));
}

/** The text of one client frame (masked, as the protocol requires of a client; these test messages are short). */
function frameText(buf: Buffer): string {
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) (len = buf.readUInt16BE(2)), (off = 4);
  const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < data.length; i++) data[i]! ^= buf[off + (i % 4)]!;
  return data.toString();
}

/** Send one text frame from the server (unmasked). */
function sendFrame(socket: Socket, text: string) {
  const data = Buffer.from(text);
  const head = Buffer.alloc(data.length < 126 ? 2 : 4);
  head[0] = 0x81;
  if (data.length < 126) head[1] = data.length;
  else (head[1] = 126), head.writeUInt16BE(data.length, 2);
  socket.write(Buffer.concat([head, data]));
}

const servers: Server[] = [];
const allSockets: Socket[] = [];
after(() => {
  for (const s of allSockets) s.destroy();
  for (const s of servers) s.close();
});

test("a pending command fails when the socket drops, and later ones fail at once", async () => {
  const { url, server, sockets } = await wsServer();
  servers.push(server);
  const s = await CdpSession.connect(url);
  const pending = s.send("Page.navigate", { url: "about:blank" }, 30_000);
  await new Promise((r) => setTimeout(r, 50));
  sockets[0]!.destroy(); // the browser died
  const t = Date.now();
  await assert.rejects(pending, /socket closed/);
  await s.closed;
  assert.ok(!s.open);
  await assert.rejects(s.send("Browser.close", {}, 30_000), /Browser\.close: socket closed/);
  assert.ok(Date.now() - t < 2000, "no wait for the 30s timeout");
});

test("a page exception is thrown, not returned as an undefined value", async () => {
  // Runtime.evaluate answers a throwing expression with a normal result carrying exceptionDetails. Ignoring it
  // hands the caller `undefined`, which every reader of the page treats as "the element is not there": a Figma page
  // that threw would be reported as a file with no layers rather than as a failure.
  const { url, server, sockets } = await wsServer();
  servers.push(server);
  const s = await CdpSession.connect(url);
  sockets[0]!.on("data", (buf) => {
    const msg = JSON.parse(frameText(buf));
    // A thrown Error arrives with an exception object; a syntax error only has the text.
    const exceptionDetails = msg.params.expression.includes("syntax")
      ? { text: "Uncaught SyntaxError: Unexpected end of input" }
      : { text: "Uncaught", exception: { description: "TypeError: figma is not defined" } };
    sendFrame(sockets[0]!, JSON.stringify({ id: msg.id, result: { result: { type: "undefined" }, exceptionDetails } }));
  });
  await assert.rejects(s.evaluate("figma.root.name", 5000), /TypeError: figma is not defined/);
  await assert.rejects(s.evaluate("syntax(", 5000), /Unexpected end of input/);
});

test("sending after our own close() rejects immediately", async () => {
  const { url, server } = await wsServer();
  servers.push(server);
  const s = await CdpSession.connect(url);
  s.close();
  const t = Date.now();
  await assert.rejects(s.evaluate("1", 30_000), /socket closed/);
  assert.ok(Date.now() - t < 1000);
});
