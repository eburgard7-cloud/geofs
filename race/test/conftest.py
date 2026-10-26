"""Hang guard shared by every pytest module in race/test (the per-test timeout is in pytest.ini)."""
import queue

from starlette.testclient import WebSocketTestSession

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
