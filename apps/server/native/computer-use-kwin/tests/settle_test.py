"""waitForSettle: the settle verdict its damage handler and timers act on."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, class_definition, definition, run_fixture

FIXTURE = Path(__file__).with_name("settle_fixture.cpp")


class SettleTest(unittest.TestCase):
    def test_settle_verdict(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [class_definition(source, "SettleVerdict"), definition(source, "settleVerdict", member=False)]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-settle-test-")


if __name__ == "__main__":
    unittest.main()
