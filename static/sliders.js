const PARAM_REGEX = /^([a-zA-Z_]\w*)\s*=\s*([0-9]+\.?[0-9]*)\s*#\s*mm/gm;

function parseSliders(script) {
    const params = [];
    let match;
    while ((match = PARAM_REGEX.exec(script)) !== null) {
        params.push({
            name: match[1],
            value: parseFloat(match[2]),
            min: parseFloat(match[2]) * 0.1,
            max: parseFloat(match[2]) * 5.0,
            step: 0.5
        });
    }
    return params;
}

function buildSliders(params, onChangeCallback) {
    const container = document.getElementById('slidersContainer');
    container.innerHTML = '';
    
    params.forEach(p => {
        const wrapper = document.createElement('div');
        wrapper.className = 'param-row';
        wrapper.innerHTML = `
            <div class="param-header">
                <span class="param-name">${p.name}</span>
                <span class="param-unit">mm</span>
            </div>
            <input type="number" 
                   min="${p.min}" max="${p.max}" step="${p.step}" 
                   value="${p.value}" id="input_${p.name}"
                   onchange="onSliderChange('${p.name}', this.value)"
                   style="width:100%; padding:6px; background:var(--bg-input); border:1px solid var(--border); color:var(--text-primary); border-radius:4px;">
        `;
        container.appendChild(wrapper);
    });
}

function onSliderChange(name, value) {
    // Update script in Monaco
    const current = window.monacoInstance ? window.monacoInstance.getValue() : window.currentScript;
    const updated = current.replace(
        new RegExp(`(${name}\\s*=\\s*)[0-9]+\\.?[0-9]*(\\s*#\\s*mm)`),
        `$1${value}$2`
    );
    if (window.monacoInstance) {
        window.monacoInstance.setValue(updated);
    } else {
        window.currentScript = updated;
    }
    // Debounced auto-run
    clearTimeout(window.runTimer);
    window.runTimer = setTimeout(() => runCurrentScript(), 800);
}
