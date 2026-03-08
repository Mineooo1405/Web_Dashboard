"""
Pure kinematics functions for robot arm.
No matplotlib — safe to import from the FastAPI server.
Mirrors workspace_visualizer.py logic (single source: config.py).
"""

import numpy as np
from config import d1, a2, a3, d5, SERVO_MAPPING_CONFIG, PICK_PLACE_CONFIG

# ── Robot parameters ─────────────────────────────────────────
ARM_D1 = float(d1)   # base height (mm)
ARM_A2 = float(a2)   # link 1 length (mm)
ARM_A3 = float(a3)   # link 2 length (mm)
ARM_D5 = float(d5)   # tool / gripper length (mm)

# ── Servo mapping ─────────────────────────────────────────────
_SERVO_CONFIG = [
    {"offset": SERVO_MAPPING_CONFIG[f"j{i}"]["offset"],
     "dir":    SERVO_MAPPING_CONFIG[f"j{i}"]["dir"]}
    for i in range(6)
]

# ── Gravity gains ─────────────────────────────────────────────
GRAVITY_GAINS = {1: 5.0, 2: 3.0, 3: 2.0}


# ═════════════════════════════════════════════════════════════
# Servo ↔ Math conversion helpers
# ═════════════════════════════════════════════════════════════
def map_math_to_servo(joint_idx: int, math_angle: float) -> float:
    if joint_idx < 0 or joint_idx > 5:
        return 90.0
    cfg = _SERVO_CONFIG[joint_idx]
    return float(np.clip(cfg["offset"] + math_angle * cfg["dir"], 0.0, 180.0))


def unmap_servo_to_math(joint_idx: int, servo_angle: float) -> float:
    if joint_idx < 0 or joint_idx > 5:
        return 0.0
    cfg = _SERVO_CONFIG[joint_idx]
    return (servo_angle - cfg["offset"]) / cfg["dir"]


# ═════════════════════════════════════════════════════════════
# Gravity compensation
# ═════════════════════════════════════════════════════════════
def apply_gravity_compensation(ch: int, angle: float) -> float:
    gain = GRAVITY_GAINS.get(ch, 0.0)
    if gain == 0.0:
        return angle
    compensation = gain * np.cos(np.radians(angle))
    return float(np.clip(angle + compensation, 0.0, 180.0))


# ═════════════════════════════════════════════════════════════
# Inclinometer reading helper
# ═════════════════════════════════════════════════════════════
def convert_to_inclinometer(geo_angle_deg: float) -> float:
    """Convert geometric link angle to inclinometer reading (-90…+90)."""
    angle = geo_angle_deg % 360
    if angle > 180:
        angle -= 360
    if angle > 90:
        angle = 180 - angle
    elif angle < -90:
        angle = -180 - angle
    return float(angle)


# ═════════════════════════════════════════════════════════════
# Forward Kinematics
# ═════════════════════════════════════════════════════════════
def forward_kinematics(j0_servo: float, j1_servo: float,
                       j2_servo: float, j3_servo: float):
    """
    Returns (result_dict, points_rz).

    result_dict keys: x, y, z, phi, r, link_angles
    points_rz: list of [r, z] for joints [base_bottom, base_top, elbow, wrist, tcp]
    """
    theta0_deg = unmap_servo_to_math(0, j0_servo)
    theta0_rad = np.radians(theta0_deg)

    m1 = unmap_servo_to_math(1, j1_servo)
    m2 = unmap_servo_to_math(2, j2_servo)
    m3 = unmap_servo_to_math(3, j3_servo)

    t1, t2, t3 = np.radians(m1), np.radians(m2), np.radians(m3)

    angle_1_plot = t1 + np.pi / 2.0
    p1_r = ARM_A2 * np.cos(angle_1_plot)
    p1_z = ARM_D1 + ARM_A2 * np.sin(angle_1_plot)

    angle_2_plot = angle_1_plot - t2
    p2_r = p1_r + ARM_A3 * np.cos(angle_2_plot)
    p2_z = p1_z + ARM_A3 * np.sin(angle_2_plot)

    angle_3_plot = angle_2_plot - t3
    p3_r = p2_r + ARM_D5 * np.cos(angle_3_plot)
    p3_z = p2_z + ARM_D5 * np.sin(angle_3_plot)

    x = p3_r * np.cos(theta0_rad)
    y = p3_r * np.sin(theta0_rad)
    phi = float(np.degrees(angle_3_plot))

    points_rz = [
        [0.0,        0.0],
        [0.0,        float(ARM_D1)],
        [float(p1_r), float(p1_z)],
        [float(p2_r), float(p2_z)],
        [float(p3_r), float(p3_z)],
    ]

    link_angles = {
        "link1_geo": float(np.degrees(angle_1_plot)),
        "link2_geo": float(np.degrees(angle_2_plot)),
        "link3_geo": float(np.degrees(angle_3_plot)),
    }

    return {
        "x": float(x), "y": float(y), "z": float(p3_z),
        "phi": phi, "r": float(p3_r),
        "link_angles": link_angles,
    }, points_rz


# ═════════════════════════════════════════════════════════════
# Inverse Kinematics (exact, 2-D in R-Z plane)
# ═════════════════════════════════════════════════════════════
def inverse_kinematics_exact(target_r: float, target_z: float, target_phi: float):
    phi_rad = np.radians(target_phi)
    wrist_r = target_r - ARM_D5 * np.cos(phi_rad)
    wrist_z = target_z - ARM_D5 * np.sin(phi_rad)

    r_rel = wrist_r
    z_rel = wrist_z - ARM_D1
    dist_sq = r_rel ** 2 + z_rel ** 2
    dist = np.sqrt(dist_sq)
    max_reach = ARM_A2 + ARM_A3
    min_reach = abs(ARM_A2 - ARM_A3)

    debug = {
        "wrist_r":   float(wrist_r),
        "wrist_z":   float(wrist_z),
        "dist":      float(dist),
        "max_reach": float(max_reach),
        "min_reach": float(min_reach),
    }

    if dist > max_reach:
        debug["fail_reason"] = f"OUT OF REACH: dist={dist:.1f} > max={max_reach:.1f}"
        return False, None, debug
    if dist < min_reach:
        debug["fail_reason"] = f"TOO CLOSE: dist={dist:.1f} < min={min_reach:.1f}"
        return False, None, debug

    cos_q2 = (dist_sq - ARM_A2 ** 2 - ARM_A3 ** 2) / (2 * ARM_A2 * ARM_A3)
    cos_q2 = float(np.clip(cos_q2, -1.0, 1.0))
    q2_rad = np.arccos(cos_q2)

    alpha = np.arctan2(z_rel, r_rel)
    beta  = np.arctan2(ARM_A3 * np.sin(q2_rad), ARM_A2 + ARM_A3 * np.cos(q2_rad))
    q1_polar = alpha + beta

    math_q1 = float(np.degrees(q1_polar)) - 90.0
    math_q2 = float(np.degrees(q2_rad))
    math_q3 = (math_q1 + 90.0) - math_q2 - target_phi

    sv1 = map_math_to_servo(1, math_q1)
    sv2 = map_math_to_servo(2, math_q2)
    sv3 = map_math_to_servo(3, math_q3)

    debug.update({"math_q1": math_q1, "math_q2": math_q2, "math_q3": math_q3})

    if not (0 <= sv1 <= 180 and 0 <= sv2 <= 180 and 0 <= sv3 <= 180):
        debug["fail_reason"] = (
            f"SERVO LIMITS: J1={sv1:.1f}, J2={sv2:.1f}, J3={sv3:.1f}"
        )
        return False, None, debug

    return True, {"j1": sv1, "j2": sv2, "j3": sv3}, debug


# ═════════════════════════════════════════════════════════════
# Inverse Kinematics (full 3-D with FK verification)
# ═════════════════════════════════════════════════════════════
def inverse_kinematics_full(x: float, y: float, z: float, phi_deg: float):
    theta0_rad = np.arctan2(y, x)
    theta0_deg = float(np.degrees(theta0_rad))

    debug = {"theta0_deg": theta0_deg, "x": x, "y": y, "z": z, "phi": phi_deg}

    if theta0_deg < 0.0 or theta0_deg > 180.0:
        debug["fail_reason"] = f"J0 OUT OF RANGE: {theta0_deg:.1f} deg"
        return False, None, debug

    sv0 = map_math_to_servo(0, theta0_deg)
    r   = float(np.sqrt(x ** 2 + y ** 2))
    debug["r"] = r

    success, angles, ik_debug = inverse_kinematics_exact(r, z, phi_deg)
    debug.update(ik_debug)

    if not success:
        return False, None, debug

    angles["j0"] = sv0

    # FK verification
    fk_result, _ = forward_kinematics(sv0, angles["j1"], angles["j2"], angles["j3"])
    ax, ay, az  = fk_result["x"], fk_result["y"], fk_result["z"]
    a_phi       = fk_result["phi"]

    pos_error = float(np.sqrt((ax - x) ** 2 + (ay - y) ** 2 + (az - z) ** 2))
    phi_error = abs(a_phi - phi_deg)

    debug["fk_verify"] = {
        "actual_x": ax, "actual_y": ay, "actual_z": az,
        "actual_phi": a_phi, "pos_error": pos_error, "phi_error": phi_error,
    }

    if pos_error > 1.0:
        debug["fail_reason"] = (
            f"POSITION MISMATCH: error={pos_error:.1f}mm "
            f"(target ({x:.1f},{y:.1f},{z:.1f}) vs actual ({ax:.1f},{ay:.1f},{az:.1f}))"
        )
        return False, None, debug
    if phi_error > 1.0:
        debug["fail_reason"] = (
            f"PHI MISMATCH: target={phi_deg:.1f}° vs actual={a_phi:.1f}° "
            f"(error={phi_error:.1f}°)"
        )
        return False, None, debug

    return True, angles, debug
