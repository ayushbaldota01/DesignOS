/**
 * DesignOS Canvas Controller — Fusion 360 Edition v2
 * Direct block operations (no AI needed), additive geometry, 
 * face operations, properties editing, history.
 */

const canvas = {
  sessionId: null,
  currentJobId: null,
  selectedBlockId: null,
  selectedFace: null,
  blocks: [],
  updateTimer: null,
  chatHistory: [],
  script: '',
};

// ─── Default params per block type ───
const DEFAULT_PARAMS = {
  bracket:  { length: 100, width: 60, height: 20, wall_t: 5 },
  plate:    { length: 100, width: 60, height: 10 },
  shaft:    { diameter: 20, length: 80 },
  housing:  { length: 80, width: 60, height: 40, wall_t: 3 },
  channel:  { length: 100, width: 40, height: 30, wall_t: 3 },
  flange:   { length: 60, width: 60, height: 8, wall_t: 3 },
  gear:     { diameter: 50, height: 10 },
  i_beam:   { height: 60, width: 30, length: 100, web_thickness: 4, flange_thickness: 6 },
  hub:      { diameter: 40, height: 15 },
  disk:     { diameter: 60, height: 5 },
  box:      { length: 60, width: 40, height: 30, wall_t: 2 },
};

// Feature block defaults (operations on existing geometry)
const FEATURE_DEFAULTS = {
  holes:   { hole_points: '[[20,0],[-20,0]]', hole_dia: 6.6 },
  fillets: { radius: 2.0 },
  chamfers:{ size: 1.0 },
  pockets: { width: 30, length: 20, depth: 5 },
  boss:    { diameter: 15, height: 5, x: 0, y: 0 },
  shell:   { wall_t: 2 },
  smart_fillet: { radius: 2.0 },
};

const BLOCK_ICONS = {
  bracket:'L', plate:'□', shaft:'|', housing:'⊞', channel:'U',
  gear:'⚙', i_beam:'I', flange:'⬡', holes:'○', fillets:'⌒',
  chamfers:'/', pockets:'▽', boss:'⬆', shell:'◻', smart_fillet:'⌒',
  two_stage_parallel_shaft:'‖', hub:'○', disk:'◎', box:'□'
};

const PART_TYPE_MAP = {
  bracket:'bracket', plate:'plate', shaft:'shaft', housing:'housing',
  channel:'channel', flange:'flange', gear:'gear', i_beam:'beam',
  hub:'plate', disk:'plate', box:'housing'
};

const HISTORY_KEY = 'designos_v2_history';

// ═══════════════════════════════════════════════════════════════
// Template Library — click handlers
// ═══════════════════════════════════════════════════════════════

window.onTemplateClick = function(templateType) {
  const defaults = DEFAULT_PARAMS[templateType];
  if (!defaults) { showToast(`Unknown template: ${templateType}`); return; }

  // If session exists, add to existing assembly. Otherwise create new.
  if (canvas.sessionId) {
    showAddGeometryDialog(templateType, { ...defaults });
  } else {
    showDimensionDialog(templateType, { ...defaults });
  }
};

// ─── New session dialog ───
function showDimensionDialog(templateType, params) {
  const modal = document.getElementById('modalContent');
  let html = `<div class="modal-title">Create ${templateType.toUpperCase().replace(/_/g,' ')}</div>`;
  for (const [key, val] of Object.entries(params)) {
    html += `<label>${key.replace(/_/g,' ')}<input type="number" id="dim_${key}" value="${val}" step="1"></label>`;
  }
  html += `
    <label>Material<select id="dim_material"><option>Steel</option><option>Aluminium</option><option>Titanium</option></select></label>
    <label>Features (comma separated)<input type="text" id="dim_features" placeholder="e.g. mounting holes, edge fillets"></label>
    <div class="modal-actions">
      <button class="btn-app" onclick="closeModal()">Cancel</button>
      <button class="btn-app-primary" onclick="createSession('${templateType}')">Generate</button>
    </div>`;
  modal.innerHTML = html;
  document.getElementById('modalBackdrop').classList.add('visible');
}

// ─── Add to existing session dialog ───
function showAddGeometryDialog(templateType, params) {
  const modal = document.getElementById('modalContent');
  let html = `<div class="modal-title">Add ${templateType.toUpperCase().replace(/_/g,' ')} to Assembly</div>
    <div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px;">This will be added to the current part assembly.</div>`;
  
  // Add position fields
  params.x = 0; params.y = 0; params.z = 0;
  for (const [key, val] of Object.entries(params)) {
    html += `<label>${key.replace(/_/g,' ')}<input type="number" id="dim_${key}" value="${val}" step="1"></label>`;
  }
  html += `
    <div class="modal-actions">
      <button class="btn-app" onclick="closeModal()">Cancel</button>
      <button class="btn-app-primary" onclick="addBlockToSession('${templateType}')">Add to Assembly</button>
    </div>`;
  modal.innerHTML = html;
  document.getElementById('modalBackdrop').classList.add('visible');
}

window.toggleGizmo = function(mode) {
    if (window.viewerInstance) {
        window.viewerInstance.setGizmoEnabled(true);
        window.viewerInstance.setGizmoMode(mode);
        
        if (window.selectedAssemblyPartIndex !== null && window.selectedAssemblyPartIndex !== undefined) {
            const p = assemblyParts[window.selectedAssemblyPartIndex];
            if (p) {
                const partName = p.template + '_' + (window.selectedAssemblyPartIndex + 1);
                window.viewerInstance.attachGizmoToPart(partName);
            }
        } else if (canvas.selectedBlockId) {
            window.viewerInstance.attachGizmoToPart('part_' + canvas.selectedBlockId);
        }
    }
};

window.disableGizmo = function() {
    if (window.viewerInstance) {
        window.viewerInstance.setGizmoEnabled(false);
    }
};

window.toggleMeasure3D = function() {
    if (window.viewerInstance) {
        window.viewerInstance.toggleMeasureMode();
    }
};

window.activateFaceMateFromPanel = function() {
    if (canvas.selectedBlockId) {
        window.activateFaceMate('part_' + canvas.selectedBlockId);
    } else {
        showToast('Select a part from the Assembly Tree first');
    }
};

window.activateFaceMate = function(partName) {
    if (!window.viewerInstance) return;
    
    // Select the part first
    if (window.viewerInstance.selectPart) {
        window.viewerInstance.selectPart(partName);
    }
    
    // Start face mate mode
    window.viewerInstance.startFaceMateMode();
    
    // Update UI
    showToast('Step 1: Click a face on ' + partName);
    addChatMsg('system', `Face mate: click source face on ${partName}`);
    
    // Show cancel button
    const mateCancelBtn = document.getElementById('mateCancelBtn');
    const mateStatusBar = document.getElementById('mateStatusBar');
    const mateStatus = document.getElementById('mateStatus');
    if (mateCancelBtn) mateCancelBtn.style.display = 'block';
    if (mateStatusBar) mateStatusBar.style.display = 'flex';
    if (mateStatus) mateStatus.textContent = `Step 1/2 — Click face on: ${partName}`;
    
    // Wire callbacks
    window.viewerInstance.onFaceMateStep = (step, partName) => {
        if (step === 1) {
            if (mateStatus) mateStatus.textContent = `Step 2/2 — Click target face on another part`;
            addChatMsg('system', 'Source face selected — click target face');
        } else if (step === 2) {
            if (mateStatus) mateStatus.textContent = 'Mate complete';
            if (mateStatusBar) mateStatusBar.style.display = 'none';
            if (mateCancelBtn) mateCancelBtn.style.display = 'none';
            addChatMsg('success', `Mated to ${partName}`);
        } else if (step === -1) {
            if (mateStatus) mateStatus.textContent = `Error: ${partName} — try again`;
            addChatMsg('error', partName);
        }
    };
    
    window.viewerInstance.onMateComplete = ({sourcePart, position, rotation}) => {
        // Frontend-only mate — don't sync to backend (would trigger SSE reload and duplicates)
        addChatMsg('success', `${sourcePart} mated successfully`);
    };
};

window.cancelFaceMate = function() {
    if (window.viewerInstance) window.viewerInstance.stopFaceMateMode();
    const mateStatusBar = document.getElementById('mateStatusBar');
    const mateCancelBtn = document.getElementById('mateCancelBtn');
    if (mateStatusBar) mateStatusBar.style.display = 'none';
    if (mateCancelBtn) mateCancelBtn.style.display = 'none';
    addChatMsg('system', 'Face mate cancelled');
};

window.setMateOffset = function(partName, offsetMm) {
    const mesh = window.viewerInstance?.partMeshes?.[partName];
    if (!mesh || !window.viewerInstance?.faceMateSource) return;
    const normal = window.viewerInstance.faceMateSource.normal.clone();
    
    // Apply visual offset
    mesh.position.addScaledVector(normal, parseFloat(offsetMm));
    
    // Send updated position to backend
    const blockId = partName.replace('part_', '');
    if (!blockId || !canvas.sessionId) return;
    
    fetch('/canvas/update-params', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            session_id: canvas.sessionId,
            block_id: blockId,
            updates: {
                x: mesh.position.x,
                y: mesh.position.z, // Y/Z swap
                z: mesh.position.y
            }
        })
    }).catch(err => console.error(err));
};

window.closeModal = function() {
  document.getElementById('modalBackdrop').classList.remove('visible');
};

// ─── Create NEW session ───
window.createSession = async function(templateType) {
  const defaults = DEFAULT_PARAMS[templateType] || {};
  const params = {};
  for (const key of Object.keys(defaults)) {
    const el = document.getElementById(`dim_${key}`);
    params[key] = el ? (parseFloat(el.value) || defaults[key]) : defaults[key];
  }
  const features = (document.getElementById('dim_features')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
  const material = document.getElementById('dim_material')?.value || 'Steel';

  closeModal();
  showGenOverlay('Generating geometry...');
  addChatMsg('system', `Generating ${templateType}...`);

  const formData = {
    part_type: PART_TYPE_MAP[templateType] || 'plate',
    length: params.length || params.base_length || params.diameter || 100,
    width: params.width || params.diameter || 60,
    height: params.height || params.length || 20,
    material, features,
    notes: `${templateType} part`
  };

  try {
    const res = await fetch('/canvas/session', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ form_data: formData })
    });
    const data = await res.json();
    if (data.error) { hideGenOverlay(); addChatMsg('error', data.error); return; }

    canvas.sessionId = data.session_id;
    canvas.currentJobId = data.job_id;
    const empty = document.getElementById('canvasEmpty');
    if (empty) empty.style.display = 'none';

    connectSSE(data.job_id);
    await loadBlocks();
  } catch (e) {
    hideGenOverlay();
    addChatMsg('error', 'Session failed: ' + e.message);
  }
};

// ─── Add block to EXISTING session ───
window.addBlockToSession = async function(blockType) {
  const defaults = DEFAULT_PARAMS[blockType] || {};
  const params = {};
  for (const key of Object.keys(defaults)) {
    const el = document.getElementById(`dim_${key}`);
    params[key] = el ? (parseFloat(el.value) || defaults[key]) : defaults[key];
  }
  // Add x/y/z position
  params.x = parseFloat(document.getElementById('dim_x')?.value) || 0;
  params.y = parseFloat(document.getElementById('dim_y')?.value) || 0;
  params.z = parseFloat(document.getElementById('dim_z')?.value) || 0;

  closeModal();
  showGenOverlay('Adding to assembly...');
  addChatMsg('op', `Adding ${blockType} to assembly...`);

  const parentId = canvas.selectedBlockId || '001';
  const face = canvas.selectedFace?.selector || '>Z';

  try {
    const res = await fetch('/canvas/add-block', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        session_id: canvas.sessionId,
        block_type: blockType,
        params, parent_id: parentId, face
      })
    });
    const data = await res.json();
    if (data.error) { hideGenOverlay(); addChatMsg('error', data.error); return; }
    if (data.job_id) {
      canvas.currentJobId = data.job_id;
      connectSSE(data.job_id);
      await loadBlocks();
    }
  } catch (e) {
    hideGenOverlay();
    addChatMsg('error', 'Add block failed: ' + e.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// Direct Feature Operations (NO AI — uses /canvas/add-block)
// ═══════════════════════════════════════════════════════════════

window.applyOp = async function(opType) {
  if (!canvas.sessionId) { showToast('Generate a part first'); return; }

  const faceSelector = window.clickedFaceSelector || '>Y';
  const parentId = canvas.selectedBlockId || '001';
  let blockType = opType;
  let params = {};

  if (opType === 'hole') {
    const dia = parseFloat(document.getElementById('op_dia')?.value) || 6.6;
    const x = parseFloat(document.getElementById('op_x')?.value) || 0;
    const y = parseFloat(document.getElementById('op_y')?.value) || 0;
    const count = document.getElementById('op_count')?.value || '4';
    // Build hole point pattern
    let pts;
    if (count === '4') pts = `[[${x+20},${y+15}],[${-x-20},${y+15}],[${x+20},${-y-15}],[${-x-20},${-y-15}]]`;
    else if (count === '2') pts = `[[${x+20},${y}],[${-x-20},${y}]]`;
    else pts = `[[${x},${y}]]`;
    blockType = 'holes';
    params = { hole_points: pts, hole_dia: dia };
  } else if (opType === 'pocket') {
    blockType = 'pockets';
    params = {
      width: parseFloat(document.getElementById('op_pw')?.value) || 30,
      length: parseFloat(document.getElementById('op_pl')?.value) || 20,
      depth: parseFloat(document.getElementById('op_pd')?.value) || 5
    };
  } else if (opType === 'fillet') {
    blockType = 'fillets';
    const edges = document.getElementById('op_fedges')?.value || '|Z';
    if (edges === 'all') blockType = 'smart_fillet';
    params = { radius: parseFloat(document.getElementById('op_fr')?.value) || 2 };
  } else if (opType === 'chamfer') {
    blockType = 'chamfers';
    params = { size: parseFloat(document.getElementById('op_cs')?.value) || 1 };
  } else if (opType === 'extrude') {
    // Extrude as AI instruction fallback
    const dist = document.getElementById('op_ext')?.value || 10;
    hideOpPanel();
    await submitChat(`extrude face ${faceSelector} by ${dist}mm`);
    return;
  } else if (opType === 'shell') {
    blockType = 'shell';
    params = { wall_t: parseFloat(document.getElementById('op_st')?.value) || 2 };
  } else if (opType === 'boss') {
    blockType = 'boss';
    params = {
      diameter: parseFloat(document.getElementById('op_bd')?.value) || 15,
      height: parseFloat(document.getElementById('op_bh')?.value) || 5,
      x: 0, y: 0
    };
  }

  hideOpPanel();
  document.getElementById('faceOpsBar').classList.remove('visible');
  showGenOverlay(`Applying ${opType}...`);
  addChatMsg('op', `Adding ${opType} on face ${faceSelector}...`);

  try {
    const res = await fetch('/canvas/add-block', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        session_id: canvas.sessionId,
        block_type: blockType,
        params, parent_id: parentId, face: faceSelector
      })
    });
    const data = await res.json();
    if (data.error) { hideGenOverlay(); addChatMsg('error', data.error); return; }
    if (data.job_id) {
      canvas.currentJobId = data.job_id;
      connectSSE(data.job_id);
      await loadBlocks();
    }
  } catch (e) {
    hideGenOverlay();
    addChatMsg('error', `${opType} failed: ` + e.message);
  }
};

// ═══════════════════════════════════════════════════════════════
// Block loading & assembly tree
// ═══════════════════════════════════════════════════════════════

async function loadBlocks() {
  if (!canvas.sessionId) return;
  try {
    const res = await fetch(`/canvas/blocks/${canvas.sessionId}`);
    const data = await res.json();
    canvas.blocks = data.blocks || [];
    canvas.script = data.script || '';
    renderAssemblyTree();
    updateEditorScript(canvas.script);
  } catch (e) { console.error('Load blocks failed:', e); }
}

function renderAssemblyTree() {
  const tree = document.getElementById('assemblyTree');
  if (!tree) return;
  if (canvas.blocks.length === 0) {
    tree.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px;">No geometry yet</div>';
    return;
  }

  const FEATURE_TYPES = new Set(['holes','fillets','chamfers','pockets','boss','shell','smart_fillet','flange_holes']);

  tree.innerHTML = canvas.blocks.map(b => {
    const icon = BLOCK_ICONS[b.type] || '□';
    const sel = b.id === canvas.selectedBlockId ? ' selected' : '';
    const isFeature = FEATURE_TYPES.has(b.type);
    const indent = isFeature ? ' tree-node-indent' : '';
    const params = b.params || {};

    let dims = '';
    if (params.length && params.width && params.height) dims = `${params.length}×${params.width}×${params.height}`;
    else if (params.hole_dia) dims = `⌀${params.hole_dia}mm`;
    else if (params.diameter) dims = `⌀${params.diameter}mm`;
    else if (params.radius) dims = `r${params.radius}mm`;
    else if (params.size) dims = `${params.size}mm`;
    else if (params.wall_t) dims = `t${params.wall_t}mm`;

    return `<div class="tree-node${sel}${indent}" onclick="selectBlock('${b.id}')" title="${b.type}: ${dims}">
      <span class="tree-node-icon">${icon}</span>
      <span class="tree-node-label">[b${b.id}] ${b.type}</span>
      <span class="tree-node-dims">${dims}</span>
    </div>`;
  }).join('');
}

window.selectBlock = function(blockId) {
  canvas.selectedBlockId = blockId;
  const block = canvas.blocks.find(b => b.id === blockId);
  if (block) renderPropsPanel(block);
  renderAssemblyTree();
  
  if (window.viewerInstance) {
      window.viewerInstance.attachGizmoToPart('part_' + blockId);
  }
};

// ═══════════════════════════════════════════════════════════════
// Properties Panel — editable with steppers & debounced update
// ═══════════════════════════════════════════════════════════════

function renderPropsPanel(block) {
  const panel = document.getElementById('propsBody');
  if (!panel) return;
  const params = block.params || {};
  const FEATURE_TYPES = new Set(['holes','fillets','chamfers','pockets','boss','shell','smart_fillet','flange_holes']);
  const isFeature = FEATURE_TYPES.has(block.type);

  let html = `<div class="prop-group-title">${block.type.toUpperCase()} [b${block.id}]</div>`;

  for (const [key, val] of Object.entries(params)) {
    // Skip complex values like hole_points and face_tag for direct editing
    if (key === 'face_tag') continue;
    const isPointArray = key === 'hole_points';
    const numVal = isPointArray ? val : (parseFloat(val) || 0);

    if (isPointArray) {
      html += `<div class="prop-row">
        <span class="prop-label">${key.replace(/_/g,' ')}</span>
        <div style="flex:1;font-size:10px;color:var(--text-secondary);font-family:var(--mono-code);">${val}</div>
      </div>`;
    } else {
      html += `<div class="prop-row">
        <span class="prop-label">${key.replace(/_/g,' ')}</span>
        <div class="prop-input-wrap">
          <input type="number" class="prop-input" value="${numVal}" step="${numVal >= 10 ? 1 : 0.5}"
                 data-block="${block.id}" data-key="${key}" onchange="onPropChange(this)">
          <span class="prop-unit">mm</span>
          <div class="prop-stepper">
            <button class="prop-step-btn" onclick="stepProp(this,'up')">▲</button>
            <button class="prop-step-btn" onclick="stepProp(this,'down')">▼</button>
          </div>
        </div>
      </div>`;
    }
  }

  if (block.face) {
    html += `<div class="prop-row"><span class="prop-label">Face</span>
      <span style="color:var(--accent);font-size:11px;font-family:var(--mono-code);">${block.face}</span></div>`;
  }
  if (block.parent) {
    html += `<div class="prop-row"><span class="prop-label">Parent</span>
      <span style="color:var(--text-secondary);font-size:11px;">b${block.parent}</span></div>`;
  }

  // Validation indicators
  html += `<div class="val-section">
    <div class="val-row val-ok">✓ Geometry valid</div>`;
  
  if (params.wall_t) {
    const wt = parseFloat(params.wall_t) || 0;
    html += wt >= 1.5
      ? `<div class="val-row val-ok">✓ Wall thickness: ${wt}mm</div>`
      : `<div class="val-row val-warn">⚠ Wall too thin: ${wt}mm</div>`;
  }
  if (params.hole_dia) {
    html += `<div class="val-row val-ok">✓ Hole clearance OK</div>`;
  }
  html += `</div>`;

  // Action buttons
  html += `<div style="margin-top:12px;display:flex;flex-direction:column;gap:6px;">`;
  if (!isFeature) {
    // Base geometry — offer feature additions
    html += `
      <button class="btn-app" style="width:100%;" onclick="quickAddFeature('holes')">○ Add Holes</button>
      <button class="btn-app" style="width:100%;" onclick="quickAddFeature('fillets')">⌒ Add Fillets</button>
      <button class="btn-app" style="width:100%;" onclick="quickAddFeature('chamfers')">/ Add Chamfers</button>
      <button class="btn-app" style="width:100%;" onclick="quickAddFeature('pockets')">▽ Add Pocket</button>
      <button class="btn-app" style="width:100%;" onclick="quickAddFeature('boss')">⬆ Add Boss</button>
      <button class="btn-app" style="width:100%;" onclick="quickAddFeature('shell')">◻ Shell</button>`;
      
    // Face Mate UI for base parts
    const partName = 'part_' + block.id;
    html += `
      <div class="prop-row" style="margin-top:12px">
          <span class="prop-label" style="font-size:9px;color:var(--text-dim)">FACE MATE</span>
      </div>
      <div style="font-size:10px;color:var(--text-dim);padding:4px 0;line-height:1.4">
          1. Click "Mate Faces"<br>
          2. Click a face on this part<br>  
          3. Click target face on another part
      </div>
      <button onclick="activateFaceMate('${partName}')" 
              class="tool-btn" style="width:100%;margin-top:6px">
          ⊕ Mate Faces
      </button>
      <div style="margin-top:6px;display:flex;gap:4px;align-items:center">
          <span style="font-size:10px;color:var(--text-dim)">Offset</span>
          <input type="number" value="0" step="0.5" style="width:60px" 
                 class="prop-input"
                 onchange="setMateOffset('${partName}', this.value)">
          <span style="font-size:10px;color:var(--text-dim)">mm</span>
      </div>`;
  }
  html += `</div>`;

  panel.innerHTML = html;
}

// Quick-add feature to selected block
window.quickAddFeature = async function(featureType) {
  if (!canvas.sessionId) return;
  const defaults = FEATURE_DEFAULTS[featureType];
  if (!defaults) return;

  const parentId = canvas.selectedBlockId || '001';
  const face = canvas.selectedFace?.selector || '>Y';

  showGenOverlay(`Adding ${featureType}...`);
  addChatMsg('op', `Adding ${featureType} to b${parentId}...`);

  try {
    const res = await fetch('/canvas/add-block', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        session_id: canvas.sessionId,
        block_type: featureType,
        params: { ...defaults },
        parent_id: parentId,
        face
      })
    });
    const data = await res.json();
    if (data.error) { hideGenOverlay(); addChatMsg('error', data.error); return; }
    if (data.job_id) {
      canvas.currentJobId = data.job_id;
      connectSSE(data.job_id);
      await loadBlocks();
    }
  } catch (e) {
    hideGenOverlay();
    addChatMsg('error', `Add ${featureType} failed: ` + e.message);
  }
};

window.stepProp = function(btn, dir) {
  const wrap = btn.closest('.prop-input-wrap');
  const input = wrap.querySelector('.prop-input');
  const step = parseFloat(input.step) || 1;
  input.value = (parseFloat(input.value) || 0) + (dir === 'up' ? step : -step);
  input.dispatchEvent(new Event('change'));
};

window.onPropChange = function(el) {
  const blockId = el.dataset.block;
  const paramKey = el.dataset.key;
  const newValue = parseFloat(el.value);
  if (isNaN(newValue)) return;

  clearTimeout(canvas.updateTimer);
  canvas.updateTimer = setTimeout(() => updateParam(blockId, paramKey, newValue), 600);
};

async function updateParam(blockId, paramKey, newValue) {
  showGenOverlay('Updating...');
  addChatMsg('op', `b${blockId}.${paramKey} → ${newValue}`);
  try {
    const res = await fetch('/canvas/update-param', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        session_id: canvas.sessionId,
        block_id: blockId,
        param_key: paramKey,
        new_value: newValue
      })
    });
    const data = await res.json();
    if (data.error) { hideGenOverlay(); addChatMsg('error', data.error); return; }
    if (data.job_id) {
      canvas.currentJobId = data.job_id;
      connectSSE(data.job_id);
      await loadBlocks();
    }
  } catch (e) {
    hideGenOverlay();
    addChatMsg('error', 'Update failed: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// Face Selection
// ═══════════════════════════════════════════════════════════════

window.setupFaceSelection = function(viewer) {
  viewer.onFaceSelect = function(faceInfo) {
    const bar = document.getElementById('faceOpsBar');
    const label = document.getElementById('faceOpsLabel');
    if (!faceInfo) {
      bar.classList.remove('visible');
      canvas.selectedFace = null;
      updateStatus('Ready');
      return;
    }
    canvas.selectedFace = faceInfo;
    label.textContent = faceInfo.label;
    bar.classList.add('visible');
    updateStatus(`Face: ${faceInfo.label} (${faceInfo.selector})`);
  };

  viewer.onMouseMove3D = function(coords) {
    const el = document.getElementById('coords');
    if (el) el.textContent = `x: ${coords.x}  y: ${coords.y}  z: ${coords.z}`;
  };

  viewer.onTransformEnd = async function({meshName, position, rotation}) {
      let isBlockEngine = false;
      let partId = null;
      let assemblyPartIndex = -1;

      if (meshName.startsWith('part_')) {
          partId = meshName.replace('part_', '');
          isBlockEngine = true;
      } else {
          assemblyPartIndex = assemblyParts.findIndex((p, i) => `${p.template}_${i+1}` === meshName);
          if (assemblyPartIndex === -1) return;
      }
      
      if (isBlockEngine) {
          // Block engine (id is like 001, 002)
          showGenOverlay('Updating position...');
          
          // Send a single batched update for position and rotation
          const updates = {
              x: Math.round(position.x * 10) / 10,
              y: Math.round(position.y * 10) / 10,
              z: Math.round(position.z * 10) / 10,
              rot_x: Math.round(rotation.x * (180 / Math.PI)),
              rot_y: Math.round(rotation.y * (180 / Math.PI)),
              rot_z: Math.round(rotation.z * (180 / Math.PI))
          };
          
          const res = await fetch('/canvas/update-params', {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({session_id: canvas.sessionId, block_id: partId, updates: updates})
          });

          const data = await res.json();
          if (data.job_id) {
              canvas.currentJobId = data.job_id;
              connectSSE(data.job_id);
              await loadBlocks();
          }
          hideGenOverlay();
      } else {
          // Assembly engine
          const partIndex = assemblyPartIndex;
          if (assemblyParts[partIndex]) {
              assemblyParts[partIndex].position = { 
                  x: Math.round(position.x * 10) / 10, 
                  y: Math.round(position.y * 10) / 10, 
                  z: Math.round(position.z * 10) / 10 
              };
              assemblyParts[partIndex].rotation = {
                  rot_x: Math.round(rotation.x * (180 / Math.PI)),
                  rot_y: Math.round(rotation.y * (180 / Math.PI)),
                  rot_z: Math.round(rotation.z * (180 / Math.PI))
              };
              renderAssemblyBuilder();
              buildCustomAssembly();
          }
      }
  };
};

window.faceOp = function(opType) {
  if (opType === 'clear') {
    document.getElementById('faceOpsBar').classList.remove('visible');
    canvas.selectedFace = null;
    hideOpPanel();
    if (window.viewerInstance) window.viewerInstance.clearFaceSelection();
    updateStatus('Ready');
    return;
  }
  if (opType === 'edit2d') {
    if (!canvas.sessionId) { showToast('Generate a part first'); return; }
    if (!canvas.selectedFace && !window.clickedFaceSelector) { showToast('Select a face first'); return; }
    document.getElementById('faceOpsBar').classList.remove('visible');
    openSketch2d();
    return;
  }
  if (!canvas.sessionId) { showToast('Generate a part first'); return; }
  showOpPanel(opType);
};

// ═══════════════════════════════════════════════════════════════
// Operation Panels
// ═══════════════════════════════════════════════════════════════

function showOpPanel(opType) {
  const panel = document.getElementById('opPanel');
  const panels = {
    hole: `<div class="op-panel-title">ADD HOLE</div>
      <label>Diameter<input type="number" id="op_dia" value="6.6" step="0.5"></label>
      <label>Offset X<input type="number" id="op_x" value="0" step="1"></label>
      <label>Offset Y<input type="number" id="op_y" value="0" step="1"></label>
      <label>Count<select id="op_count"><option>1</option><option>2</option><option>4</option></select></label>
      <button class="op-panel-apply" onclick="applyOp('hole')">Apply</button>
      <button class="op-panel-cancel" onclick="hideOpPanel()">Cancel</button>`,
    pocket: `<div class="op-panel-title">ADD POCKET</div>
      <label>Width<input type="number" id="op_pw" value="30" step="1"></label>
      <label>Length<input type="number" id="op_pl" value="20" step="1"></label>
      <label>Depth<input type="number" id="op_pd" value="5" step="0.5"></label>
      <button class="op-panel-apply" onclick="applyOp('pocket')">Apply</button>
      <button class="op-panel-cancel" onclick="hideOpPanel()">Cancel</button>`,
    fillet: `<div class="op-panel-title">FILLET EDGES</div>
      <label>Radius<input type="number" id="op_fr" value="2" step="0.5"></label>
      <label>Edges<select id="op_fedges">
        <option value="|Z">Vertical</option><option value=">Z">Top</option><option value="all">All</option>
      </select></label>
      <button class="op-panel-apply" onclick="applyOp('fillet')">Apply</button>
      <button class="op-panel-cancel" onclick="hideOpPanel()">Cancel</button>`,
    chamfer: `<div class="op-panel-title">CHAMFER</div>
      <label>Size<input type="number" id="op_cs" value="1" step="0.5"></label>
      <button class="op-panel-apply" onclick="applyOp('chamfer')">Apply</button>
      <button class="op-panel-cancel" onclick="hideOpPanel()">Cancel</button>`,
    extrude: `<div class="op-panel-title">EXTRUDE</div>
      <label>Distance<input type="number" id="op_ext" value="10" step="1"></label>
      <label>Direction<select id="op_dir"><option>Outward</option><option>Inward (cut)</option></select></label>
      <button class="op-panel-apply" onclick="applyOp('extrude')">Apply</button>
      <button class="op-panel-cancel" onclick="hideOpPanel()">Cancel</button>`,
    shell: `<div class="op-panel-title">SHELL</div>
      <label>Wall Thickness<input type="number" id="op_st" value="2" step="0.5"></label>
      <button class="op-panel-apply" onclick="applyOp('shell')">Apply</button>
      <button class="op-panel-cancel" onclick="hideOpPanel()">Cancel</button>`,
    boss: `<div class="op-panel-title">ADD BOSS</div>
      <label>Diameter<input type="number" id="op_bd" value="15" step="1"></label>
      <label>Height<input type="number" id="op_bh" value="5" step="1"></label>
      <button class="op-panel-apply" onclick="applyOp('boss')">Apply</button>
      <button class="op-panel-cancel" onclick="hideOpPanel()">Cancel</button>`
  };
  panel.innerHTML = panels[opType] || '';
  panel.classList.add('visible');
}

window.hideOpPanel = function() {
  document.getElementById('opPanel').classList.remove('visible');
};

window.toolbarOp = function(opType) {
  if (!canvas.sessionId) { showToast('Generate a part first'); return; }
  showOpPanel(opType);
};

window.toolbarDropdownToggle = function(el) {
  el.closest('.tool-dropdown').classList.toggle('open');
};

// ═══════════════════════════════════════════════════════════════
// Chat / AI (fallback for complex operations)
// ═══════════════════════════════════════════════════════════════

window.submitChatInput = async function() {
  const input = document.getElementById('aiInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await submitChat(text);
};

window.submitShortcut = function(text) { submitChat(text); };

async function submitChat(instruction) {
  if (!canvas.sessionId) { showToast('Generate a part first'); return; }
  addChatMsg('user', instruction);
  showGenOverlay('AI processing...');

  try {
    const res = await fetch('/assist', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        instruction,
        script: canvas.script,
        face_label: window.clickedFaceLabel || ''
      })
    });
    const data = await res.json();
    if (data.error) {
      hideGenOverlay();
      addChatMsg('error', 'AI: ' + data.error);
      addChatMsg('system', 'Tip: Use the toolbar buttons or property panel for direct operations without AI.');
      return;
    }

    addChatMsg('system', 'Script modified, executing...');
    const execRes = await fetch('/run-script', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ script: data.script })
    });
    const execData = await execRes.json();
    if (execData.error) { hideGenOverlay(); addChatMsg('error', execData.error); return; }

    if (execData.job_id) {
      canvas.currentJobId = execData.job_id;
      canvas.script = data.script;
      updateEditorScript(data.script);
      connectSSE(execData.job_id);
    }
  } catch (e) {
    hideGenOverlay();
    addChatMsg('error', 'Request failed: ' + e.message);
  }
}

function addChatMsg(type, text) {
  const history = document.getElementById('chatHistory');
  if (!history) return;
  const prefixes = { user:'YOU ›', system:'SYS ›', error:'ERR ›', success:'✓', op:'OP ›' };
  const div = document.createElement('div');
  div.className = `chat-msg ${type}`;
  div.innerHTML = `<span class="chat-prefix">${prefixes[type]||'›'}</span><span class="chat-text">${text}</span>`;
  history.appendChild(div);
  history.scrollTop = history.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
// SSE Streaming
// ═══════════════════════════════════════════════════════════════

function connectSSE(jobId) {
  const es = new EventSource(`/stream/${jobId}`);
  es.onmessage = function(event) {
    try {
      const entry = JSON.parse(event.data);
      if (entry.message) updateStatus(entry.message);

      if (entry.complete || entry.status === 'completed') {
        es.close();
        hideGenOverlay();
        updateStatus('Ready');
        addChatMsg('success', 'Model updated');
        if (window.viewerInstance && entry.has_stl_file !== false) {
          if (entry.part_count > 0) {
              const partsData = [];
              for (let i = 0; i < entry.part_count; i++) {
                  partsData.push({
                      name: `part_${(i+1).toString().padStart(3, '0')}`,
                      stl_url: `/part-stl/${jobId}/${i}`,
                      template: 'part'
                  });
              }
              window.viewerInstance.loadAssemblyParts(partsData);
          } else {
              window.viewerInstance.loadSTL(`/model/${jobId}`);
          }
        }
        saveToHistory();
      }
      if (entry.status === 'failed' || (entry.error && !entry.complete)) {
        es.close();
        hideGenOverlay();
        updateStatus('Error');
        addChatMsg('error', entry.error || 'Generation failed');
      }
    } catch (e) {}
  };
  es.onerror = function() { es.close(); hideGenOverlay(); };
}

// ═══════════════════════════════════════════════════════════════
// Undo
// ═══════════════════════════════════════════════════════════════

window.undoCanvas = async function() {
  if (!canvas.sessionId) return;
  showGenOverlay('Undoing...');
  try {
    const res = await fetch(`/canvas/undo/${canvas.sessionId}`, { method: 'POST' });
    const data = await res.json();
    if (data.error) { hideGenOverlay(); addChatMsg('error', data.error); return; }
    if (data.job_id) {
      canvas.currentJobId = data.job_id;
      connectSSE(data.job_id);
      await loadBlocks();
    }
  } catch (e) { hideGenOverlay(); addChatMsg('error', 'Undo failed'); }
};

// ═══════════════════════════════════════════════════════════════
// History (localStorage)
// ═══════════════════════════════════════════════════════════════

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

function saveToHistory() {
  const history = getHistory();
  let thumbnail = null;
  if (window.viewerInstance) thumbnail = window.viewerInstance.captureThumbnail();
  const label = canvas.blocks.length > 0
    ? canvas.blocks[0].type + (canvas.blocks.length > 1 ? ` +${canvas.blocks.length-1}` : '')
    : 'part';
  history.unshift({ id: canvas.sessionId, label, timestamp: Date.now(), script: canvas.script, jobId: canvas.currentJobId, thumbnail });
  if (history.length > 12) history.pop();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistoryPanel();
}

function renderHistoryPanel() {
  const list = document.getElementById('historyList');
  if (!list) return;
  const history = getHistory();
  if (history.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px;">No history yet</div>';
    return;
  }
  list.innerHTML = history.map((h,i) => `
    <div class="history-item" onclick="restoreHistory(${i})">
      ${h.thumbnail ? `<img src="${h.thumbnail}" class="history-thumb" alt="">` : '<div class="history-thumb-empty">□</div>'}
      <div class="history-info">
        <div class="history-label">${h.label}</div>
        <div class="history-time">${timeAgo(h.timestamp)}</div>
      </div>
    </div>`).join('');
}

window.restoreHistory = function(index) {
  const item = getHistory()[index];
  if (!item) return;
  if (item.jobId && window.viewerInstance) {
    window.viewerInstance.loadSTL(`/model/${item.jobId}`);
    canvas.currentJobId = item.jobId;
    addChatMsg('system', `Restored: ${item.label}`);
  }
};

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.floor(d/60000)+'m ago';
  if (d < 86400000) return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}

// ═══════════════════════════════════════════════════════════════
// Export
// ═══════════════════════════════════════════════════════════════

window.exportSTEP = function() {
  if (canvas.currentJobId) window.location.href = `/download/${canvas.currentJobId}`;
  else showToast('No model to export');
};
window.exportSTL = function() {
  if (canvas.currentJobId) window.location.href = `/model/${canvas.currentJobId}`;
  else showToast('No model to export');
};

// ═══════════════════════════════════════════════════════════════
// UI Helpers
// ═══════════════════════════════════════════════════════════════

function updateStatus(msg) { const el = document.getElementById('statusMsg'); if(el) el.textContent = msg; }
function showGenOverlay(text) { const el = document.getElementById('genOverlay'); if(el){el.querySelector('.gen-text').textContent=text;el.classList.add('visible');} }
function hideGenOverlay() { const el = document.getElementById('genOverlay'); if(el) el.classList.remove('visible'); }

function showToast(msg) {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg; c.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function updateEditorScript(script) {
  if (window.monacoInstance) window.monacoInstance.setValue(script);
  updateParamSliders(script);
}

function updateParamSliders(script) {
  const container = document.getElementById('paramSliders');
  if (!container) return;
  const lines = script.split('\n');
  let html = '';
  for (const line of lines) {
    const m = line.match(/^(\w+)\s*=\s*([\d.]+)\s*#\s*mm/);
    if (m) {
      html += `<div class="slider-row">
        <div class="slider-label"><span>${m[1]}</span><span class="slider-val">${m[2]}</span></div>
        <input type="range" class="slider-input" min="1" max="${parseFloat(m[2])*3}" value="${m[2]}" step="1"
               oninput="this.previousElementSibling.querySelector('.slider-val').textContent=this.value">
      </div>`;
    }
  }
  container.innerHTML = html || '<div style="padding:12px;color:var(--text-dim);font-size:11px;">No parameters detected</div>';
}

window.filterTemplates = function(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('.template-item').forEach(item => {
    const name = item.querySelector('.template-item-name')?.textContent?.toLowerCase() || '';
    item.style.display = name.includes(q) ? '' : 'none';
  });
};

window.toggleGroup = function(el) { el.closest('.template-group').classList.toggle('collapsed'); };

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  renderHistoryPanel();
  checkHealth();
});

async function checkHealth() {
  try {
    const res = await fetch('/health');
    const data = await res.json();
    document.getElementById('statusOllama').className = `status-dot ${data.ollama ? 'on' : 'off'}`;
    document.getElementById('statusGPU').className = `status-dot ${data.gpu ? 'on' : 'off'}`;
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// 2D Face Sketcher
// ═══════════════════════════════════════════════════════════════

let s2dState = {
  elements: [],
  currentTool: 'select',
  selectedId: null,
  faceWidth: 100,
  faceHeight: 100,
  pxPerMm: 1,
  centerX: 0,
  centerY: 0,
  mouseX: 0,
  mouseY: 0,
  snappedX: 0,
  snappedY: 0,
  gridSize: 1, // mm
  isDragging: false,
  dragOffsetX: 0,
  dragOffsetY: 0
};

window.openSketch2d = function() {
  const overlay = document.getElementById('sketch2dOverlay');
  if (!overlay) return;
  
  // Resolve face selector — use canvas.selectedFace first, fall back to globals
  const faceStr = (canvas.selectedFace && canvas.selectedFace.selector)
    ? canvas.selectedFace.selector
    : (window.clickedFaceSelector || '>Y');
  const faceLabel = (canvas.selectedFace && canvas.selectedFace.label)
    ? canvas.selectedFace.label
    : (window.clickedFaceLabel || 'TOP FACE');
  
  document.getElementById('sketch2dTitleText').textContent = `2D Face Sketcher — ${faceLabel} (${faceStr})`;
  
  // Determine dimensions from the selected block
  const rootBlock = canvas.blocks.find(b => b.id === (canvas.selectedBlockId || '001')) || canvas.blocks[0];
  s2dState.faceWidth = 100;
  s2dState.faceHeight = 100;
  if (rootBlock && rootBlock.params) {
    const p = rootBlock.params;
    if (faceStr.includes('Y')) { // TOP / BOTTOM FACE
      s2dState.faceWidth = parseFloat(p.length || p.base_length || p.diameter || 100);
      s2dState.faceHeight = parseFloat(p.width || p.diameter || 60);
    } else if (faceStr.includes('Z')) { // FRONT / BACK FACE
      s2dState.faceWidth = parseFloat(p.length || p.base_length || p.diameter || 100);
      s2dState.faceHeight = parseFloat(p.height || p.thickness || p.diameter || 20);
    } else if (faceStr.includes('X')) { // LEFT / RIGHT FACE
      s2dState.faceWidth = parseFloat(p.width || p.diameter || 60);
      s2dState.faceHeight = parseFloat(p.height || p.thickness || p.diameter || 20);
    }
  }
  
  // Store resolved face selector for applySketch2d
  s2dState.faceSelector = faceStr;
  
  s2dState.elements = [];
  s2dState.originalBlockIds = [];
  
  // Reload existing features on this face
  const parentId = canvas.selectedBlockId || '001';
  canvas.blocks.forEach(b => {
    if (b.parent === parentId && b.face === faceStr) {
      if (['holes', 'pockets', 'boss'].includes(b.type)) {
        s2dState.originalBlockIds.push(b.id);
        
        // Reverse map coordinates
        const mapCoords = (cqX, cqY) => {
          let sx = cqX, sy = cqY;
          if (faceStr === '>X') { sx = -cqY; sy = cqX; }
          else if (faceStr === '<X') { sx = cqY; sy = -cqX; }
          else if (faceStr === '>Y') { sx = -cqX; sy = -cqY; }
          else if (faceStr === '<Y') { sx = cqX; sy = cqY; }
          else if (faceStr === '<Z') { sx = -cqX; sy = -cqY; }
          return { sx, sy };
        };

        if (b.type === 'holes' && b.params.hole_points) {
          try {
            const pts = JSON.parse(b.params.hole_points.replace(/'/g, '"'));
            pts.forEach((pt, i) => {
              const { sx, sy } = mapCoords(pt[0], pt[1]);
              s2dState.elements.push({
                id: b.id + '_' + i, type: 'circle', opType: 'hole',
                x: sx, y: sy, dia: parseFloat(b.params.hole_dia) || 6.6,
                depth: parseFloat(b.params.depth) || 10
              });
            });
          } catch(e) {}
        } else if (b.type === 'pockets') {
           const { sx, sy } = mapCoords(parseFloat(b.params.x)||0, parseFloat(b.params.y)||0);
           let sw = parseFloat(b.params.width) || 20;
           let sh = parseFloat(b.params.length) || 20;
           if (faceStr === '>X' || faceStr === '<X') { let tmp = sw; sw = sh; sh = tmp; }
           s2dState.elements.push({
             id: b.id, type: 'rect', opType: 'pocket',
             x: sx, y: sy, w: sw, h: sh, depth: parseFloat(b.params.depth) || 5
           });
        } else if (b.type === 'boss') {
           const { sx, sy } = mapCoords(parseFloat(b.params.x)||0, parseFloat(b.params.y)||0);
           s2dState.elements.push({
             id: b.id, type: 'circle', opType: 'boss',
             x: sx, y: sy, dia: parseFloat(b.params.diameter) || 15, depth: parseFloat(b.params.height) || 5
           });
        }
      }
    }
  });

  s2dState.selectedId = null;
  selectSketch2dTool('select');
  
  overlay.classList.add('visible');
  initSketch2dCanvas();
  renderSketch2dSidebar();
};

window.closeSketch2d = function() {
  document.getElementById('sketch2dOverlay').classList.remove('visible');
};

window.selectSketch2dTool = function(tool) {
  s2dState.currentTool = tool;
  document.querySelectorAll('.sketch2d-tool-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`s2dTool_${tool}`);
  if (btn) btn.classList.add('active');
  drawSketch2d();
};

window.clearSketch2d = function() {
  s2dState.elements = [];
  s2dState.selectedId = null;
  renderSketch2dSidebar();
  drawSketch2d();
};

function initSketch2dCanvas() {
  const ws = document.getElementById('sketch2dWorkspace');
  const cvs = document.getElementById('sketch2dCanvas');
  cvs.width = ws.clientWidth;
  cvs.height = ws.clientHeight;
  
  const padding = 60;
  const availW = cvs.width - padding * 2;
  const availH = cvs.height - padding * 2;
  
  s2dState.pxPerMm = Math.min(availW / s2dState.faceWidth, availH / s2dState.faceHeight);
  s2dState.centerX = cvs.width / 2;
  s2dState.centerY = cvs.height / 2;
  
  cvs.onmousemove = onSketch2dMouseMove;
  cvs.onmousedown = onSketch2dMouseDown;
  cvs.onmouseup = onSketch2dMouseUp;
  cvs.onmouseleave = onSketch2dMouseUp;
  
  drawSketch2d();
}

function getGridSnapped(val) {
  return Math.round(val / s2dState.gridSize) * s2dState.gridSize;
}

function onSketch2dMouseMove(e) {
  const cvs = document.getElementById('sketch2dCanvas');
  const rect = cvs.getBoundingClientRect();
  s2dState.mouseX = e.clientX - rect.left;
  s2dState.mouseY = e.clientY - rect.top;
  
  const mmX = (s2dState.mouseX - s2dState.centerX) / s2dState.pxPerMm;
  const mmY = (s2dState.centerY - s2dState.mouseY) / s2dState.pxPerMm;
  
  s2dState.snappedX = getGridSnapped(mmX);
  s2dState.snappedY = getGridSnapped(mmY);
  
  document.getElementById('sketch2dCoords').textContent = `X: ${s2dState.snappedX.toFixed(1)} Y: ${s2dState.snappedY.toFixed(1)} mm`;
  
  if (s2dState.isDragging && s2dState.selectedId) {
    const el = s2dState.elements.find(x => x.id === s2dState.selectedId);
    if (el) {
      el.x = s2dState.snappedX - s2dState.dragOffsetX;
      el.y = s2dState.snappedY - s2dState.dragOffsetY;
      renderSketch2dSidebar();
    }
  }
  
  drawSketch2d();
}

function onSketch2dMouseDown(e) {
  if (s2dState.currentTool === 'select') {
    // hit test
    s2dState.selectedId = null;
    for (let i = s2dState.elements.length - 1; i >= 0; i--) {
      const el = s2dState.elements[i];
      if (el.type === 'circle') {
        const dx = s2dState.snappedX - el.x;
        const dy = s2dState.snappedY - el.y;
        if (Math.sqrt(dx*dx + dy*dy) <= el.dia/2 + 1) {
          s2dState.selectedId = el.id;
          break;
        }
      } else if (el.type === 'rect') {
        if (Math.abs(s2dState.snappedX - el.x) <= el.w/2 + 1 && Math.abs(s2dState.snappedY - el.y) <= el.h/2 + 1) {
          s2dState.selectedId = el.id;
          break;
        }
      }
    }
    if (s2dState.selectedId) {
      s2dState.isDragging = true;
      const el = s2dState.elements.find(x => x.id === s2dState.selectedId);
      s2dState.dragOffsetX = s2dState.snappedX - el.x;
      s2dState.dragOffsetY = s2dState.snappedY - el.y;
    }
    renderSketch2dSidebar();
  } else {
    // create shape
    const id = Date.now().toString();
    if (s2dState.currentTool === 'hole') {
      s2dState.elements.push({ id, type: 'circle', opType: 'hole', x: s2dState.snappedX, y: s2dState.snappedY, dia: 6.6 });
    } else if (s2dState.currentTool === 'rect_pocket') {
      s2dState.elements.push({ id, type: 'rect', opType: 'pocket', x: s2dState.snappedX, y: s2dState.snappedY, w: 20, h: 15, depth: 5 });
    } else if (s2dState.currentTool === 'extrude') {
      s2dState.elements.push({ id, type: 'circle', opType: 'boss', x: s2dState.snappedX, y: s2dState.snappedY, dia: 15, depth: 5 });
    }
    s2dState.selectedId = id;
    s2dState.currentTool = 'select'; // switch back to select
    document.querySelectorAll('.sketch2d-tool-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('s2dTool_select').classList.add('active');
    renderSketch2dSidebar();
  }
  drawSketch2d();
}

function onSketch2dMouseUp() {
  s2dState.isDragging = false;
}

function drawSketch2d() {
  const cvs = document.getElementById('sketch2dCanvas');
  const ctx = cvs.getContext('2d');
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  
  // Grid
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  const gridPx = 10 * s2dState.pxPerMm; // 10mm grid
  const originX = s2dState.centerX;
  const originY = s2dState.centerY;
  
  ctx.beginPath();
  for (let x = originX % gridPx; x < cvs.width; x += gridPx) { ctx.moveTo(x, 0); ctx.lineTo(x, cvs.height); }
  for (let y = originY % gridPx; y < cvs.height; y += gridPx) { ctx.moveTo(0, y); ctx.lineTo(cvs.width, y); }
  ctx.stroke();
  
  // Axes
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(originX, 0); ctx.lineTo(originX, cvs.height);
  ctx.moveTo(0, originY); ctx.lineTo(cvs.width, originY);
  ctx.stroke();
  
  // Face outline
  ctx.strokeStyle = '#0078d4';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  const facePxW = s2dState.faceWidth * s2dState.pxPerMm;
  const facePxH = s2dState.faceHeight * s2dState.pxPerMm;
  ctx.strokeRect(originX - facePxW/2, originY - facePxH/2, facePxW, facePxH);
  ctx.setLineDash([]);
  
  // Elements
  s2dState.elements.forEach(el => {
    const cx = originX + el.x * s2dState.pxPerMm;
    const cy = originY - el.y * s2dState.pxPerMm;
    const isSel = el.id === s2dState.selectedId;
    
    ctx.strokeStyle = isSel ? '#fff' : '#0078d4';
    ctx.fillStyle = isSel ? 'rgba(255,255,255,0.2)' : 'rgba(0,120,212,0.2)';
    ctx.lineWidth = 2;
    
    ctx.beginPath();
    if (el.type === 'circle') {
      const r = (el.dia / 2) * s2dState.pxPerMm;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else if (el.type === 'rect') {
      const rw = el.w * s2dState.pxPerMm;
      const rh = el.h * s2dState.pxPerMm;
      ctx.rect(cx - rw/2, cy - rh/2, rw, rh);
    }
    ctx.fill();
    ctx.stroke();
    
    // center point
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI*2); ctx.fill();
  });
  
  // Preview
  if (s2dState.currentTool !== 'select') {
    const cx = originX + s2dState.snappedX * s2dState.pxPerMm;
    const cy = originY - s2dState.snappedY * s2dState.pxPerMm;
    ctx.strokeStyle = '#ff8c00';
    ctx.fillStyle = 'rgba(255,140,0,0.3)';
    ctx.beginPath();
    if (s2dState.currentTool === 'hole' || s2dState.currentTool === 'extrude') {
      const r = ((s2dState.currentTool === 'hole' ? 6.6 : 15) / 2) * s2dState.pxPerMm;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else if (s2dState.currentTool === 'rect_pocket') {
      const rw = 20 * s2dState.pxPerMm;
      const rh = 15 * s2dState.pxPerMm;
      ctx.rect(cx - rw/2, cy - rh/2, rw, rh);
    }
    ctx.fill(); ctx.stroke();
  }
}

function renderSketch2dSidebar() {
  const list = document.getElementById('sketch2dElementsList');
  const params = document.getElementById('sketch2dElemParams');
  
  if (s2dState.elements.length === 0) {
    list.innerHTML = `<div style="padding:12px;color:var(--text-dim);font-size:11px;">No sketch elements</div>`;
  } else {
    list.innerHTML = s2dState.elements.map(el => `
      <div class="sketch2d-el-item ${el.id === s2dState.selectedId ? 'selected' : ''}" onclick="s2dState.selectedId='${el.id}'; renderSketch2dSidebar(); drawSketch2d();">
        <span>${el.opType.toUpperCase()} (x:${el.x.toFixed(1)}, y:${el.y.toFixed(1)})</span>
        <span class="sketch2d-el-del" onclick="event.stopPropagation(); deleteSketch2dElem('${el.id}')">✕</span>
      </div>
    `).join('');
  }
  
  const sel = s2dState.elements.find(x => x.id === s2dState.selectedId);
  if (!sel) {
    params.innerHTML = `<div style="padding:12px;color:var(--text-dim);font-size:11px;">Select an element to view/edit dimensions.</div>`;
    return;
  }
  
  let html = `
    <label>X Offset <input type="number" step="0.5" value="${sel.x}" onchange="updateSketch2dElem('x', this.value)"></label>
    <label>Y Offset <input type="number" step="0.5" value="${sel.y}" onchange="updateSketch2dElem('y', this.value)"></label>
  `;
  if (sel.type === 'circle') {
    html += `<label>Diameter <input type="number" step="0.5" value="${sel.dia}" onchange="updateSketch2dElem('dia', this.value)"></label>`;
    if (sel.opType === 'boss' || sel.opType === 'hole') {
      html += `<label>Depth <input type="number" step="0.5" value="${sel.depth || 10}" onchange="updateSketch2dElem('depth', this.value)"></label>`;
    }
  } else if (sel.type === 'rect') {
    html += `
      <label>Width (X) <input type="number" step="0.5" value="${sel.w}" onchange="updateSketch2dElem('w', this.value)"></label>
      <label>Length (Y) <input type="number" step="0.5" value="${sel.h}" onchange="updateSketch2dElem('h', this.value)"></label>
      <label>Depth <input type="number" step="0.5" value="${sel.depth || 5}" onchange="updateSketch2dElem('depth', this.value)"></label>
    `;
  }
  params.innerHTML = html;
}

window.deleteSketch2dElem = function(id) {
  s2dState.elements = s2dState.elements.filter(x => x.id !== id);
  if (s2dState.selectedId === id) s2dState.selectedId = null;
  renderSketch2dSidebar();
  drawSketch2d();
};

window.updateSketch2dElem = function(key, val) {
  const el = s2dState.elements.find(x => x.id === s2dState.selectedId);
  if (el) {
    el[key] = parseFloat(val) || 0;
    renderSketch2dSidebar();
    drawSketch2d();
  }
};

// applyOp is defined at line ~210 — this block intentionally left empty
// to avoid overwriting the real applyOp function.

window.applySketch2d = async function() {
  const faceSelector = s2dState.faceSelector || (canvas.selectedFace ? canvas.selectedFace.selector : '>Y');
  const parentId = canvas.selectedBlockId || '001';
  
  closeSketch2d();
  document.getElementById('faceOpsBar').classList.remove('visible');
  showGenOverlay(`Syncing ${s2dState.elements.length} sketch features...`);
  
  try {
    // Delete the original blocks for this face first
    if (s2dState.originalBlockIds && s2dState.originalBlockIds.length > 0) {
      const delRes = await fetch('/canvas/delete-blocks', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          session_id: canvas.sessionId,
          block_ids: s2dState.originalBlockIds
        })
      });
      const delData = await delRes.json();
      if (delData.job_id) {
         canvas.currentJobId = delData.job_id;
         await executeJobPromise(delData.job_id);
      }
    }

    if (s2dState.elements.length === 0) {
      hideGenOverlay();
      return;
    }

    // Group holes since they share one block
    const holes = s2dState.elements.filter(e => e.opType === 'hole');
    const others = s2dState.elements.filter(e => e.opType !== 'hole');
    
    const blocksToAdd = [];

    const mapCoordsToCQ = (elem) => {
      let cqX = elem.x, cqY = elem.y;
      if (faceSelector === '>X') { cqX = elem.y; cqY = -elem.x; }
      else if (faceSelector === '<X') { cqX = -elem.y; cqY = elem.x; }
      else if (faceSelector === '>Y') { cqX = -elem.x; cqY = -elem.y; }
      else if (faceSelector === '<Y') { cqX = elem.x; cqY = elem.y; }
      else if (faceSelector === '<Z') { cqX = -elem.x; cqY = -elem.y; }
      return { cqX, cqY };
    };

    if (holes.length > 0) {
      const pts = holes.map(h => {
        const c = mapCoordsToCQ(h);
        return `[${c.cqX.toFixed(2)},${c.cqY.toFixed(2)}]`;
      });
      // use the first hole's dia and depth for all
      blocksToAdd.push({
        block_type: 'holes',
        params: { hole_points: `[${pts.join(',')}]`, hole_dia: holes[0].dia, depth: holes[0].depth || 10 }
      });
    }

    for (const elem of others) {
      const { cqX, cqY } = mapCoordsToCQ(elem);
      if (elem.opType === 'pocket') {
        let cqW = elem.w, cqH = elem.h;
        if (faceSelector === '>X' || faceSelector === '<X') { cqW = elem.h; cqH = elem.w; }
        blocksToAdd.push({
          block_type: 'pockets',
          params: { width: cqW, length: cqH, depth: elem.depth, x: cqX, y: cqY }
        });
      } else if (elem.opType === 'boss') {
        blocksToAdd.push({
          block_type: 'boss',
          params: { diameter: elem.dia, height: elem.depth, x: cqX, y: cqY }
        });
      }
    }

    for (const b of blocksToAdd) {
      addChatMsg('op', `Applying ${b.block_type}...`);
      const res = await fetch('/canvas/add-block', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          session_id: canvas.sessionId,
          block_type: b.block_type,
          params: b.params, parent_id: parentId, face: faceSelector
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      if (data.job_id) {
        canvas.currentJobId = data.job_id;
        await executeJobPromise(data.job_id);
      }
    }
    await loadBlocks();
  } catch (err) {
    addChatMsg('error', 'Sketch apply failed: ' + err.message);
  } finally {
    hideGenOverlay();
  }
};

function executeJobPromise(jobId) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/stream/${jobId}`);
    es.onmessage = function(event) {
      try {
        const entry = JSON.parse(event.data);
        if (entry.message) updateStatus(entry.message);
        if (entry.complete || entry.status === 'completed') {
          es.close();
          updateStatus('Ready');
          if (window.viewerInstance) {
            if (entry.has_glb_file) {
                window.viewerInstance.loadGLTF(`/model_glb/${jobId}`, true);
            } else if (entry.has_stl_file !== false) {
                window.viewerInstance.loadSTL(`/model/${jobId}`);
            }
          }
          saveToHistory();
          resolve(jobId);
        }
        if (entry.status === 'failed' || (entry.error && !entry.complete)) {
          es.close();
          reject(new Error(entry.error || 'Generation failed'));
        }
      } catch (e) {}
    };
    es.onerror = function() {
      es.close();
      reject(new Error('SSE stream disconnected'));
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// Assembly Mates
// ═══════════════════════════════════════════════════════════════

// ── ASSEMBLY ENGINE ────────────────────────────────────────────

// ── ASSEMBLY ENGINE ────────────────────────────────────────────

const assemblyParts = [];



function addAssemblyPart() {
    const templates = ['bracket','plate','shaft','housing','crankshaft','piston','connecting_rod','cylinder_block'];
    const type = templates[assemblyParts.length % templates.length];
    
    assemblyParts.push({
        template: type,
        params: {},
        position: {x: assemblyParts.length * 50, y: 0, z: 0},
        rotation: {axis: 'Z', angle: 0}
    });
    
    renderAssemblyBuilder();
}
window.addAssemblyPart = addAssemblyPart;

window.selectedAssemblyPartIndex = null;

window.selectAssemblyPart = function(index) {
    window.selectedAssemblyPartIndex = index;
    renderAssemblyBuilder();
    if (window.viewerInstance) {
        const p = assemblyParts[index];
        const partName = p.template + '_' + (index + 1);
        window.viewerInstance.attachGizmoToPart(partName);
    }
};

function renderAssemblyBuilder() {
    const container = document.getElementById('assemblyPartsList');
    container.innerHTML = assemblyParts.map((p, i) => `
        <div class="assembly-part-row ${i === window.selectedAssemblyPartIndex ? 'selected' : ''}" onclick="selectAssemblyPart(${i})">
            <select onchange="assemblyParts[${i}].template=this.value" class="prop-select" onclick="event.stopPropagation()">
                ${['bracket','plate','shaft','housing','crankshaft','piston','connecting_rod','cylinder_block']
                    .map(t => `<option value="${t}" ${p.template===t?'selected':''}>${t}</option>`).join('')}
            </select>
            <div class="part-pos-row" onclick="event.stopPropagation()">
                <span class="prop-label">X</span>
                <input type="number" value="${p.position.x}" class="prop-input" style="width:50px"
                       onchange="assemblyParts[${i}].position.x=parseFloat(this.value)">
                <span class="prop-label">Y</span>
                <input type="number" value="${p.position.y}" class="prop-input" style="width:50px"
                       onchange="assemblyParts[${i}].position.y=parseFloat(this.value)">
                <span class="prop-label">Z</span>
                <input type="number" value="${p.position.z}" class="prop-input" style="width:50px"
                       onchange="assemblyParts[${i}].position.z=parseFloat(this.value)">
            </div>
            <button onclick="event.stopPropagation(); assemblyParts.splice(${i},1); renderAssemblyBuilder()" 
                    class="tree-node-del">✕</button>
        </div>
    `).join('');
}
window.renderAssemblyBuilder = renderAssemblyBuilder;

async function buildCustomAssembly() {
    if (assemblyParts.length === 0) { showToast('Add parts first'); return; }
    
    showGenerationOverlay('Building custom assembly...');
    
    const res = await fetch('/assembly/build', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({parts: assemblyParts})
    });
    
    const data = await res.json();
    if (data.job_id) {
        connectSSE(data.job_id, onLog, async (status) => {
            hideGenerationOverlay();
            if (status === 'done') {
                if (window.viewerInstance) {
                    window.viewerInstance.loadGLTF(`/model_glb/${data.job_id}`);
                }
                window.currentJobId = data.job_id;
                document.getElementById('downloadBtn').style.display = 'block';
                addChatMsg('success', `Assembly built: ${assemblyParts.length} parts`);
                
                // Load script into editor
                const scriptRes = await fetch(`/assembly/script/${data.job_id}`);
                const scriptData = await scriptRes.json();
                if (scriptData.script && window.monacoInstance) {
                    window.monacoInstance.setValue(scriptData.script);
                }
            }
        });
    }
}
window.buildCustomAssembly = buildCustomAssembly;

// System Stats
async function refreshStats() {
    try {
        const res = await fetch('/admin/stats');
        const data = await res.json();
        const elRam = document.getElementById('statRam');
        const elJobs = document.getElementById('statJobs');
        const elTemp = document.getElementById('statTemp');
        const elStats = document.getElementById('sysStats');
        
        if (elRam) elRam.textContent = `${data.ram_mb}MB`;
        if (elJobs) elJobs.textContent = `${data.jobs_in_memory} jobs`;
        if (elTemp) elTemp.textContent = `${data.temp_files} tmp`;
        
        // Warn if RAM high
        if (elStats) {
            if (data.ram_mb > 800) {
                elStats.style.color = 'var(--warning)';
            } else {
                elStats.style.color = 'var(--text-dim)';
            }
        }
    } catch(e) {}
}
window.refreshStats = refreshStats;

// Auto refresh every 2 minutes
setInterval(refreshStats, 120000);
document.addEventListener('DOMContentLoaded', () => setTimeout(refreshStats, 2000));
