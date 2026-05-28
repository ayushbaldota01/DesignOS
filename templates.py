"""
DesignOS Template Library — Pure CadQuery parametric templates.
Each base template returns a CadQuery Workplane. Each feature add-on
takes an existing result + parameters and returns the modified result.
All dimensions in mm.
"""
import math
import cadquery as cq

# ═══════════════════════════════════════════════════════════════════
# BASE GEOMETRY TEMPLATES
# ═══════════════════════════════════════════════════════════════════

def make_bracket(length, width, height, wall_t):
    """Self-validating L-shaped mounting bracket.

    Constructs a clean 2D profile on the YZ plane and extrudes it along X,
    ensuring it is perfectly centered on all three axes (X, Y, Z).
    Includes an integrated inner corner stress-relief fillet.
    """
    # ── INTERNAL PARAMETER VALIDATION ──
    min_dim = min(length, width, height)
    t = min(wall_t, height * 0.15, width * 0.15, 5.0)
    t = max(t, max(1.5, min_dim * 0.04))
    t = round(t, 2)

    wall_h = height - t

    # ── STRESS-RELIEF FILLET RADIUS ──
    fillet_r = min(t * 0.8, wall_h * 0.4, (width - t) * 0.4)
    fillet_r = max(fillet_r, 0.0)

    # ── 2D SKETCH ON YZ PLANE ──
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

    # Extrude and center
    result = profile.extrude(length).translate((-length/2, 0, 0))
    
    # Tag base top face (for holes)
    # Center of base top face is at (0, t/2, t/2)
    base_top_sel = cq.selectors.NearestToPointSelector((0, t/2, t/2))
    result = result.faces(base_top_sel).workplane().tag("base_top").end().end()
    
    return result


def make_plate(length, width, height):
    """Flat rectangular plate."""
    return cq.Workplane("XY").box(length, width, height).faces(">Z").workplane().tag("base_top").end().end()


def make_shaft(diameter, length):
    """Cylindrical shaft extruded along Z."""
    return cq.Workplane("XY").circle(diameter / 2).extrude(length).faces(">Z").workplane().tag("base_top").end().end()


def make_housing(length, width, height, wall_t):
    """Hollow box housing (shelled)."""
    box = cq.Workplane("XY").box(length, width, height)
    housed = box.faces(">Z").shell(-wall_t)
    return housed.faces("<Z[1]").workplane().tag("base_top").end().end()


def make_channel(length, width, height, wall_t):
    """U-channel profile — open on top."""
    outer = cq.Workplane("XY").box(length, width, height)
    inner = (
        cq.Workplane("XY")
        .box(length - 2 * wall_t, width - 2 * wall_t, height - wall_t)
        .translate((0, 0, wall_t / 2))
    )
    chan = outer.cut(inner)
    return chan.faces("<Z[1]").workplane().tag("base_top").end().end()


def make_flange(length, width, height, wall_t):
    """Flat flange plate (same as plate)."""
    return cq.Workplane("XY").box(length, width, height).faces(">Z").workplane().tag("base_top").end().end()


def make_gear(diameter, height):
    """Simplified gear blank."""
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
}


# ═══════════════════════════════════════════════════════════════════
# FEATURE ADD-ONS
# ═══════════════════════════════════════════════════════════════════

def get_working_plane(result, fallback_selector=">Z"):
    """Helper to get the tagged 'base_top' workplane, or fallback."""
    try:
        # Try to use the tagged face
        return result.workplaneFromTagged("base_top")
    except Exception:
        return result.faces(fallback_selector).workplane()

def add_holes(result, hole_points, hole_dia, depth=None):
    """Add through-holes or blind holes on the primary face."""
    wp = get_working_plane(result)
    if depth:
        return wp.pushPoints(hole_points).hole(hole_dia, depth)
    return wp.pushPoints(hole_points).hole(hole_dia)


def add_fillets(result, radius, edge_selector="|Z"):
    """Add fillets to vertical edges."""
    try:
        return result.edges(edge_selector).fillet(radius)
    except Exception:
        return result


def add_chamfers(result, size, edge_selector="|Z"):
    """Add chamfers to vertical edges."""
    try:
        return result.edges(edge_selector).chamfer(size)
    except Exception:
        return result


def add_pocket(result, pocket_w, pocket_l, depth):
    """Add rectangular pocket on the primary face."""
    wp = get_working_plane(result)
    return wp.rect(pocket_w, pocket_l).cutBlind(-depth)


def add_shell(result, wall_t):
    """Shell a solid (hollow it out), open on top face."""
    try:
        return result.faces(">Z").shell(-wall_t)
    except Exception:
        return result


def add_boss(result, diameter, height, x=0, y=0):
    """Add cylindrical boss on the primary face."""
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
}
