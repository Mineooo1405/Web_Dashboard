"""
Transport Manager Module (Phase 2)

Handles all Phase 2 (Transport) operations:
- Setting destination position
- Computing transport trajectories for centroid movement
- Starting/aborting transport phase
- Handling transport completion notifications
"""

import time
import json
import math
import numpy as np
from scipy import interpolate

from .path_planner import PathPlanner


class TransportManager:
    """
    Manages Phase 2 (Transport) operations.
    
    Robots transport the object from current position to destination.
    Uses Virtual Structure control where each robot follows a centroid trajectory
    with formation offsets.
    """
    
    def __init__(self, server):
        """
        Initialize the Transport Manager.
        
        Args:
            server: Reference to main Server instance for accessing shared state
        """
        self.server = server
        
        # Transport phase state (moved from Server)
        self.transport_phase_active = False
        self.destination_position = None  # (x, y) target position for object center
        self.transport_trajectories = {}  # {robot_id: centroid_trajectory}
        self.transport_arrived_status = {}  # {robot_id: bool}
    
    def set_destination_position(self, x, y):
        """
        Set the destination position for object transport.
        
        Args:
            x, y: Destination center position in meters (object center = centroid)
        """
        self.destination_position = (float(x), float(y))
        self.server.gui.update_monitor(
            f"Destination set: ({x:.2f}, {y:.2f})"
        )
        
        # Update visualization
        self.server.visualizer.set_destination_position(x, y)
    
    def compute_transport_trajectories(self):
        """
        Compute transport trajectory from current object position to destination.
        
        The trajectory is for the CENTROID (object center). Each robot receives
        the same centroid trajectory plus their formation offset for Virtual
        Structure control on Xavier.
        
        Uses effective radius = grip_radius + robot_radius + max(object_length, object_width)/2
        to ensure the entire formation clears obstacles.
        
        Returns:
            list: Centroid trajectory [{x, y, theta, t}, ...] or None on error
        """
        server = self.server
        
        if self.destination_position is None:
            server.gui.update_monitor("Error: Destination position not set")
            return None
        
        if server.object_position is None:
            server.gui.update_monitor("Error: Object position not set")
            return None
        
        # Current centroid = object position (robots are around it)
        start_pos = server.object_position
        end_pos = self.destination_position
        
        server.gui.update_monitor(
            f"Computing transport trajectory: ({start_pos[0]:.2f}, {start_pos[1]:.2f}) → "
            f"({end_pos[0]:.2f}, {end_pos[1]:.2f})"
        )
        
        # Dynamic update of grip_radius based on current object dimensions and gripper_length
        # Use max dimension for safety with rectangular objects
        # Formula: object_half_size + gripper_length + robot_radius (NOT arm_base_length)
        max_object_dimension = max(server.object_length, server.object_width)
        current_grip_radius = (max_object_dimension / 2) + server.gripper_length + server.robot_radius
        server.formation_planner.grip_radius = current_grip_radius
        
        # Calculate effective radius for obstacle clearance
        effective_radius = (
            server.formation_planner.grip_radius +  # Distance from centroid to robot
            server.robot_radius                      # Robot's own size
        )
        
        server.gui.update_monitor(
            f"Effective clearance radius: {effective_radius:.2f}m "
            f"(grip={server.formation_planner.grip_radius:.2f}, "
            f"robot={server.robot_radius:.2f})"
        )
        
        # Visualize the formation circle (unified body size) at start position
        self.server.visualizer.set_formation_circle(start_pos[0], start_pos[1], effective_radius)
        
        # Create a modified planner with inflated obstacles
        transport_planner = PathPlanner(
            x_range=(-2.0, 15.0), 
            y_range=(-2.0, 15.0), 
            cell_size=0.05,
            robot_radius=0.0  # We manually inflate obstacles below
        )
        
        # Add inflated obstacles
        original_obstacles = server.path_planner.obstacles
        
        for obs in original_obstacles:
            # Check if this obstacle IS the object we are moving
            if obs['type'] == 'circle':
                dist_to_obj = math.sqrt((obs['cx'] - start_pos[0])**2 + (obs['cy'] - start_pos[1])**2)
                if dist_to_obj < 0.1:  # Threshold to identify "It is Me"
                    continue  # Skip adding myself as obstacle
                
                # Add extra margin for spline smoothing (spline can cut corners)
                spline_margin = 0.15  # Extra safety margin for cubic spline smoothing
                transport_planner.add_circular_obstacle(
                    obs['cx'], obs['cy'], 
                    obs['radius'] + effective_radius + spline_margin
                )
            elif obs['type'] == 'rectangle':
                # Expand rectangle by effective_radius + spline_margin on all sides
                spline_margin = 0.15
                total_expansion = effective_radius + spline_margin
                transport_planner.add_rectangular_obstacle(
                    obs['x1'] - total_expansion,
                    obs['y1'] - total_expansion,
                    obs['x2'] + total_expansion,
                    obs['y2'] + total_expansion
                )
        
        # Generate centroid trajectory
        start_time = time.time() + 1.0
        
        try:
            # Use A* from PathPlanner to find path for centroid
            centroid_path = transport_planner.plan_path(start_pos, end_pos)
            
            if not centroid_path:
                server.gui.update_monitor("Error: No transport path found (blocked)")
                return None
            
            # Step 1: Find key waypoints using line-of-sight shortcutting
            key_points = self._find_key_waypoints(centroid_path, transport_planner)
            
            # Ensure exact start and end
            key_points[0] = start_pos
            key_points[-1] = end_pos
            
            server.gui.update_monitor(f"Transport path: {len(centroid_path)} A* pts → {len(key_points)} key pts")
            
            # Step 2: Apply Cubic Spline for smooth curve
            trajectory_points = self._apply_cubic_spline(key_points, spacing=0.05)
            
            server.gui.update_monitor(f"Smoothed to {len(trajectory_points)} pts via cubic spline")
            
            # Timestamp
            self.transport_trajectories = {}
            centroid_traj = []
            
            total_dist = 0
            for i in range(1, len(trajectory_points)):
                p1 = trajectory_points[i-1]
                p2 = trajectory_points[i]
                total_dist += math.sqrt((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2)
            
            current_dist = 0
            for i, p in enumerate(trajectory_points):
                if i > 0:
                    p_prev = trajectory_points[i-1]
                    current_dist += math.sqrt((p[0]-p_prev[0])**2 + (p[1]-p_prev[1])**2)
                
                t = start_time + (current_dist / server.transport_velocity)
                centroid_traj.append({
                    "x": float(p[0]),
                    "y": float(p[1]),
                    "theta": 0.0,  # Centroid theta - Keep 0 for translation
                    "t": float(t)
                })
                
            # Assign to robots
            for rid in server.robot_connections:
                self.transport_trajectories[rid] = centroid_traj
            
            # Save Phase 2 trajectory to file (works for both TestMode and real mode)
            self._save_phase2_trajectory(centroid_traj)
                 
            return centroid_traj

        except Exception as e:
            import traceback
            server.gui.update_monitor(f"Transport planning error: {e}")
            traceback.print_exc()
            return None

    def start_transport_phase(self):
        """
        Start Phase 2: Transport the object to destination.
        
        Computes centroid trajectory and sends it to all arrived robots
        along with their formation offsets for Virtual Structure control.
        
        Returns:
            bool: True if started successfully
        """
        server = self.server
        
        # Verify robots have arrived (check via approach_manager)
        if not server.approach_manager.check_all_arrived():
            server.gui.update_monitor("Error: Not all robots have arrived at grip positions")
            return False
        
        # Get arrived robot IDs
        arrived_robots = [rid for rid, arrived in server.approach_manager.arrived_status.items() if arrived]
        if len(arrived_robots) < 2:
            server.gui.update_monitor("Error: Need at least 2 robots for transport")
            return False
        
        # Compute centroid trajectory
        centroid_trajectory = self.compute_transport_trajectories()
        if centroid_trajectory is None:
            return False
        
        # Compute formation offsets for each robot
        server.formation_planner.set_active_robots(arrived_robots)
        formation_offsets = server.formation_planner.compute_formation_offsets()
        
        server.gui.update_monitor(
            f"Formation offsets: {formation_offsets}"
        )
        
        # Reset transport arrival status
        self.transport_arrived_status = {rid: False for rid in arrived_robots}
        self.transport_phase_active = True
        
        # ========== LOCK TRANSPORT OFFSET (for testing without grip) ==========
        # If grip was skipped/ignored, we need to lock offset before sending trajectory
        # This ensures robots maintain their relative positions to object center
        server.gui.update_monitor("Sending lock_transport_offset command to all robots...")
        
        for robot_id in arrived_robots:
            if robot_id not in server.robot_connections:
                continue
            
            lock_cmd = json.dumps({
                "type": "control",
                "cmd": "lock_transport_offset",
                "object_pos": list(server.object_position)
            })
            server.send_command_to_robot(robot_id, lock_cmd)
            server.gui.update_monitor(f"Robot {robot_id}: lock_transport_offset sent")
        
        # Small delay to ensure offset is locked before trajectory
        time.sleep(0.1)
        
        # Start sync position logging for Phase 2
        server.start_sync_position_logging()
        
        # Calculate synchronized start time for all robots
        sync_start_time = time.time() + server.execution_time_offset
        
        # Offset all trajectory times by execution_time_offset
        for point in centroid_trajectory:
            point['t'] += server.execution_time_offset
        
        # User requested Mutex Lock to block sync_position during trajectory loading.
        server.trajectory_sync_lock.acquire()
        try:
            # Send trajectory to each robot
            success_count = 0
            for robot_id in arrived_robots:
                if robot_id not in server.robot_connections:
                    server.gui.update_monitor(f"Robot {robot_id} not connected - skipping")
                    continue
                
                # Get this robot's offset
                offset = formation_offsets.get(robot_id, (0.0, 0.0))
                
                # Prepare metadata with phase info and offset
                meta = {
                    "phase": "transport",
                    "trajectory_type": "centroid",
                    "formation_offset": list(offset),  # [dx, dy]
                    "robot_id": robot_id,
                    "destination": list(self.destination_position),
                    "num_robots": len(arrived_robots)
                }
                
                # Store trajectory
                self.transport_trajectories[robot_id] = centroid_trajectory
                
                # Send to robot
                if server.send_trajectory_to_robot(robot_id, centroid_trajectory, meta):
                    # Small delay to ensure trajectory is received before execute command
                    time.sleep(0.01)  # 10ms delay
                    
                    # Send execute command with synchronized start time
                    exec_cmd = json.dumps({
                        "type": "control", 
                        "cmd": "execute_trajectory",
                        "time": sync_start_time  # Synchronized start time for all robots
                    })
                    server.send_command_to_robot(robot_id, exec_cmd)
                    success_count += 1
                    server.gui.update_monitor(
                        f"Robot {robot_id}: Sent transport trajectory (offset: "
                        f"[{offset[0]:.3f}, {offset[1]:.3f}])"
                    )
                    
            # Keep the mutex engaged for an extra few seconds so the ESP32s can finish 
            # parsing their large TCP buffers before sync_position starts interlacing them
            time.sleep(3.0)
            
        finally:
            server.trajectory_sync_lock.release()
            
        if success_count > 0:
            server.gui.update_monitor(
                f"=== PHASE 2 TRANSPORT STARTED ({success_count} robots) ==="
            )
            
            # Update visualization with centroid path
            path_points = [(p['x'], p['y']) for p in centroid_trajectory]
            self.server.visualizer.set_centroid_path(path_points)
            
            return True
        else:
            self.transport_phase_active = False
            server.gui.update_monitor("Transport phase failed: No trajectories sent")
            return False
    
    def handle_transport_completion(self, robot_id):
        """
        Handle transport completion notification from a robot.
        
        Args:
            robot_id: Robot that has completed transport
        """
        if robot_id not in self.transport_arrived_status:
            return
        
        self.transport_arrived_status[robot_id] = True
        self.server.gui.update_monitor(f"Robot {robot_id}: Transport complete")
        
        # Check if all robots completed
        if all(self.transport_arrived_status.values()):
            self.transport_phase_active = False
            self.server.gui.update_monitor(
                "=== ALL ROBOTS COMPLETED TRANSPORT - PHASE 2 FINISHED ==="
            )
            
            # Update GUI
            if hasattr(self.server.gui, 'update_phase2_status'):
                self.server.gui.update_phase2_status("Complete", completed=True)
    
    def abort_transport_phase(self):
        """
        Abort the current transport phase and stop all robots.
        """
        self.transport_phase_active = False
        
        # Stop all robots
        for robot_id in self.server.robot_connections.keys():
            self.server.emergency_stop(robot_id)
            self.server.visualizer.clear_ground_truth_path(robot_id)
        
        self.transport_arrived_status.clear()
        self.transport_trajectories.clear()
        
        self.server.gui.update_monitor("Transport phase aborted")
    
    def get_transport_status(self):
        """
        Get current transport phase status.
        
        Returns:
            dict: Status information
        """
        return {
            'active': self.transport_phase_active,
            'destination': self.destination_position,
            'arrived_status': self.transport_arrived_status.copy(),
            'all_complete': all(self.transport_arrived_status.values()) if self.transport_arrived_status else False
        }
    
    # ========== TRAJECTORY LOGGING ==========
    
    def _save_phase2_trajectory(self, centroid_trajectory):
        """
        Save Phase 2 (transport) trajectory to file for debugging/analysis.
        
        Args:
            centroid_trajectory: List of trajectory points [{x, y, theta, t}, ...]
        """
        import os
        
        try:
            log_dir = "trajectory_logs"
            os.makedirs(log_dir, exist_ok=True)
            
            log_file = os.path.join(log_dir, "phase2.txt")
            
            with open(log_file, 'w') as f:
                f.write("# Phase 2 Transport Trajectory (Centroid)\n")
                f.write("# Format: x, y, theta, t\n")
                f.write(f"# Total points: {len(centroid_trajectory)}\n")
                f.write("# =====================================\n")
                
                for point in centroid_trajectory:
                    f.write(f"{point['x']:.6f}, {point['y']:.6f}, {point['theta']:.6f}, {point['t']:.6f}\n")
            
            self.server.gui.update_monitor(f"Phase 2 trajectory saved to {log_file} ({len(centroid_trajectory)} pts)")
            
        except Exception as e:
            print(f"[TransportManager] Error saving Phase 2 trajectory: {e}")
    
    # ========== PATH SMOOTHING (Phase 2 specific - Cubic Spline) ==========
    
    def _find_key_waypoints(self, path, planner):
        """
        Find key waypoints from A* path using line-of-sight shortcutting.
        
        Removes unnecessary waypoints by checking if we can go directly
        from point A to point C without hitting obstacles.
        """
        if len(path) < 3:
            return list(path)
        
        key_points = [path[0]]  # Always keep start
        current_idx = 0
        
        while current_idx < len(path) - 1:
            best_idx = current_idx + 1
            
            # Try to find the furthest point we can reach directly
            for check_idx in range(len(path) - 1, current_idx + 1, -1):
                if self._line_of_sight(path[current_idx], path[check_idx], planner):
                    best_idx = check_idx
                    break
            
            key_points.append(path[best_idx])
            current_idx = best_idx
        
        return key_points
    
    def _apply_cubic_spline(self, key_points, spacing=0.05):
        """
        Apply cubic spline interpolation to create a smooth curve through key points.
        
        This creates smooth, continuous curves that robot motors can follow.
        
        Args:
            key_points: List of (x, y) key waypoints
            spacing: Distance between output points (meters)
            
        Returns:
            List of (x, y) points along the smooth curve
        """
        if len(key_points) < 2:
            return key_points
        
        if len(key_points) == 2:
            # Just 2 points - linear interpolation
            return self._linear_interpolate(key_points[0], key_points[1], spacing)
        
        # Extract x and y coordinates
        x_pts = np.array([p[0] for p in key_points])
        y_pts = np.array([p[1] for p in key_points])
        
        # Calculate cumulative arc length for parameterization
        t = np.zeros(len(key_points))
        for i in range(1, len(key_points)):
            dx = x_pts[i] - x_pts[i-1]
            dy = y_pts[i] - y_pts[i-1]
            t[i] = t[i-1] + np.sqrt(dx*dx + dy*dy)
        
        total_length = t[-1]
        if total_length < 0.01:
            return key_points
        
        # Create cubic spline interpolation
        # k=3 for cubic, k=2 for quadratic (use smaller if not enough points)
        k = min(3, len(key_points) - 1)
        
        try:
            # Use scipy's splprep for parametric spline
            # s > 0 adds smoothing to reduce curvature (important for Mecanum wheels to avoid slipping)
            # s=0 means exact interpolation, s=0.1 means slight smoothing
            smoothing_factor = 0.1  # Reduce curvature - higher = smoother but less accurate
            tck, u = interpolate.splprep([x_pts, y_pts], s=smoothing_factor, k=k)
            
            # Generate smooth points - fewer points for Mecanum
            # Use larger spacing (0.10m instead of 0.05m) to reduce point count
            output_spacing = 0.10  # meters between points
            num_output_points = max(10, int(total_length / output_spacing))
            u_new = np.linspace(0, 1, num_output_points)
            
            smooth_x, smooth_y = interpolate.splev(u_new, tck)
            
            # Convert to list of tuples
            smooth_path = [(float(smooth_x[i]), float(smooth_y[i])) for i in range(len(smooth_x))]
            
            # Ensure exact start and end points
            smooth_path[0] = key_points[0]
            smooth_path[-1] = key_points[-1]
            
            return smooth_path
            
        except Exception as e:
            print(f"[TransportManager] Spline error: {e}, falling back to linear")
            # Fallback to linear interpolation
            return self._linear_interpolate_path(key_points, spacing)
    
    def _linear_interpolate(self, p1, p2, spacing):
        """Linear interpolation between two points."""
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        dist = math.sqrt(dx*dx + dy*dy)
        
        if dist < spacing:
            return [p1, p2]
        
        num_points = max(2, int(dist / spacing))
        points = []
        
        for i in range(num_points + 1):
            t = i / num_points
            x = p1[0] + t * dx
            y = p1[1] + t * dy
            points.append((x, y))
        
        return points
    
    def _linear_interpolate_path(self, path, spacing):
        """Linear interpolation for entire path (fallback)."""
        result = []
        for i in range(len(path) - 1):
            segment = self._linear_interpolate(path[i], path[i+1], spacing)
            if i > 0:
                segment = segment[1:]  # Avoid duplicates
            result.extend(segment)
        return result
    
    def _line_of_sight(self, p1, p2, planner):
        """Check if there's a clear line of sight between two points."""
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        dist = math.sqrt(dx*dx + dy*dy)
        
        if dist < 0.01:
            return True
        
        step_size = planner.cell_size / 2
        num_steps = int(dist / step_size) + 1
        
        for i in range(num_steps + 1):
            t = i / num_steps if num_steps > 0 else 0
            x = p1[0] + t * dx
            y = p1[1] + t * dy
            
            if not planner.is_valid_position(x, y):
                return False
            
            col, row = planner.world_to_grid(x, y)
            if planner.obstacle_map[row, col]:
                return False
        
        return True


