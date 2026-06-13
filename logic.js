// Jurassic Survival: Island Alpha — solo vertical slice.
// Single-player: all simulation is client-side in index.html. The platform
// requires a root code module, so this is the canonical solo stub.
// TODO v2: promote to server.js (DurableObject) for authoritative 4-player co-op.
export const meta = { game: "jurassic-survival-island-alpha", minPlayers: 1, maxPlayers: 1 };
export function setup() { return {}; }
export function validateAction() { return { ok: true }; }
export function applyAction(state) { return state; }
export function isGameOver() { return { over: false }; }
export function viewFor(state) { return state; }
