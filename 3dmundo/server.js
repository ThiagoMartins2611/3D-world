import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import http from 'http';

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const PORT = 8080;
const BROADCAST_HZ = 20;
const BROADCAST_MS = 1000 / BROADCAST_HZ;
const MAX_XZ_SPEED = 6 * 2.5;
const MAX_XZ_SPEED_SQ = MAX_XZ_SPEED * MAX_XZ_SPEED;
const MAX_POSITION_DELTA = 25;

// Chat
const CHAT_RATE_LIMIT_MS = 1500;
const CHAT_MAX_LENGTH = 200;
const NICKNAME_MAX_LEN = 20;

// Weapon anti-cheat
const BAT_MAX_DIST_SQ = 400;     // 20² metres — reject hits from further away
const BAT_MAX_FORCE = 100;      // clamp impulse magnitude

// Ant Configuration
const NUM_ANTS = 5;
const ANT_BASE_SPEED = 20;     // units/s
const ANT_SPEED_VAR = 20;
const ANT_MIN_SCALE = 0.3;
const ANT_MAX_SCALE = 1.5;
const ANT_DETECT_RANGE = 300;  // metres

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT & ENTITY STATE
// ══════════════════════════════════════════════════════════════════════════════
const antsState = [];
for (let i = 0; i < NUM_ANTS; i++) {
    antsState.push({
        id: i,
        p: { x: (Math.random() - 0.5) * 100, y: 10, z: (Math.random() - 0.5) * 100 },
        rY: Math.random() * Math.PI * 2,
        scale: ANT_MIN_SCALE + Math.random() * (ANT_MAX_SCALE - ANT_MIN_SCALE),
        speed: ANT_BASE_SPEED + (Math.random() - 0.5) * ANT_SPEED_VAR,
        v: { x: 0, y: 0, z: 0 }
    });
}

function getProceduralHeight(x, z) {
    return Math.sin(x * 0.02) * Math.cos(z * 0.02) * 8
        + Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3;
}

function makeClientState() {
    return {
        pos: { x: 0, y: 5, z: 0 },
        vel: { x: 0, y: 0, z: 0 },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        nickname: 'Player',
        lastProcessedSeq: 0,
        lastUpdateTime: Date.now(),
        lastChatTime: 0,
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// VALIDATION
// ══════════════════════════════════════════════════════════════════════════════
function validateState(current, packet) {
    const { pos, vel, rot, seq } = packet;
    if (!pos || !vel || !rot || typeof seq !== 'number') return null;

    for (const v of [pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, rot.x, rot.y, rot.z, rot.w]) {
        if (!Number.isFinite(v)) return null;
    }
    if (seq <= current.lastProcessedSeq) return null;

    const xzSpeedSq = vel.x * vel.x + vel.z * vel.z;
    let vx = vel.x, vz = vel.z;
    if (xzSpeedSq > MAX_XZ_SPEED_SQ) {
        const scale = MAX_XZ_SPEED / Math.sqrt(xzSpeedSq);
        vx *= scale; vz *= scale;
    }

    const dx = pos.x - current.pos.x;
    const dz = pos.z - current.pos.z;
    const xzDist = Math.sqrt(dx * dx + dz * dz);
    let px = pos.x, py = pos.y, pz = pos.z;
    if (xzDist > MAX_POSITION_DELTA) {
        const ratio = MAX_POSITION_DELTA / xzDist;
        px = current.pos.x + dx * ratio;
        pz = current.pos.z + dz * ratio;
    }
    py = Math.max(py, -200);

    return {
        pos: { x: px, y: py, z: pz },
        vel: { x: vx, y: vel.y, z: vz },
        rot: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
    };
}

function sanitiseNickname(raw) {
    if (typeof raw !== 'string') return 'Player';
    return raw.replace(/[<>&"']/g, '').trim().slice(0, NICKNAME_MAX_LEN) || 'Player';
}

function clampDir(dir) {
    if (!dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z)) return null;
    const mag = Math.sqrt(dir.x ** 2 + dir.y ** 2 + dir.z ** 2);
    if (mag === 0) return null;
    if (mag > BAT_MAX_FORCE) {
        const s = BAT_MAX_FORCE / mag;
        return { x: dir.x * s, y: dir.y * s, z: dir.z * s };
    }
    return { x: dir.x, y: dir.y, z: dir.z };
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER
// ══════════════════════════════════════════════════════════════════════════════
const clients = new Map();

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Multiplayer server running\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    const id = uuidv4();
    const state = makeClientState();
    clients.set(id, { ws, state });

    console.log(`✓ [${id.slice(0, 8)}] connected — online: ${clients.size}`);

    // Handshake
    ws.send(JSON.stringify({ type: 'init', clientId: id, serverTime: Date.now() }));

    // Send existing players to new client
    for (const [existingId, { state: es }] of clients) {
        if (existingId === id) continue;
        ws.send(JSON.stringify({
            type: 'world_state', t: Date.now(), initial: true,
            states: {
                [existingId]: { p: es.pos, v: es.vel, r: es.rot, s: es.lastProcessedSeq, n: es.nickname },
            },
        }));
    }

    // ── All incoming messages ─────────────────────────────────────────────────
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            const client = clients.get(id);
            if (!client) return;

            // ── Physics state update ──────────────────────────────────────────
            if (msg.type === 'state') {
                const validated = validateState(client.state, msg);
                if (!validated) return;
                client.state.pos = validated.pos;
                client.state.vel = validated.vel;
                client.state.rot = validated.rot;
                client.state.lastProcessedSeq = msg.seq;
                client.state.lastUpdateTime = Date.now();
            }

            // ── Nickname change ───────────────────────────────────────────────
            else if (msg.type === 'set_nickname') {
                const clean = sanitiseNickname(msg.nickname);
                client.state.nickname = clean;
                broadcastAll({ type: 'player_info', clientId: id, nickname: clean }, null);
                console.log(`[${id.slice(0, 8)}] nickname → "${clean}"`);
            }

            // ── Chat ──────────────────────────────────────────────────────────
            else if (msg.type === 'chat') {
                const now = Date.now();
                if (now - client.state.lastChatTime < CHAT_RATE_LIMIT_MS) return;
                client.state.lastChatTime = now;
                const text = typeof msg.message === 'string'
                    ? msg.message.replace(/[<>&"']/g, '').trim().slice(0, CHAT_MAX_LENGTH)
                    : '';
                if (!text) return;
                broadcastAll({ type: 'chat', clientId: id, nickname: client.state.nickname, message: text, t: now }, null);
                console.log(`[${id.slice(0, 8)}] <${client.state.nickname}>: ${text}`);
            }

            // ── Bat hit ───────────────────────────────────────────────────────
            // Attacker reports a hit on targetId with a direction vector.
            // Server validates proximity and force, then relays to the target.
            // A swing_event is broadcast to all so everyone plays the bat animation.
            else if (msg.type === 'bat_hit') {
                const { targetId, dir } = msg;
                if (!targetId) return;

                const target = clients.get(targetId);
                if (!target || target.ws.readyState !== WebSocket.OPEN) return;

                // Proximity anti-cheat: attacker must be within 20 metres of target
                const dx = client.state.pos.x - target.state.pos.x;
                const dz = client.state.pos.z - target.state.pos.z;
                const distSq = dx * dx + dz * dz;
                if (distSq > BAT_MAX_DIST_SQ) return;

                const safeDir = clampDir(dir);
                if (!safeDir) return;

                // Forward the hit to the target player only
                target.ws.send(JSON.stringify({
                    type: 'bat_hit',
                    fromId: id,
                    fromNickname: client.state.nickname,
                    dir: safeDir,
                }));

                // Tell everyone (including attacker) to play the swing animation
                broadcastAll({ type: 'swing_event', fromId: id }, null);

                console.log(`[${id.slice(0, 8)}] bat_hit → [${targetId.slice(0, 8)}]`);
            }

            // ── Eliminated (player fell off map) ─────────────────────────────
            // Client tells the server it died; server broadcasts the kill feed.
            else if (msg.type === 'eliminated') {
                const killerNickname = typeof msg.killerNickname === 'string'
                    ? msg.killerNickname.replace(/[<>&"']/g, '').trim().slice(0, 30)
                    : null;

                broadcastAll({
                    type: 'kill_feed',
                    killedId: id,
                    killedNickname: client.state.nickname,
                    killerNickname: killerNickname || null,
                }, null);

                console.log(`[${id.slice(0, 8)}] eliminated by ${killerNickname || 'fall'}`);
            }

            // ── Ant hit ───────────────────────────────────────────────────────
            else if (msg.type === 'ant_hit') {
                const { antId, dir } = msg;
                const ant = antsState.find(a => a.id === antId);
                if (!ant) return;

                // Simple proximity check: attacker must be within range of ant
                const dx = client.state.pos.x - ant.p.x;
                const dz = client.state.pos.z - ant.p.z;
                const distSq = dx * dx + dz * dz;
                if (distSq > BAT_MAX_DIST_SQ) return;

                const safeDir = clampDir(dir);
                if (!safeDir) return;

                // Apply knockback to ant
                ant.v.x += safeDir.x * 2; // Ants are lighter?
                ant.v.z += safeDir.z * 2;
                ant.v.y += safeDir.y * 2;

                // Everyone plays swing animation
                broadcastAll({ type: 'swing_event', fromId: id }, null);
                console.log(`[${id.slice(0, 8)}] ant_hit → ant ${antId}`);
            }

        } catch { /* ignore malformed JSON */ }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    ws.on('close', () => {
        clients.delete(id);
        console.log(`✗ [${id.slice(0, 8)}] disconnected — online: ${clients.size}`);
        broadcastAll({ type: 'disconnect', clientId: id }, null);
    });

    ws.on('error', (err) => console.error(`[${id.slice(0, 8)}] error: ${err.message}`));
});

// ══════════════════════════════════════════════════════════════════════════════
// BROADCAST LOOP — 20 Hz
// ══════════════════════════════════════════════════════════════════════════════
let lastLoopTime = Date.now();

setInterval(() => {
    const now = Date.now();
    const dt = (now - lastLoopTime) / 1000.0;
    lastLoopTime = now;

    if (clients.size > 0) {
        // --- Ants AI ---
        for (const ant of antsState) {
            let nearestP = null;
            let nearestDist = Infinity;

            for (const [cid, { state }] of clients) {
                const dx = state.pos.x - ant.p.x;
                const dy = state.pos.y - ant.p.y;
                const dz = state.pos.z - ant.p.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (dist < ANT_DETECT_RANGE && dist < nearestDist) {
                    nearestP = state.pos;
                    nearestDist = dist;
                }
            }

            if (nearestP) {
                const dx = nearestP.x - ant.p.x;
                const dz = nearestP.z - ant.p.z;
                const len = Math.sqrt(dx * dx + dz * dz);

                if (len > 0.5) {
                    const step = ant.speed * dt;
                    const actualStep = Math.min(step, len - 0.5); // prevent overshoot
                    if (actualStep > 0) {
                        ant.p.x += (dx / len) * actualStep;
                        ant.p.z += (dz / len) * actualStep;
                        ant.rY = Math.atan2(dx / len, dz / len);
                    }
                }
            }

            // Apply and decay velocity (knockback)
            ant.p.x += ant.v.x * dt;
            ant.p.y += ant.v.y * dt;
            ant.p.z += ant.v.z * dt;

            ant.v.x *= Math.pow(0.1, dt); // fast decay
            ant.v.y *= Math.pow(0.1, dt);
            ant.v.z *= Math.pow(0.1, dt);

            if (Math.abs(ant.v.y) > 0.1) ant.v.y -= 9.81 * 2 * dt; // extra gravity for ants when launched

            // Stick to terrain (adjusted slightly by scale to prevent clipping)
            const terrainY = getProceduralHeight(ant.p.x, ant.p.z) + (3 * ant.scale);
            if (ant.p.y < terrainY) {
                ant.p.y = terrainY;
                ant.v.y = 0;
            }
        }

        // --- Broadcast ---
        const states = {};
        for (const [cid, { state }] of clients) {
            states[cid] = { p: state.pos, v: state.vel, r: state.rot, s: state.lastProcessedSeq, n: state.nickname };
        }
        broadcastAll({ type: 'world_state', t: now, states, ants: antsState }, null);
    }
}, BROADCAST_MS);


// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function broadcastAll(payload, excludeId) {
    const msg = JSON.stringify(payload);
    for (const [cid, { ws }] of clients) {
        if (cid !== excludeId && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
httpServer.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║   🚀  Multiplayer Server Active        ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  Port      : ${PORT}                     ║`);
    console.log(`║  Broadcast : ${BROADCAST_HZ} Hz                   ║`);
    console.log(`║  Chat rate : ${CHAT_RATE_LIMIT_MS}ms                 ║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');
});

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    wss.close(() => { console.log('Done.'); process.exit(0); });
});