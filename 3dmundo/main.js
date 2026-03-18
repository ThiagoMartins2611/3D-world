import * as BABYLON from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';

// ══════════════════════════════════════════════════════════════════════════════
// NETWORK CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const INTERPOLATION_DELAY_MS = 100;
const RECONCILE_EPS_XZ       = 0.4;
const MAX_SNAPSHOTS          = 40;
const PREDICTION_BUFFER_SIZE = 128;

const IMPULSE_FORCE       = 14;
const IMPULSE_Y           = 6;
const IMPULSE_COOLDOWN_MS = 300;

// Max chat messages kept visible in the DOM
const CHAT_MAX_VISIBLE = 40;

// ══════════════════════════════════════════════════════════════════════════════
// NICKNAME OVERLAY
// Blocks the game until the player confirms a nickname.
// ══════════════════════════════════════════════════════════════════════════════
let localNickname = 'Player';

function waitForNickname() {
    return new Promise((resolve) => {
        const overlay   = document.getElementById('nickname-overlay');
        const input     = document.getElementById('nickname-input-field');
        const btnOk     = document.getElementById('nickname-confirm-btn');

        function confirm() {
            const raw = input.value.replace(/[<>&"']/g, '').trim();
            localNickname = raw.slice(0, 20) || 'Player';
            overlay.classList.add('hidden');
            resolve(localNickname);
        }

        btnOk.addEventListener('click', confirm);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirm();
        });

        // Focus the field immediately
        input.focus();
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAT UI HELPERS
// ══════════════════════════════════════════════════════════════════════════════
const chatList  = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');

// clientId of self — set after handshake, used to style own messages
let _selfId = null;

function appendChatMessage({ nickname, message, clientId, isSystem = false }) {
    const li = document.createElement('li');

    if (isSystem) {
        li.classList.add('sys');
        li.textContent = message;
    } else {
        const nick = document.createElement('span');
        nick.classList.add('chat-nick');
        nick.classList.add(clientId === _selfId ? 'is-self' : 'is-other');
        nick.textContent = `${nickname}:`;
        const text = document.createTextNode(` ${message}`);
        li.appendChild(nick);
        li.appendChild(text);
    }

    chatList.appendChild(li);

    // Prune old messages
    while (chatList.children.length > CHAT_MAX_VISIBLE) {
        chatList.removeChild(chatList.firstChild);
    }

    // Auto-scroll to bottom
    chatList.scrollTop = chatList.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════════════════
// CROSSHAIR
// ══════════════════════════════════════════════════════════════════════════════
const crosshair = document.createElement('div');
Object.assign(crosshair.style, {
    position: 'absolute', top: '50%', left: '50%',
    width: '8px', height: '8px', backgroundColor: 'red',
    transform: 'translate(-50%, -50%)', borderRadius: '50%',
    pointerEvents: 'none', zIndex: '1000',
});
document.body.appendChild(crosshair);

// ══════════════════════════════════════════════════════════════════════════════
// ENGINE
// ══════════════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas);

// ══════════════════════════════════════════════════════════════════════════════
// BOOT — wait for nickname THEN build the scene
// ══════════════════════════════════════════════════════════════════════════════
waitForNickname().then(createScene).then(scene => {
    engine.runRenderLoop(() => scene.render());
});

window.addEventListener('resize', () => engine.resize());

// ══════════════════════════════════════════════════════════════════════════════
// SCENE
// ══════════════════════════════════════════════════════════════════════════════
async function createScene() {
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = BABYLON.Color4.FromHexString("#87CEEBff");

    // ── Physics ───────────────────────────────────────────────────────────────
    const havokInstance = await HavokPhysics();
    const hk = new BABYLON.HavokPlugin(true, havokInstance);
    scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), hk);

    // ── Light ─────────────────────────────────────────────────────────────────
    const light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene);
    light.intensity = 0.8;

    // ── Local player ──────────────────────────────────────────────────────────
    const box = new BABYLON.MeshBuilder.CreateBox('mybox', { size: 1 });
    box.position.y = 5;
    box.rotationQuaternion = new BABYLON.Quaternion();

    const boxMat = new BABYLON.StandardMaterial('boxMat', scene);
    boxMat.diffuseColor = new BABYLON.Color3(0, 0.8, 1);
    box.material = boxMat;

    const boxAggregate = new BABYLON.PhysicsAggregate(
        box, BABYLON.PhysicsShapeType.BOX,
        { mass: 1, restitution: 0.3, friction: 0.8 }, scene
    );
    boxAggregate.body.disablePreStep = false;
    const inert = (1 * 1 * 1) / 6;
    boxAggregate.body.setMassProperties({ inertia: new BABYLON.Vector3(inert, inert, inert) });
    boxAggregate.body.setCollisionCallbackEnabled(true);

    // ── Camera ────────────────────────────────────────────────────────────────
    const camera = new BABYLON.ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3, 10, box.position, scene);
    camera.lockedTarget = box;
    camera.attachControl(canvas, true);
    camera.angularSensibilityX = 4000;
    camera.angularSensibilityY = 4000;
    camera.inputs.attached.pointers.buttons = [0];

    // ── Terrain ───────────────────────────────────────────────────────────────
    new BABYLON.MeshBuilder.CreateGroundFromHeightMap(
        'myground', '/profundidade.jpg',
        {
            width: 1000, height: 1000, subdivisions: 100, maxHeight: 10,
            onReady: (mesh) => {
                const groundMat     = new BABYLON.StandardMaterial('groundMat', scene);
                const groundTexture = new BABYLON.Texture('/textura-do-chao.png', scene);
                groundTexture.uScale = 50;
                groundTexture.vScale = 50;
                groundMat.diffuseTexture = groundTexture;
                mesh.material = groundMat;
                new BABYLON.PhysicsAggregate(
                    mesh, BABYLON.PhysicsShapeType.MESH,
                    { mass: 0, restitution: 0.1, friction: 0.8 }, scene
                );
            },
        }
    );

    // ══════════════════════════════════════════════════════════════════════════
    // NETWORK STATE
    // ══════════════════════════════════════════════════════════════════════════
    let clientId         = null;
    let serverTimeOffset = 0;

    // Map<id, { mesh, aggregate, label, snapshots[], nickname }>
    const otherPlayers = new Map();

    let inputSeq = 0;
    const predBuf = [];

    let isAirborne      = false;
    let lastImpulseTime = 0;

    // ══════════════════════════════════════════════════════════════════════════
    // REMOTE PLAYER FACTORY
    // ══════════════════════════════════════════════════════════════════════════
    function spawnRemotePlayer(rid, nickname) {

        const mesh = new BABYLON.MeshBuilder.CreateBox(`player_${rid}`, { size: 1 }, scene);
        const mat  = new BABYLON.StandardMaterial(`mat_${rid}`, scene);
        mat.diffuseColor = new BABYLON.Color3(Math.random(), Math.random(), Math.random());
        mesh.material = mat;
        mesh.rotationQuaternion = new BABYLON.Quaternion();

        const agg = new BABYLON.PhysicsAggregate(
            mesh, BABYLON.PhysicsShapeType.BOX,
            { mass: 0, restitution: 0.1, friction: 0.5 }, scene
        );
        agg.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
        agg.body.setCollisionCallbackEnabled(true);
        agg.body.disablePreStep = false;

        const label = document.createElement('div');
        label.textContent = nickname || `Player ${rid.substring(0, 8)}`;
        Object.assign(label.style, {
            position: 'absolute', color: 'white', fontSize: '12px',
            backgroundColor: 'rgba(0,0,0,0.55)', padding: '2px 8px',
            borderRadius: '4px', pointerEvents: 'none', zIndex: '999',
            fontFamily: 'sans-serif', fontWeight: 'bold',
            textShadow: '0 1px 3px #000',
            transform: 'translateX(-50%)',  // centre the label over the player
        });
        document.body.appendChild(label);

        return { mesh, aggregate: agg, label, snapshots: [], nickname: nickname || rid.substring(0, 8) };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // WEBSOCKET
    // ══════════════════════════════════════════════════════════════════════════
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${location.hostname}:8080`);

    ws.onopen = () => {
        console.log('✓ WebSocket connected');
        // Nickname is sent right after the server responds with 'init',
        // but we queue it here too in case init already arrived.
    };
    ws.onerror = (e) => console.error('WebSocket error', e);
    ws.onclose = () => console.warn('⚠ WebSocket closed');

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        // ── Handshake ─────────────────────────────────────────────────────────
        if (msg.type === 'init') {
            clientId         = msg.clientId;
            _selfId          = clientId;  // let chat UI know who "self" is
            serverTimeOffset = msg.serverTime - Date.now();
            console.log(`ID: ${clientId} | clock offset: ${serverTimeOffset}ms`);

            // Send our nickname immediately after receiving our ID
            ws.send(JSON.stringify({ type: 'set_nickname', nickname: localNickname }));

        // ── World state ───────────────────────────────────────────────────────
        } else if (msg.type === 'world_state') {

            for (const [rid, srv] of Object.entries(msg.states)) {

                // ── Own player — XZ Reconciliation ────────────────────────────
                if (rid === clientId) {
                    const idx = predBuf.findIndex(e => e.seq === srv.s);
                    if (idx === -1) continue;

                    const pred  = predBuf[idx];
                    const dxErr = pred.pos.x - srv.p.x;
                    const dzErr = pred.pos.z - srv.p.z;
                    const xzErr = Math.sqrt(dxErr * dxErr + dzErr * dzErr);

                    if (xzErr > RECONCILE_EPS_XZ) {
                        console.warn(`[Reconcile] seq=${srv.s} ΔXZ=${xzErr.toFixed(3)}m`);
                        box.position.x = srv.p.x;
                        box.position.z = srv.p.z;
                        const curVel = boxAggregate.body.getLinearVelocity();
                        boxAggregate.body.setLinearVelocity(
                            new BABYLON.Vector3(srv.v.x, curVel.y, srv.v.z)
                        );
                        let rx = srv.p.x, rz = srv.p.z;
                        for (let i = idx + 1; i < predBuf.length; i++) {
                            const e = predBuf[i];
                            rx += e.vel.x * e.dt;
                            rz += e.vel.z * e.dt;
                            e.pos.x = rx;
                            e.pos.z = rz;
                        }
                    }

                    predBuf.splice(0, idx + 1);

                // ── Remote player — snapshot ──────────────────────────────────
                } else {
                    // Nickname may arrive in world_state (srv.n)
                    const incomingNick = srv.n || null;

                    if (!otherPlayers.has(rid)) {
                        const p = spawnRemotePlayer(rid, incomingNick);
                        otherPlayers.set(rid, p);
                        appendChatMessage({
                            isSystem: true,
                            message:  `⚡ ${p.nickname} entrou no jogo`,
                        });
                        console.log('Player joined:', rid, `(${p.nickname})`);
                    } else if (incomingNick) {
                        // Update label if nickname changed
                        const p = otherPlayers.get(rid);
                        if (p.nickname !== incomingNick) {
                            p.nickname        = incomingNick;
                            p.label.textContent = incomingNick;
                        }
                    }

                    const player = otherPlayers.get(rid);
                    player.snapshots.push({
                        t: msg.t,
                        p: { ...srv.p },
                        v: { ...srv.v },
                        r: { ...srv.r },
                    });
                    if (player.snapshots.length > MAX_SNAPSHOTS) player.snapshots.shift();
                }
            }

        // ── Nickname update broadcast ─────────────────────────────────────────
        } else if (msg.type === 'player_info') {
            if (msg.clientId === clientId) return; // ignore own echo
            const p = otherPlayers.get(msg.clientId);
            if (p) {
                p.nickname        = msg.nickname;
                p.label.textContent = msg.nickname;
            }

        // ── Chat ──────────────────────────────────────────────────────────────
        } else if (msg.type === 'chat') {
            appendChatMessage({
                clientId: msg.clientId,
                nickname: msg.nickname,
                message:  msg.message,
            });

        // ── Disconnect ────────────────────────────────────────────────────────
        } else if (msg.type === 'disconnect') {
            const p = otherPlayers.get(msg.clientId);
            if (p) {
                appendChatMessage({
                    isSystem: true,
                    message:  `🔌 ${p.nickname} saiu do jogo`,
                });
                p.aggregate.dispose();
                p.mesh.dispose();
                p.label.remove();
                otherPlayers.delete(msg.clientId);
            }
        }
    };

    // ══════════════════════════════════════════════════════════════════════════
    // COLLISION IMPULSE
    // ══════════════════════════════════════════════════════════════════════════
    boxAggregate.body.getCollisionObservable().add((evt) => {
        if (evt.type !== BABYLON.PhysicsEventType.COLLISION_STARTED) return;

        const now = performance.now();
        if (now - lastImpulseTime < IMPULSE_COOLDOWN_MS) return;

        let hitPos = null;
        for (const [, p] of otherPlayers) {
            if (p.aggregate.body === evt.collidedAgainst) { hitPos = p.mesh.position; break; }
        }
        if (!hitPos) return;

        const dir = box.position.subtract(hitPos);
        dir.y = 0;
        if (dir.length() < 0.001) dir.x = 1;
        else dir.normalize();
        dir.scaleInPlace(IMPULSE_FORCE);
        dir.y = IMPULSE_Y;

        boxAggregate.body.applyImpulse(dir, box.getAbsolutePosition());
        lastImpulseTime = now;
        isAirborne      = true;

        // Immediate state push so the server knows about the velocity spike now
        if (clientId && ws.readyState === WebSocket.OPEN) {
            const seq = ++inputSeq;
            ws.send(JSON.stringify({
                type: 'state', seq,
                t:   Date.now() + serverTimeOffset,
                pos: { x: box.position.x, y: box.position.y, z: box.position.z },
                vel: { x: dir.x, y: dir.y, z: dir.z },
                rot: quatToObj(box.rotationQuaternion),
            }));
            predBuf.push({
                seq, dt: 0,
                pos: { x: box.position.x, y: box.position.y, z: box.position.z },
                vel: { x: dir.x, y: dir.y, z: dir.z },
            });
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // INPUT — keyboard + CHAT
    // ══════════════════════════════════════════════════════════════════════════
    scene.onPointerDown = (evt) => {
        // Only lock pointer if not clicking the chat input
        if (evt.button === 0 && document.activeElement !== chatInput) {
            engine.enterPointerlock();
        }
    };

    const keys = {};

    // Keyboard: WASD / arrows — but NOT when the chat input is focused
    scene.onKeyboardObservable.add((kbInfo) => {
        // If user is typing in chat, don't forward movement keys to the game
        if (document.activeElement === chatInput) return;

        const k = kbInfo.event.key.toLowerCase();
        if (kbInfo.type === BABYLON.KeyboardEventTypes.KEYDOWN) keys[k] = true;
        if (kbInfo.type === BABYLON.KeyboardEventTypes.KEYUP)   keys[k] = false;
    });

    // Press T to focus chat (and Escape to blur)
    window.addEventListener('keydown', (e) => {
        if (e.key === 't' || e.key === 'T') {
            if (document.activeElement !== chatInput) {
                e.preventDefault();
                engine.exitPointerlock();
                chatInput.focus();
            }
        }
        if (e.key === 'Escape') {
            chatInput.blur();
        }
    });

    // Send chat on Enter
    chatInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const text = chatInput.value.trim();
        chatInput.value = '';
        if (!text || !clientId || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'chat', message: text }));
        // Server echoes the message back to us — no need to add locally
    });

    // Blur chat when clicking the canvas
    canvas.addEventListener('mousedown', () => {
        chatInput.blur();
    });

    // ══════════════════════════════════════════════════════════════════════════
    // RENDER LOOP
    // ══════════════════════════════════════════════════════════════════════════
    scene.onBeforeRenderObservable.add(() => {
        const dt  = Math.min(engine.getDeltaTime() / 1000, 0.05);
        const vel = boxAggregate.body.getLinearVelocity();

        const ray        = new BABYLON.Ray(box.position, new BABYLON.Vector3(0, -1, 0), 1.0);
        const hit        = scene.pickWithRay(ray, (m) => m.name === 'myground');
        const isGrounded = hit.hit;
        if (isGrounded && Math.abs(vel.y) < 1.5) isAirborne = false;

        const input = {
            w: !!(keys['w']         || keys['arrowup']),
            s: !!(keys['s']         || keys['arrowdown']),
            a: !!(keys['a']         || keys['arrowleft']),
            d: !!(keys['d']         || keys['arrowright']),
        };

        if (keys[' '] && isGrounded) {
            keys[' '] = false;
            vel.y = 8;
        }

        const cfBab = camera.getDirection(BABYLON.Vector3.Forward());
        const crBab = camera.getDirection(BABYLON.Vector3.Right());
        cfBab.y = 0; cfBab.normalize();
        crBab.y = 0; crBab.normalize();

        let dirX = 0, dirZ = 0;
        if (input.w) { dirX += cfBab.x; dirZ += cfBab.z; }
        if (input.s) { dirX -= cfBab.x; dirZ -= cfBab.z; }
        if (input.d) { dirX += crBab.x; dirZ += crBab.z; }
        if (input.a) { dirX -= crBab.x; dirZ -= crBab.z; }

        const dLen = Math.sqrt(dirX * dirX + dirZ * dirZ);
        const spd  = 25;
        const vx   = dLen > 0 ? (dirX / dLen) * spd : 0;
        const vz   = dLen > 0 ? (dirZ / dLen) * spd : 0;

        if (dLen === 0 && isGrounded) {
            const av = boxAggregate.body.getAngularVelocity();
            boxAggregate.body.setAngularVelocity(av.scale(0.95));
        }

        if (isAirborne && !isGrounded) {
            boxAggregate.body.setLinearVelocity(new BABYLON.Vector3(vel.x, vel.y, vel.z));
        } else {
            boxAggregate.body.setLinearVelocity(new BABYLON.Vector3(vx, vel.y, vz));
        }

        const finalVel = boxAggregate.body.getLinearVelocity();

        const seq = ++inputSeq;
        predBuf.push({
            seq, dt,
            pos: { x: box.position.x, y: box.position.y, z: box.position.z },
            vel: { x: finalVel.x,     y: finalVel.y,     z: finalVel.z },
        });
        if (predBuf.length > PREDICTION_BUFFER_SIZE) predBuf.shift();

        if (clientId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'state', seq,
                t:   Date.now() + serverTimeOffset,
                pos: { x: box.position.x, y: box.position.y, z: box.position.z },
                vel: { x: finalVel.x,     y: finalVel.y,     z: finalVel.z },
                rot: quatToObj(box.rotationQuaternion),
            }));
        }

        // ── Entity interpolation ──────────────────────────────────────────────
        const renderTime = Date.now() + serverTimeOffset - INTERPOLATION_DELAY_MS;

        for (const [, player] of otherPlayers) {
            const snaps = player.snapshots;
            if (snaps.length === 0) continue;

            let lo = -1;
            for (let i = snaps.length - 1; i >= 0; i--) {
                if (snaps[i].t <= renderTime) { lo = i; break; }
            }

            let ip, ir;

            if (lo === -1) {
                ip = { ...snaps[0].p };
                ir = { ...snaps[0].r };
            } else if (lo === snaps.length - 1) {
                const s    = snaps[lo];
                const exDt = Math.min((renderTime - s.t) / 1000, 0.15);
                ip = {
                    x: s.p.x + s.v.x * exDt,
                    y: s.p.y + s.v.y * exDt,
                    z: s.p.z + s.v.z * exDt,
                };
                ir = { ...s.r };
            } else {
                const s0   = snaps[lo];
                const s1   = snaps[lo + 1];
                const span = s1.t - s0.t;
                const t    = span > 0 ? Math.max(0, Math.min(1, (renderTime - s0.t) / span)) : 0;
                ip = {
                    x: s0.p.x + (s1.p.x - s0.p.x) * t,
                    y: s0.p.y + (s1.p.y - s0.p.y) * t,
                    z: s0.p.z + (s1.p.z - s0.p.z) * t,
                };
                ir = slerpQuat(s0.r, s1.r, t);
            }

            player.aggregate.body.setTargetTransform(
                new BABYLON.Vector3(ip.x, ip.y, ip.z),
                new BABYLON.Quaternion(ir.x, ir.y, ir.z, ir.w)
            );

            // ── Label position ────────────────────────────────────────────────
            const screenPos = BABYLON.Vector3.Project(
                new BABYLON.Vector3(ip.x, ip.y + 1.2, ip.z),
                BABYLON.Matrix.Identity(),
                scene.getTransformMatrix(),
                camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
            );
            if (screenPos.z > 0 && screenPos.z < 1) {
                Object.assign(player.label.style, {
                    display: 'block',
                    left:    `${screenPos.x}px`,
                    top:     `${screenPos.y}px`,
                });
            } else {
                player.label.style.display = 'none';
            }
        }
    });

    return scene;
}

// ══════════════════════════════════════════════════════════════════════════════
// MATH HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function slerpQuat(q0, q1, t) {
    let dot = q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w;
    const s = dot < 0 ? -1 : 1;
    const a = { x: q1.x * s, y: q1.y * s, z: q1.z * s, w: q1.w * s };
    dot = Math.abs(dot);
    if (dot > 0.9995) {
        const r = {
            x: q0.x + (a.x - q0.x) * t, y: q0.y + (a.y - q0.y) * t,
            z: q0.z + (a.z - q0.z) * t, w: q0.w + (a.w - q0.w) * t,
        };
        const len = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z + r.w * r.w);
        return { x: r.x / len, y: r.y / len, z: r.z / len, w: r.w / len };
    }
    const theta0    = Math.acos(dot);
    const theta     = theta0 * t;
    const sinTheta  = Math.sin(theta);
    const sinTheta0 = Math.sin(theta0);
    const sc0 = Math.cos(theta) - dot * sinTheta / sinTheta0;
    const sc1 = sinTheta / sinTheta0;
    return {
        x: q0.x * sc0 + a.x * sc1, y: q0.y * sc0 + a.y * sc1,
        z: q0.z * sc0 + a.z * sc1, w: q0.w * sc0 + a.w * sc1,
    };
}

function quatToObj(q) {
    return { x: q.x, y: q.y, z: q.z, w: q.w };
}