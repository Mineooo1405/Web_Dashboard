"""
Server Core — extracted robot server logic for the Web Dashboard.

This package contains all the server-side robot control logic,
originally from the server/ directory, refactored as a standalone package.
"""
from .server import Server
from .path_planner import PathPlanner, get_path_planner
from .formation_planner import FormationPlanner
from .approach_manager import ApproachManager
from .transport_manager import TransportManager
