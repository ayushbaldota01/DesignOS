/**
 * DesignOS — Three.js CAD Viewer (Fusion 360 Edition)
 * Face selection, highlighting, raycaster coords, thumbnail capture.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

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
    this.onTransformEnd = null; // callback({meshName, position, rotation})
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();
    
    // Gizmo properties
    this.transformControls = null;
    this.gizmoEnabled = false;
    this.gizmoMode = "translate"; // translate, rotate

    // Assembly part meshes for individual selection
    this.partMeshes = {};        // name → THREE.Mesh
    this.selectedPartName = null;
    this.onPartSelect = null;    // callback(partName, mesh)

    this.faceMateMode = false;
    this.faceMateStep = 1;
    this.faceMateSource = null;
    this.onFaceMateStep = null;
    this.onMateComplete = null;
    this._faceHighlight = null;

    // Measurement
    this.measureMode = false;
    this.measurePoints = [];
    this._measureLine = null;
    this._measureLabels = [];

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.container.appendChild(this.renderer.domElement);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 10000;

    // TransformControls (Gizmo)
    this.transformControls = new TransformControls(this.camera, this.renderer.domElement);
    this.transformControls.addEventListener('dragging-changed', (event) => {
        this.controls.enabled = !event.value;
        if (!event.value && this.onTransformEnd && this.transformControls.object) {
            const obj = this.transformControls.object;
            this.onTransformEnd({
                meshName: obj.name,
                position: obj.position.clone(),
                rotation: obj.rotation.clone()
            });
        }
    });
    this.scene.add(this.transformControls);

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

  setGizmoEnabled(enabled) {
      this.gizmoEnabled = enabled;
      if (!enabled) {
          this.transformControls.detach();
      }
  }

  setGizmoMode(mode) {
      this.gizmoMode = mode;
      this.transformControls.setMode(mode);
  }

  /* ─── Measurement ─── */

  toggleMeasureMode() {
      this.measureMode = !this.measureMode;
      this.measurePoints = [];
      this._clearMeasureVisuals();

      const btn = document.getElementById('btnMeasure3D');
      if (this.measureMode) {
          if (btn) btn.classList.add('active');
          this.renderer.domElement.style.cursor = 'crosshair';
          if (window.showToast) window.showToast('Measure: Click two points on the model');
      } else {
          if (btn) btn.classList.remove('active');
          this.renderer.domElement.style.cursor = 'default';
      }
  }

  _clearMeasureVisuals() {
      if (this._measureLine) { this.scene.remove(this._measureLine); this._measureLine = null; }
      if (this._measureLabels) { this._measureLabels.forEach(l => this.scene.remove(l)); this._measureLabels = []; }
  }

  _createMeasureSprite(text) {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      ctx.font = '24px monospace';
      const width = ctx.measureText(text).width;
      c.width = width + 30;
      c.height = 40;
      ctx.fillStyle = 'rgba(20, 20, 20, 0.8)';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = '#e6a23c';
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#e6a23c';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(text, 15, 28);
      const tex = new THREE.CanvasTexture(c);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(c.width * 0.15, c.height * 0.15, 1);
      return sprite;
  }

  /* ─── Face Mating ─── */
  
  startFaceMateMode() {
      this.faceMateMode = true;
      this.faceMateStep = 1; // 1=pick source face, 2=pick target face
      this.faceMateSource = null;
      this.renderer.domElement.style.cursor = 'crosshair';
      console.log('Face mate: click source face');
  }

  stopFaceMateMode() {
      this.faceMateMode = false;
      this.faceMateStep = 1;
      this.faceMateSource = null;
      this.renderer.domElement.style.cursor = 'default';
      if (this._faceHighlight) {
          this.scene.remove(this._faceHighlight);
          this._faceHighlight = null;
      }
  }

  _getFaceInfo(hit) {
      const mesh = hit.object;
      const face = hit.face;
      
      const normal = face.normal.clone()
          .transformDirection(mesh.matrixWorld)
          .normalize();
      
      const pos = mesh.geometry.attributes.position;
      const v0 = new THREE.Vector3().fromBufferAttribute(pos, face.a).applyMatrix4(mesh.matrixWorld);
      const v1 = new THREE.Vector3().fromBufferAttribute(pos, face.b).applyMatrix4(mesh.matrixWorld);
      const v2 = new THREE.Vector3().fromBufferAttribute(pos, face.c).applyMatrix4(mesh.matrixWorld);
      const center = v0.add(v1).add(v2).divideScalar(3);
      
      return { mesh, normal, center };
  }

  _highlightFace(faceInfo) {
      if (this._faceHighlight) this.scene.remove(this._faceHighlight);
      
      const arrow = new THREE.ArrowHelper(
          faceInfo.normal,
          faceInfo.center,
          20,
          0x0078d4,
          5, 3
      );
      this._faceHighlight = arrow;
      this.scene.add(arrow);
  }

  mateFaces(sourceInfo, targetInfo) {
      const meshA = sourceInfo.mesh;
      const normalA = sourceInfo.normal.clone();
      const centerA = sourceInfo.center.clone();
      const normalB = targetInfo.normal.clone();
      const centerB = targetInfo.center.clone();
      
      const targetNormal = normalB.clone().negate();
      
      const quaternion = new THREE.Quaternion()
          .setFromUnitVectors(normalA, targetNormal);
      
      meshA.quaternion.premultiply(quaternion);
      meshA.updateMatrixWorld(true);
      
      const meshCenter = meshA.position.clone();
      const originalOffset = centerA.clone().sub(meshCenter);
      const rotatedOffset = originalOffset.clone().applyQuaternion(quaternion);
      const newFaceCenter = meshA.position.clone().add(rotatedOffset);
      
      const translation = centerB.clone().sub(newFaceCenter);
      meshA.position.add(translation);
      
      meshA.updateMatrixWorld(true);
      
      if (this.onMateComplete) {
          this.onMateComplete({
              sourcePart: meshA.name,
              position: meshA.position,
              rotation: meshA.rotation
          });
      }
  }

  /* ─── Assembly Part Loading ─── */

  loadAssemblyParts(partsData) {
    // Clear existing part meshes
    Object.values(this.partMeshes).forEach(m => {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    this.partMeshes = {};
    this.transformControls.detach();
    this.selectedPartName = null;

    // Also remove the combined model if present
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      if (this.currentModel.geometry) this.currentModel.geometry.dispose();
      if (this.currentModel.material) this.currentModel.material.dispose();
      this.currentModel = null;
    }

    const loader = new STLLoader();
    const PART_COLORS = [0x6a9fd8, 0x7ab8a0, 0xd4956a, 0x9b7ab8, 0xb8a07a, 0x7ab8b8, 0xd47a7a];
    let loadedCount = 0;
    const total = partsData.length;

    partsData.forEach((partDef, i) => {
      loader.load(partDef.stl_url, (geometry) => {
        geometry.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({
          color: PART_COLORS[i % PART_COLORS.length],
          metalness: 0.3, roughness: 0.5,
          emissive: new THREE.Color(0x000000),
          emissiveIntensity: 0
        });
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.name = partDef.name;
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        // Store original assembly position for reset
        // Note: STL already has the part baked at its translated position from CadQuery export
        mesh.userData.originalPosition = mesh.position.clone();
        mesh.userData.originalRotation = mesh.rotation.clone();
        mesh.userData.template = partDef.template;
        mesh.userData.partIndex = i;

        this.partMeshes[partDef.name] = mesh;
        this.scene.add(mesh);

        loadedCount++;
        if (loadedCount === total) {
          this._fitCameraToAssembly();
        }
      }, undefined, (err) => {
        console.error(`Part ${partDef.name} load failed:`, err);
        loadedCount++;
        if (loadedCount === total) this._fitCameraToAssembly();
      });
    });
  }

  _fitCameraToAssembly() {
    const box = new THREE.Box3();
    Object.values(this.partMeshes).forEach(m => box.expandByObject(m));
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z) || 200;
    const dist = maxDim * 2.5;
    this.camera.position.set(center.x + dist, center.y + dist * 0.8, center.z + dist);
    this.controls.target.copy(center);
    this.controls.update();
  }

  selectPart(partName) {
    // Deselect all
    Object.values(this.partMeshes).forEach(m => {
      m.material.emissive.set(0x000000);
      m.material.emissiveIntensity = 0;
    });

    if (!partName) {
      this.transformControls.detach();
      this.selectedPartName = null;
      return;
    }

    const mesh = this.partMeshes[partName];
    if (!mesh) {
      console.warn('selectPart: not found:', partName, 'available:', Object.keys(this.partMeshes));
      return;
    }

    // Highlight
    mesh.material.emissive.setHex(0x1a3a5a);
    mesh.material.emissiveIntensity = 0.5;

    // Attach gizmo
    this.transformControls.attach(mesh);
    this.transformControls.setMode(this.gizmoMode || 'translate');
    this.selectedPartName = partName;

    if (this.onPartSelect) this.onPartSelect(partName, mesh);
  }

  getPartTransforms() {
    const out = {};
    Object.entries(this.partMeshes).forEach(([name, mesh]) => {
      out[name] = {
        position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
        rotation: {
          x: THREE.MathUtils.radToDeg(mesh.rotation.x),
          y: THREE.MathUtils.radToDeg(mesh.rotation.y),
          z: THREE.MathUtils.radToDeg(mesh.rotation.z)
        }
      };
    });
    return out;
  }

  resetPartPositions() {
    Object.values(this.partMeshes).forEach(m => {
      if (m.userData.originalPosition) {
        m.position.copy(m.userData.originalPosition);
      }
      if (m.userData.originalRotation) {
        m.rotation.copy(m.userData.originalRotation);
      }
    });
    this.transformControls.detach();
    this.selectedPartName = null;
  }

  loadGLTF(url) {
      this.clear();
      this.loadToken = (this.loadToken || 0) + 1;
      const currentToken = this.loadToken;
      
      const loader = new GLTFLoader();
      loader.load(url, (gltf) => {
          if (this.loadToken !== currentToken) {
              // Rapid load override, dispose immediately
              gltf.scene.traverse(child => {
                  if (child.isMesh) {
                      if (child.geometry) child.geometry.dispose();
                      if (child.material) {
                          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
                          else child.material.dispose();
                      }
                  }
              });
              return;
          }
          const model = gltf.scene;
          
          const material = new THREE.MeshStandardMaterial({
              color: COLORS.partBase,
              metalness: 0.3,
              roughness: 0.5,
              emissive: COLORS.partEmissive,
              emissiveIntensity: 0.15,
              flatShading: false,
          });

          // Compute bounding box to center camera
          const box = new THREE.Box3().setFromObject(model);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 100;
          
          model.traverse((child) => {
              if (child.isMesh) {
                  child.material = material;
                  child.castShadow = true;
                  child.receiveShadow = true;
              }
          });

          this.currentModel = model;
          this.scene.add(model);

          const dist = maxDim * 2.0;
          this.camera.position.set(dist, dist * 0.8, dist);
          this.controls.target.copy(box.getCenter(new THREE.Vector3()));
          this.controls.update();

      }, undefined, (err) => console.error("GLTF load error:", err));
  }

  _disposeCurrentModel() {
    if (this.currentModel) {
        this.currentModel.traverse((child) => {
            if (child.isMesh) {
                if (child.geometry) {
                    child.geometry.dispose();
                }
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach(m => m.dispose());
                    } else {
                        child.material.dispose();
                    }
                }
            }
        });
        this.scene.remove(this.currentModel);
        this.currentModel = null;
    }
    
    // Also dispose assembly parts
    Object.values(this.partMeshes || {}).forEach(mesh => {
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
        this.scene.remove(mesh);
    });
    this.partMeshes = {};
    
    // Force renderer to release GPU memory
    this.renderer.renderLists.dispose();
  }

  loadSTL(url) {
    this._disposeCurrentModel();
    this.clearFaceSelection();

    this.loadToken = (this.loadToken || 0) + 1;
    const currentToken = this.loadToken;

    const loader = new STLLoader();
    loader.load(url, (geometry) => {
      if (this.loadToken !== currentToken) {
          geometry.dispose();
          return;
      }
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
    this._updateMouse(e);
    this._raycaster.setFromCamera(this._mouse, this.camera);
    
    // FACE MATE MODE
    if (this.faceMateMode) {
        const allMeshes = Object.values(this.partMeshes);
        if (allMeshes.length === 0) return;
        
        const hits = this._raycaster.intersectObjects(allMeshes, false);
        if (hits.length === 0) return;
        
        const faceInfo = this._getFaceInfo(hits[0]);
        this._highlightFace(faceInfo);
        
        if (this.faceMateStep === 1) {
            this.faceMateSource = faceInfo;
            this.faceMateStep = 2;
            if (this.onFaceMateStep) this.onFaceMateStep(1, faceInfo.mesh.name);
        } else if (this.faceMateStep === 2) {
            if (faceInfo.mesh === this.faceMateSource.mesh) {
                if (this.onFaceMateStep) this.onFaceMateStep(-1, 'Same part — click a face on a different part');
                return;
            }
            this.mateFaces(this.faceMateSource, faceInfo);
            this.stopFaceMateMode();
            if (this.onFaceMateStep) this.onFaceMateStep(2, faceInfo.mesh.name);
        }
        return;
    }

    // MEASURE MODE
    if (this.measureMode) {
        let targetObjects = [];
        if (Object.keys(this.partMeshes).length > 0) {
            targetObjects = Object.values(this.partMeshes);
        } else if (this.currentModel) {
            targetObjects = this.currentModel.isGroup ? this.currentModel.children : [this.currentModel];
        }

        const hits = this._raycaster.intersectObjects(targetObjects, true);
        let pt = null;
        if (hits.length > 0) {
            pt = hits[0].point;
        } else {
            const tempPt = new THREE.Vector3();
            this._raycaster.ray.intersectPlane(this._groundPlane, tempPt);
            if (tempPt) pt = tempPt;
        }

        if (pt) {
            if (this.measurePoints.length >= 2) {
                this.measurePoints = [];
                this._clearMeasureVisuals();
            }
            this.measurePoints.push(pt.clone());

            // Add point marker
            const geo = new THREE.SphereGeometry(1.5, 16, 16);
            const mat = new THREE.MeshBasicMaterial({color: 0xe6a23c, depthTest: false});
            const sphere = new THREE.Mesh(geo, mat);
            sphere.position.copy(pt);
            this.scene.add(sphere);
            if (!this._measureLabels) this._measureLabels = [];
            this._measureLabels.push(sphere);

            if (this.measurePoints.length === 2) {
                const p1 = this.measurePoints[0];
                const p2 = this.measurePoints[1];
                const distance = p1.distanceTo(p2).toFixed(2);
                const dx = Math.abs(p1.x - p2.x).toFixed(2);
                const dy = Math.abs(p1.y - p2.y).toFixed(2);
                const dz = Math.abs(p1.z - p2.z).toFixed(2);

                const lineGeo = new THREE.BufferGeometry().setFromPoints([p1, p2]);
                const lineMat = new THREE.LineBasicMaterial({color: 0xe6a23c, depthTest: false});
                this._measureLine = new THREE.Line(lineGeo, lineMat);
                this.scene.add(this._measureLine);

                const text = `Dist: ${distance}mm (dx:${dx}, dy:${dy}, dz:${dz})`;
                const sprite = this._createMeasureSprite(text);
                sprite.position.copy(p1).lerp(p2, 0.5);
                this.scene.add(sprite);
                this._measureLabels.push(sprite);

                if (window.showToast) window.showToast(text);
            }
        }
        return;
    }

    let targetObjects = [];
    if (Object.keys(this.partMeshes).length > 0) {
        targetObjects = Object.values(this.partMeshes);
    } else if (this.currentModel) {
        if (this.currentModel.isGroup) {
            targetObjects = this.currentModel.children;
        } else {
            targetObjects = [this.currentModel];
        }
    }

    if (targetObjects.length === 0) {
        if (this.gizmoEnabled) this.selectPart(null);
        this.clearFaceSelection();
        if (this.onFaceSelect) this.onFaceSelect(null);
        return;
    }

    const intersects = this._raycaster.intersectObjects(targetObjects, true);

    if (intersects.length > 0) {
      const isect = intersects[0];
      
      // If Gizmo mode is on, attach it and skip face selection!
      if (this.gizmoEnabled && isect.object.isMesh) {
          if (Object.keys(this.partMeshes).length > 0) {
              this.selectPart(isect.object.name);
          } else {
              this.transformControls.attach(isect.object);
          }
          this.clearFaceSelection();
          return;
      }
      
      const hit = isect;
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

  /* ─── Helpers ─── */

  _updateMouse(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }
}
