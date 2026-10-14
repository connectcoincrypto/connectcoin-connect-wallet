# Third-party software

ConnectWallet uses the following independent projects. This file identifies important dependencies and their licenses; it is not a complete software bill of materials or a replacement for their full license texts. Distributors must retain the applicable notices for the exact dependencies and runtimes included in their packages.

- Electron and Node.js: MIT and bundled third-party notices.
- `@scure/bip39`, `@scure/bip32`, `@scure/base`, `@noble/curves` and their hash dependency: MIT, Paul Miller and contributors.
- `qrcode`: MIT, its contributors.
- The ConnectCoin typed transaction and consensus formats are implemented for interoperability with [ConnectCoin Core](https://github.com/connectcoincrypto/connectcoin), MIT licensed.
- The vendored P2C proof toolkit: MIT, ConnectCoin contributors. Its complete notice is in `helpers/vendor/LICENSE.connectcoin-p2c-tools`; see `helpers/PROVENANCE.md` for the exact source revision and local hardening changes.
- The native claims runtime is adapted from ConnectCoin Core and connectcoin-claimer (MIT), with the detailed revision and validation policy in `native/PROVENANCE.md`. Its statically linked Mbed TLS 3.6.7 / Everest / p256-m components use Apache-2.0; UniValue and Bitcoin Core SHA-NI compression use MIT. Packages include full native licenses under `claims-helper/licenses` and a checksum manifest.
- Python (development/differential-test reference only, not included in desktop packages): Python Software Foundation License and bundled notices.
- `cryptography`: Apache-2.0 or BSD-3-Clause, with its bundled OpenSSL notices.
- `cffi` 2.1.1: [MIT No Attribution (MIT-0)](https://github.com/python-cffi/cffi/blob/main/LICENSE).
- `pycparser` 3.0: [BSD-3-Clause](https://github.com/eliben/pycparser/blob/main/LICENSE), Eli Bendersky and contributors.
- PyInstaller: [GPL-2.0-or-later with the bootloader distribution exception](https://pyinstaller.org/en/stable/license.html). The exception permits distributing the resulting application without licensing the application's own code under the GPL.
- The pinned certificate root bundle is distributed unchanged from ConnectCoin Core and originates from Mozilla's certificate store through curl's CA Extract. The [CA Extract licensing notice](https://curl.se/docs/caextract.html) identifies the bundle as [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/). Its exact SHA-256 and provenance are documented in `helpers/PROVENANCE.md`; the pinned file must not be modified without a protocol-compatible root-bundle update.

Development-only tools include Playwright, electron-builder, Python, cryptography, cffi, pycparser and legacy Python helper build tooling; refer to each package's included license. The desktop runtime does not require Python or OpenSSL.
