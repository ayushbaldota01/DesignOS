"""
DesignOS — AI-powered Text-to-CAD backend
Flask server that orchestrates a local Ollama Qwen model and CadQuery
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
OLLAMA_TIMEOUT = 180  # generous timeout for a 7B model on 4GB VRAM

os.makedirs(TEMP_DIR, exist_ok=True)

# In-memory job store  (adequate for single-user local use)
jobs: dict = {}

# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

QWEN_SYSTEM_PROMPT = """\
You are a CadQuery 2.x code generator. Output ONLY valid Python code. No markdown fences, no explanation, no comments except on dimension lines.

TEMPLATE — follow this structure exactly:

import cadquery as cq

# Dimensions
length = 100.0
width = 60.0
height = 20.0
hole_dia = 6.0
fillet_r = 2.0

# Base shape
result = cq.Workplane("XY").box(length, width, height)

# Holes (if needed) — ALWAYS use pushPoints, NEVER loop
hole_points = [(20, 15), (-20, 15), (20, -15), (-20, -15)]
result = result.faces(">Z").workplane().pushPoints(hole_points).hole(hole_dia)

# Fillets (if needed) — ALWAYS last step, keep radius small
result = result.edges().fillet(fillet_r)

# Export — ALWAYS use output_path variable (it is pre-defined)
cq.exporters.export(result, output_path)

ABSOLUTE RULES:
1. The variable `output_path` is ALREADY defined before your code runs. Use it directly.
2. The final solid MUST be called `result`.
3. The last line MUST be: cq.exporters.export(result, output_path)
4. NEVER use assert statements.
5. NEVER use for-loops to create holes — use pushPoints().
6. NEVER use result.cut() — use .hole(), .cutBlind(), or .cutThruAll() instead.
7. NEVER hardcode output filenames like "part.stl" or "bracket.step".
8. NEVER use complex edge selectors like "|Z or <X or >X" — they crash OpenCascade.
9. For fillets: use result.edges().fillet(r) to fillet ALL edges, or result.edges("|Z").fillet(r) for vertical edges only. Keep it simple.
10. NEVER fillet AND chamfer. Pick one or the other.
11. Keep fillet radius <= 30% of the smallest dimension to avoid geometry failure.
12. Output ONLY Python code. No markdown, no ``` fences, no text before or after."""

REFINE_PROMPT = """\
You are a mechanical engineer. Analyze the part request and return ONLY a JSON object:
{
  "part_type": "",
  "function": "",
  "length_mm": 0,
  "width_mm": 0,
  "height_mm": 0,
  "wall_thickness_mm": 0,
  "holes": [{"diameter_mm": 0, "x_mm": 0, "y_mm": 0}],
  "fillet_radius_mm": 0,
  "material": "",
  "notes": ""
}
Return ONLY the JSON. No explanation."""


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


# ---------------------------------------------------------------------------
# Pipeline stages
# ---------------------------------------------------------------------------

def refine_prompt(prompt: str) -> str:
    """Convert natural-language prompt into a structured engineering spec."""
    raw = call_ollama(
        QWEN_MODEL,
        f"Part request: {prompt}",
        REFINE_PROMPT,
    )
    cleaned = raw.strip()
    # Extract from markdown json block if wrapped
    for pattern in (r"```json\s*\n(.*?)```", r"```\s*\n(.*?)```"):
        m = re.search(pattern, cleaned, re.DOTALL)
        if m:
            cleaned = m.group(1).strip()
            break
    return cleaned


def generate_cadquery_script(spec: str) -> str:
    """Ask Qwen to produce a CadQuery Python script."""
    raw = call_ollama(
        QWEN_MODEL,
        f"Generate a CadQuery script for this part:\n{spec}",
        QWEN_SYSTEM_PROMPT,
    )
    script = extract_python_code(raw)
    script = sanitise_script(script)
    return script


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
        f'output_path = r"{step_path}"\n'
        f'stl_output_path = r"{stl_path}"\n'
        '\n'
    )

    # Fallback export block — runs after the LLM script.
    # Uses regular string formatting to avoid f-string brace issues.
    fallback = '''

# --- DesignOS auto-appended fallback export ---
import os as _os
if "result" in dir():
    try:
        if not _os.path.exists(output_path):
            cq.exporters.export(result, output_path)
    except Exception:
        pass
    try:
        if not _os.path.exists(stl_output_path):
            cq.exporters.export(result, stl_output_path, exportType="STL")
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
    entry = {"step": step, "status": status, "message": message, "ts": time.time()}
    if detail:
        entry["detail"] = detail
    jobs[job_id]["log"].append(entry)


def run_generation(job_id: str, prompt: str, max_attempts: int = 3):
    """Full generate pipeline — runs in a background thread."""
    try:
        # Check if this is a refinement job (skip spec generation)
        is_refinement = "parent_job" in jobs[job_id]

        if not is_refinement:
            # ---- Step 0: Refine prompt into engineering spec ----
            jobs[job_id]["step"] = "refining_prompt"
            _log(job_id, "refine_prompt", "running", "Refining prompt to engineering spec …")
            try:
                spec = refine_prompt(prompt)
                jobs[job_id]["spec"] = spec
                _log(job_id, "refine_prompt", "done", "Engineering spec generated", spec)
                generation_prompt = spec
            except Exception as exc:
                _log(job_id, "refine_prompt", "error",
                     f"Refinement failed: {exc}. Using original prompt.")
                generation_prompt = prompt
        else:
            generation_prompt = prompt

        current_prompt = generation_prompt
        last_error = None

        for attempt in range(1, max_attempts + 1):
            jobs[job_id]["attempt"] = attempt

            # ---- Step 1: Generate CadQuery script ----
            jobs[job_id]["step"] = "generating_script"
            _log(job_id, "generate", "running",
                 f"Generating CadQuery script (attempt {attempt}/{max_attempts}) …")

            script = generate_cadquery_script(current_prompt)
            _log(job_id, "generate", "done", "Script generated", script)
            jobs[job_id]["script"] = script

            # ---- Step 2: Execute ----
            jobs[job_id]["step"] = "executing"
            _log(job_id, "execute", "running", "Executing CadQuery script …")

            success, error = execute_cadquery(script, job_id)

            if success:
                _log(job_id, "execute", "done", "STEP + STL files generated successfully")
                jobs[job_id]["status"] = "completed"
                jobs[job_id]["step"] = "done"
                step_path = os.path.join(TEMP_DIR, f"{job_id}.step")
                stl_path = os.path.join(TEMP_DIR, f"{job_id}.stl")
                jobs[job_id]["step_file"] = step_path
                jobs[job_id]["stl_file"] = stl_path if os.path.exists(stl_path) else None
                return

            last_error = error
            _log(job_id, "execute", "error",
                 f"Execution failed (attempt {attempt})", error)

            if attempt < max_attempts:
                jobs[job_id]["step"] = "retrying"
                _log(job_id, "retry", "running", "Feeding error back to Qwen for retry …")
                current_prompt = (
                    f"The previous CadQuery script FAILED with this error:\n"
                    f"{error}\n\n"
                    f"The failing script was:\n{script}\n\n"
                    f"Original specification:\n{generation_prompt}\n\n"
                    f"Write a CORRECTED CadQuery script. Keep it simple. "
                    f"Avoid fillets if they caused the error. "
                    f"Use only basic CadQuery operations."
                )

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
        "Modify this existing CadQuery script based on the instruction.\n\n"
        f"Existing script:\n{original_script}\n\n"
        f"Instruction: {instruction}\n\n"
        "Output the complete modified CadQuery script."
    )

    job_id = _new_job(instruction)
    jobs[job_id]["parent_job"] = original_job_id
    t = threading.Thread(target=run_generation, args=(job_id, refine_text), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, use_reloader=False, port=5000)
