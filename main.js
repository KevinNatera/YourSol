// --- ES Module Imports (resolved by the Import Map in index.html) ---
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// --- Firebase CDN Imports ---
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  signInWithCustomToken,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  addDoc,
  serverTimestamp,
  query,
  doc,
  deleteDoc,
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// REFACTOR: Import the initialized Firebase services and the public appId from the new config file.
import { db, auth, appId } from "./firebaseConfig.js";

// --- GLOBAL VARIABLES & CONFIGURATION ---
let camera, scene, renderer, controls, composer;
let userId;
const celestialObjects = new Map();
const starPositions = new Map();
const STAR_SPACING = 750;
let targetPosition = new THREE.Vector3();
let targetLookAt = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const mouseDownPosition = new THREE.Vector2();
let starIdToFlash = null;
let isInitialLoad = true;
let selectedStarId = null;

// Visual/Glow Constants
const ENTIRE_SCENE = 0,
  BLOOM_LAYER = 1;
const bloomLayer = new THREE.Layers();
bloomLayer.set(BLOOM_LAYER);
// White, Yellow, Blue, Red
const STAR_COLORS = [0xffffff, 0xffff00, 0x00bfff, 0xff4500];

// --- UI ELEMENTS ---
const topicInput = document.getElementById("topic-input");
const generateBtn = document.getElementById("generate-btn");
const loadingIndicator = document.getElementById("loading-indicator");
const starList = document.getElementById("star-list");
const starSearch = document.getElementById("star-search");
const infoTitle = document.getElementById("info-title");
const infoDescription = document.getElementById("info-description");
const userIdDisplay = document.getElementById("user-id-display");
const canvasContainer = document.getElementById("canvas-container");
const tooltip = document.getElementById("tooltip");
const deleteStarBtn = document.getElementById("delete-star-btn");
const systemNavigator = document.getElementById("system-navigator");
const navigatorStarName = document.getElementById("navigator-star-name");
const navigatorList = document.getElementById("navigator-celestial-list");

// --- FIREBASE INITIALIZATION & CONFIGURATION HANDLING ---

// REFACTOR: The logic for handling mock mode is preserved, but it now checks for the SECRET
// Gemini key. This is a more reliable way to determine if the app is running in a "real"
// environment with all secrets loaded.
const isDeployed = !!import.meta.env.VITE_GEMINI_API_KEY;

if (isDeployed) {
  // --- REAL/DEPLOYED MODE ---
  // The Firebase services are already initialized by the import. We just need to handle the UI state.
  console.log(
    "Firebase services imported successfully. Running in deployed mode."
  );
  // Button is disabled until user auth is confirmed.
  generateBtn.disabled = true;
} else {
  // --- MOCK/LOCAL MODE ---
  // If the secret Gemini key is missing, this block will run.
  console.warn("VITE_GEMINI_API_KEY not found. Running in MOCK mode.");
  userIdDisplay.textContent = "Local Mock";
  // For local testing, enable the generate button immediately.
  generateBtn.disabled = false;
}

// --- THREE.JS INITIALIZATION (Includes Bloom Pass) ---

/**
 * Sets up the 3D scene, camera, renderer, and controls, and post-processing.
 */
function init3D() {
  // 1. Scene setup
  scene = new THREE.Scene();

  // 2. Camera setup
  // REFACTOR: Increased the `far` clipping plane from 5000 to 20000.
  // This prevents the "black hole" effect by ensuring the starfield background
  // does not get clipped when the camera moves and rotates. [4, 13]
  camera = new THREE.PerspectiveCamera(
    75,
    canvasContainer.clientWidth / canvasContainer.clientHeight,
    0.1,
    20000
  );
  camera.position.set(0, 60, 100);

  // 3. Renderer setup
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(canvasContainer.clientWidth, canvasContainer.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.toneMapping = THREE.ReinhardToneMapping;
  renderer.toneMappingExposure = 1.5;
  canvasContainer.appendChild(renderer.domElement);

  // 4. Post-Processing (Bloom Effect)
  const renderScene = new RenderPass(scene, camera);

  // The bloom pass makes bright objects glow intensely
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(
      canvasContainer.clientWidth,
      canvasContainer.clientHeight
    ),
    1.5, // Intensity - Increased for brighter glow
    0.4, // Radius
    0.85 // Threshold
  );
  bloomPass.threshold = 0; // Ensures everything on the bloom layer glows

  composer = new EffectComposer(renderer);
  composer.addPass(renderScene);
  composer.addPass(bloomPass);

  // 5. Controls setup
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  // Enable screen-space panning for a better "free roam" feel with the mouse
  controls.screenSpacePanning = true;
  controls.update();

  // 6. Lighting and Starfield
  scene.add(new THREE.AmbientLight(0x0a0a0a)); // Very dark ambient light
  createStarField();

  // 7. Start the animation loop
  animate();

  // 8. Handle resizing
  window.addEventListener("resize", () => {
    const width = canvasContainer.clientWidth;
    const height = canvasContainer.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    composer.setSize(width, height);
    bloomPass.resolution.set(width, height);
  });
}

/**
 * The main animation loop for the 3D scene.
 */
function animate() {
  requestAnimationFrame(animate);

  // Update controls (essential for damping)
  controls.update();

  // Animate star systems (rotation, etc.)
  celestialObjects.forEach(({ systemGroup }) => {
    if (systemGroup) {
      // Star system rotates slowly
      systemGroup.rotation.y += 0.0005;

      // Planets rotate on their axis and orbit their star (inherited by planetOrbitGroup)
      systemGroup.traverse((obj) => {
        if (obj.userData.type === "planet") {
          // Axial rotation
          obj.rotation.y += 0.01;
        }

        // Rotate the MoonOrbitGroup around the planet (making moons orbit slower)
        if (obj.name === "MoonOrbitGroup") {
          // Rotates using the custom orbitSpeed set in createStarSystem
          obj.rotation.y += obj.userData.orbitSpeed;
        }
      });
    }
  });

  // Render the scene using the composer for the bloom effect
  composer.render();
}

/**
 * Creates a bright flash of light and fades it out with a particle burst (sparks).
 * @param {THREE.PointLight} starLight
 * @param {THREE.MeshLambertMaterial} starMat
 * @param {THREE.Mesh} starMesh The star mesh to attach particles to.
 */
function starFlash(starLight, starMat, starMesh) {
  // Save initial values
  const initialIntensity = starLight.intensity;
  const initialEmissive = starMat.emissiveIntensity;
  const flashMultiplier = 10; // Peak intensity multiplier

  // 1. Create Particle System for Sparks
  const particleCount = 50;
  const particleGeo = new THREE.BufferGeometry();
  const positions = [];
  const velocities = [];

  for (let i = 0; i < particleCount; i++) {
    // Start at star's position (0,0,0 relative to the systemGroup)
    positions.push(0, 0, 0);

    // Random velocity vector (high speed)
    const velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 5,
      (Math.random() - 0.5) * 5,
      (Math.random() - 0.5) * 5
    );
    velocities.push(velocity.x, velocity.y, velocity.z);
  }

  particleGeo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  particleGeo.setAttribute(
    "velocity",
    new THREE.Float32BufferAttribute(velocities, 3)
  );

  const particleMat = new THREE.PointsMaterial({
    color: starMat.color,
    size: 5,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 1.0,
  });

  const sparkParticles = new THREE.Points(particleGeo, particleMat);
  starMesh.parent.add(sparkParticles); // Add to the star system group

  const duration = 1500; // 1.5 second flash/spark lifetime
  const startTime = performance.now();

  function fadeFlashAndSparks() {
    const elapsed = performance.now() - startTime;
    const progress = elapsed / duration;

    if (progress < 1) {
      // 2. Light Fade (Exponential interpolation for faster fade)
      const factor = Math.pow(1 - progress, 2); // Faster fade

      starLight.intensity =
        initialIntensity +
        (initialIntensity * flashMultiplier - initialIntensity) * factor;
      starMat.emissiveIntensity =
        initialEmissive +
        (initialEmissive * flashMultiplier - initialEmissive) * factor;

      // 3. Spark Movement and Fade
      particleMat.opacity = factor; // Fade particles as light fades
      const positions = particleGeo.attributes.position.array;
      const velocities = particleGeo.attributes.velocity.array;

      for (let i = 0; i < particleCount; i++) {
        const i3 = i * 3;
        // Update position based on velocity
        positions[i3] += velocities[i3] * 0.1;
        positions[i3 + 1] += velocities[i3 + 1] * 0.1;
        positions[i3 + 2] += velocities[i3 + 2] * 0.1;
        // Apply slight drag/damping
        velocities[i3] *= 0.99;
        velocities[i3 + 1] *= 0.99;
        velocities[i3 + 2] *= 0.99;
      }
      particleGeo.attributes.position.needsUpdate = true;

      requestAnimationFrame(fadeFlashAndSparks);
    } else {
      // 4. Cleanup
      // Ensure light is reset exactly
      starLight.intensity = initialIntensity;
      starMat.emissiveIntensity = initialEmissive;
      // Remove and dispose of the spark system
      starMesh.parent.remove(sparkParticles);
      particleGeo.dispose();
      particleMat.dispose();
    }
  }
  fadeFlashAndSparks();
}

/**
 * Creates a vast, random star field background.
 * UPDATED: Increased star count and radius to prevent "void" effect.
 */
function createStarField() {
  const geometry = new THREE.BufferGeometry();
  const vertices = [];
  const colors = [];

  const numStars = 10000; // Doubled star count
  // REFACTOR: Increased radius to 10000 to fill the larger camera frustum.
  // This complements the camera's new `far` plane setting to eliminate the "black hole" effect. [4]
  const radius = 10000;

  for (let i = 0; i < numStars; i++) {
    const phi = Math.random() * Math.PI * 2;
    const theta = Math.random() * Math.PI;

    // Randomly place stars in a sphere
    const x = radius * Math.sin(theta) * Math.cos(phi);
    const y = radius * Math.sin(theta) * Math.sin(phi);
    const z = radius * Math.cos(theta);

    vertices.push(x, y, z);

    // REFACTOR: Made background stars brighter for better visibility.
    // Changed the base color from 0x333333 to 0x888888 and adjusted the
    // random scalar to a higher range (0.3 to 0.8).
    const color = new THREE.Color(0x888888);
    color.setScalar(Math.random() * 0.5 + 0.3);
    colors.push(color.r, color.g, color.b);
  }

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

  // REFACTOR: Slightly increased star size for better visibility.
  const material = new THREE.PointsMaterial({
    size: 2.0,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });

  const starField = new THREE.Points(geometry, material);
  scene.add(starField);
}

// --- GALAXY CREATION FUNCTIONS ---

function clearScene() {
  for (const [id, obj] of celestialObjects) {
    scene.remove(obj.light);
    scene.remove(obj.systemGroup);
    // Dispose of geometries and materials to prevent memory leaks
    obj.systemGroup.traverse((child) => {
      if (child.isMesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }
  celestialObjects.clear();
  starPositions.clear();
}

/**
 * Calculates a star's position using a grid pattern with significant random jitter
 * to break the straight-line appearance.
 */
function calculateStarPosition(index) {
  const gridWidth = 5;
  // Use slightly more space than the base constant to prevent overlap
  const baseSpacing = STAR_SPACING * 1.5;

  const x = ((index % gridWidth) - Math.floor(gridWidth / 2)) * baseSpacing;
  const z =
    (Math.floor(index / gridWidth) - Math.floor(gridWidth / 2)) * baseSpacing;

  // Small vertical offset
  const y = (Math.random() - 0.5) * 200;

  // Add significant jitter (up to 50% of STAR_SPACING) to break the grid pattern
  const jitter = STAR_SPACING * 0.5;
  const finalX = x + (Math.random() - 0.5) * jitter;
  const finalZ = z + (Math.random() - 0.5) * jitter;

  return new THREE.Vector3(finalX, y, finalZ);
}

function getRandomColor() {
  const color = new THREE.Color();
  color.setRGB(Math.random(), Math.random(), Math.random());
  return color.getHex();
}

/**
 * Creates a 3D star system.
 * @param {object} data The star system data.
 * @param {string} docId The Firestore document ID.
 * @param {THREE.Vector3} position The system's position in the scene.
 * @param {boolean} shouldFlash If true, triggers the flash effect for the star.
 */
function createStarSystem(data, docId, position, shouldFlash = false) {
  const systemGroup = new THREE.Group();
  systemGroup.position.copy(position);
  systemGroup.userData = { docId: docId, fullData: data };
  scene.add(systemGroup);

  // Star/Light Source (Randomly selected from white, yellow, blue, red)
  const starColorHex =
    data.star.color ||
    STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)];
  const starLight = new THREE.PointLight(starColorHex, 20, 800, 2);
  starLight.position.set(0, 0, 0);
  systemGroup.add(starLight);

  // Star Mesh: UPDATED: Enlarged by 2x (12 -> 24)
  const starGeo = new THREE.SphereGeometry(data.star.scale * 30, 32, 32);
  const starMat = new THREE.MeshLambertMaterial({
    color: starColorHex,
    emissive: starColorHex,
    emissiveIntensity: 2.5,
  });
  const star = new THREE.Mesh(starGeo, starMat);
  star.userData = { type: "star", docId, ...data.star };
  star.name = data.star.name;
  star.layers.enable(BLOOM_LAYER);
  systemGroup.add(star);

  // Flash effect logic - Pass the star mesh for the particle effect
  if (shouldFlash) {
    starFlash(starLight, starMat, star);
  }

  // Planets
  let orbitRadius = 160;
  data.planets.forEach((planetData) => {
    // Group for the planet and its moons to handle rotation/orbit
    const planetOrbitGroup = new THREE.Group();
    // Give the planet group a random initial rotation to vary orbits
    planetOrbitGroup.rotation.y = Math.random() * Math.PI * 2;
    systemGroup.add(planetOrbitGroup);

    const orbitPoints = [];
    const segments = 128; // The number of line segments to make the circle smooth
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      // Calculate points on the XZ plane
      const x = orbitRadius * Math.cos(theta);
      const z = orbitRadius * Math.sin(theta);
      orbitPoints.push(new THREE.Vector3(x, 0, z));
    }
    const orbitGeometry = new THREE.BufferGeometry().setFromPoints(orbitPoints);
    const orbitMaterial = new THREE.LineBasicMaterial({
      color: 0x444444, // A dim gray
      transparent: true,
      opacity: 0.5,
    });
    const orbitLine = new THREE.Line(orbitGeometry, orbitMaterial);
    // Add the orbit line directly to the main system group so it doesn't rotate with the planet
    systemGroup.add(orbitLine);

    const planetColorHex = planetData.color || getRandomColor();
    const planetRadius = planetData.scale * 15;
    const planetGeo = new THREE.SphereGeometry(planetRadius, 32, 32);
    const planetMat = new THREE.MeshLambertMaterial({
      color: planetColorHex,
      emissive: planetColorHex,
      emissiveIntensity: 0.8,
    });
    const planet = new THREE.Mesh(planetGeo, planetMat);
    // Added parentStarName for tooltip
    planet.userData = {
      type: "planet",
      docId,
      ...planetData,
      parentStarName: data.star.name,
    };
    planet.name = planetData.name;

    // Position the planet within its orbit group
    planet.position.set(orbitRadius, 0, 0);
    planet.layers.enable(BLOOM_LAYER);
    planetOrbitGroup.add(planet); // Planet is child of its orbit group

    orbitRadius += 150; // Increased spacing

    // Moons: Spaced out in random orbits
    let moonOrbitRadius = planetRadius + 15; // Base radius adjusted for larger planet
    planetData.moons.forEach((moonData, index) => {
      // Group to handle the moon's orbit around the planet
      const moonOrbitGroup = new THREE.Group();
      moonOrbitGroup.name = "MoonOrbitGroup";
      // REFACTOR: Reduced moon orbit speed by 50% by dividing the final value by 2.
      moonOrbitGroup.userData.orbitSpeed =
        (Math.random() * 0.0002 + 0.00002) / 8;
      planet.add(moonOrbitGroup); // This group is a child of the planet

      // UPDATED: Moons cut in half (24 -> 12)
      const moonGeo = new THREE.SphereGeometry(moonData.scale * 10, 16, 16);
      const moonColorHex = 0xcccccc;
      const moonMat = new THREE.MeshLambertMaterial({
        color: moonColorHex,
        emissive: moonColorHex,
        emissiveIntensity: 0.5,
      });
      const moon = new THREE.Mesh(moonGeo, moonMat);
      // Added parent names for tooltip
      moon.userData = {
        type: "moon",
        docId,
        ...moonData,
        parentPlanetName: planetData.name,
        parentStarName: data.star.name,
      };
      moon.name = moonData.name;

      // Randomize position based on index, radius, and a random angle
      const angle =
        (index / planetData.moons.length) * Math.PI * 2 + Math.random() * 0.5;
      const x = moonOrbitRadius * Math.cos(angle);
      const z = moonOrbitRadius * Math.sin(angle);

      // Add a slight random vertical offset
      const y = (Math.random() - 0.5) * 2;

      moon.position.set(x, y, z);
      moon.layers.enable(BLOOM_LAYER);
      moonOrbitGroup.add(moon); // Moon is child of its orbit group

      moonOrbitRadius += 10; // Increased spacing
    });
  });

  // Collect all clickable objects
  const clickable = [star];
  systemGroup.traverse((obj) => {
    if (obj.isMesh && obj !== star) clickable.push(obj);
  });

  celestialObjects.set(docId, { systemGroup, light: starLight, clickable });
  starPositions.set(docId, position);
}

// --- NAVIGATION, INTERACTION, & AUTH ---

async function handleAuthentication() {
  if (!isDeployed) {
    userId = crypto.randomUUID();
    userIdDisplay.textContent = `${userId.substring(0, 8)} (Mock)`;
    renderInitialMockGalaxy();
    return;
  }

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      userId = user.uid;
      userIdDisplay.textContent = userId;
      generateBtn.disabled = false;
      await loadUserGalaxy();
    } else {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error("Authentication failed:", error);
        userIdDisplay.textContent = "Auth Error";
      }
    }
  });
}

function renderInitialMockGalaxy() {
  const topic = "Dual-Mode Architecture (Mock)";
  const generatedData = createMockGalaxyData(topic);
  const tempId = crypto.randomUUID();
  const starPosition = calculateStarPosition(0);

  // Pass true to flash the initial star in mock mode
  createStarSystem(generatedData, tempId, starPosition, true);
  addStarToList(generatedData, tempId);
  navigateToStar(tempId, false);
}

function setEmptyGalaxyState() {
  // Clear the 3D scene and sidebar list (though they should already be empty)
  clearScene();
  starList.innerHTML = "";

  // Update the info panel with a welcome message
  infoTitle.textContent = "Welcome to Your Sol";
  infoTitle.className = "text-xl font-bold mb-1 text-gray-300"; // Use a neutral color
  infoDescription.innerHTML =
    "Your personal knowledge galaxy is empty.<br><br>Enter a topic in the sidebar to generate your first star system!";

  // Ensure the delete button is hidden
  if (deleteStarBtn) {
    deleteStarBtn.classList.add("hidden");
  }
  if (systemNavigator) {
    systemNavigator.classList.add("hidden");
  }
}

async function loadUserGalaxy() {
  if (!userId || !db) return;

  const q = query(collection(db, "artifacts", appId, "users", userId, "stars"));

  onSnapshot(q, (snapshot) => {
    const idToFlash = starIdToFlash; // Capture the ID of a newly created star

    // --- 1. Rebuild the scene and sidebar from the current data ---
    clearScene();
    starList.innerHTML = "";
    let firstStarId = null;
    snapshot.docs.forEach((doc, index) => {
      if (index === 0) firstStarId = doc.id;
      const starData = doc.data();
      const starPosition = calculateStarPosition(index);
      createStarSystem(starData, doc.id, starPosition);
      addStarToList(starData, doc.id);
    });

    // --- 2. Decide what the new selection state should be (THE FIX) ---
    // This logic replaces all previous attempts. It determines the correct
    // selection state BEFORE taking any action.

    let nextSelectedId = null; // Default to selecting nothing.

    if (idToFlash) {
      // CASE A: A new star was just created. It becomes the selection.
      nextSelectedId = idToFlash;
    } else if (selectedStarId && celestialObjects.has(selectedStarId)) {
      // CASE B: The previously selected star STILL EXISTS. Keep it selected.
      nextSelectedId = selectedStarId;
    } else if (isInitialLoad && firstStarId) {
      // CASE C: This is the first time the page is loading. Select the first star.
      nextSelectedId = firstStarId;
    }
    // **IMPLICIT CASE D:** If none of the above are true (i.e., the selected star was
    // deleted), `nextSelectedId` remains `null`.

    // --- 3. Apply the decided state to the UI ---
    if (nextSelectedId) {
      // If we decided a star should be selected, navigate to it.
      // We pass `false` for smooth navigation as this is a state update, not a user click.
      navigateToStar(nextSelectedId, false);

      // If this was a new star, trigger the flash effect.
      if (idToFlash) {
        const newStar = celestialObjects.get(idToFlash);
        if (newStar) {
          const starMesh = newStar.systemGroup.children.find(
            (c) => c.userData.type === "star"
          );
          starFlash(newStar.light, starMesh.material, starMesh);
        }
      }
    } else {
      // If we decided NOTHING should be selected, clear the panels.
      // This path is now correctly taken after deleting a selected star.
      clearInfoPanel();
    }

    // --- 4. Handle the special case of a totally empty galaxy ---
    if (snapshot.empty) {
      setEmptyGalaxyState();
    }

    // --- 5. Cleanup for the next snapshot event ---
    isInitialLoad = false;
    starIdToFlash = null;
  });
}

function navigateToStar(docId, smooth = true) {
  selectedStarId = docId;
  const position = starPositions.get(docId);
  if (!position) return;

  // Set camera slightly above and behind the star
  targetPosition.set(position.x, position.y + 100, position.z + 100);
  targetLookAt.copy(position);

  // Instant update: Jumps the camera to the star system.
  // The OrbitControls (with panning enabled) allow for "free roam" afterwards.
  controls.target.copy(targetLookAt);
  camera.position.copy(targetPosition);
  controls.update();

  const starData = celestialObjects
    .get(docId)
    .clickable.find((o) => o.userData.type === "star").userData;
  updateInfoPanel(starData);
  populateSystemNavigator(docId);
}

/**
 * Handles object clicks, updating the information panel.
 */
function onMouseDown(event) {
  mouseDownPosition.x = event.clientX;
  mouseDownPosition.y = event.clientY;
}

function onMouseUp(event) {
  // Calculate the distance the mouse moved
  const deltaX = Math.abs(event.clientX - mouseDownPosition.x);
  const deltaY = Math.abs(event.clientY - mouseDownPosition.y);

  // If the mouse moved less than 5 pixels, treat it as a click
  if (deltaX < 5 && deltaY < 5) {
    // --- This is the logic from your old onMouseClick function ---
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    let allClickable = [];
    celestialObjects.forEach((obj) => {
      allClickable = allClickable.concat(obj.clickable);
    });

    const intersects = raycaster.intersectObjects(allClickable, true);

    if (intersects.length > 0) {
      // An object was clicked
      const intersectedObject = intersects[0].object;
      updateInfoPanel(intersectedObject.userData);

      if (intersectedObject.userData.type === "star") {
        navigateToStar(intersectedObject.userData.docId);
      }
    } else {
      // --- SEE PART 3 FOR THE FINAL FIX TO THIS BLOCK ---
      // Empty space was clicked
      // We only clear the panel if the galaxy is NOT in its initial empty state.
      if (celestialObjects.size > 0) {
        clearInfoPanel();
      }
    }
  }
  // If the mouse moved more than 5 pixels, it was a drag, so do nothing.
}

/**
 * Handles object hovers, displaying a temporary tooltip with hierarchy.
 */
function onMouseMove(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  let allClickable = [];
  celestialObjects.forEach((obj) => {
    allClickable = allClickable.concat(obj.clickable);
  });

  const intersects = raycaster.intersectObjects(allClickable, true);

  if (intersects.length > 0) {
    const object = intersects[0].object;
    const data = object.userData;
    let tooltipText = "";

    // Generate hierarchical tooltip text
    if (data.type === "star") {
      // Use the actual Star Name (e.g., "Quantum System")
      tooltipText = `${data.name} System\n(Click to Navigate)`;
    } else if (data.type === "planet") {
      // Star Name System / Planet Name Planet
      tooltipText = `${data.parentStarName} System\n${data.name} Planet`;
    } else if (data.type === "moon") {
      // Star Name System / Planet Name Moon / Moon Name
      tooltipText = `${data.parentStarName} System\n${data.parentPlanetName} Planet Moon\n${data.name}`;
    }

    // Use innerHTML and replace newline with <br> for multi-line tooltip
    tooltip.innerHTML = tooltipText.replace(/\n/g, "<br>");

    // Position tooltip near mouse, slightly offset
    tooltip.style.left = `${event.clientX + 10}px`;
    tooltip.style.top = `${event.clientY - 20}px`;
    tooltip.classList.remove("hidden", "opacity-0");
    tooltip.classList.add("opacity-100");
  } else {
    tooltip.classList.add("opacity-0");
    tooltip.classList.remove("opacity-100");
    // Hide after transition
    setTimeout(() => {
      if (tooltip.classList.contains("opacity-0")) {
        tooltip.classList.add("hidden");
      }
    }, 150);
  }
}

// --- UI / Sidebar Functions ---

function addStarToList(data, docId) {
  const li = document.createElement("li");
  li.className =
    "p-2 rounded-lg cursor-pointer hover:bg-gray-600 transition duration-150";
  li.dataset.docId = docId;
  li.textContent = data.star.name;
  li.addEventListener("click", () => {
    navigateToStar(docId);
  });
  starList.appendChild(li);
  return li;
}

function updateInfoPanel(data) {
  const colorClass =
    data.type === "star"
      ? "text-yellow-400"
      : data.type === "planet"
      ? "text-blue-400"
      : "text-gray-400";

  infoTitle.className = `text-xl font-bold mb-1 ${colorClass}`;
  infoTitle.textContent = `${
    data.type.charAt(0).toUpperCase() + data.type.slice(1)
  }: ${data.name}`;
  infoDescription.innerHTML = data.description.replace(/\n/g, "<br>");

  if (data.docId) {
    deleteStarBtn.classList.remove("hidden");
    // Store the star's ID on the button itself for easy access
    deleteStarBtn.dataset.docId = data.docId;
  } else {
    deleteStarBtn.classList.add("hidden");
  }
}

function handleStarSearch() {
  const filter = starSearch.value.toLowerCase();
  const items = starList.getElementsByTagName("li");
  for (let i = 0; i < items.length; i++) {
    const text = items[i].textContent || items[i].innerText;
    if (text.toLowerCase().indexOf(filter) > -1) {
      items[i].style.display = "";
    } else {
      items[i].style.display = "none";
    }
  }
}

function setLoading(isLoading) {
  generateBtn.disabled = isLoading;
  topicInput.disabled = isLoading;
  if (isLoading) {
    loadingIndicator.classList.remove("hidden");
    loadingIndicator.classList.add("flex");
  } else {
    loadingIndicator.classList.add("hidden");
  }
}

// --- GEMINI API INTEGRATION ---

const MODEL_NAME = "gemini-2.5-flash-preview-05-20";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

// Helper function to handle exponential backoff for retries
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      throw new Error(`API returned status ${response.status}`);
    } catch (error) {
      console.warn(`Attempt ${i + 1} failed. Retrying in ${1 << i}s...`);
      if (i === maxRetries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, (1 << i) * 1000));
    }
  }
}

/**
 * Calls the Gemini API to generate structured star system data.
 * Falls back to mock data if the API fails.
 */
async function _geminiApiExecutor(topic) {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

  const systemPrompt = `You are a helpful knowledge structuring engine. Your task is to take a core topic and break it down into a structured JSON format representing a star system:
- The **star** is the main Core Idea/Topic.
- **Planets** are the main sub-topics or conceptual pillars.
- **Moons** are specific details, examples, or supporting points for their parent planet.

Generate exactly 3 planets, and 1 to 3 moons for each planet.
Ensure the name and description are concise and relevant to the topic.
The 'scale' property should be a float between 0.5 and 2.0.

Your response MUST be a JSON array of objects following this schema. Do not include any text, markdown formatting, or explanations outside the JSON block.`;

  const userQuery = `Core Topic: "${topic}"`;

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          star: {
            type: "OBJECT",
            properties: {
              name: { type: "STRING" },
              description: { type: "STRING" },
              scale: { type: "NUMBER" },
            },
            propertyOrdering: ["name", "description", "scale"],
          },
          planets: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                description: { type: "STRING" },
                scale: { type: "NUMBER" },
                moons: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      name: { type: "STRING" },
                      description: { type: "STRING" },
                      scale: { type: "NUMBER" },
                    },
                    propertyOrdering: ["name", "description", "scale"],
                  },
                },
              },
              propertyOrdering: ["name", "description", "scale", "moons"],
            },
          },
        },
        propertyOrdering: ["star", "planets"],
      },
    },
  };

  try {
    // --- API CALL LOGIC ENABLED ---
    const response = await fetchWithRetry(`${API_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonText) {
      console.error("Gemini API failed to return JSON text:", result);
      throw new Error("API content generation failed.");
    }

    const data = JSON.parse(jsonText);

    if (!data.star || !data.planets || data.planets.length === 0) {
      throw new Error("Generated JSON structure is invalid.");
    }

    return data;
    // --- API CALL LOGIC ENABLED END ---
  } catch (error) {
    console.error(
      "Error calling Gemini API. Falling back to mock data.",
      error
    );
    return createMockGalaxyData(topic);
  }
}

async function handleGenerateStar() {
  const topic = topicInput.value.trim();
  if (!topic || !userId) return;

  setLoading(true);

  let generatedData;

  console.log("Checking conditions:", { db, userId, isDeployed });

  if (isDeployed) {
    // 1. Attempt to call the Gemini API
    generatedData = await _geminiApiExecutor(topic);

    generatedData.star.name = topic;
    generatedData.star.color =
      STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)];
    generatedData.planets.forEach((planet) => {
      planet.color = getRandomColor();
      // Moons are static gray, so we don't need to assign them colors.
    });

    // 2. Save the data to Firestore
    try {
      const docRef = await addDoc(
        collection(db, "artifacts", appId, "users", userId, "stars"),
        {
          ...generatedData,
          topic: topic,
          createdAt: serverTimestamp(),
        }
      );
      // Set the global flag so the onSnapshot listener knows to flash this specific star
      starIdToFlash = docRef.id;
      topicInput.value = ""; // Clear input on success
    } catch (error) {
      console.error("Failed to save star system:", error);
      // In case of Firestore save failure, still clear input
      topicInput.value = "";
    }
  } else {
    // Handle mock mode generation (adds local system to the current list)
    generatedData = createMockGalaxyData(topic);
    const tempId = crypto.randomUUID();
    const newPosition = calculateStarPosition(celestialObjects.size);
    // Pass true to flash the new star in mock mode
    createStarSystem(generatedData, tempId, newPosition, true);
    addStarToList(generatedData, tempId);
    navigateToStar(tempId, true);
    topicInput.value = "";
  }

  setLoading(false);
}

// --- STAR DELETION LOGIC ---

/**
 * Removes a star system from the 3D scene and cleans up its Three.js resources
 * to prevent memory leaks.
 * @param {string} docId The ID of the star system to remove.
 */
function removeStarFromScene(docId) {
  const obj = celestialObjects.get(docId);
  if (!obj) return;

  // 1. Remove the entire group from the scene
  scene.remove(obj.systemGroup);

  // 2. Traverse all objects in the group to dispose of their geometry and material
  obj.systemGroup.traverse((child) => {
    if (child.isMesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else {
        child.material.dispose();
      }
    }
  });

  // 3. Remove the star from our internal tracking maps
  celestialObjects.delete(docId);
  starPositions.delete(docId);
}

/**
 * Removes the corresponding star entry from the sidebar list.
 * @param {string} docId The ID of the star system to remove.
 */
function removeStarFromList(docId) {
  const listItem = starList.querySelector(`li[data-doc-id="${docId}"]`);
  if (listItem) {
    listItem.remove();
  }
}

/**
 * Resets the main info panel to its default, welcoming state.
 */
function clearInfoPanel() {
  selectedStarId = null;
  // 1. Reset the text and styles of the left column
  infoTitle.textContent = "Select a Celestial Body";
  infoDescription.innerHTML =
    "Click on a star, planet, or moon in the 3D space, or select a system from the sidebar to view its details here.";
  infoTitle.className = "text-xl font-bold mb-1 text-yellow-400 mt-0";

  // 2. Hide the delete button
  deleteStarBtn.classList.add("hidden");

  // 3. CRUCIAL: Hide the system navigator (the right column)
  if (systemNavigator) {
    systemNavigator.classList.add("hidden");
  } else {
    console.warn('UI element with ID "system-navigator" was not found.');
  }
}

/**
 * The main handler for the delete button click event. It confirms the action,
 * deletes from Firestore, and then cleans up the UI and the 3D scene.
 */
async function handleDeleteStar() {
  const docId = deleteStarBtn.dataset.docId;
  if (!docId) return;

  if (
    !confirm("Are you sure you want to permanently delete this star system?")
  ) {
    return;
  }

  try {
    const docRef = doc(db, "artifacts", appId, "users", userId, "stars", docId);
    await deleteDoc(docRef);
    console.log(
      "Star system deleted successfully. onSnapshot will now update the UI."
    );
  } catch (error) {
    console.error("Error deleting star system:", error);
    alert("There was an error deleting the star system. Please try again.");
  }
}

/**
 * Populates and displays the system navigator panel for a selected star system.
 * @param {string} docId The Firestore document ID of the selected star system.
 */
function populateSystemNavigator(docId) {
  const starSystem = celestialObjects.get(docId);

  // --- Retrieve the FULL data from the systemGroup ---
  const fullStarData = starSystem.systemGroup.userData.fullData;

  // Check if we have valid data before proceeding
  if (!fullStarData || !fullStarData.star || !fullStarData.planets) {
    systemNavigator.classList.add("hidden");
    console.error("Could not find full star data to populate navigator.");
    return;
  }

  // 1. Clear any previous list and set the star's name
  navigatorList.innerHTML = "";
  navigatorStarName.textContent = fullStarData.star.name + " System";

  // 2. Loop through planets to build the list
  fullStarData.planets.forEach((planetData) => {
    // --- Create Planet Element ---
    const planetLi = document.createElement("li");
    const planetSpan = document.createElement("span");
    planetSpan.className = "navigator-item planet block";
    planetSpan.textContent = planetData.name + " Planet";

    // Add click listener for the planet
    planetSpan.addEventListener("click", () => {
      const planetObject = starSystem.clickable.find(
        (o) =>
          o.userData.name === planetData.name && o.userData.type === "planet"
      );
      if (planetObject) {
        updateInfoPanel(planetObject.userData);
      }
    });
    planetLi.appendChild(planetSpan);

    // --- Create Moon Elements (if they exist) ---
    if (planetData.moons && planetData.moons.length > 0) {
      const moonUl = document.createElement("ul");
      planetData.moons.forEach((moonData) => {
        const moonLi = document.createElement("li");
        const moonSpan = document.createElement("span");
        moonSpan.className = "navigator-item moon block";
        moonSpan.textContent = moonData.name + " Moon";

        // Add click listener for the moon
        moonSpan.addEventListener("click", (e) => {
          e.stopPropagation();
          const moonObject = starSystem.clickable.find(
            (o) =>
              o.userData.name === moonData.name && o.userData.type === "moon"
          );
          if (moonObject) {
            updateInfoPanel(moonObject.userData);
          }
        });
        moonLi.appendChild(moonSpan);
        moonUl.appendChild(moonLi);
      });
      planetLi.appendChild(moonUl);
    }

    navigatorList.appendChild(planetLi);
  });

  // 3. Make the navigator visible
  systemNavigator.classList.remove("hidden");
}

// --- MOCK DATA STRUCTURE (Required for local testing) ---

function createMockGalaxyData(topic) {
  return {
    star: {
      name: topic,
      description: `This star represents the core concept of **${topic}**. It is the central element of this knowledge system. Click on its planets (sub-topics) and moons (details) for more info.`,
      scale: 2,
    },
    planets: [
      {
        name: "Fundamental Concepts",
        description:
          "This planet covers the **basic building blocks and principles** necessary to understand the main topic. It's the foundation of your learning journey.",
        scale: 1,
        moons: [
          {
            name: "First Principle",
            description:
              "Detail of the first fundamental concept: how X works.",
            scale: 0.3,
            orbitRadius: 5,
          },
          {
            name: "Key Vocabulary",
            description:
              "Detail of the second fundamental concept: important terms and definitions.",
            scale: 0.3,
            orbitRadius: 8,
          },
        ],
      },
      {
        name: "Advanced Applications",
        description:
          "This planet explores how the core topic is **applied in real-world scenarios** and specialized fields, showing its practical value.",
        scale: 1.2,
        moons: [
          {
            name: "Case Study Alpha",
            description:
              "A specific case study or implementation detail in industry Z.",
            scale: 0.4,
            orbitRadius: 6,
          },
          {
            name: "Future Trends",
            description:
              "Future trends and theoretical applications of this knowledge.",
            scale: 0.4,
            orbitRadius: 10,
          },
        ],
      },
      {
        name: "Historical Context",
        description:
          "This planet maps the **origins, key discoveries, and evolution** of the topic over time, giving you perspective.",
        scale: 0.8,
        moons: [
          {
            name: "Foundational Paper",
            description:
              "The initial foundational paper or inventor who kickstarted this field.",
            scale: 0.2,
            orbitRadius: 4,
          },
        ],
      },
    ],
  };
}

// --- MAIN APP ENTRY POINT ---

function setupEventListeners() {
  generateBtn.addEventListener("click", handleGenerateStar);
  starSearch.addEventListener("input", handleStarSearch);
  deleteStarBtn.addEventListener("click", handleDeleteStar);
  canvasContainer.addEventListener("mousedown", onMouseDown);
  canvasContainer.addEventListener("mouseup", onMouseUp);
  canvasContainer.addEventListener("mousemove", onMouseMove);
}

/**
 * Initializes the entire application: 3D scene, authentication, and event listeners.
 */
function setupApp() {
  // The THREE.js logic must run first to ensure the canvas is ready
  init3D();
  handleAuthentication();
  setupEventListeners();
}

// Start the application immediately when the module script is executed.
setupApp();
