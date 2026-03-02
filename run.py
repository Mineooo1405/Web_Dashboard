#!/usr/bin/env python3
"""
Quick launcher for the Robot Web Dashboard.

Usage:
    python run.py
    python run.py --host 0.0.0.0 --port 8000
"""
import argparse
import uvicorn


def main():
    parser = argparse.ArgumentParser(description="Robot Web Dashboard")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="Port (default: 8000)")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args()

    print("=" * 60)
    print("  Robot Web Dashboard")
    print(f"  Open http://localhost:{args.port} in your browser")
    print("=" * 60)

    uvicorn.run(
        "app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
