#!/usr/bin/env python3
"""Read a bounded AT-SPI tree and return JSON-RPC responses on stdout."""

import json
import sys

try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as error:  # pragma: no cover - exercised only on live Linux
    Atspi = None
    ATSPI_IMPORT_ERROR = str(error)
else:
    ATSPI_IMPORT_ERROR = None


MAX_NODES = 2048
MAX_DEPTH = 64
WINDOW_ROLE_NAMES = {"frame", "window", "dialog"}


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def rect_for(accessible):
    try:
        component = accessible.get_component_iface()
        rect = component.get_extents(Atspi.CoordType.SCREEN)
        return {
            "x": float(rect.x),
            "y": float(rect.y),
            "width": max(0.0, float(rect.width)),
            "height": max(0.0, float(rect.height)),
        }
    except Exception:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}


def text_or_none(value):
    return value if isinstance(value, str) and value else None


def node_for(accessible, depth, budget):
    if depth > MAX_DEPTH or budget[0] >= MAX_NODES:
        return None
    budget[0] += 1
    try:
        role = accessible.get_role_name() or "unknown"
    except Exception:
        role = "unknown"
    try:
        label = text_or_none(accessible.get_name())
    except Exception:
        label = None
    try:
        description = text_or_none(accessible.get_description())
    except Exception:
        description = None
    value = None
    try:
        value_iface = accessible.get_value_iface()
        value = text_or_none(str(value_iface.get_current_value()))
    except Exception:
        pass

    children = []
    try:
        count = accessible.get_child_count()
        for index in range(min(count, MAX_NODES)):
            child = accessible.get_child_at_index(index)
            if child is None:
                continue
            child_node = node_for(child, depth + 1, budget)
            if child_node is not None:
                children.append(child_node)
    except Exception:
        pass

    return {
        "role": role,
        "label": label,
        "value": value,
        "description": description,
        "frame": rect_for(accessible),
        "activationPoint": None,
        "children": children,
    }


def process_id(accessible):
    try:
        value = accessible.get_process_id()
        return int(value) if value and int(value) > 0 else None
    except Exception:
        return None


def role_name(accessible):
    try:
        value = accessible.get_role_name()
        return value.strip().casefold() if isinstance(value, str) else ""
    except Exception:
        return ""


def is_window_candidate(accessible):
    try:
        role = accessible.get_role()
        if role in (Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG):
            return True
    except Exception:
        pass
    return role_name(accessible) in WINDOW_ROLE_NAMES


def same_window_score(accessible, requested, inherited_pid=None):
    if not is_window_candidate(accessible):
        return None

    requested_pid = requested.get("pid")
    score = 0
    if requested_pid is not None:
        actual_pid = process_id(accessible) or inherited_pid
        if actual_pid != requested_pid:
            return None
        score += 100

    requested_title = (requested.get("title") or "").strip().casefold()
    try:
        name = (accessible.get_name() or "").strip().casefold()
    except Exception:
        name = ""
    if requested_title:
        if name == requested_title:
            score += 100
        elif requested_title in name or name in requested_title:
            score += 30
        elif requested_pid is None:
            return None
    elif requested_pid is None:
        return None

    requested_bounds = requested.get("bounds")
    actual_bounds = rect_for(accessible)
    if isinstance(requested_bounds, dict):
        requested_width = requested_bounds.get("width")
        requested_height = requested_bounds.get("height")
        if (
            isinstance(requested_width, (int, float))
            and isinstance(requested_height, (int, float))
            and actual_bounds["width"] > 0
            and actual_bounds["height"] > 0
        ):
            width_delta = abs(actual_bounds["width"] - float(requested_width))
            height_delta = abs(actual_bounds["height"] - float(requested_height))
            if width_delta <= 2 and height_delta <= 2:
                score += 40
            elif width_delta <= 8 and height_delta <= 8:
                score += 20
            elif width_delta <= 64 and height_delta <= 64:
                score += 5
    return score


def same_window(accessible, requested):
    return same_window_score(accessible, requested) is not None


def find_window_match(accessible, requested, depth=0, budget=None, inherited_pid=None):
    if budget is None:
        budget = [0]
    if depth > MAX_DEPTH or budget[0] >= MAX_NODES:
        return None
    budget[0] += 1

    actual_pid = process_id(accessible) or inherited_pid
    score = same_window_score(accessible, requested, inherited_pid)
    best = (score, accessible) if score is not None else None
    try:
        count = accessible.get_child_count()
        for index in range(min(count, MAX_NODES)):
            child = accessible.get_child_at_index(index)
            if child is None:
                continue
            found = find_window_match(child, requested, depth + 1, budget, actual_pid)
            if found is not None and (best is None or found[0] > best[0]):
                best = found
    except Exception:
        pass
    return best


def find_window(accessible, requested):
    match = find_window_match(accessible, requested)
    return match[1] if match is not None else None


def client_size_for(window):
    rect = rect_for(window)
    return {"width": rect["width"], "height": rect["height"]}


def read_tree(params):
    if Atspi is None:
        raise RuntimeError("PyGObject Atspi is unavailable: " + ATSPI_IMPORT_ERROR)
    desktop = Atspi.get_desktop(0)
    trees = []
    for requested in params.get("windows", []):
        if not isinstance(requested, dict) or not isinstance(requested.get("id"), str):
            continue
        window = find_window(desktop, requested)
        if window is None:
            continue
        budget = [0]
        root = node_for(window, 0, budget)
        if root is None:
            continue
        trees.append(
            {
                "windowId": requested["id"],
                "clientSize": client_size_for(window),
                "root": root,
            }
        )
    return {"trees": trees}


def main():
    for line in sys.stdin:
        try:
            message = json.loads(line)
            request_id = message.get("id")
            method = message.get("method")
            params = message.get("params") or {}
            if method != "read-tree":
                raise ValueError("Unknown AT-SPI helper method")
            emit({"jsonrpc": "2.0", "id": request_id, "result": read_tree(params)})
        except Exception as error:
            emit(
                {
                    "jsonrpc": "2.0",
                    "id": locals().get("request_id"),
                    "error": {"code": -32000, "message": str(error)},
                }
            )


if __name__ == "__main__":
    main()
