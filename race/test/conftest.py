"""Isolation and a hang guard shared by every pytest module in race/test (the per-test timeout is in pytest.ini).

RACE_DB is pointed at a scratch directory before any test module imports app.py (which reads it, and
derives the tile cache and customs dirs from it at import), so no test can reach a developer's real
database: the documented `RACE_DB=... pytest` prefix and the old /tmp/race-test.db default are both
ignored. A test that needs an empty database of its own asks for `race_db`.
"""
import os
import queue
import sys
import tempfile

import pytest
from starlette.testclient import WebSocketTestSession

SCRATCH_DIR = tempfile.mkdtemp(prefix="race-test-")
os.environ["RACE_DB"] = os.path.join(SCRATCH_DIR, "race.db")


@pytest.fixture
def race_db(tmp_path, monkeypatch):
    """An empty tmp_path-backed database with the schema in place, for the test only (app.connect()
    and the lifespan follow app.DB_PATH). The path."""
    path = str(tmp_path / "race.db")
    app = sys.modules["app"]
    monkeypatch.setattr(app, "DB_PATH", path)
    with app.connect() as conn:
        conn.executescript(app.SCHEMA)
        conn.executescript(app.garage.SCHEMA)
        app.migrate(conn)
    return path


# starlette's WebSocketTestSession.receive() blocks forever on an empty queue, so a frame that never
# arrives (a regression, a failed assertion inside nested socket contexts) stalls the whole run
# instead of failing the test. Give it a deadline well inside pytest.ini's 60 s per-test timeout.
RECEIVE_TIMEOUT_S = 20


def _receive(self):
    try:
        message = self._send_queue.get(timeout=RECEIVE_TIMEOUT_S)
    except queue.Empty:
        raise AssertionError(f"websocket: no frame arrived within {RECEIVE_TIMEOUT_S} s") from None
    if isinstance(message, BaseException):
        raise message
    return message


WebSocketTestSession.receive = _receive
