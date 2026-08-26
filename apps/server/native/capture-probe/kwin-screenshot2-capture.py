#!/usr/bin/env python3
# Demonstrates one normal-process KWin ScreenShot2 pipe-fd capture and reports
# the bus or permission failure without retrying.
"""Make one normal-process KWin ScreenShot2 pipe-fd capture, or report why it failed.

This probe performs exactly one Capture* call. It writes successful raw output only
under /tmp and does not use KWin's diagnostic permission-bypass environment variable.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import sys
import threading
import time

import dbus


SERVICE = "org.kde.KWin"
OBJECT = "/org/kde/KWin/ScreenShot2"
INTERFACE = "org.kde.KWin.ScreenShot2"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--method",
        choices=("area", "active-screen", "window"),
        default="area",
        help="one ScreenShot2 method; the default is a small CaptureArea probe",
    )
    parser.add_argument("--x", type=int, default=0, help="CaptureArea logical x")
    parser.add_argument("--y", type=int, default=0, help="CaptureArea logical y")
    parser.add_argument("--width", type=int, default=320, help="CaptureArea width")
    parser.add_argument("--height", type=int, default=200, help="CaptureArea height")
    parser.add_argument(
        "--window-handle",
        help="KWin window handle for CaptureWindow; required with --method window",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="raw output path, which must be a new file below /tmp",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> Path:
    if args.width <= 0 or args.height <= 0:
        raise ValueError("width and height must be positive")
    if args.width * args.height > 4_000_000:
        raise ValueError("refusing a region larger than four million pixels")
    if args.method == "window" and not args.window_handle:
        raise ValueError("--window-handle is required for --method window")

    output = args.output or Path(f"/tmp/synara-kwin-capture-{os.getpid()}.raw")
    if not output.is_absolute() or output.parent != Path("/tmp"):
        raise ValueError("--output must be a direct child of /tmp")
    if output.exists():
        raise ValueError(f"refusing to overwrite existing file: {output}")
    return output


def capture(args: argparse.Namespace, output: Path) -> int:
    read_fd, write_fd = os.pipe()
    payload = bytearray()
    reader_error: list[BaseException] = []

    def read_pipe() -> None:
        try:
            while True:
                chunk = os.read(read_fd, 1024 * 1024)
                if not chunk:
                    return
                payload.extend(chunk)
        except BaseException as error:  # report the pipe failure after the call
            reader_error.append(error)

    reader = threading.Thread(target=read_pipe, name="kwin-capture-reader")
    reader.start()
    call_started = time.perf_counter_ns()

    try:
        bus = dbus.SessionBus()
        proxy = bus.get_object(SERVICE, OBJECT)
        iface = dbus.Interface(proxy, dbus_interface=INTERFACE)
        options = dbus.Dictionary(
            {
                "include-cursor": dbus.Boolean(False),
                "include-decoration": dbus.Boolean(True),
                "include-shadow": dbus.Boolean(False),
                "native-resolution": dbus.Boolean(True),
            },
            signature="sv",
        )
        pipe_fd = dbus.types.UnixFd(write_fd)

        if args.method == "area":
            metadata = iface.CaptureArea(
                dbus.Int32(args.x),
                dbus.Int32(args.y),
                dbus.UInt32(args.width),
                dbus.UInt32(args.height),
                options,
                pipe_fd,
                timeout=10.0,
            )
        elif args.method == "active-screen":
            metadata = iface.CaptureActiveScreen(options, pipe_fd, timeout=10.0)
        else:
            metadata = iface.CaptureWindow(
                dbus.String(args.window_handle), options, pipe_fd, timeout=10.0
            )
        call_elapsed_ms = (time.perf_counter_ns() - call_started) / 1_000_000
    except Exception as error:
        call_elapsed_ms = (time.perf_counter_ns() - call_started) / 1_000_000
        os.close(write_fd)
        reader.join(timeout=2.0)
        os.close(read_fd)
        print(
            f"D-BUS-UNAVAILABLE-OR-CALL-FAILED: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        print(f"method={args.method} call_elapsed_ms={call_elapsed_ms:.3f}")
        return 2

    os.close(write_fd)
    reader.join(timeout=10.0)
    os.close(read_fd)
    total_elapsed_ms = (time.perf_counter_ns() - call_started) / 1_000_000

    if reader.is_alive():
        print("capture pipe did not close within 10 seconds", file=sys.stderr)
        return 3
    if reader_error:
        print(f"capture pipe failed: {reader_error[0]}", file=sys.stderr)
        return 3

    output.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    print(f"method={args.method}")
    print(f"metadata={dict(metadata)!r}")
    print(f"bytes={len(payload)} sha256={digest}")
    print(f"call_elapsed_ms={call_elapsed_ms:.3f} total_elapsed_ms={total_elapsed_ms:.3f}")
    print(f"output={output}")
    return 0


def main() -> int:
    args = parse_args()
    try:
        output = validate_args(args)
    except ValueError as error:
        print(f"invalid arguments: {error}", file=sys.stderr)
        return 2
    return capture(args, output)


if __name__ == "__main__":
    raise SystemExit(main())
