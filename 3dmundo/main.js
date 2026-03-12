import * as BABYLON from '@babylonjs/core';

const canvas = document.getElementById('renderCanvas');

const engine = new BABYLON.Engine(canvas);

const createScene = function () {
    const scene = new BABYLON.Scene(engine);

    scene.createDefaultCameraOrLight(true, false, true);

    // const box = new BABYLON.MeshBuilder.CreateBox("mybox", {
    //     size: 2,
    //     width: 7,   
    //     height: 0.2,
    //     depth: 7,
    //     faceColors:[
    //         new BABYLON.Color4(1, 0, 0, 1),
    //     ]
    // });
    
    // const sphere = new BABYLON.MeshBuilder.CreateSphere("mysphere", {
    //     segments: 3,
    // }, scene);

    // const ground = new BABYLON.MeshBuilder.CreateGround("myground", {
    //     height: 10,
    //     width: 10,
    //     subdivisions: 30
    // })
    // ground.material = new BABYLON.StandardMaterial();
    // ground.material.wireframe = true;

    const groundFromHeightMap = new BABYLON.MeshBuilder.CreateGroundFromHeightMap("myground", "/profundidade.jpg", {
        width: 10,
        height: 10,
        subdivisions: 50,
        maxHeight: 1.5
    });

    groundFromHeightMap.material = new BABYLON.StandardMaterial();
    groundFromHeightMap.material.wireframe = true;
    return scene;
}

const scene = createScene();

engine.runRenderLoop(function () {
    scene.render();
});

window.addEventListener('resize', function () {
    engine.resize();
});