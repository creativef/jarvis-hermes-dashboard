"""Every test defined in a tests/test_*.py file must actually be collected.

A test that is silently not collected is worse than a failing one: the suite still
reports OK, with a smaller number. This cross-checks each module's static
`def test_` count against what the loader really collects, and names anything missing.
"""
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parent
DEF = re.compile(r"^[ \t]+def (test_\w+)", re.M)


def _defined(path):
    return set(DEF.findall(path.read_text(encoding="utf-8")))


def _collected(module):
    suite = unittest.defaultTestLoader.loadTestsFromName(f"tests.{module}")
    names, stack = set(), [suite]
    while stack:
        for t in stack.pop():
            if isinstance(t, unittest.TestSuite):
                stack.append(t)
            else:
                names.add(t._testMethodName)
    return names


class CollectionTests(unittest.TestCase):
    def test_no_defined_test_is_silently_dropped(self):
        checked = 0
        for path in sorted(HERE.glob("test_*.py")):
            module = path.stem
            if module == pathlib.Path(__file__).stem:
                continue                                  # counting ourselves proves nothing
            defined = _defined(path)
            if not defined:
                continue
            got = _collected(module)
            missing = defined - got
            self.assertFalse(missing, f"{module}: defined but never collected: {sorted(missing)}")
            checked += len(defined)
        self.assertGreater(checked, 150, "the sweep looked at suspiciously few tests")

    def test_the_suite_is_not_smaller_than_its_parts(self):
        total = 0
        for path in sorted(HERE.glob("test_*.py")):
            if path.stem == pathlib.Path(__file__).stem:
                continue
            total += len(_defined(path))
        self.assertGreaterEqual(total, 150, f"only {total} tests are defined across the suite")


if __name__ == "__main__":
    unittest.main()