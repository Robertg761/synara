import importlib.util
import unittest
from pathlib import Path


HELPER_PATH = Path(__file__).with_name("atspi_helper.py")
SPEC = importlib.util.spec_from_file_location("synara_atspi_helper", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(HELPER)


class FakeRole:
    FRAME = "frame"
    WINDOW = "window"
    DIALOG = "dialog"


class FakeCoordType:
    SCREEN = "screen"


class FakeAtspi:
    Role = FakeRole
    CoordType = FakeCoordType


class FakeRect:
    def __init__(self, width, height):
        self.x = 0
        self.y = 0
        self.width = width
        self.height = height


class FakeAccessible:
    def __init__(self, role, name="", pid=None, width=0, height=0, children=None):
        self.role = role
        self.name = name
        self.pid = pid
        self.rect = FakeRect(width, height)
        self.children = children or []

    def get_role(self):
        return self.role

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_process_id(self):
        return self.pid

    def get_component_iface(self):
        return self

    def get_extents(self, _coord_type):
        return self.rect

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]

    def get_description(self):
        return ""

    def get_value_iface(self):
        raise RuntimeError("no value")


class AtspiHelperTest(unittest.TestCase):
    def setUp(self):
        HELPER.Atspi = FakeAtspi

    def test_descends_through_application_to_find_a_frame(self):
        frame = FakeAccessible("frame", "Terminal", None, 640, 480)
        application = FakeAccessible("application", "Terminal", 42, 0, 0, [frame])
        desktop = FakeAccessible("desktop", children=[application])

        found = HELPER.find_window(
            desktop,
            {
                "title": "Terminal",
                "pid": 42,
                "bounds": {"width": 648, "height": 518},
            },
        )

        self.assertIs(found, frame)
        self.assertEqual(HELPER.client_size_for(found), {"width": 640.0, "height": 480.0})

    def test_chooses_the_frame_with_matching_name_and_extents_for_one_pid(self):
        other = FakeAccessible("frame", "Other", 42, 400, 300)
        target = FakeAccessible("window", "Terminal", 42, 640, 480)
        desktop = FakeAccessible("desktop", children=[other, target])

        found = HELPER.find_window(
            desktop,
            {
                "title": "Terminal",
                "pid": 42,
                "bounds": {"width": 648, "height": 518},
            },
        )

        self.assertIs(found, target)


if __name__ == "__main__":
    unittest.main()
