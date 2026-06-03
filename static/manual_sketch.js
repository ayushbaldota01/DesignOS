// DesignOS 2D Sketch Engine
// HTML5 Canvas-based 2D sketch editor for face editing

const sketch = {
    canvas: null,
    ctx: null,
    tool: 'select',
    elements: [],
    drawing: false,
    startX: 0, startY: 0,
    scale: 2, // px per mm
    offsetX: 0, offsetY: 0,
    snapGrid: 5, // mm
    faceContext: null,
    blockId: null
};

function initSketch() {
    sketch.canvas = document.getElementById('sketchCanvas');
    if (!sketch.canvas) return;
    sketch.ctx = sketch.canvas.getContext('2d');
    
    resizeSketchCanvas();
    drawGrid();
    
    sketch.canvas.addEventListener('mousedown', onSketchMouseDown);
    sketch.canvas.addEventListener('mousemove', onSketchMouseMove);
    sketch.canvas.addEventListener('mouseup', onSketchMouseUp);
    sketch.canvas.addEventListener('wheel', onSketchWheel);
    window.addEventListener('resize', resizeSketchCanvas);
}

function initSketchForFace(faceSelector, blockId) {
    sketch.faceContext = faceSelector;
    sketch.blockId = blockId;
    sketch.elements = [];
    
    // Update face context indicator
    const indicator = document.getElementById('sketchFaceIndicator');
    if (indicator) {
        indicator.textContent = `Editing face: ${getFaceLabelFromSelector(faceSelector)} of BLOCK_${blockId}`;
    }
    
    if (!sketch.canvas) initSketch();
    drawGrid();
}

function resizeSketchCanvas() {
    if (!sketch.canvas) return;
    const container = sketch.canvas.parentElement;
    sketch.canvas.width = container.clientWidth;
    sketch.canvas.height = container.clientHeight;
    sketch.offsetX = sketch.canvas.width / 2;
    sketch.offsetY = sketch.canvas.height / 2;
    redrawSketch();
}

function drawGrid() {
    const ctx = sketch.ctx;
    if (!ctx) return;
    const W = sketch.canvas.width;
    const H = sketch.canvas.height;
    
    ctx.clearRect(0, 0, W, H);
    
    // Background
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, W, H);
    
    // Grid lines
    const gridMm = sketch.snapGrid;
    const gridPx = gridMm * sketch.scale;
    
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 0.5;
    
    // Minor grid
    for (let x = sketch.offsetX % gridPx; x < W; x += gridPx) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = sketch.offsetY % gridPx; y < H; y += gridPx) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    
    // Major grid (every 5 minor)
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1;
    const majorPx = gridPx * 5;
    for (let x = sketch.offsetX % majorPx; x < W; x += majorPx) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = sketch.offsetY % majorPx; y < H; y += majorPx) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    
    // Origin axes
    ctx.strokeStyle = '#3d3d3d';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sketch.offsetX, 0); ctx.lineTo(sketch.offsetX, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, sketch.offsetY); ctx.lineTo(W, sketch.offsetY); ctx.stroke();
    
    // Origin label
    ctx.fillStyle = '#555';
    ctx.font = '10px Consolas';
    ctx.fillText('0,0', sketch.offsetX + 4, sketch.offsetY - 4);
}

function redrawSketch() {
    drawGrid();
    drawElements();
    drawDimensions();
}

function drawElements() {
    const ctx = sketch.ctx;
    sketch.elements.forEach(el => {
        ctx.strokeStyle = el.selected ? '#0078d4' : '#cccccc';
        ctx.lineWidth = el.selected ? 2 : 1.5;
        ctx.fillStyle = 'transparent';
        
        if (el.type === 'line') {
            ctx.beginPath();
            ctx.moveTo(mmToPxX(el.x1), mmToPxY(el.y1));
            ctx.lineTo(mmToPxX(el.x2), mmToPxY(el.y2));
            ctx.stroke();
            
            // Dimension label
            const mx = (mmToPxX(el.x1) + mmToPxX(el.x2)) / 2;
            const my = (mmToPxY(el.y1) + mmToPxY(el.y2)) / 2;
            const len = Math.sqrt((el.x2-el.x1)**2 + (el.y2-el.y1)**2).toFixed(1);
            ctx.fillStyle = '#666';
            ctx.font = '9px Consolas';
            ctx.fillText(`${len}mm`, mx + 4, my - 4);
            
        } else if (el.type === 'circle') {
            ctx.beginPath();
            ctx.arc(mmToPxX(el.cx), mmToPxY(el.cy), el.r * sketch.scale, 0, Math.PI*2);
            ctx.stroke();
            
            // Center cross
            ctx.strokeStyle = '#444';
            ctx.lineWidth = 0.5;
            const cx = mmToPxX(el.cx), cy = mmToPxY(el.cy), cs = 6;
            ctx.beginPath(); ctx.moveTo(cx-cs,cy); ctx.lineTo(cx+cs,cy); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx,cy-cs); ctx.lineTo(cx,cy+cs); ctx.stroke();
            
            ctx.fillStyle = '#666';
            ctx.font = '9px Consolas';
            ctx.fillText(`⌀${(el.r*2).toFixed(1)}mm`, mmToPxX(el.cx)+el.r*sketch.scale+4, mmToPxY(el.cy));
            
        } else if (el.type === 'rect') {
            // Need to adjust Y for rect because canvas fillRect uses top-left, but our Y is inverted
            // If el.y is the top in math coords, it's the top in canvas coords too, but wait...
            // el.h is height. The top-left in canvas is mmToPxX(el.x), mmToPxY(el.y)
            ctx.strokeRect(mmToPxX(el.x), mmToPxY(el.y), el.w*sketch.scale, el.h*sketch.scale);
            ctx.fillStyle = '#666';
            ctx.font = '9px Consolas';
            ctx.fillText(`${el.w}×${el.h}mm`, mmToPxX(el.x)+4, mmToPxY(el.y)-4);
        }
    });
}

function drawDimensions() {
    // Auto dimension annotations for all elements
    // Already handled inline in drawElements
}

// Coordinate conversions
function mmToPxX(mm) { return sketch.offsetX + mm * sketch.scale; }
function mmToPxY(mm) { return sketch.offsetY - mm * sketch.scale; } // Invert Y: CadQuery +Y is UP
function pxToMmX(px) { return (px - sketch.offsetX) / sketch.scale; }
function pxToMmY(px) { return (sketch.offsetY - px) / sketch.scale; } // Invert Y
function snapToGrid(mm) { return Math.round(mm / sketch.snapGrid) * sketch.snapGrid; }

// Mouse events
function onSketchMouseDown(e) {
    const rect = sketch.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const mx = snapToGrid(pxToMmX(px));
    const my = snapToGrid(pxToMmY(py));
    
    sketch.drawing = true;
    sketch.startX = mx;
    sketch.startY = my;
    sketch.tempEl = null;
}

function onSketchMouseMove(e) {
    const rect = sketch.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const mx = snapToGrid(pxToMmX(px));
    const my = snapToGrid(pxToMmY(py));
    
    // Update cursor coords in status bar
    document.getElementById('coords').textContent = 
        `x: ${mx.toFixed(1)}  y: ${my.toFixed(1)}  z: 0.0`;
    
    if (!sketch.drawing) return;
    
    // Preview current element
    redrawSketch();
    
    const ctx = sketch.ctx;
    ctx.strokeStyle = '#0078d4';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    
    if (sketch.tool === 'line') {
        ctx.beginPath();
        ctx.moveTo(mmToPxX(sketch.startX), mmToPxY(sketch.startY));
        ctx.lineTo(px, py);
        ctx.stroke();
    } else if (sketch.tool === 'circle') {
        const r = Math.sqrt((mx-sketch.startX)**2 + (my-sketch.startY)**2);
        ctx.beginPath();
        ctx.arc(mmToPxX(sketch.startX), mmToPxY(sketch.startY), r*sketch.scale, 0, Math.PI*2);
        ctx.stroke();
    } else if (sketch.tool === 'rectangle') {
        ctx.strokeRect(mmToPxX(sketch.startX), mmToPxY(sketch.startY), 
                      (mx-sketch.startX)*sketch.scale, -(my-sketch.startY)*sketch.scale);
    }
    
    ctx.setLineDash([]);
}

function onSketchMouseUp(e) {
    if (!sketch.drawing) return;
    sketch.drawing = false;
    
    const rect = sketch.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const mx = snapToGrid(pxToMmX(px));
    const my = snapToGrid(pxToMmY(py));
    
    if (Math.abs(mx - sketch.startX) < 1 && Math.abs(my - sketch.startY) < 1) return;
    
    if (sketch.tool === 'line') {
        sketch.elements.push({ type:'line', x1:sketch.startX, y1:sketch.startY, x2:mx, y2:my });
    } else if (sketch.tool === 'circle') {
        const r = Math.sqrt((mx-sketch.startX)**2 + (my-sketch.startY)**2);
        sketch.elements.push({ type:'circle', cx:sketch.startX, cy:sketch.startY, r });
    } else if (sketch.tool === 'rectangle') {
        sketch.elements.push({ type:'rect', x:sketch.startX, y:sketch.startY, 
                               w:mx-sketch.startX, h:my-sketch.startY });
    }
    
    redrawSketch();
}

function onSketchWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    sketch.scale *= factor;
    sketch.scale = Math.max(0.5, Math.min(20, sketch.scale));
    redrawSketch();
}

// Tool selection
function setSketchTool(tool) {
    sketch.tool = tool;
    document.querySelectorAll('.sketch-tool').forEach(el => el.classList.remove('active'));
    const btn = document.querySelector(`[data-tool="${tool}"]`);
    if (btn) btn.classList.add('active');
    sketch.canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

// Extrude from sketch
async function extrudeSketch(depth) {
    if (sketch.elements.length === 0) {
        showToast('Draw a profile first'); return;
    }
    
    // Convert sketch elements to CadQuery script addition
    const profile = sketchToCADQuery();
    const instruction = `Add this profile extruded ${depth}mm on face ${sketch.faceContext}: ${profile}`;
    
    switchTab('prompt');
    document.getElementById('aiInput').value = instruction;
    await submitChat(instruction);
}

function sketchToCADQuery() {
    // Convert sketch elements to natural language description for AI
    const descriptions = sketch.elements.map(el => {
        if (el.type === 'circle') return `circle diameter ${(el.r*2).toFixed(1)}mm at ${el.cx},${el.cy}`;
        if (el.type === 'rect') return `rectangle ${el.w}x${el.h}mm at ${el.x},${el.y}`;
        if (el.type === 'line') return `line from ${el.x1},${el.y1} to ${el.x2},${el.y2}`;
        return '';
    });
    return descriptions.join('; ');
}

// Clear sketch
function clearSketch() {
    sketch.elements = [];
    redrawSketch();
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    // Only init when Manual tab is active
    const manualTab = document.getElementById('tabManual');
    if (manualTab) {
        manualTab.addEventListener('click', () => {
            setTimeout(initSketch, 100);
        });
    }
});
