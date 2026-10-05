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
from connectcoin_p2c_tools.errors import ProofFormatError, ProofVerificationError
from connectcoin_p2c_tools.verify import verify_connection_proof
from connectcoin_p2c_tools.protocol import parse_proof
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

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

    def run_native(self, envelope, *, mode="verify", endpoint=None, timeout=5000, cancel=None):
        proof = self.path / "proof.bin"
        proof.write_bytes(envelope.proof)
        args = [str(CLI), mode, envelope.domain, envelope.challenge.hex(),
                envelope.connection_work_target, str(envelope.signature_algorithms_mask),
                str(envelope.validation_time), str(self.roots), str(endpoint or proof)]
        if mode == "capture":
            args.append(str(timeout))
            if cancel is not None:
                args.append(str(cancel))
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

    def loopback(self, *, rsa_leaf=False, restricted_pss=False, stalled=False, cancel=None, timeout=5000):
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
                        with server_context.wrap_socket(peer, server_side=True) as encrypted:
                            completed.append(encrypted.version())
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
                self.assertFalse(failure["validProof"])
                self.assertFalse(failure["meetsTarget"])
                self.assertEqual(failure["proof"], "")
                self.assertEqual(failure["errorCode"], "CLAIM_TIMEOUT")
                self.assertGreaterEqual(failure["durationMs"], 150)
            self.assertLess(elapsed, 2)
            return
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(completed, ["TLSv1.3"])
        decoded = json.loads(result.stdout)
        self.assertTrue(decoded["validProof"])
        self.assertTrue(decoded["meetsTarget"])
        proof = dataclasses.replace(context, proof=bytes.fromhex(decoded["proof"]))
        verify_connection_proof(proof, self.roots, enforce_root_pin=False)
        return proof

    def test_completed_loopback_tls_ecdsa_and_rsae(self):
        for rsa_leaf in (False, True):
            with self.subTest(rsa_leaf=rsa_leaf):
                first = self.loopback(rsa_leaf=rsa_leaf)
                second = self.loopback(rsa_leaf=rsa_leaf)
                # Same challenge is intentional; ephemeral ECDHE must not repeat.
                self.assertNotEqual(split_messages(first.proof)[0], split_messages(second.proof)[0])

    def test_socket_deadline_and_cancel_drain(self):
        self.loopback(stalled=True, timeout=200)
        self.loopback(stalled=True, cancel=100)

    def test_completed_loopback_tls_restricted_pss_key(self):
        proof = self.loopback(restricted_pss=True)
        parsed = parse_proof(proof.proof, proof.domain, proof.challenge)
        self.assertEqual(parsed.certificate_verify_scheme, 0x0809)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cli", required=True, type=Path)
    options, rest = parser.parse_known_args()
    CLI = options.cli.resolve(strict=True)
    unittest.main(argv=[sys.argv[0], *rest])
