/**
 * DesignOS — Monaco Script Editor (Tab 3)
 * Syncs with canvas session, Ctrl+S to execute, parameter sliders.
 */

function initMonaco(initialScript) {
  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' }});
  require(['vs/editor/editor.main'], function() {
    window.monacoInstance = monaco.editor.create(
      document.getElementById('monacoEditor'), {
        value: initialScript || '# No script loaded yet\n# Generate a part in the Prompt to Geometry tab first.',
        language: 'python',
        theme: 'vs-dark',
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Consolas', monospace",
        automaticLayout: true,
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        renderLineHighlight: 'all',
        padding: { top: 8 },
        wordWrap: 'on',
      }
    );

    // Ctrl+S to run
    window.monacoInstance.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => runCurrentScript()
    );
  });
}

async function runCurrentScript() {
  if (!window.monacoInstance) return;
  const script = window.monacoInstance.getValue();
  if (!script.trim()) return;

  const statusEl = document.getElementById('statusMsg');
  if (statusEl) statusEl.textContent = 'Executing script...';

  try {
    const res = await fetch('/run-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script })
    });
    const data = await res.json();

    if (data.error) {
      if (statusEl) statusEl.textContent = 'Script error: ' + data.error;
      return;
    }

    if (data.job_id) {
      // Stream results
      const es = new EventSource(`/stream/${data.job_id}`);
      es.onmessage = function(event) {
        try {
          const entry = JSON.parse(event.data);
          if (entry.message && statusEl) statusEl.textContent = entry.message;

          if (entry.complete || entry.status === 'completed') {
            es.close();
            if (statusEl) statusEl.textContent = 'Ready';
            if (window.viewerInstance && entry.has_stl_file !== false) {
              window.viewerInstance.loadSTL(`/model/${data.job_id}`);
            }
          }
          if (entry.status === 'failed') {
            es.close();
            if (statusEl) statusEl.textContent = 'Execution failed';
          }
        } catch(e) {}
      };
      es.onerror = () => es.close();
    }
  } catch(e) {
    if (statusEl) statusEl.textContent = 'Failed: ' + e.message;
  }
}

// Init Monaco when Tab 3 is first opened
window.initEditorTab = function() {
  if (!window.monacoInstance) {
    const script = window.canvas?.script || '';
    initMonaco(script);
  } else {
    // Sync script
    const script = window.canvas?.script || '';
    if (script) window.monacoInstance.setValue(script);
  }
};
