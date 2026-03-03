import os
import sys
import json
import asyncio
import threading
import time
import signal
import socket
import argparse
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, PlainTextResponse
import uvicorn

from web_gui import WebGUI
from server_core.server import Server


# ============================================================
# Log Toggle Flags
# Set True/False to enable/disable logging for each component.
# RX = packets received, TX = packets sent
# ============================================================

# --- WebSocket (browser <-> server) ---
LOG_WS_RX          = True   # Commands received from browser (connect, kinematic, arm, etc.)
LOG_WS_TX          = False  # State updates broadcast to browser (high frequency, verbose)

# --- Robot TCP: Received (robot -> server) ---
LOG_ROBOT_RX_ENCODER   = False  # Encoder data (very high frequency)
LOG_ROBOT_RX_BNO055    = False  # BNO055 heading / IMU data (high frequency)
LOG_ROBOT_RX_POSITION  = False  # Position source data (EKF, odometry, localization)
LOG_ROBOT_RX_PID       = True   # PID config data received from robot
LOG_ROBOT_RX_CONTROL   = True   # Control status (reached_goal, trajectory_complete, arrived)
LOG_ROBOT_RX_ARM       = True   # Arm IK result
LOG_ROBOT_RX_SYNC      = False  # Sync position relay (high frequency in transport)
LOG_ROBOT_RX_LOG       = True   # Log messages from robot firmware

# --- Robot TCP: Sent (server -> robot) ---
LOG_ROBOT_TX_KINEMATIC   = False  # Kinematic velocity commands (high frequency during control)
LOG_ROBOT_TX_COMMAND     = True   # Raw string commands
LOG_ROBOT_TX_TRAJECTORY  = True   # Trajectory data sent to robot
LOG_ROBOT_TX_PID         = True   # PID set commands
LOG_ROBOT_TX_ARM         = True   # Arm IK / servo / pick / place / gripper / rest
LOG_ROBOT_TX_POSITION    = True   # Position goal commands
LOG_ROBOT_TX_FIRMWARE    = True   # Firmware upgrade commands


# ============================================================
# WebSocket Connection Manager
# ============================================================
class WSManager:
    def __init__(self):
        self.connections: list[WebSocket] = []
        self._lock = threading.Lock()
        self._loop = None

    def set_loop(self, loop):
        self._loop = loop

    async def connect(self, ws: WebSocket):
        await ws.accept()
        with self._lock:
            self.connections.append(ws)

    def disconnect(self, ws: WebSocket):
        with self._lock:
            if ws in self.connections:
                self.connections.remove(ws)

    def broadcast(self, data: dict):
        """Thread-safe broadcast to all connected clients"""
        if not self.connections:
            return
        if LOG_WS_TX:
            msg_type = data.get('type', '?')
            print(f"[WS TX] type={msg_type}  clients={len(self.connections)}")
        message = json.dumps(data, default=str)
        if self._loop and self._loop.is_running():
            asyncio.run_coroutine_threadsafe(self._async_broadcast(message), self._loop)

    async def _async_broadcast(self, message: str):
        dead = []
        with self._lock:
            clients = list(self.connections)
        for ws in clients:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


# ============================================================
# App Setup
# ============================================================
ws_manager = WSManager()
web_gui = WebGUI(ws_manager)
server = Server(web_gui)
web_gui.set_server(server)

# Apply log toggle flags to server
server.log_rx_encoder    = LOG_ROBOT_RX_ENCODER
server.log_rx_bno055     = LOG_ROBOT_RX_BNO055
server.log_rx_position   = LOG_ROBOT_RX_POSITION
server.log_rx_pid        = LOG_ROBOT_RX_PID
server.log_rx_control    = LOG_ROBOT_RX_CONTROL
server.log_rx_arm        = LOG_ROBOT_RX_ARM
server.log_rx_sync       = LOG_ROBOT_RX_SYNC
server.log_rx_log        = LOG_ROBOT_RX_LOG
server.log_tx_kinematic  = LOG_ROBOT_TX_KINEMATIC
server.log_tx_command    = LOG_ROBOT_TX_COMMAND
server.log_tx_trajectory = LOG_ROBOT_TX_TRAJECTORY
server.log_tx_pid        = LOG_ROBOT_TX_PID
server.log_tx_arm        = LOG_ROBOT_TX_ARM
server.log_tx_position   = LOG_ROBOT_TX_POSITION
server.log_tx_firmware   = LOG_ROBOT_TX_FIRMWARE

# ============================================================
# Lifespan (replaces deprecated @app.on_event)
# ============================================================
@asynccontextmanager
async def lifespan(application: FastAPI):
    # --- startup ---
    ws_manager.set_loop(asyncio.get_event_loop())
    yield
    # --- shutdown ---


app = FastAPI(title="Robot Web Dashboard", lifespan=lifespan)

# Serve static files
static_dir = os.path.join(os.path.dirname(__file__), 'static')
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
async def root():
    return FileResponse(
        os.path.join(static_dir, "index.html"),
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        }
    )


# ============================================================
# WebSocket endpoint
# ============================================================
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        # Send current state to new client
        await ws.send_text(json.dumps(web_gui.get_full_state(), default=str))
        await ws.send_text(json.dumps(web_gui.visualizer.get_full_state(), default=str))
        
        # Listen for commands
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)
            action = msg.get('action', '')
            
            if LOG_WS_RX:
                print(f"[WS RX] action={action}  payload_keys={list(msg.keys())}")
            
            # Process command in thread pool to avoid blocking
            await asyncio.get_event_loop().run_in_executor(
                None, process_command, msg
            )
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
    except Exception as e:
        print(f"WebSocket error: {e}")
        ws_manager.disconnect(ws)


def process_command(msg):
    """Process a command from the WebSocket client (runs in thread)"""
    action = msg.get('action', '')
    
    try:
        # ---- Connection ----
        if action == 'connect':
            robot_id = int(msg['robot_id'])
            host = msg['host']
            port = int(msg['port'])
            server.connect_to_robot(robot_id, host, port)
        
        elif action == 'disconnect':
            robot_id = int(msg['robot_id'])
            server.disconnect_from_robot(robot_id)
        
        elif action == 'disconnect_all':
            server.disconnect_all_robots()
        
        # ---- Kinematic control ----
        elif action == 'kinematic':
            robot_id = int(msg['robot_id'])
            server.send_kinematic_command(
                robot_id,
                float(msg.get('dot_x', 0)),
                float(msg.get('dot_y', 0)),
                float(msg.get('dot_theta', 0))
            )
        
        elif action == 'emergency_stop':
            robot_id = msg.get('robot_id')
            if robot_id is not None:
                server.emergency_stop(int(robot_id))
            else:
                server.emergency_stop()
        
        elif action == 'send_command':
            robot_id = int(msg['robot_id'])
            command = msg['command']
            server.send_command_to_robot(robot_id, command)
        
        # ---- Motor / PID ----
        elif action == 'set_motor_speed':
            robot_id = int(msg['robot_id'])
            motor = int(msg['motor'])
            speed = float(msg['speed'])
            server.set_speed(robot_id, motor, speed)
        
        elif action == 'set_pid':
            robot_id = int(msg['robot_id'])
            motor = int(msg['motor'])
            p = float(msg['p'])
            i = float(msg['i'])
            d = float(msg['d'])
            server.set_pid_values(robot_id, motor, p, i, d)
            server.send_set_pid(robot_id)
        
        elif action == 'save_pid':
            robot_id = int(msg['robot_id'])
            server.save_pid_config(robot_id)
        
        elif action == 'load_pid':
            robot_id = int(msg['robot_id'])
            server.load_pid_config(robot_id)
        
        # ---- Test trajectories ----
        elif action == 'test_trajectory':
            robot_id = int(msg['robot_id'])
            shape = msg.get('shape', 'square')
            server.start_test_trajectory(robot_id, shape)
        
        # ---- Arm control ----
        elif action == 'arm_ik':
            robot_id = int(msg['robot_id'])
            server.send_arm_coordinates(
                robot_id,
                float(msg['x']), float(msg['y']),
                float(msg['z']), float(msg['pitch'])
            )
        
        elif action == 'arm_servo':
            robot_id = int(msg['robot_id'])
            angles = {f'j{i}': float(msg[f'j{i}']) for i in range(6) if f'j{i}' in msg}
            server.send_arm_servo_angles(robot_id, angles)
        
        elif action == 'arm_pick':
            robot_id = int(msg['robot_id'])
            server.send_arm_pick(robot_id, float(msg['x']), float(msg['y']), float(msg['z']))
        
        elif action == 'arm_place':
            robot_id = int(msg['robot_id'])
            server.send_arm_place(robot_id, float(msg['x']), float(msg['y']), float(msg['z']))
        
        elif action == 'arm_gripper':
            robot_id = int(msg['robot_id'])
            server.send_arm_gripper(robot_id, msg['gripper_action'])
        
        elif action == 'arm_rest':
            robot_id = int(msg['robot_id'])
            server.send_arm_rest(robot_id)
        
        # ---- Phase 1: Approach ----
        elif action == 'set_object':
            server.set_object_position(
                float(msg['x']), float(msg['y']),
                float(msg.get('length', 0.3)),
                float(msg.get('width', 0.3))
            )
        
        elif action == 'set_config':
            if 'num_robots' in msg:
                server.set_num_robots(int(msg['num_robots']))
            if 'gripper_length' in msg:
                server.set_gripper_length(float(msg['gripper_length']))
        
        elif action == 'add_obstacle':
            server.add_obstacle(float(msg['x']), float(msg['y']), float(msg['r']))
        
        elif action == 'clear_obstacles':
            server.clear_obstacles()
        
        elif action == 'set_manual_position':
            robot_id = int(msg['robot_id'])
            server.set_use_manual_positions(True)
            server.set_manual_robot_position(
                robot_id,
                float(msg['x']), float(msg['y']),
                float(msg.get('theta', 0.0))
            )
        
        elif action == 'start_approach':
            use_vf = msg.get('use_vector_field', True)
            server.start_approach_phase(use_vector_field=use_vf)
        
        elif action == 'abort_approach':
            server.abort_approach_phase()
        
        elif action == 'compute_trajectories':
            use_vf = msg.get('use_vector_field', True)
            result = server.compute_approach_trajectories(use_vector_field=use_vf)
            if result:
                web_gui.update_monitor(f"Trajectories computed: {len(result)} robots")
            else:
                web_gui.update_monitor("Failed to compute trajectories")
        
        # ---- Phase 2: Transport ----
        elif action == 'set_destination':
            server.set_destination_position(float(msg['x']), float(msg['y']))
        
        elif action == 'start_transport':
            server.start_transport_phase()
        
        elif action == 'abort_transport':
            server.abort_transport_phase()
        
        # ---- Settings ----
        elif action == 'set_logging':
            server.log_data = msg.get('enabled', True)
        
        elif action == 'set_execution_offset':
            server.execution_time_offset = float(msg.get('offset', 5.0))
        
        elif action == 'set_approach_velocity':
            server.approach_velocity = float(msg.get('velocity', 0.2))
        
        elif action == 'set_transport_velocity':
            server.transport_velocity = float(msg.get('velocity', 0.15))
        
        # ---- Firmware ----
        elif action == 'firmware_upgrade':
            robot_id = int(msg['robot_id'])
            server.send_upgrade_command(robot_id)
        
        else:
            web_gui.update_monitor(f"Unknown action: {action}")
    
    except Exception as e:
        web_gui.update_monitor(f"Command error ({action}): {e}")
        import traceback
        traceback.print_exc()


# ============================================================
# Connection profiles API
# ============================================================
@app.get("/api/profiles")
async def get_profiles():
    profiles = {}
    try:
        config_path = os.path.join(os.path.dirname(__file__), 'connection_config.txt')
        with open(config_path, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    parts = line.split(':')
                    if len(parts) == 3:
                        profiles[parts[0].strip()] = {
                            'host': parts[1].strip(),
                            'port': int(parts[2].strip())
                        }
    except FileNotFoundError:
        profiles = {
            'Robot 1': {'host': '192.168.1.211', 'port': 2004},
        }
    return profiles


# ============================================================
# Analytics API — Log file access
# ============================================================
@app.get("/api/logs")
async def list_logs():
    """List all CSV log files in the logs/ directory"""
    log_dir = os.path.join(os.path.dirname(__file__), 'logs')
    if not os.path.isdir(log_dir):
        return []
    files = [f for f in os.listdir(log_dir) if f.endswith('.csv')]
    files.sort(reverse=True)
    return files


@app.get("/api/logs/{filename}")
async def get_log(filename: str):
    """Return the raw content of a log CSV file"""
    log_dir = os.path.join(os.path.dirname(__file__), 'logs')
    filepath = os.path.join(log_dir, filename)
    # Security: ensure the file is inside the logs directory
    if not os.path.realpath(filepath).startswith(os.path.realpath(log_dir)):
        return PlainTextResponse("Forbidden", status_code=403)
    if not os.path.isfile(filepath):
        return PlainTextResponse("Not found", status_code=404)
    return FileResponse(filepath, media_type='text/csv')


# ============================================================
# Helpers
# ============================================================
def _free_port(port: int) -> bool:
    """Kill any process occupying *port*. Returns True if freed."""
    if sys.platform == 'win32':
        import subprocess
        try:
            out = subprocess.check_output(
                f'netstat -ano | findstr :{port}', shell=True, text=True
            )
            for line in out.strip().splitlines():
                parts = line.split()
                if 'LISTENING' in parts:
                    pid = int(parts[-1])
                    if pid != os.getpid():
                        os.kill(pid, signal.SIGTERM)
                        time.sleep(0.3)
                        print(f"[port] Killed PID {pid} on port {port}")
            return True
        except subprocess.CalledProcessError:
            return True          # nothing on this port
    else:
        # Linux/macOS: fuser or lsof
        import subprocess
        try:
            subprocess.run(f'fuser -k {port}/tcp', shell=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.3)
        except Exception:
            pass
        return True


def _port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) != 0


# ============================================================
# Main
# ============================================================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Robot Web Dashboard")
    parser.add_argument('--port', '-p', type=int, default=8000,
                        help='HTTP port (default: 8000)')
    parser.add_argument('--no-kill', action='store_true',
                        help='Do not auto-kill process on the port')
    args = parser.parse_args()

    port = args.port

    # Auto-free the port if occupied
    if not _port_available(port):
        if args.no_kill:
            print(f"[ERROR] Port {port} is already in use. ")
            print(f"        Use --port <N> to choose another port, "
                  f"or remove --no-kill to auto-free it.")
            sys.exit(1)
        print(f"[port] Port {port} in use — freeing...")
        _free_port(port)
        # Verify
        time.sleep(0.5)
        if not _port_available(port):
            print(f"[ERROR] Could not free port {port}. Kill it manually or use --port <N>.")
            sys.exit(1)
        print(f"[port] Port {port} is now available.")

    print("=" * 60)
    print("  Robot Web Dashboard")
    print(f"  Open http://localhost:{port} in your browser")
    print("=" * 60)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
