// Minimal co-op networking client for Jurassic Survival: Island Alpha.
// Talks to the zero-dependency WebSocket relay in server.js. Keeps a peer table and
// fires lightweight events the game wires into (lobby UI + remote avatar rendering).
// Purely opt-in: nothing here runs unless the player chooses Host/Join.
export const Net = {
  ws: null,
  on: false,            // connected + welcomed
  id: 0,
  isHost: false,
  room: "",
  seed: 1,
  mission: "",
  name: "PLAYER",
  role: "navigator",
  peers: new Map(),     // id -> { name, role, x, z, yaw, gait, hp, alive, _t }
  _h: {},               // event -> handler

  onEvent(ev, fn) { this._h[ev] = fn; },
  _emit(ev, d) { const f = this._h[ev]; if (f) try { f(d); } catch (e) { console.warn("net handler", ev, e); } },

  connect(room, name, role, seed, mission) {
    this.disconnect();
    this.name = name; this.role = role;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try { ws = new WebSocket(`${proto}//${location.host}/ws`); }
    catch (e) { this._emit("error", e); return; }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", room, name, role, seed, mission: mission || "" }));
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this._recv(m); };
    ws.onclose = () => { this.on = false; this._emit("close"); };
    ws.onerror = () => { this._emit("error"); };
  },

  _recv(m) {
    switch (m.t) {
      case "welcome":
        this.on = true; this.id = m.id; this.isHost = !!m.host; this.room = m.room; this.seed = m.seed; this.mission = m.mission || "";
        this.peers.clear();
        (m.peers || []).forEach(p => this.peers.set(p.id, { name: p.name, role: p.role }));
        this._emit("welcome", m); break;
      case "peer-join": this.peers.set(m.id, { name: m.name, role: m.role }); this._emit("peers"); break;
      case "peer-leave": this.peers.delete(m.id); this._emit("leave", m.id); this._emit("peers"); break;
      case "state": { const p = this.peers.get(m.id); if (p) { Object.assign(p, m.p); p._t = performance.now(); } this._emit("state", m); break; }
      case "host": this.isHost = (m.id === this.id); this._emit("peers"); break;
      case "dinos": this._emit("dinos", m); break;
      case "exfil": this._emit("exfil", m); break;
      case "full": this._emit("full"); break;
    }
  },

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); },
  sendState(p) { this.send({ t: "state", p }); },

  disconnect() { try { this.ws && this.ws.close(); } catch {} this.ws = null; this.on = false; this.peers.clear(); },
};
