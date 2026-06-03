/**
 * DesignOS - Manual 2D Sketching and Extrusion
 */

let manualState = {
  elements: [],
  currentTool: 'select',
  isDrawing: false,
  points: [],
  ctx: null,
  canvas: null,
  width: 0,
  height: 0,
  pxPerMm: 5,
  centerX: 0,
  centerY: 0,
  mouseX: 0,
  mouseY: 0,
  snappedX: 0,
  snappedY: 0,
  gridSize: 5
};

window.initManualSketcher = function() {
  const viewport = document.getElementById('manualViewport');
  viewport.innerHTML = `
    <canvas id="manualCanvas" style="width: 100%; height: 100%; cursor: crosshair;"></canvas>
    <div id="manualCoords" style="position: absolute; bottom: 10px; right: 10px; color: var(--text-dim); font-size: 11px;"></div>
  `;
  
  const cvs = document.getElementById('manualCanvas');
  manualState.canvas = cvs;
  manualState.ctx = cvs.getContext('2d');
  
  // Handle resize
  const resizeObserver = new ResizeObserver(entries => {
    for (let entry of entries) {
      cvs.width = entry.contentRect.width;
      cvs.height = entry.contentRect.height;
      manualState.width = cvs.width;
      manualState.height = cvs.height;
      manualState.centerX = cvs.width / 2;
      manualState.centerY = cvs.height / 2;
      drawManualSketch();
    }
  });
  resizeObserver.observe(viewport);

  cvs.onmousemove = onManualMouseMove;
  cvs.onmousedown = onManualMouseDown;
  cvs.onmouseup = onManualMouseUp;
};

function getSnapped(val) {
  return Math.round(val / manualState.gridSize) * manualState.gridSize;
}

function onManualMouseMove(e) {
  const rect = manualState.canvas.getBoundingClientRect();
  manualState.mouseX = e.clientX - rect.left;
  manualState.mouseY = e.clientY - rect.top;
  
  const mmX = (manualState.mouseX - manualState.centerX) / manualState.pxPerMm;
  const mmY = (manualState.centerY - manualState.mouseY) / manualState.pxPerMm;
  
  manualState.snappedX = getSnapped(mmX);
  manualState.snappedY = getSnapped(mmY);
  
  document.getElementById('manualCoords').textContent = `X: ${manualState.snappedX} Y: ${manualState.snappedY} mm`;
  
  drawManualSketch();
}

function onManualMouseDown(e) {
  if (manualState.currentTool === 'line') {
    if (!manualState.isDrawing) {
      manualState.isDrawing = true;
      manualState.points = [{x: manualState.snappedX, y: manualState.snappedY}];
    } else {
      manualState.points.push({x: manualState.snappedX, y: manualState.snappedY});
      // Auto close if clicking near start
      const start = manualState.points[0];
      const dx = manualState.snappedX - start.x;
      const dy = manualState.snappedY - start.y;
      if (manualState.points.length > 2 && Math.sqrt(dx*dx + dy*dy) < manualState.gridSize) {
        manualState.isDrawing = false;
        manualState.elements.push({ type: 'polyline', points: [...manualState.points] });
        manualState.points = [];
      }
    }
  } else if (manualState.currentTool === 'circle') {
    if (!manualState.isDrawing) {
      manualState.isDrawing = true;
      manualState.points = [{x: manualState.snappedX, y: manualState.snappedY}];
    } else {
      const center = manualState.points[0];
      const dx = manualState.snappedX - center.x;
      const dy = manualState.snappedY - center.y;
      const r = Math.sqrt(dx*dx + dy*dy);
      manualState.elements.push({ type: 'circle', x: center.x, y: center.y, r: r });
      manualState.isDrawing = false;
      manualState.points = [];
    }
  } else if (manualState.currentTool === 'rectangle') {
    if (!manualState.isDrawing) {
      manualState.isDrawing = true;
      manualState.points = [{x: manualState.snappedX, y: manualState.snappedY}];
    } else {
      const start = manualState.points[0];
      const w = Math.abs(manualState.snappedX - start.x);
      const h = Math.abs(manualState.snappedY - start.y);
      const cx = (manualState.snappedX + start.x) / 2;
      const cy = (manualState.snappedY + start.y) / 2;
      manualState.elements.push({ type: 'rect', x: cx, y: cy, w: w, h: h });
      manualState.isDrawing = false;
      manualState.points = [];
    }
  }
  updatePropsBody();
  drawManualSketch();
}

function onManualMouseUp(e) {}

function drawManualSketch() {
  if (!manualState.ctx) return;
  const ctx = manualState.ctx;
  ctx.clearRect(0, 0, manualState.width, manualState.height);
  
  const ox = manualState.centerX;
  const oy = manualState.centerY;
  const p = manualState.pxPerMm;
  
  // Draw Axes
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ox, 0); ctx.lineTo(ox, manualState.height);
  ctx.moveTo(0, oy); ctx.lineTo(manualState.width, oy);
  ctx.stroke();

  // Draw Grid
  ctx.strokeStyle = '#222';
  const gridPx = manualState.gridSize * p;
  ctx.beginPath();
  for (let x = ox % gridPx; x < manualState.width; x += gridPx) { ctx.moveTo(x, 0); ctx.lineTo(x, manualState.height); }
  for (let y = oy % gridPx; y < manualState.height; y += gridPx) { ctx.moveTo(0, y); ctx.lineTo(manualState.width, y); }
  ctx.stroke();

  // Draw Elements
  ctx.strokeStyle = '#0078d4';
  ctx.fillStyle = 'rgba(0,120,212,0.1)';
  ctx.lineWidth = 2;
  
  for (const el of manualState.elements) {
    ctx.beginPath();
    if (el.type === 'polyline') {
      el.points.forEach((pt, i) => {
        const x = ox + pt.x * p;
        const y = oy - pt.y * p;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(ox + el.points[0].x * p, oy - el.points[0].y * p); // closed
      ctx.fill();
    } else if (el.type === 'circle') {
      ctx.arc(ox + el.x * p, oy - el.y * p, el.r * p, 0, Math.PI * 2);
      ctx.fill();
    } else if (el.type === 'rect') {
      ctx.rect(ox + (el.x - el.w/2) * p, oy - (el.y + el.h/2) * p, el.w * p, el.h * p);
      ctx.fill();
    }
    ctx.stroke();
  }
  
  // Draw current drawing state
  if (manualState.isDrawing && manualState.points.length > 0) {
    ctx.strokeStyle = '#ff8c00';
    ctx.beginPath();
    if (manualState.currentTool === 'line') {
      manualState.points.forEach((pt, i) => {
        const x = ox + pt.x * p;
        const y = oy - pt.y * p;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(ox + manualState.snappedX * p, oy - manualState.snappedY * p);
    } else if (manualState.currentTool === 'circle') {
      const start = manualState.points[0];
      const dx = manualState.snappedX - start.x;
      const dy = manualState.snappedY - start.y;
      const r = Math.sqrt(dx*dx + dy*dy);
      ctx.arc(ox + start.x * p, oy - start.y * p, r * p, 0, Math.PI * 2);
    } else if (manualState.currentTool === 'rectangle') {
      const start = manualState.points[0];
      const w = manualState.snappedX - start.x;
      const h = manualState.snappedY - start.y;
      ctx.rect(ox + start.x * p, oy - start.y * p, w * p, -h * p);
    }
    ctx.stroke();
  }
  
  // Snap point cursor
  ctx.fillStyle = '#ff8c00';
  ctx.beginPath();
  ctx.arc(ox + manualState.snappedX * p, oy - manualState.snappedY * p, 3, 0, Math.PI * 2);
  ctx.fill();
}

window.manualToolImpl = function(tool) {
  if (tool === 'extrude') {
    executeManualExtrude();
    return;
  }
  manualState.currentTool = tool;
  manualState.isDrawing = false;
  manualState.points = [];
  
  if (!manualState.ctx) initManualSketcher();
};

function updatePropsBody() {
  const pb = document.querySelector('#contentManual .props-body');
  if (!pb) return;
  if (manualState.elements.length === 0) {
    pb.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px;">No elements</div>';
    return;
  }
  pb.innerHTML = manualState.elements.map((el, i) => {
    let desc = el.type;
    if (el.type === 'circle') desc += ` (r=${el.r.toFixed(1)})`;
    if (el.type === 'rect') desc += ` (${el.w.toFixed(1)}x${el.h.toFixed(1)})`;
    if (el.type === 'polyline') desc += ` (${el.points.length} pts)`;
    return `<div style="padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px;">${desc} <span style="float:right; cursor:pointer; color:var(--text-dim);" onclick="manualState.elements.splice(${i}, 1); updatePropsBody(); drawManualSketch();">✕</span></div>`;
  }).join('');
}

async function executeManualExtrude() {
  if (manualState.elements.length === 0) {
    showToast('Sketch is empty!');
    return;
  }
  
  // Generate CadQuery script
  let script = 'import cadquery as cq\n\nres = cq.Workplane("XY")\n';
  
  let hasGeometry = false;
  
  for (const el of manualState.elements) {
    if (el.type === 'polyline' && el.points.length > 2) {
      script += `res = res.moveTo(${el.points[0].x}, ${el.points[0].y})\n`;
      for (let i = 1; i < el.points.length; i++) {
        script += `res = res.lineTo(${el.points[i].x}, ${el.points[i].y})\n`;
      }
      script += `res = res.close()\n`;
      hasGeometry = true;
    } else if (el.type === 'circle') {
      script += `res = res.center(${el.x}, ${el.y}).circle(${el.r}).center(${-el.x}, ${-el.y})\n`;
      hasGeometry = true;
    } else if (el.type === 'rect') {
      script += `res = res.center(${el.x}, ${el.y}).rect(${el.w}, ${el.h}).center(${-el.x}, ${-el.y})\n`;
      hasGeometry = true;
    }
  }
  
  if (!hasGeometry) { showToast('No valid profiles to extrude'); return; }
  
  // Assuming default extrude depth of 10mm
  script += `result = res.extrude(10)\n`;
  
  showToast('Extruding sketch...');
  
  try {
    const res = await fetch('/run-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script })
    });
    const data = await res.json();
    if (data.error) {
      showToast('Error: ' + data.error);
      return;
    }
    
    if (data.job_id) {
      // Instead of waiting, we can switch to editor/prompt tab to see the result, 
      // or we can embed the viewer in the manual tab! Let's switch to the Prompt tab.
      switchTab('prompt');
      canvas.currentJobId = data.job_id;
      canvas.script = script;
      connectSSE(data.job_id);
    }
  } catch(e) {
    showToast('Failed to extrude: ' + e.message);
  }
}
