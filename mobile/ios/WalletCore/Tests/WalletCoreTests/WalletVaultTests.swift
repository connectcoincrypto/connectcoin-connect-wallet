import XCTest
@testable import WalletCore

final class WalletVaultTests: XCTestCase {
    func testExactDesktopEnvelopeAndNonemptyPassphrase() throws {
        let envelope = try WalletVault.parse(DesktopCryptoVectors.envelope)
        XCTAssertEqual(try WalletVault.serialize(envelope), DesktopCryptoVectors.envelope)
        let payload = try WalletVault.decrypt(envelope, password: DesktopCryptoVectors.password)
        XCTAssertEqual(try payload.string("mnemonic"), DesktopCryptoVectors.mnemonic)
        XCTAssertEqual(try payload.string("passphrase"), "café 🔑")
        XCTAssertEqual(try payload.integer("receiveIndex"), 7); XCTAssertEqual(try payload.integer("changeIndex"), 3)
        let session = try VaultSession(mnemonic: payload.string("mnemonic"), passphrase: payload.string("passphrase")); defer { session.close() }
        XCTAssertEqual(try session.publicAccount(index: 0, change: 1).string("address"), "cc1plyra2xkx5va3m5djztl8eqfakdz2w3u4plquss6clyv3jzjwc8aqyuq2dt")
    }
    func testAuthenticationAndStrictEnvelopeValidation() throws {
        let original = try WalletVault.parse(DesktopCryptoVectors.envelope)
        XCTAssertThrowsError(try WalletVault.decrypt(original, password: "incorrect public password"))
        for field in ["ciphertext", "tag", "nonce", "salt"] {
            var copy = original; let old = try copy.string(field)
            copy[field] = (old.first == "0" ? "1" : "0") + old.dropFirst()
            XCTAssertThrowsError(try WalletVault.decrypt(copy, password: DesktopCryptoVectors.password))
        }
        for version: Any in [true, "1", 1.0, 2] {
            var copy = original; copy["version"] = version
            XCTAssertThrowsError(try WalletVault.serialize(copy))
        }
        for field in ["N", "r", "p", "keyLength"] {
            var copy = original, kdf = try copy.object("kdf"); kdf[field] = 2147483647; copy["kdf"] = kdf
            XCTAssertThrowsError(try WalletVault.serialize(copy))
        }
        for text in ["[]", "{\"version\":1,\"version\":1}", "{\"x\":\"\\ud800\"}", String(repeating: "x", count: WalletVault.maxFileBytes + 1)] {
            XCTAssertThrowsError(try WalletVault.parse(text))
        }
        var uppercase = original; uppercase["tag"] = String(repeating: "AA", count: 16)
        XCTAssertThrowsError(try WalletVault.serialize(uppercase))
        for password in ["short", String(repeating: "é", count: 513)] { XCTAssertThrowsError(try WalletVault.validatePassword(password)) }
    }
    func testFreshEncryptionMetadataUpdateAndRevocation() throws {
        var payload = try WalletVault.newPayload(name: "Public fixture", mnemonic: DesktopCryptoVectors.mnemonic)
        payload["desktopMetadata"] = ["retained": true]
        let session = try WalletVault.createForUpdate(payload, password: DesktopCryptoVectors.password); defer { session.close() }
        let original = try session.envelope(); var next = try session.payload(); next["receiveIndex"] = 9
        var saved: JSONObject?
        try session.save(next) { saved = $0 }
        let updated = try XCTUnwrap(saved)
        XCTAssertEqual(try original.string("salt"), updated.string("salt"))
        XCTAssertNotEqual(try original.string("nonce"), updated.string("nonce"))
        let reopened = try WalletVault.decrypt(updated, password: DesktopCryptoVectors.password)
        XCTAssertEqual(try reopened.integer("receiveIndex"), 9)
        XCTAssertEqual(try reopened.object("desktopMetadata").boolean("retained"), true)
        next["receiveIndex"] = 10
        XCTAssertThrowsError(try session.save(next) { _ in throw WalletError("Disk failure") })
        XCTAssertEqual(try session.payload().integer("receiveIndex"), 9)
        next["passphrase"] = "different wallet"
        XCTAssertThrowsError(try session.save(next) { _ in XCTFail("Identity change reached disk") })
        session.close(); XCTAssertTrue(session.isClosed)
        XCTAssertThrowsError(try session.payload()); XCTAssertThrowsError(try session.envelope())
        XCTAssertThrowsError(try session.save(payload) { _ in XCTFail("Closed writer reached disk") })
    }
    func testPasswordChangePreservesFullPayloadAndRotatesSaltNonce() throws {
        let original = try WalletVault.parse(DesktopCryptoVectors.envelope)
        let before = try WalletVault.decrypt(original, password: DesktopCryptoVectors.password)
        let changed = try WalletVault.changePassword(original, currentPassword: DesktopCryptoVectors.password, newPassword: "new public test password")
        let after = try WalletVault.decrypt(changed, password: "new public test password")
        XCTAssertEqual(try JSON.encode(before), JSON.encode(after))
        XCTAssertNotEqual(try original.string("salt"), changed.string("salt"))
        XCTAssertNotEqual(try original.string("nonce"), changed.string("nonce"))
        XCTAssertThrowsError(try WalletVault.decrypt(changed, password: DesktopCryptoVectors.password))
        XCTAssertEqual(try WalletVault.decrypt(original, password: DesktopCryptoVectors.password).string("mnemonic"), DesktopCryptoVectors.mnemonic)
    }
    func testPayloadTypesAndNetworkAreStrict() throws {
        var payload = try WalletVault.newPayload(name: "Fixture", mnemonic: DesktopCryptoVectors.mnemonic)
        for invalid: Any in [true, 1.0, "1", -1, Int(Int32.max) + 1] {
            payload["receiveIndex"] = invalid; XCTAssertThrowsError(try WalletVault.validatePayload(payload))
        }
        payload["receiveIndex"] = 0; payload["needsRecovery"] = 1
        XCTAssertThrowsError(try WalletVault.validatePayload(payload))
        payload["needsRecovery"] = false; payload["network"] = "testnet4"
        XCTAssertThrowsError(try WalletVault.validatePayload(payload))
    }
}
