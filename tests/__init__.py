"""Test package bootstrap.

Isolates filesystem/env side effects BEFORE any test module imports the
dashboard's modules (several read the environment at import time).
"""
import os
import pathlib
import tempfile

_TMP = tempfile.mkdtemp(prefix="jarvis-test-")
os.environ["JARVIS_STATE"] = str(pathlib.Path(_TMP) / "state.json")
# Never let unit tests probe or drive the real Hermes CLI; the one integration
# test that exercises the subprocess machinery monkeypatches RUNTIME explicitly.
os.environ["JARVIS_RUNTIME"] = "mock"
# ...and never reach a real Hermes API server/gateway that may be running on this machine.
os.environ["JARVIS_BACKEND"] = "cli"
os.environ["JARVIS_START_GATEWAY"] = "0"
