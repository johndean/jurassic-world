# Jurassic Survival: Island Alpha

A browser-based dinosaur survival game. Pure static front end — Three.js (vendored),
ES modules, and JSON data loaded at runtime. No build step.

## Run locally

The game uses ES module imports and `fetch()`, so it must be served over HTTP
(not opened as a `file://` URL):

```bash
npm start
# then open http://localhost:8080
```

`server.js` is a zero-dependency Node static server (uses `process.env.PORT`).

## Deploy on Railway

This repo is Railway-ready:

- `railway.json` pins the start command (`node server.js`) and a `/` health check.
- `package.json` exposes `npm start` and requires Node 18+.

Railway will detect Node, install (no dependencies), and run `node server.js`,
binding to the injected `PORT`. Add a public domain in the Railway service
settings to get a live URL.

## Structure

```
index.html        # entry point + HUD
game.js           # game logic / Three.js scene
logic.js          # game-state stubs
strings.js        # UI copy
vendor/           # vendored three.module.js
data/             # species + biome JSON
assets/           # model assets
favicon.jpg       # full-body T-Rex icon
server.js         # static file server
```
