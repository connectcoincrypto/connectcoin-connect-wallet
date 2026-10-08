"""Host-only native/Python oracle and real loopback TLS tests; no public traffic.

Run with the desktop helper's pinned cryptography environment:
  python mobile/native/tests/test_oracle.py --cli <build>/p2c_test_cli[.exe]
Only generated public test identities are used. All private fixture keys and
certificates live in a TemporaryDirectory and are never wallet material.
"""
from __future__ import annotations

import argparse
import base64
import dataclasses
import hashlib
import json
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import textwrap
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "helpers"))
sys.path.insert(0, str(ROOT / "helpers/tests"))
import claims_bridge  # Establish the exact shipped Python verifier import path.
from test_claims import identity, request
from test_verifier_security import certificate, signed_proof
from test_rsa_exponent_limits import _der, _content
from connectcoin_p2c_tools import tls13
from connectcoin_p2c_tools.errors import ProofFormatError, ProofVerificationError
from connectcoin_p2c_tools.verify import verify_connection_proof
from connectcoin_p2c_tools.protocol import parse_proof
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305

CLI = None
DER, PEM = serialization.Encoding.DER, serialization.Encoding.PEM


def handshake(kind, body):
    return bytes([kind]) + len(body).to_bytes(3, "big") + body


def split_messages(proof):
    result, at = [], 1
    while at < len(proof):
        end = at + 4 + int.from_bytes(proof[at + 1:at + 4], "big")
        result.append(proof[at:end])
        at = end
    assert at == len(proof)
    return result


def rsa_identity(root, *, restricted=False, salt=32, exponent=65537):
    key = rsa.generate_private_key(65537, 2048)
    public = key.public_key() if exponent == 65537 else rsa.RSAPublicNumbers(
        exponent, key.public_key().public_numbers().n).public_key()
    # Reuse all extensions of an EC fixture while replacing only its public key.
    _, template = certificate(503, "RSA fixture", issuer=root, dns_name="example.com")
    builder = (x509.CertificateBuilder().subject_name(template.subject)
               .issuer_name(template.issuer).public_key(public).serial_number(504)
               .not_valid_before(template.not_valid_before_utc)
               .not_valid_after(template.not_valid_after_utc))
    for extension in template.extensions:
        builder = builder.add_extension(extension.value, extension.critical)
    cert = builder.sign(root[0], hashes.SHA256())
    if restricted:
        spki = public.public_bytes(DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        rsa_algorithm = bytes.fromhex("300d06092a864886f70d0101010500")
        sha256 = bytes.fromhex("300d06096086480165030402010500")
        mgf1 = _der(0x30, bytes.fromhex("06092a864886f70d010108") + sha256)
        params = _der(0x30, _der(0xa0, sha256) + _der(0xa1, mgf1)
                      + _der(0xa2, _der(2, bytes([salt]))))
        algorithm = _der(0x30, bytes.fromhex("06092a864886f70d01010a") + params)
        replacement = _der(0x30, algorithm + _content(spki)[len(rsa_algorithm):])
        tbs = _der(0x30, _content(cert.tbs_certificate_bytes).replace(spki, replacement))
        signature = root[0].sign(tbs, ec.ECDSA(hashes.SHA256()))
        cert = x509.load_der_x509_certificate(_der(0x30, tbs
            + bytes.fromhex("300a06082a8648ce3d040302") + _der(3, b"\x00" + signature)))
    return key, cert


def pss_private_pem(key):
    # Preserve the RSASSA-PSS PKCS8 algorithm rather than normalizing through a
    # generic RSAPrivateKey serializer. Only a generated fixture key is handled.
    generic = bytes.fromhex("300d06092a864886f70d0101010500")
    sha256 = bytes.fromhex("300d06096086480165030402010500")
    mgf1 = _der(0x30, bytes.fromhex("06092a864886f70d010108") + sha256)
    params = _der(0x30, _der(0xa0, sha256) + _der(0xa1, mgf1) + _der(0xa2, _der(2, b"\x20")))
    algorithm = _der(0x30, bytes.fromhex("06092a864886f70d01010a") + params)
    encoded = key.private_bytes(DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    assert _content(encoded).count(generic) == 1
    encoded = _der(0x30, _content(encoded).replace(generic, algorithm))
    return ("-----BEGIN PRIVATE KEY-----\n" + "\n".join(textwrap.wrap(base64.b64encode(encoded).decode("ascii"), 64))
            + "\n-----END PRIVATE KEY-----\n").encode("ascii")


def rsa_proof(root, leaf, scheme):
    seed_leaf = certificate(505, "EC skeleton", issuer=root, dns_name="example.com")
    envelope = signed_proof("example.com", seed_leaf, [])
    messages = split_messages(envelope.proof)
    offered = b"\x00\x0d\x00\x04\x00\x02\x04\x03"
    assert messages[0].count(offered) == 1
    messages[0] = messages[0].replace(offered, offered[:-2] + scheme.to_bytes(2, "big"))
    encoded = leaf[1].public_bytes(DER)
    entries = len(encoded).to_bytes(3, "big") + encoded + b"\x00\x00"
    messages[3] = handshake(11, b"\x00" + len(entries).to_bytes(3, "big") + entries)
    transcript = b"".join(messages[:4])
    signature = leaf[0].sign(b"\x20" * 64 + b"TLS 1.3, server CertificateVerify\x00"
        + hashlib.sha256(transcript).digest(), padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
    messages[4] = handshake(15, scheme.to_bytes(2, "big") + len(signature).to_bytes(2, "big") + signature)
    return dataclasses.replace(envelope, proof=b"\x02" + b"".join(messages),
                               signature_algorithms_mask=2 if scheme == 0x0804 else 4)


def server_first_flight(context, peer):
    """Generate a real OpenSSL server flight without requiring client Finished."""
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    server = context.wrap_bio(incoming, outgoing, server_side=True)
    client_messages = bytearray()
    deadline = time.monotonic() + 5
    while True:
        try:
            server.do_handshake()
        except ssl.SSLWantReadError:
            if outgoing.pending:
                client_hello = tls13._pop_handshake(client_messages)
                assert client_hello and client_hello[0] == 1 and not client_messages
                return client_hello, outgoing.read()
            kind, header, body = tls13._recv_record(peer, deadline)
            assert kind == tls13.CONTENT_HANDSHAKE
            client_messages.extend(body)
            incoming.write(header + body)
        else:
            raise AssertionError("Server completed before receiving client Finished")


def flight_through_certificate_verify(client_hello, flight, keylog, private_key, mutation, *, withhold_finished=True):
    """Authenticate fixture records ending at CV; Finished is never transmitted.

    The key log contains only this temporary, generated server's secrets. The
    original encrypted flight is never sent, so rewriting its records does not
    reuse a nonce on the wire. Keeping the connection open makes a client that
    waits for Finished fail its deadline instead of succeeding on a lucky EOF.
    """
    records, at = [], 0
    while at < len(flight):
        header = flight[at:at + 5]
        assert len(header) == 5
        end = at + 5 + int.from_bytes(header[3:5], "big")
        assert end <= len(flight)
        records.append((header, flight[at + 5:end]))
        at = end
    server_hello = next(body for header, body in records if header[0] == tls13.CONTENT_HANDSHAKE)
    assert server_hello[0] == 2
    session_id_length = server_hello[38]
    suite = int.from_bytes(server_hello[39 + session_id_length:41 + session_id_length], "big")
    secrets = [line.split()[2] for line in keylog.read_text().splitlines()
               if line.startswith("SERVER_HANDSHAKE_TRAFFIC_SECRET ")]
    assert len(secrets) == 1
    key, iv = tls13._handshake_keys(bytes.fromhex(secrets[0]), suite)
    prefix, plaintext, sequence = bytearray(), bytearray(), 0
    for header, body in records:
        if header[0] == tls13.CONTENT_APPLICATION_DATA:
            kind, message = tls13._decrypt_record(suite, key, iv, sequence, header, body)
            assert kind == tls13.CONTENT_HANDSHAKE
            plaintext.extend(message)
            sequence += 1
        else:
            assert header[0] in (tls13.CONTENT_HANDSHAKE, tls13.CONTENT_CHANGE_CIPHER_SPEC)
            prefix.extend(header + body)
    messages = []
    while plaintext:
        message = tls13._pop_handshake(plaintext)
        assert message is not None
        messages.append(message)
    assert [message[0] for message in messages] == [8, 11, 15, 20]
    finished = messages.pop()  # Separate Finished, even when it shared a TLS record.
    if mutation == "certificate_signature":
        # Preserve a structurally valid certificate/public key but invalidate its
        # issuer signature, then make a fresh *valid* CV over the altered cert.
        # This reaches the full proof verifier after Mbed TLS accepts CV.
        certificate_message = bytearray(messages[1])
        assert certificate_message[4] == 0
        certificate_length = int.from_bytes(certificate_message[8:11], "big")
        certificate_message[11 + certificate_length - 1] ^= 1
        messages[1] = bytes(certificate_message)
        signer = serialization.load_pem_private_key(private_key, password=None)
        transcript = client_hello + server_hello + b"".join(messages[:2])
        signed = b"\x20" * 64 + b"TLS 1.3, server CertificateVerify\x00" + hashlib.sha256(transcript).digest()
        if isinstance(signer, rsa.RSAPrivateKey):
            signature = signer.sign(signed, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32), hashes.SHA256())
        else:
            signature = signer.sign(signed, ec.ECDSA(hashes.SHA256()))
        messages[2] = handshake(15, messages[2][4:6] + len(signature).to_bytes(2, "big") + signature)
        finished = handshake(20, tls13._finished_verify_data(bytes.fromhex(secrets[0]), client_hello + server_hello + b"".join(messages)))
    elif mutation == "cv_signature":
        messages[2] = messages[2][:-1] + bytes([messages[2][-1] ^ 1])
    elif mutation == "cv_mask":
        # The fixture offers only ECDSA (mask 1), never RSAE (0x0804).
        assert messages[2][4:6] == b"\x04\x03"
        messages[2] = messages[2][:4] + b"\x08\x04" + messages[2][6:]
    elif mutation == "finished":
        finished = finished[:-1] + bytes([finished[-1] ^ 1])
    else:
        assert mutation is None
    if not withhold_finished:
        messages.append(finished)
    cipher = AESGCM(key) if suite == tls13.TLS_AES_128_GCM_SHA256 else ChaCha20Poly1305(key)
    for sequence, message in enumerate(messages):
        body = message + bytes([tls13.CONTENT_HANDSHAKE])
        header = b"\x17\x03\x03" + (len(body) + 16).to_bytes(2, "big")
        prefix.extend(header + cipher.encrypt(tls13._record_nonce(iv, sequence), body, header))
    return bytes(prefix)


class NativeOracleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="connectwallet-native-oracle-")
        self.path = Path(self.directory.name)
        self.root = certificate(501, "Native public fixture root", ca=True)
        self.leaf = certificate(502, "Native public fixture leaf", issuer=self.root, dns_name="example.com")
        self.envelope = signed_proof("example.com", self.leaf, [])
        self.roots = self.path / "roots.pem"
        self.roots.write_bytes(self.root[1].public_bytes(PEM))

    def tearDown(self):
        self.directory.cleanup()

    def run_native(self, envelope, *, mode="verify", endpoint=None, timeout=5000, cancel=None, workers=8):
        proof = self.path / "proof.bin"
        proof.write_bytes(envelope.proof)
        args = [str(CLI), mode, envelope.domain, envelope.challenge.hex(),
                envelope.connection_work_target, str(envelope.signature_algorithms_mask),
                str(envelope.validation_time), str(self.roots), str(endpoint or proof)]
        if mode.startswith("capture") or mode == "probe":
            args.append(str(timeout))
            if cancel is not None:
                args.append(str(cancel))
            elif mode == "capture-parallel":
                args.append(str(workers))
        result = subprocess.run(args, capture_output=True, text=True, timeout=12)
        return result

    def assert_agreement(self, envelope, valid=True, target=True):
        result = self.run_native(envelope)
        self.assertEqual(result.returncode, 0, result.stderr)
        decoded = json.loads(result.stdout)
        self.assertEqual(decoded["validProof"], valid)
        self.assertEqual(decoded["meetsTarget"], valid and target)
        if valid and target:
            verified = verify_connection_proof(envelope, self.roots, enforce_root_pin=False)
            self.assertEqual(verified.challenge, envelope.challenge.hex())
            self.assertEqual(decoded["proof"], envelope.proof.hex())
        else:
            with self.assertRaises((ProofFormatError, ProofVerificationError)):
                verify_connection_proof(envelope, self.roots, enforce_root_pin=False)
        return decoded

    def test_ecdsa_and_work_target_semantics(self):
        self.assert_agreement(self.envelope)
        parsed = parse_proof(self.envelope.proof, self.envelope.domain, self.envelope.challenge)
        # Display target is the reversed internal work hash; equality is valid.
        exact = parsed.connection_work_hash[::-1].hex()
        self.assert_agreement(dataclasses.replace(self.envelope, connection_work_target=exact))
        self.assert_agreement(dataclasses.replace(self.envelope, connection_work_target="00" * 32), target=False)

    def test_rsae_and_restricted_pss_spki(self):
        for restricted, scheme in ((False, 0x0804), (True, 0x0809)):
            with self.subTest(restricted=restricted):
                self.assert_agreement(rsa_proof(self.root, rsa_identity(self.root, restricted=restricted), scheme))

    def test_parallel_workers_isolate_roots_and_verify_independently(self):
        for envelope in (self.envelope, rsa_proof(self.root, rsa_identity(self.root), 0x0804),
                         rsa_proof(self.root, rsa_identity(self.root, restricted=True), 0x0809)):
            with self.subTest(mask=envelope.signature_algorithms_mask):
                result = self.run_native(envelope, mode="verify-parallel")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(json.loads(result.stdout)["validProof"])

    def test_signature_challenge_domain_time_mask_and_framing_rejections(self):
        self.assert_agreement(dataclasses.replace(self.envelope, proof=self.envelope.proof[:-1]
                                                  + bytes([self.envelope.proof[-1] ^ 1])), False)
        self.assert_agreement(dataclasses.replace(self.envelope, txid="02" * 32), False)
        self.assert_agreement(dataclasses.replace(self.envelope, domain="other.example.com"), False)
        self.assert_agreement(dataclasses.replace(self.envelope, validation_time=1_000_000_000), False)
        self.assert_agreement(dataclasses.replace(self.envelope, signature_algorithms_mask=2), False)
        for malformed in (b"", self.envelope.proof[:-1], self.envelope.proof + b"\x00"):
            self.assert_agreement(dataclasses.replace(self.envelope, proof=malformed), False)

    def test_rsa_key_identity_restrictions_and_exponent_bound(self):
        pss_leaf = rsa_identity(self.root, restricted=True)
        self.assert_agreement(rsa_proof(self.root, pss_leaf, 0x0804), False)
        self.assert_agreement(rsa_proof(self.root, rsa_identity(self.root), 0x0809), False)
        self.assert_agreement(rsa_proof(self.root, rsa_identity(self.root, restricted=True, salt=48), 0x0809), False)
        self.assert_agreement(rsa_proof(self.root, rsa_identity(self.root, exponent=(1 << 64) + 1), 0x0804), False)

    def test_untrusted_root_and_name_constraints(self):
        self.roots.write_bytes(certificate(510, "Unrelated root", ca=True)[1].public_bytes(PEM))
        self.assert_agreement(self.envelope, False)
        self.roots.write_bytes(self.root[1].public_bytes(PEM))
        intermediate = certificate(511, "Restricted CA", issuer=self.root, ca=True, permitted="foo.example.com")
        leaf = certificate(512, "Wildcard leaf", issuer=intermediate, dns_name="*.example.com")
        self.assert_agreement(signed_proof("foo.example.com", leaf, [intermediate[1]]), False)

    def loopback(self, *, rsa_leaf=False, restricted_pss=False, stalled=False, cancel=None, timeout=5000,
                 without_finished=False, mutation=None):
        if restricted_pss:
            leaf_key, leaf = rsa_identity(self.root, restricted=True)
            root, cert, key = self.root[1].public_bytes(PEM), leaf.public_bytes(PEM), pss_private_pem(leaf_key)
        else:
            root, cert, key = identity(rsa_leaf=rsa_leaf)
        self.roots.write_bytes(root)
        cert_path, key_path = self.path / "server.pem", self.path / "server-key.pem"
        cert_path.write_bytes(cert)
        key_path.write_bytes(key)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.minimum_version = server_context.maximum_version = ssl.TLSVersion.TLSv1_3
        server_context.load_cert_chain(cert_path, key_path)
        keylog = self.path / ("server-" + str(time.monotonic_ns()) + ".keys")
        if without_finished:
            server_context.keylog_filename = str(keylog)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(5)
        completed, failures = [], []
        release = threading.Event()

        def serve():
            try:
                peer, _ = listener.accept()
                with peer:
                    peer.settimeout(5)
                    if stalled:
                        release.wait(5)
                    else:
                        client_hello, flight = server_first_flight(server_context, peer)
                        if without_finished:
                            flight = flight_through_certificate_verify(client_hello, flight, keylog, key, mutation)
                        peer.sendall(flight)
                        completed.append("through CV" if without_finished else "server flight")
                        release.wait(5)
            except Exception as error:
                failures.append(str(error))
            finally:
                listener.close()

        worker = threading.Thread(target=serve)
        worker.start()
        context, _ = claims_bridge.parse_request(request())
        context = dataclasses.replace(context, signature_algorithms_mask=4 if restricted_pss else 2 if rsa_leaf else 1)
        started = time.monotonic()
        try:
            result = self.run_native(context, mode="capture", endpoint=listener.getsockname()[1], timeout=timeout, cancel=cancel)
        finally:
            release.set()
            worker.join(6)
        elapsed = time.monotonic() - started
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        if stalled:
            if cancel is not None:
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr.strip(), "CLAIM_CANCELLED")
            else:
                self.assertEqual(result.returncode, 0, result.stderr)
                failure = json.loads(result.stdout)
                self.assertFalse(failure["captured"])
                self.assertFalse(failure["validationPassed"])
                self.assertFalse(failure["validProof"])
                self.assertFalse(failure["meetsTarget"])
                self.assertEqual(failure["proof"], "")
                self.assertEqual(failure["errorCode"], "CLAIM_TIMEOUT")
                self.assertGreaterEqual(failure["durationMs"], 150)
            self.assertLess(elapsed, 2)
            return
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(completed, ["through CV" if without_finished else "server flight"])
        decoded = json.loads(result.stdout)
        if mutation:
            self.assertFalse(decoded["validationPassed"])
            self.assertFalse(decoded["validProof"])
            self.assertFalse(decoded["meetsTarget"])
            self.assertEqual(decoded["proof"], "")
            self.assertEqual(decoded["captured"], mutation == "certificate_signature")
            self.assertEqual(decoded["errorCode"], "CLAIM_CERTIFICATE" if mutation == "certificate_signature" else "CLAIM_TLS")
            return
        self.assertTrue(decoded["captured"])
        self.assertTrue(decoded["validationPassed"])
        self.assertTrue(decoded["validProof"])
        self.assertTrue(decoded["meetsTarget"])
        proof = dataclasses.replace(context, proof=bytes.fromhex(decoded["proof"]))
        verify_connection_proof(proof, self.roots, enforce_root_pin=False)
        return proof

    def test_loopback_tls_ecdsa_and_rsae(self):
        for rsa_leaf in (False, True):
            with self.subTest(rsa_leaf=rsa_leaf):
                first = self.loopback(rsa_leaf=rsa_leaf)
                second = self.loopback(rsa_leaf=rsa_leaf)
                # Same challenge is intentional; ephemeral ECDHE must not repeat.
                self.assertNotEqual(split_messages(first.proof)[0], split_messages(second.proof)[0])

    def test_capture_succeeds_with_server_finished_withheld(self):
        for rsa_leaf, restricted_pss, scheme in ((False, False, 0x0403), (True, False, 0x0804), (False, True, 0x0809)):
            with self.subTest(scheme=hex(scheme)):
                proof = self.loopback(rsa_leaf=rsa_leaf, restricted_pss=restricted_pss,
                                      without_finished=True, timeout=2000)
                parsed = parse_proof(proof.proof, proof.domain, proof.challenge)
                self.assertEqual(parsed.certificate_verify_scheme, scheme)
                self.assertEqual([message[0] for message in split_messages(proof.proof)], [1, 2, 8, 11, 15])

    def test_no_finished_does_not_bypass_certificate_signature_or_mask_checks(self):
        for mutation in ("certificate_signature", "cv_signature", "cv_mask"):
            with self.subTest(mutation=mutation):
                self.loopback(without_finished=True, mutation=mutation, timeout=2000)

    def test_socket_deadline_and_cancel_drain(self):
        self.loopback(stalled=True, timeout=200)
        self.loopback(stalled=True, cancel=100)

    def probe_loopback(self, *, rsa_leaf=True, restricted_pss=False, without_finished=False,
                       mutation=None, wrong_host=False, untrusted=False, moment=1800000000,
                       stalled=False, cancel=None, timeout=3000):
        if restricted_pss:
            leaf_key, leaf = rsa_identity(self.root, restricted=True)
            root, cert, key = self.root[1].public_bytes(PEM), leaf.public_bytes(PEM), pss_private_pem(leaf_key)
        else:
            root, cert, key = identity(rsa_leaf=rsa_leaf, leaf_domain="other.example" if wrong_host else "example.com")
        self.roots.write_bytes(self.root[1].public_bytes(PEM) if untrusted else root)
        cert_path, key_path = self.path / "probe-server.pem", self.path / "probe-server-key.pem"
        cert_path.write_bytes(cert)
        key_path.write_bytes(key)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
        context.num_tickets = 0
        context.load_cert_chain(cert_path, key_path)
        keylog = self.path / ("probe-" + str(time.monotonic_ns()) + ".keys")
        context.keylog_filename = str(keylog)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(4)
        completed, application_data, errors = [], [], []
        release = threading.Event()

        def serve():
            try:
                peer, _ = listener.accept()
                with peer:
                    peer.settimeout(4)
                    if stalled:
                        release.wait(4)
                    elif without_finished or mutation:
                        client_hello, flight = server_first_flight(context, peer)
                        flight = flight_through_certificate_verify(client_hello, flight, keylog, key, mutation,
                                                                  withhold_finished=without_finished)
                        peer.sendall(flight)
                        release.wait(4)
                    else:
                        with context.wrap_socket(peer, server_side=True) as encrypted:
                            completed.append(encrypted.version())
                            application_data.append(encrypted.recv(1))
            except (ssl.SSLError, OSError) as error:
                errors.append(str(error))
            finally:
                listener.close()

        worker = threading.Thread(target=serve)
        worker.start()
        envelope, _ = claims_bridge.parse_request(request())
        # Probe ignores external target/challenge/mask. Its native API generates
        # a fresh challenge and fixes RSA-only mask/max target independently.
        envelope = dataclasses.replace(envelope, signature_algorithms_mask=1,
                                       connection_work_target="00" * 32, validation_time=moment)
        started = time.monotonic()
        try:
            result = self.run_native(envelope, mode="probe", endpoint=listener.getsockname()[1],
                                     timeout=timeout, cancel=cancel)
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertLess(time.monotonic() - started, 4)
        if cancel is not None:
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr.strip(), "CLAIM_CANCELLED")
            return
        self.assertEqual(result.returncode, 0, result.stderr)
        status = result.stdout.strip()
        self.assertIn(status, ("verified", "failed", "timeout", "busy", "unavailable"))
        if stalled or without_finished:
            self.assertEqual(status, "timeout")
        elif mutation or wrong_host or untrusted or moment != 1800000000 or not rsa_leaf and not restricted_pss:
            self.assertEqual(status, "failed")
        else:
            self.assertEqual(status, "verified")
            self.assertEqual(completed, ["TLSv1.3"], errors)
            self.assertEqual(application_data, [b""], errors)
            lines = [line.split()[1] for line in keylog.read_text().splitlines()
                     if line.startswith("SERVER_HANDSHAKE_TRAFFIC_SECRET ")]
            self.assertEqual(len(lines), 1)
            return lines[0]

    def test_rsa_probe_completes_both_finished_and_uses_fresh_native_challenge(self):
        first = self.probe_loopback()
        second = self.probe_loopback()
        self.assertNotEqual(first, second)
        self.probe_loopback(restricted_pss=True)

    def test_rsa_probe_rejects_ecdsa_only_or_unauthenticated_certificates(self):
        self.probe_loopback(rsa_leaf=False)
        self.probe_loopback(wrong_host=True)
        self.probe_loopback(untrusted=True)
        self.probe_loopback(moment=1)
        for mutation in ("certificate_signature", "cv_signature"):
            with self.subTest(mutation=mutation):
                self.probe_loopback(mutation=mutation)

    def test_rsa_probe_requires_valid_finished_and_honors_cancel_deadline(self):
        self.probe_loopback(without_finished=True, timeout=600)
        self.probe_loopback(mutation="finished")
        self.probe_loopback(stalled=True, timeout=200)
        self.probe_loopback(stalled=True, cancel=100)

    def test_parallel_loopback_handshakes_and_timeout_cleanup(self):
        for rsa_leaf, stalled, count in ((False, False, 8), (True, False, 8), (False, True, 8), (False, False, 100)):
            with self.subTest(rsa_leaf=rsa_leaf, stalled=stalled, workers=count):
                root, cert, key = identity(rsa_leaf=rsa_leaf)
                self.roots.write_bytes(root)
                cert_path, key_path = self.path / "parallel.pem", self.path / "parallel-key.pem"
                cert_path.write_bytes(cert)
                key_path.write_bytes(key)
                server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                server_context.minimum_version = server_context.maximum_version = ssl.TLSVersion.TLSv1_3
                server_context.load_cert_chain(cert_path, key_path)
                listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                listener.bind(("127.0.0.1", 0))
                listener.listen(count)
                listener.settimeout(5)
                port = listener.getsockname()[1]
                release, all_connected = threading.Event(), threading.Event()
                peers, failures, completed = [], [], []

                def serve_peer(peer):
                    try:
                        with peer:
                            peer.settimeout(5)
                            all_connected.wait(5)
                            if stalled:
                                release.wait(5)
                            else:
                                _, flight = server_first_flight(server_context, peer)
                                peer.sendall(flight)
                                completed.append("server flight")
                                release.wait(5)
                    except Exception as error:
                        failures.append(str(error))

                def serve_all():
                    try:
                        for _ in range(count):
                            peer, _ = listener.accept()
                            worker = threading.Thread(target=serve_peer, args=(peer,))
                            peers.append(worker)
                            worker.start()
                        all_connected.set()
                    except Exception as error:
                        failures.append(str(error))
                    finally:
                        listener.close()

                server = threading.Thread(target=serve_all)
                server.start()
                context, _ = claims_bridge.parse_request(request())
                context = dataclasses.replace(context, signature_algorithms_mask=2 if rsa_leaf else 1)
                try:
                    result = self.run_native(context, mode="capture-parallel", endpoint=port,
                                             timeout=400 if stalled else 5000, workers=count)
                finally:
                    release.set()
                    server.join(6)
                    for peer in peers:
                        peer.join(6)
                self.assertFalse(server.is_alive())
                self.assertTrue(all(not peer.is_alive() for peer in peers))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(failures, [])
                self.assertEqual(len(peers), count)
                decoded = json.loads(result.stdout)
                if stalled:
                    self.assertFalse(decoded["captured"])
                    self.assertEqual(decoded["errorCode"], "CLAIM_TIMEOUT")
                else:
                    self.assertEqual(completed, ["server flight"] * count)
                    self.assertTrue(decoded["validProof"])
                    proof = dataclasses.replace(context, proof=bytes.fromhex(decoded["proof"]))
                    verify_connection_proof(proof, self.roots, enforce_root_pin=False)

    def test_loopback_tls_restricted_pss_key(self):
        proof = self.loopback(restricted_pss=True)
        parsed = parse_proof(proof.proof, proof.domain, proof.challenge)
        self.assertEqual(parsed.certificate_verify_scheme, 0x0809)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", required=True, type=Path)
    options, rest = parser.parse_known_args()
    CLI = options.cli.resolve(strict=True)
    unittest.main(argv=[sys.argv[0], *rest])
