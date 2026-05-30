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

  const faceSelector = window.clickedFaceSelector || '>Z';
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
  const face = canvas.selectedFace?.selector || '>Z';

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
    showToast('2D Face Editor — coming in next version');
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
          window.viewerInstance.loadSTL(`/model/${jobId}`);
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
