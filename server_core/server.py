"""
Server Module — Core robot communication and state management.

Cleaned version of server_multi.py for standalone web dashboard.
All tkinter / GUI-specific code removed. Uses null-object pattern for visualizer.
"""
import socket
import threading
import queue
import concurrent.futures
import time
import csv
import os
import re
import json
import subprocess
import platform
import math

# Null stubs for tkinter-dependent modules (not needed in web mode)
messagebox = None
def update_rpm_plot(*a, **k): pass
def get_rpm_plotter(*a, **k): return None
robot_position_visualizer = None
_default_visualizer = None

from .trajectory_manager import get_test_trajectory, timestamp_trajectory, generate_approach_trajectory, generate_multi_robot_approach_trajectories, generate_safe_approach_path
from .synchronized_trajectory import generate_synchronized_trajectories, verify_trajectories_collision_free
from .path_planner import PathPlanner, get_path_planner
from .formation_planner import FormationPlanner
from .approach_manager import ApproachManager
from .transport_manager import TransportManager


class _NullVisualizer:
    """Null object pattern - silently ignores all method calls"""
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


class Server:
    def __init__(self, gui):
        self.gui = gui
        
        # Setup visualizer (can be provided by GUI adapter via gui.visualizer)
        self.visualizer = getattr(gui, 'visualizer', None) or _NullVisualizer()
        
        # Single robot state - all indexed by robot_id
        self.robot_connections = {}  # {robot_id: socket}
        self.robot_threads = {}      # {robot_id: thread}
        self.socket_locks = {}       # {robot_id: threading.Lock} - prevent race condition
        self.control_active = {}     # {robot_id: bool}
        self.firmware_active = {}    # {robot_id: bool}
        self.file_paths = {}         # {robot_id: firmware_file_path} - CHANGED: per-robot paths
        
        # State per robot
        self.speed = {}              # {robot_id: [0,0,0,0]}
        self.encoders = {}           # {robot_id: [0,0,0,0]}
        self.bno055_heading = {}     # {robot_id: 0.0}
        self.pid_values = {}         # {robot_id: [[1.0,0.0,0.0] for _ in range(4)]}
        self.bno055_calibrated = {}  # {robot_id: False}
        
        # Trajectory supervisor state
        self.robot_paths = {}        # {robot_id: [(x, y), ...]}
        self.robot_path_index = {}   # {robot_id: current_waypoint_index}
        
        # Initialize state for 1 robot
        for robot_id in [1]:
            self.speed[robot_id] = [0, 0, 0, 0]
            self.encoders[robot_id] = [0, 0, 0, 0]
            self.bno055_heading[robot_id] = 0.0
            self.pid_values[robot_id] = [[1.0, 0.0, 0.0] for _ in range(4)]
            self.bno055_calibrated[robot_id] = False
            self.control_active[robot_id] = False
            self.firmware_active[robot_id] = False
            self.file_paths[robot_id] = None
            if not hasattr(self, 'decentralized_execution'):
                self.decentralized_execution = {}
            self.decentralized_execution[robot_id] = False

        self.sending_firmware = False
        self.connection_status = {}  # {robot_id: "Disconnected"}
        self.log_data = True
        self.log_files = {}          # {(robot_id, data_type): file_handle}
        self.log_writers = {}        # {(robot_id, data_type): csv_writer}
        self.start_times = {}
        self.supported_types = ["encoder", "bno055", "log", "position", "pid"]
        
        # --- Component-level log toggles (set from app.py) ---
        self.log_rx_encoder   = False
        self.log_rx_bno055    = False
        self.log_rx_position  = False
        self.log_rx_pid       = True
        self.log_rx_control   = True
        self.log_rx_arm       = True
        self.log_rx_sync      = False
        self.log_rx_log       = True
        self.log_tx_kinematic = False
        self.log_tx_command   = True
        self.log_tx_trajectory = True
        self.log_tx_pid       = True
        self.log_tx_arm       = True
        self.log_tx_position  = True
        self.log_tx_firmware  = True
        
        # ========== PHASE 1: APPROACH STATE ==========
        # Path Planner and Formation planners
        # Initialize with wider range to support negative coordinates (offset from 0,0)
        self.path_planner = get_path_planner(x_range=(-2.0, 15.0), 
                                             y_range=(-2.0, 15.0), 
                                             cell_size=0.05)
        # Object & Gripper Configuration
        self.object_position = None  # (x, y) in meters
        self.object_length = 0.2     # Object length in meters (X-axis direction)
        self.object_width = 0.2      # Object width in meters (Y-axis direction)
        
        self.arm_base_length = 0.10   # Distance from robot center to arm base (10cm - fixed)
        self.gripper_length = 0.05    # Distance from arm base to gripper tip (5cm - configurable)
        self.robot_radius = 0.2       # Robot radius for collision checking (m)
        
        # Calculate dynamic grip radius
        self.calculated_grip_radius = (
            (max(self.object_length, self.object_width) / 2) + 
            self.gripper_length + 
            self.robot_radius
        )

        # Path Planner and Formation planners
        self.path_planner = get_path_planner(x_range=(-2.0, 15.0), 
                                             y_range=(-2.0, 15.0), 
                                             cell_size=0.05)
        self.formation_planner = FormationPlanner(num_robots=1, grip_radius=self.calculated_grip_radius)

        
        # Robot positions from EKF (updated automatically)
        self.robot_positions = {}     # {robot_id: (x, y, theta)}
        
        # Manual positions for testing
        self.manual_positions = {}    # {robot_id: (x, y, theta)}
        self.use_manual_positions = False
        
        # Grip positions around object
        self.grip_positions = {}      # {robot_id: (x, y)}
        
        # Approach velocity (m/s)
        self.approach_velocity = 0.2
        
        # Phase 2 shared state
        self.transport_velocity = 0.15    # Slower for carrying object (m/s)
        
        # Execution synchronization offset (seconds)
        self.execution_time_offset = 5.0  # Default 5 seconds
        
        # ========== PHASE MANAGERS ==========
        self.approach_manager = ApproachManager(self)
        self.transport_manager = TransportManager(self)
        
        # Thread management
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=12)
        self.ui_update_queue = queue.Queue()
        self.ui_update_thread_active = True
        self.ui_update_thread = threading.Thread(target=self._ui_update_worker, daemon=True)
        self.ui_update_thread.start()
        
        # Mutex lock to block sync_position during trajectory loading (requested by user)
        self.trajectory_sync_lock = threading.Lock()
        
        # Sync position logging (async, non-blocking)
        self.sync_log_queue = queue.Queue(maxsize=10000)
        self.sync_log_file = None
        self.sync_log_writer = None
        self.sync_log_active = True
        self.sync_logging_enabled = False
        self.sync_log_thread = threading.Thread(target=self._sync_log_worker, daemon=True)
        self.sync_log_thread.start()

    def connect_to_robot(self, robot_id, host, port):
        """Connect to a specific robot server"""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(10)
            sock.connect((host, port))

            self.robot_connections[robot_id] = sock
            self.socket_locks[robot_id] = threading.Lock()
            self.connection_status[robot_id] = "Connected"
            
            thread = threading.Thread(target=self.receive_data, args=(sock, robot_id), daemon=True)
            thread.start()
            self.robot_threads[robot_id] = thread
            
            self.gui.update_monitor(f"Robot {robot_id} connected to {host}:{port}")
            self.gui.update_status(robot_id, "Connected")
            self.gui.enable_control_buttons(robot_id)
            
            return True
            
        except socket.timeout:
            self.gui.update_monitor(f"Robot {robot_id}: Connection timeout")
            if hasattr(self.gui, 'show_notification'):
                self.gui.show_notification('error', 'Connection Error', f'Robot {robot_id}: Timeout connecting to {host}:{port}')
            return False
            
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Connection error: {e}")
            if hasattr(self.gui, 'show_notification'):
                self.gui.show_notification('error', 'Connection Error', f'Robot {robot_id}: {str(e)}')
            return False

    def disconnect_from_robot(self, robot_id):
        """Disconnect from a specific robot server"""
        if robot_id not in self.robot_connections:
            return
        
        try:
            sock = self.robot_connections[robot_id]
            sock.close()
            del self.robot_connections[robot_id]
            if robot_id in self.robot_threads:
                del self.robot_threads[robot_id]
            if robot_id in self.socket_locks:
                del self.socket_locks[robot_id]
        except Exception as e:
            print(f"Error disconnecting robot {robot_id}: {e}")
        
        self.connection_status[robot_id] = "Disconnected"
        self.gui.update_monitor(f"Robot {robot_id} disconnected")
        self.gui.update_status(robot_id, "Disconnected")
        self.gui.disable_control_buttons(robot_id)
        self.close_robot_logs(robot_id)

    def disconnect_all_robots(self):
        """Disconnect all robots"""
        for robot_id in list(self.robot_connections.keys()):
            self.disconnect_from_robot(robot_id)
        
        self.sync_log_active = False
        if self.sync_log_thread.is_alive():
            self.sync_log_queue.put(None)
            self.sync_log_thread.join(timeout=2.0)
        self._close_sync_log_file()

    # Log file management per robot
    # File naming: robot{id}_{YYYYMMDD_HHMMSS}_{type}.csv
    _LOG_TYPE_NAME = {
        "bno055":   "imu",
        "log":      "monitor",
        "encoder":  "encoder",
        "position": "position",
        "pid":      "pid",
    }

    def setup_log_file(self, robot_id, data_type):
        if not self.log_data:
            return

        if not hasattr(self, 'common_start_time') or not self.log_files:
            self.common_start_time = time.time()

        log_key = (robot_id, data_type)
        if log_key in self.log_files:
            return

        log_dir = "logs"
        os.makedirs(log_dir, exist_ok=True)
        session_id = time.strftime('%Y%m%d_%H%M%S', time.localtime(self.common_start_time))
        clean_name = self._LOG_TYPE_NAME.get(data_type, data_type)
        log_filename = f"{log_dir}/robot{robot_id}_{session_id}_{clean_name}.csv"

        self.log_files[log_key] = open(log_filename, "w", newline='')
        self.log_writers[log_key] = csv.writer(self.log_files[log_key])

        if data_type == "encoder":
            self.log_writers[log_key].writerow(["time", "motor1", "motor2", "motor3", "motor4"])
        elif data_type == "bno055":
            self.log_writers[log_key].writerow([
                "time", "heading", "roll", "pitch",
                "accel_x", "accel_y", "accel_z",
                "gyro_x", "gyro_y", "gyro_z",
                "mag_x", "mag_y", "mag_z",
                "quat_w", "quat_x", "quat_y", "quat_z",
                "linear_accel_x", "linear_accel_y", "linear_accel_z",
                "gravity_x", "gravity_y", "gravity_z",
                "sys_cal", "gyro_cal", "accel_cal", "mag_cal"
            ])
        elif data_type == "log":
            self.log_writers[log_key].writerow(["time", "message"])
        elif data_type == "position":
            # 'source' is explicit in header so analytics can parse without guessing
            self.log_writers[log_key].writerow(["time", "source", "x", "y", "theta", "vx", "vy"])
        elif data_type == "pid":
            self.log_writers[log_key].writerow(["time", "motor", "kp", "ki", "kd"])

        self.gui.update_monitor(f"Robot {robot_id}: Logging {clean_name} → {log_filename}")
    
    def close_robot_logs(self, robot_id):
        """Close all log files for a specific robot"""
        keys_to_remove = [key for key in self.log_files.keys() if key[0] == robot_id]
        for key in keys_to_remove:
            self.log_files[key].close()
            del self.log_files[key]
            if key in self.log_writers:
                del self.log_writers[key]
    
    def close_all_logs(self):
        """Close all log files"""
        for log_file in self.log_files.values():
            log_file.close()
        self.log_files = {}
        self.log_writers = {}
        self.start_times = {}
    
    def _setup_sync_log_file(self):
        """Setup sync position log file for replay capability"""
        try:
            log_dir = "logs"
            os.makedirs(log_dir, exist_ok=True)
            session_id = time.strftime('%Y%m%d_%H%M%S')
            log_filename = f"{log_dir}/sync_position_log_{session_id}.csv"
            
            self.sync_log_file = open(log_filename, "w", newline='')
            self.sync_log_writer = csv.writer(self.sync_log_file)
            self.sync_log_writer.writerow([
                "server_timestamp", "robot_id", "x", "y", "vx", "vy", "theta", "robot_timestamp", "pos_unc", "vel_unc"
            ])
            self.sync_log_file.flush()
            
            self.gui.update_monitor(f"Sync position logging started: {log_filename}")
        except Exception as e:
            print(f"Error setting up sync log file: {e}")
    
    def _close_sync_log_file(self):
        """Close sync position log file"""
        if self.sync_log_file:
            try:
                self.sync_log_file.close()
                self.gui.update_monitor("Sync position log file closed")
            except Exception as e:
                print(f"Error closing sync log file: {e}")
            finally:
                self.sync_log_file = None
                self.sync_log_writer = None
    
    def start_sync_position_logging(self):
        """Start sync position logging (called when Phase 2 begins)"""
        if self.sync_logging_enabled:
            self.gui.update_monitor("Sync position logging already enabled")
            return
        
        self.sync_logging_enabled = True
        self._setup_sync_log_file()
        self.gui.update_monitor("Phase 2: Sync position logging enabled")
    
    def stop_sync_position_logging(self):
        """Stop sync position logging"""
        self.sync_logging_enabled = False
        self._close_sync_log_file()
        self.gui.update_monitor("Sync position logging disabled")

    def send_firmware(self, robot_id):
        """Send firmware to a specific robot"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id} is not connected - cannot send firmware")
            return
            
        if robot_id not in self.file_paths or not self.file_paths[robot_id]:
            self.gui.update_monitor(f"Please choose a firmware file for Robot {robot_id} first")
            return
            
        try:
            sock = self.robot_connections[robot_id]
            file_path = self.file_paths[robot_id]
            
            with open(file_path, "rb") as f:
                firmware_data = f.read()
                
            total_size = len(firmware_data)
            self.gui.setup_progress_bar(total_size)
                        
            sent = 0
            chunk_size = 1024
            while sent < total_size:
                chunk = firmware_data[sent:sent + chunk_size]
                sock.sendall(chunk)
                sent += len(chunk)
                self.gui.update_progress((sent / total_size) * 100)
            
            self.gui.update_monitor(f"Robot {robot_id}: Firmware sent successfully")
            time.sleep(4)
            sock.sendall(b"COMPLETED")
                
            self.gui.update_monitor(f"Robot {robot_id}: Firmware sent successfully. Sent 'COMPLETED' signal.")
            self.gui.hide_progress_bar()
            
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Firmware send error: {e}")
            if hasattr(self.gui, 'show_notification'):
                self.gui.show_notification('error', 'Firmware Error', f'Robot {robot_id}: {str(e)}')
        finally:
            self.gui.hide_progress_bar()

    def send_upgrade_command(self, robot_id):
        """Send upgrade command to a specific robot"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id} is not connected - cannot send upgrade")
            return
            
        try:
            sock = self.robot_connections[robot_id]
            command = "Upgrade\n"
            sock.sendall(command.encode())
            if self.log_tx_firmware:
                print(f"[TX firmware] Robot {robot_id}: Upgrade command sent")
            self.gui.update_monitor(f"Robot {robot_id}: Upgrade command sent")
            self.firmware_active[robot_id] = True
            
        except socket.timeout:
            self.gui.update_monitor(f"Robot {robot_id}: Upgrade command timeout")
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Upgrade command error: {e}")

    def process_encoder_data(self, robot_id, encoder_data):
        """Process encoder data for a specific robot"""
        if not isinstance(encoder_data, list) or len(encoder_data) < 4:
            return
        
        self.encoders[robot_id] = [float(v) for v in encoder_data]
        self.gui.update_encoders(robot_id, self.encoders[robot_id])
        
        if hasattr(self.gui, 'update_rpm_data'):
            self.gui.update_rpm_data(robot_id, self.encoders[robot_id])
        
        self.setup_log_file(robot_id, "encoder")
        log_key = (robot_id, "encoder")
        if self.log_data and log_key in self.log_files:
            elapsed = time.time() - self.common_start_time
            self.log_writers[log_key].writerow([elapsed] + self.encoders[robot_id])
            self.log_files[log_key].flush()

    def process_bno055_data(self, robot_id, bno_data):
        """Process BNO055 data for a specific robot"""
        try:
            if "event" in bno_data and bno_data["event"] == "calibration_complete":
                status = bno_data.get("status", {})
                self.gui.update_monitor(
                    f"Robot {robot_id} BNO055 CALIBRATION COMPLETE! Status: Sys={status.get('sys', 0)}, "
                    f"Gyro={status.get('gyro', 0)}, Accel={status.get('accel', 0)}, "
                    f"Mag={status.get('mag', 0)}"
                )
                self.gui.update_calibration_status(robot_id, True)
                return
            
            heading = bno_data.get('euler', [0.0, 0.0, 0.0])[0]
            self.bno055_heading[robot_id] = heading
            self.gui.update_heading(robot_id, heading)
            
            self.setup_log_file(robot_id, "bno055")
            log_key = (robot_id, "bno055")
            if self.log_data and log_key in self.log_files:
                elapsed = time.time() - self.common_start_time
                row = [elapsed] + bno_data.get('euler', []) + bno_data.get('quaternion', []) + \
                    bno_data.get('lin_accel', []) + bno_data.get('gravity', []) + \
                    bno_data.get('gyro_raw', []) + [bno_data.get('status', '')]
                self.log_writers[log_key].writerow(row)
                self.log_files[log_key].flush()
        except Exception as e:
            print(f"Robot {robot_id}: BNO055 processing error: {e}")

    def process_position_data(self, robot_id, position_data):
        """Process position data sent directly from the robot"""
        try:
            if isinstance(position_data, dict):
                x = float(position_data.get('x', 0.0))
                y = float(position_data.get('y', 0.0))
                theta = float(position_data.get('theta', 0.0))
                source = str(position_data.get('source', 'ekf')).strip().lower() or 'ekf'
                
                vx_raw = position_data.get('vx', None)
                vy_raw = position_data.get('vy', None)
                vx = float(vx_raw) if vx_raw else None
                vy = float(vy_raw) if vy_raw else None

                self.visualizer.update_position(robot_id, x, y, theta)
                
                self.setup_log_file(robot_id, "position")
                log_key = (robot_id, "position")
                if self.log_data and log_key in self.log_files:
                    elapsed = time.time() - self.common_start_time
                    self.log_writers[log_key].writerow([
                        f"{elapsed:.3f}",
                        source,
                        f"{x:.4f}",
                        f"{y:.4f}",
                        f"{theta:.4f}",
                        f"{vx:.4f}" if vx is not None else "",
                        f"{vy:.4f}" if vy is not None else ""
                    ])
                    self.log_files[log_key].flush()
                    
        except Exception as e:
            print(f"Robot {robot_id}: Position processing error: {e}")

    def process_log_message(self, robot_id, log_message):
        """Process log message from a specific robot"""
        self.gui.update_monitor(f"Robot {robot_id}: {log_message}")
        
        self.setup_log_file(robot_id, "log")
        log_key = (robot_id, "log")
        if self.log_data and log_key in self.log_files:
            elapsed = time.time() - self.common_start_time
            self.log_writers[log_key].writerow([f"{elapsed:.3f}", log_message])

    def process_pid_data(self, robot_id, pid_data):
        """Process PID data from a specific robot"""
        try:
            if not isinstance(pid_data, dict):
                return
            
            for motor_idx in range(4):
                motor_key = f"motor{motor_idx + 1}"
                if motor_key in pid_data:
                    pid_values = pid_data[motor_key]
                    if isinstance(pid_values, list) and len(pid_values) >= 3:
                        p, i, d = float(pid_values[0]), float(pid_values[1]), float(pid_values[2])
                        self.pid_values[robot_id][motor_idx] = [p, i, d]
                        self.gui.update_pid_entries(robot_id, motor_idx, p, i, d)
            
            self.setup_log_file(robot_id, "pid")
            log_key = (robot_id, "pid")
            if self.log_data and log_key in self.log_files:
                elapsed = time.time() - self.common_start_time
                for motor_idx in range(4):
                    motor_key = f"motor{motor_idx + 1}"
                    if motor_key in pid_data:
                        pid_values = pid_data[motor_key]
                        if isinstance(pid_values, list) and len(pid_values) >= 3:
                            self.log_writers[log_key].writerow(
                                [elapsed, motor_idx + 1, pid_values[0], pid_values[1], pid_values[2]]
                            )
                self.log_files[log_key].flush()
            
            self.gui.update_monitor(f"Robot {robot_id}: PID data received and updated")
            
        except Exception as e:
            print(f"Robot {robot_id}: PID data processing error: {e}")
            self.log_files[log_key].flush()

    def process_position_source_data(self, robot_id, message):
        """Process position data from multiple sources (EKF, BNO055, Odometry, Localization)"""
        try:
            source = message.get('source', 'unknown')
            data = message.get('data', {})
            position = data.get('position', [0.0, 0.0])
            velocity = data.get('velocity', [0.0, 0.0])

            if source == 'ekf':
                if len(position) >= 5:
                    x, y, vx, vy, theta = position[0], position[1], position[2], position[3], position[4]
                    self.ui_update_queue.put(('ekf', robot_id, (x, y, theta)))
                else:
                    self.gui.update_monitor(f"Robot {robot_id}: EKF data missing 5 values, only has {len(position)}")
                    return
            elif source == 'optical_flow':
                x, y = position[0], position[1]
                vx = velocity[0] if len(velocity) > 0 else 0.0
                vy = velocity[1] if len(velocity) > 1 else 0.0
                theta = 0.0
                self.ui_update_queue.put(('bno055', robot_id, (x, y, vx, vy)))
            elif source == 'odometry':
                x, y = position[0], position[1]
                vx = velocity[0] if len(velocity) > 0 else 0.0
                vy = velocity[1] if len(velocity) > 1 else 0.0
                theta = 0.0
                self.ui_update_queue.put(('odometry', robot_id, (x, y, vx, vy)))
            elif source == 'localization':
                x, y = position[0], position[1]
                theta = 0.0
                vx, vy = 0.0, 0.0
                self.ui_update_queue.put(('localization', robot_id, (x, y)))
            else:
                x, y = position[0] if position else 0.0, position[1] if len(position) > 1 else 0.0
                theta, vx, vy = 0.0, 0.0, 0.0

            self.setup_log_file(robot_id, "position")
            log_key = (robot_id, "position")
            if self.log_data and log_key in self.log_files:
                elapsed = time.time() - self.common_start_time
                # Normalized 7-column row: time, source, x, y, theta, vx, vy
                row = [
                    f"{elapsed:.4f}", source,
                    f"{x:.6f}", f"{y:.6f}", f"{theta:.6f}",
                    f"{vx:.6f}", f"{vy:.6f}"
                ]
                self.log_writers[log_key].writerow(row)
                self.log_files[log_key].flush()
        except Exception as e:
            print(f"Robot {robot_id}: Position source processing error: {e}")

    def clean_ansi_codes(self, text):
        """Remove ANSI color codes from text"""
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
        return ansi_escape.sub('', text)
    
    def receive_data(self, sock, robot_id):
        """Receive and process JSON data from a specific robot"""
        buffer = ""
        
        try:
            while robot_id in self.robot_connections:
                data = sock.recv(4096).decode('utf-8', errors='ignore')
                if not data:
                    break
                
                buffer += data
                
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    
                    if not line:
                        continue
                    
                    if line == 'ready':
                        self.gui.update_monitor(f"Robot {robot_id}: Received 'ready'. Sending 'ACK'...")
                        try:
                            sock.sendall("okay".encode())
                        except Exception as e:
                            print(f"Robot {robot_id}: Error sending ACK: {e}")
                        continue
                    
                    line = self.clean_ansi_codes(line)
                    try:
                        message = json.loads(line)
                        if 'type' in message:
                            data_type = message['type']
                            
                            if data_type == 'encoder':
                                if self.log_rx_encoder:
                                    print(f"[RX encoder] Robot {robot_id}: {message['data']}")
                                self.process_encoder_data(robot_id, message['data'])
                            
                            elif data_type == 'bno055':
                                if self.log_rx_bno055:
                                    print(f"[RX bno055] Robot {robot_id}: {message['data']}")
                                self.process_bno055_data(robot_id, message['data'])
                            
                            elif data_type == 'position':
                                if self.log_rx_position:
                                    src = message.get('source', '?')
                                    print(f"[RX position] Robot {robot_id}: source={src}")
                                self.process_position_source_data(robot_id, message)
                            
                            elif data_type == 'pid_data':
                                pid_data = message.get('data', {})
                                if self.log_rx_pid:
                                    print(f"[RX pid] Robot {robot_id}: {pid_data}")
                                self.process_pid_data(robot_id, pid_data)
                            
                            elif data_type == 'log':
                                if self.log_rx_log:
                                    print(f"[RX log] Robot {robot_id}: {message.get('message', '')}")
                                self.process_log_message(robot_id, message.get('message', ''))
                            
                            elif data_type == 'control':
                                if self.log_rx_control:
                                    print(f"[RX control] Robot {robot_id}: {message}")
                                if 'status' in message:
                                    status = message['status']
                                    if status == 'reached_goal':
                                        if not self.decentralized_execution.get(robot_id, False):
                                            self.gui.update_monitor(f"Robot {robot_id}: Reached goal!")
                                            self.request_next_waypoint(robot_id)
                                        else:
                                            self.gui.update_monitor(
                                                f"Robot {robot_id}: Reached waypoint (decentralized execution)"
                                            )
                                    elif status == 'trajectory_complete':
                                        self.gui.update_monitor(f"Robot {robot_id}: Trajectory execution complete")
                                        self.decentralized_execution[robot_id] = False
                                        if robot_id in self.robot_paths:
                                            del self.robot_paths[robot_id]
                                        if robot_id in self.robot_path_index:
                                            del self.robot_path_index[robot_id]
                                        self.visualizer.clear_ground_truth_path(robot_id)
                                    elif status == 'arrived':
                                        self.handle_arrival_notification(robot_id)
                                    else:
                                        self.gui.update_monitor(
                                            f"Robot {robot_id}: Control status: {status}"
                                        )
                            
                            elif data_type == 'arm_ik_result':
                                arm_data = message.get('data', {})
                                if self.log_rx_arm:
                                    print(f"[RX arm_ik] Robot {robot_id}: {arm_data}")
                                self.process_arm_ik_result(robot_id, arm_data)
                            
                            elif data_type == 'sync_position':
                                if self.log_rx_sync:
                                    print(f"[RX sync] Robot {robot_id}: x={message.get('x')}, y={message.get('y')}")
                                self.relay_sync_position(robot_id, message)
                            
                            else:
                                self.gui.update_monitor(f"Robot {robot_id}: Unknown data type: {data_type}")
                        else:
                            self.gui.update_monitor(f"Robot {robot_id}: Invalid message format: {line}")
                    
                    except json.JSONDecodeError:
                        self.gui.update_monitor(f"Robot {robot_id}: Invalid JSON received: {line}")
                    except Exception as e:
                        print(f"Robot {robot_id}: Error processing message: {e}")
        
        except Exception as e:
            print(f"Robot {robot_id}: Receive error: {e}")
        finally:
            self.disconnect_from_robot(robot_id)

    def send_kinematic_command(self, robot_id, dot_x, dot_y, dot_theta):
        """Send kinematic command to a specific robot"""
        if robot_id not in self.robot_connections:
            return
            
        command = f"dot_x:{dot_x:.4f} dot_y:{dot_y:.4f} dot_theta:{dot_theta:.4f}"
        
        try:
            sock = self.robot_connections[robot_id]
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((command + "\n").encode())
            if self.log_tx_kinematic:
                print(f"[TX kinematic] Robot {robot_id}: {command}")
        except Exception as e:
            print(f"Robot {robot_id}: Command send error: {e}")

    def send_command_to_robot(self, robot_id, command):
        """Send raw command string to a specific robot"""
        if robot_id not in self.robot_connections:
            return
            
        try:
            sock = self.robot_connections[robot_id]
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((command + "\n").encode())
            if self.log_tx_command:
                print(f"[TX command] Robot {robot_id}: {command}")
            self.gui.update_monitor(f"Robot {robot_id}: Sent command: {command}")
        except Exception as e:
            print(f"Robot {robot_id}: Command send error: {e}")

    # ========== ARM CONTROL METHODS ==========
    
    def send_arm_coordinates(self, robot_id, x, y, z, pitch):
        """Send arm IK coordinates to a specific robot"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id}: Not connected - cannot send arm coordinates")
            return
            
        payload = {
            "type": "arm_ik_request",
            "data": {"x": x, "y": y, "z": z, "pitch": pitch}
        }
        
        try:
            sock = self.robot_connections[robot_id]
            json_str = json.dumps(payload)
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((json_str + "\n").encode())
            if self.log_tx_arm:
                print(f"[TX arm_ik] Robot {robot_id}: X={x:.1f}, Y={y:.1f}, Z={z:.1f}, P={pitch:.1f}")
            self.gui.update_monitor(
                f"Robot {robot_id}: Sent arm IK request - X={x:.1f}, Y={y:.1f}, Z={z:.1f}, Pitch={pitch:.1f}"
            )
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error sending arm coordinates: {e}")
    
    def send_arm_servo_angles(self, robot_id, angles):
        """Send direct servo angles to robot arm"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id}: Not connected - cannot send servo angles")
            return
            
        payload = {"type": "arm_servo_cmd", "data": angles}
        
        try:
            sock = self.robot_connections[robot_id]
            json_str = json.dumps(payload)
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((json_str + "\n").encode())
            angles_str = ", ".join([f"{k}={v:.1f}" for k, v in angles.items()])
            if self.log_tx_arm:
                print(f"[TX arm_servo] Robot {robot_id}: {angles_str}")
            self.gui.update_monitor(f"Robot {robot_id}: Sent arm servo cmd - {angles_str}")
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error sending servo angles: {e}")
    
    def process_arm_ik_result(self, robot_id, arm_data):
        """Process IK result received from robot and update GUI"""
        try:
            angles_str = ", ".join([f"{k}={v:.2f}" for k, v in arm_data.items() if k.startswith('j')])
            self.gui.update_monitor(f"Robot {robot_id}: Received IK result - {angles_str}")
            
            if hasattr(self.gui, 'arm_guis') and robot_id in self.gui.arm_guis:
                self.gui.arm_guis[robot_id].update_received_angles(arm_data)
        except Exception as e:
            print(f"Robot {robot_id}: Error processing arm IK result: {e}")

    def send_arm_pick(self, robot_id, x, y, z):
        """Send arm pick command to robot"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id}: Not connected - cannot send pick command")
            return
            
        payload = {"type": "arm_pick", "data": {"x": x, "y": y, "z": z}}
        
        try:
            sock = self.robot_connections[robot_id]
            json_str = json.dumps(payload)
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((json_str + "\n").encode())
            if self.log_tx_arm:
                print(f"[TX arm_pick] Robot {robot_id}: X={x:.1f}, Y={y:.1f}, Z={z:.1f}")
            self.gui.update_monitor(f"Robot {robot_id}: Sent arm pick cmd - X={x:.1f}, Y={y:.1f}, Z={z:.1f}")
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error sending pick command: {e}")

    def send_arm_place(self, robot_id, x, y, z):
        """Send arm place command to robot"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id}: Not connected - cannot send place command")
            return
            
        payload = {"type": "arm_place", "data": {"x": x, "y": y, "z": z}}
        
        try:
            sock = self.robot_connections[robot_id]
            json_str = json.dumps(payload)
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((json_str + "\n").encode())
            if self.log_tx_arm:
                print(f"[TX arm_place] Robot {robot_id}: X={x:.1f}, Y={y:.1f}, Z={z:.1f}")
            self.gui.update_monitor(f"Robot {robot_id}: Sent arm place cmd - X={x:.1f}, Y={y:.1f}, Z={z:.1f}")
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error sending place command: {e}")

    def send_arm_gripper(self, robot_id, action):
        """Send arm gripper open/close command to robot"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id}: Not connected - cannot send gripper command")
            return
            
        payload = {"type": "arm_gripper", "data": {"action": action}}
        
        try:
            sock = self.robot_connections[robot_id]
            json_str = json.dumps(payload)
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((json_str + "\n").encode())
            if self.log_tx_arm:
                print(f"[TX arm_gripper] Robot {robot_id}: action={action}")
            self.gui.update_monitor(f"Robot {robot_id}: Sent arm gripper cmd - action={action}")
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error sending gripper command: {e}")

    def send_arm_rest(self, robot_id):
        """Send arm rest command to robot"""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id}: Not connected - cannot send rest command")
            return
            
        payload = {"type": "arm_rest"}
        
        try:
            sock = self.robot_connections[robot_id]
            json_str = json.dumps(payload)
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((json_str + "\n").encode())
            if self.log_tx_arm:
                print(f"[TX arm_rest] Robot {robot_id}")
            self.gui.update_monitor(f"Robot {robot_id}: Sent arm rest command")
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error sending rest command: {e}")

    # ========== POSITION RELAY ==========
    
    def relay_sync_position(self, source_robot_id, message):
        """Relay sync_position message from one robot to all other connected robots."""
        if self.sync_logging_enabled:
            try:
                server_ts = time.time()
                robot_id = message.get('id', f'robot{source_robot_id}')
                x = message.get('x', 0.0)
                y = message.get('y', 0.0)
                vx = message.get('vx', 0.0)
                vy = message.get('vy', 0.0)
                theta = message.get('theta', 0.0)
                robot_ts = message.get('ts', 0.0)
                pos_unc = message.get('pos_unc', 0.0)
                vel_unc = message.get('vel_unc', 0.0)
                
                log_entry = [f"{server_ts:.6f}", robot_id, f"{x:.6f}", f"{y:.6f}", 
                            f"{vx:.6f}", f"{vy:.6f}", f"{theta:.6f}", f"{robot_ts:.6f}", 
                            f"{pos_unc:.6f}", f"{vel_unc:.6f}"]
                
                self.sync_log_queue.put_nowait(log_entry)
            except queue.Full:
                pass
            except Exception as e:
                pass
        
        relay_msg_bytes = (json.dumps(message) + "\n").encode()
        
        def send_to_robot(target_id, sock, lock):
            try:
                # If we cannot acquire the mutex lock instantly, it means ApproachManager is currently
                # sending trajectories. We drop this sync_position so we don't build a massive queue.
                if not self.trajectory_sync_lock.acquire(blocking=False):
                    return
                try:
                    with lock:
                        sock.sendall(relay_msg_bytes)
                finally:
                    self.trajectory_sync_lock.release()
            except socket.timeout:
                pass
            except Exception as e:
                if "temporarily unavailable" not in str(e).lower():
                    print(f"Relay sync_position to robot {target_id} failed: {e}")
        
        for target_id, sock in self.robot_connections.items():
            if target_id != source_robot_id and target_id in self.socket_locks:
                self.executor.submit(send_to_robot, target_id, sock, self.socket_locks[target_id])

    def send_trajectory_to_robot(self, robot_id, trajectory_list, meta=None):
        """Send a full timestamped trajectory to the robot as a single JSON message."""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id} not connected - cannot send trajectory")
            return False

        payload = {
            "type": "load_trajectory",
            "trajectory": trajectory_list,
            "meta": meta or {}
        }

        try:
            sock = self.robot_connections[robot_id]
            json_str = json.dumps(payload)
            
            try:
                log_dir = "trajectory_logs"
                os.makedirs(log_dir, exist_ok=True)
                log_filename = os.path.join(log_dir, f"robot_{robot_id}.txt")
                with open(log_filename, "w") as f:
                    f.write(f"# Trajectory for Robot {robot_id}\n")
                    f.write("# x, y, theta, t\n")
                    for point in trajectory_list:
                        x = point['x']
                        y = point['y']
                        theta = point.get('theta', 0.0)
                        t = point['t']
                        f.write(f"{x:.4f}, {y:.4f}, {theta:.4f}, {t:.3f}\n")
                self.gui.update_monitor(f"Robot {robot_id}: Trajectory logged to {log_filename}")
            except Exception as log_e:
                self.gui.update_monitor(f"Robot {robot_id}: Warning - failed to log trajectory: {log_e}")
            
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((json_str + "\n").encode())
            if self.log_tx_trajectory:
                print(f"[TX trajectory] Robot {robot_id}: {len(trajectory_list)} points")
            self.gui.update_monitor(f"Robot {robot_id}: Sent full trajectory ({len(trajectory_list)} points)")
            return True
        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error sending trajectory: {e}")
            return False
            
    def send_position_goal(self, robot_id, x, y, theta=0.0):
        """Send a position goal to a specific robot"""
        if robot_id not in self.robot_connections:
            return
            
        command = f"x:{x:.2f} y:{y:.2f} theta:{theta:.2f}"
        
        try:
            sock = self.robot_connections[robot_id]
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((command + "\n").encode())
            if self.log_tx_position:
                print(f"[TX position_goal] Robot {robot_id}: {command}")
        except Exception as e:
            print(f"Robot {robot_id}: Position goal send error: {e}")
            
    def set_speed(self, robot_id, motor_index, speed):
        """Set speed for a specific motor on a specific robot"""
        if robot_id not in self.robot_connections:
            return
            
        self.speed[robot_id][motor_index] = speed
        try:
            command = f"MOTOR:{motor_index} SPEED:{speed}"
            sock = self.robot_connections[robot_id]
            with self.socket_locks.get(robot_id, threading.Lock()):
                sock.sendall((command + "\n").encode())
        except Exception as e:
            print(f"Robot {robot_id}: Set speed error: {e}")

    def emergency_stop(self, robot_id=None):
        """Send emergency stop command to one or all robots"""
        if robot_id is not None:
            if robot_id in self.robot_connections:
                try:
                    command = "STOP"
                    sock = self.robot_connections[robot_id]
                    with self.socket_locks.get(robot_id, threading.Lock()):
                        sock.sendall((command + "\n").encode())
                    self.gui.update_monitor(f"Robot {robot_id}: Emergency stop sent")
                except Exception as e:
                    print(f"Robot {robot_id}: Emergency stop error: {e}")
        else:
            for rid in self.robot_connections.keys():
                self.emergency_stop(rid)

    def send_set_pid(self, robot_id):
        """Send PID values to a specific robot"""
        if robot_id not in self.robot_connections:
            return
            
        try:
            for i in range(4):
                p, i_val, d = self.pid_values[robot_id][i]
                command = f"pid:{i} p:{p} i:{i_val} d:{d}"
                sock = self.robot_connections[robot_id]
                with self.socket_locks.get(robot_id, threading.Lock()):
                    sock.sendall((command + "\n").encode())
                if self.log_tx_pid:
                    print(f"[TX pid] Robot {robot_id}: motor={i} P={p} I={i_val} D={d}")
        except Exception as e:
            print(f"Robot {robot_id}: PID send error: {e}")
    
    def start_test_trajectory(self, robot_id, shape='square'):
        """Start a test trajectory for a specific robot."""
        if robot_id not in self.robot_connections:
            self.gui.update_monitor(f"Robot {robot_id} is not connected")
            return
        
        try:
            scale = 1.0
            center = (2.0, 2.0)
            points = 12 if shape == 'square' else 16
            path = get_test_trajectory(shape, scale, center, points)

            if not path:
                self.gui.update_monitor(f"Robot {robot_id}: Failed to generate {shape} trajectory")
                return

            stamped = timestamp_trajectory(path, start_time=time.time(), dt=1.0)
            self.robot_paths[robot_id] = path
            self.decentralized_execution[robot_id] = True
            self.visualizer.set_ground_truth_path(robot_id, path)

            meta = {"shape": shape, "scale": scale}
            sent_ok = self.send_trajectory_to_robot(robot_id, stamped, meta=meta)
            if not sent_ok:
                self.decentralized_execution[robot_id] = False
                self.robot_path_index[robot_id] = 0
                first_waypoint = path[0]
                self.send_position_goal(robot_id, first_waypoint[0], first_waypoint[1], 0.0)
                self.gui.update_monitor(f"Robot {robot_id}: Sent first waypoint (fallback) for {shape} trajectory")
                return

            exec_cmd = json.dumps({"type": "control", "cmd": "execute_trajectory"})
            self.send_command_to_robot(robot_id, exec_cmd)

            self.gui.update_monitor(
                f"Robot {robot_id}: Sent full {shape} trajectory ({len(path)} waypoints) and START command"
            )

        except Exception as e:
            self.gui.update_monitor(f"Robot {robot_id}: Error starting trajectory: {e}")
            print(f"Robot {robot_id}: Trajectory error: {e}")
    
    def request_next_waypoint(self, robot_id):
        """Send the next waypoint to a specific robot after reaching current goal."""
        if robot_id not in self.robot_paths or robot_id not in self.robot_path_index:
            return
        
        self.robot_path_index[robot_id] += 1
        current_index = self.robot_path_index[robot_id]
        path = self.robot_paths[robot_id]
        
        if current_index >= len(path):
            self.gui.update_monitor(
                f"Robot {robot_id}: Trajectory completed! ({len(path)} waypoints)"
            )
            del self.robot_paths[robot_id]
            del self.robot_path_index[robot_id]
            self.visualizer.clear_ground_truth_path(robot_id)
            return
        
        next_waypoint = path[current_index]
        self.send_position_goal(robot_id, next_waypoint[0], next_waypoint[1], 0.0)
        
        self.gui.update_monitor(
            f"Robot {robot_id}: Waypoint {current_index + 1}/{len(path)} sent: "
            f"({next_waypoint[0]:.2f}, {next_waypoint[1]:.2f})"
        )

    def show_trajectory_plot(self):
        """Display the trajectory visualization window"""
        self.visualizer.show()
        self.gui.update_monitor("Global trajectory visualization displayed")

    def show_robot_position_plot(self, robot_id):
        """Display the robot position visualization window"""
        pass  # Not available in web mode

    def show_rpm_plot(self, robot_id):
        """Display the RPM plot window"""
        pass  # Not available in web mode

    def set_pid_values(self, robot_id, motor_index, p, i, d):
        """Set PID values for a specific motor on a specific robot"""
        if robot_id not in self.pid_values:
            return
        self.pid_values[robot_id][motor_index] = [p, i, d]
        self.gui.update_pid_entries(robot_id, motor_index, p, i, d)

    def save_pid_config(self, robot_id):
        """Save PID configuration for a specific robot"""
        try:
            filename = f"pid_config_robot{robot_id}.txt"
            with open(filename, "w") as f:
                for i in range(4):
                    p, i_val, d = self.pid_values[robot_id][i]
                    f.write(f"{i},{p},{i_val},{d}\n")
            self.gui.update_monitor(f"Robot {robot_id}: PID config saved to {filename}")
        except Exception as e:
            print(f"Robot {robot_id}: Error saving PID config: {e}")

    def load_pid_config(self, robot_id):
        """Load PID configuration for a specific robot"""
        try:
            filename = f"pid_config_robot{robot_id}.txt"
            with open(filename, "r") as f:
                for line in f:
                    parts = line.strip().split(",")
                    if len(parts) == 4:
                        motor_idx = int(parts[0])
                        p = float(parts[1])
                        i_val = float(parts[2])
                        d = float(parts[3])
                        self.set_pid_values(robot_id, motor_idx, p, i_val, d)
            self.gui.update_monitor(f"Robot {robot_id}: PID config loaded from {filename}")
        except FileNotFoundError:
            self.gui.update_monitor(f"Robot {robot_id}: No PID config file found")
        except Exception as e:
            print(f"Robot {robot_id}: Error loading PID config: {e}")

    def _ui_update_worker(self):
        """Worker thread to process UI updates"""
        while self.ui_update_thread_active:
            try:
                update = self.ui_update_queue.get(timeout=0.1)
                if update is None:
                    break
                    
                update_type = update[0]
                robot_id = update[1]
                update_data = update[2] if len(update) > 2 else None
                
                self._process_ui_update(update_type, robot_id, update_data)
                
            except queue.Empty:
                continue
            except Exception as e:
                print(f"UI update worker error: {e}")
    
    def _sync_log_worker(self):
        """Worker thread to log sync_position messages asynchronously"""
        while self.sync_log_active:
            try:
                log_entry = self.sync_log_queue.get(timeout=0.1)
                if log_entry is None:
                    break
                
                if self.sync_log_writer and self.sync_log_file:
                    try:
                        self.sync_log_writer.writerow(log_entry)
                        if self.sync_log_queue.qsize() < 10:
                            self.sync_log_file.flush()
                    except Exception as e:
                        print(f"Error writing sync log: {e}")
                
            except queue.Empty:
                if self.sync_log_file:
                    try:
                        self.sync_log_file.flush()
                    except:
                        pass
                continue
            except Exception as e:
                print(f"Sync log worker error: {e}")

    def _process_ui_update(self, update_type, robot_id, update_data):
        """Process different types of UI updates"""
        try:
            if update_type == 'ekf':
                x, y, theta = update_data 
                self.update_robot_position_from_ekf(robot_id, x, y, theta)
                self.visualizer.update_ekf(robot_id, x, y)
                self.visualizer.update_position(robot_id, x, y, theta)
            
            elif update_type == 'bno055':
                x, y, vx, vy = update_data
                self.visualizer.update_bno055(robot_id, x, y, vx, vy)
            
            elif update_type == 'odometry':
                x, y, vx, vy = update_data
                self.visualizer.update_odometry(robot_id, x, y, vx, vy)
            
            elif update_type == 'localization':
                x, y = update_data
                self.visualizer.update_localization(robot_id, x, y)
        except Exception as e:
            print(f"Error processing UI update: {e}")

    # ========== PHASE 1: APPROACH METHODS ==========
    
    def set_object_position(self, x, y, length=None, width=None):
        """Set the position and dimensions of the object to be grasped."""
        self.object_position = (float(x), float(y))
        if length is not None:
            self.object_length = float(length)
        if width is not None:
            self.object_width = float(width)
            
        max_dimension = max(self.object_length, self.object_width)
        object_radius = max_dimension / 2
        auto_grip_radius = object_radius + self.gripper_length + self.robot_radius
        
        self.formation_planner.grip_radius = auto_grip_radius
        self.gui.update_monitor(
            f"Auto grip_radius = {auto_grip_radius:.3f}m "
            f"(obj_max/2={object_radius:.2f} + gripper={self.gripper_length:.2f} + robot_r={self.robot_radius:.2f})"
        )
        
        self.gui.update_monitor(
            f"Object position set: ({x:.2f}, {y:.2f}), size: {self.object_length:.2f}m x {self.object_width:.2f}m"
        )
        
        self.visualizer.set_object_position(x, y, self.object_length, self.object_width)
    
    def set_manual_robot_position(self, robot_id, x, y, theta=0.0):
        """Set manual robot position for testing purposes."""
        self.manual_positions[robot_id] = (float(x), float(y), float(theta))
        self.gui.update_monitor(
            f"Robot {robot_id} manual position: ({x:.2f}, {y:.2f}, theta={theta:.2f})"
        )
    
    def get_robot_position(self, robot_id):
        """Get current robot position (from EKF or manual)."""
        if self.use_manual_positions and robot_id in self.manual_positions:
            pos = self.manual_positions[robot_id]
            return (pos[0], pos[1])
        
        if robot_id in self.robot_positions:
            pos = self.robot_positions[robot_id]
            return (pos[0], pos[1])
        
        return None
    
    def set_use_manual_positions(self, use_manual):
        """Toggle between manual and EKF positions."""
        self.use_manual_positions = use_manual
        mode = "manual (testing)" if use_manual else "EKF (real)"
        self.gui.update_monitor(f"Position mode: {mode}")
    
    def set_num_robots(self, num_robots):
        """Set the number of robots for formation."""
        self.formation_planner.set_num_robots(num_robots)
        self.gui.update_monitor(f"Formation configured for {num_robots} robots")
    
    def set_gripper_length(self, length):
        """Set the gripper length."""
        self.gripper_length = float(length)
        if self.object_length and self.object_width:
            max_dimension = max(self.object_length, self.object_width)
            object_radius = max_dimension / 2
            grip_radius = object_radius + self.gripper_length + self.robot_radius
            self.formation_planner.grip_radius = grip_radius
            self.gui.update_monitor(
                f"Gripper length set to {length*100:.1f}cm -> grip_radius = {grip_radius:.3f}m"
            )
        else:
            self.gui.update_monitor(f"Gripper length set to {length*100:.1f}cm")
    
    def set_grip_radius(self, radius):
        """DEPRECATED: Use set_gripper_length instead."""
        self.formation_planner.grip_radius = float(radius)
        self.gui.update_monitor(f"Grip radius set to {radius:.2f}m (DEPRECATED)")
    
    def set_active_robots(self, robot_ids):
        """Set which robots are active (connected)."""
        self.formation_planner.set_active_robots(robot_ids)
        self.gui.update_monitor(f"Active robots: {robot_ids}")
    
    def add_obstacle(self, x, y, radius):
        """Add a circular obstacle to the path planner."""
        self.path_planner.add_circular_obstacle(x, y, radius)
        self.gui.update_monitor(f"Added obstacle at ({x:.2f}, {y:.2f}), r={radius:.2f}m")
        self.visualizer.set_obstacles(self.path_planner.get_obstacles())
    
    def add_rectangular_obstacle(self, x1, y1, x2, y2):
        """Add a rectangular obstacle to the path planner."""
        self.path_planner.add_rectangular_obstacle(x1, y1, x2, y2)
        self.gui.update_monitor(f"Added rectangular obstacle: ({x1:.2f},{y1:.2f})-({x2:.2f},{y2:.2f})")
        self.visualizer.set_obstacles(self.path_planner.get_obstacles())
    
    def clear_obstacles(self):
        """Clear all obstacles from the path planner."""
        self.path_planner.clear_obstacles()
        self.gui.update_monitor("All obstacles cleared")
        self.visualizer.set_obstacles([])
    
    def compute_approach_trajectories(self, use_vector_field=True, use_collision_avoidance=True):
        """Compute approach trajectories. Delegates to ApproachManager."""
        return self.approach_manager.compute_approach_trajectories(use_vector_field, use_collision_avoidance)
    
    def start_approach_phase(self, use_vector_field=True):
        """Start the approach phase. Delegates to ApproachManager."""
        return self.approach_manager.start_approach_phase(use_vector_field)
    
    def handle_arrival_notification(self, robot_id):
        """Handle arrival notification. Delegates to ApproachManager."""
        self.approach_manager.handle_arrival_notification(robot_id)
    
    def check_all_arrived(self):
        """Check if all robots arrived. Delegates to ApproachManager."""
        return self.approach_manager.check_all_arrived()
    
    def abort_approach_phase(self):
        """Abort approach phase. Delegates to ApproachManager."""
        self.approach_manager.abort_approach_phase()
    
    def get_approach_status(self):
        """Get approach status. Delegates to ApproachManager."""
        return self.approach_manager.get_approach_status()
    
    def update_robot_position_from_ekf(self, robot_id, x, y, theta):
        """Update robot position from EKF data."""
        self.robot_positions[robot_id] = (float(x), float(y), float(theta))
    
    # ========== PHASE 2: TRANSPORT METHODS ==========
    
    def set_destination_position(self, x, y):
        """Set destination position. Delegates to TransportManager."""
        self.transport_manager.set_destination_position(x, y)
    
    def compute_transport_trajectories(self):
        """Compute transport trajectories. Delegates to TransportManager."""
        return self.transport_manager.compute_transport_trajectories()
    
    def start_transport_phase(self):
        """Start transport phase. Delegates to TransportManager."""
        return self.transport_manager.start_transport_phase()
    
    def handle_transport_completion(self, robot_id):
        """Handle transport completion. Delegates to TransportManager."""
        self.transport_manager.handle_transport_completion(robot_id)
    
    def abort_transport_phase(self):
        """Abort transport phase. Delegates to TransportManager."""
        self.transport_manager.abort_transport_phase()
    
    def get_transport_status(self):
        """Get transport status. Delegates to TransportManager."""
        return self.transport_manager.get_transport_status()
