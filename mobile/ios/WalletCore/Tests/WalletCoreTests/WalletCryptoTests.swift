import XCTest
@testable import WalletCore

final class WalletCryptoTests: XCTestCase {
    func testOfficialMnemonicEntropyAndSeed() throws {
        for (bytes, ending) in [(16,"about"),(24,"agent"),(32,"art")] {
            let expected = Array(repeating: "abandon", count: bytes / 4 * 3 - 1).joined(separator: " ") + " " + ending
            XCTAssertEqual(try WalletCrypto.mnemonicFromEntropy(Data(repeating: 0, count: bytes)), expected)
            XCTAssertTrue(WalletCrypto.validateMnemonic(expected))
            XCTAssertTrue(WalletCrypto.validateMnemonic(try WalletCrypto.generateMnemonic(bytes / 4 * 3)))
        }
        XCTAssertEqual(try WalletCrypto.hex(WalletCrypto.mnemonicToSeed(DesktopCryptoVectors.mnemonic, "TREZOR")),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04")
        XCTAssertEqual(try WalletCrypto.mnemonicToSeed(DesktopCryptoVectors.mnemonic, "caf\u{00e9}"),
            try WalletCrypto.mnemonicToSeed(DesktopCryptoVectors.mnemonic, "cafe\u{0301}"))
        XCTAssertFalse(WalletCrypto.validateMnemonic(Array(repeating: "abandon", count: 12).joined(separator: " ")))
        XCTAssertThrowsError(try WalletCrypto.generateMnemonic(15))
        XCTAssertThrowsError(try WalletCrypto.mnemonicToSeed(DesktopCryptoVectors.mnemonic, String(repeating: "x", count: 1025)))
    }
    func testWhitespaceMatchesDesktop() throws {
        for code in [UInt32(9),10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279] {
            let separator = String(UnicodeScalar(code)!)
            let phrase = separator + DesktopCryptoVectors.mnemonic.uppercased().replacingOccurrences(of: " ", with: separator) + separator
            XCTAssertEqual(try WalletCrypto.normalizeMnemonic(phrase), DesktopCryptoVectors.mnemonic)
        }
        for code in [UInt32(0),8,14,28,31,133,6158,8203,8288] {
            XCTAssertFalse(WalletCrypto.validateMnemonic(DesktopCryptoVectors.mnemonic.replacingOccurrences(of: " ", with: String(UnicodeScalar(code)!))))
        }
    }
    func testDesktopDerivationParityBoundaryAndSignatures() throws {
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(DesktopCryptoVectors.rows.utf8)) as? [[String: Any]])
        for row in rows {
            let session = try VaultSession(mnemonic: DesktopCryptoVectors.mnemonic, passphrase: row.string("passphrase"))
            defer { session.close() }
            let index = Int(try row.integer("index")), change = Int(try row.integer("change"))
            let account = try session.publicAccount(index: index, change: change)
            XCTAssertEqual(Set(account.keys), Set(["publicKey","address","path","network","index","change"]))
            for field in ["address", "publicKey", "path"] { XCTAssertEqual(try account.string(field), try row.string(field)) }
            let pub = try WalletCrypto.fromHex(row.string("publicKey")), digest = try WalletCrypto.fromHex(row.string("digest"))
            XCTAssertEqual(try WalletCrypto.decodeAddress(row.string("address").uppercased()), pub)
            XCTAssertTrue(WalletCrypto.verifySchnorr(try WalletCrypto.fromHex(row.string("signature")), digest, pub))
            let first = try session.signDigest(digest, index: index, change: change)
            let second = try session.signDigest(digest, index: index, change: change)
            XCTAssertNotEqual(first, second); XCTAssertTrue(WalletCrypto.verifySchnorr(first, digest, pub))
            var changed = digest; changed[0] ^= 1; XCTAssertFalse(WalletCrypto.verifySchnorr(first, changed, pub))
            session.lock(); XCTAssertTrue(session.isLocked)
            XCTAssertThrowsError(try session.publicAccount(index: index, change: change))
            XCTAssertThrowsError(try session.signDigest(digest, index: index, change: change))
        }
    }
    func testInvalidAddressesAndIndicesFailClosed() throws {
        let session = try VaultSession(mnemonic: DesktopCryptoVectors.mnemonic); defer { session.close() }
        let address = try session.publicAccount(index: 0, change: 0).string("address")
        for bad in ["", "t" + address, "CC" + address.dropFirst(2), String(address.dropLast()) + "q", " " + address, address + " "] {
            XCTAssertThrowsError(try WalletCrypto.decodeAddress(bad))
        }
        XCTAssertThrowsError(try WalletCrypto.validatePublicKey(Data(repeating: 0, count: 32)))
        XCTAssertThrowsError(try WalletCrypto.encodeAddress(Data(repeating: 255, count: 32)))
        XCTAssertThrowsError(try session.publicAccount(index: -1, change: 0))
        XCTAssertThrowsError(try session.publicAccount(index: Int(Int32.max) + 1, change: 0))
        XCTAssertThrowsError(try session.publicAccount(index: 0, change: 2))
        XCTAssertThrowsError(try session.signDigest(Data(count: 31), index: 0, change: 0))
        XCTAssertThrowsError(try WalletCrypto.fromHex("00zz"))
        XCTAssertThrowsError(try WalletCrypto.fromHex("0"))
        XCTAssertThrowsError(try WalletCrypto.fromHex("\u{ff10}\u{ff10}"))
        XCTAssertEqual(try WalletCrypto.hex(WalletCrypto.sha256(Data("abc".utf8))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
}
