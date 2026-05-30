"""
DesignOS Template Library — Pure CadQuery parametric templates.
Each base template returns a CadQuery Workplane. Each feature add-on
takes an existing result + parameters and returns the modified result.
All dimensions in mm.
"""
import math
from typing import Tuple, Optional
import cadquery as cq

# ═══════════════════════════════════════════════════════════════════
# ALGORITHMIC VALIDATION LAYER
# ═══════════════════════════════════════════════════════════════════

def validate_bounds(val: float, min_val: float, max_val: float, fallback: float) -> float:
    """Hard-clamps values. If mathematically impossible, forces safe fallback."""
    try:
        val = float(val)
        if math.isnan(val) or math.isinf(val): return float(fallback)
        return max(min_val, min(val, max_val))
    except (ValueError, TypeError):
        return float(fallback)

def get_safe_bbox(body: cq.Workplane) -> Tuple[float, float, float]:
    """Returns absolute bounding box dimensions (X, Y, Z) safely."""
    bbox = body.val().BoundingBox()
    return (bbox.xlen, bbox.ylen, bbox.zlen)

def core_primitive() -> cq.Workplane:
    """Absolute final fallback marker."""
    return cq.Workplane("XY").box(10, 10, 10).faces(">Z").workplane().tag("ERROR_STATE").end().end()


# ═══════════════════════════════════════════════════════════════════
# BASE GEOMETRY TEMPLATES
# ═══════════════════════════════════════════════════════════════════

def make_bracket(length, width, height, wall_t):
    """Self-validating L-shaped mounting bracket."""
    min_dim = min(length, width, height)
    t = min(wall_t, height * 0.15, width * 0.15, 5.0)
    t = max(t, max(1.5, min_dim * 0.04))
    t = round(t, 2)
    wall_h = height - t

    fillet_r = min(t * 0.8, wall_h * 0.4, (width - t) * 0.4)
    fillet_r = max(fillet_r, 0.0)

    profile = cq.Workplane("YZ")
    
    if fillet_r >= 0.5:
        cy = -width/2 + t + fillet_r
        cz = t/2 + fillet_r
        my = cy - fillet_r * 0.7071067811865475
        mz = cz - fillet_r * 0.7071067811865475
        
        profile = (
            profile
            .moveTo(width/2, -t/2)
            .lineTo(-width/2, -t/2)
            .lineTo(-width/2, height - t/2)
            .lineTo(-width/2 + t, height - t/2)
            .lineTo(-width/2 + t, t/2 + fillet_r)
            .threePointArc((my, mz), (cy, t/2))
            .lineTo(width/2, t/2)
            .close()
        )
    else:
        profile = (
            profile
            .moveTo(width/2, -t/2)
            .lineTo(-width/2, -t/2)
            .lineTo(-width/2, height - t/2)
            .lineTo(-width/2 + t, height - t/2)
            .lineTo(-width/2 + t, t/2)
            .lineTo(width/2, t/2)
            .close()
        )

    result = profile.extrude(length).translate((-length/2, 0, 0))
    base_top_sel = cq.selectors.NearestToPointSelector((0, t/2, t/2))
    result = result.faces(base_top_sel).workplane().tag("base_top").end().end()
    
    return result

def l_bracket(height=100.0, base_length=60.0, width=60.0, thickness=20.0, root_fillet=5.0) -> cq.Workplane:
    """Production Core: Geometry Contract: X-axis aligned L-bracket."""
    h = validate_bounds(height, 20.0, 2000.0, 100.0)
    bl = validate_bounds(base_length, 20.0, 2000.0, 60.0)
    w = validate_bounds(width, 10.0, 2000.0, 60.0)
    t = validate_bounds(thickness, 2.0, min(h, bl) * 0.4, 20.0)
    rf = validate_bounds(root_fillet, 0.0, t * 1.5, 5.0)
    
    profile = cq.Workplane("YZ")
    
    if rf >= 0.5:
        cy = -w/2 + t + rf
        cz = t/2 + rf
        my = cy - rf * 0.7071067811865475
        mz = cz - rf * 0.7071067811865475
        
        profile = (
            profile
            .moveTo(w/2, -t/2)
            .lineTo(-w/2, -t/2)
            .lineTo(-w/2, h - t/2)
            .lineTo(-w/2 + t, h - t/2)
            .lineTo(-w/2 + t, t/2 + rf)
            .threePointArc((my, mz), (cy, t/2))
            .lineTo(w/2, t/2)
            .close()
        )
    else:
        profile = (
            profile
            .moveTo(w/2, -t/2)
            .lineTo(-w/2, -t/2)
            .lineTo(-w/2, h - t/2)
            .lineTo(-w/2 + t, h - t/2)
            .lineTo(-w/2 + t, t/2)
            .lineTo(w/2, t/2)
            .close()
        )
        
    result = profile.extrude(bl).translate((-bl/2, 0, 0))
    base_top_sel = cq.selectors.NearestToPointSelector((0, t/2, t/2))
    # Tag flange_base specifically for flange_holes feature
    result = result.faces(base_top_sel).workplane().tag("flange_base").end().end()
    # Also tag base_top for general compatibility
    result = result.faces(base_top_sel).workplane().tag("base_top").end().end()
    
    return result

def i_beam(height=100.0, width=50.0, length=200.0, web_thickness=5.0, flange_thickness=10.0) -> cq.Workplane:
    """Production Core: I-Beam structural profile."""
    h = validate_bounds(height, 20.0, 2000.0, 100.0)
    w = validate_bounds(width, 10.0, 2000.0, 50.0)
    l = validate_bounds(length, 20.0, 5000.0, 200.0)
    wt = validate_bounds(web_thickness, 1.0, w * 0.8, 5.0)
    ft = validate_bounds(flange_thickness, 1.0, h * 0.4, 10.0)
    
    profile = (
        cq.Workplane("XY")
        .moveTo(-w/2, -h/2)
        .lineTo(w/2, -h/2)
        .lineTo(w/2, -h/2 + ft)
        .lineTo(wt/2, -h/2 + ft)
        .lineTo(wt/2, h/2 - ft)
        .lineTo(w/2, h/2 - ft)
        .lineTo(w/2, h/2)
        .lineTo(-w/2, h/2)
        .lineTo(-w/2, h/2 - ft)
        .lineTo(-wt/2, h/2 - ft)
        .lineTo(-wt/2, -h/2 + ft)
        .lineTo(-w/2, -h/2 + ft)
        .close()
    )
    result = profile.extrude(l)
    return result.faces(">Z").workplane().tag("base_top").end().end()

def two_stage_parallel_shaft(d1=20.0, l1=50.0, d2=30.0, l2=50.0) -> cq.Workplane:
    """Production Core: Concentric 2-stage parallel shaft."""
    d1 = validate_bounds(d1, 2.0, 500.0, 20.0)
    l1 = validate_bounds(l1, 5.0, 1000.0, 50.0)
    d2 = validate_bounds(d2, 2.0, 500.0, 30.0)
    l2 = validate_bounds(l2, 5.0, 1000.0, 50.0)
    
    stage1 = cq.Workplane("XY").circle(d1/2).extrude(l1)
    stage2 = cq.Workplane("XY").workplane(offset=l1).circle(d2/2).extrude(l2)
    
    result = stage1.union(stage2)
    return result.faces(">Z").workplane().tag("base_top").end().end()

def make_plate(length, width, height):
    return cq.Workplane("XY").box(length, width, height).faces(">Z").workplane().tag("base_top").end().end()

def make_shaft(diameter, length):
    return cq.Workplane("XY").circle(diameter / 2).extrude(length).faces(">Z").workplane().tag("base_top").end().end()

def make_housing(length, width, height, wall_t):
    box = cq.Workplane("XY").box(length, width, height)
    housed = box.faces(">Z").shell(-wall_t)
    return housed.faces("<Z[1]").workplane().tag("base_top").end().end()

def make_channel(length, width, height, wall_t):
    outer = cq.Workplane("XY").box(length, width, height)
    inner = (
        cq.Workplane("XY")
        .box(length - 2 * wall_t, width - 2 * wall_t, height - wall_t)
        .translate((0, 0, wall_t / 2))
    )
    chan = outer.cut(inner)
    return chan.faces("<Z[1]").workplane().tag("base_top").end().end()

def make_flange(length, width, height, wall_t):
    return cq.Workplane("XY").box(length, width, height).faces(">Z").workplane().tag("base_top").end().end()

def make_gear(diameter, height):
    return cq.Workplane("XY").circle(diameter / 2).extrude(height).faces(">Z").workplane().tag("base_top").end().end()


BASE_TEMPLATES = {
    "bracket": make_bracket,
    "plate": make_plate,
    "shaft": make_shaft,
    "housing": make_housing,
    "channel": make_channel,
    "flange": make_flange,
    "gear": make_gear,
    "custom": make_plate,
    
    # Production Core Templates
    "l_bracket": l_bracket,
    "i_beam": i_beam,
    "two_stage_parallel_shaft": two_stage_parallel_shaft,
}


# ═══════════════════════════════════════════════════════════════════
# FEATURE ADD-ONS
# ═══════════════════════════════════════════════════════════════════

def get_working_plane(result, fallback_selector=">Z"):
    try:
        return result.workplaneFromTagged("base_top")
    except Exception:
        return result.faces(fallback_selector).workplane()

def add_flange_holes(body, face_tag="flange_base", dia=8.0, clearance=16.0):
    """Production Core: Adds symmetrically clearance-aware holes."""
    try:
        if face_tag:
            target_face = body.workplaneFromTagged(face_tag)
        else:
            target_face = body.faces(">Z").workplane()
            
        bbox = body.val().BoundingBox()
        d = validate_bounds(dia, 1.0, 100.0, 8.0)
        clear = validate_bounds(clearance, d, 500.0, 16.0)
        
        x_dist = bbox.xlen - clear
        y_dist = bbox.ylen - clear
        
        if x_dist < d * 2 or y_dist < d * 2:
            return body
            
        return (target_face
                .workplane(centerOption="CenterOfBoundBox")
                .rect(x_dist, y_dist, forConstruction=True)
                .vertices()
                .hole(d))
    except Exception as e:
        return body

def apply_smart_fillet(body, radius=2.0):
    """Production Core: Robust fillet capable of backing off radius gracefully."""
    try:
        r = validate_bounds(radius, 0.1, 50.0, 2.0)
        return body.edges("|Z").fillet(r)
    except Exception:
        try:
            return body.edges("|Z").fillet(r * 0.5)
        except Exception:
            return body

def add_holes(result, hole_points, hole_dia, depth=None):
    wp = get_working_plane(result)
    if depth:
        return wp.pushPoints(hole_points).hole(hole_dia, depth)
    return wp.pushPoints(hole_points).hole(hole_dia)

def add_fillets(result, radius, edge_selector="|Z"):
    try:
        return result.edges(edge_selector).fillet(radius)
    except Exception:
        return result

def add_chamfers(result, size, edge_selector="|Z"):
    try:
        return result.edges(edge_selector).chamfer(size)
    except Exception:
        return result

def add_pocket(result, pocket_w, pocket_l, depth, x=0, y=0):
    wp = get_working_plane(result)
    if float(x) != 0 or float(y) != 0:
        return wp.center(float(x), float(y)).rect(float(pocket_w), float(pocket_l)).cutBlind(-float(depth))
    return wp.rect(float(pocket_w), float(pocket_l)).cutBlind(-float(depth))

def add_shell(result, wall_t):
    try:
        return result.faces(">Z").shell(-wall_t)
    except Exception:
        return result

def add_boss(result, diameter, height, x=0, y=0):
    wp = get_working_plane(result)
    boss = wp.moveTo(x, y).circle(diameter / 2).extrude(height)
    return result.union(boss)

FEATURE_MAP = {
    "holes": add_holes,
    "fillets": add_fillets,
    "chamfers": add_chamfers,
    "pockets": add_pocket,
    "shell": add_shell,
    "boss": add_boss,
    
    # Production Core Features
    "smart_fillet": apply_smart_fillet,
    "flange_holes": add_flange_holes,
}
