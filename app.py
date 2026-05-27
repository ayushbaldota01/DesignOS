"""
DesignOS — AI-powered Text-to-CAD backend
Flask server that orchestrates Ollama LLMs (Qwen + Gemma3) and CadQuery
to generate parametric CAD models from natural-language descriptions.
"""

import os
import re
import uuid
import json
import time
import threading
import subprocess
from flask import Flask, request, jsonify, send_file, render_template
from flask_cors import CORS
import requests as http_requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

app = Flask(__name__)
CORS(app)

TEMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
CADQUERY_PYTHON = r"H:\Miniconda3\python.exe"
OLLAMA_URL = "http://localhost:11434/api/generate"
QWEN_MODEL = "qwen2.5:7b-instruct"
OLLAMA_TIMEOUT = 120

os.makedirs(TEMP_DIR, exist_ok=True)

# In-memory job store  (adequate for single-user local use)
jobs: dict = {}

# ---------------------------------------------------------------------------
# Ollama helpers
# ---------------------------------------------------------------------------

QWEN_SYSTEM_PROMPT = """You are a senior mechanical design engineer with 15+ years of experience in precision manufacturing, GD&T, and design for manufacturability (DFM). You write CadQuery 2.x Python scripts to produce industry-standard parametric CAD models.

ENGINEERING MINDSET:
- Every dimension has a reason. Think about load paths, stress concentrations, and manufacturability before writing a single line.
- Fillets exist to reduce stress concentration, not decoration. R >= 1.5mm minimum for steel parts.
- Holes near edges fail. Minimum edge-to-hole clearance = hole_diameter.
- Thin walls crack. Minimum wall thickness: 3mm steel, 5mm aluminium, 2mm for 3D print.
- Design for the machine that will make it: drills make round holes, mills make flat pockets.

BEFORE GENERATING, THINK:
1. What are the primary load directions on this part?
2. Where will stress concentrate? Add fillets there.
3. Is every feature manufacturable? No undercuts unless specified.
4. Are tolerances realistic? Standard machining = ±0.1mm.
5. Does the assembly make sense? Will it fit with mating parts?

CODE RULES:
- Always name dimensions as variables with units in comments.
- Final shape: result
- Last line: cq.exporters.export(result, output_path)
- No markdown, no explanation, pure Python only.
- Operations order: base geometry → pockets/cuts/slots → holes → fillets/chamfers LAST.

CADQUERY SYNTAX RULES:
1. Creating Holes:
   - To make holes, ALWAYS use: result.faces(">Z").workplane().pushPoints(points_list).hole(diameter)
   - NEVER loop to make multiple holes one by one.
   - NEVER use result.cut() for simple holes.
2. Creating Pockets/Cuts:
   - Use result.faces(">Z").workplane().rect(w, h).cutBlind(-depth) or .cutThruAll()
   - NEVER use result.cut() with a 2D profile. result.cut() is ONLY for subtracting one 3D Solid from another.
3. Fillets and Chamfers:
   - Fillets and Chamfers MUST be applied as the absolute last step.
   - NEVER fillet and chamfer the same edge. If an edge is filleted, it cannot be chamfered.
   - Keep selectors simple. Use basic selectors like ">Z", "<Z", "|Z", ">Y", or select all edges via result.edges().fillet(r).
   - NEVER use complex boolean selector strings like "|Z or <X or >X" as they cause OpenCascade crashes.
   - Make sure fillet/chamfer radius is smaller than the adjacent wall thickness to avoid geometry collapse.

DIMENSION VARIABLES (always):
length, width, height = 50.0, 30.0, 10.0  # mm
hole_dia = 6.0      # M6 clearance hole
fillet_r = 2.0      # stress relief fillet
wall_t = 5.0        # minimum wall thickness

COMMON PATTERNS (use exactly):
# Multiple holes — always this pattern:
hole_points = [(15, 15), (85, 15), (15, 45), (85, 45)]
result = result.faces(">Z").workplane().pushPoints(hole_points).hole(hole_dia)

# Rectangular pocket — always this pattern:
result = result.faces(">Z").workplane().rect(20.0, 15.0).cutBlind(-5.0)

FORBIDDEN PATTERNS:
NEVER DO THESE — they cause execution failure:
- Never use assert statements.
- Never use result.cut() for holes or pockets.
- Never hardcode file paths — always use the variable: output_path
- Never use chamfereach() or filleteach() — use .chamfer(size) or .fillet(radius)
- Never loop to create holes — use pushPoints() for multiple holes.
- Never add comments after code lines on same line for complex expressions.

QUALITY CHECKS BEFORE FINAL LINE:
- No fillet radius larger than adjacent wall thickness.
- No hole closer to edge than its diameter.
- No feature smaller than 1.5mm (unmachineable).
- Verify part has correct orientation: XY = base plane, Z = build direction."""

REFINE_PROMPT = """You are a mechanical engineer reviewing a part request before modeling.

Analyze the request and return ONLY a JSON engineering spec:
{
  "part_type": "",
  "function": "what does this part do and what loads does it carry",
  "length_mm": 0,
  "width_mm": 0,
  "height_mm": 0,
  "wall_thickness_mm": 0,
  "holes": [{"purpose": "", "diameter_mm": 0, "x_offset_mm": 0, "y_offset_mm": 0}],
  "fillets_mm": 0,
  "chamfers_mm": 0,
  "material": "",
  "manufacturing_process": "machined/3d_printed/cast",
  "critical_dimensions": "which dimensions cannot be compromised",
  "dfm_notes": "any manufacturability concerns"
}

Think like an engineer, not a programmer. What is this part FOR?"""

QWEN_VALIDATOR_PROMPT = """\
You are a CadQuery Python syntax checker. Review the provided CadQuery script for:
1. Syntax errors
2. Undefined variables
3. Wrong CadQuery API calls
Return ONLY the corrected script. If no errors, return the original unchanged.
No explanation, no markdown.
"""


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
                    "temperature": 0.1,  # lower = faster, more deterministic
                    "num_predict": 500   # limit token output length
                }
            },
            timeout=OLLAMA_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()["response"]
    except Exception as exc:
        raise RuntimeError(f"Ollama call failed ({model}): {exc}") from exc


def extract_python_code(text: str) -> str:
    """Strip markdown fences if the model wrapped its output."""
    for pattern in (r"```python\s*\n(.*?)```", r"```\s*\n(.*?)```"):
        m = re.search(pattern, text, re.DOTALL)
        if m:
            return m.group(1).strip()
    return text.strip()


# ---------------------------------------------------------------------------
# Pipeline stages
# ---------------------------------------------------------------------------
def refine_prompt(prompt: str) -> str:
    raw = call_ollama(
        QWEN_MODEL,
        f"Description: {prompt}",
        REFINE_PROMPT,
    )
    cleaned = raw.strip()
    # If the model wrapped in markdown json block, extract it
    for pattern in (r"```json\s*\n(.*?)```", r"```\s*\n(.*?)```"):
        m = re.search(pattern, cleaned, re.DOTALL)
        if m:
            cleaned = m.group(1).strip()
            break
    return cleaned


def generate_cadquery_script(spec: str) -> str:
    raw = call_ollama(
        QWEN_MODEL,
        f"Generate a CadQuery script for this specification:\n{spec}",
        QWEN_SYSTEM_PROMPT,
    )
    return extract_python_code(raw)


def validate_script(script: str) -> str:
    raw = call_ollama(
        QWEN_MODEL,
        f"Review and fix this CadQuery script:\n{script}",
        QWEN_VALIDATOR_PROMPT,
    )
    return extract_python_code(raw)


def execute_cadquery(script: str, job_id: str):
    """Write script to temp file, run via Miniconda, return (success, error)."""
    step_path = os.path.join(TEMP_DIR, f"{job_id}.step")
    stl_path = os.path.join(TEMP_DIR, f"{job_id}.stl")
    script_path = os.path.join(TEMP_DIR, f"{job_id}.py")

    # Inject output paths and append standard exports to guarantee they exist
    full_script = (
        f'output_path = r"{step_path}"\n'
        f'stl_output_path = r"{stl_path}"\n\n'
        f"{script}\n\n"
        "# --- auto-appended exports to guarantee file generation ---\n"
        "if 'result' in locals() or 'result' in globals():\n"
        "    try:\n"
        "        import os\n"
        "        if not os.path.exists(output_path):\n"
        "            cq.exporters.export(result, output_path)\n"
        "    except Exception as e:\n"
        "        print(f'STEP export failed: {e}')\n"
        "    try:\n"
        "        if not os.path.exists(stl_output_path):\n"
        "            cq.exporters.export(result, stl_output_path, exportType='STL')\n"
        "    except Exception as e:\n"
        "        print(f'STL export failed: {e}')\n"
    )

    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(full_script)

    try:
        result = subprocess.run(
            [CADQUERY_PYTHON, script_path],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=TEMP_DIR,
        )
        if result.returncode == 0 and os.path.exists(step_path):
            return True, None
        error = result.stderr or result.stdout or "Unknown execution error"
        return False, error
    except subprocess.TimeoutExpired:
        return False, "Script execution timed out (60 s)"
    except Exception as exc:
        return False, str(exc)
    finally:
        # Clean up the script file (keep STEP/STL)
        if os.path.exists(script_path):
            os.remove(script_path)


# ---------------------------------------------------------------------------
# Background generation runner
# ---------------------------------------------------------------------------

def _log(job_id: str, step: str, status: str, message: str, detail: str = ""):
    entry = {"step": step, "status": status, "message": message, "ts": time.time()}
    if detail:
        entry["detail"] = detail
    jobs[job_id]["log"].append(entry)


def run_generation(job_id: str, prompt: str, max_attempts: int = 3):
    """Full generate pipeline — runs in a background thread."""
    try:
        original_prompt = prompt

        # Check if this is a refinement job
        is_refinement = "parent_job" in jobs[job_id]

        if not is_refinement:
            # ---- Step 0: Refinement step before CadQuery generation ----
            jobs[job_id]["step"] = "refining_prompt"
            _log(job_id, "refine_prompt", "running", "Refining prompt to engineering spec …")
            try:
                spec = refine_prompt(prompt)
                jobs[job_id]["spec"] = spec
                _log(job_id, "refine_prompt", "done", "Engineering spec generated", spec)
                generation_prompt = spec
            except Exception as exc:
                _log(job_id, "refine_prompt", "error", f"Refinement failed: {exc}. Falling back to original prompt.")
                generation_prompt = prompt
        else:
            generation_prompt = prompt

        current_prompt = generation_prompt

        for attempt in range(1, max_attempts + 1):
            jobs[job_id]["attempt"] = attempt

            # ---- Step 1: Generate CadQuery script ----
            jobs[job_id]["step"] = "generating_script"
            _log(job_id, "generate", "running",
                 f"Generating CadQuery script (attempt {attempt}/{max_attempts}) …")

            script = generate_cadquery_script(current_prompt)
            _log(job_id, "generate", "done", "Script generated by Qwen", script)
            jobs[job_id]["script"] = script

            # (Validation step removed to speed up generation)

            # ---- Step 4: Execute ----
            jobs[job_id]["step"] = "executing"
            _log(job_id, "execute", "running", "Executing CadQuery script …")

            success, error = execute_cadquery(script, job_id)

            if success:
                _log(job_id, "execute", "done", "STEP file generated successfully")
                jobs[job_id]["status"] = "completed"
                jobs[job_id]["step"] = "done"
                step_path = os.path.join(TEMP_DIR, f"{job_id}.step")
                stl_path = os.path.join(TEMP_DIR, f"{job_id}.stl")
                jobs[job_id]["step_file"] = step_path
                jobs[job_id]["stl_file"] = stl_path if os.path.exists(stl_path) else None
                return

            _log(job_id, "execute", "error",
                 f"Execution failed (attempt {attempt})", error)

            if attempt < max_attempts:
                jobs[job_id]["step"] = "retrying"
                _log(job_id, "retry", "running", "Feeding error back to Qwen for retry …")
                current_prompt = (
                    f"Previous attempt failed with error:\n{error}\n\n"
                    f"Original request / Specification:\n{generation_prompt}\n\n"
                    f"Faulty script:\n{script}\n\n"
                    "Fix the CadQuery script."
                )

        # All attempts exhausted
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["step"] = "failed"
        jobs[job_id]["error"] = error
        _log(job_id, "final", "error", f"All {max_attempts} attempts failed")

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
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "No prompt provided"}), 400

    job_id = _new_job(prompt)
    t = threading.Thread(target=run_generation, args=(job_id, prompt), daemon=True)
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
    })


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
        "Modify this existing CadQuery script based on the new instruction.\n\n"
        f"Existing script:\n{original_script}\n\n"
        f"New instruction: {instruction}\n\n"
        "Generate the complete modified CadQuery script."
    )

    job_id = _new_job(instruction)
    jobs[job_id]["parent_job"] = original_job_id
    t = threading.Thread(target=run_generation, args=(job_id, refine_text), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)
