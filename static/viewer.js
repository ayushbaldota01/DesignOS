/**
 * DesignOS — Three.js CAD Viewer
 * Renders STL meshes exported by CadQuery in a dark engineering-themed viewport.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const COLORS = {
  background: 0x12141a,
  gridCenter: 0x3a3f4b,
  gridLines: 0x22252e,
  partBase: 0x4ea8de,
  partEmissive: 0x1a3a5c,
  ambient: 0xc8d0e0,
};

let measureMode = false;


export class CADViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.currentModel = null;
    this._init();
  }

  /* ------------------------------------------------------------------ */
  /*  Initialisation                                                     */
  /* ------------------------------------------------------------------ */

  _init() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.background);

    // Camera
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 50000);
    this.camera.position.set(150, 120, 150);

    // HUD (Corner Axes)
    this.hudScene = new THREE.Scene();
    this.hudCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    this.hudCamera.position.set(0, 0, 3);
    this.hudAxes = new THREE.AxesHelper(1);
    this.hudScene.add(this.hudAxes);

    // Add X, Y, Z text sprites to HUD
    const createTextSprite = (text, color) => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = color;
      ctx.font = 'bold 48px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 32, 32);
      const texture = new THREE.CanvasTexture(canvas);
      const spriteMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: false });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.scale.set(0.4, 0.4, 0.4);
      return sprite;
    };
    
    const spriteX = createTextSprite('X', '#ff4444'); spriteX.position.set(1.2, 0, 0); this.hudScene.add(spriteX);
    const spriteY = createTextSprite('Y', '#44ff44'); spriteY.position.set(0, 1.2, 0); this.hudScene.add(spriteY);
    const spriteZ = createTextSprite('Z', '#4444ff'); spriteZ.position.set(0, 0, 1.2); this.hudScene.add(spriteZ);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false; // required for HUD
    this.container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = false;
    this.controls.autoRotateSpeed = 2.0;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 10000;

    // Lights
    this.scene.add(new THREE.AmbientLight(COLORS.ambient, 0.5));

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(200, 300, 150);
    key.castShadow = true;
    key.shadow.mapSize.width = 2048;
    key.shadow.mapSize.height = 2048;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 1000;
    key.shadow.camera.left = -200;
    key.shadow.camera.right = 200;
    key.shadow.camera.top = 200;
    key.shadow.camera.bottom = -200;
    key.shadow.bias = -0.001;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xb0c4de, 0.4);
    fill.position.set(-150, 100, -100);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(0, -100, -200);
    this.scene.add(rim);

    // Grid
    const grid = new THREE.GridHelper(400, 40, COLORS.gridCenter, COLORS.gridLines);
    grid.material.opacity = 0.5;
    grid.material.transparent = true;
    this.scene.add(grid);

    // Axes
    this.scene.add(new THREE.AxesHelper(60));

    // Handle resize
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);

    // Interaction
    this.renderer.domElement.addEventListener('click', (e) => this._onClick(e));

    // Render loop
    this._animate();
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  loadSTL(url) {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel.geometry.dispose();
      this.currentModel.material.dispose();
      this.currentModel = null;
    }

    const loader = new STLLoader();
    loader.load(
      url,
      (geometry) => {
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
          color: COLORS.partBase,
          metalness: 0.3,
          roughness: 0.5,
          emissive: COLORS.partEmissive,
          emissiveIntensity: 0.15,
          flatShading: false,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        // Centre model at origin
        geometry.computeBoundingBox();
        const centre = new THREE.Vector3();
        geometry.boundingBox.getCenter(centre);
        mesh.position.sub(centre);

        // Fit camera
        const size = new THREE.Vector3();
        geometry.boundingBox.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        const dist = maxDim * 2.0;
        this.camera.position.set(dist, dist * 0.8, dist);
        this.controls.target.set(0, 0, 0);
        this.controls.update();

        this.currentModel = mesh;
        this.scene.add(mesh);
      },
      undefined,
      (err) => console.error("STL load error:", err)
    );
  }

  clear() {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel.geometry.dispose();
      this.currentModel.material.dispose();
      this.currentModel = null;
    }
  }

  resetCamera() {
    this.camera.position.set(150, 120, 150);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                          */
  /* ------------------------------------------------------------------ */

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();

    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    // Render main scene
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // Render HUD (corner axes)
    const hudSize = 100;
    this.renderer.setViewport(w - hudSize - 20, 20, hudSize, hudSize);
    this.hudCamera.position.copy(this.camera.position).normalize().multiplyScalar(3);
    this.hudCamera.lookAt(0, 0, 0);
    this.renderer.clearDepth();
    this.renderer.render(this.hudScene, this.hudCamera);
  }

  _onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _onClick(e) {
    if (!this.currentModel) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    const intersects = raycaster.intersectObject(this.currentModel, true);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);

      let faceLabel = "FACE";
      let cqSelector = "'>Z'";
      if (normal.z > 0.8) { faceLabel = "TOP FACE"; cqSelector = "'>Z'"; }
      else if (normal.z < -0.8) { faceLabel = "BOTTOM FACE"; cqSelector = "'<Z'"; }
      else if (normal.x > 0.8) { faceLabel = "SIDE FACE (+X)"; cqSelector = "'>X'"; }
      else if (normal.x < -0.8) { faceLabel = "SIDE FACE (-X)"; cqSelector = "'<X'"; }
      else if (normal.y > 0.8) { faceLabel = "SIDE FACE (+Y)"; cqSelector = "'>Y'"; }
      else if (normal.y < -0.8) { faceLabel = "SIDE FACE (-Y)"; cqSelector = "'<Y'"; }

      window.clickedFaceNormal = { x: normal.x, y: normal.y, z: normal.z };
      window.clickedFaceLabel = `${faceLabel} (recommended CadQuery selector: ${cqSelector})`;

      if (window.onGeometryClick) {
        window.onGeometryClick(hit);
      }

      const originalEmissive = hit.object.material.emissive.clone();
      hit.object.material.emissive = new THREE.Color(0x00d4ff); // bright blue highlight
      setTimeout(() => { if (hit.object) hit.object.material.emissive = originalEmissive; }, 800);
    }
  }
}
