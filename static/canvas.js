/**
 * DesignOS Canvas Controller
 * Manages the block-based assembly workspace.
 * All parameter updates are pure REST — zero AI latency.
 */

const canvas = {
    sessionId: null,
    selectedBlockId: null,
    selectedFace: null,
    blocks: [],
    updateTimer: null,
    currentJobId: null
};

// ─── Default params for each block type ───
const DEFAULT_PARAMS = {
    bracket: { length: 80.0, width: 50.0, height: 40.0, wall_t: 5.0, x: 0, y: 0, z: 0 },
    plate:   { length: 50.0, width: 50.0, height: 5.0, x: 0, y: 0, z: 0 },
    shaft:   { diameter: 20.0, length: 60.0, x: 0, y: 0, z: 0 },
    housing: { length: 60.0, width: 40.0, height: 30.0, wall_t: 3.0, x: 0, y: 0, z: 0 },
    channel: { length: 80.0, width: 40.0, height: 30.0, wall_t: 3.0, x: 0, y: 0, z: 0 },
    gear:    { diameter: 40.0, height: 10.0, x: 0, y: 0, z: 0 },
    i_beam:  { height: 60.0, width: 30.0, length: 100.0, web_thickness: 4.0, flange_thickness: 6.0, x: 0, y: 0, z: 0 },
    holes:   { hole_points: "[[20,0],[-20,0]]", hole_dia: 6.6 },
    fillets: { radius: 2.0 },
    chamfers:{ size: 1.0 },
    pockets: { width: 30.0, length: 20.0, depth: 5.0 },
    boss:    { diameter: 15.0, height: 10.0, x: 0, y: 0 },
    shell:   { wall_t: 2.0 },
    smart_fillet: { radius: 2.0 },
    flange:  { length: 60.0, width: 60.0, height: 8.0, wall_t: 3.0, x: 0, y: 0, z: 0 }
};

const BLOCK_ICONS = {
    bracket: 'L', plate: '□', shaft: '|', housing: '⊞',
    channel: 'U', gear: '⚙', i_beam: 'I', flange: '◎',
    holes: '○', fillets: '⌒', chamfers: '/', pockets: '▽',
    boss: '⬆', shell: '◻', smart_fillet: '⌒',
    two_stage_parallel_shaft: '‖'
};

// ─── Initialize canvas session ───
window.initCanvas = async function(formData) {
    const statusEl = document.getElementById('canvasStatus');
    if (statusEl) statusEl.textContent = 'Initializing canvas session...';

    try {
        const res = await fetch('/canvas/session', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ form_data: formData })
        });
        const data = await res.json();
        if (data.error) {
            console.error('Canvas session error:', data.error);
            return;
        }

        canvas.sessionId = data.session_id;
        canvas.currentJobId = data.job_id;

        // Switch stages
        document.getElementById('formStage').style.display = 'none';
        document.getElementById('editStage').style.display = 'none';
        document.getElementById('canvasStage').style.display = 'flex';
        document.getElementById('canvasSessionId').textContent = canvas.sessionId;
        document.getElementById('modeIndicator').textContent = 'CANVAS MODE';

        // Create viewer in canvas container if not exists
        if (!window.viewerInstance) {
            // Dynamically import CADViewer
            const { CADViewer } = await import('/static/viewer.js');
            window.viewerInstance = new CADViewer('canvasViewerContainer');
        }

        // Connect SSE for the initial build
        connectCanvasSSE(data.job_id);
        await loadBlocks();
    } catch(e) {
        console.error('Canvas init failed:', e);
    }
};

// ─── Load and render blocks ───
async function loadBlocks() {
    if (!canvas.sessionId) return;
    try {
        const res = await fetch(`/canvas/blocks/${canvas.sessionId}`);
        const data = await res.json();
        canvas.blocks = data.blocks || [];
        renderAssemblyTree();
        
        // Update script view
        const scriptView = document.getElementById('canvasScriptView');
        if (scriptView) scriptView.textContent = data.script || '';
    } catch(e) {
        console.error('Load blocks failed:', e);
    }
}

// ─── Render assembly tree ───
function renderAssemblyTree() {
    const tree = document.getElementById('assemblyTree');
    if (!tree) return;

    if (canvas.blocks.length === 0) {
        tree.innerHTML = '<div class="tree-empty">No blocks yet</div>';
        return;
    }

    tree.innerHTML = canvas.blocks.map(b => {
        const icon = BLOCK_ICONS[b.type] || '□';
        const sel = b.id === canvas.selectedBlockId ? ' selected' : '';
        const indent = b.parent ? ' tree-child' : '';
        return `<div class="tree-item${sel}${indent}" onclick="selectBlock('${b.id}')">
            <span class="tree-icon">${icon}</span>
            <span class="tree-label">b${b.id}: ${b.type}</span>
        </div>`;
    }).join('');
}

// ─── Select block ───
window.selectBlock = function(blockId) {
    canvas.selectedBlockId = blockId;
    const block = canvas.blocks.find(b => b.id === blockId);
    if (!block) return;
    renderParamPanel(block);
    renderAssemblyTree();
};

// ─── Render parameter panel ───
function renderParamPanel(block) {
    const panel = document.getElementById('paramPanel');
    if (!panel) return;

    const params = block.params || {};

    let html = `<div class="param-panel-title">[BLOCK_${block.id}] ${block.type.toUpperCase()}</div>`;

    for (const [key, val] of Object.entries(params)) {
        html += `
        <div class="param-row">
            <label>${key}</label>
            <div class="param-input-row">
                <input type="number"
                       id="cparam_${key}"
                       value="${val}"
                       step="0.5"
                       data-block="${block.id}"
                       data-key="${key}"
                       onchange="updateCanvasParam(this)">
                <span class="param-unit">mm</span>
            </div>
        </div>`;
    }

    if (block.face) {
        html += `
        <div class="mount-face-row">
            <label>Mounted on</label>
            <div class="face-badge">${block.face}</div>
        </div>`;
    }

    panel.innerHTML = html;
}

// ─── Update parameter (debounced, NO AI) ───
window.updateCanvasParam = function(inputEl) {
    const blockId = inputEl.dataset.block;
    const paramKey = inputEl.dataset.key;
    const newValue = parseFloat(inputEl.value);
    if (isNaN(newValue)) return;

    clearTimeout(canvas.updateTimer);
    canvas.updateTimer = setTimeout(async () => {
        const statusEl = document.getElementById('canvasStatus');
        if (statusEl) statusEl.textContent = 'Updating...';

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
            if (data.job_id) {
                canvas.currentJobId = data.job_id;
                connectCanvasSSE(data.job_id);
                await loadBlocks();
            }
        } catch(e) {
            console.error('Update param failed:', e);
        }
    }, 600);
};

// ─── Add geometry block ───
window.addGeometry = function(blockType) {
    const face = canvas.selectedFace || '>Z';
    const params = { ...(DEFAULT_PARAMS[blockType] || {}) };
    _addBlock(blockType, params, face);
};

// ─── Geometry click handler (from viewer.js) ───
window.onGeometryClick = function(hit) {
    if (hit) {
        // Extract CadQuery selector from window.clickedFaceLabel
        const match = window.clickedFaceLabel.match(/'([^']+)'/);
        if (match) {
            canvas.selectedFace = match[1];
            document.getElementById('canvasFaceSelectorLabel').textContent = canvas.selectedFace;
            document.getElementById('canvasFaceSelectorLabel').classList.add('active');
        }
    }
};

window.clearFaceSelection = function() {
    canvas.selectedFace = null;
    document.getElementById('canvasFaceSelectorLabel').textContent = "None (Free Space)";
    document.getElementById('canvasFaceSelectorLabel').classList.remove('active');
};

async function _addBlock(blockType, params, face) {
    const statusEl = document.getElementById('canvasStatus');
    if (statusEl) statusEl.textContent = 'Adding block...';

    try {
        const res = await fetch('/canvas/add-block', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                session_id: canvas.sessionId,
                block_type: blockType,
                params: params,
                parent_id: canvas.selectedBlockId || '001',
                face: face
            })
        });
        const data = await res.json();
        if (data.job_id) {
            canvas.currentJobId = data.job_id;
            connectCanvasSSE(data.job_id);
            await loadBlocks();
        }
    } catch(e) {
        console.error('Add block failed:', e);
    }
}

// ─── Undo ───
window.undoCanvas = async function() {
    if (!canvas.sessionId) return;
    try {
        const res = await fetch(`/canvas/undo/${canvas.sessionId}`, { method: 'POST' });
        const data = await res.json();
        if (data.job_id) {
            canvas.currentJobId = data.job_id;
            connectCanvasSSE(data.job_id);
            await loadBlocks();
        }
    } catch(e) {
        console.error('Undo failed:', e);
    }
};

// ─── SSE connection for canvas jobs ───
function connectCanvasSSE(jobId) {
    const es = new EventSource(`/stream/${jobId}`);
    const statusEl = document.getElementById('canvasStatus');

    es.onmessage = function(event) {
        try {
            const entry = JSON.parse(event.data);

            // Status update
            if (statusEl) {
                statusEl.textContent = entry.message || entry.status || '';
                statusEl.className = 'canvas-status ' + (entry.status || '');
            }

            // Job complete
            if (entry.complete || entry.status === 'completed') {
                es.close();
                if (statusEl) {
                    statusEl.textContent = 'Ready';
                    statusEl.className = 'canvas-status done';
                }
                // Load STL into viewer
                if (window.viewerInstance && entry.has_stl_file !== false) {
                    window.viewerInstance.loadSTL(`/model/${jobId}`);
                }
            }

            // Error
            if (entry.error) {
                es.close();
                if (statusEl) {
                    statusEl.textContent = 'Error: ' + entry.error;
                    statusEl.className = 'canvas-status error';
                }
            }
        } catch(e) {
            // Ignore parse errors
        }
    };

    es.onerror = function() {
        es.close();
    };
}

// ─── Export STEP ───
window.exportCanvasSTEP = function() {
    if (canvas.currentJobId) {
        window.location.href = `/download/${canvas.currentJobId}`;
    }
};

// ─── Toggle script view ───
window.toggleCanvasScript = function() {
    const panel = document.getElementById('canvasScriptPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
};

// ─── Back to form ───
window.canvasBackToForm = function() {
    document.getElementById('canvasStage').style.display = 'none';
    document.getElementById('formStage').style.display = 'contents';
    canvas.sessionId = null;
    canvas.blocks = [];
    canvas.selectedBlockId = null;
};
