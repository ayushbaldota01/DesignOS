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

      // Extract only the triangles belonging to the clicked face
      const highlightGeo = this._extractFaceGeometry(hit.object, hit.face, hit.point, hit.faceIndex);
      const highlightMat = new THREE.MeshBasicMaterial({
        color: COLORS.faceHighlight,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      this.faceHighlight = new THREE.Mesh(highlightGeo, highlightMat);
      this.faceHighlight.position.copy(hit.object.position);
      this.faceHighlight.rotation.copy(hit.object.rotation);
      this.faceHighlight.scale.copy(hit.object.scale);
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
    // n is the normal in Three.js world space, which perfectly matches CadQuery export space.
    if (n.y > 0.8) return '>Y';
    if (n.y < -0.8) return '<Y';
    if (n.z > 0.8) return '>Z';
    if (n.z < -0.8) return '<Z';
    if (n.x > 0.8) return '>X';
    if (n.x < -0.8) return '<X';
    return '>Y';
  }

  _getFaceLabel(n) {
    // In Three.js, Y is Up, Z is Forward (towards camera), X is Right.
    if (n.y > 0.8) return 'TOP FACE';
    if (n.y < -0.8) return 'BOTTOM FACE';
    if (n.z > 0.8) return 'FRONT FACE';
    if (n.z < -0.8) return 'BACK FACE';
    if (n.x > 0.8) return 'RIGHT FACE';
    if (n.x < -0.8) return 'LEFT FACE';
    return 'TOP FACE';
  }

  _extractFaceGeometry(mesh, hitFace, hitPoint, faceIndex) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position.array;
    const count = pos.length / 9;

    // Build edge map (cache it for performance)
    if (!geo.userData.edgeMap) {
      const edgeMap = new Map();
      const toHash = (v) => Math.round(v * 1000);
      const getHash = (idx) => toHash(pos[idx]) + '_' + toHash(pos[idx+1]) + '_' + toHash(pos[idx+2]);
      
      for (let i = 0; i < count; i++) {
        const h1 = getHash(i * 9);
        const h2 = getHash(i * 9 + 3);
        const h3 = getHash(i * 9 + 6);
        
        const edges = [
          h1 < h2 ? h1 + '|' + h2 : h2 + '|' + h1,
          h2 < h3 ? h2 + '|' + h3 : h3 + '|' + h2,
          h3 < h1 ? h3 + '|' + h1 : h1 + '|' + h3
        ];
        
        for (const edge of edges) {
          if (!edgeMap.has(edge)) edgeMap.set(edge, []);
          edgeMap.get(edge).push(i);
        }
      }
      geo.userData.edgeMap = edgeMap;
      
      // Precompute normals for speed
      const normals = new Float32Array(count * 3);
      const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
      const cb = new THREE.Vector3(), ab = new THREE.Vector3(), triNorm = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        vA.fromArray(pos, i * 9);
        vB.fromArray(pos, i * 9 + 3);
        vC.fromArray(pos, i * 9 + 6);
        cb.subVectors(vC, vB);
        ab.subVectors(vA, vB);
        triNorm.crossVectors(cb, ab).normalize();
        normals[i*3] = triNorm.x;
        normals[i*3+1] = triNorm.y;
        normals[i*3+2] = triNorm.z;
      }
      geo.userData.triNormals = normals;
    }
    
    const edgeMap = geo.userData.edgeMap;
    const triNormals = geo.userData.triNormals;
    
    const toHash = (v) => Math.round(v * 1000);
    const getHash = (idx) => toHash(pos[idx]) + '_' + toHash(pos[idx+1]) + '_' + toHash(pos[idx+2]);
    
    // Flood fill
    const visited = new Set([faceIndex]);
    const queue = [faceIndex];
    const n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
    
    while (queue.length > 0) {
      const curTri = queue.shift();
      n1.fromArray(triNormals, curTri * 3);
      
      const h1 = getHash(curTri * 9);
      const h2 = getHash(curTri * 9 + 3);
      const h3 = getHash(curTri * 9 + 6);
      
      const edges = [
        h1 < h2 ? h1 + '|' + h2 : h2 + '|' + h1,
        h2 < h3 ? h2 + '|' + h3 : h3 + '|' + h2,
        h3 < h1 ? h3 + '|' + h1 : h1 + '|' + h3
      ];
      
      for (const edge of edges) {
        const adjTris = edgeMap.get(edge) || [];
        for (const adjTri of adjTris) {
          if (!visited.has(adjTri)) {
            n2.fromArray(triNormals, adjTri * 3);
            // ~36 degrees threshold for smooth surfaces
            if (n1.dot(n2) > 0.8) {
              visited.add(adjTri);
              queue.push(adjTri);
            }
          }
        }
      }
    }
    
    const newPos = [];
    for (const tri of visited) {
      newPos.push(
        pos[tri*9], pos[tri*9+1], pos[tri*9+2],
        pos[tri*9+3], pos[tri*9+4], pos[tri*9+5],
        pos[tri*9+6], pos[tri*9+7], pos[tri*9+8]
      );
    }
    
    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
    hGeo.computeVertexNormals();
    return hGeo;
  }
}
