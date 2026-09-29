"""Copy original runtime/dependency notices into the generated helper artifact.

No license text is synthesized. Third-party Rust crate archives are verified
against the exact SHA-256 checksums in cryptography's installed wheel SBOM.
"""

from __future__ import annotations

import hashlib
import importlib.metadata as metadata
import io
import json
import re
import shutil
import ssl
import sys
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT / "tmp" / "claims-licenses"
CACHE = (PROJECT / "tmp" / "claims-license-cache").resolve()
MANIFEST: list[dict] = []


def fetch(url: str, limit: int = 20 * 1024 * 1024) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "ConnectWallet-License-Bundler/1"})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("License source exceeds the download limit")
    return data


def save(relative: str, data: bytes, source: str) -> dict:
    path = (OUTPUT / relative).resolve()
    if not path.is_relative_to(OUTPUT) or len(data) > 8 * 1024 * 1024:
        raise ValueError("Invalid license artifact path or size")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"file": relative, "source": source, "sha256": hashlib.sha256(data).hexdigest()}


def local_or_upstream(name: str, candidates: list[Path], url: str) -> None:
    for candidate in candidates:
        if candidate.is_file():
            MANIFEST.append(save(name, candidate.read_bytes(), f"installed CPython {sys.version.split()[0]}: {candidate.name}"))
            return
    MANIFEST.append(save(name, fetch(url, 1024 * 1024), url))


def crate_notices(component: dict) -> list[dict]:
    name, version = component["name"], component["version"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not re.fullmatch(r"[A-Za-z0-9.+-]+", version):
        raise ValueError("Invalid SBOM crate identity")
    expected = next(item["content"] for item in component["hashes"] if item["alg"] == "SHA-256")
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Invalid SBOM crate checksum")
    url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
    cached = CACHE / f"{expected}.crate"
    data = cached.read_bytes() if cached.is_file() else b""
    if hashlib.sha256(data).hexdigest() != expected:
        data = fetch(url)
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"License source checksum differs from the wheel SBOM: {name}")
        cached.write_bytes(data)
    result = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not re.match(r"(?i)^(license|licence|copying|notice|copyright)", Path(member.name).name):
                continue
            if member.size > 1024 * 1024 or len(result) >= 128:
                raise ValueError("Oversized third-party license archive")
            # Never extract an archive pathname into the filesystem.
            text = archive.extractfile(member).read()
            filename = f"{len(result):02d}-{Path(member.name).name}"
            result.append(save(f"rust/{name}-{version}/{filename}", text, f"{url}#{member.name}"))
    if not result:
        raise ValueError(f"No original license notice was found for {name} {version}")
    return result


def main() -> None:
    # Rebuild only this generated staging directory. Otherwise notices/SBOMs
    # from an older provider are silently shipped beside the new manifest.
    # Never follow a substituted link/junction to a different directory.
    if OUTPUT.resolve() != PROJECT / "tmp" / "claims-licenses" or OUTPUT.is_symlink():
        raise ValueError("Unexpected license staging directory")
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(parents=True, exist_ok=True)
    version = ".".join(map(str, sys.version_info[:3]))
    base = Path(sys.base_prefix)
    local_or_upstream(f"python-{version}/LICENSE.txt", [base / "LICENSE.txt", base / "LICENSE"],
                      f"https://raw.githubusercontent.com/python/cpython/v{version}/LICENSE")
    local_or_upstream(f"python-{version}/third-party-license.rst", [base / "Doc/html/_sources/license.rst.txt"],
                      f"https://raw.githubusercontent.com/python/cpython/v{version}/Doc/license.rst")
    for name in ("cryptography", "cffi", "pycparser", "pyinstaller", "pyinstaller-hooks-contrib",
                 "altgraph", "packaging", "setuptools"):
        distribution = metadata.distribution(name)
        copied = 0
        for file in distribution.files or []:
            path = Path(str(file))
            if re.match(r"(?i)^(license|licence|copying|notice|copyright)", path.name) or "sboms" in path.parts:
                source = Path(distribution.locate_file(file))
                destination = f"{name}-{distribution.version}/{copied:02d}-{path.name}"
                MANIFEST.append(save(destination, source.read_bytes(), f"installed {name}@{distribution.version}: {file}"))
                copied += 1
        if not copied:
            raise ValueError(f"No original license notice was found for {name}")
    crypto = metadata.distribution("cryptography")
    native = json.loads(crypto.read_text("sboms/sbom.json"))
    openssl_versions = {item["version"] for item in native.get("components", []) if item["name"] == "openssl"}
    runtime_version = re.match(r"OpenSSL ([0-9]+\.[0-9]+\.[0-9]+)", ssl.OPENSSL_VERSION)
    if runtime_version:
        openssl_versions.add(runtime_version[1])
    for openssl_version in sorted(openssl_versions):
        if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", openssl_version):
            raise ValueError("Unexpected OpenSSL version in the build environment")
        url = f"https://raw.githubusercontent.com/openssl/openssl/openssl-{openssl_version}/LICENSE.txt"
        MANIFEST.append(save(f"openssl-{openssl_version}/LICENSE.txt", fetch(url, 1024 * 1024), url))
    rust = json.loads(crypto.read_text("sboms/cryptography-rust.cyclonedx.json"))
    components = [item for item in rust.get("components", []) if item.get("bom-ref", "").startswith("registry+")]
    with ThreadPoolExecutor(max_workers=6) as executor:
        for notices in executor.map(crate_notices, components):
            MANIFEST.extend(notices)
    (OUTPUT / "manifest.json").write_text(json.dumps(sorted(MANIFEST, key=lambda value: value["file"]), indent=2) + "\n", encoding="utf-8")
    print(f"Collected {len(MANIFEST)} original runtime and dependency license/SBOM files.")


if __name__ == "__main__":
    main()
