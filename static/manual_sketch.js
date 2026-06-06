/**
 * DesignOS Manual Sketch Engine
 * 2D canvas sketch with live 3D preview sync
 */

const sketch = {
    canvas: null, ctx: null,
    tool: 'select',
    elements: [],
    undoStack: [],
    redoStack: [],
    drawing: false,
    startX: 0, startY: 0,
    scale: 3,           // px per mm
    offsetX: 0, offsetY: 0,
    snapGrid: 5,        // mm
    snapAngle: false,
    snapVertexEdge: true,
    plane: 'top',       // 'top'|'front'|'side'
    cursor: {x:0, y:0} // current mm position
};

// ── INIT ─────────────────────────────────────────────────────────

function initSketch() {
    sketch.canvas = document.getElementById('sketchCanvas');
    if (!sketch.canvas) return;
    sketch.ctx = sketch.canvas.getContext('2d');
    resizeSketchCanvas();
    bindSketchEvents();
}

function resizeSketchCanvas() {
    if (!sketch.canvas) return;
    sketch.canvas.width  = sketch.canvas.clientWidth  || 600;
    sketch.canvas.height = sketch.canvas.clientHeight || 400;
    sketch.offsetX = sketch.canvas.width  / 2;
    sketch.offsetY = sketch.canvas.height / 2;
    redrawSketch();
}

function bindSketchEvents() {
    const c = sketch.canvas;
    c.addEventListener('mousedown', onSketchDown);
    c.addEventListener('mousemove', onSketchMove);
    c.addEventListener('mouseup',   onSketchUp);
    c.addEventListener('wheel',     onSketchWheel, {passive:false});
    c.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', resizeSketchCanvas);
}

// ── COORDINATE UTILS ─────────────────────────────────────────────

function mmToPx(mm) { return sketch.offsetX + mm * sketch.scale; }
function mmToPy(mm) { return sketch.offsetY - mm * sketch.scale; } // Y-up in sketch
function pxToMmX(px) { return (px - sketch.offsetX) / sketch.scale; }
function pxToMmY(py) { return -(py - sketch.offsetY) / sketch.scale; }

function snapMm(val) {
    if (!document.getElementById('snapGrid')?.checked) return val;
    return Math.round(val / sketch.snapGrid) * sketch.snapGrid;
}

function snapAngleLine(x1, y1, x2, y2) {
    if (!document.getElementById('snapAngle')?.checked) return {x:x2, y:y2};
    const dx = x2-x1, dy = y2-y1;
    const angle = Math.atan2(dy, dx);
    const step = Math.PI/12; // 15 degrees
    const snapped = Math.round(angle/step)*step;
    const len = Math.sqrt(dx*dx+dy*dy);
    return { x: x1+Math.cos(snapped)*len, y: y1+Math.sin(snapped)*len };
}

// ── DRAW ─────────────────────────────────────────────────────────

function redrawSketch() {
    if (!sketch.ctx) return;
    drawGrid();
    drawElements();
    updateElementCount();
}

function drawGrid() {
    const ctx = sketch.ctx;
    const W = sketch.canvas.width, H = sketch.canvas.height;

    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, W, H);

    const minor = sketch.snapGrid * sketch.scale;
    const major = minor * 5;

    // Minor grid
    ctx.strokeStyle = '#242424'; ctx.lineWidth = 0.5;
    for (let x = sketch.offsetX%minor; x<W; x+=minor) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = sketch.offsetY%minor; y<H; y+=minor) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    // Major grid
    ctx.strokeStyle = '#303030'; ctx.lineWidth = 1;
    for (let x = sketch.offsetX%major; x<W; x+=major) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = sketch.offsetY%major; y<H; y+=major) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    // Axes
    ctx.strokeStyle = '#3d3d3d'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sketch.offsetX,0); ctx.lineTo(sketch.offsetX,H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,sketch.offsetY); ctx.lineTo(W,sketch.offsetY); ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#555'; ctx.font = '10px Consolas';
    const planeLabels = { top:'X', front:'X', side:'Y' };
    const planeLabels2 = { top:'Y', front:'Z', side:'Z' };
    ctx.fillText(planeLabels[sketch.plane] || 'X', W-16, sketch.offsetY-6);
    ctx.fillText(planeLabels2[sketch.plane] || 'Y', sketch.offsetX+6, 14);
    ctx.fillText('0', sketch.offsetX+4, sketch.offsetY-4);
}

function drawElements(preview) {
    const ctx = sketch.ctx;
    const allEls = preview ? [...sketch.elements, preview] : sketch.elements;

    allEls.forEach((el, i) => {
        const isPreview = i === allEls.length-1 && preview;
        ctx.strokeStyle = isPreview ? '#0078d4' : (el.selected ? '#5b9bd5' : '#cccccc');
        ctx.lineWidth = isPreview ? 1.5 : 1.5;
        ctx.setLineDash(isPreview ? [5,4] : []);
        ctx.fillStyle = 'transparent';

        if (el.type === 'line') {
            const snapped = isPreview ? el : snapAngleLine(el.x1,el.y1,el.x2,el.y2);
            ctx.beginPath();
            ctx.moveTo(mmToPx(el.x1), mmToPy(el.y1));
            ctx.lineTo(mmToPx(el.x2 !== undefined ? el.x2 : snapped.x),
                       mmToPy(el.y2 !== undefined ? el.y2 : snapped.y));
            ctx.stroke();
            // Length annotation
            if (!isPreview) {
                const len = Math.sqrt((el.x2-el.x1)**2+(el.y2-el.y1)**2).toFixed(1);
                const mx = (mmToPx(el.x1)+mmToPx(el.x2))/2;
                const my = (mmToPy(el.y1)+mmToPy(el.y2))/2;
                ctx.setLineDash([]);
                ctx.fillStyle='#666'; ctx.font='9px Consolas';
                ctx.fillText(`${len}mm`, mx+4, my-4);
            }

        } else if (el.type === 'circle') {
            ctx.beginPath();
            ctx.arc(mmToPx(el.cx), mmToPy(el.cy), el.r*sketch.scale, 0, Math.PI*2);
            ctx.stroke();
            // Center mark
            ctx.setLineDash([]);
            ctx.strokeStyle = '#444'; ctx.lineWidth = 0.5;
            const cx=mmToPx(el.cx), cy=mmToPy(el.cy);
            ctx.beginPath(); ctx.moveTo(cx-6,cy); ctx.lineTo(cx+6,cy); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx,cy-6); ctx.lineTo(cx,cy+6); ctx.stroke();
            // Diameter annotation
            if (!isPreview) {
                ctx.fillStyle='#666'; ctx.font='9px Consolas';
                ctx.fillText(`⌀${(el.r*2).toFixed(1)}mm`, cx+el.r*sketch.scale+4, cy);
            }

        } else if (el.type === 'rect') {
            ctx.strokeRect(mmToPx(el.x), mmToPy(el.y+el.h),
                          el.w*sketch.scale, el.h*sketch.scale);
            if (!isPreview) {
                ctx.fillStyle='#666'; ctx.font='9px Consolas';
                ctx.fillText(`${el.w}×${el.h}mm`, mmToPx(el.x)+2, mmToPy(el.y+el.h)-4);
            }

        } else if (el.type === 'template_marker') {
            // Visual placeholder for template added at position
            ctx.strokeStyle = '#0078d4';
            ctx.setLineDash([3,3]);
            ctx.strokeRect(mmToPx(el.x)-20, mmToPy(el.y)-20, 40, 40);
            ctx.setLineDash([]);
            ctx.fillStyle = '#5b9bd5'; ctx.font = 'bold 10px Consolas';
            ctx.fillText(el.template.toUpperCase(), mmToPx(el.x)-16, mmToPy(el.y)+4);
        } else if (el.type === 'measure_temp' || el.type === 'measure') {
            ctx.strokeStyle = '#e6a23c'; 
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(mmToPx(el.x1), mmToPy(el.y1));
            ctx.lineTo(mmToPx(el.x2), mmToPy(el.y2));
            ctx.stroke();
            const len = Math.sqrt((el.x2-el.x1)**2+(el.y2-el.y1)**2).toFixed(3);
            const dx = Math.abs(el.x2-el.x1).toFixed(3);
            const dy = Math.abs(el.y2-el.y1).toFixed(3);
            const mx = (mmToPx(el.x1)+mmToPx(el.x2))/2;
            const my = (mmToPy(el.y1)+mmToPy(el.y2))/2;
            ctx.setLineDash([]);
            ctx.fillStyle='#e6a23c'; ctx.font='10px Consolas';
            ctx.fillText(`Dist: ${len}mm (dx:${dx}, dy:${dy})`, mx+4, my-4);
        }
    });
    ctx.setLineDash([]);
}

function updateElementCount() {
    const el = document.getElementById('sketchElementCount');
    if (el) el.textContent = `${sketch.elements.length} element${sketch.elements.length!==1?'s':''}`;
}

// ── MOUSE EVENTS ─────────────────────────────────────────────────

function onSketchDown(e) {
    const {mx, my} = getSketchCoords(e);
    sketch.drawing = true;
    sketch.startX = mx; sketch.startY = my;
}

function onSketchMove(e) {
    const {px, py, mx, my} = getSketchCoords(e);
    sketch.cursor = {x:mx, y:my};

    // Update coord display
    const cd = document.getElementById('sketchCoordsDisplay');
    if (cd) cd.textContent = `x: ${mx.toFixed(1)}  y: ${my.toFixed(1)} mm`;

    if (!sketch.drawing || sketch.tool === 'select') return;

    // Draw preview
    let preview = null;
    if (sketch.tool === 'line') {
        preview = {type:'line', x1:sketch.startX, y1:sketch.startY, x2:mx, y2:my};
    } else if (sketch.tool === 'circle') {
        const r = Math.sqrt((mx-sketch.startX)**2+(my-sketch.startY)**2);
        preview = {type:'circle', cx:sketch.startX, cy:sketch.startY, r};
    } else if (sketch.tool === 'rectangle') {
        preview = {type:'rect', x:sketch.startX, y:sketch.startY,
                   w:mx-sketch.startX, h:my-sketch.startY};
    } else if (sketch.tool === 'measure') {
        preview = {type:'measure', x1:sketch.startX, y1:sketch.startY, x2:mx, y2:my};
    }
    redrawSketch();
    if (preview) drawElements(preview);
}

function onSketchUp(e) {
    if (!sketch.drawing) return;
    sketch.drawing = false;

    const {mx, my} = getSketchCoords(e);
    const dx = Math.abs(mx-sketch.startX), dy = Math.abs(my-sketch.startY);

    if (sketch.tool === 'measure') {
        sketch.elements = sketch.elements.filter(e => e.type !== 'measure_temp');
        sketch.elements.push({type:'measure_temp', x1:sketch.startX, y1:sketch.startY, x2:mx, y2:my});
        redrawSketch();
        return;
    }

    pushUndoState();

    if (sketch.tool === 'line' && (dx>0.5||dy>0.5)) {
        sketch.elements.push({type:'line', x1:sketch.startX, y1:sketch.startY, x2:mx, y2:my});
    } else if (sketch.tool === 'circle' && (dx>0.5||dy>0.5)) {
        const r = Math.sqrt(dx*dx+dy*dy);
        sketch.elements.push({type:'circle', cx:sketch.startX, cy:sketch.startY, r});
    } else if (sketch.tool === 'rectangle' && dx>1 && dy>1) {
        sketch.elements.push({type:'rect', x:sketch.startX, y:sketch.startY, w:dx, h:dy});
    } else if (sketch.tool === 'point') {
        sketch.elements.push({type:'point', x:mx, y:my});
    }

    redrawSketch();
    scheduleLivePreview();
}

function onSketchWheel(e) {
    e.preventDefault();
    // Zoom toward mouse
    const rect = sketch.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.85 : 1.18;
    const oldScale = sketch.scale;
    sketch.scale *= factor;
    sketch.scale = Math.max(0.3, Math.min(30, sketch.scale));
    // Adjust offset so zoom centers on mouse position
    sketch.offsetX = mx - (mx - sketch.offsetX) * (sketch.scale/oldScale);
    sketch.offsetY = my - (my - sketch.offsetY) * (sketch.scale/oldScale);
    redrawSketch();
}

function getSketchCoords(e) {
    const rect = sketch.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let mx = pxToMmX(px);
    let my = pxToMmY(py);

    if (sketch.snapVertexEdge !== false && sketch.elements.length > 0) {
        let bestDist = 2.0; // snap threshold in mm
        let snappedX = mx;
        let snappedY = my;
        let didSnap = false;

        function checkSnap(vx, vy) {
            if(vx===undefined || vy===undefined) return;
            const d = Math.sqrt((mx-vx)**2 + (my-vy)**2);
            if (d < bestDist) { bestDist = d; snappedX = vx; snappedY = vy; didSnap = true; }
        }
        function checkSnapEdge(x1, y1, x2, y2) {
            const l2 = (x1-x2)**2 + (y1-y2)**2;
            if (l2 === 0) return checkSnap(x1, y1);
            let t = ((mx-x1)*(x2-x1) + (my-y1)*(y2-y1)) / l2;
            t = Math.max(0, Math.min(1, t));
            checkSnap(x1 + t*(x2-x1), y1 + t*(y2-y1));
        }

        sketch.elements.forEach(el => {
            if (el.type === 'line') {
                checkSnap(el.x1, el.y1); checkSnap(el.x2, el.y2);
                checkSnapEdge(el.x1, el.y1, el.x2, el.y2);
            } else if (el.type === 'rect') {
                checkSnap(el.x, el.y); checkSnap(el.x+el.w, el.y);
                checkSnap(el.x, el.y+el.h); checkSnap(el.x+el.w, el.y+el.h);
                checkSnapEdge(el.x, el.y, el.x+el.w, el.y);
                checkSnapEdge(el.x, el.y, el.x, el.y+el.h);
                checkSnapEdge(el.x+el.w, el.y, el.x+el.w, el.y+el.h);
                checkSnapEdge(el.x, el.y+el.h, el.x+el.w, el.y+el.h);
            } else if (el.type === 'circle') {
                checkSnap(el.cx, el.cy);
            } else if (el.type === 'point') {
                checkSnap(el.x, el.y);
            }
        });

        if (didSnap) {
            mx = snappedX; my = snappedY;
        } else {
            mx = snapMm(mx); my = snapMm(my);
        }
    } else {
        mx = snapMm(mx); my = snapMm(my);
    }
    return {px, py, mx, my};
}

// ── TOOL SELECTION ───────────────────────────────────────────────

function setSketchTool(tool) {
    sketch.tool = tool;
    sketch.elements = sketch.elements.filter(e => e.type !== 'measure_temp');
    redrawSketch();
    document.querySelectorAll('.sketch-tool-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`[data-tool="${tool}"]`);
    if (btn) btn.classList.add('active');
    sketch.canvas.style.cursor = (tool === 'select' || tool === 'measure') ? 'default' : 'crosshair';
}

function toggleSnap(type, enabled) {
    if (type === 'angle') sketch.snapAngle = enabled;
    if (type === 'vertex_edge') sketch.snapVertexEdge = enabled;
    if (type === 'grid') {
        const el = document.getElementById('snapGrid');
        if (el) el.checked = enabled;
    }
}

// ── VIEW PLANE ───────────────────────────────────────────────────

function setSketchPlane(plane) {
    sketch.plane = plane;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    event?.target?.classList.add('active');

    // Update face indicator
    const labels = { top:'XY Plane (Top view)', front:'XZ Plane (Front view)', side:'YZ Plane (Side view)' };
    const ind = document.getElementById('sketchFaceIndicator');
    if (ind) ind.textContent = labels[plane] || plane;

    redrawSketch();
}

// ── 3D PREVIEW ───────────────────────────────────────────────────

let previewRenderer = null;
let previewScene = null;
let previewCamera = null;
let previewAnimId = null;

function init3DPreview() {
    const canvas = document.getElementById('preview3DCanvas');
    if (!canvas || !window.THREE) return;

    previewRenderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
    previewRenderer.setSize(canvas.clientWidth || 280, canvas.clientHeight || 300);
    previewRenderer.setPixelRatio(window.devicePixelRatio);
    previewRenderer.setClearColor(0x141414);

    previewScene = new THREE.Scene();
    previewScene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 2, 1);
    previewScene.add(dir);

    previewCamera = new THREE.PerspectiveCamera(45, 280/300, 0.1, 10000);
    previewCamera.position.set(200, 200, 200);
    previewCamera.lookAt(0,0,0);

    // Grid
    const grid = new THREE.GridHelper(200, 20, 0x333333, 0x252525);
    previewScene.add(grid);

    function animate() {
        previewAnimId = requestAnimationFrame(animate);
        previewRenderer.render(previewScene, previewCamera);
    }
    animate();
}

function set3DPreviewAngle(view) {
    if (!previewCamera) return;
    const d = 250;
    if (view === 'top')   { previewCamera.position.set(0, d, 0.01); }
    if (view === 'front') { previewCamera.position.set(0, 0, d); }
    if (view === 'iso')   { previewCamera.position.set(d, d*0.8, d); }
    previewCamera.lookAt(0,0,0);
}

let previewMesh = null;

function updateLivePreview() {
    if (!previewScene || !window.THREE) return;

    // Remove old preview mesh
    if (previewMesh) { previewScene.remove(previewMesh); previewMesh = null; }

    // Build simple extruded shape from sketch elements
    const depth = parseFloat(document.getElementById('extrudeDepth')?.value || 10);
    const shapes = sketchElementsToThreeShapes();

    if (shapes.length === 0) return;

    try {
        const extrudeSettings = { depth, bevelEnabled: false };
        const geometry = new THREE.ExtrudeGeometry(shapes, extrudeSettings);
        const material = new THREE.MeshStandardMaterial({
            color: 0x6a9fd8, metalness:0.3, roughness:0.5,
            transparent:true, opacity:0.85
        });
        previewMesh = new THREE.Mesh(geometry, material);

        // Rotate based on sketch plane
        if (sketch.plane === 'front') previewMesh.rotation.x = -Math.PI/2;
        if (sketch.plane === 'side')  previewMesh.rotation.y = -Math.PI/2;

        previewScene.add(previewMesh);

        // Fit camera
        const box = new THREE.Box3().setFromObject(previewMesh);
        const center = new THREE.Vector3();
        box.getCenter(center);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z) || 50;
        set3DPreviewAngle('iso');
        previewCamera.lookAt(center);
    } catch(e) {
        console.warn('Preview update failed:', e);
    }
}

function sketchElementsToThreeShapes() {
    if (!window.THREE) return [];
    const shapes = [];

    sketch.elements.forEach(el => {
        try {
            if (el.type === 'circle' && el.r > 0) {
                const shape = new THREE.Shape();
                shape.absarc(el.cx, el.cy, el.r, 0, Math.PI*2, false);
                shapes.push(shape);
            } else if (el.type === 'rect' && el.w > 0 && el.h > 0) {
                const shape = new THREE.Shape();
                shape.moveTo(el.x, el.y);
                shape.lineTo(el.x+el.w, el.y);
                shape.lineTo(el.x+el.w, el.y+el.h);
                shape.lineTo(el.x, el.y+el.h);
                shape.closePath();
                shapes.push(shape);
            }
        } catch(e) {}
    });

    return shapes;
}

let previewTimer = null;
function scheduleLivePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updateLivePreview, 400);
}

// ── UNDO / REDO ──────────────────────────────────────────────────

function pushUndoState() {
    sketch.undoStack.push(JSON.stringify(sketch.elements.filter(e => e.type !== 'measure_temp')));
    if (sketch.undoStack.length > 30) sketch.undoStack.shift();
    sketch.redoStack = [];
}

function undoSketch() {
    if (sketch.undoStack.length === 0) return;
    sketch.redoStack.push(JSON.stringify(sketch.elements.filter(e => e.type !== 'measure_temp')));
    sketch.elements = JSON.parse(sketch.undoStack.pop());
    redrawSketch();
    scheduleLivePreview();
}

function redoSketch() {
    if (sketch.redoStack.length === 0) return;
    sketch.undoStack.push(JSON.stringify(sketch.elements.filter(e => e.type !== 'measure_temp')));
    sketch.elements = JSON.parse(sketch.redoStack.pop());
    redrawSketch();
    scheduleLivePreview();
}

// ── SYNC 3D ↔ 2D ─────────────────────────────────────────────────

function syncFrom3D() {
    // Project current 3D model bounding box onto 2D sketch plane
    if (!window.viewerInstance) {
        showToast('No 3D model loaded');
        return;
    }

    const bbox = getViewerBoundingBox();
    if (!bbox) { showToast('No geometry in 3D viewport'); return; }

    pushUndoState();

    // Create rectangle from bounding box projection onto selected plane
    let rx, ry, rw, rh;

    if (sketch.plane === 'top') {
        rx = bbox.min.x; ry = bbox.min.z;
        rw = bbox.max.x - bbox.min.x;
        rh = bbox.max.z - bbox.min.z;
    } else if (sketch.plane === 'front') {
        rx = bbox.min.x; ry = bbox.min.y;
        rw = bbox.max.x - bbox.min.x;
        rh = bbox.max.y - bbox.min.y;
    } else { // side
        rx = bbox.min.z; ry = bbox.min.y;
        rw = bbox.max.z - bbox.min.z;
        rh = bbox.max.y - bbox.min.y;
    }

    sketch.elements.push({
        type: 'rect',
        x: rx, y: ry, w: rw, h: rh,
        fromProjection: true
    });

    redrawSketch();
    showToast(`Projected ${sketch.plane} view from 3D model`);
}

function getViewerBoundingBox() {
    if (!window.viewerInstance || !window.THREE) return null;
    const scene = window.viewerInstance.scene;
    const box = new THREE.Box3();
    let hasObjects = false;

    scene.traverse(obj => {
        if (obj.isMesh && obj.name !== 'grid') {
            box.expandByObject(obj);
            hasObjects = true;
        }
    });

    return hasObjects ? box : null;
}

function syncTo3D() {
    // Send sketch description to prompt tab as AI instruction
    if (sketch.elements.length === 0) {
        showToast('Nothing to sync — draw something first');
        return;
    }
    sendSketchToPromptTab();
}

// ── TEMPLATE AT CURSOR ────────────────────────────────────────────

function addTemplateAt2DCursor(templateName) {
    const x = sketch.cursor.x;
    const y = sketch.cursor.y;

    pushUndoState();
    sketch.elements.push({
        type: 'template_marker',
        template: templateName,
        x, y
    });

    redrawSketch();
    showToast(`${templateName} marker added at (${x.toFixed(0)}, ${y.toFixed(0)}) — generate in Prompt tab`);
}

// ── EXTRUDE + EXPORT ─────────────────────────────────────────────

async function extrudeSketch(depth) {
    const depthVal = parseFloat(depth) || 10;
    
    // Filter usable elements
    const rects = sketch.elements.filter(e => e.type === 'rect');
    const circles = sketch.elements.filter(e => e.type === 'circle');
    
    if (rects.length === 0 && circles.length === 0) {
        showToast('Draw a rectangle or circle profile first');
        return;
    }
    
    // DIRECT execution — no Qwen, no AI
    // Build CadQuery script directly from sketch geometry
    const faceSelector = getFaceSelectorFromPlane(sketch.plane);
    let scriptLines = [
        "import cadquery as cq",
        "import sys",
        "sys.path.insert(0, r'H:\\DesignOS')",
        ""
    ];
    
    // Check if we're adding to existing geometry
    const hasExisting = window.currentScript && 
                        window.currentScript.includes('output_path');
    
    if (hasExisting) {
        // Inject into existing script — add operation on selected face
        scriptLines = window.currentScript.split('\n')
            .filter(l => !l.includes('exporters.export'));
        
        // Add sketch elements as operations on existing geometry
        circles.forEach((el, i) => {
            scriptLines.push(
                `result = result.faces("${faceSelector}").workplane()` +
                `.moveTo(${el.cx.toFixed(1)}, ${el.cy.toFixed(1)})` +
                `.circle(${el.r.toFixed(1)}).extrude(${depthVal})`
            );
        });
        
        rects.forEach((el, i) => {
            const cx = (el.x + el.w/2).toFixed(1);
            const cy = (el.y + el.h/2).toFixed(1);
            scriptLines.push(
                `result = result.faces("${faceSelector}").workplane()` +
                `.moveTo(${cx}, ${cy})` +
                `.rect(${Math.abs(el.w).toFixed(1)}, ${Math.abs(el.h).toFixed(1)})` +
                `.extrude(${depthVal})`
            );
        });
        
        scriptLines.push('cq.exporters.export(result, output_path)');
    } else {
        // Fresh geometry from sketch
        if (circles.length > 0) {
            const el = circles[0];
            scriptLines.push(
                `result = cq.Workplane("XY").circle(${el.r.toFixed(1)}).extrude(${depthVal})`
            );
            circles.slice(1).forEach(el => {
                scriptLines.push(
                    `result = result.faces(">Z").workplane()` +
                    `.moveTo(${el.cx.toFixed(1)}, ${el.cy.toFixed(1)})` +
                    `.circle(${el.r.toFixed(1)}).extrude(${depthVal})`
                );
            });
        } else if (rects.length > 0) {
            const el = rects[0];
            scriptLines.push(
                `result = cq.Workplane("XY")` +
                `.rect(${Math.abs(el.w).toFixed(1)}, ${Math.abs(el.h).toFixed(1)})` +
                `.extrude(${depthVal})`
            );
            rects.slice(1).forEach(el => {
                scriptLines.push(
                    `result = result.faces(">Z").workplane()` +
                    `.rect(${Math.abs(el.w).toFixed(1)}, ${Math.abs(el.h).toFixed(1)})` +
                    `.extrude(${depthVal})`
                );
            });
        }
        scriptLines.push('cq.exporters.export(result, output_path)');
    }
    
    const script = scriptLines.join('\n');
    
    // Execute directly — bypasses Qwen completely
    showToast('Extruding...');
    addChatMessage('system', `Direct extrude ${depthVal}mm from 2D sketch`);
    
    const res = await fetch('/execute_raw_script', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({script})
    });
    const data = await res.json();
    
    if (data.job_id) {
        // Update current script
        window.currentScript = script;
        if (window.monacoInstance) window.monacoInstance.setValue(script);
        
        connectSSE(data.job_id, onLog, (status) => {
            if (status === 'done') {
                loadSTL(`/model/${data.job_id}`);
                window.currentJobId = data.job_id;
                document.getElementById('downloadBtn').style.display = 'block';
                addChatMessage('success', 'Extrude complete');
                switchTab('prompt'); // Switch to see result
            } else {
                addChatMessage('error', 'Extrude failed — check script editor');
            }
        });
    }
}

// Add hole directly — also bypasses Qwen
async function addHoleFromSketch(dia, x, y) {
    if (!window.currentScript) {
        showToast('Generate a base geometry first in Prompt tab');
        return;
    }
    
    const faceSelector = getFaceSelectorFromPlane(sketch.plane);
    
    const lines = window.currentScript.split('\n')
        .filter(l => !l.includes('exporters.export'));
    
    lines.push(
        `result = result.faces("${faceSelector}").workplane()` +
        `.moveTo(${parseFloat(x).toFixed(1)}, ${parseFloat(y).toFixed(1)})` +
        `.hole(${parseFloat(dia).toFixed(1)})`
    );
    lines.push('cq.exporters.export(result, output_path)');
    
    const script = lines.join('\n');
    window.currentScript = script;
    
    const res = await fetch('/execute_raw_script', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({script})
    });
    const data = await res.json();
    if (data.job_id) {
        connectSSE(data.job_id, onLog, (status) => {
            if (status === 'done') loadSTL(`/model/${data.job_id}`);
        });
    }
}

function getFaceSelectorFromPlane(plane) {
    const map = { top: '>Z', front: '>Y', side: '>X' };
    return map[plane] || '>Z';
}

async function createHoleFromSketch() {
    if (sketch.elements.filter(e => e.type !== 'template_marker' && e.type !== 'measure_temp').length === 0) {
        showToast('Draw a closed profile (circle/rectangle) or point first');
        return;
    }
    const dia = document.getElementById('manualHoleDia')?.value || 5;
    const depth = document.getElementById('manualHoleDepth')?.value || 10;
    const description = sketchToDescription();
    const instruction = `Create hole from this 2D sketch profile (Diameter: ${dia}mm, Depth: ${depth}mm):\n${description}`;
    switchTab('prompt');
    document.getElementById('aiInput').value = instruction;
    await submitChat(instruction);
}

function sketchToDescription() {
    return sketch.elements.map(el => {
        if (el.type === 'circle')
            return `circle: center(${el.cx.toFixed(1)}, ${el.cy.toFixed(1)}) diameter ${(el.r*2).toFixed(1)}mm`;
        if (el.type === 'rect')
            return `rectangle: origin(${el.x.toFixed(1)}, ${el.y.toFixed(1)}) size ${el.w.toFixed(1)}x${el.h.toFixed(1)}mm`;
        if (el.type === 'line')
            return `line: from(${el.x1.toFixed(1)},${el.y1.toFixed(1)}) to(${el.x2.toFixed(1)},${el.y2.toFixed(1)})`;
        if (el.type === 'template_marker')
            return `template: ${el.template} at position(${el.x.toFixed(1)},${el.y.toFixed(1)})`;
        return '';
    }).filter(Boolean).join('\n');
}

function sendSketchToPromptTab() {
    const desc = sketchToDescription();
    if (!desc) { showToast('Nothing to send'); return; }
    switchTab('prompt');
    document.getElementById('aiInput').value =
        `Build this assembly from 2D sketch (plane: ${sketch.plane}):\n${desc}`;
    showToast('Sketch sent to Prompt tab');
}

// ── CLEAR ─────────────────────────────────────────────────────────

function clearSketch() {
    pushUndoState();
    sketch.elements = [];
    if (previewMesh && previewScene) {
        previewScene.remove(previewMesh);
        previewMesh = null;
    }
    redrawSketch();
}

// ── EXISTING COMPAT ───────────────────────────────────────────────

function initSketchForFace(faceSelector, blockId) {
    const labels = {'>Z':'Top',  '<Z':'Bottom', '>X':'Right', '<X':'Left', '>Y':'Front', '<Y':'Back'};
    const plane_map = {'>Z':'top', '<Z':'top', '>X':'side', '<X':'side', '>Y':'front', '<Y':'front'};
    sketch.plane = plane_map[faceSelector] || 'top';

    const ind = document.getElementById('sketchFaceIndicator');
    if (ind) ind.textContent = `Editing face: ${labels[faceSelector]||faceSelector} of BLOCK_${blockId}`;

    if (!sketch.canvas) initSketch();
    redrawSketch();
}

// ── BOOT ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    const manualTab = document.getElementById('tabManual');
    if (manualTab) {
        manualTab.addEventListener('click', () => {
            setTimeout(() => {
                initSketch();
                init3DPreview();
                resizeSketchCanvas();
            }, 100);
        });
    }
});
