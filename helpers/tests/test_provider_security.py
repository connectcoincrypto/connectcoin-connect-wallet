"""Ensure source and bundled helper self-tests cannot bless old providers."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import cryptography
from cryptography.hazmat.backends.openssl.backend import backend

HELPERS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HELPERS))
import claims_bridge


class ProviderSecurityTests(unittest.TestCase):
    def test_rejects_vulnerable_unknown_and_prerelease_versions(self):
        for version in ("47.0.0", "48.0.0", "49.0.0", "50.0.0", "50.0.1rc1",
                        "51.0.0.dev1", "unknown", "50.0", "50.0.1+local"):
            with self.subTest(version=version), patch.object(cryptography, "__version__", version):
                with self.assertRaisesRegex(RuntimeError, "50.0.1 or newer stable release"):
                    claims_bridge.security_provider_versions()

    def test_reports_loaded_provider_and_accepts_patched_stable_releases(self):
        for version in ("50.0.1", "50.0.2", "51.0.0"):
            with self.subTest(version=version), patch.object(cryptography, "__version__", version):
                self.assertEqual(claims_bridge.security_provider_versions(), {
                    "cryptographyVersion": version,
                    "minimumCryptographyVersion": "50.0.1",
                    "opensslVersion": backend.openssl_version_text(),
                })


if __name__ == "__main__":
    unittest.main()
