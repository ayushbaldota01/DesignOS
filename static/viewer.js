/**
 * DesignOS — Three.js CAD Viewer (Fusion 360 Edition)
 * Face selection, highlighting, raycaster coords, thumbnail capture.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

const COLORS = {
  background: 0x141414,
  gridCenter: 0x2a2a2a,
  gridLines: 0x1e1e1e,
  partBase: 0x6a9fd8,
  partEmissive: 0x1a2d42,
  faceHighlight: 0x0078d4,
  ambient: 0xc8d0e0,
};

export class CADViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.currentModel = null;
    this.faceHighlight = null;
    this.selectedFace = null;
    this.onFaceSelect = null;   // callback(faceInfo) or null
    this.onMouseMove3D = null;  // callback({x,y,z})
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();
    this._init();
  }

  _init() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.background);

    // Camera
    const aspect = this.container.clientWidth / this.container.clientHeight || 1;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 50000);
    this.camera.position.set(150, 120, 150);

    // HUD axes
    this.hudScene = new THREE.Scene();
    this.hudCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
    this.hudCamera.position.set(0, 0, 3);
    this.hudAxes = new THREE.AxesHelper(1);
    this.hudScene.add(this.hudAxes);
    this._addAxisLabels();

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true  // for thumbnail capture
    });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 10000;

    // Lights
    this.scene.add(new THREE.AmbientLight(COLORS.ambient, 0.5));

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(200, 300, 150);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
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

    this.scene.add(new THREE.AxesHelper(60));

    // Resize
    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);

    // Events
    this.renderer.domElement.addEventListener('click', (e) => this._onClick(e));
    this.renderer.domElement.addEventListener('mousemove', (e) => this._onMouseMove(e));

    this._animate();
  }

  _addAxisLabels() {
    const makeLabel = (text, color) => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const ctx = c.getContext('2d');
      ctx.fillStyle = color;
      ctx.font = 'bold 48px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 32, 32);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
      const s = new THREE.Sprite(mat);
      s.scale.set(0.4, 0.4, 0.4);
      return s;
    };
    const sx = makeLabel('X', '#ff4444'); sx.position.set(1.2, 0, 0); this.hudScene.add(sx);
    const sy = makeLabel('Y', '#44ff44'); sy.position.set(0, 1.2, 0); this.hudScene.add(sy);
    const sz = makeLabel('Z', '#4444ff'); sz.position.set(0, 0, 1.2); this.hudScene.add(sz);
  }

  /* ─── Public API ─── */

  loadSTL(url) {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel.geometry.dispose();
      this.currentModel.material.dispose();
      this.currentModel = null;
    }
    this.clearFaceSelection();

    const loader = new STLLoader();
    loader.load(url, (geometry) => {
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

      geometry.computeBoundingBox();
      const centre = new THREE.Vector3();
      geometry.boundingBox.getCenter(centre);
      mesh.position.sub(centre);

      const size = new THREE.Vector3();
      geometry.boundingBox.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const dist = maxDim * 2.0;
      this.camera.position.set(dist, dist * 0.8, dist);
      this.controls.target.set(0, 0, 0);
      this.controls.update();

      this.currentModel = mesh;
      this.scene.add(mesh);
    }, undefined, (err) => console.error("STL load error:", err));
  }

  clear() {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      this.currentModel.geometry.dispose();
      this.currentModel.material.dispose();
      this.currentModel = null;
    }
    this.clearFaceSelection();
  }

  resetCamera() {
    this.camera.position.set(150, 120, 150);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  clearFaceSelection() {
    if (this.faceHighlight) {
      this.scene.remove(this.faceHighlight);
      this.faceHighlight.geometry.dispose();
      this.faceHighlight.material.dispose();
      this.faceHighlight = null;
    }
    this.selectedFace = null;
    window.clickedFaceSelector = null;
    window.clickedFaceLabel = null;
  }

  captureThumbnail() {
    try {
      this.renderer.render(this.scene, this.camera);
      return this.renderer.domElement.toDataURL('image/jpeg', 0.3);
    } catch { return null; }
  }

  /* ─── Internals ─── */

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.renderer.setViewport(0, 0, w, h);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // HUD
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
    this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this._raycaster.setFromCamera(this._mouse, this.camera);
    const intersects = this._raycaster.intersectObject(this.currentModel, true);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();

      this.clearFaceSelection();

      // Create face highlight — a slightly enlarged translucent copy
      const highlightGeo = this.currentModel.geometry.clone();
      const highlightMat = new THREE.MeshBasicMaterial({
        color: COLORS.faceHighlight,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        depthTest: true,
      });
      this.faceHighlight = new THREE.Mesh(highlightGeo, highlightMat);
      this.faceHighlight.position.copy(this.currentModel.position);
      this.scene.add(this.faceHighlight);

      const selector = this._getFaceSelector(normal);
      const label = this._getFaceLabel(normal);

      this.selectedFace = { normal, point: hit.point, selector, label };
      window.clickedFaceSelector = selector;
      window.clickedFaceLabel = label;

      if (this.onFaceSelect) {
        this.onFaceSelect(this.selectedFace);
      }

      // Flash emissive
      const orig = hit.object.material.emissive.clone();
      hit.object.material.emissive.set(COLORS.faceHighlight);
      setTimeout(() => {
        if (hit.object && hit.object.material) hit.object.material.emissive.copy(orig);
      }, 600);
    } else {
      this.clearFaceSelection();
      if (this.onFaceSelect) this.onFaceSelect(null);
    }
  }

  _onMouseMove(e) {
    if (!this.onMouseMove3D) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this._raycaster.setFromCamera(this._mouse, this.camera);

    // Try hitting model first
    if (this.currentModel) {
      const hits = this._raycaster.intersectObject(this.currentModel, true);
      if (hits.length > 0) {
        const p = hits[0].point;
        this.onMouseMove3D({ x: p.x.toFixed(1), y: p.y.toFixed(1), z: p.z.toFixed(1) });
        return;
      }
    }
    // Fallback: ground plane
    const pt = new THREE.Vector3();
    this._raycaster.ray.intersectPlane(this._groundPlane, pt);
    if (pt) {
      this.onMouseMove3D({ x: pt.x.toFixed(1), y: pt.y.toFixed(1), z: pt.z.toFixed(1) });
    }
  }

  _getFaceSelector(n) {
    if (n.z > 0.8) return '>Z';
    if (n.z < -0.8) return '<Z';
    if (n.x > 0.8) return '>X';
    if (n.x < -0.8) return '<X';
    if (n.y > 0.8) return '>Y';
    return '<Y';
  }

  _getFaceLabel(n) {
    if (n.z > 0.8) return 'TOP FACE';
    if (n.z < -0.8) return 'BOTTOM FACE';
    if (n.x > 0.8) return 'RIGHT FACE';
    if (n.x < -0.8) return 'LEFT FACE';
    if (n.y > 0.8) return 'FRONT FACE';
    return 'BACK FACE';
  }
}
