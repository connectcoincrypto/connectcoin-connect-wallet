import Foundation
import XCTest
@testable import WalletCore

/// These paths stop before HD discovery and never connect to an RPC endpoint.
final class WalletCustodyTests: XCTestCase {
    private func directory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("connectwallet-custody-" + UUID().uuidString,isDirectory:true)
    }
    private func original(_ store: DurableWalletStore) throws -> Data {
        try store.saveVault(WalletVault.parse(DesktopCryptoVectors.envelope))
        return try XCTUnwrap(store.read(.vault,maxBytes:WalletVault.maxFileBytes))
    }
    func testUnsupportedImportedHdRangeCannotOverwriteExistingWallet() async throws {
        let folder = directory(); defer { try? FileManager.default.removeItem(at:folder) }
        let store = try DurableWalletStore(directory:folder), before = try original(store)
        let runtime = MobileWalletRuntime(directory:folder); await runtime.setActive(true)
        var payload = try WalletVault.newPayload(mnemonic:DesktopCryptoVectors.mnemonic)
        payload["receiveIndex"] = Int(Int32.max)
        let oversized = try WalletVault.encrypt(payload,password:DesktopCryptoVectors.password)
        do {
            _ = try await runtime.importEnvelope(Data(WalletVault.serialize(oversized).utf8),password:DesktopCryptoVectors.password,replace:true,replacementBackup:before)
            XCTFail("Unsupported HD vault replaced the current wallet")
        } catch { XCTAssertTrue(error.localizedDescription.contains("HD")) }
        XCTAssertEqual(try store.read(.vault,maxBytes:WalletVault.maxFileBytes),before)
        let state = try await runtime.publicState(); XCTAssertEqual(state["locked"] as? Bool,true)
        await runtime.setActive(false)
    }
    func testUnverifiedAndStaleBackupCannotAuthorizeReplacement() async throws {
        let folder = directory(); defer { try? FileManager.default.removeItem(at:folder) }
        let store = try DurableWalletStore(directory:folder), before = try original(store)
        let runtime = MobileWalletRuntime(directory:folder); await runtime.setActive(true)
        for backup in [nil,Data("not the verified vault".utf8)] as [Data?] {
            do {
                _ = try await runtime.installMnemonic(DesktopCryptoVectors.mnemonic,password:DesktopCryptoVectors.password,replace:true,imported:true,replacementBackup:backup)
                XCTFail("Unverified replacement was accepted")
            } catch { XCTAssertTrue(error.localizedDescription.contains("backup")) }
        }
        XCTAssertEqual(try store.read(.vault,maxBytes:WalletVault.maxFileBytes),before)
        await runtime.setActive(false)
    }
    func testBackgroundRevokesImportAndCustodyGateBlocksNewClaims() async throws {
        let folder = directory(); defer { try? FileManager.default.removeItem(at:folder) }
        let store = try DurableWalletStore(directory:folder), before = try original(store)
        let runtime = MobileWalletRuntime(directory:folder); await runtime.setActive(true)
        let operation = Task { try await runtime.importEnvelope(before,password:DesktopCryptoVectors.password,replace:true,replacementBackup:before) }
        try await Task.sleep(nanoseconds:10_000_000)
        do { _ = try await runtime.perform("claimsStart",["address":"not-used"]); XCTFail("Claims started during custody operation") }
        catch { XCTAssertTrue(error.localizedDescription.contains("wallet operation")) }
        await runtime.setActive(false)
        do { _ = try await operation.value; XCTFail("Background import replaced wallet") } catch {}
        XCTAssertEqual(try store.read(.vault,maxBytes:WalletVault.maxFileBytes),before)
    }
    func testNativeRecoveryIncludesBip39PassphraseAndExportIsExact() async throws {
        let folder = directory(); defer { try? FileManager.default.removeItem(at:folder) }
        let store = try DurableWalletStore(directory:folder), before = try original(store)
        let runtime = MobileWalletRuntime(directory:folder); await runtime.setActive(true)
        let secrets = try await runtime.recoverySecrets(password:DesktopCryptoVectors.password)
        XCTAssertEqual(secrets.mnemonic,DesktopCryptoVectors.mnemonic); XCTAssertEqual(secrets.passphrase,"café 🔑")
        let exported = try await runtime.exportEnvelope(password:DesktopCryptoVectors.password)
        XCTAssertEqual(exported,before)
        await runtime.setActive(false)
    }
    func testUnsupportedCurrentHdRangeCannotChangePasswordOnDisk() async throws {
        let folder = directory(); defer { try? FileManager.default.removeItem(at:folder) }
        let store = try DurableWalletStore(directory:folder)
        var payload = try WalletVault.newPayload(mnemonic:DesktopCryptoVectors.mnemonic); payload["changeIndex"] = 10_001
        try store.saveVault(WalletVault.encrypt(payload,password:DesktopCryptoVectors.password))
        let before = try XCTUnwrap(store.read(.vault,maxBytes:WalletVault.maxFileBytes))
        let runtime = MobileWalletRuntime(directory:folder); await runtime.setActive(true)
        do { _ = try await runtime.changePassword(old:DesktopCryptoVectors.password,new:"new public fixture password"); XCTFail("Unsupported vault changed password before preflight") }
        catch { XCTAssertTrue(error.localizedDescription.contains("HD")) }
        XCTAssertEqual(try store.read(.vault,maxBytes:WalletVault.maxFileBytes),before)
        await runtime.setActive(false)
    }
}
