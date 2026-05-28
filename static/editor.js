function initMonaco(initialScript) {
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.44.0/min/vs' }});
    require(['vs/editor/editor.main'], function() {
        window.monacoInstance = monaco.editor.create(
            document.getElementById('monacoEditor'), {
                value: initialScript,
                language: 'python',
                theme: 'vs-dark',
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "'JetBrains Mono', monospace",
                automaticLayout: true,
                scrollBeyondLastLine: false
            }
        );
        // Ctrl+S to run
        window.monacoInstance.addCommand(
            monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
            () => runCurrentScript()
        );
    });
}

// Toggle script panel
document.getElementById('toggleScript').addEventListener('click', () => {
    const panel = document.getElementById('scriptPanel');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'flex';
    document.getElementById('toggleScript').textContent = visible ? 'Show Script' : 'Hide Script';
});
