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
    l = validate_bounds(length, 1.0, 5000.0, 100.0)
    w = validate_bounds(width, 1.0, 5000.0, 60.0)
    h = validate_bounds(height, 0.1, 1000.0, 10.0)
    return cq.Workplane("XY").box(l, w, h).faces(">Z").workplane().tag("base_top").end().end()

def make_shaft(diameter, length):
    d = validate_bounds(diameter, 1.0, 2000.0, 20.0)
    l = validate_bounds(length, 1.0, 5000.0, 80.0)
    c = validate_bounds(d * 0.05, 0.5, 5.0, 1.0)
    shaft = cq.Workplane("XY").circle(d / 2).extrude(l)
    try:
        shaft = shaft.edges(">Z or <Z").chamfer(c)
    except Exception:
        pass
    return shaft.faces(">Z").workplane().tag("base_top").end().end()

def make_housing(length, width, height, wall_t):
    l = validate_bounds(length, 10.0, 5000.0, 80.0)
    w = validate_bounds(width, 10.0, 2000.0, 60.0)
    h = validate_bounds(height, 5.0, 2000.0, 40.0)
    t = validate_bounds(wall_t, 1.0, min(l, w, h)*0.4, 3.0)
    
    box = cq.Workplane("XY").box(l, w, h)
    try:
        housed = box.faces(">Z").shell(-t)
        sel = cq.selectors.NearestToPointSelector((0, 0, -h/2 + t))
        return housed.faces(sel).workplane().tag("base_top").end().end()
    except Exception:
        # Fallback if shell fails
        inner = cq.Workplane("XY").box(l - 2*t, w - 2*t, h - t).translate((0, 0, t/2))
        housed = box.cut(inner)
        sel = cq.selectors.NearestToPointSelector((0, 0, -h/2 + t))
        return housed.faces(sel).workplane().tag("base_top").end().end()

def make_channel(length, width, height, wall_t):
    l = validate_bounds(length, 10.0, 5000.0, 100.0)
    w = validate_bounds(width, 10.0, 2000.0, 40.0)
    h = validate_bounds(height, 10.0, 2000.0, 30.0)
    t = validate_bounds(wall_t, 1.0, min(w, h)*0.4, 3.0)
    
    profile = (
        cq.Workplane("YZ")
        .moveTo(w/2, h/2)
        .lineTo(w/2, -h/2)
        .lineTo(-w/2, -h/2)
        .lineTo(-w/2, h/2)
        .lineTo(-w/2 + t, h/2)
        .lineTo(-w/2 + t, -h/2 + t)
        .lineTo(w/2 - t, -h/2 + t)
        .lineTo(w/2 - t, h/2)
        .close()
    )
    result = profile.extrude(l).translate((-l/2, 0, 0))
    sel = cq.selectors.NearestToPointSelector((0, 0, -h/2 + t))
    return result.faces(sel).workplane().tag("base_top").end().end()

def make_flange(length, width, height, wall_t):
    l = validate_bounds(length, 10.0, 2000.0, 60.0)
    w = validate_bounds(width, 10.0, 2000.0, 60.0)
    h = validate_bounds(height, 1.0, 500.0, 8.0)
    t = validate_bounds(wall_t, 1.0, min(l, w)*0.4, 3.0)
    
    bore_d = min(l, w) - 2 * t
    res = cq.Workplane("XY").box(l, w, h).faces(">Z").workplane().hole(bore_d)
    return res.faces(">Z").workplane().tag("base_top").end().end()

def make_gear(diameter, height):
    d = validate_bounds(diameter, 10.0, 2000.0, 50.0)
    h = validate_bounds(height, 2.0, 500.0, 10.0)
    
    bore_d = validate_bounds(d * 0.3, 5.0, 100.0, 15.0)
    res = cq.Workplane("XY").circle(d/2).extrude(h)
    
    res = res.faces(">Z").workplane().hole(bore_d)
    kw_w = bore_d * 0.25
    kw_h = bore_d * 0.15
    res = res.faces(">Z").workplane().rect(kw_w, bore_d + kw_h).cutBlind(-h)
    return res.faces(">Z").workplane().tag("base_top").end().end()


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
    try:
        d = validate_bounds(hole_dia, 0.1, 500.0, 6.6)
        wp = get_working_plane(result)
        if depth:
            dp = validate_bounds(depth, 0.1, 1000.0, 10.0)
            return wp.pushPoints(hole_points).hole(d, dp)
        return wp.pushPoints(hole_points).hole(d)
    except Exception:
        return result

def add_fillets(result, radius, edge_selector="|Z"):
    try:
        r = validate_bounds(radius, 0.1, 50.0, 2.0)
        return result.edges(edge_selector).fillet(r)
    except Exception:
        return result

def add_chamfers(result, size, edge_selector="|Z"):
    try:
        s = validate_bounds(size, 0.1, 50.0, 1.0)
        return result.edges(edge_selector).chamfer(s)
    except Exception:
        return result

def add_pocket(result, pocket_w, pocket_l, depth, x=0, y=0):
    try:
        w = validate_bounds(pocket_w, 0.1, 1000.0, 20.0)
        l = validate_bounds(pocket_l, 0.1, 1000.0, 20.0)
        d = validate_bounds(depth, 0.1, 1000.0, 5.0)
        cx = float(x)
        cy = float(y)
        wp = get_working_plane(result)
        if cx != 0 or cy != 0:
            return wp.center(cx, cy).rect(w, l).cutBlind(-d)
        return wp.rect(w, l).cutBlind(-d)
    except Exception:
        return result

def add_shell(result, wall_t):
    try:
        t = validate_bounds(wall_t, 0.1, 100.0, 2.0)
        return result.faces(">Z").shell(-t)
    except Exception:
        return result

def add_boss(result, diameter, height, x=0, y=0):
    try:
        d = validate_bounds(diameter, 0.1, 1000.0, 15.0)
        h = validate_bounds(height, 0.1, 1000.0, 5.0)
        cx = float(x)
        cy = float(y)
        wp = get_working_plane(result)
        boss = wp.center(cx, cy).circle(d / 2).extrude(h)
        return result.union(boss)
    except Exception:
        return result

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
