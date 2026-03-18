import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import http from 'http';

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const PORT           = 8080;
const BROADCAST_HZ   = 20;
const BROADCAST_MS   = 1000 / BROADCAST_HZ;
const MAX_XZ_SPEED   = 6 * 2.5;
const MAX_XZ_SPEED_SQ = MAX_XZ_SPEED * MAX_XZ_SPEED;
const MAX_POSITION_DELTA = 25;

// Chat
const CHAT_RATE_LIMIT_MS = 1500; // min ms between messages per client
const CHAT_MAX_LENGTH    = 200;  // max characters per message
const NICKNAME_MAX_LEN   = 20;

// ══════════════════════════════════════════════════════════════════════════════
// CLIENT STATE
// ══════════════════════════════════════════════════════════════════════════════
function makeClientState() {
    return {
        pos:              { x: 0, y: 5, z: 0 },
        vel:              { x: 0, y: 0, z: 0 },
        rot:              { x: 0, y: 0, z: 0, w: 1 },
        nickname:         'Player',
        lastProcessedSeq: 0,
        lastUpdateTime:   Date.now(),
        lastChatTime:     0,  // ← lives here, not on a separate handler
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

    // Clamp XZ speed
    const xzSpeedSq = vel.x * vel.x + vel.z * vel.z;
    let vx = vel.x, vz = vel.z;
    if (xzSpeedSq > MAX_XZ_SPEED_SQ) {
        const scale = MAX_XZ_SPEED / Math.sqrt(xzSpeedSq);
        vx *= scale;
        vz *= scale;
    }

    // Clamp position delta
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
    // Strip HTML and trim
    return raw.replace(/[<>&"']/g, '').trim().slice(0, NICKNAME_MAX_LEN) || 'Player';
}

// ══════════════════════════════════════════════════════════════════════════════
// SERVER — single wss.on('connection') handler
// ══════════════════════════════════════════════════════════════════════════════
const clients = new Map();

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Multiplayer server running\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    const id    = uuidv4();
    const state = makeClientState();
    clients.set(id, { ws, state });

    console.log(`✓ [${id.slice(0, 8)}] connected — online: ${clients.size}`);

    // ── Handshake ────────────────────────────────────────────────────────────
    ws.send(JSON.stringify({
        type:       'init',
        clientId:   id,
        serverTime: Date.now(),
    }));

    // Tell new client about everyone already online (position + nickname)
    for (const [existingId, { state: es }] of clients) {
        if (existingId === id) continue;
        ws.send(JSON.stringify({
            type:    'world_state',
            t:       Date.now(),
            initial: true,
            states: {
                [existingId]: {
                    p: es.pos, v: es.vel, r: es.rot,
                    s: es.lastProcessedSeq,
                    n: es.nickname,  // nickname included from the start
                }
            },
        }));
    }

    // ── All incoming messages — ONE handler ──────────────────────────────────
    ws.on('message', (raw) => {
        try {
            const msg    = JSON.parse(raw);
            const client = clients.get(id);
            if (!client) return;

            // ── Physics state update ──────────────────────────────────────────
            if (msg.type === 'state') {
                const validated = validateState(client.state, msg);
                if (!validated) return;
                client.state.pos              = validated.pos;
                client.state.vel              = validated.vel;
                client.state.rot              = validated.rot;
                client.state.lastProcessedSeq = msg.seq;
                client.state.lastUpdateTime   = Date.now();
            }

            // ── Nickname change ───────────────────────────────────────────────
            else if (msg.type === 'set_nickname') {
                const clean = sanitiseNickname(msg.nickname);
                client.state.nickname = clean;
                // Tell everyone (including sender) about the name change
                broadcastAll({
                    type:     'player_info',
                    clientId: id,
                    nickname: clean,
                }, null);
                console.log(`[${id.slice(0, 8)}] nickname → "${clean}"`);
            }

            // ── Chat message ──────────────────────────────────────────────────
            else if (msg.type === 'chat') {
                const now = Date.now();
                // Rate-limit: ignore if sending too fast
                if (now - client.state.lastChatTime < CHAT_RATE_LIMIT_MS) return;
                client.state.lastChatTime = now;

                const text = typeof msg.message === 'string'
                    ? msg.message.replace(/[<>&"']/g, '').trim().slice(0, CHAT_MAX_LENGTH)
                    : '';
                if (!text) return;

                broadcastAll({
                    type:     'chat',
                    clientId: id,
                    nickname: client.state.nickname,
                    message:  text,
                    t:        now,
                }, null); // broadcast to EVERYONE including sender (echo)

                console.log(`[${id.slice(0, 8)}] <${client.state.nickname}>: ${text}`);
            }

        } catch { /* ignore malformed JSON */ }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    ws.on('close', () => {
        clients.delete(id);
        console.log(`✗ [${id.slice(0, 8)}] disconnected — online: ${clients.size}`);
        broadcastAll({ type: 'disconnect', clientId: id }, null);
    });

    ws.on('error', (err) => {
        console.error(`[${id.slice(0, 8)}] error: ${err.message}`);
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// BROADCAST LOOP — 20 Hz world state
// Includes nickname (n) in every state entry so clients always have it.
// ══════════════════════════════════════════════════════════════════════════════
setInterval(() => {
    if (clients.size === 0) return;

    const t      = Date.now();
    const states = {};

    for (const [cid, { state }] of clients) {
        states[cid] = {
            p: state.pos,
            v: state.vel,
            r: state.rot,
            s: state.lastProcessedSeq,
            n: state.nickname,           // ← always broadcast the nickname
        };
    }

    broadcastAll({ type: 'world_state', t, states }, null);

}, BROADCAST_MS);

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function broadcastAll(payload, excludeId) {
    const msg = JSON.stringify(payload);
    for (const [cid, { ws }] of clients) {
        if (cid !== excludeId && ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════════════════
httpServer.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║   🚀  Multiplayer Server Active       ║');
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