import * as BABYLON from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';
import '@babylonjs/loaders';

// ══════════════════════════════════════════════════════════════════════════════
// NETWORK CONFIG
// ══════════════════════════════════════════════════════════════════════════════
const INTERPOLATION_DELAY_MS = 100;
const RECONCILE_EPS_XZ = 0.4;
const MAX_SNAPSHOTS = 40;
const PREDICTION_BUFFER_SIZE = 128;

const IMPULSE_FORCE = 14;
const IMPULSE_Y = 6;
const IMPULSE_COOLDOWN_MS = 300;

// Ant knockback (player is launched, not the ant)
const ANT_IMPULSE_FORCE = 40;
const ANT_IMPULSE_Y = 14;
const ANT_MOVE_SPEED = 55;     // units/s – ant pursuit speed
const ANT_DETECT_RANGE = 700;    // metres – how far the ant can detect a player

// ── WEAPON ────────────────────────────────────────────────────────────────────
// Bat animation: idle = vertical (up). Attack = windup back-right → strike left.
const BAT_WINDUP_ROT = { x: -0.3, y: -0.9, z: 0.5 }; // anticipation: cocked back-right
const BAT_STRIKE_ROT = { x: 0.1, y: 1.5, z: -0.5 }; // end of sweep: through to left
const WINDUP_DURATION = 0.08;  // seconds – fast anticipation windup
const SWING_DURATION = 0.18;  // seconds – main lateral strike
const RECOVERY_DURATION = 0.28;  // seconds – return to vertical idle
const BAT_HIT_T_FRACTION = 0.5;  // fraction into strike phase when hit-cone fires
const BAT_HIT_IMPULSE_XZ = 3140;   // horizontal impulse on target
const BAT_HIT_IMPULSE_Y = 200;   // vertical impulse on target
const BAT_CONE_HALF_ANGLE = Math.PI / 3.5; // ~72° half-angle of the invisible hit cone
const BAT_CONE_RANGE = 10.0;  // metres – cone reach from player centre
const SWING_COOLDOWN_MS = 520;  // min ms between swings

// ── WORLD ─────────────────────────────────────────────────────────────────────
const DEATH_Y = -60;   // fall below this Y → eliminated & respawn

// ── SPAWN POINTS ──────────────────────────────────────────────────────────────
const SPAWN_POINTS = [
    { x: 0, z: 0 },
    { x: 40, z: 40 },
    { x: -40, z: 40 },
    { x: 40, z: -40 },
    { x: -40, z: -40 },
    { x: 20, z: -30 },
    { x: -30, z: 20 },
    { x: 10, z: 50 },
];
function randomSpawn() {
    return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
}
const CHAT_MAX_VISIBLE = 40;

// ══════════════════════════════════════════════════════════════════════════════
// NICKNAME OVERLAY
// ══════════════════════════════════════════════════════════════════════════════
let localNickname = 'Player';

function waitForNickname() {
    return new Promise((resolve) => {
        const overlay = document.getElementById('nickname-overlay');
        const input = document.getElementById('nickname-input-field');
        const btnOk = document.getElementById('nickname-confirm-btn');

        function confirm() {
            const raw = input.value.replace(/[<>&"']/g, '').trim();
            localNickname = raw.slice(0, 20) || 'Player';
            overlay.classList.add('hidden');
            resolve(localNickname);
        }

        btnOk.addEventListener('click', confirm);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
        input.focus();
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// CHAT UI
// ══════════════════════════════════════════════════════════════════════════════
const chatList = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
let _selfId = null;

function appendChatMessage({ nickname, message, clientId, isSystem = false }) {
    const li = document.createElement('li');
    if (isSystem) {
        li.classList.add('sys');
        li.textContent = message;
    } else {
        const nick = document.createElement('span');
        nick.classList.add('chat-nick', clientId === _selfId ? 'is-self' : 'is-other');
        nick.textContent = `${nickname}:`;
        li.appendChild(nick);
        li.appendChild(document.createTextNode(` ${message}`));
    }
    chatList.appendChild(li);
    while (chatList.children.length > CHAT_MAX_VISIBLE) chatList.removeChild(chatList.firstChild);
    chatList.scrollTop = chatList.scrollHeight;
}

// ══════════════════════════════════════════════════════════════════════════════
// HUD hint strip
// ══════════════════════════════════════════════════════════════════════════════
const hud = document.createElement('div');
Object.assign(hud.style, {
    position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.50)', color: '#fff', fontSize: '12px',
    padding: '4px 14px', borderRadius: '20px', fontFamily: 'sans-serif',
    pointerEvents: 'none', zIndex: '1000', letterSpacing: '0.4px',
});
hud.innerHTML = '🖱 Clique para travar · WASD mover · <b>Espaço</b> pular · <b>Clique esq.</b> tacar · <b>T</b> chat';
document.body.appendChild(hud);

// ══════════════════════════════════════════════════════════════════════════════
// CROSSHAIR
// ══════════════════════════════════════════════════════════════════════════════
const crosshair = document.createElement('div');
Object.assign(crosshair.style, {
    position: 'absolute', top: '50%', left: '50%', width: '8px', height: '8px',
    backgroundColor: 'red', transform: 'translate(-50%,-50%)', borderRadius: '50%',
    pointerEvents: 'none', zIndex: '1000',
});
document.body.appendChild(crosshair);

// ══════════════════════════════════════════════════════════════════════════════
// ENGINE
// ══════════════════════════════════════════════════════════════════════════════
const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas);

waitForNickname().then(createScene).then(scene => {
    engine.runRenderLoop(() => scene.render());
});
window.addEventListener('resize', () => engine.resize());

// ══════════════════════════════════════════════════════════════════════════════
// BAT FACTORY
// Creates a procedural baseball-bat mesh parented to `parentNode`.
// Returns { root: TransformNode, mat: StandardMaterial }
// ══════════════════════════════════════════════════════════════════════════════
function createBat(scene, parentNode, idSuffix) {
    idSuffix = idSuffix || '';

    const mat = new BABYLON.StandardMaterial('batMat' + idSuffix, scene);
    mat.diffuseColor = new BABYLON.Color3(0.58, 0.30, 0.09);
    mat.specularColor = new BABYLON.Color3(0.2, 0.15, 0.05);

    const root = new BABYLON.TransformNode('batRoot' + idSuffix, scene);
    root.parent = parentNode;
    // Held to the right side, slightly forward and elevated
    root.position = new BABYLON.Vector3(0.6, 0.1, 0.2);
    root.rotation = new BABYLON.Vector3(0, 0, 80); // idle: bat vertical, pointing straight up

    // Handle: 0 → 1.0 along local Y (bigger)
    const handle = BABYLON.MeshBuilder.CreateCylinder('batH' + idSuffix, {
        height: 1.0, diameterTop: 0.09, diameterBottom: 0.075, tessellation: 8,
    }, scene);
    handle.parent = root;
    handle.position = new BABYLON.Vector3(0, 0.50, 0);
    handle.material = mat;

    // Barrel: 1.0 → 1.75 along local Y (bigger)
    const barrel = BABYLON.MeshBuilder.CreateCylinder('batB' + idSuffix, {
        height: 0.75, diameterTop: 0.13, diameterBottom: 0.26, tessellation: 8,
    }, scene);
    barrel.parent = root;
    barrel.position = new BABYLON.Vector3(0, 1.375, 0);
    barrel.material = mat;

    // End knob (bigger)
    const knob = BABYLON.MeshBuilder.CreateSphere('batK' + idSuffix, { diameter: 0.15, segments: 6 }, scene);
    knob.parent = root;
    knob.position = new BABYLON.Vector3(0, -0.01, 0);
    knob.material = mat;

    return { root, mat };
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENE
// ══════════════════════════════════════════════════════════════════════════════
async function createScene() {
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = BABYLON.Color4.FromHexString('#87CEEBff');

    // ── Physics ───────────────────────────────────────────────────────────────
    const havokInstance = await HavokPhysics();
    const hk = new BABYLON.HavokPlugin(true, havokInstance);
    scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), hk);

    // ── Lighting & Shadows ──────────────────────────────────────────────────
    const hemiLight = new BABYLON.HemisphericLight('hemiLight', new BABYLON.Vector3(0, 1, 0), scene);
    hemiLight.intensity = 0.4;
    hemiLight.groundColor = new BABYLON.Color3(0.2, 0.2, 0.3);

    const dirLight = new BABYLON.DirectionalLight('dirLight', new BABYLON.Vector3(-1, -2, -1), scene);
    dirLight.position = new BABYLON.Vector3(20, 40, 20);
    dirLight.intensity = 0.8;

    const shadowGen = new BABYLON.ShadowGenerator(1024, dirLight);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 32;

    // ── Local player — random spawn ───────────────────────────────────────────
    const sp = randomSpawn();

    const box = BABYLON.MeshBuilder.CreateBox('mybox', { size: 1 });
    box.position.set(sp.x, 15, sp.z);
    box.rotationQuaternion = new BABYLON.Quaternion();

    const boxMat = new BABYLON.StandardMaterial('boxMat', scene);
    boxMat.diffuseColor = new BABYLON.Color3(0, 0.8, 1);
    box.material = boxMat;
    shadowGen.addShadowCaster(box);

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
    function getProceduralHeight(x, z) {
        return Math.sin(x * 0.02) * Math.cos(z * 0.02) * 8
            + Math.sin(x * 0.05) * Math.cos(z * 0.05) * 3;
    }

    const ground = BABYLON.MeshBuilder.CreateGround('myground', {
        width: 1000, height: 1000, subdivisions: 200, updatable: true,
    }, scene);

    const positions = ground.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    const indices = ground.getIndices();
    for (let i = 0; i < positions.length; i += 3) {
        positions[i + 1] = getProceduralHeight(positions[i], positions[i + 2]);
    }
    ground.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions);
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    ground.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals);

    const groundMat = new BABYLON.StandardMaterial('groundMat', scene);
    const groundTexture = new BABYLON.Texture('/textura-do-chao.png', scene);
    groundTexture.uScale = 50;
    groundTexture.vScale = 50;
    groundMat.diffuseTexture = groundTexture;
    groundMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    ground.material = groundMat;
    ground.receiveShadows = true;

    // Ground is already configured above with the texture


    new BABYLON.PhysicsAggregate(
        ground, BABYLON.PhysicsShapeType.MESH,
        { mass: 0, restitution: 0.1, friction: 0.8 }, scene
    );

    // ══════════════════════════════════════════════════════════════════════════
    // LOCAL PLAYER BAT
    // batHolder is manually positioned each frame to follow the box and
    // face the camera direction, so the swing always goes "forward".
    // ══════════════════════════════════════════════════════════════════════════
    const batHolder = new BABYLON.TransformNode('batHolder', scene);
    const { root: batRoot, mat: batMat } = createBat(scene, batHolder, '_local');

    // Swing FSM
    let swingPhase = 'idle';   // 'idle' | 'swing' | 'recovery'
    let swingT = 0;
    let hitCheckedThisSwing = false;
    let lastSwingTime = 0;
    let lastHitBy = null;     // nickname of whoever last hit us

    function startSwing() {
        const now = performance.now();
        if (swingPhase !== 'idle' || now - lastSwingTime < SWING_COOLDOWN_MS) return;
        lastSwingTime = now;
        swingPhase = 'windup';
        swingT = 0;
        hitCheckedThisSwing = false;
    }

    function checkBatHit() {
        if (!clientId || ws.readyState !== WebSocket.OPEN) return;

        // ── Invisible cone hitbox in front of the player ──────────────────────
        // The bat mesh has no collision role; damage comes from this cone only.
        const playerPos = box.position;
        const fwdDir = camera.getDirection(BABYLON.Vector3.Forward());
        fwdDir.y = 0;
        if (fwdDir.length() < 0.001) return;
        fwdDir.normalize();

        const cosHalf = Math.cos(BAT_CONE_HALF_ANGLE);

        // Check other players
        for (const [rid, p] of otherPlayers) {
            const toTarget = p.mesh.position.subtract(playerPos);
            toTarget.y = 0;
            const dist = toTarget.length();
            if (dist < 0.001 || dist > BAT_CONE_RANGE) continue;
            if (BABYLON.Vector3.Dot(fwdDir, toTarget.normalize()) < cosHalf) continue;

            const dir = p.mesh.position.subtract(box.position);
            dir.y = 0;
            if (dir.length() < 0.001) dir.x = 1;
            dir.normalize().scaleInPlace(BAT_HIT_IMPULSE_XZ);
            dir.y = BAT_HIT_IMPULSE_Y;

            ws.send(JSON.stringify({
                type: 'bat_hit',
                targetId: rid,
                dir: { x: dir.x, y: dir.y, z: dir.z },
            }));

            batMat.emissiveColor = new BABYLON.Color3(1, 0.1, 0);
            setTimeout(() => { batMat.emissiveColor = BABYLON.Color3.Black(); }, 180);
            return; // one target per swing
        }

        // Check ants
        for (const ant of localAnts) {
            const toTarget = ant.collider.position.subtract(playerPos);
            toTarget.y = 0;
            const dist = toTarget.length();
            if (dist < 0.001 || dist > BAT_CONE_RANGE) continue;
            if (BABYLON.Vector3.Dot(fwdDir, toTarget.normalize()) < cosHalf) continue;

            const dir = ant.collider.position.subtract(box.position);
            dir.y = 0;
            if (dir.length() < 0.001) dir.x = 1;
            dir.normalize().scaleInPlace(BAT_HIT_IMPULSE_XZ);
            dir.y = BAT_HIT_IMPULSE_Y;

            ws.send(JSON.stringify({
                type: 'ant_hit',
                antId: ant.id,
                dir: { x: dir.x, y: dir.y, z: dir.z },
            }));

            batMat.emissiveColor = new BABYLON.Color3(1, 0.5, 0);
            setTimeout(() => { batMat.emissiveColor = BABYLON.Color3.Black(); }, 180);
            break;
        }
    }

    function respawnPlayer() {
        const rsp = randomSpawn();
        box.position.set(rsp.x, 15, rsp.z);
        boxAggregate.body.setLinearVelocity(BABYLON.Vector3.Zero());
        boxAggregate.body.setAngularVelocity(BABYLON.Vector3.Zero());
        isAirborne = false;
        if (isAirborneTimer) { clearTimeout(isAirborneTimer); isAirborneTimer = null; }

        if (clientId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'eliminated', killerNickname: lastHitBy }));
        }
        appendChatMessage({ isSystem: true, message: '💀 Você foi eliminado! Renascendo...' });
        lastHitBy = null;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // NETWORK STATE
    // ══════════════════════════════════════════════════════════════════════════
    let clientId = null;
    let serverTimeOffset = 0;

    const otherPlayers = new Map();
    const pendingNicknames = new Map();  // nicknames arriving before world_state

    let inputSeq = 0;
    const predBuf = [];
    const localAnts = [];
    let antMeshPrototype = null;

    let isAirborne = false;
    let lastImpulseTime = 0;
    let isAirborneTimer = null;

    let antPhysicsBody = null;
    let antColliderRef = null;

    // ══════════════════════════════════════════════════════════════════════════
    // REMOTE PLAYER FACTORY (includes bat)
    // ══════════════════════════════════════════════════════════════════════════
    function spawnRemotePlayer(rid, nickname) {
        const resolvedNick = pendingNicknames.get(rid) || nickname || ('Player_' + rid.substring(0, 6));
        pendingNicknames.delete(rid);

        const mesh = BABYLON.MeshBuilder.CreateBox('player_' + rid, { size: 1 }, scene);
        const mat = new BABYLON.StandardMaterial('mat_' + rid, scene);
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

        // Bat parented directly to the remote player mesh
        const { root: remoteBatRoot } = createBat(scene, mesh, '_' + rid.substring(0, 6));

        shadowGen.addShadowCaster(mesh);

        const label = document.createElement('div');
        label.textContent = resolvedNick;
        Object.assign(label.style, {
            position: 'absolute', color: 'white', fontSize: '12px',
            backgroundColor: 'rgba(0,0,0,0.55)', padding: '2px 8px',
            borderRadius: '4px', pointerEvents: 'none', zIndex: '999',
            fontFamily: 'sans-serif', fontWeight: 'bold',
            textShadow: '0 1px 3px #000', transform: 'translateX(-50%)',
        });
        document.body.appendChild(label);

        return {
            mesh, aggregate: agg, label, snapshots: [],
            nickname: resolvedNick,
            batRoot: remoteBatRoot,
            swingPhase: 'idle', swingT: 0,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    // WEBSOCKET
    // ══════════════════════════════════════════════════════════════════════════
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsProtocol + '//' + location.hostname + ':8080');

    ws.onopen = () => console.log('✓ WebSocket conectado');
    ws.onerror = (e) => console.error('WebSocket error', e);
    ws.onclose = () => console.warn('⚠ WebSocket fechado');

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        // ── Handshake ─────────────────────────────────────────────────────────
        if (msg.type === 'init') {
            clientId = msg.clientId;
            _selfId = clientId;
            serverTimeOffset = msg.serverTime - Date.now();
            ws.send(JSON.stringify({ type: 'set_nickname', nickname: localNickname }));

            // ── World state ───────────────────────────────────────────────────────
        } else if (msg.type === 'world_state') {
            for (const [rid, srv] of Object.entries(msg.states)) {
                if (rid === clientId) {
                    // XZ reconciliation
                    const idx = predBuf.findIndex(e => e.seq === srv.s);
                    if (idx === -1) continue;
                    const pred = predBuf[idx];
                    const xzErr = Math.hypot(pred.pos.x - srv.p.x, pred.pos.z - srv.p.z);
                    if (xzErr > RECONCILE_EPS_XZ) {
                        box.position.x = srv.p.x;
                        box.position.z = srv.p.z;
                        const curVel = boxAggregate.body.getLinearVelocity();
                        boxAggregate.body.setLinearVelocity(
                            new BABYLON.Vector3(srv.v.x, curVel.y, srv.v.z)
                        );
                        let rx = srv.p.x, rz = srv.p.z;
                        for (let i = idx + 1; i < predBuf.length; i++) {
                            const e = predBuf[i];
                            rx += e.vel.x * e.dt; rz += e.vel.z * e.dt;
                            e.pos.x = rx; e.pos.z = rz;
                        }
                    }
                    predBuf.splice(0, idx + 1);
                } else {
                    const incomingNick = srv.n || null;
                    if (!otherPlayers.has(rid)) {
                        const p = spawnRemotePlayer(rid, incomingNick);
                        otherPlayers.set(rid, p);
                        appendChatMessage({ isSystem: true, message: '⚡ ' + p.nickname + ' entrou no jogo' });
                    } else {
                        const p = otherPlayers.get(rid);
                        const pending = pendingNicknames.get(rid);
                        if (pending) {
                            p.nickname = pending; p.label.textContent = pending;
                            pendingNicknames.delete(rid);
                        } else if (incomingNick && p.nickname !== incomingNick) {
                            p.nickname = incomingNick; p.label.textContent = incomingNick;
                        }
                    }
                    const player = otherPlayers.get(rid);
                    player.snapshots.push({ t: msg.t, p: { ...srv.p }, v: { ...srv.v }, r: { ...srv.r } });
                    if (player.snapshots.length > MAX_SNAPSHOTS) player.snapshots.shift();
                }
            }

            // Sync ants
            if (msg.ants && antMeshPrototype) {
                // Initialize missing ants
                while (localAnts.length < msg.ants.length) {
                    const srvAnt = msg.ants[localAnts.length];

                    const antCollider = BABYLON.MeshBuilder.CreateBox(
                        'antCollider_' + srvAnt.id,
                        { width: 10 * srvAnt.scale, height: 6 * srvAnt.scale, depth: 14 * srvAnt.scale },
                        scene
                    );
                    antCollider.position = new BABYLON.Vector3(srvAnt.p.x, srvAnt.p.y + 10, srvAnt.p.z);
                    antCollider.isVisible = false;

                    const visualAnt = antMeshPrototype.instantiateHierarchy(antCollider, { doNotInstantiate: false });
                    visualAnt.scaling = new BABYLON.Vector3(5 * srvAnt.scale, 5 * srvAnt.scale, 5 * srvAnt.scale);
                    visualAnt.position = new BABYLON.Vector3(0, -1 * srvAnt.scale, 0);

                    const antAggregate = new BABYLON.PhysicsAggregate(
                        antCollider, BABYLON.PhysicsShapeType.BOX,
                        { mass: 0, restitution: 0.2, friction: 0.8 }, scene
                    );
                    antAggregate.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
                    antAggregate.body.setCollisionCallbackEnabled(true);

                    // Add to shadows (loop through meshes of visualAnt)
                    visualAnt.getChildMeshes().forEach(m => shadowGen.addShadowCaster(m));

                    localAnts.push({
                        id: srvAnt.id,
                        scale: srvAnt.scale,
                        collider: antCollider,
                        body: antAggregate.body,
                        snapshots: []
                    });
                }

                // Push snapshots
                for (let i = 0; i < msg.ants.length; i++) {
                    const localAnt = localAnts[i];
                    localAnt.snapshots.push({ t: msg.t, p: { ...msg.ants[i].p }, rY: msg.ants[i].rY });
                    if (localAnt.snapshots.length > MAX_SNAPSHOTS) localAnt.snapshots.shift();
                }
            }


            // ── Nickname update ───────────────────────────────────────────────────
        } else if (msg.type === 'player_info') {
            if (msg.clientId === clientId) return;
            const p = otherPlayers.get(msg.clientId);
            if (p) {
                p.nickname = msg.nickname; p.label.textContent = msg.nickname;
            } else {
                pendingNicknames.set(msg.clientId, msg.nickname);
            }

            // ── Chat ──────────────────────────────────────────────────────────────
        } else if (msg.type === 'chat') {
            appendChatMessage({ clientId: msg.clientId, nickname: msg.nickname, message: msg.message });

            // ── We were hit by a bat! Apply knockback to ourselves ────────────────
        } else if (msg.type === 'bat_hit') {
            const impulse = new BABYLON.Vector3(msg.dir.x, msg.dir.y, msg.dir.z);
            boxAggregate.body.applyImpulse(impulse, box.getAbsolutePosition());
            isAirborne = true;
            lastHitBy = msg.fromNickname || null;
            if (isAirborneTimer) clearTimeout(isAirborneTimer);
            isAirborneTimer = setTimeout(() => { isAirborne = false; isAirborneTimer = null; }, 3000);

            // ── A remote player swung their bat — play their swing animation ───────
        } else if (msg.type === 'swing_event') {
            const p = otherPlayers.get(msg.fromId);
            if (p && p.swingPhase === 'idle') {
                p.swingPhase = 'windup';
                p.swingT = 0;
            }

            // ── Kill feed (someone was eliminated) ────────────────────────────────
        } else if (msg.type === 'kill_feed') {
            const text = msg.killerNickname
                ? ('💀 ' + msg.killedNickname + ' foi eliminado por ' + msg.killerNickname)
                : ('💀 ' + msg.killedNickname + ' caiu do mapa');
            appendChatMessage({ isSystem: true, message: text });

            // ── Disconnect ────────────────────────────────────────────────────────
        } else if (msg.type === 'disconnect') {
            const p = otherPlayers.get(msg.clientId);
            if (p) {
                appendChatMessage({ isSystem: true, message: '🔌 ' + p.nickname + ' saiu do jogo' });
                p.aggregate.dispose();
                p.mesh.dispose();
                p.label.remove();
                otherPlayers.delete(msg.clientId);
                pendingNicknames.delete(msg.clientId);
            }
        }
    };

    // ══════════════════════════════════════════════════════════════════════════
    // COLLISION — body-slam and ant contact (push LOCAL player away)
    // ══════════════════════════════════════════════════════════════════════════
    boxAggregate.body.getCollisionObservable().add((evt) => {
        if (evt.type !== BABYLON.PhysicsEventType.COLLISION_STARTED) return;
        const now = performance.now();
        if (now - lastImpulseTime < IMPULSE_COOLDOWN_MS) return;

        let hitPos = null;
        let isAntHit = false;

        for (const [, p] of otherPlayers) {
            if (p.aggregate.body === evt.collidedAgainst) { hitPos = p.mesh.position; break; }
        }

        if (!hitPos) {
            const hitAnt = localAnts.find(a => a.body === evt.collidedAgainst);
            if (hitAnt) {
                hitPos = hitAnt.collider.position;
                isAntHit = true;
            }
        }
        if (!hitPos) return;

        const dir = box.position.subtract(hitPos);
        dir.y = 0;
        if (dir.length() < 0.001) dir.x = 1;
        dir.normalize().scaleInPlace(isAntHit ? ANT_IMPULSE_FORCE : IMPULSE_FORCE);
        dir.y = isAntHit ? ANT_IMPULSE_Y : IMPULSE_Y;

        boxAggregate.body.applyImpulse(dir, box.getAbsolutePosition());
        lastImpulseTime = now;
        isAirborne = true;
        if (isAirborneTimer) clearTimeout(isAirborneTimer);
        isAirborneTimer = setTimeout(() => { isAirborne = false; isAirborneTimer = null; }, 2000);

        if (clientId && ws.readyState === WebSocket.OPEN) {
            const seq = ++inputSeq;
            ws.send(JSON.stringify({
                type: 'state', seq,
                t: Date.now() + serverTimeOffset,
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
    // INPUT
    // ══════════════════════════════════════════════════════════════════════════
    // First click → lock pointer; clicks while locked → swing bat
    scene.onPointerDown = (evt) => {
        if (evt.button === 0 && document.activeElement !== chatInput) {
            if (!document.pointerLockElement) {
                engine.enterPointerlock();
            } else {
                startSwing();
            }
        }
    };

    const keys = {};

    scene.onKeyboardObservable.add((kbInfo) => {
        if (document.activeElement === chatInput) return;
        const k = kbInfo.event.key.toLowerCase();
        if (kbInfo.type === BABYLON.KeyboardEventTypes.KEYDOWN) keys[k] = true;
        if (kbInfo.type === BABYLON.KeyboardEventTypes.KEYUP) keys[k] = false;
    });

    // T = open chat (must release pointer lock first)
    window.addEventListener('keydown', (e) => {
        if ((e.key === 't' || e.key === 'T') && document.activeElement !== chatInput) {
            e.preventDefault();
            if (document.pointerLockElement) {
                document.exitPointerLock();
                document.addEventListener('pointerlockchange', function onUnlock() {
                    document.removeEventListener('pointerlockchange', onUnlock);
                    if (!document.pointerLockElement) chatInput.focus();
                });
            } else {
                chatInput.focus();
            }
        }
        if (e.key === 'Escape' && document.activeElement === chatInput) chatInput.blur();
    });

    chatInput.addEventListener('keydown', (e) => {
        e.stopPropagation(); // stop Babylon intercepting keys while typing
        if (e.key !== 'Enter') return;
        const text = chatInput.value.trim();
        chatInput.value = '';
        if (!text) return;
        if (!clientId || ws.readyState !== WebSocket.OPEN) {
            appendChatMessage({ isSystem: true, message: '⚠ Não conectado.' }); return;
        }
        ws.send(JSON.stringify({ type: 'chat', message: text }));
    });

    canvas.addEventListener('mousedown', () => chatInput.blur());

    // ══════════════════════════════════════════════════════════════════════════
    // RENDER LOOP
    // ══════════════════════════════════════════════════════════════════════════
    scene.onBeforeRenderObservable.add(() => {
        const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
        const vel = boxAggregate.body.getLinearVelocity();

        // ── Ground check ──────────────────────────────────────────────────────
        const ray = new BABYLON.Ray(box.position, new BABYLON.Vector3(0, -1, 0), 1.0);
        const hit = scene.pickWithRay(ray, (m) => m.name === 'myground');
        const isGrounded = hit.hit;
        if (isGrounded && Math.abs(vel.y) < 1.5) {
            isAirborne = false;
            if (isAirborneTimer) { clearTimeout(isAirborneTimer); isAirborneTimer = null; }
        }

        // ── Death zone check ──────────────────────────────────────────────────
        if (box.position.y < DEATH_Y) { respawnPlayer(); return; }

        // ── batHolder: tracks box position and faces camera direction ─────────
        batHolder.position.copyFrom(box.position);
        const cf = camera.getDirection(BABYLON.Vector3.Forward());
        batHolder.rotation.y = Math.atan2(cf.x, cf.z);

        // ── Local bat swing animation ──────────────────────────────────────────
        // idle   : bat vertical (rot 0,0,0)
        // windup : anticipation – cocked back-right
        // strike : lateral sweep left (hit cone fires at BAT_HIT_T_FRACTION)
        // recovery: returns to vertical
        if (swingPhase === 'windup') {
            swingT = Math.min(swingT + dt / WINDUP_DURATION, 1);
            batRoot.rotation.x = BAT_WINDUP_ROT.x * swingT;
            batRoot.rotation.y = BAT_WINDUP_ROT.y * swingT;
            batRoot.rotation.z = BAT_WINDUP_ROT.z * swingT;
            if (swingT >= 1) { swingPhase = 'strike'; swingT = 0; }

        } else if (swingPhase === 'strike') {
            swingT = Math.min(swingT + dt / SWING_DURATION, 1);
            batRoot.rotation.x = BAT_WINDUP_ROT.x + (BAT_STRIKE_ROT.x - BAT_WINDUP_ROT.x) * swingT;
            batRoot.rotation.y = BAT_WINDUP_ROT.y + (BAT_STRIKE_ROT.y - BAT_WINDUP_ROT.y) * swingT;
            batRoot.rotation.z = BAT_WINDUP_ROT.z + (BAT_STRIKE_ROT.z - BAT_WINDUP_ROT.z) * swingT;

            if (!hitCheckedThisSwing && swingT >= BAT_HIT_T_FRACTION) {
                hitCheckedThisSwing = true;
                checkBatHit();
            }
            if (swingT >= 1) { swingPhase = 'recovery'; swingT = 0; }

        } else if (swingPhase === 'recovery') {
            swingT = Math.min(swingT + dt / RECOVERY_DURATION, 1);
            batRoot.rotation.x = BAT_STRIKE_ROT.x * (1 - swingT);
            batRoot.rotation.y = BAT_STRIKE_ROT.y * (1 - swingT);
            batRoot.rotation.z = BAT_STRIKE_ROT.z * (1 - swingT);
            if (swingT >= 1) {
                swingPhase = 'idle';
                swingT = 0;
                batRoot.rotation.set(0, 0, 0);
                batRoot.scaling.setAll(1);
            }
        }

        // ── Movement ──────────────────────────────────────────────────────────
        const input = {
            w: !!(keys['w'] || keys['arrowup']),
            s: !!(keys['s'] || keys['arrowdown']),
            a: !!(keys['a'] || keys['arrowleft']),
            d: !!(keys['d'] || keys['arrowright']),
        };

        if (keys[' '] && isGrounded) { keys[' '] = false; vel.y = 8; }

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
        const spd = 25;
        const vx = dLen > 0 ? (dirX / dLen) * spd : 0;
        const vz = dLen > 0 ? (dirZ / dLen) * spd : 0;

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
            vel: { x: finalVel.x, y: finalVel.y, z: finalVel.z },
        });
        if (predBuf.length > PREDICTION_BUFFER_SIZE) predBuf.shift();

        if (clientId && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'state', seq,
                t: Date.now() + serverTimeOffset,
                pos: { x: box.position.x, y: box.position.y, z: box.position.z },
                vel: { x: finalVel.x, y: finalVel.y, z: finalVel.z },
                rot: quatToObj(box.rotationQuaternion),
            }));
        }

        // ── Interpolation ───────────────────────────────────────────────────
        const renderTime = Date.now() + serverTimeOffset - INTERPOLATION_DELAY_MS;

        // Ant Interpolation
        for (let antIdx = 0; antIdx < localAnts.length; antIdx++) {
            const localAnt = localAnts[antIdx];
            const snaps = localAnt.snapshots;
            if (snaps.length < 2) continue;

            let lo = -1;
            for (let i = snaps.length - 1; i >= 0; i--) {
                if (snaps[i].t <= renderTime) { lo = i; break; }
            }

            let ap, arY;
            if (lo === -1) {
                ap = { ...snaps[0].p }; arY = snaps[0].rY;
            } else if (lo === snaps.length - 1) {
                ap = { ...snaps[lo].p }; arY = snaps[lo].rY;
            } else {
                const s0 = snaps[lo], s1 = snaps[lo + 1];
                const span = s1.t - s0.t;
                const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - s0.t) / span)) : 0;
                ap = {
                    x: s0.p.x + (s1.p.x - s0.p.x) * t,
                    y: s0.p.y + (s1.p.y - s0.p.y) * t,
                    z: s0.p.z + (s1.p.z - s0.p.z) * t,
                };

                let dR = s1.rY - s0.rY;
                while (dR > Math.PI) dR -= Math.PI * 2;
                while (dR < -Math.PI) dR += Math.PI * 2;
                arY = s0.rY + dR * t;
            }

            localAnt.collider.position.set(ap.x, ap.y, ap.z);
            // ── Terrain snap: override Y with locally-computed ground height ──
            // Interpolating Y linearly between server snapshots can dip below
            // the terrain when the ant traverses slopes. Recalculate Y from the
            // same formula used on the server so the ant always sits on the mesh.
            const snapY = getProceduralHeight(ap.x, ap.z) + (3 * localAnt.scale);
            localAnt.collider.position.y = snapY;
            localAnt.collider.rotation.y = arY;

            localAnt.body.setTargetTransform(
                localAnt.collider.position,
                BABYLON.Quaternion.FromEulerAngles(0, arY, 0)
            );
        }

        // Remote players
        for (const [, player] of otherPlayers) {
            const snaps = player.snapshots;
            if (snaps.length === 0) continue;

            let lo = -1;
            for (let i = snaps.length - 1; i >= 0; i--) {
                if (snaps[i].t <= renderTime) { lo = i; break; }
            }

            let ip, ir;
            if (lo === -1) {
                ip = { ...snaps[0].p }; ir = { ...snaps[0].r };
            } else if (lo === snaps.length - 1) {
                const s = snaps[lo];
                const exDt = Math.min((renderTime - s.t) / 1000, 0.15);
                ip = { x: s.p.x + s.v.x * exDt, y: s.p.y + s.v.y * exDt, z: s.p.z + s.v.z * exDt };
                ir = { ...s.r };
            } else {
                const s0 = snaps[lo], s1 = snaps[lo + 1];
                const span = s1.t - s0.t;
                const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - s0.t) / span)) : 0;
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

            // Remote bat swing animation — mirrors local 3-phase FSM
            if (player.swingPhase === 'windup') {
                player.swingT = Math.min(player.swingT + dt / WINDUP_DURATION, 1);
                if (player.batRoot) {
                    player.batRoot.rotation.x = BAT_WINDUP_ROT.x * player.swingT;
                    player.batRoot.rotation.y = BAT_WINDUP_ROT.y * player.swingT;
                    player.batRoot.rotation.z = BAT_WINDUP_ROT.z * player.swingT;
                }
                if (player.swingT >= 1) { player.swingPhase = 'strike'; player.swingT = 0; }

            } else if (player.swingPhase === 'strike') {
                player.swingT = Math.min(player.swingT + dt / SWING_DURATION, 1);
                if (player.batRoot) {
                    player.batRoot.rotation.x = BAT_WINDUP_ROT.x + (BAT_STRIKE_ROT.x - BAT_WINDUP_ROT.x) * player.swingT;
                    player.batRoot.rotation.y = BAT_WINDUP_ROT.y + (BAT_STRIKE_ROT.y - BAT_WINDUP_ROT.y) * player.swingT;
                    player.batRoot.rotation.z = BAT_WINDUP_ROT.z + (BAT_STRIKE_ROT.z - BAT_WINDUP_ROT.z) * player.swingT;
                }
                if (player.swingT >= 1) { player.swingPhase = 'recovery'; player.swingT = 0; }

            } else if (player.swingPhase === 'recovery') {
                player.swingT = Math.min(player.swingT + dt / RECOVERY_DURATION, 1);
                if (player.batRoot) {
                    player.batRoot.rotation.x = BAT_STRIKE_ROT.x * (1 - player.swingT);
                    player.batRoot.rotation.y = BAT_STRIKE_ROT.y * (1 - player.swingT);
                    player.batRoot.rotation.z = BAT_STRIKE_ROT.z * (1 - player.swingT);
                }
                if (player.swingT >= 1) {
                    player.swingPhase = 'idle';
                    player.swingT = 0;
                    if (player.batRoot) {
                        player.batRoot.rotation.set(0, 0, 0);
                        player.batRoot.scaling.setAll(1);
                    }
                }
            }

            // Nickname label projection
            const screenPos = BABYLON.Vector3.Project(
                new BABYLON.Vector3(ip.x, ip.y + 1.2, ip.z),
                BABYLON.Matrix.Identity(),
                scene.getTransformMatrix(),
                camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
            );
            if (screenPos.z > 0 && screenPos.z < 1) {
                Object.assign(player.label.style, {
                    display: 'block', left: screenPos.x + 'px', top: screenPos.y + 'px',
                });
            } else {
                player.label.style.display = 'none';
            }
        }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // FORMIGA — Prototype Loading
    // ══════════════════════════════════════════════════════════════════════════
    BABYLON.SceneLoader.ImportMeshAsync('', './3D/', 'Esmilividu.glb', scene)
        .then((resultado) => {
            const malhaFormiga = resultado.meshes[0];
            malhaFormiga.isVisible = false;

            // Oculta todos os filhos do modelo importado
            resultado.meshes.forEach(m => {
                m.isVisible = false;
            });

            antMeshPrototype = malhaFormiga;
            console.log('✓ Protótipo da formiga carregado. Aguardando servidor enviar array de formigas...');
        })
        .catch((err) => console.error('Erro ao carregar formiga:', err));

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
        const r = { x: q0.x + (a.x - q0.x) * t, y: q0.y + (a.y - q0.y) * t, z: q0.z + (a.z - q0.z) * t, w: q0.w + (a.w - q0.w) * t };
        const len = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z + r.w * r.w);
        return { x: r.x / len, y: r.y / len, z: r.z / len, w: r.w / len };
    }
    const theta0 = Math.acos(dot), theta = theta0 * t;
    const sinT = Math.sin(theta), sinT0 = Math.sin(theta0);
    const sc0 = Math.cos(theta) - dot * sinT / sinT0, sc1 = sinT / sinT0;
    return { x: q0.x * sc0 + a.x * sc1, y: q0.y * sc0 + a.y * sc1, z: q0.z * sc0 + a.z * sc1, w: q0.w * sc0 + a.w * sc1 };
}

function quatToObj(q) { return { x: q.x, y: q.y, z: q.z, w: q.w }; }