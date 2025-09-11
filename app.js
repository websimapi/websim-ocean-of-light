import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Water } from 'three/addons/objects/Water.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { WebsimSocket } from '@websim/websim-socket';

const COLLECTION_NAME = 'candle_paths_v1';
const UPDATE_INTERVAL_MS = 15000; // 15 seconds

let camera, scene, renderer;
let controls, water, sun;
let raycaster, mouse;

const room = new WebsimSocket();
let currentUser = null;
let userCandleData = { id: null, candles_data: [] }; // { id: candle_id, path: [{x,y,z,t}] }
const sceneCandles = new Map(); // Map<user_id, Map<candle_id, THREE.Object3D>>

init();

async function init() {
    currentUser = await window.websim.getCurrentUser();

    const container = document.getElementById('container');

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.5;
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 20000);
    camera.position.set(30, 30, 100);

    sun = new THREE.Vector3();

    const waterGeometry = new THREE.PlaneGeometry(10000, 10000);
    water = new Water(waterGeometry, {
        textureWidth: 512,
        textureHeight: 512,
        waterNormals: new THREE.TextureLoader().load('https://threejs.org/examples/textures/waternormals.jpg', function (texture) {
            texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        }),
        sunDirection: new THREE.Vector3(),
        sunColor: 0xffffff,
        waterColor: 0x001e0f,
        distortionScale: 3.7,
        fog: scene.fog !== undefined
    });
    water.rotation.x = -Math.PI / 2;
    scene.add(water);

    const sky = new Sky();
    sky.scale.setScalar(10000);
    scene.add(sky);
    const skyUniforms = sky.material.uniforms;
    skyUniforms['turbidity'].value = 10;
    skyUniforms['rayleigh'].value = 2;
    skyUniforms['mieCoefficient'].value = 0.005;
    skyUniforms['mieDirectionalG'].value = 0.8;

    const parameters = {
        elevation: 2,
        azimuth: 180
    };
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    let renderTarget;
    function updateSun() {
        const phi = THREE.MathUtils.degToRad(90 - parameters.elevation);
        const theta = THREE.MathUtils.degToRad(parameters.azimuth);
        sun.setFromSphericalCoords(1, phi, theta);
        sky.material.uniforms['sunPosition'].value.copy(sun);
        water.material.uniforms['sunDirection'].value.copy(sun).normalize();
        if (renderTarget !== undefined) renderTarget.dispose();
        renderTarget = pmremGenerator.fromScene(sky);
        scene.environment = renderTarget.texture;
    }
    updateSun();
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.2);
    scene.add(ambientLight);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.target.set(0, 10, 0);
    controls.minDistance = 40.0;
    controls.maxDistance = 200.0;
    controls.update();

    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    window.addEventListener('resize', onWindowResize);
    window.addEventListener('click', onMouseClick, false);

    // Database logic
    await loadInitialData();
    subscribeToUpdates();
    setInterval(saveCurrentUserCandles, UPDATE_INTERVAL_MS);

    // Hide loader and start animation
    document.getElementById('loader').style.display = 'none';
    animate();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function onMouseClick(event) {
    event.preventDefault();

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(water);

    if (intersects.length > 0) {
        const point = intersects[0].point;
        addCandle(currentUser.id, currentUser.username, point, true);
    }
}

function createCandleObject(position) {
    const group = new THREE.Group();

    // Candle body
    const candleMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffdd,
        emissive: 0x444433,
        metalness: 0.1,
        roughness: 0.7,
    });
    const candleGeometry = new THREE.CylinderGeometry(0.5, 0.5, 2, 8);
    const candleMesh = new THREE.Mesh(candleGeometry, candleMaterial);
    candleMesh.position.y = 1;

    // Flame
    const flameLight = new THREE.PointLight(0xffaa33, 50, 20); // Increased intensity
    flameLight.position.y = 2.5;

    group.add(candleMesh);
    group.add(flameLight);
    
    group.position.copy(position);
    return group;
}

function addCandle(userId, username, position, isNew) {
    if (!sceneCandles.has(userId)) {
        sceneCandles.set(userId, new Map());
    }

    const candleId = `candle_${Date.now()}_${Math.random()}`;
    const candleObject = createCandleObject(position);
    scene.add(candleObject);
    sceneCandles.get(userId).set(candleId, candleObject);

    if (isNew && userId === currentUser.id) {
        userCandleData.candles_data.push({
            id: candleId,
            path: [{ x: position.x, y: position.y, z: position.z, t: Date.now() }]
        });
        // Immediate save on new candle creation
        saveCurrentUserCandles();
    }
}


function updateSceneFromData(allData) {
    const allUsersData = new Map(allData.map(d => [d.id, d.candles_data]));

    // Remove candles for users who are no longer in the data
    for (const userId of sceneCandles.keys()) {
        if (!allUsersData.has(userId)) {
            sceneCandles.get(userId).forEach(candleObj => scene.remove(candleObj));
            sceneCandles.delete(userId);
        }
    }
    
    allUsersData.forEach((candles, userId) => {
        if (!sceneCandles.has(userId)) {
            sceneCandles.set(userId, new Map());
        }
        const userSceneCandles = sceneCandles.get(userId);
        const userDbCandles = new Map(candles.map(c => [c.id, c]));

        // Remove candles that no longer exist for the user
        for (const candleId of userSceneCandles.keys()) {
            if (!userDbCandles.has(candleId)) {
                scene.remove(userSceneCandles.get(candleId));
                userSceneCandles.delete(candleId);
            }
        }

        // Add or update candles
        userDbCandles.forEach((candleData, candleId) => {
            const lastPos = candleData.path[candleData.path.length - 1];
            if (!lastPos) return;

            if (userSceneCandles.has(candleId)) {
                // Candle exists, update its position if needed (for future movement)
                userSceneCandles.get(candleId).position.set(lastPos.x, lastPos.y, lastPos.z);
            } else {
                // New candle
                const candleObject = createCandleObject(new THREE.Vector3(lastPos.x, lastPos.y, lastPos.z));
                scene.add(candleObject);
                userSceneCandles.set(candleId, candleObject);
            }
        });
    });

    updateLeaderboard(allUsersData);
}

let leaderboardUnsubscribe = null;
function updateLeaderboard(allUsersData) {
    if (leaderboardUnsubscribe) {
        leaderboardUnsubscribe();
        leaderboardUnsubscribe = null;
    }
    const leaderboardList = document.getElementById('leaderboard-list');
    
    const userIds = Array.from(allUsersData.keys());
    if (userIds.length === 0) {
        leaderboardList.innerHTML = '<li>No candles yet.</li>';
        return;
    }

    leaderboardUnsubscribe = room.query(`SELECT id, username FROM public.user WHERE id = ANY($1::uuid[])`, [userIds]).subscribe(userData => {
        if (!userData) return;
        const userMap = new Map(userData.map(u => [u.id, u.username]));

        const leaderboardData = [];
        allUsersData.forEach((candles, userId) => {
            if (userMap.has(userId)) {
                leaderboardData.push({ username: userMap.get(userId), count: candles.length });
            }
        });

        leaderboardData.sort((a, b) => b.count - a.count);

        leaderboardList.innerHTML = '';
        leaderboardData.forEach(item => {
            const li = document.createElement('li');
            li.innerHTML = `<span class="username">${item.username}</span><span class="count">${item.count} candles</span>`;
            leaderboardList.appendChild(li);
        });

        if (leaderboardData.length === 0) {
            leaderboardList.innerHTML = '<li>No candles yet.</li>';
        }
    });
}


async function loadInitialData() {
    const allData = await room.collection(COLLECTION_NAME).getList();
    
    // Find current user's data
    const existingUserData = allData.find(d => d.id === currentUser.id);
    if (existingUserData) {
        userCandleData = existingUserData;
    } else {
        userCandleData.id = currentUser.id;
    }
    
    updateSceneFromData(allData);
}

function subscribeToUpdates() {
    room.collection(COLLECTION_NAME).subscribe(allData => {
        updateSceneFromData(allData);
    });
}

async function saveCurrentUserCandles() {
    if (!currentUser || userCandleData.candles_data.length === 0) {
        return;
    }
    
    // Append current positions to path
    userCandleData.candles_data.forEach(candle => {
        const candleObject = sceneCandles.get(currentUser.id)?.get(candle.id);
        if (candleObject) {
            const pos = candleObject.position;
            candle.path.push({ x: pos.x, y: pos.y, z: pos.z, t: Date.now() });
        }
    });

    try {
        await room.collection(COLLECTION_NAME).upsert(userCandleData);
    } catch (error) {
        console.error("Failed to save candle data:", error);
    }
}


function animate() {
    requestAnimationFrame(animate);
    render();
}

function render() {
    const time = performance.now() * 0.001;
    water.material.uniforms['time'].value += 1.0 / 60.0;

    // Bobbing candles
    sceneCandles.forEach(userCandles => {
        userCandles.forEach(candle => {
            const worldPos = new THREE.Vector3();
            candle.getWorldPosition(worldPos);
            // Simple sine wave for bobbing
            const yOffset = Math.sin(time * 2.0 + worldPos.x * 0.1 + worldPos.z * 0.1) * 0.2;
            candle.position.y = yOffset;
        });
    });

    renderer.render(scene, camera);
}