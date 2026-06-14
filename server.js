// Zero-dependency static file server for Jurassic Survival: Island Alpha.
// Serves the game's static files (HTML/ES-modules/JSON/images) over HTTP so
// that ES module imports and fetch() work (they do not over file://).
// Railway provides PORT; default to 8080 for local runs.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = process.env.PORT || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".wasm": "application/wasm",
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";

    // Resolve within ROOT and block path traversal.
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }

    const body = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": /\.(html|js|mjs|json)$/.test(filePath) ? "no-cache" : "public, max-age=3600",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end("Server error");
  }
});

/* ===================================================================== *
 *  Zero-dependency WebSocket co-op relay (RFC 6455, hand-rolled).        *
 *  Purely additive: static serving above is untouched. Clients connect   *
 *  to /ws, join a room by code, and the server relays player state +     *
 *  (host-authoritative) dino snapshots to everyone else in the room.     *
 * ===================================================================== */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const rooms = new Map();   // code -> { clients:Set<socket>, hostId:number|null, seed:number }
let nextId = 1;

function wsSend(socket, obj) {
  if (socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(obj));
  const len = data.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  try { socket.write(Buffer.concat([header, data])); } catch { /* dead socket */ }
}
function roomBroadcast(room, except, obj) { for (const c of room.clients) if (c !== except) wsSend(c, obj); }

function wsClose(socket) {
  const mp = socket._mp; socket._mp = null;
  if (!mp) return;
  const room = rooms.get(mp.room);
  if (!room) return;
  room.clients.delete(socket);
  roomBroadcast(room, null, { t: "peer-leave", id: mp.id });
  if (room.hostId === mp.id) {                       // promote a new host
    const next = [...room.clients][0];
    room.hostId = next ? next._mp.id : null;
    if (next) roomBroadcast(room, null, { t: "host", id: room.hostId });
  }
  if (room.clients.size === 0) rooms.delete(mp.room);
}

function wsMessage(socket, text) {
  let m; try { m = JSON.parse(text); } catch { return; }
  if (m.t === "join") {
    const code = String(m.room || "ALPHA").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "ALPHA";
    let room = rooms.get(code);
    if (!room) room = (rooms.set(code, { clients: new Set(), hostId: null, seed: (m.seed | 0) || 1, mission: "" }), rooms.get(code));
    if (room.clients.size >= 16) { wsSend(socket, { t: "full" }); return; }
    socket._mp = { id: nextId++, room: code, name: String(m.name || "PLAYER").slice(0, 16), role: String(m.role || "navigator").slice(0, 16) };
    if (room.hostId == null) { room.hostId = socket._mp.id; if (m.seed) room.seed = m.seed | 0; if (m.mission) room.mission = String(m.mission).slice(0, 24); }   // host seeds world + mission
    room.clients.add(socket);
    wsSend(socket, {
      t: "welcome", id: socket._mp.id, host: room.hostId === socket._mp.id, hostId: room.hostId, seed: room.seed, mission: room.mission, room: code,
      peers: [...room.clients].filter(c => c !== socket && c._mp).map(c => ({ id: c._mp.id, name: c._mp.name, role: c._mp.role })),
    });
    roomBroadcast(room, socket, { t: "peer-join", id: socket._mp.id, name: socket._mp.name, role: socket._mp.role });
    return;
  }
  if (!socket._mp) return;
  const room = rooms.get(socket._mp.room);
  if (!room) return;
  if (m.t === "state") roomBroadcast(room, socket, { t: "state", id: socket._mp.id, p: m.p });       // player snapshot
  else if (m.t === "dinos" && room.hostId === socket._mp.id) roomBroadcast(room, socket, m);          // host only
  else if (m.t === "exfil" && room.hostId === socket._mp.id) roomBroadcast(room, socket, m);          // host only
  else if (m.t === "say") roomBroadcast(room, socket, { t: "say", id: socket._mp.id, msg: String(m.msg || "").slice(0, 80) });
}

function decodeFrames(socket) {
  let buf = socket._buf;
  while (buf.length >= 2) {
    const op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f, offset = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
    let mask;
    if (masked) { if (buf.length < offset + 4) break; mask = buf.subarray(offset, offset + 4); offset += 4; }
    if (buf.length < offset + len) break;            // wait for the rest of the payload
    let payload = buf.subarray(offset, offset + len);
    if (masked) { const out = Buffer.allocUnsafe(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
    buf = buf.subarray(offset + len);
    if (op === 0x8) { try { socket.end(); } catch {} wsClose(socket); return; }      // close
    else if (op === 0x9) { try { socket.write(Buffer.from([0x8a, 0])); } catch {} }  // ping -> pong
    else if (op === 0x1 || op === 0x2) wsMessage(socket, payload.toString("utf8")); // text/binary
  }
  socket._buf = buf;
}

server.on("upgrade", (req, socket) => {
  if (!String(req.url || "").startsWith("/ws")) { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.setNoDelay(true);
  socket._buf = Buffer.alloc(0);
  socket.on("data", (chunk) => { socket._buf = Buffer.concat([socket._buf, chunk]); try { decodeFrames(socket); } catch { wsClose(socket); socket.destroy(); } });
  socket.on("close", () => wsClose(socket));
  socket.on("error", () => wsClose(socket));
});

server.listen(PORT, () => {
  console.log(`Jurassic Survival serving on :${PORT}`);
});
