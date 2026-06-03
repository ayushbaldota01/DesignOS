"""
DesignOS Block Engine — Tagged block script management.
Parses, modifies, and assembles CadQuery scripts using tagged block comments.
No AI involvement for parameter updates — pure regex string manipulation.
"""
import re
import json
import math

# ---------------------------------------------------------------------------
# Block parsing
# ---------------------------------------------------------------------------

PARAM_SCHEMAS = {
    "bracket":  ["length", "width", "height", "wall_t", "x", "y", "z"],
    "l_bracket":["height", "base_length", "width", "thickness", "root_fillet", "x", "y", "z"],
    "plate":    ["length", "width", "height", "x", "y", "z"],
    "shaft":    ["diameter", "length", "x", "y", "z"],
    "housing":  ["length", "width", "height", "wall_t", "x", "y", "z"],
    "channel":  ["length", "width", "height", "wall_t", "x", "y", "z"],
    "flange":   ["length", "width", "height", "wall_t", "x", "y", "z"],
    "gear":     ["diameter", "height", "x", "y", "z"],
    "i_beam":   ["height", "width", "length", "web_thickness", "flange_thickness", "x", "y", "z"],
    "two_stage_parallel_shaft": ["d1", "l1", "d2", "l2", "x", "y", "z"],
    "holes":    ["hole_points", "hole_dia"],
    "fillets":  ["radius"],
    "chamfers": ["size"],
    "pockets":  ["width", "length", "depth", "x", "y"],
    "boss":     ["diameter", "height", "x", "y"],
    "shell":    ["wall_t"],
    "smart_fillet": ["radius"],
    "flange_holes": ["face_tag", "dia", "clearance"],
}

BLOCK_PATTERN = re.compile(
    r'# \[BLOCK_(\d+)\] type=(\w+) params=(.+?)(?:\s+parent=(\d+))?(?:\s+face=(\S+))?\n'
    r'([^\n]+)',
    re.MULTILINE
)


def parse_blocks(script: str) -> list:
    """Extract all tagged blocks from a script."""
    blocks = []
    for m in BLOCK_PATTERN.finditer(script):
        block = {
            "id": m.group(1),
            "type": m.group(2),
            "params_raw": m.group(3).strip(),
            "parent": m.group(4),
            "face": m.group(5),
            "code_line": m.group(6).strip(),
            "full_match": m.group(0)
        }
        # Parse params into a dict for the UI
        block["params"] = _parse_params(block["type"], block["params_raw"])
        blocks.append(block)
    return blocks


def _parse_params(block_type, params_raw):
    """Convert params_raw string into a named dict based on block type."""
    schema = PARAM_SCHEMAS.get(block_type, [])
    
    # Try JSON first
    try:
        vals = json.loads(params_raw)
        if isinstance(vals, dict):
            return vals
    except (json.JSONDecodeError, ValueError):
        pass
    
    # Fallback: split by comma (top-level only, respecting brackets)
    vals = _split_params(params_raw)
    result = {}
    for i, key in enumerate(schema):
        if i < len(vals):
            result[key] = vals[i]
        else:
            break
    return result


def _split_params(raw):
    """Split params string by top-level commas, respecting brackets."""
    parts = []
    depth = 0
    current = ""
    for ch in raw:
        if ch in "([{":
            depth += 1
            current += ch
        elif ch in ")]}":
            depth -= 1
            current += ch
        elif ch == "," and depth == 0:
            parts.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current.strip())
    return parts


# ---------------------------------------------------------------------------
# Block parameter update (NO AI)
# ---------------------------------------------------------------------------

def _resolve_parent_var(blocks, target_id):
    """Trace up the feature chain to find the actual base variable name."""
    FEATURE_TYPES = {'holes', 'fillets', 'chamfers', 'pockets', 'boss', 'shell', 'smart_fillet', 'flange_holes'}
    current_id = target_id
    while current_id:
        b = next((b for b in blocks if b["id"] == current_id), None)
        if not b:
            return f"b{current_id}"
        if b["type"] in FEATURE_TYPES and b["parent"]:
            current_id = b["parent"]
        else:
            return f"b{current_id}"
    return "b001"

def update_block_param(script: str, block_id: str, param_key: str, new_value: any) -> str:
    """Updates a single parameter inside a tagged block script."""
    blocks = parse_blocks(script)
    target = next((b for b in blocks if b["id"] == block_id), None)
    if not target:
        return script

    # Parse old params, update the key, rebuild
    old_params = target["params"]
    
    # Allow adding x, y, z dynamically for gizmo transforms even if they didn't exist
    if param_key not in old_params and param_key not in ['x', 'y', 'z', 'rot_x', 'rot_y', 'rot_z']:
        return script

    old_params[param_key] = str(new_value)
    
    # Update the raw string based on schema order
    schema = PARAM_SCHEMAS.get(target["type"], [])
    ordered_vals = []
    for k in schema:
        if k in old_params:
            ordered_vals.append(str(old_params[k]))
    
    # If the block type doesn't have a strict schema match, fallback to just values
    if not ordered_vals:
        ordered_vals = [str(v) for v in old_params.values()]
        
    target["params_raw"] = ",".join(ordered_vals)
    
    # Rebuild the code line
    parent_var = _resolve_parent_var(blocks, target["parent"])
    target["code_line"] = _rebuild_code_line(target["type"], old_params, target["parent"], target["id"], parent_var, target.get("face"))
    
    return rebuild_script_from_blocks(blocks)


def _rebuild_params_raw(params):
    """Rebuild params_raw string from dict."""
    return ",".join(str(v) for v in params.values())


def _rebuild_code_line(block_type, params, parent_id, block_id, parent_var="b001", face_selector=">Y"):
    """Rebuild the Python code line from block type and params."""
    
    FEATURE_TYPES = {'holes', 'fillets', 'chamfers', 'pockets', 'boss', 'shell',
                     'smart_fillet', 'flange_holes'}
    
    if block_type in FEATURE_TYPES:
        args = ", ".join(str(v) for v in params.values())
        return f"{parent_var} = FEATURE_MAP['{block_type}']({parent_var}, {args}, face_selector='{face_selector}')"
    else:
        # Separate base params from x, y, z and rotations
        base_args = []
        x, y, z = 0.0, 0.0, 0.0
        rx, ry, rz = 0.0, 0.0, 0.0
        
        for k, v in params.items():
            if k == 'x': x = float(v)
            elif k == 'y': y = float(v)
            elif k == 'z': z = float(v)
            elif k == 'rot_x': rx = float(v)
            elif k == 'rot_y': ry = float(v)
            elif k == 'rot_z': rz = float(v)
            else: base_args.append(str(v))
            
        args_str = ", ".join(base_args)
        code_line = f"b{block_id} = BASE_TEMPLATES['{block_type}']({args_str})"
        
        if rx != 0: code_line += f".rotate((0,0,0), (1,0,0), {rx})"
        if ry != 0: code_line += f".rotate((0,0,0), (0,1,0), {ry})"
        if rz != 0: code_line += f".rotate((0,0,0), (0,0,1), {rz})"
        
        if x != 0 or y != 0 or z != 0:
            code_line += f".translate(({x}, {y}, {z}))"
            
        return code_line


# ---------------------------------------------------------------------------
# Add block to script
# ---------------------------------------------------------------------------

def rebuild_script_from_blocks(blocks: list) -> str:
    """Rebuilds the entire script including the assembly tail from a list of parsed blocks."""
    script_lines = ["import cadquery as cq", "from templates import BASE_TEMPLATES, FEATURE_MAP"]
    
    FEATURE_TYPES = {'holes', 'fillets', 'chamfers', 'pockets', 'boss', 'shell',
                     'smart_fillet', 'flange_holes'}
                     
    for b in blocks:
        tag_parts = [f"# [BLOCK_{b['id']}] type={b['type']} params={b['params_raw']}"]
        if b.get('parent'):
            tag_parts.append(f"parent={b['parent']}")
        if b.get('face'):
            tag_parts.append(f"face={b['face']}")
            
        script_lines.append("")
        script_lines.append(" ".join(tag_parts))
        if b['type'] == 'mate':
            script_lines.append("pass")
        else:
            script_lines.append(b['code_line'])

    script_lines.append("\nresult = cq.Assembly()")
    for b in blocks:
        if b['type'] not in FEATURE_TYPES and b['type'] != "mate":
            script_lines.append(f"result.add(b{b['id']}, name='part_{b['id']}')")
            
    for b in blocks:
        if b['type'] == "mate":
            try:
                parts = b['params_raw'].split(',')
                if len(parts) >= 5:
                    p1, f1, p2, f2, m_t = parts[:5]
                    script_lines.append(f"result = result.constrain('{p1}@faces@{f1}', '{p2}@faces@{f2}', '{m_t}')")
            except Exception:
                pass

    script_lines.append("if isinstance(result, cq.Assembly):")
    script_lines.append("    result.save(output_path)")
    script_lines.append("    result.save(stl_output_path, exportType='STL')")
    script_lines.append("    result.save(glb_output_path)")
    script_lines.append("else:")
    script_lines.append("    cq.exporters.export(result, output_path)")
    script_lines.append("    cq.exporters.export(result, stl_output_path)")
    script_lines.append("    temp_assy = cq.Assembly()")
    script_lines.append("    temp_assy.add(result, name='part_001')")
    script_lines.append("    temp_assy.save(glb_output_path)")
    
    return "\n".join(script_lines) + "\n"

def add_block_to_script(script: str, block_type: str, params: dict,
                        parent_id: str = "001", face_selector: str = ">Y") -> str:
    """Append a new template block to an existing script and regenerate it cleanly."""
    blocks = parse_blocks(script)
    new_id = str(len(blocks) + 1).zfill(3)
    parent_var = _resolve_parent_var(blocks, parent_id)

    FEATURE_TYPES = {'holes', 'fillets', 'chamfers', 'pockets', 'boss', 'shell',
                     'smart_fillet', 'flange_holes'}

    code_line = ""
    params_raw = ""

    if block_type == "mate":
        part1 = params.get('part1')
        face1 = params.get('face1', '>Y')
        part2 = params.get('part2')
        face2 = params.get('face2', '<Y')
        m_type = params.get('type', 'Plane')
        code_line = "pass"
        params_raw = f"{part1},{face1},{part2},{face2},{m_type}"
    elif block_type in FEATURE_TYPES:
        args = ", ".join(str(v) for v in params.values())
        params_raw = ",".join(str(v) for v in params.values())
        code_line = f"{parent_var} = FEATURE_MAP['{block_type}']({parent_var}, {args}, face_selector='{face_selector}')"
    else:
        x = float(params.pop('x', 0.0))
        y = float(params.pop('y', 0.0))
        z = float(params.pop('z', 0.0))
        params['x'] = x
        params['y'] = y
        params['z'] = z
        params_raw = ",".join(str(v) for v in params.values())
        base_args = ", ".join(str(v) for k, v in params.items() if k not in ('x', 'y', 'z'))
        
        code_line = f"b{new_id} = BASE_TEMPLATES['{block_type}']({base_args})"
        if x != 0 or y != 0 or z != 0:
            code_line += f".translate(({x}, {y}, {z}))"

    blocks.append({
        "id": new_id,
        "type": block_type,
        "params_raw": params_raw,
        "parent": parent_id,
        "face": face_selector,
        "code_line": code_line
    })

    return rebuild_script_from_blocks(blocks)


# ---------------------------------------------------------------------------
# Assemble block script from form data
# ---------------------------------------------------------------------------

def assemble_block_script(form_data: dict, params: dict) -> str:
    """Build a tagged-block CadQuery script from form data and Qwen params.
    
    This replaces the old assemble_script() for canvas mode.
    The old flow still works for non-canvas generation.
    """
    part_type = form_data.get("part_type", "plate").lower()
    length = float(form_data.get("length", 100))
    width = float(form_data.get("width", 60))
    height = float(form_data.get("height", 20))
    features = [f.lower() for f in form_data.get("features", [])]

    f_str = " ".join(features)
    has_holes = "hole" in f_str
    has_fillets = "fillet" in f_str
    has_chamfers = "chamfer" in f_str
    has_pockets = "pocket" in f_str
    has_boss = "boss" in f_str

    # Safe parameter defaults
    min_dim = min(length, width, height)
    wall_t = float(params.get("wall_t") or max(2.0, min_dim * 0.1))
    wall_t = min(wall_t, min_dim * 0.15, 5.0)
    wall_t = max(wall_t, 1.5)

    hole_dia = float(params.get("hole_dia") or 6.6)
    hole_dia = min(hole_dia, min_dim * 0.15)
    hole_dia = max(hole_dia, 2.0)

    raw_pts = params.get("hole_points") or []
    safe_pts = []
    margin = hole_dia * 1.5
    for pt in raw_pts:
        try:
            x, y = float(pt[0]), float(pt[1])
            x = max(-(length / 2 - margin), min(length / 2 - margin, x))
            y = max(-(width / 2 - margin), min(width / 2 - margin, y))
            safe_pts.append([round(x, 2), round(y, 2)])
        except:
            continue
    if not safe_pts and has_holes:
        ox = round(length / 2 - hole_dia * 2, 2)
        oy = round(width / 2 - hole_dia * 2, 2)
        safe_pts = [[ox, oy], [-ox, oy], [ox, -oy], [-ox, -oy]]

    fillet_r = float(params.get("fillet_r") or min(2.0, wall_t * 0.35))
    fillet_r = min(fillet_r, min_dim * 0.08)
    pocket_w = float(params.get("pocket_w") or length * 0.4)
    pocket_l = float(params.get("pocket_l") or width * 0.4)
    pocket_depth = float(params.get("pocket_depth") or height * 0.3)
    boss_dia = float(params.get("boss_dia") or 10.0)
    boss_height = float(params.get("boss_height") or 5.0)

    # ── BUILD TAGGED BLOCK SCRIPT ──
    # NOTE: import sys / sys.path.insert is handled by execute_cadquery header
    lines = [
        "import cadquery as cq",
        "from templates import BASE_TEMPLATES, FEATURE_MAP",
        "",
    ]

    block_num = 1

    # ── BLOCK 001: Base geometry ──
    bid = str(block_num).zfill(3)
    if part_type == "bracket":
        p_raw = f"{length},{width},{height},{wall_t}"
        lines.append(f"# [BLOCK_{bid}] type=bracket params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['bracket']({length}, {width}, {height}, {wall_t})")
    elif part_type == "beam":
        p_raw = f"{height},{width},{length},{wall_t},{round(wall_t * 1.5, 2)}"
        lines.append(f"# [BLOCK_{bid}] type=i_beam params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['i_beam']({height}, {width}, {length}, {wall_t}, {round(wall_t * 1.5, 2)})")
    elif part_type == "shaft":
        d1, l1 = width, length * 0.6
        d2, l2 = width * 1.5, length * 0.4
        p_raw = f"{d1},{l1},{d2},{l2}"
        lines.append(f"# [BLOCK_{bid}] type=two_stage_parallel_shaft params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['two_stage_parallel_shaft']({d1}, {l1}, {d2}, {l2})")
    elif part_type == "housing":
        p_raw = f"{length},{width},{height},{wall_t}"
        lines.append(f"# [BLOCK_{bid}] type=housing params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['housing']({length}, {width}, {height}, {wall_t})")
    elif part_type == "channel":
        p_raw = f"{length},{width},{height},{wall_t}"
        lines.append(f"# [BLOCK_{bid}] type=channel params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['channel']({length}, {width}, {height}, {wall_t})")
    elif part_type == "flange":
        p_raw = f"{length},{width},{height},{wall_t}"
        lines.append(f"# [BLOCK_{bid}] type=flange params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['flange']({length}, {width}, {height}, {wall_t})")
    elif part_type == "gear":
        d = min(length, width)
        p_raw = f"{d},{height}"
        lines.append(f"# [BLOCK_{bid}] type=gear params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['gear']({d}, {height})")
    else:
        p_raw = f"{length},{width},{height}"
        lines.append(f"# [BLOCK_{bid}] type=plate params={p_raw}")
        lines.append(f"b{bid} = BASE_TEMPLATES['plate']({length}, {width}, {height})")

    lines.append("")

    # ── Feature blocks ──
    parent = bid

    if has_holes and safe_pts:
        block_num += 1
        bid = str(block_num).zfill(3)
        pts_str = str(safe_pts)
        p_raw = f"{pts_str},{hole_dia}"
        lines.append(f"# [BLOCK_{bid}] type=holes params={p_raw} parent={parent} face=>Z")
        lines.append(f"b{parent} = FEATURE_MAP['holes'](b{parent}, {pts_str}, {hole_dia})")
        lines.append("")

    if has_pockets:
        block_num += 1
        bid = str(block_num).zfill(3)
        p_raw = f"{pocket_w},{pocket_l},{pocket_depth}"
        lines.append(f"# [BLOCK_{bid}] type=pockets params={p_raw} parent={parent} face=>Z")
        lines.append(f"b{parent} = FEATURE_MAP['pockets'](b{parent}, {pocket_w}, {pocket_l}, {pocket_depth})")
        lines.append("")

    if has_boss:
        block_num += 1
        bid = str(block_num).zfill(3)
        p_raw = f"{boss_dia},{boss_height}"
        lines.append(f"# [BLOCK_{bid}] type=boss params={p_raw} parent={parent} face=>Z")
        lines.append(f"b{parent} = FEATURE_MAP['boss'](b{parent}, {boss_dia}, {boss_height})")
        lines.append("")

    if has_chamfers:
        block_num += 1
        bid = str(block_num).zfill(3)
        p_raw = "1.0"
        lines.append(f"# [BLOCK_{bid}] type=chamfers params={p_raw} parent={parent}")
        lines.append(f"b{parent} = FEATURE_MAP['chamfers'](b{parent}, 1.0)")
        lines.append("")

    if has_fillets:
        block_num += 1
        bid = str(block_num).zfill(3)
        p_raw = str(fillet_r)
        ft = "smart_fillet" if part_type in ["bracket", "beam", "shaft"] else "fillets"
        lines.append(f"# [BLOCK_{bid}] type={ft} params={p_raw} parent={parent}")
        lines.append(f"b{parent} = FEATURE_MAP['{ft}'](b{parent}, {fillet_r})")
        lines.append("")

    lines.append(f"result = cq.Assembly()")
    lines.append(f"result.add(b{parent}, name='part_{parent}')")
    lines.append("if isinstance(result, cq.Assembly):")
    lines.append("    result.save(output_path)")
    lines.append("else:")
    lines.append("    cq.exporters.export(result, output_path)")

    return "\n".join(lines)
