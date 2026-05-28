import os

with open("templates/old_index.html", "r", encoding="utf-16") as f:
    old_html = f.read()

# We want to keep the original HTML structure for the form and sidebar tabs.
# The original layout was #app -> (header, #sidebar, #main)
# We will wrap #sidebar and #main in <div id="formStage" class="stage">
# And then add the new <div id="editStage" class="stage"> right after it, but before </div> <!-- end #app -->

# Let's just create a new file entirely using the old one as a base.

new_html = old_html.replace(
    '</head>',
    '  <script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs/loader.js"></script>\n  <link rel="stylesheet" href="/static/ide.css">\n</head>'
)

# Insert the stage wrappers
new_html = new_html.replace(
    '<!-- ==================== SIDEBAR ==================== -->',
    '<!-- STAGE 1: FORM MODE -->\n<div id="formStage" class="stage">\n<!-- ==================== SIDEBAR ==================== -->'
)

# Close formStage and start editStage after #main
new_html = new_html.replace(
    '  </main>\n\n</div>',
    """  </main>
</div> <!-- End formStage -->

<!-- STAGE 2: EDIT MODE -->
<div id="editStage" class="stage" style="display:none">
  <div class="edit-layout">
    <div class="slider-panel" id="sliderPanel">
      <div class="panel-title">PARAMETERS</div>
      <div id="slidersContainer"></div>
      <button class="btn-back" id="backBtn">← New Part</button>
    </div>
    <div class="viewer-panel" id="editViewerContainer">
      <div id="viewerCanvas" style="width:100%; height:100%;"></div>
      <div id="facePopup" class="face-popup" style="display:none">
        <div class="popup-title" id="popupTitle">TOP FACE</div>
        <button onclick="faceAction('Add holes here')">+ Holes</button>
        <button onclick="faceAction('Add pocket here')">+ Pocket</button>
        <button onclick="faceAction('Add fillet to all edges')">+ Fillet</button>
        <button onclick="faceAction('Add boss here')">+ Boss</button>
        <button class="btn-close" onclick="closePopup()">✕</button>
      </div>
    </div>
    <div class="script-panel" id="scriptPanel" style="display:none">
      <div class="panel-title" style="padding:16px;">SCRIPT</div>
      <div id="monacoEditor" style="height:100%"></div>
    </div>
  </div>
  <div class="ai-panel">
    <span class="ai-label">AI ›</span>
    <input type="text" id="aiInput" class="ai-input" placeholder='e.g. "add 4 M6 holes on top face"'/>
    <button id="aiBtn" class="btn-assist">MODIFY</button>
    <span id="aiStatus" class="ai-status"></span>
  </div>
</div>

</div> <!-- end #app -->
"""
)

# Update header with toggle buttons
new_html = new_html.replace(
    '<div class="health-indicators" id="health-indicators">',
    """<span class="mode-indicator" id="modeIndicator" style="margin-right:auto; margin-left: 20px;">FORM MODE</span>
    <div class="header-right" style="display:flex; gap:12px; margin-right: 20px; align-items:center;">
      <span id="runStatus" class="run-status"></span>
      <button id="toggleScript" class="btn-secondary" style="display:none; margin:0;">Show Script</button>
    </div>
    <div class="health-indicators" id="health-indicators">"""
)


# We need to modify the pollStatus logic inside <script type="module">
# When d.status === "completed", we want to call onGenerationComplete(jobId, script)

old_poll = """    // Terminal states
    if (d.status === "completed") {
      clearInterval(pollTimer);
      pollTimer = null;
      statusBar.classList.remove("visible");
      btnGenerate.disabled = false;
      btnExecute.disabled = false;
      btnDownload.style.display = "inline-block";
      refineSection.classList.add("visible");
      viewerToolbar.style.display = "flex";

      // Load 3-D model
      if (d.has_stl_file && viewer) {
        // Hide the empty-state overlay so the 3D model is visible
        emptyState.style.display = "none";
        document.getElementById("viewer-overlay").style.display = "none";
        console.log("Loading STL from /model/" + currentJobId);
        viewer.loadSTL(`/model/${currentJobId}`);
      } else {
        console.warn("No STL file or viewer not ready", { has_stl: d.has_stl_file, viewer: !!viewer });
      }
    } else if (d.status === "failed") {"""

new_poll = """    // Terminal states
    if (d.status === "completed") {
      clearInterval(pollTimer);
      pollTimer = null;
      statusBar.classList.remove("visible");
      
      onGenerationComplete(currentJobId, d.script || "");
      
    } else if (d.status === "failed") {"""

new_html = new_html.replace(old_poll, new_poll)


# Now append our new JS logic
new_html = new_html.replace(
    '</script>\n\n</body>',
    """
// --- NEW PATH B LOGIC ---

window.viewerInstance = null;

window.onGenerationComplete = function(jobId, script) {
    window.currentScript = script;
    window.currentJobId = jobId;
    
    document.getElementById('formStage').style.display = 'none';
    document.getElementById('editStage').style.display = 'flex';
    document.getElementById('modeIndicator').textContent = 'EDIT MODE';
    document.getElementById('toggleScript').style.display = 'block';
    
    // Create new viewer inside editStage if not exists
    if (!window.viewerInstance) {
        window.viewerInstance = new CADViewer("viewerCanvas");
    }
    window.viewerInstance.loadSTL(`/model/${jobId}`);
    
    if (typeof parseSliders === 'function') {
        const params = parseSliders(script);
        buildSliders(params, onSliderChange);
    }
    if (typeof initMonaco === 'function') {
        initMonaco(script);
    }
}

document.getElementById('backBtn').addEventListener('click', () => {
    document.getElementById('editStage').style.display = 'none';
    document.getElementById('formStage').style.display = 'grid'; // because #app is grid, but formStage is block, wait. formStage contains #sidebar and #main, it should be display: flex or something. Actually, let's reset to initial.
    // Wait, #formStage is display: flex if we add a class. But let's just make it display: flex or grid depending on CSS. 
    // Wait, original #app was grid! I broke the grid layout by wrapping it in formStage!
    document.getElementById('formStage').style.display = 'contents'; 
    document.getElementById('modeIndicator').textContent = 'FORM MODE';
    document.getElementById('toggleScript').style.display = 'none';
    btnGenerate.disabled = false;
});

window.runCurrentScript = async function() {
    document.getElementById('runStatus').textContent = 'Running...';
    document.getElementById('runStatus').className = 'run-status running';
    
    const script = window.monacoInstance ? window.monacoInstance.getValue() : window.currentScript;
    const res = await fetch('/run-script', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({script})
    });
    const d = await res.json();
    
    let execTimer = setInterval(async () => {
        const sr = await fetch(`/status/${d.job_id}`);
        const stat = await sr.json();
        if (stat.status === 'completed') {
            clearInterval(execTimer);
            document.getElementById('runStatus').textContent = 'Updated';
            document.getElementById('runStatus').className = 'run-status done';
            window.currentJobId = d.job_id;
            window.viewerInstance.loadSTL(`/model/${d.job_id}`);
            if (typeof parseSliders === 'function') {
                const params = parseSliders(stat.script || script);
                buildSliders(params, onSliderChange);
            }
        } else if (stat.status === 'failed') {
            clearInterval(execTimer);
            document.getElementById('runStatus').textContent = 'Error';
            document.getElementById('runStatus').className = 'run-status error';
        }
    }, 800);
}

// AI logic
async function triggerAI() {
    const instruction = document.getElementById('aiInput').value.trim();
    if (!instruction) return;
    
    const script = window.monacoInstance ? window.monacoInstance.getValue() : window.currentScript;
    
    document.getElementById('aiStatus').textContent = 'Thinking...';
    document.getElementById('aiBtn').disabled = true;
    
    const res = await fetch('/assist', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            instruction,
            script,
            face_label: window.clickedFaceLabel || null
        })
    });
    
    const data = await res.json();
    
    if (data.script) {
        window.currentScript = data.script;
        if (window.monacoInstance) {
            window.monacoInstance.setValue(data.script);
        }
        if (typeof parseSliders === 'function') {
            buildSliders(parseSliders(data.script), onSliderChange);
        }
        await window.runCurrentScript();
    }
    
    document.getElementById('aiStatus').textContent = '';
    document.getElementById('aiBtn').disabled = false;
    document.getElementById('aiInput').value = '';
}

document.getElementById('aiBtn').addEventListener('click', triggerAI);
document.getElementById('aiInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') triggerAI();
});

window.faceAction = function(action) {
    window.closePopup();
    document.getElementById('aiInput').value = `${action} on the ${window.clickedFaceLabel.toLowerCase()}`;
    triggerAI();
}

window.closePopup = function() {
    const popup = document.getElementById('facePopup');
    if (popup) popup.style.display = 'none';
}

</script>
<script src="/static/sliders.js"></script>
<script src="/static/editor.js"></script>
</body>"""
)

# Since formStage wraps the grid, we need formStage to be display: contents so #app grid layout still works
new_html = new_html.replace('<div id="formStage" class="stage">', '<div id="formStage" style="display: contents">')


with open("templates/index.html", "w", encoding="utf-8") as f:
    f.write(new_html)

print("Merged successfully!")
