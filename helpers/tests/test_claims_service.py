"""Persistent protocol-3 tests: mocked public captures and loopback cancellation."""

from __future__ import annotations

import io
import json
import socket
import sys
import threading
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HELPERS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HELPERS))
import claims_bridge
import claims_service as service
from connectcoin_p2c_tools.errors import ProofVerificationError
from connectcoin_p2c_tools.tls13 import CaptureCancelled, CaptureControl, Endpoint, TLSGenerationError, capture_tls13_proof


def public_context(**changes):
    return {"domain": "example.com", "txid": "01" * 32, "input_index": 0,
            "connection_work_target": "ff" * 32, "root_certificates_version": 1,
            "signature_algorithms_mask": 1, "validation_time": 1800000000, **changes}


def endpoint(ip="8.8.8.8"):
    return Endpoint(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, (ip, 443), ip)


def fake_capture(_endpoint, _domain, _challenge, *, control, before_start, on_started, **_):
    with control:
        before_start()
        control.begin(SimpleNamespace(shutdown=lambda *_: None, close=lambda: None), on_started)
        return SimpleNamespace(encoded_proof=b"\x02\x01", peer_ip=_endpoint.ip)


class Fixture:
    def __init__(self, **options):
        self.options = {"connectionsPerSecond": 256, "concurrency": 2, **options}
        self.frames = []
        self.condition = threading.Condition()
        self.stack = ExitStack()

    def __enter__(self):
        self.resolve = self.stack.enter_context(patch.object(service, "resolve_endpoints", return_value=(endpoint(),)))
        self.capture = self.stack.enter_context(patch.object(service, "capture_tls13_proof", side_effect=fake_capture))
        self.parse = self.stack.enter_context(patch.object(service, "parse_proof", return_value=SimpleNamespace(connection_work_hash=b"\x00" * 32)))
        self.meets = self.stack.enter_context(patch.object(service, "meets_work_target", return_value=True))
        self.verify = self.stack.enter_context(patch.object(service, "verify_connection_proof"))
        self.service = service.ClaimsService(self.options, self.emit, claims_bridge.parse_context, HELPERS / "p2c_roots_v1.pem")
        return self

    def emit(self, frame):
        with self.condition:
            self.frames.append(frame)
            self.condition.notify_all()

    def wait(self, kind, identifier, timeout=4):
        deadline = time.monotonic() + timeout
        with self.condition:
            while True:
                found = next((frame for frame in self.frames if frame["type"] == kind and frame.get("id") == identifier), None)
                if found is not None: return found
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise AssertionError(f"Missing {kind} frame for request {identifier}")
                self.condition.wait(remaining)

    def resolve_domain(self, identifier=1, domain="example.com"):
        self.service.command({"type": "resolve", "id": identifier, "domain": domain})
        return self.wait("resolved", identifier)

    def attempt(self, identifier, *, bounty=1, successes="0", **context):
        self.service.command({"type": "attempt", "id": identifier, "context": public_context(**context),
            "bountyId": f"{bounty:064x}:0", "successfulConnections": successes})

    def __exit__(self, *_):
        self.service.close()
        self.service.executor.shutdown(wait=True)
        self.stack.close()


class ServiceTests(unittest.TestCase):
    def test_protocol_start_frame_and_clean_shutdown(self):
        frames = []
        payload = [{"type": "start", "protocol": 3, "options": {"connectionsPerSecond": 100, "concurrency": 100}}, {"type": "shutdown"}]
        stream = io.BytesIO(b"".join(json.dumps(frame).encode() + b"\n" for frame in payload))
        self.assertEqual(service.run_service(stream, frames.append, claims_bridge.parse_context, HELPERS / "p2c_roots_v1.pem"), 0)
        self.assertEqual(frames, [{"type": "ready", "protocol": 3, "roots": 1,
                                   "security": {"rsaPublicExponentMaxBits": 64}}])

    def test_frames_options_and_secret_fields_fail_closed(self):
        for raw in (b"{}", b"x" * 16385 + b"\n", b'{"x":NaN}\n', b'{"x":Infinity}\n', b'{"type":"cancel","type":"attempt"}\n'):
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError): service.read_frame(io.BytesIO(raw))
        self.assertIsNone(service.read_frame(io.BytesIO()))
        for options in ({"connectionsPerSecond": 0, "concurrency": 1}, {"connectionsPerSecond": 1, "concurrency": 257},
                        {"connectionsPerSecond": True, "concurrency": 1}, {"connectionsPerSecond": 1, "concurrency": 1, "maxAttempts": 1000}):
            with self.assertRaises(ValueError): service.ClaimsService(options, lambda _: None, claims_bridge.parse_context, HELPERS / "p2c_roots_v1.pem")
        with Fixture() as h:
            for changes in ({"privateKey": "secret"}, {"domain": "wallet.local"}, {"root_certificates_version": 2}, {"validation_time": 253402300800}):
                with self.assertRaises(ValueError): h.attempt(1, **changes)

    def test_request_ids_and_budget_seeds_are_strict(self):
        with Fixture() as h:
            h.resolve_domain()
            for identifier in (True, 0, -1, 1, (1 << 53), "2"):
                with self.assertRaises(ValueError): h.service.command({"type": "resolve", "id": identifier, "domain": "example.com"})
            for successes in ("-1", "1\n", "01", "", str(1 << 64), 0, True):
                with self.assertRaises(ValueError): h.attempt(2, successes=successes)
            h.attempt(2)
            h.wait("attempt", 2)
            with self.assertRaises(ValueError): h.attempt(3, connection_work_target="7f" + "ff" * 31)

    def test_verified_proof_has_started_capture_then_single_terminal(self):
        with Fixture() as h:
            self.assertTrue(h.resolve_domain()["ok"])
            h.attempt(2)
            result = h.wait("attempt", 2)
            self.assertEqual([frame["type"] for frame in h.frames if frame.get("id") == 2], ["started", "capture", "attempt"])
            self.assertEqual(result["context"], public_context())
            self.assertTrue(result["started"] and result["captured"] and result["verified"])
            self.assertEqual(result["proof"], "0201")
            self.assertEqual(result["successfulConnections"], "1")
            self.assertFalse(result["cancelled"])
            self.assertGreaterEqual(result["seconds"], 0)

    def test_hash_miss_and_invalid_certificate_still_count_capture_success(self):
        for reason in ("work", "certificate"):
            with self.subTest(reason=reason), Fixture() as h:
                h.resolve_domain()
                if reason == "work": h.meets.return_value = False
                else: h.verify.side_effect = ProofVerificationError("secret remote certificate details")
                h.attempt(2)
                result = h.wait("attempt", 2)
                self.assertTrue(result["captured"])
                self.assertFalse(result["verified"])
                self.assertIsNone(result["proof"])
                self.assertEqual(result["successfulConnections"], "1")
                self.assertNotIn("secret", json.dumps(h.frames))

    def test_cancellation_racing_verified_result_cannot_emit_cancelled_proof(self):
        with Fixture() as h:
            h.resolve_domain()
            original = h.service._fields
            def race(job):
                if job.captured and h.verify.call_count:
                    job.control.cancel()
                return original(job)
            h.service._fields = race
            h.attempt(2)
            result = h.wait("attempt", 2)
            self.assertTrue(result["captured"])
            self.assertTrue(result["cancelled"])
            self.assertFalse(result["verified"])
            self.assertIsNone(result["proof"])

    def test_capture_event_precedes_slow_verification_and_keeps_completion_order(self):
        release, entered = threading.Event(), threading.Event()
        with Fixture() as h:
            h.resolve_domain()
            def verify(*_args, **_kwargs):
                entered.set()
                if not release.wait(3): raise AssertionError("test verification timed out")
            h.verify.side_effect = verify
            h.attempt(2)
            try:
                first = h.wait("capture", 2)
                self.assertTrue(first["captured"])
                self.assertTrue(entered.wait(3))
                self.assertFalse(any(frame["type"] == "attempt" for frame in h.frames))
                h.attempt(3, bounty=2)
                h.wait("capture", 3)
                self.assertEqual([frame["id"] for frame in h.frames if frame["type"] == "capture"], [2, 3])
            finally:
                release.set()
            h.wait("attempt", 2); h.wait("attempt", 3)

    def test_terminal_repeats_own_capture_count_despite_later_completions(self):
        release, verifying = threading.Event(), threading.Event()
        with Fixture() as h:
            h.resolve_domain()
            count = 0
            def verify(*_args, **_kwargs):
                nonlocal count
                count += 1
                if count == 1:
                    verifying.set()
                    if not release.wait(3): raise AssertionError("test timed out")
            h.verify.side_effect = verify
            h.attempt(2)
            try:
                self.assertTrue(verifying.wait(3))
                h.attempt(3)
                self.assertEqual(h.wait("attempt", 3)["successfulConnections"], "2")
            finally:
                release.set()
            self.assertEqual(h.wait("attempt", 2)["successfulConnections"], "1")

    def test_dns_failure_and_expiry_never_start_tcp(self):
        with Fixture() as h:
            h.resolve.side_effect = OSError("private resolver details")
            self.assertFalse(h.resolve_domain()["ok"])
            h.attempt(2)
            result = h.wait("attempt", 2)
            self.assertFalse(result["started"] or result["captured"])
            self.assertEqual(result["seconds"], 0)
            self.assertFalse(any(frame["type"] == "capture" for frame in h.frames))
            h.capture.assert_not_called()
            self.assertFalse(h.resolve_domain(3)["ok"])
            self.assertEqual(h.resolve.call_count, 1)  # Negative DNS cache: two seconds.
            h.service.dns["example.com"]["expires"] = 0
            h.resolve.side_effect = None
            self.assertTrue(h.resolve_domain(4)["ok"])
            self.assertEqual(h.resolve.call_count, 2)
            h.service.dns["example.com"]["expires"] = 0
            h.attempt(5)
            self.assertFalse(h.wait("attempt", 5)["started"])
            h.capture.assert_not_called()

    def test_dns_cache_is_reused_and_endpoints_rotate(self):
        with Fixture() as h:
            h.resolve.return_value = (endpoint(), endpoint("1.1.1.1"))
            h.resolve_domain()
            expires = h.service.dns["example.com"]["expires"]
            self.assertAlmostEqual(expires - time.monotonic(), 60, delta=1)
            for identifier in (2, 3, 4):
                h.attempt(identifier)
                h.wait("attempt", identifier)
            h.resolve_domain(5)
            self.assertEqual(h.resolve.call_count, 1)
            self.assertEqual([call.args[0].ip for call in h.capture.call_args_list], ["8.8.8.8", "1.1.1.1", "8.8.8.8"])

    def test_exact_two_expected_gate_is_strict_and_counts_only_success(self):
        with Fixture() as h:
            h.resolve_domain()
            h.meets.return_value = False
            for identifier in (2, 3, 4):
                h.attempt(identifier)
                self.assertTrue(h.wait("attempt", identifier)["captured"])
            h.attempt(5)
            result = h.wait("attempt", 5)
            self.assertEqual(result["blocked"], "budget")
            self.assertFalse(result["started"])
            self.assertEqual(result["successfulConnections"], "3")
            self.assertEqual(h.capture.call_count, 4)  # Last call reaches gate before TCP.
            self.assertEqual(sum(frame["type"] == "started" for frame in h.frames), 3)

    def test_seed_never_decreases_and_large_integer_gate_is_exact(self):
        with Fixture() as h:
            h.resolve_domain()
            h.attempt(2, successes="3")
            self.assertEqual(h.wait("attempt", 2)["blocked"], "budget")
            h.attempt(3, successes="0")
            self.assertEqual(h.wait("attempt", 3)["successfulConnections"], "3")
            h.attempt(4, bounty=2, successes=str(service.MAX_UINT64), connection_work_target="00" * 32)
            self.assertEqual(h.wait("attempt", 4)["blocked"], "budget")
            # 2^257/(target+1) = 2^54: above JS safe-integer precision.
            target = ((1 << 203) - 1).to_bytes(32, "big").hex()
            h.attempt(5, bounty=3, successes=str((1 << 54) + 1), connection_work_target=target)
            self.assertEqual(h.wait("attempt", 5)["blocked"], "budget")
            h.attempt(6, bounty=4, successes=str(1 << 54), connection_work_target=target)
            self.assertTrue(h.wait("attempt", 6)["started"])

    def test_capture_failures_do_not_exhaust_success_budget(self):
        with Fixture() as h:
            h.resolve_domain()
            def fails(*args, **kwargs):
                fake_capture(*args, **kwargs)
                raise OSError("connection failed")
            h.capture.side_effect = fails
            for identifier in (2, 3, 4, 5):
                h.attempt(identifier)
                result = h.wait("attempt", identifier)
                self.assertTrue(result["started"])
                self.assertFalse(result["captured"])
                self.assertEqual(result["successfulConnections"], "0")

    def test_capture_failure_messages_are_fixed_and_timeouts_preserve_budget(self):
        for error, expected in (
            (TimeoutError("private socket details"), "TLS connection timed out"),
            (TLSGenerationError("TLS handshake exceeded the connection timeout"), "TLS connection timed out"),
            (TLSGenerationError("private peer timed out"), "TLS capture or proof validation failed"),
            (OSError("private peer timed out"), "TLS capture or proof validation failed"),
        ):
            with self.subTest(error=type(error).__name__, expected=expected), Fixture() as h:
                h.resolve_domain()
                def fails(*args, **kwargs):
                    fake_capture(*args, **kwargs)
                    raise error
                h.capture.side_effect = fails
                h.attempt(2, successes="2")
                result = h.wait("attempt", 2)
                self.assertEqual(result["message"], expected)
                self.assertTrue(result["started"])
                self.assertFalse(result["captured"] or result["cancelled"] or result["verified"])
                self.assertIsNone(result["proof"])
                self.assertEqual(result["successfulConnections"], "2")
                self.assertNotIn("private", json.dumps(h.frames))
                h.capture.side_effect = fake_capture
                h.attempt(3, successes="2")
                retry = h.wait("attempt", 3)
                self.assertTrue(retry["verified"])
                self.assertEqual(retry["successfulConnections"], "3")

    def test_real_tls_deadline_is_reported_as_timeout_without_remote_text(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0)); listener.listen(1); listener.settimeout(3)
        address = listener.getsockname()
        received, release = threading.Event(), threading.Event()
        def peer():
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(3)
                    connection.recv(4096)
                    received.set()
                    release.wait(3)
            finally:
                listener.close()
        server_thread = threading.Thread(target=peer)
        server_thread.start()
        try:
            with patch.object(service, "CONNECTION_TIMEOUT", 0.1), Fixture() as h:
                h.resolve.return_value = (Endpoint(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, address, "127.0.0.1"),)
                h.capture.side_effect = capture_tls13_proof
                h.resolve_domain()
                h.attempt(2)
                result = h.wait("attempt", 2)
                self.assertTrue(received.is_set())
                self.assertEqual(result["message"], "TLS connection timed out")
                self.assertEqual([frame["type"] for frame in h.frames if frame.get("id") == 2], ["started", "capture", "attempt"])
                self.assertFalse(result["captured"] or result["cancelled"] or result["verified"])
                self.assertEqual(result["successfulConnections"], "0")
                self.assertGreaterEqual(result["seconds"], 0.1)
                self.assertLess(result["seconds"], 2)
        finally:
            release.set(); server_thread.join(4)

    def test_global_start_rate_is_shared_across_domains(self):
        times = []
        with Fixture(connectionsPerSecond=20, concurrency=2) as h:
            h.resolve_domain()
            h.resolve_domain(2, "other.example")
            original_emit = h.service.emit_callback
            def emit(frame):
                if frame["type"] == "started": times.append(time.monotonic())
                original_emit(frame)
            h.service.emit_callback = emit
            for identifier in (3, 4, 5):
                h.attempt(identifier, bounty=identifier, domain="other.example" if identifier == 4 else "example.com")
            for identifier in (3, 4, 5): h.wait("attempt", identifier)
            self.assertEqual(len(times), 3)
            self.assertTrue(all(right - left >= 0.040 for left, right in zip(times, times[1:])))

    def test_global_concurrency_and_cancellation_are_per_attempt(self):
        release = threading.Event()
        lock = threading.Lock()
        active = maximum = 0
        with Fixture(concurrency=2) as h:
            h.resolve_domain()
            def blocks(*args, **kwargs):
                nonlocal active, maximum
                result = fake_capture(*args, **kwargs)
                with lock:
                    active += 1
                    maximum = max(maximum, active)
                try:
                    until = time.monotonic() + 3
                    while not release.wait(0.005):
                        if kwargs["control"].cancelled(): raise CaptureCancelled("cancelled")
                        if time.monotonic() > until: raise AssertionError("test timed out")
                    return result
                finally:
                    with lock: active -= 1
            h.capture.side_effect = blocks
            for identifier in (2, 3, 4): h.attempt(identifier, bounty=identifier)
            try:
                h.wait("started", 2); h.wait("started", 3)
                self.assertFalse(any(frame.get("id") == 4 for frame in h.frames))
                h.service.command({"type": "cancel", "id": 2})
                self.assertTrue(h.wait("attempt", 2)["cancelled"])
                h.wait("started", 4)
                self.assertEqual(maximum, 2)
            finally:
                release.set()
            self.assertTrue(h.wait("attempt", 3)["verified"])
            self.assertTrue(h.wait("attempt", 4)["verified"])
            self.assertFalse(h.wait("attempt", 3)["cancelled"])

    def test_dns_cache_is_bounded_and_does_not_retain_old_domains(self):
        with patch.object(service, "MAX_DNS_CACHE", 3), Fixture() as h:
            for identifier in range(1, 6): h.resolve_domain(identifier, f"d{identifier}.example")
            self.assertEqual(list(h.service.dns), ["d3.example", "d4.example", "d5.example"])

    def test_budget_cache_never_evicts_active_or_queued_bounties(self):
        entered = threading.Event()
        with patch.object(service, "MAX_BUDGETS", 2), Fixture(concurrency=1) as h:
            h.resolve_domain()
            def blocks(*args, **kwargs):
                fake_capture(*args, **kwargs)
                entered.set()
                kwargs["control"]._event.wait(3)
                raise CaptureCancelled("cancelled")
            h.capture.side_effect = blocks
            h.attempt(2, bounty=1)
            self.assertTrue(entered.wait(3))
            h.attempt(3, bounty=2)
            with self.assertRaisesRegex(ValueError, "budget cache"): h.attempt(4, bounty=3)
            h.service.command({"type": "cancel", "id": 3})
            h.wait("attempt", 3)
            h.attempt(4, bounty=3)
            self.assertIn(f"{1:064x}:0", h.service.budgets)
            self.assertNotIn(f"{2:064x}:0", h.service.budgets)
            h.service.command({"type": "cancel", "id": 2})

    def test_pending_limit_and_queued_cancel_never_dial(self):
        entered = threading.Event()
        with Fixture(concurrency=1) as h:
            h.resolve_domain()
            def blocks(*args, **kwargs):
                fake_capture(*args, **kwargs)
                entered.set()
                kwargs["control"]._event.wait(3)
                raise CaptureCancelled("cancelled test connection")
            h.capture.side_effect = blocks
            h.attempt(2)
            self.assertTrue(entered.wait(3))
            for identifier in range(3, service.MAX_PENDING + 2): h.attempt(identifier, bounty=identifier)
            with self.assertRaisesRegex(ValueError, "pending request"): h.attempt(service.MAX_PENDING + 2)
            h.service.command({"type": "cancel", "id": 3})
            cancelled = h.wait("attempt", 3)
            self.assertTrue(cancelled["cancelled"])
            self.assertFalse(cancelled["started"])
            self.assertEqual(h.capture.call_count, 1)
            h.service.command({"type": "cancel", "id": 2})
            self.assertTrue(h.wait("attempt", 2)["cancelled"])

    def test_one_executor_survives_more_than_one_thousand_attempts_and_bounds_budget_cache(self):
        with Fixture(concurrency=1) as h:
            h.resolve_domain()
            executor = h.service.executor
            threads = set()
            def recorded(*args, **kwargs):
                threads.add(threading.get_ident())
                return fake_capture(*args, **kwargs)
            h.capture.side_effect = recorded
            for identifier in range(2, 1102):
                # This checks executor longevity and bounded caches, not wall
                # clock rate accuracy. Expire the previous synthetic slot so
                # OS sleep granularity cannot add 4-16 seconds to 1,100 mocks.
                # Keep the real start hook (including budget/cancel checks);
                # the dedicated cross-domain rate test still uses real time.
                with h.service.condition:
                    h.service.next_start = 0
                h.attempt(identifier, bounty=identifier)
                self.assertTrue(h.wait("attempt", identifier)["captured"])
            self.assertIs(h.service.executor, executor)
            self.assertLessEqual(len(threads), 3)
            self.assertEqual(h.capture.call_count, 1100)
            self.assertLessEqual(len(h.service.budgets), service.MAX_BUDGETS)
            self.assertLessEqual(len(h.service.jobs), 1)

    def test_real_loopback_socket_cancellation_interrupts_receive(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0)); listener.listen(1); listener.settimeout(3)
        address = listener.getsockname()
        received, release = threading.Event(), threading.Event()
        control = CaptureControl()
        failures = []
        def peer():
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(3)
                    connection.recv(4096)
                    received.set()
                    release.wait(3)
            finally:
                listener.close()
        def client():
            try:
                proof = claims_bridge.parse_context(public_context())
                capture_tls13_proof(Endpoint(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, address, "127.0.0.1"),
                    proof.domain, proof.challenge, signature_algorithms_mask=1, timeout=10, control=control)
            except (OSError, ValueError) as error:
                failures.append(error)
        server_thread, client_thread = threading.Thread(target=peer), threading.Thread(target=client)
        server_thread.start(); client_thread.start()
        try:
            self.assertTrue(received.wait(3))
            started = time.monotonic(); control.cancel(); client_thread.join(2)
            self.assertFalse(client_thread.is_alive())
            self.assertLess(time.monotonic() - started, 2)
            self.assertTrue(failures)
        finally:
            control.cancel(); release.set(); server_thread.join(4); client_thread.join(4)

    def test_cancelled_before_capture_opens_no_socket(self):
        control = CaptureControl(); control.cancel()
        proof = claims_bridge.parse_context(public_context())
        with patch("connectcoin_p2c_tools.tls13.socket.socket") as new_socket:
            with self.assertRaises(CaptureCancelled):
                capture_tls13_proof(endpoint(), proof.domain, proof.challenge,
                    signature_algorithms_mask=1, control=control)
        new_socket.assert_not_called()


if __name__ == "__main__":
    unittest.main()
