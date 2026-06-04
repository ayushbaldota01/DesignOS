"""
DesignOS Assembly Engine
Positions and combines multiple parts into a single STEP assembly.
Uses CadQuery Assemblies for true multi-component export.
"""
import sys

# Helper for locating axis vectors
AXES = {
    'X': (1,0,0),
    'Y': (0,1,0),
    'Z': (0,0,1)
}

# Distinct colors for assembly parts
COLORS = [
    (0.2, 0.4, 0.8), # Blue
    (0.8, 0.3, 0.2), # Red
    (0.2, 0.8, 0.3), # Green
    (0.8, 0.8, 0.2), # Yellow
    (0.6, 0.2, 0.8), # Purple
    (0.9, 0.5, 0.1), # Orange
]

def assemble_parts(parts_list):
    """
    parts_list: [
        {"template": "crankshaft", "params": {...}, "position": {"x":0,"y":0,"z":0}, "rotation": {"axis":"Z","angle":0}},
        ...
    ]
    Returns a cq.Assembly object.
    """
    import cadquery as cq
    sys.path.insert(0, r'H:\DesignOS')
    from templates import BASE_TEMPLATES
    
    assembly = cq.Assembly()
    
    for i, part_def in enumerate(parts_list):
        template_name = part_def.get("template")
        params = part_def.get("params", {})
        pos = part_def.get("position", {"x":0,"y":0,"z":0})
        rot = part_def.get("rotation", {"axis":"Z","angle":0})
        
        if template_name not in BASE_TEMPLATES:
            continue
            
        # Generate part
        fn = BASE_TEMPLATES[template_name]
        try:
            body = fn(**{k:float(v) for k,v in params.items() if k in fn.__code__.co_varnames})
        except Exception:
            body = fn()
            
        # Create Location object for positioning
        vec = cq.Vector(float(pos.get("x",0)), float(pos.get("y",0)), float(pos.get("z",0)))
        axis_name = str(rot.get("axis", "Z")).upper()
        ax_vec = cq.Vector(*AXES.get(axis_name, (0,0,1)))
        angle = float(rot.get("angle", 0))
        
        loc = cq.Location(vec, ax_vec, angle)
        
        # Add to assembly
        part_name = f"{template_name}_{i+1}"
        color = cq.Color(*COLORS[i % len(COLORS)])
        
        assembly.add(body, name=part_name, loc=loc, color=color)
        
    return assembly

def generate_assembly_script(parts_list):
    """
    Generate a CadQuery script for the assembly.
    Used in Script Editor tab for inspection/editing.
    """
    lines = [
        "import cadquery as cq",
        "import sys",
        "sys.path.insert(0, r'H:\\DesignOS')",
        "from templates import BASE_TEMPLATES",
        "",
        "result = cq.Assembly()",
        ""
    ]
    
    colors_list = [
        "cq.Color(0.2, 0.4, 0.8)",
        "cq.Color(0.8, 0.3, 0.2)",
        "cq.Color(0.2, 0.8, 0.3)",
        "cq.Color(0.8, 0.8, 0.2)",
        "cq.Color(0.6, 0.2, 0.8)",
        "cq.Color(0.9, 0.5, 0.1)"
    ]
    
    for i, p in enumerate(parts_list):
        t = p.get("template","plate")
        params = p.get("params", {})
        pos = p.get("position", {"x":0,"y":0,"z":0})
        rot = p.get("rotation", {"axis":"Z","angle":0})
        
        param_str = ", ".join(f"{k}={v}" for k,v in params.items())
        lines.append(f"# Part {i+1}: {t}")
        lines.append(f"part_{i+1} = BASE_TEMPLATES['{t}']({param_str})")
        
        vec_str = f"cq.Vector({pos.get('x',0)}, {pos.get('y',0)}, {pos.get('z',0)})"
        axis_name = str(rot.get('axis','Z')).upper()
        if axis_name == 'X': ax_str = "cq.Vector(1,0,0)"
        elif axis_name == 'Y': ax_str = "cq.Vector(0,1,0)"
        else: ax_str = "cq.Vector(0,0,1)"
        
        loc_str = f"cq.Location({vec_str}, {ax_str}, {rot.get('angle',0)})"
        color_str = colors_list[i % len(colors_list)]
        
        lines.append(f"result.add(part_{i+1}, name='{t}_{i+1}', loc={loc_str}, color={color_str})")
        lines.append("")
        
    return "\n".join(lines)



