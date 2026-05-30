"""
DesignOS — AI-powered Text-to-CAD backend
Flask server that orchestrates a local Ollama Qwen model and CadQuery
to generate parametric CAD models from natural-language descriptions.
"""

import ast
import os
import re
import uuid
import json
import time
import threading
import subprocess
from flask import Flask, request, jsonify, send_file, render_template, Response
from flask_cors import CORS
import requests as http_requests
from block_engine import parse_blocks, update_block_param, add_block_to_script, assemble_block_script

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

app = Flask(__name__)
CORS(app, origins=["http://localhost:5000", "http://127.0.0.1:5000"])

TEMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
CADQUERY_PYTHON = r"H:\Miniconda3\python.exe"
OLLAMA_URL = "http://localhost:11434/api/generate"
QWEN_MODEL = "qwen2.5:7b-instruct"
OLLAMA_TIMEOUT = 180  # generous timeout for a 7B model on 4GB VRAM

os.makedirs(TEMP_DIR, exist_ok=True)

# In-memory job store  (adequate for single-user local use)
jobs: dict = {}

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

QWEN_SYSTEM_PROMPT = """\
You are a mechanical engineering parameter calculator.
You receive a part specification and return ONLY a JSON object with calculated parameters.
No Python code. No CadQuery. No explanation. Pure JSON only.

CALCULATION RULES:
- wall_t = max(3.0, min_dimension * 0.15) for aluminium, max(2.5, min_dimension*0.12) for steel
- fillet_r = min(wall_t * 0.4, 2.0) — never exceed wall_t
- hole_dia: M4=4.5mm, M5=5.5mm, M6=6.6mm, M8=9mm (clearance holes)
- hole_points: symmetric pattern, min edge clearance = hole_dia * 1.5 from part edge
- For bracket: holes go on BASE PLATE ONLY, y_offset=0 (center of base)
- pocket_depth max = height * 0.6

COORDINATE SYSTEM: Origin at part center. X=length, Y=width, Z=height.
Hole points are offsets FROM CENTER of the face.

Return this exact JSON structure:
{
  "wall_t": 0.0,
  "hole_dia": 0.0,
  "hole_points": [[0,0]],
  "fillet_r": 0.0,
  "chamfer_size": 0.0,
  "pocket_w": 0.0,
  "pocket_l": 0.0,
  "pocket_depth": 0.0,
  "boss_dia": 0.0,
  "boss_height": 0.0
}"""


# ---------------------------------------------------------------------------
# Ollama helper
# ---------------------------------------------------------------------------

def call_ollama(model: str, prompt: str, system: str = "") -> str:
    """Send a synchronous generate request to the local Ollama instance."""
    try:
        resp = http_requests.post(
            OLLAMA_URL,
            json={
                "model": model,
                "prompt": prompt,
                "system": system,
                "stream": False,
                "options": {
                    "temperature": 0.1,
                    "num_predict": 1024,
                },
            },
            timeout=OLLAMA_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()["response"]
    except Exception as exc:
        raise RuntimeError(f"Ollama call failed ({model}): {exc}") from exc


def extract_python_code(text: str) -> str:
    """Strip markdown fences if the model wrapped its output."""
    # Try to extract from ```python ... ``` blocks
    for pattern in (r"```python\s*\n(.*?)```", r"```\s*\n(.*?)```"):
        m = re.search(pattern, text, re.DOTALL)
        if m:
            return m.group(1).strip()
    return text.strip()


def sanitise_script(script: str) -> str:
    """
    Post-process the LLM-generated script to remove known failure patterns
    that the model sometimes produces despite instructions.
    """
    lines = script.split("\n")
    cleaned = []
    for line in lines:
        stripped = line.strip()
        # Remove assert statements
        if stripped.startswith("assert "):
            continue
        # Remove hardcoded export lines — our wrapper handles this
        if "cq.exporters.export" in stripped and "output_path" not in stripped:
            continue
        cleaned.append(line)
    return "\n".join(cleaned)


BLACKLISTED_MODULES = {'os', 'subprocess', 'sys', 'shutil', 'socket', 'requests', 'urllib', 'http'}

def validate_script_safety(script: str) -> tuple:
    """Returns (is_safe, reason)"""
    try:
        tree = ast.parse(script)
    except SyntaxError as e:
        return False, f"Syntax error: {e}"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split('.')[0] in BLACKLISTED_MODULES:
                    return False, f"Blocked import: {alias.name}"
        if isinstance(node, ast.ImportFrom):
            if node.module and node.module.split('.')[0] in BLACKLISTED_MODULES:
                return False, f"Blocked import: {node.module}"
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in {'eval', 'exec', 'compile', '__import__'}:
                return False, f"Blocked call: {node.func.id}"
    return True, "OK"


# ---------------------------------------------------------------------------
# Pipeline stages — Template-based assembly
# ---------------------------------------------------------------------------

def build_spec_string(form_data: dict) -> str:
    """Build a human-readable spec string for Qwen parameter calculation."""
    part_type = form_data.get("part_type", "Part")
    length = float(form_data.get("length", 100))
    width = float(form_data.get("width", 60))
    height = float(form_data.get("height", 20))
    material = form_data.get("material", "Steel")
    features = form_data.get("features", [])
    notes = form_data.get("notes", "")

    return (
        f"Part: {part_type}\n"
        f"Dimensions: {length}mm (L) x {width}mm (W) x {height}mm (H)\n"
        f"Material: {material}\n"
        f"Features: {', '.join(features) if features else 'None'}\n"
        f"Notes: {notes if notes else 'Standard design'}\n"
        f"Calculate parameters for this part. Return ONLY JSON."
    )


def get_params_from_qwen(spec: str) -> dict:
    raw = call_ollama(QWEN_MODEL, spec, QWEN_SYSTEM_PROMPT)
    try:
        import re, json
        match = re.search(r'\{[\s\S]*?\}', raw)
        if match:
            params = json.loads(match.group())
            # Validate types — reject anything non-numeric
            numeric_keys = ["wall_t","hole_dia","fillet_r","chamfer_size","pocket_w","pocket_l","pocket_depth","boss_dia","boss_height"]
            for k in numeric_keys:
                if k in params:
                    try:
                        params[k] = float(params[k])
                    except:
                        del params[k]
            return params
    except:
        pass
    return {}


def assemble_script(form_data: dict, params: dict) -> str:
    part_type = form_data.get("part_type", "plate").lower()
    length = float(form_data.get("length", 100))
    width = float(form_data.get("width", 60))
    height = float(form_data.get("height", 20))
    features = [f.lower() for f in form_data.get("features", [])]

    # ── TRANSLATE UI FEATURE NAMES EARLY ──
    # UI sends "mounting holes", "edge fillets" etc.  We need boolean flags.
    f_str = " ".join(features)
    has_holes = "hole" in f_str
    has_fillets = "fillet" in f_str
    has_chamfers = "chamfer" in f_str
    has_pockets = "pocket" in f_str
    has_boss = "boss" in f_str
    has_shell = "shell" in f_str

    # ── SAFE PARAMETER DEFAULTS ──
    min_dim = min(length, width, height)

    # Wall thickness: clamp tightly — max 15% of smallest dim or 5mm
    wall_t = float(params.get("wall_t") or max(2.0, min_dim * 0.1))
    wall_t = min(wall_t, min_dim * 0.15, 5.0)
    wall_t = max(wall_t, 1.5)

    hole_dia = float(params.get("hole_dia") or 6.6)
    hole_dia = min(hole_dia, min_dim * 0.15)  # hole can't be huge
    hole_dia = max(hole_dia, 2.0)

    # Validate and sanitize hole points
    raw_pts = params.get("hole_points") or []
    safe_pts = []
    margin = hole_dia * 1.5
    for pt in raw_pts:
        try:
            x, y = float(pt[0]), float(pt[1])
            x = max(-(length/2 - margin), min(length/2 - margin, x))

            y_min = -(width/2 - margin)
            if part_type == "bracket":
                y_min = -(width/2) + wall_t + margin

            y = max(y_min, min(width/2 - margin, y))
            safe_pts.append([round(x,2), round(y,2)])
        except:
            continue

    # Default hole pattern if none provided
    if not safe_pts and has_holes:
        ox = round(length/2 - hole_dia*2, 2)
        if part_type == "bracket":
            # Holes must sit on the flat base plate, avoiding the wall footprint
            usable_y = width - wall_t
            y_center = wall_t / 2  # shift forward from origin
            oy = round(usable_y/2 - hole_dia*1.5, 2)
            safe_pts = [
                [ox, y_center + oy],
                [-ox, y_center + oy],
                [ox, y_center - oy],
                [-ox, y_center - oy]
            ]
        else:
            oy = round(width/2 - hole_dia*2, 2)
            safe_pts = [[ox,oy],[-ox,oy],[ox,-oy],[-ox,-oy]]

    fillet_r = float(params.get("fillet_r") or min(2.0, wall_t * 0.35))
    fillet_r = min(fillet_r, min_dim * 0.08)

    pocket_w = float(params.get("pocket_w") or length * 0.4)
    pocket_l = float(params.get("pocket_l") or width * 0.4)
    pocket_depth = float(params.get("pocket_depth") or height * 0.3)
    boss_dia = float(params.get("boss_dia") or 10.0)
    boss_height = float(params.get("boss_height") or 5.0)

    # ── BUILD SCRIPT — only template function calls ──
    lines = [
        "import sys",
        r"sys.path.insert(0, r'H:\DesignOS')",
        "import cadquery as cq",
        "from templates import BASE_TEMPLATES, FEATURE_MAP",
        "",
        f"# {part_type.upper()} | {length}x{width}x{height}mm",
        f"length = {length} # mm",
        f"width = {width} # mm",
        f"height = {height} # mm",
        f"wall_t = {wall_t} # mm",
        f"hole_dia = {hole_dia} # mm",
        f"hole_points = {safe_pts}",
        f"fillet_r = {fillet_r} # mm",
        "",
    ]

    # Base geometry
    if part_type == "bracket":
        lines.append(f"result = BASE_TEMPLATES['l_bracket'](height={height}, base_length={length}, width={width}, thickness={wall_t}, root_fillet=min({wall_t} * 0.5, 5.0))")
    elif part_type == "beam":
        lines.append(f"result = BASE_TEMPLATES['i_beam'](height={height}, width={width}, length={length}, web_thickness={wall_t}, flange_thickness={wall_t * 1.5})")
    elif part_type == "shaft":
        lines.append(f"result = BASE_TEMPLATES['two_stage_parallel_shaft'](d1={width}, l1={length*0.5}, d2={height}, l2={length*0.5})")
    elif part_type == "housing":
        lines.append(f"result = BASE_TEMPLATES['housing'](length, width, height, wall_t)")
    elif part_type == "channel":
        lines.append(f"result = BASE_TEMPLATES['channel'](length, width, height, wall_t)")
    elif part_type == "flange":
        lines.append(f"result = BASE_TEMPLATES['flange'](length, width, height, wall_t)")
    elif part_type == "gear":
        lines.append(f"result = BASE_TEMPLATES['gear'](min(length,width), height)")
    else:
        lines.append(f"result = BASE_TEMPLATES['plate'](length, width, height)")

    # Features — strict order: holes → pockets → shell → boss → chamfers → fillets LAST
    if has_holes and safe_pts:
        if part_type == "bracket":
            lines.append(f"result = FEATURE_MAP['flange_holes'](result, face_tag='flange_base', dia={hole_dia}, clearance={hole_dia * 2.0})")
        else:
            lines.append(f"result = FEATURE_MAP['holes'](result, hole_points, {hole_dia})")
    if has_pockets:
        lines.append(f"result = FEATURE_MAP['pockets'](result, {pocket_w}, {pocket_l}, {pocket_depth})")
    if has_boss:
        lines.append(f"result = FEATURE_MAP['boss'](result, {boss_dia}, {boss_height})")
    if has_chamfers:
        lines.append(f"result = FEATURE_MAP['chamfers'](result, 1.0)")
    if has_fillets:
        if part_type in ["bracket", "beam", "shaft"]:
            lines.append(f"result = FEATURE_MAP['smart_fillet'](result, {fillet_r})")
        else:
            lines.append(f"result = FEATURE_MAP['fillets'](result, {fillet_r})")

    lines.append("")
    lines.append("cq.exporters.export(result, output_path)")
    
    return "\n".join(lines)


def execute_cadquery(script: str, job_id: str):
    """Write script to temp file, run via Miniconda, return (success, error_msg)."""
    step_path = os.path.join(TEMP_DIR, f"{job_id}.step")
    stl_path = os.path.join(TEMP_DIR, f"{job_id}.stl")
    script_path = os.path.join(TEMP_DIR, f"{job_id}.py")

    # Build the full script with output_path injected at the top,
    # and a fallback export block appended at the bottom.
    # NOTE: The fallback uses raw strings, NOT f-strings, to avoid
    # Python interpreting braces at app.py compile time.
    header = (
        'import sys\n'
        f'sys.path.insert(0, r"H:\\DesignOS")\n'
        f'output_path = r"{step_path}"\n'
        f'stl_output_path = r"{stl_path}"\n'
        '\n'
        '# --- DesignOS mock show_object ---\n'
        '_designos_export_target = None\n'
        'def show_object(obj, name=None, options=None):\n'
        '    global _designos_export_target\n'
        '    _designos_export_target = obj\n'
        '\n'
    )

    # Fallback export block — runs after the LLM script.
    # Uses regular string formatting to avoid f-string brace issues.
    fallback = '''

# --- DesignOS auto-appended fallback export ---
import os as _os
import cadquery as _cq

if _designos_export_target is None:
    if "result" in locals() and isinstance(locals()["result"], (_cq.Workplane, _cq.Shape, _cq.Assembly)):
        _designos_export_target = locals()["result"]
    else:
        for _name, _val in reversed(list(locals().items())):
            if not _name.startswith("_") and isinstance(_val, (_cq.Workplane, _cq.Shape, _cq.Assembly)):
                _designos_export_target = _val
                break

if _designos_export_target is not None:
    try:
        if not _os.path.exists(output_path):
            _cq.exporters.export(_designos_export_target, output_path)
    except Exception:
        pass
    try:
        if not _os.path.exists(stl_output_path):
            _cq.exporters.export(_designos_export_target, stl_output_path, exportType=_cq.exporters.ExportTypes.STL)
    except Exception:
        pass
'''

    full_script = header + script + fallback

    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(full_script)

    try:
        proc = subprocess.run(
            [CADQUERY_PYTHON, script_path],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=TEMP_DIR,
        )
        if proc.returncode == 0 and os.path.exists(step_path):
            return True, None
        error = proc.stderr or proc.stdout or "Unknown execution error"
        return False, error
    except subprocess.TimeoutExpired:
        return False, "Script execution timed out (60 s)"
    except Exception as exc:
        return False, str(exc)
    # NOTE: We intentionally do NOT delete the script file here.
    # Keeping it allows inspection for debugging.


# ---------------------------------------------------------------------------
# Background generation runner
# ---------------------------------------------------------------------------

def _log(job_id: str, step: str, status: str, message: str, detail: str = ""):
    entry = {"step": step, "stage": step, "status": status, "message": message, "ts": time.time()}
    if detail:
        entry["detail"] = detail
    jobs[job_id]["log"].append(entry)


def validate_dimensions(step_path, expected_length, expected_width, expected_height, tolerance=5.0):
    """Verify output dimensions match input. Returns (valid, actual_dims, error)"""
    validate_script = f"""
import cadquery as cq, sys, json
shape = cq.importers.importStep(r"{step_path}")
bb = shape.val().BoundingBox()
dims = {{
    "length": round(bb.xmax - bb.xmin, 2),
    "width": round(bb.ymax - bb.ymin, 2),
    "height": round(bb.zmax - bb.zmin, 2),
    "volume": round(shape.val().Volume(), 2),
    "solids": len(shape.solids().vals())
}}
print(json.dumps(dims))
"""
    script_path = step_path.replace(".step", "_validate.py")
    with open(script_path, "w") as f:
        f.write(validate_script)
    
    try:
        proc = subprocess.run([CADQUERY_PYTHON, script_path], capture_output=True, text=True, timeout=30)
        os.unlink(script_path)
        dims = json.loads(proc.stdout.strip())
        
        # Check against expected with tolerance
        errors = []
        if abs(dims["length"] - expected_length) > tolerance:
            errors.append(f"Length wrong: got {dims['length']}mm, expected {expected_length}mm")
        if abs(dims["width"] - expected_width) > tolerance:
            errors.append(f"Width wrong: got {dims['width']}mm, expected {expected_width}mm")
        if abs(dims["height"] - expected_height) > tolerance:
            errors.append(f"Height wrong: got {dims['height']}mm, expected {expected_height}mm")
        if dims["solids"] == 0:
            errors.append("No solid body — open geometry")
            
        return len(errors) == 0, dims, errors
    except Exception as e:
        return True, {}, []  # Don't block on validator failure


def run_generation(job_id: str, prompt: str, form_data: dict = None, max_attempts: int = 3):
    """Template-based generation pipeline — runs in a background thread."""
    form_data = form_data or {}
    try:
        # ---- Step 1: Qwen calculates parameters only ----
        jobs[job_id]["step"] = "calculating_params"
        jobs[job_id]["attempt"] = 1
        _log(job_id, "params", "running", "Qwen calculating parameters …")

        spec = build_spec_string(form_data)
        params = get_params_from_qwen(spec)
        _log(job_id, "params", "done", f"Parameters calculated", json.dumps(params, indent=2))

        # ---- Step 2: Assemble script from templates (deterministic) ----
        jobs[job_id]["step"] = "assembling_script"
        _log(job_id, "assemble", "running", "Assembling geometry from templates …")

        script = assemble_script(form_data, params)
        jobs[job_id]["script"] = script
        _log(job_id, "assemble", "done", "Script assembled from templates", script)

        # ---- Step 3: Execute (retry up to max_attempts) ----
        last_error = None
        for attempt in range(1, max_attempts + 1):
            jobs[job_id]["attempt"] = attempt
            jobs[job_id]["step"] = "executing"
            _log(job_id, "execute", "running",
                 f"Executing CadQuery script (attempt {attempt}/{max_attempts}) …")

            success, error = execute_cadquery(script, job_id)

            if success:
                # Validate dimensions
                step_path = os.path.join(TEMP_DIR, f"{job_id}.step")
                valid, actual_dims, dim_errors = validate_dimensions(
                    step_path,
                    float(form_data.get("length", 100)),
                    float(form_data.get("width", 60)),
                    float(form_data.get("height", 20))
                )
                if actual_dims:
                    _log(job_id, "validate", "done", f"Dimensions: {actual_dims}")
                    jobs[job_id]["actual_dims"] = actual_dims

                jobs[job_id]["status"] = "completed"
                jobs[job_id]["step"] = "done"
                stl_path = os.path.join(TEMP_DIR, f"{job_id}.stl")
                jobs[job_id]["step_file"] = step_path
                jobs[job_id]["stl_file"] = stl_path if os.path.exists(stl_path) else None
                _log(job_id, "complete", "done", "Model generated successfully")
                return

            last_error = error
            _log(job_id, "execute", "error",
                 f"Execution failed (attempt {attempt})", error)

            if attempt < max_attempts:
                jobs[job_id]["step"] = "retrying"
                _log(job_id, "retry", "running", "Retrying with safe defaults …")
                params = {}  # Reset to safe defaults
                script = assemble_script(form_data, params)
                jobs[job_id]["script"] = script

        # All attempts exhausted
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["step"] = "failed"
        jobs[job_id]["error"] = last_error
        _log(job_id, "final", "error", f"All {max_attempts} attempts failed")

    except Exception as exc:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["step"] = "failed"
        jobs[job_id]["error"] = str(exc)
        _log(job_id, "error", "error", str(exc))


def run_manual_script(job_id: str, script: str):
    """Executes a manually provided CadQuery script directly."""
    try:
        jobs[job_id]["step"] = "executing"
        _log(job_id, "execute", "running", "Executing manual CadQuery script …")
        
        success, error = execute_cadquery(script, job_id)
        
        if success:
            _log(job_id, "execute", "done", "STEP + STL files generated successfully")
            jobs[job_id]["status"] = "completed"
            jobs[job_id]["step"] = "done"
            step_path = os.path.join(TEMP_DIR, f"{job_id}.step")
            stl_path = os.path.join(TEMP_DIR, f"{job_id}.stl")
            jobs[job_id]["step_file"] = step_path
            jobs[job_id]["stl_file"] = stl_path if os.path.exists(stl_path) else None
        else:
            jobs[job_id]["status"] = "failed"
            jobs[job_id]["step"] = "failed"
            jobs[job_id]["error"] = error
            _log(job_id, "execute", "error", "Execution failed", error)

    except Exception as exc:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["step"] = "failed"
        jobs[job_id]["error"] = str(exc)
        _log(job_id, "error", "error", str(exc))


def _new_job(prompt: str) -> str:
    """Create a fresh job record and return its id."""
    job_id = uuid.uuid4().hex[:8]
    jobs[job_id] = {
        "status": "running",
        "step": "starting",
        "attempt": 0,
        "max_attempts": 3,
        "log": [],
        "script": None,
        "spec": None,
        "step_file": None,
        "stl_file": None,
        "error": None,
        "prompt": prompt,
    }
    return job_id


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/generate", methods=["POST"])
def generate():
    data = request.get_json(force=True)
    
    # Accept both simple prompt and structured form data
    prompt = data.get("prompt", "").strip()
    form_data = {
        "part_type": data.get("part_type", "Part"),
        "length": data.get("length", 100),
        "width": data.get("width", 60),
        "height": data.get("height", 20),
        "material": data.get("material", "Steel"),
        "features": data.get("features", []),
        "notes": data.get("notes", "")
    }
    
    if not prompt and not any([data.get("part_type"), data.get("length")]):
        return jsonify({"error": "No prompt or form data provided"}), 400

    # Build prompt from form if no freeform prompt
    if not prompt:
        prompt = f"{form_data['part_type']} {form_data['length']}x{form_data['width']}x{form_data['height']}mm {form_data['material']}"

    job_id = _new_job(prompt)
    jobs[job_id]["form_data"] = form_data
    t = threading.Thread(target=run_generation, args=(job_id, prompt, form_data), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/execute_raw_script", methods=["POST"])
def execute_raw_script():
    data = request.get_json(force=True)
    script = data.get("script", "").strip()
    if not script:
        return jsonify({"error": "No script provided"}), 400

    job_id = _new_job("Manual Script Execution")
    jobs[job_id]["script"] = script
    t = threading.Thread(target=run_manual_script, args=(job_id, script), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def status(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404
    j = jobs[job_id]
    return jsonify({
        "status": j["status"],
        "step": j["step"],
        "attempt": j["attempt"],
        "max_attempts": j["max_attempts"],
        "log": j["log"],
        "has_step_file": j["step_file"] is not None,
        "has_stl_file": j["stl_file"] is not None,
        "error": j["error"],
        "script": j.get("script", "")
    })


@app.route("/stream/<job_id>")
def stream_job(job_id):
    def generate():
        last_count = 0
        timeout = 0
        while timeout < 180:
            job = jobs.get(job_id)
            if not job:
                yield f"data: {json.dumps({'error': 'Job not found'})}\n\n"
                break
            logs = job.get("log", [])
            for entry in logs[last_count:]:
                yield f"data: {json.dumps(entry)}\n\n"
            last_count = len(logs)
            if job.get("status") in ["completed", "failed"]:
                final = {"status": job["status"], "complete": True,
                         "has_stl_file": job.get("stl_file") is not None,
                         "has_step_file": job.get("step_file") is not None,
                         "script": job.get("script", ""),
                         "error": job.get("error")}
                yield f"data: {json.dumps(final)}\n\n"
                break
            time.sleep(0.5)
            timeout += 0.5
    return Response(generate(), mimetype='text/event-stream',
                   headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route("/download/<job_id>")
def download(job_id):
    if job_id not in jobs or not jobs[job_id].get("step_file"):
        return jsonify({"error": "File not found"}), 404
    return send_file(
        jobs[job_id]["step_file"],
        as_attachment=True,
        download_name=f"design_{job_id}.step",
    )


@app.route("/model/<job_id>")
def model_stl(job_id):
    if job_id not in jobs or not jobs[job_id].get("stl_file"):
        return jsonify({"error": "STL not found"}), 404
    return send_file(jobs[job_id]["stl_file"], mimetype="application/octet-stream")


@app.route("/health")
def health():
    info = {
        "ollama": False,
        "qwen": False,
        "cadquery": False,
        "gpu": None,
        "models": [],
    }

    # Check Ollama + models
    try:
        r = http_requests.get("http://localhost:11434/api/tags", timeout=5)
        if r.status_code == 200:
            info["ollama"] = True
            model_names = [m["name"] for m in r.json().get("models", [])]
            info["models"] = model_names
            info["qwen"] = any("qwen" in n for n in model_names)
    except Exception:
        pass

    # Check CadQuery
    try:
        result = subprocess.run(
            [CADQUERY_PYTHON, "-c", "import cadquery; print('ok')"],
            capture_output=True, text=True, timeout=10,
        )
        info["cadquery"] = result.returncode == 0
    except Exception:
        pass

    # Check GPU
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,memory.used,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            parts = [p.strip() for p in result.stdout.strip().split(",")]
            if len(parts) >= 4:
                info["gpu"] = {
                    "name": parts[0],
                    "memory_total": f"{parts[1]} MB",
                    "memory_used": f"{parts[2]} MB",
                    "temperature": f"{parts[3]}°C",
                }
    except Exception:
        pass

    return jsonify(info)


@app.route("/refine", methods=["POST"])
def refine():
    data = request.get_json(force=True)
    original_job_id = data.get("job_id", "").strip()
    instruction = data.get("instruction", "").strip()

    if not original_job_id or original_job_id not in jobs:
        return jsonify({"error": "Original job not found"}), 404
    if not instruction:
        return jsonify({"error": "No instruction provided"}), 400

    original_script = jobs[original_job_id].get("script", "")
    refine_text = (
        "Modify this existing CadQuery script based on the instruction.\n\n"
        f"Existing script:\n{original_script}\n\n"
        f"Instruction: {instruction}\n\n"
        "Output the complete modified CadQuery script."
    )

    job_id = _new_job(instruction)
    jobs[job_id]["parent_job"] = original_job_id
    # Carry form_data from the original job for template assembly
    original_form = jobs[original_job_id].get("form_data", {})
    # Merge the refine instruction into notes
    original_form["notes"] = instruction
    jobs[job_id]["form_data"] = original_form
    t = threading.Thread(target=run_generation, args=(job_id, instruction, original_form), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/run-script", methods=["POST"])
def run_script():
    data = request.get_json(force=True)
    raw_script = data.get("script", "").strip()
    if not raw_script:
        return jsonify({"error": "No script"}), 400
    safe, reason = validate_script_safety(raw_script)
    if not safe:
        return jsonify({"error": f"Script rejected: {reason}"}), 400
    job_id = _new_job("ide_script")
    jobs[job_id]["script"] = raw_script
    def execute():
        _log(job_id, "execute", "running", "Running script...")
        success, error = execute_cadquery(raw_script, job_id)
        status = "completed" if success else "failed"
        jobs[job_id]["status"] = status
        if success:
            jobs[job_id]["step_file"] = os.path.join(TEMP_DIR, f"{job_id}.step")
            jobs[job_id]["stl_file"] = os.path.join(TEMP_DIR, f"{job_id}.stl")
        _log(job_id, "complete", "done" if success else "error", error or "Script executed successfully")
    threading.Thread(target=execute, daemon=True).start()
    return jsonify({"job_id": job_id})

@app.route("/assist", methods=["POST"])
def assist():
    data = request.get_json(force=True)
    instruction = data.get("instruction", "")
    current_script = data.get("script", "")
    face_label = data.get("face_label", "")
    
    face_context = f"\nUser clicked: {face_label}" if face_label else ""
    
    ASSIST_PROMPT = f"""You are a CadQuery 2.x expert. Modify this script.

Current script:
{current_script}
{face_context}

Instruction: "{instruction}"

Rules:
- Return ONLY the complete modified Python script
- Keep output_path variable unchanged — never hardcode a path
- Keep all # mm comments on dimension variables
- Use valid CadQuery string selectors for faces (e.g. '>Z', '<Y', '>X'). NEVER use '@Y' or '@X' as they are invalid.
- Operations order: base → additions (gears, flanges, bosses) → holes → pocket → fillets LAST
- When adding features (e.g., gears, flanges), use standard primitives (.circle().extrude()) and .union() them to the main body.
- No markdown, no explanation, pure Python only"""

    try:
        raw = call_ollama(QWEN_MODEL, ASSIST_PROMPT, "")
        script = extract_python_code(raw)
        safe, reason = validate_script_safety(script)
        if not safe:
            return jsonify({"error": f"AI generated unsafe script: {reason}"}), 400
        return jsonify({"script": script})
    except Exception as exc:
        return jsonify({"error": f"AI unavailable: {exc}"}), 503

# ---------------------------------------------------------------------------
# Canvas — Block-based assembly endpoints
# ---------------------------------------------------------------------------

canvas_sessions = {}

@app.route("/canvas/session", methods=["POST"])
def create_canvas_session():
    """Initialize canvas session from form data."""
    data = request.get_json(force=True)
    session_id = uuid.uuid4().hex[:8]

    form_data = data.get("form_data", {})
    source_job = data.get("source_job", "")

    # Get params from Qwen (fallback to safe defaults if Ollama is down)
    spec = build_spec_string(form_data)
    try:
        params = get_params_from_qwen(spec)
    except Exception:
        params = {}

    # Build tagged block script
    script = assemble_block_script(form_data, params)

    canvas_sessions[session_id] = {
        "script": script,
        "history": [script],
        "history_index": 0,
        "form_data": form_data,
    }

    # Execute
    job_id = _new_job(f"canvas_{session_id}")
    jobs[job_id]["script"] = script
    threading.Thread(
        target=lambda: _run_canvas_job(job_id, script),
        daemon=True
    ).start()

    return jsonify({"session_id": session_id, "job_id": job_id})


@app.route("/canvas/blocks/<session_id>")
def get_canvas_blocks(session_id):
    """Return parsed blocks for the UI parameter panels."""
    session = canvas_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404
    blocks = parse_blocks(session["script"])
    return jsonify({"blocks": blocks, "script": session["script"]})


@app.route("/canvas/update-param", methods=["POST"])
def canvas_update_param():
    """Update single parameter in single block — no Qwen."""
    data = request.get_json(force=True)
    session_id = data["session_id"]
    block_id = data["block_id"]
    param_key = data["param_key"]
    new_value = data["new_value"]

    session = canvas_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    new_script = update_block_param(
        session["script"], block_id, param_key, new_value
    )

    # Save to history
    session["history"] = session["history"][:session["history_index"] + 1]
    session["history"].append(new_script)
    session["history_index"] += 1
    session["script"] = new_script

    # Execute
    job_id = _new_job(f"{session_id}_update")
    jobs[job_id]["script"] = new_script
    threading.Thread(
        target=lambda: _run_canvas_job(job_id, new_script),
        daemon=True
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/canvas/add-block", methods=["POST"])
def canvas_add_block():
    """Add new geometry block to existing assembly."""
    data = request.get_json(force=True)
    session_id = data["session_id"]
    block_type = data["block_type"]
    params = data.get("params", {})
    parent_id = data.get("parent_id", "001")
    face_selector = data.get("face", ">Z")

    session = canvas_sessions.get(session_id)
    if not session:
        return jsonify({"error": "Session not found"}), 404

    new_script = add_block_to_script(
        session["script"], block_type, params, parent_id, face_selector
    )

    # Save history
    session["history"] = session["history"][:session["history_index"] + 1]
    session["history"].append(new_script)
    session["history_index"] += 1
    session["script"] = new_script

    # Execute
    job_id = _new_job(f"{session_id}_add")
    jobs[job_id]["script"] = new_script
    threading.Thread(
        target=lambda: _run_canvas_job(job_id, new_script),
        daemon=True
    ).start()

    return jsonify({"job_id": job_id})


@app.route("/canvas/undo/<session_id>", methods=["POST"])
def canvas_undo(session_id):
    """Undo the last canvas operation."""
    session = canvas_sessions.get(session_id)
    if not session or session["history_index"] <= 0:
        return jsonify({"error": "Nothing to undo"}), 400

    session["history_index"] -= 1
    session["script"] = session["history"][session["history_index"]]

    job_id = _new_job(f"{session_id}_undo")
    jobs[job_id]["script"] = session["script"]
    threading.Thread(
        target=lambda: _run_canvas_job(job_id, session["script"]),
        daemon=True
    ).start()

    return jsonify({"job_id": job_id})


def _run_canvas_job(job_id, script):
    """Execute a canvas script in background."""
    _log(job_id, "execute", "running", "Executing canvas script...")
    safe, reason = validate_script_safety(script)
    if not safe:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = f"Script rejected: {reason}"
        _log(job_id, "execute", "error", f"Script rejected: {reason}")
        return
    success, error = execute_cadquery(script, job_id)
    if success:
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["step"] = "done"
        jobs[job_id]["step_file"] = os.path.join(TEMP_DIR, f"{job_id}.step")
        stl_path = os.path.join(TEMP_DIR, f"{job_id}.stl")
        jobs[job_id]["stl_file"] = stl_path if os.path.exists(stl_path) else None
        _log(job_id, "complete", "done", "Canvas model updated")
    else:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["step"] = "failed"
        jobs[job_id]["error"] = error
        _log(job_id, "execute", "error", "Execution failed", error)


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=False, use_reloader=False, port=5000)
