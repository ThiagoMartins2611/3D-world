import * as BABYLON from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';

const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas);

// ==========================================
// MIRA ARTIFICIAL (Crosshair) HTML/CSS
// ==========================================
const crosshair = document.createElement("div");
crosshair.style.position = "absolute";
crosshair.style.top = "50%";
crosshair.style.left = "50%";
crosshair.style.width = "8px";
crosshair.style.height = "8px";
crosshair.style.backgroundColor = "red";
crosshair.style.transform = "translate(-50%, -50%)";
crosshair.style.borderRadius = "50%";
crosshair.style.pointerEvents = "none";
crosshair.style.zIndex = "1000";
document.body.appendChild(crosshair);

const createScene = async function () {
    const scene = new BABYLON.Scene(engine);

    // 1. Inicializar a Física
    const havokInstance = await HavokPhysics();
    const hk = new BABYLON.HavokPlugin(true, havokInstance);
    scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), hk);

    // 2. Luz
    const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
    light.intensity = 0.8;

    // 3. Bloco Controlável com Física Melhorada
    const box = new BABYLON.MeshBuilder.CreateBox("mybox", {
        size: 1, width: 1, height: 1, depth: 1
    });
    box.position.y = 5; 
    box.rotationQuaternion = new BABYLON.Quaternion(); 
    
    // Material para a box do jogador
    const boxMaterial = new BABYLON.StandardMaterial("boxMat", scene);
    boxMaterial.diffuse = new BABYLON.Color3(0, 0.8, 1); // Azul
    box.material = boxMaterial;
    
    const boxAggregate = new BABYLON.PhysicsAggregate(
        box, 
        BABYLON.PhysicsShapeType.BOX, 
        { 
            mass: 1, 
            restitution: 0.3,
            friction: 0.8,
            friction2: 0.8 
        }, 
        scene
    );
    
    boxAggregate.body.disablePreStep = false;
    const boxMass = 1;
    const boxSize = 1;
    const inertia = (boxMass * boxSize * boxSize) / 6;
    boxAggregate.body.setMassProperties({ 
        inertia: new BABYLON.Vector3(inertia, inertia, inertia)
    });

    // 4. Câmera
    const camera = new BABYLON.ArcRotateCamera(
        "camera", 
        -Math.PI / 2, 
        Math.PI / 3, 
        10, 
        box.position, 
        scene
    );
    camera.lockedTarget = box;
    camera.attachControl(canvas, true);
    
    camera.angularSensibilityX = 4000;
    camera.angularSensibilityY = 4000;
    camera.inputs.attached.pointers.buttons = [0]; 

    // 5. Chão com Física Melhorada
    const groundFromHeightMap = new BABYLON.MeshBuilder.CreateGroundFromHeightMap(
        "myground", 
        "/profundidade.jpg", 
        {
            width: 50, 
            height: 50, 
            subdivisions: 50, 
            maxHeight: 10,
            onReady: (mesh) => {
                new BABYLON.PhysicsAggregate(
                    mesh, 
                    BABYLON.PhysicsShapeType.MESH, 
                    { 
                        mass: 0,
                        restitution: 0.1,
                        friction: 0.8,
                        friction2: 0.8
                    }, 
                    scene
                );
            }
        }
    );
    groundFromHeightMap.material = new BABYLON.StandardMaterial("groundMat", scene);
    groundFromHeightMap.material.wireframe = true;

    // ==========================================
    // SISTEMA DE WEBSOCKET (MULTIPLAYER)
    // ==========================================
    
    const otherPlayers = new Map();
    let clientId = null;
    let updateCounter = 0;
    
    // Detectar URL do servidor (desenvolvimento vs produção)
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.hostname;
    const wsPort = 8080;
    const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}`;
    
    console.log(`Conectando ao servidor WebSocket: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('✓ Conectado ao servidor de multiplayer');
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'init') {
            clientId = data.clientId;
            console.log('Seu ID:', clientId);
        } else if (data.type === 'update') {
            // Atualizar posição de outros jogadores
            if (data.clientId !== clientId) {
                if (!otherPlayers.has(data.clientId)) {
                    // Criar nova caixa para novo jogador
                    const otherBox = new BABYLON.MeshBuilder.CreateBox(`player_${data.clientId}`, { size: 1 });
                    const otherMat = new BABYLON.StandardMaterial(`mat_${data.clientId}`, scene);
                    otherMat.diffuse = new BABYLON.Color3(
                        Math.random(),
                        Math.random(),
                        Math.random()
                    );
                    otherBox.material = otherMat;
                    
                    // Adicionar label com ID do jogador
                    const label = document.createElement('div');
                    label.textContent = `Player ${data.clientId.substring(0, 8)}`;
                    label.style.position = 'absolute';
                    label.style.color = 'white';
                    label.style.fontSize = '12px';
                    label.style.backgroundColor = 'rgba(0,0,0,0.5)';
                    label.style.padding = '2px 4px';
                    label.style.borderRadius = '3px';
                    label.style.pointerEvents = 'none';
                    label.style.zIndex = '999';
                    document.body.appendChild(label);
                    
                    otherPlayers.set(data.clientId, { 
                        mesh: otherBox,
                        label: label
                    });
                    console.log('Novo jogador conectado:', data.clientId);
                }
                
                const otherPlayer = otherPlayers.get(data.clientId);
                otherPlayer.mesh.position = new BABYLON.Vector3(
                    data.position.x, 
                    data.position.y, 
                    data.position.z
                );
                otherPlayer.mesh.rotationQuaternion = new BABYLON.Quaternion(
                    data.rotation.x,
                    data.rotation.y,
                    data.rotation.z,
                    data.rotation.w
                );
            }
        } else if (data.type === 'disconnect') {
            if (otherPlayers.has(data.clientId)) {
                const player = otherPlayers.get(data.clientId);
                player.mesh.dispose();
                player.label.remove();
                otherPlayers.delete(data.clientId);
                console.log('Jogador desconectado:', data.clientId);
            }
        }
    };
    
    ws.onerror = (error) => {
        console.error('❌ Erro WebSocket:', error);
    };
    
    ws.onclose = () => {
        console.log('⚠ Desconectado do servidor');
    };

    // ==========================================
    // SISTEMA DE ENTRADAS (TRAVAR MOUSE E TECLADO)
    // ==========================================
    
    scene.onPointerDown = (evt) => {
        if (evt.button === 0) engine.enterPointerlock();
    };

    const inputMap = {};
    scene.onKeyboardObservable.add((kbInfo) => {
        switch (kbInfo.type) {
            case BABYLON.KeyboardEventTypes.KEYDOWN:
                inputMap[kbInfo.event.key.toLowerCase()] = true;
                break;
            case BABYLON.KeyboardEventTypes.KEYUP:
                inputMap[kbInfo.event.key.toLowerCase()] = false;
                break;
        }
    });

    // ==========================================
    // LOOP DE FÍSICA E MOVIMENTO
    // ==========================================
    scene.onBeforeRenderObservable.add(() => {
        const speed = 6; 
        const currentVelocity = boxAggregate.body.getLinearVelocity();
        
        let moveZ = 0; 
        let moveX = 0; 

        if (inputMap["w"] || inputMap["arrowup"]) moveZ = 1;
        if (inputMap["s"] || inputMap["arrowdown"]) moveZ = -1;
        if (inputMap["a"] || inputMap["arrowleft"]) moveX = -1;
        if (inputMap["d"] || inputMap["arrowright"]) moveX = 1;

        // --- SISTEMA DE PULO COM RAYCAST ---
        const ray = new BABYLON.Ray(box.position, new BABYLON.Vector3(0, -1, 0), 1.0); 
        const pickInfo = scene.pickWithRay(ray, (mesh) => mesh.name === "myground");
        const isGrounded = pickInfo.hit;

        if (inputMap[" "] && isGrounded) {
            currentVelocity.y = 8;
            inputMap[" "] = false; 
        }

        // --- SISTEMA DE MOVIMENTO E DIREÇÃO ---
        let camForward = camera.getDirection(BABYLON.Vector3.Forward());
        let camRight = camera.getDirection(BABYLON.Vector3.Right());

        camForward.y = 0;
        camRight.y = 0;

        camForward.normalize();
        camRight.normalize();

        let moveDirection = camForward.scale(moveZ).add(camRight.scale(moveX));
        let finalVelocityX = 0;
        let finalVelocityZ = 0;

        if (moveDirection.lengthSquared() > 0) {
            moveDirection.normalize().scaleInPlace(speed);
            finalVelocityX = moveDirection.x;
            finalVelocityZ = moveDirection.z;

            // --- ROTAÇÃO NATURAL POR ROLAMENTO (SEM ROTAÇÃO VISUAL) ---
            const movementLength = Math.sqrt(finalVelocityX ** 2 + finalVelocityZ ** 2);
            if (movementLength > 0.1 && isGrounded) {
                const rotationAxis = new BABYLON.Vector3(-finalVelocityZ, 0, finalVelocityX).normalize();
                const angularVelocity = rotationAxis.scale(movementLength / boxSize);
                boxAggregate.body.setAngularVelocity(angularVelocity);
            }
        } else if (isGrounded) {
            const angularVel = boxAggregate.body.getAngularVelocity();
            boxAggregate.body.setAngularVelocity(angularVel.scale(0.95));
        }

        boxAggregate.body.setLinearVelocity(new BABYLON.Vector3(finalVelocityX, currentVelocity.y, finalVelocityZ));

        // --- SINCRONIZAR COM OUTROS JOGADORES ---
        updateCounter++;
        if (updateCounter > 3 && clientId && ws.readyState === WebSocket.OPEN) {
            updateCounter = 0;
            ws.send(JSON.stringify({
                type: 'update',
                clientId: clientId,
                position: {
                    x: box.position.x,
                    y: box.position.y,
                    z: box.position.z
                },
                rotation: {
                    x: box.rotationQuaternion.x,
                    y: box.rotationQuaternion.y,
                    z: box.rotationQuaternion.z,
                    w: box.rotationQuaternion.w
                }
            }));
        }
    });

    return scene;
}

createScene().then(scene => {
    engine.runRenderLoop(function () {
        scene.render();
    });
});

window.addEventListener('resize', function () {
    engine.resize();
});