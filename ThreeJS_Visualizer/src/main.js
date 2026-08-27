import "./style.css";
import * as GaussianSplats3D from "@mkkellogg/gaussian-splats-3d";
import * as THREE from "three";
import GUI from "lil-gui";

const appEl = document.getElementById("app");
const statusEl = document.getElementById("status");
const uiEl = document.getElementById("ui");
const fileInput = document.getElementById("plyInput");
const urlInput = document.getElementById("plyUrl");
const loadUrlBtn = document.getElementById("loadUrl");
const resetViewBtn = document.getElementById("resetView");
const helpToggleBtn = document.getElementById("helpToggle");
const helpPanelEl = document.getElementById("helpPanel");
const triggerDebugEl = document.getElementById("triggerDebug");

const initialCameraPosition = [0, 80, 0];
//Distance of camera from center
const initialCameraLookAt = [0, 0, 0];

const viewerOptions = {
    selfDrivenMode: true,
    renderer: "internal",
    camera: "internal",
    useBuiltInControls: true,
    // fix the camera rotations controls
    ignoreDevicePixelRatio: false,
    gpuAcceleratedSort: false,
    enableSIMDInSort: false,
    sharedMemoryForWorkers: false,
    integerBasedSort: false,
    halfPrecisionCovariancesOnGPU: false,
    dynamicScene: false,
    webXRMode: GaussianSplats3D.WebXRMode.None,
    renderMode: GaussianSplats3D.RenderMode.Always,
    sceneRevealMode: GaussianSplats3D.SceneRevealMode.Gradual,
    antialiased: true,
    focalAdjustment: 1.0,
    logLevel: GaussianSplats3D.LogLevel.None,
    sphericalHarmonicsDegree: 0,
    enableOptionalEffects: false,
    inMemoryCompressionLevel: 0,
    freeIntermediateSplatData: false,
    waveAnimationMode: "Sin Wave",
    sinWaveAmplitude: 0.2,
    sinWaveFrequency: 0.26,
    waveDisplacementAxis: "xyz",
    cameraMovement: true,
    cameraMovementMode: "pulley",
    pulleyTestValue: -10,
    descendTestState: false,
    // mirrors OSC /trigger so the POV sweep can be exercised without the pd patch
    cameraMovementSpeed: 0.7,
    proximityRevealMode: true,
    proximityRevealWindowSize: 10,
    circularProjection: true,
};

const gui = new GUI({ title: "Viewer" });
let viewer = null;
let dynamicSceneController = null;
let sharedMemoryController = null;
let manualLoopId = 0;

let objectUrl = null;
let lastLoadedScene = null;
let fallbackInProgress = false;
let rebuildInProgress = false;
let operationQueue = Promise.resolve();
let lastWorkingViewerOptions = { ...viewerOptions };
let animationStartTime = Date.now();
let globalAnimationFrameId = 0;
let cameraMovementStartTime = Date.now();
const pulleyCameraRange = {
    rawTop: -14,
    //check that csv data fits these parameters
    rawBottom: 6,
    yTop: 73,
    yBottom: 0,
};
const pulleySmoothingFactor = 1;
// the lower, the smoother

// The camera is pinned to the Y axis (applyCameraMovement only writes .y), and
// so are both POV targets — (0, 80, 0) and the origin. Lerping controls.target
// between two points on that same axis is degenerate: every intermediate target
// is still on the axis, so the camera looks straight up or straight down with no
// angle in between, and flips 180 degrees in a single frame the moment the
// target crosses the camera's own Y.
//
// So the POV is driven as a swept *direction* instead. povAngle rotates in the
// Y-Z plane: 0 = straight up (equivalent to looking at (0, 80, 0)), PI =
// straight down (equivalent to looking at the origin). Sweeping the angle takes
// the camera through the horizon, which is the visible rotation that lerping the
// target point could never produce.
const povAngleUp = 0;
const povAngleDown = Math.PI;
const lookTargetSwitchY = 52;
const lookTargetSwitchHysteresis = 3;
// buffer above lookTargetSwitchY before the downward latch is released again
const lookSweepDuration = 5000;
// ms for the full 180-degree sweep, both directions
const lookDistance = 60;
// how far in front of the camera controls.target sits. Orientation-only, so the
// value is not visible; it just keeps OrbitControls' spherical radius off zero.
const lookSweepThroughZ = 1;
// which horizon side the sweep passes through; flip to -1 to reverse the arc

let povAngle = povAngleUp;
let povAngleFrom = povAngleUp;
let povAngleTo = povAngleUp;
let povSweepStart = null;
let povSweepDuration = lookSweepDuration;
let povLatchedDown = false;
let povInitialized = false;
const povDirection = new THREE.Vector3();

let projectionUiVisible = false;
let projectionModeController = null;

function startGlobalAnimationLoop() {
    if (globalAnimationFrameId) {
        cancelAnimationFrame(globalAnimationFrameId);
    }
    const tick = () => {
        applyWaveAnimation();
        applyCameraMovement();
        applyCameraLookTarget();
        applyProximityReveal();
        updateTriggerDebug();
        globalAnimationFrameId = requestAnimationFrame(tick);
    };
    globalAnimationFrameId = requestAnimationFrame(tick);
}

let lastTriggerDebugText = null;

// Always-visible readout of the raw OSC /trigger value next to how the
// visualiser is interpreting it, so a mismatch between what pd sends and what
// the camera does is obvious without opening the console.
function updateTriggerDebug() {
    if (!triggerDebugEl) {
        return;
    }

    const rawValue = window.__pulleyTrigger?.value;
    let text;
    let className;

    if (!Number.isFinite(rawValue)) {
        text = "Trigger: — (no OSC yet)";
        className = "trigger-none";
    } else {
        const descending = isDescending();
        text = `Trigger: ${rawValue} — ${descending ? "descend" : "ascend"}`;
        className = descending ? "trigger-descend" : "trigger-ascend";
    }

    // Only touch the DOM when the text actually changes; this runs every frame.
    if (text === lastTriggerDebugText) {
        return;
    }
    lastTriggerDebugText = text;
    triggerDebugEl.textContent = text;
    triggerDebugEl.className = className;
}

function refreshGuiDisplay() {
    if (typeof gui.controllersRecursive === "function") {
        gui.controllersRecursive().forEach((controller) =>
            controller.updateDisplay(),
        );
    }
}

function setProjectionUiVisible(visible) {
    projectionUiVisible = visible;

    if (uiEl) {
        uiEl.style.display = visible ? "" : "none";
    }

    if (helpPanelEl) {
        helpPanelEl.hidden = !visible;
    }

    if (triggerDebugEl) {
        triggerDebugEl.hidden = !visible;
    }

    if (helpToggleBtn) {
        helpToggleBtn.setAttribute("aria-expanded", String(visible));
    }

    if (gui?.domElement) {
        gui.domElement.style.display = visible ? "" : "none";
    }
}

function toggleProjectionUi() {
    setProjectionUiVisible(!projectionUiVisible);
}

function setCircularProjectionVisible(visible) {
    viewerOptions.circularProjection = visible;

    if (appEl) {
        appEl.classList.toggle("projection-circular", visible);
    }

    if (projectionModeController) {
        projectionModeController.updateDisplay();
    }
}

function toggleCircularProjectionVisible() {
    setCircularProjectionVisible(!viewerOptions.circularProjection);
}

function queueViewerOperation(operation) {
    operationQueue = operationQueue.then(
        () => operation(),
        () => operation(),
    );
    return operationQueue;
}

function isSharedMemorySupported() {
    return globalThis.crossOriginIsolated === true;
}

function getEffectiveSharedMemoryForWorkers() {
    return viewerOptions.sharedMemoryForWorkers && isSharedMemorySupported();
}

function getEffectiveDynamicSafeOptions() {
    if (!viewerOptions.dynamicScene) {
        return {
            gpuAcceleratedSort: viewerOptions.gpuAcceleratedSort,
            enableSIMDInSort: viewerOptions.enableSIMDInSort,
            sharedMemoryForWorkers: getEffectiveSharedMemoryForWorkers(),
            integerBasedSort: viewerOptions.integerBasedSort,
        };
    }

    return {
        gpuAcceleratedSort: false,
        enableSIMDInSort: false,
        sharedMemoryForWorkers: false,
        integerBasedSort: false,
    };
}

function getEnumOptions(enumObj) {
    const options = {};
    for (const key of Object.keys(enumObj)) {
        if (!Number.isNaN(Number(key))) {
            continue;
        }
        const value = enumObj[key];
        if (typeof value === "number") {
            options[key] = value;
        }
    }
    return options;
}

function stopManualLoop() {
    if (manualLoopId) {
        cancelAnimationFrame(manualLoopId);
        manualLoopId = 0;
    }
}

function applyWaveAnimation() {
    if (!viewer) {
        return;
    }
    const splatMesh = viewer.splatMesh;
    if (!splatMesh?.material?.uniforms) {
        return;
    }

    const isEnabled = viewerOptions.waveAnimationMode !== "off";
    if (splatMesh.material.uniforms.waveEnabled) {
        splatMesh.material.uniforms.waveEnabled.value = isEnabled ? 1 : 0;
    }
    if (!isEnabled) {
        return;
    }

    const elapsed = (Date.now() - animationStartTime) * 0.001;

    // Update wave uniforms if they exist
    if (splatMesh.material.uniforms.waveTime) {
        splatMesh.material.uniforms.waveTime.value = elapsed;
        splatMesh.material.uniforms.waveAmplitude.value =
            viewerOptions.sinWaveAmplitude;
        splatMesh.material.uniforms.waveFrequency.value =
            viewerOptions.sinWaveFrequency;
        if (splatMesh.material.uniforms.waveMode) {
            splatMesh.material.uniforms.waveMode.value =
                viewerOptions.waveAnimationMode === "perlin" ? 1 : 0;
        }
        if (splatMesh.material.uniforms.waveAxisMask) {
            const axis = viewerOptions.waveDisplacementAxis;
            const mask = {
                x: [1, 0, 0],
                y: [0, 1, 0],
                z: [0, 0, 1],
                xyz: [1, 1, 1],
            }[axis] || [0, 1, 0];
            splatMesh.material.uniforms.waveAxisMask.value.set(
                mask[0],
                mask[1],
                mask[2],
            );
        }
    }
}

function applyCameraMovement() {
    if (!viewer || !viewer.camera || !viewerOptions.cameraMovement) {
        return;
    }

    if (viewerOptions.cameraMovementMode === "pulley") {
        const pulley = window.__pulley;
        if (!pulley || !Number.isFinite(pulley.value)) {
            return;
        }

        const rawValue = Math.max(
            Math.min(pulley.value, pulleyCameraRange.rawBottom),
            pulleyCameraRange.rawTop,
        );
        const normalized =
            (rawValue - pulleyCameraRange.rawTop) /
            (pulleyCameraRange.rawBottom - pulleyCameraRange.rawTop);
        const newY =
            pulleyCameraRange.yBottom +
            normalized * (pulleyCameraRange.yTop - pulleyCameraRange.yBottom);

        // Smooth the camera response without altering the raw OSC value.
        viewer.camera.position.y +=
            (newY - viewer.camera.position.y) * pulleySmoothingFactor;

        viewer.camera.position.y = Math.max(
            Math.min(viewer.camera.position.y, pulleyCameraRange.yTop),
            pulleyCameraRange.yBottom,
        );

        return;
    }

    const startY = 80;
    const endY = 0;
    const totalDistance = Math.abs(startY - endY);
    const cycleDuration =
        (totalDistance / viewerOptions.cameraMovementSpeed) * 2;

    const elapsed = (Date.now() - cameraMovementStartTime) * 0.001;
    const cyclePosition = (elapsed % cycleDuration) / cycleDuration;

    const smoothProgress = Math.abs(Math.sin(cyclePosition * Math.PI));

    const newY = startY - totalDistance * smoothProgress;
    viewer.camera.position.y = Math.max(Math.min(newY, startY), endY);
}

function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Park controls.target a fixed distance ahead of the camera along povAngle.
// OrbitControls recomputes position as target + offset, which resolves back to
// the camera's current position, so this never fights applyCameraMovement.
function applyPovAngleToTarget() {
    povDirection.set(
        0,
        Math.cos(povAngle),
        Math.sin(povAngle) * lookSweepThroughZ,
    );
    viewer.controls.target
        .copy(viewer.camera.position)
        .addScaledVector(povDirection, lookDistance);
    viewer.controls.update();
}

// buoyData.pd's "toggle journey" sends /trigger 1 to start the descent and
// /trigger 0 to return to the surface, relayed to window.__pulleyTrigger by the
// OSC listener in index.html.
function isDescending() {
    return window.__pulleyTrigger?.active === true;
}

// The angle the POV should rest at, given the trigger state and camera height.
// Also advances povLatchedDown, which is what makes the descent flip one-way.
function getDesiredPovAngle(cameraY) {
    if (!isDescending()) {
        // Ascending: look at the surface regardless of where the camera is.
        povLatchedDown = false;
        return povAngleUp;
    }

    if (cameraY <= lookTargetSwitchY) {
        // Latched for the rest of the descent, so wave noise around the
        // threshold can't flip the POV back and forth.
        povLatchedDown = true;
    } else if (cameraY > lookTargetSwitchY + lookTargetSwitchHysteresis) {
        povLatchedDown = false;
    }

    return povLatchedDown ? povAngleDown : povAngleUp;
}

function applyCameraLookTarget() {
    if (!viewer || !viewer.camera || !viewer.controls) {
        return;
    }

    const desiredAngle = getDesiredPovAngle(viewer.camera.position.y);

    if (!povInitialized) {
        // Start already facing the right way rather than sweeping on load.
        povAngle = desiredAngle;
        povAngleFrom = desiredAngle;
        povAngleTo = desiredAngle;
        povInitialized = true;
    } else if (desiredAngle !== povAngleTo) {
        // Sweeping from the current angle keeps a reversal mid-sweep smooth.
        povAngleFrom = povAngle;
        povAngleTo = desiredAngle;
        povSweepStart = Date.now();
        // Scale by how far there is to go so the rotation speed stays constant:
        // a full flip takes lookSweepDuration, a part-way reversal takes less.
        povSweepDuration =
            (lookSweepDuration * Math.abs(povAngleTo - povAngleFrom)) /
            Math.PI;
    }

    if (povSweepStart !== null && povSweepDuration > 0) {
        const progress = Math.min(
            (Date.now() - povSweepStart) / povSweepDuration,
            1,
        );
        povAngle =
            povAngleFrom +
            (povAngleTo - povAngleFrom) * easeInOutCubic(progress);
        if (progress >= 1) {
            povAngle = povAngleTo;
            povSweepStart = null;
        }
    }

    applyPovAngleToTarget();
}

function applyProximityReveal() {
    if (!viewer || !viewer.camera) {
        return;
    }

    const splatMesh = viewer.splatMesh;
    if (!splatMesh?.material?.uniforms) {
        return;
    }

    if (splatMesh.material.uniforms.cameraY) {
        splatMesh.material.uniforms.cameraY.value = viewer.camera.position.y;
    }
    if (splatMesh.material.uniforms.proximityRevealEnabled) {
        splatMesh.material.uniforms.proximityRevealEnabled.value =
            viewerOptions.proximityRevealMode ? 1 : 0;
    }
    if (splatMesh.material.uniforms.proximityRevealWindowSize) {
        splatMesh.material.uniforms.proximityRevealWindowSize.value =
            viewerOptions.proximityRevealWindowSize;
    }
}

// Patch the splat material shader to add wave displacement and proximity reveal
function patchSplatShader() {
    const splatMesh = viewer?.splatMesh;
    if (!splatMesh?.material) {
        console.log("No splatMesh material to patch");
        return;
    }

    // Check if already patched
    if (splatMesh.material.uniforms.waveTime) {
        console.log("Shader already patched");
        return;
    }

    // Add wave uniforms
    splatMesh.material.uniforms.waveTime = { value: 0.0 };
    splatMesh.material.uniforms.waveAmplitude = { value: 0.0 };
    splatMesh.material.uniforms.waveFrequency = { value: 1.0 };
    splatMesh.material.uniforms.waveEnabled = { value: 0 };
    splatMesh.material.uniforms.waveMode = { value: 0 };
    splatMesh.material.uniforms.waveAxisMask = {
        value: new THREE.Vector3(0, 1, 0),
    };

    // Add proximity reveal uniforms
    splatMesh.material.uniforms.cameraY = { value: 0.0 };
    splatMesh.material.uniforms.proximityRevealEnabled = { value: 0 };
    splatMesh.material.uniforms.proximityRevealWindowSize = { value: 20.0 };

    // Get current shader source
    const originalVertexShader = splatMesh.material.vertexShader;

    // Add wave uniform declarations after existing uniforms
    const uniformDeclarations = `
        uniform float waveTime;
        uniform float waveAmplitude;
        uniform float waveFrequency;
        uniform int waveEnabled;
        uniform int waveMode;
        uniform vec3 waveAxisMask;
        uniform float cameraY;
        uniform int proximityRevealEnabled;
        uniform float proximityRevealWindowSize;

        float waveHash(vec3 p) {
            return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
        }

        float perlinNoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            vec3 u = f * f * (3.0 - 2.0 * f);

            float n000 = waveHash(i + vec3(0.0, 0.0, 0.0));
            float n100 = waveHash(i + vec3(1.0, 0.0, 0.0));
            float n010 = waveHash(i + vec3(0.0, 1.0, 0.0));
            float n110 = waveHash(i + vec3(1.0, 1.0, 0.0));
            float n001 = waveHash(i + vec3(0.0, 0.0, 1.0));
            float n101 = waveHash(i + vec3(1.0, 0.0, 1.0));
            float n011 = waveHash(i + vec3(0.0, 1.0, 1.0));
            float n111 = waveHash(i + vec3(1.0, 1.0, 1.0));

            float nx00 = mix(n000, n100, u.x);
            float nx10 = mix(n010, n110, u.x);
            float nx01 = mix(n001, n101, u.x);
            float nx11 = mix(n011, n111, u.x);
            float nxy0 = mix(nx00, nx10, u.y);
            float nxy1 = mix(nx01, nx11, u.y);

            return mix(nxy0, nxy1, u.z) * 2.0 - 1.0;
        }
    `;

    // Wave displacement code to inject after splatCenter is computed
    const waveDisplacement = `
        // Wave displacement effect
        if (waveEnabled == 1 && waveAmplitude > 0.0) {
            float wave = 0.0;
            if (waveMode == 0) {
                float dist = length(splatCenter.xz);
                wave = sin(waveTime * waveFrequency + dist * 2.0) * waveAmplitude;
            } else if (waveMode == 1) {
                vec3 noisePos = vec3(splatCenter.x, splatCenter.z, waveTime) * waveFrequency;
                wave = perlinNoise(noisePos) * waveAmplitude;
            }
            splatCenter += waveAxisMask * wave;
        }
    `;

    // Proximity reveal code for fragment shader
    const proximityRevealDeclaration = `
        varying float revealAlpha;
    `;

    const proximityRevealVertexCode = `
        // Proximity reveal calculation in vertex shader
        float distanceFromCamera = abs(splatCenter.y - cameraY);
        revealAlpha = 1.0 - smoothstep(0.0, proximityRevealWindowSize, distanceFromCamera);
        revealAlpha = mix(1.0, revealAlpha, float(proximityRevealEnabled));
    `;

    const proximityRevealFragmentCode = `
        // Apply proximity reveal to alpha
        gl_FragColor.a *= revealAlpha;
    `;

    // Inject uniform declarations at the start (after precision)
    let patchedShader = originalVertexShader.replace(
        "precision highp float;",
        "precision highp float;\n" +
            uniformDeclarations +
            "\n" +
            proximityRevealDeclaration,
    );

    // Inject wave displacement after splatCenter is computed
    // The line is: vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));
    patchedShader = patchedShader.replace(
        "vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));",
        "vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));\n" +
            waveDisplacement +
            proximityRevealVertexCode,
    );

    // Get and patch fragment shader
    const originalFragmentShader = splatMesh.material.fragmentShader;
    let patchedFragmentShader = originalFragmentShader.replace(
        "precision highp float;",
        "precision highp float;\n" + proximityRevealDeclaration,
    );

    // Inject proximity reveal code at the end
    patchedFragmentShader = patchedFragmentShader.replace(
        /\}[\s]*$/,
        proximityRevealFragmentCode + "\n}",
    );

    // Apply patched shaders
    splatMesh.material.vertexShader = patchedShader;
    splatMesh.material.fragmentShader = patchedFragmentShader;
    splatMesh.material.needsUpdate = true;

    console.log(
        "Shader patched successfully for wave animation and proximity reveal",
    );
}

function startManualLoop(instance) {
    const tick = () => {
        if (viewer !== instance) {
            return;
        }
        applyWaveAnimation();
        if (typeof instance.update === "function") {
            instance.update();
        }
        if (typeof instance.render === "function") {
            instance.render();
        }
        manualLoopId = requestAnimationFrame(tick);
    };
    manualLoopId = requestAnimationFrame(tick);
}

function createViewer() {
    stopManualLoop();
    const safeOptions = getEffectiveDynamicSafeOptions();

    const instance = new GaussianSplats3D.Viewer({
        rootElement: appEl,
        cameraUp: [-1, 0, 0],
        initialCameraPosition,
        initialCameraLookAt,
        selfDrivenMode: viewerOptions.selfDrivenMode,
        renderer:
            viewerOptions.renderer === "internal"
                ? undefined
                : viewerOptions.renderer,
        camera:
            viewerOptions.camera === "internal"
                ? undefined
                : viewerOptions.camera,
        useBuiltInControls: viewerOptions.useBuiltInControls,
        ignoreDevicePixelRatio: viewerOptions.ignoreDevicePixelRatio,
        gpuAcceleratedSort: safeOptions.gpuAcceleratedSort,
        enableSIMDInSort: safeOptions.enableSIMDInSort,
        sharedMemoryForWorkers: safeOptions.sharedMemoryForWorkers,
        integerBasedSort: safeOptions.integerBasedSort,
        halfPrecisionCovariancesOnGPU:
            viewerOptions.halfPrecisionCovariancesOnGPU,
        dynamicScene: viewerOptions.dynamicScene,
        webXRMode: viewerOptions.webXRMode,
        renderMode: viewerOptions.renderMode,
        sceneRevealMode: viewerOptions.sceneRevealMode,
        sceneFadeInRateMultiplier: 1.0,
        antialiased: viewerOptions.antialiased,
        focalAdjustment: viewerOptions.focalAdjustment,
        logLevel: viewerOptions.logLevel,
        sphericalHarmonicsDegree: viewerOptions.sphericalHarmonicsDegree,
        enableOptionalEffects: viewerOptions.enableOptionalEffects,
        inMemoryCompressionLevel: viewerOptions.inMemoryCompressionLevel,
        freeIntermediateSplatData: viewerOptions.freeIntermediateSplatData,
        splatSortDistanceMapPrecision: viewerOptions.dynamicScene ? 12 : 16,
    });

    // gaussian-splats-3d's built-in click handler recenters the orbit target
    // on the clicked splat; overriding it here disables that. Drag-to-orbit,
    // drag-to-pan, and scroll-to-zoom are separate, handled by OrbitControls
    // below.
    instance.onMouseClick = () => {};

    // Both perspectiveControls and orthographicControls exist simultaneously
    // and the viewer swaps this.controls between them when orthographic mode
    // is toggled (O key), so disable on both to survive that swap.
    for (const controls of [
        instance.perspectiveControls,
        instance.orthographicControls,
    ]) {
        if (controls) {
            controls.enableRotate = false;
            controls.enablePan = false;
            controls.enableZoom = false;
        }
    }

    if (viewerOptions.selfDrivenMode) {
        instance.start();
    } else {
        startManualLoop(instance);
    }

    // Dev-only handle for inspecting camera/controls from the console; Vite
    // strips this from production builds.
    if (import.meta.env.DEV) {
        window.__viewer = instance;
    }

    return instance;
}

viewer = createViewer();
applyPovAngleToTarget();

// Start global animation loop for wave effect
startGlobalAnimationLoop();

function inferSceneFormat(sourceName) {
    const lowerName = sourceName.toLowerCase();
    if (lowerName.endsWith(".ksplat")) {
        return GaussianSplats3D.SceneFormat.KSplat;
    }
    if (lowerName.endsWith(".splat")) {
        return GaussianSplats3D.SceneFormat.Splat;
    }
    return GaussianSplats3D.SceneFormat.Ply;
}

async function clearExistingScene() {
    if (!viewer) {
        return;
    }

    const sceneCount = viewer.getSceneCount();
    if (sceneCount < 1) {
        return;
    }

    const indexes = [];
    for (let index = 0; index < sceneCount; index++) {
        indexes.push(index);
    }

    await viewer.removeSplatScenes(indexes, false);
}

async function loadSplatScene(path, label, format) {
    if (!viewer) {
        viewer = createViewer();
    }

    statusEl.textContent = `Loading ${label}...`;
    await clearExistingScene();
    viewer.sceneRevealMode = viewerOptions.sceneRevealMode;
    await viewer.addSplatScene(path, {
        format,
        showLoadingUI: true,
    });

    // Patch shader for wave animation
    patchSplatShader();

    // Reset animation timer when loading new scene
    animationStartTime = Date.now();
    cameraMovementStartTime = Date.now();

    statusEl.textContent = `${label} loaded`;
}

async function reloadLastScene() {
    if (!lastLoadedScene) {
        statusEl.textContent = "No file loaded";
        return;
    }

    if (lastLoadedScene.type === "url") {
        await loadSplatFromUrlInternal(lastLoadedScene.sourceUrl, {
            persistLastScene: false,
        });
        return;
    }

    if (lastLoadedScene.type === "file") {
        await loadSplatFromFileInternal(lastLoadedScene.file, {
            persistLastScene: false,
        });
        return;
    }

    statusEl.textContent = "No file loaded";
}

async function rebuildViewer() {
    if (rebuildInProgress) {
        return;
    }
    rebuildInProgress = true;

    statusEl.textContent = "Rebuilding viewer...";

    try {
        if (
            viewerOptions.sharedMemoryForWorkers &&
            !isSharedMemorySupported()
        ) {
            viewerOptions.sharedMemoryForWorkers = false;
            if (sharedMemoryController) {
                sharedMemoryController.updateDisplay();
            }
            statusEl.textContent =
                "Shared memory disabled: crossOriginIsolated is required";
        }

        const previousViewer = viewer;
        viewer = null;

        if (previousViewer) {
            stopManualLoop();
            try {
                await previousViewer.dispose();
            } catch (error) {
                console.warn(
                    "Viewer dispose failed during rebuild, continuing with fresh instance.",
                    error,
                );
            }
        }

        viewer = createViewer();

        if (lastLoadedScene) {
            await reloadLastScene();
        } else {
            statusEl.textContent = "No file loaded";
        }
    } finally {
        rebuildInProgress = false;
    }
}

async function fallbackFromDynamicMode(reason) {
    if (!viewerOptions.dynamicScene || fallbackInProgress) {
        return;
    }

    fallbackInProgress = true;
    try {
        viewerOptions.dynamicScene = false;
        if (dynamicSceneController) {
            dynamicSceneController.updateDisplay();
        }
        statusEl.textContent = `Dynamic Scene disabled (${reason})`;
        await queueViewerOperation(async () => {
            await rebuildViewer();
        });
    } catch (error) {
        statusEl.textContent = "Failed to recover from dynamic mode error";
        console.error(error);
    } finally {
        fallbackInProgress = false;
    }
}

function isMemoryBoundsErrorMessage(message) {
    if (!message) {
        return false;
    }
    return String(message)
        .toLowerCase()
        .includes("memory access out of bounds");
}

function resetView() {
    if (!viewer.camera || !viewer.controls) {
        return;
    }

    viewer.camera.position.fromArray(initialCameraPosition);
    // Face the surface again, and let the next frame re-derive the POV from the
    // live trigger state rather than sweeping away from a stale angle.
    povAngle = povAngleUp;
    povSweepStart = null;
    povLatchedDown = false;
    povInitialized = false;
    applyPovAngleToTarget();
}

async function loadSplatFromUrl(url) {
    return loadSplatFromUrlInternal(url, { persistLastScene: true });
}

async function loadSplatFromUrlInternal(
    url,
    options = { persistLastScene: true },
) {
    const targetUrl = url.trim();
    if (!targetUrl) {
        statusEl.textContent = "Enter a scene URL first";
        return;
    }

    try {
        const sceneName = targetUrl.split("/").pop() || targetUrl;
        const format = inferSceneFormat(sceneName);

        const response = await fetch(targetUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (
            format === GaussianSplats3D.SceneFormat.KSplat &&
            arrayBuffer.byteLength < 4096
        ) {
            throw new Error(
                "Invalid KSplat data (file too small or wrong URL)",
            );
        }

        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
        }

        const blob = new Blob([arrayBuffer]);
        objectUrl = URL.createObjectURL(blob);

        await loadSplatScene(objectUrl, sceneName, format);

        if (options.persistLastScene) {
            lastLoadedScene = {
                type: "url",
                sourceUrl: targetUrl,
                label: sceneName,
                format,
            };
        }
    } catch (error) {
        statusEl.textContent = `Failed to load ${targetUrl} (${error.message || "invalid data"})`;
        console.error(error);
    }
}

async function loadSplatFromFile(file) {
    return loadSplatFromFileInternal(file, { persistLastScene: true });
}

async function loadSplatFromFileInternal(
    file,
    options = { persistLastScene: true },
) {
    if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
    }

    objectUrl = URL.createObjectURL(file);
    try {
        const format = inferSceneFormat(file.name);
        await loadSplatScene(objectUrl, file.name, format);

        if (options.persistLastScene) {
            lastLoadedScene = {
                type: "file",
                file,
                label: file.name,
                format,
            };
        }
    } catch (error) {
        statusEl.textContent = `Failed to load ${file.name}`;
        console.error(error);
    }
}

fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
        return;
    }

    await queueViewerOperation(async () => {
        await loadSplatFromFile(file);
    });
});

loadUrlBtn.addEventListener("click", () => {
    queueViewerOperation(async () => {
        await loadSplatFromUrl(urlInput.value);
    });
});

urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        queueViewerOperation(async () => {
            await loadSplatFromUrl(urlInput.value);
        });
    }
});

resetViewBtn.addEventListener("click", () => {
    resetView();
});

helpToggleBtn.addEventListener("click", () => {
    const isOpen = !helpPanelEl.hidden;
    helpPanelEl.hidden = isOpen;
    helpToggleBtn.setAttribute("aria-expanded", String(!isOpen));
});

const disabledLibraryShortcutCodes = new Set([
    "KeyC",
    "KeyU",
    "KeyP",
    "Equal",
    "Minus",
    "ArrowLeft",
    "ArrowRight",
    "KeyO",
]);

// Capture phase runs before gaussian-splats-3d's own window "keydown"
// listener (bubble phase), so stopping propagation here keeps its switch
// statement for these codes from ever running.
window.addEventListener(
    "keydown",
    (event) => {
        if (disabledLibraryShortcutCodes.has(event.code)) {
            event.stopImmediatePropagation();
        }
    },
    true,
);

window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (key !== "h" && key !== "x") {
        return;
    }

    const activeElement = document.activeElement;
    const isTypingTarget =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.isContentEditable === true;

    if (isTypingTarget) {
        return;
    }

    event.preventDefault();

    if (key === "h") {
        toggleProjectionUi();
    } else if (key === "x") {
        toggleCircularProjectionVisible();
    }
});

const advancedFolder = gui.addFolder("Advanced Options");

const rebuildOnChange = (controller) =>
    controller.onFinishChange(async () => {
        const rollbackOptions = { ...lastWorkingViewerOptions };

        try {
            await queueViewerOperation(async () => {
                await rebuildViewer();
            });
            lastWorkingViewerOptions = { ...viewerOptions };
        } catch (error) {
            Object.assign(viewerOptions, rollbackOptions);
            refreshGuiDisplay();
            statusEl.textContent =
                "Option failed; reverted to last working config";
            console.error(error);

            try {
                await queueViewerOperation(async () => {
                    await rebuildViewer();
                });
            } catch (recoveryError) {
                statusEl.textContent =
                    "Failed to recover viewer after rollback";
                console.error(recoveryError);
            }
        }
    });

rebuildOnChange(
    advancedFolder.add(viewerOptions, "selfDrivenMode").name("selfDrivenMode"),
);
advancedFolder
    .add(viewerOptions, "renderer", { internal: "internal" })
    .name("renderer");
advancedFolder
    .add(viewerOptions, "camera", { internal: "internal" })
    .name("camera");
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "useBuiltInControls")
        .name("useBuiltInControls"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "ignoreDevicePixelRatio")
        .name("ignoreDevicePixelRatio"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "gpuAcceleratedSort")
        .name("gpuAcceleratedSort"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "enableSIMDInSort")
        .name("enableSIMDInSort"),
);
sharedMemoryController = advancedFolder
    .add(viewerOptions, "sharedMemoryForWorkers")
    .name("sharedMemoryForWorkers");
rebuildOnChange(sharedMemoryController);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "integerBasedSort")
        .name("integerBasedSort"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "halfPrecisionCovariancesOnGPU")
        .name("halfPrecisionCovariancesOnGPU"),
);
dynamicSceneController = advancedFolder
    .add(viewerOptions, "dynamicScene")
    .name("dynamicScene");
rebuildOnChange(dynamicSceneController);
rebuildOnChange(
    advancedFolder
        .add(
            viewerOptions,
            "webXRMode",
            getEnumOptions(GaussianSplats3D.WebXRMode),
        )
        .name("webXRMode"),
);
rebuildOnChange(
    advancedFolder
        .add(
            viewerOptions,
            "renderMode",
            getEnumOptions(GaussianSplats3D.RenderMode),
        )
        .name("renderMode"),
);
rebuildOnChange(
    advancedFolder
        .add(
            viewerOptions,
            "sceneRevealMode",
            getEnumOptions(GaussianSplats3D.SceneRevealMode),
        )
        .name("sceneRevealMode"),
);
rebuildOnChange(
    advancedFolder.add(viewerOptions, "antialiased").name("antialiased"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "focalAdjustment", 0.1, 3, 0.01)
        .name("focalAdjustment"),
);
rebuildOnChange(
    advancedFolder
        .add(
            viewerOptions,
            "logLevel",
            getEnumOptions(GaussianSplats3D.LogLevel),
        )
        .name("logLevel"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "sphericalHarmonicsDegree", 0, 2, 1)
        .name("sphericalHarmonicsDegree"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "enableOptionalEffects")
        .name("enableOptionalEffects"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "inMemoryCompressionLevel", 0, 2, 1)
        .name("inMemoryCompressionLevel"),
);
rebuildOnChange(
    advancedFolder
        .add(viewerOptions, "freeIntermediateSplatData")
        .name("freeIntermediateSplatData"),
);

advancedFolder
    .add(viewerOptions, "waveAnimationMode", {
        Off: "off",
        "Sin Wave": "sin",
        "Perlin Noise": "perlin",
    })
    .name("Wave Animation")
    .onChange(() => {
        animationStartTime = Date.now();
        applyWaveAnimation();
    });
advancedFolder
    .add(viewerOptions, "waveDisplacementAxis", {
        X: "x",
        Y: "y",
        Z: "z",
        XYZ: "xyz",
    })
    .name("Displacement Axis")
    .onChange(() => {
        applyWaveAnimation();
    });
advancedFolder
    .add(viewerOptions, "sinWaveAmplitude", 0, 5, 0.01)
    .name("Wave Amplitude");
advancedFolder
    .add(viewerOptions, "sinWaveFrequency", 0.1, 10, 0.01)
    .name("Wave Frequency");

advancedFolder
    .add(viewerOptions, "cameraMovement")
    .name("Camera Movement")
    .onChange(() => {
        if (viewerOptions.cameraMovement) {
            cameraMovementStartTime = Date.now();
        }
    });
advancedFolder
    .add(viewerOptions, "cameraMovementMode", {
        Pulley: "pulley",
        Automatic: "automatic",
    })
    .name("Camera Mode");
advancedFolder
    .add(viewerOptions, "pulleyTestValue", -10, 1, 0.01)
    .name("Pulley Test Value")
    .onChange((value) => {
        if (!window.__pulley) {
            window.__pulley = {};
        }
        window.__pulley.value = value;
    });
advancedFolder
    .add(viewerOptions, "descendTestState")
    .name("Descending (trigger)")
    .onChange((value) => {
        if (!window.__pulleyTrigger) {
            window.__pulleyTrigger = {};
        }
        // Mirror the raw value too, so the debug readout reflects this control
        // the same way it reflects a real /trigger message.
        window.__pulleyTrigger.value = value ? 1 : 0;
        window.__pulleyTrigger.active = value;
    });
advancedFolder
    .add(viewerOptions, "cameraMovementSpeed", 0.1, 5, 0.1)
    .name("Camera Speed");

advancedFolder
    .add(viewerOptions, "proximityRevealMode")
    .name("Proximity Reveal");
advancedFolder
    .add(viewerOptions, "proximityRevealWindowSize", 5, 50, 1)
    .name("Reveal Window Size");

projectionModeController = advancedFolder
    .add(viewerOptions, "circularProjection")
    .name("Circular Projection")
    .onChange((value) => {
        setCircularProjectionVisible(value);
    });

advancedFolder.close();

setCircularProjectionVisible(viewerOptions.circularProjection);
setProjectionUiVisible(projectionUiVisible);

const defaultStartupUrl = (urlInput.value || "data/bubble.ksplat").trim();
if (defaultStartupUrl) {
    queueViewerOperation(async () => {
        await loadSplatFromUrl(defaultStartupUrl);
    }).catch(() => {
        statusEl.textContent = "No file loaded";
    });
}

window.addEventListener("error", (event) => {
    if (
        isMemoryBoundsErrorMessage(event?.message) ||
        isMemoryBoundsErrorMessage(event?.error?.message)
    ) {
        fallbackFromDynamicMode("WASM sort error");
    }
});

window.addEventListener("unhandledrejection", (event) => {
    const reasonMessage = event?.reason?.message || event?.reason;
    if (isMemoryBoundsErrorMessage(reasonMessage)) {
        fallbackFromDynamicMode("WASM sort error");
    }
});
