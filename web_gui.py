"""
WebGUI Adapter - implements the same interface as ServerGUI
but pushes all updates via WebSocket to connected browsers.
"""
import json
import asyncio
import threading
import time


class WebVisualizer:
    """
    Visualizer that stores state and broadcasts updates via WebSocket.
    Implements the same interface as TrajectoryVisualizer.
    """
    def __init__(self, broadcast_fn):
        self._broadcast = broadcast_fn
        
        # Store state for new client sync
        self.positions = {}        # {robot_id: (x, y, theta)}
        self.trajectories = {}     # {robot_id: [(x,y), ...]}
        self.ground_truth = {}     # {robot_id: [(x,y), ...]}
        self.object_pos = None     # (x, y, length, width)
        self.obstacles = []
        self.grip_positions = {}   # {robot_id: (x, y)}
        self.destination = None    # (x, y)
        self.centroid_path = []    # [(x,y), ...]
        self.formation_circle = None  # (cx, cy, r)
        
        # Sensor data
        self.ekf_data = {}         # {robot_id: (x, y)}
        self.bno055_data = {}
        self.odometry_data = {}
        self.localization_data = {}

    def _send(self, method, *args):
        self._broadcast({'type': 'viz', 'method': method, 'args': list(args)})

    def update_position(self, robot_id, x, y, theta):
        self.positions[robot_id] = (x, y, theta)
        # Append to trajectory
        if robot_id not in self.trajectories:
            self.trajectories[robot_id] = []
        pts = self.trajectories[robot_id]
        pts.append((x, y))
        if len(pts) > 2000:
            self.trajectories[robot_id] = pts[-1500:]
        self._send('update_position', robot_id, x, y, theta)

    def update_ekf(self, robot_id, x, y):
        self.ekf_data[robot_id] = (x, y)
        self._send('update_ekf', robot_id, x, y)

    def update_bno055(self, robot_id, x, y, vx, vy):
        self.bno055_data[robot_id] = (x, y, vx, vy)
        self._send('update_bno055', robot_id, x, y, vx, vy)

    def update_odometry(self, robot_id, x, y, vx, vy):
        self.odometry_data[robot_id] = (x, y, vx, vy)
        self._send('update_odometry', robot_id, x, y, vx, vy)

    def update_localization(self, robot_id, x, y):
        self.localization_data[robot_id] = (x, y)
        self._send('update_localization', robot_id, x, y)

    def set_object_position(self, x, y, length, width):
        self.object_pos = (x, y, length, width)
        self._send('set_object_position', x, y, length, width)

    def set_obstacles(self, obstacles):
        self.obstacles = obstacles
        serializable = []
        for obs in obstacles:
            serializable.append(dict(obs))
        self._send('set_obstacles', serializable)

    def set_grip_positions(self, grip_positions):
        self.grip_positions = dict(grip_positions)
        serializable = {str(k): list(v) for k, v in grip_positions.items()}
        self._send('set_grip_positions', serializable)

    def set_ground_truth_path(self, robot_id, path):
        self.ground_truth[robot_id] = list(path)
        self._send('set_ground_truth_path', robot_id, path)

    def clear_ground_truth_path(self, robot_id):
        if robot_id in self.ground_truth:
            del self.ground_truth[robot_id]
        self._send('clear_ground_truth_path', robot_id)

    def set_destination_position(self, x, y):
        self.destination = (x, y)
        self._send('set_destination_position', x, y)

    def set_centroid_path(self, path_points):
        self.centroid_path = list(path_points)
        self._send('set_centroid_path', path_points)

    def set_formation_circle(self, cx, cy, radius):
        self.formation_circle = (cx, cy, radius)
        self._send('set_formation_circle', cx, cy, radius)

    def show(self):
        pass  # No-op for web

    def get_full_state(self):
        """Return complete state for syncing new clients"""
        state = {'type': 'viz_full_state'}
        if self.object_pos:
            state['object'] = list(self.object_pos)
        if self.obstacles:
            state['obstacles'] = [dict(o) for o in self.obstacles]
        if self.grip_positions:
            state['grip_positions'] = {str(k): list(v) for k, v in self.grip_positions.items()}
        if self.destination:
            state['destination'] = list(self.destination)
        if self.centroid_path:
            state['centroid_path'] = self.centroid_path
        if self.formation_circle:
            state['formation_circle'] = list(self.formation_circle)
        if self.ground_truth:
            state['ground_truth'] = {str(k): v for k, v in self.ground_truth.items()}
        if self.positions:
            state['positions'] = {str(k): list(v) for k, v in self.positions.items()}
        if self.trajectories:
            state['trajectories'] = {str(k): v[-200:] for k, v in self.trajectories.items()}
        return state


class ArmGUIProxy:
    """Proxy for arm GUI - stores received angles and broadcasts"""
    def __init__(self, robot_id, broadcast_fn):
        self.robot_id = robot_id
        self._broadcast = broadcast_fn
        self.received_angles = {}

    def update_received_angles(self, arm_data):
        self.received_angles = dict(arm_data)
        self._broadcast({
            'type': 'arm_ik_result',
            'robot_id': self.robot_id,
            'data': arm_data
        })


class WebGUI:
    """
    Web GUI adapter that implements the same interface as ServerGUI.
    All UI updates are broadcast via WebSocket to connected browsers.
    """

    def __init__(self, ws_manager):
        self.ws_manager = ws_manager
        
        # Create visualizer for Server to use
        self.visualizer = WebVisualizer(self._broadcast)
        
        # Arm GUI proxies
        self.arm_guis = {}
        for robot_id in [1, 2, 3]:
            self.arm_guis[robot_id] = ArmGUIProxy(robot_id, self._broadcast)
        
        # Server reference (set after Server is created)
        self.server = None

        # State tracking
        self.connection_status = {}
        self.encoder_data = {}
        self.heading_data = {}
        self.calibration_data = {}
        self.pid_data = {}
        self.arrival_status = {}
        self.monitor_log = []
        self._monitor_max = 500

    def set_server(self, server):
        self.server = server

    def _broadcast(self, message):
        """Broadcast a message to all connected WebSocket clients"""
        self.ws_manager.broadcast(message)

    # ===== GUI Interface Methods =====

    def update_monitor(self, message):
        timestamp = time.strftime('%H:%M:%S')
        entry = f"[{timestamp}] {message}"
        self.monitor_log.append(entry)
        if len(self.monitor_log) > self._monitor_max:
            self.monitor_log = self.monitor_log[-self._monitor_max:]
        self._broadcast({'type': 'monitor', 'message': entry})

    def update_status(self, robot_id, status):
        self.connection_status[robot_id] = status
        self._broadcast({'type': 'status', 'robot_id': robot_id, 'status': status})

    def enable_control_buttons(self, robot_id):
        self._broadcast({'type': 'buttons', 'robot_id': robot_id, 'enabled': True})

    def disable_control_buttons(self, robot_id):
        self._broadcast({'type': 'buttons', 'robot_id': robot_id, 'enabled': False})

    def update_encoders(self, robot_id, encoders):
        self.encoder_data[robot_id] = list(encoders)
        self._broadcast({'type': 'encoders', 'robot_id': robot_id, 'data': list(encoders)})

    def update_heading(self, robot_id, heading_value):
        self.heading_data[robot_id] = heading_value
        self._broadcast({'type': 'heading', 'robot_id': robot_id, 'value': heading_value})

    def update_calibration_status(self, robot_id, is_calibrated):
        self.calibration_data[robot_id] = is_calibrated
        self._broadcast({'type': 'calibration', 'robot_id': robot_id, 'calibrated': is_calibrated})

    def update_pid_entries(self, robot_id, motor_index, p, i, d):
        if robot_id not in self.pid_data:
            self.pid_data[robot_id] = {}
        self.pid_data[robot_id][motor_index] = [p, i, d]
        self._broadcast({
            'type': 'pid_update', 'robot_id': robot_id,
            'motor': motor_index, 'p': p, 'i': i, 'd': d
        })

    def update_arrival_status(self, robot_id, arrived):
        self.arrival_status[robot_id] = arrived
        self._broadcast({'type': 'arrival', 'robot_id': robot_id, 'arrived': arrived})

    def update_phase2_status(self, status, completed=False):
        self._broadcast({'type': 'phase2_status', 'status': status, 'completed': completed})

    def setup_progress_bar(self, total_size):
        self._broadcast({'type': 'progress_setup', 'total': total_size})

    def update_progress(self, value):
        self._broadcast({'type': 'progress', 'value': value})

    def hide_progress_bar(self):
        self._broadcast({'type': 'progress_hide'})

    def show_notification(self, level, title, message):
        self._broadcast({'type': 'notification', 'level': level, 'title': title, 'message': message})

    def update_rpm_data(self, robot_id, encoder_data):
        # Already handled by update_encoders
        pass

    def get_full_state(self):
        """Get complete current state for syncing new clients"""
        state = {
            'type': 'full_state',
            'connections': {str(k): v for k, v in self.connection_status.items()},
            'encoders': {str(k): v for k, v in self.encoder_data.items()},
            'headings': {str(k): v for k, v in self.heading_data.items()},
            'calibrations': {str(k): v for k, v in self.calibration_data.items()},
            'arrivals': {str(k): v for k, v in self.arrival_status.items()},
            'monitor': self.monitor_log[-100:],
        }
        # Add viz state
        state['viz'] = self.visualizer.get_full_state()
        return state
