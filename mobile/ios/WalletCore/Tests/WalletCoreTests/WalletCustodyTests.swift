import Foundation
import XCTest
@testable import WalletCore

private actor ActivityTransitionPause {
    private var paused: CheckedContinuation<Void,Never>?
    private var entered: CheckedContinuation<Void,Never>?
    func hold() async {
        await withCheckedContinuation { continuation in
            paused = continuation; entered?.resume(); entered = nil
        }
    }
    func waitUntilHeld() async {
        if paused != nil { return }
        await withCheckedContinuation { entered = $0 }
    }
    func release() { paused?.resume(); paused = nil }
}

/// These paths stop before HD discovery and never connect to an RPC endpoint.
final class WalletCustodyTests: XCTestCase {
    private func directory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("connectwallet-custody-" + UUID().uuidString,isDirectory:true)
    }
    private func original(_ store: DurableWalletStore) throws -> Data {
        try store.saveVault(WalletVault.parse(DesktopCryptoVectors.envelope))
        return try XCTUnwrap(store.read(.vault,maxBytes:WalletVault.maxFileBytes))
    }
    func testOlderBackgroundCleanupCannotDisableNewForegroundPolicyAndTimer() async throws {
        let folder = directory(); defer { try? FileManager.default.removeItem(at:folder) }
        let runtime = MobileWalletRuntime(directory:folder), pause = ActivityTransitionPause()
        await runtime.setActive(true)
        let initialTimer = await runtime.hasInactivityTimer; XCTAssertTrue(initialTimer)
        // Park exactly where closing an older HD actor can suspend. Resume the
        // foreground completely before allowing that old cleanup to continue.
        let background = Task { await runtime.setActive(false,afterLock:{ await pause.hold() }) }
        await pause.waitUntilHeld()
        await runtime.setActive(true)
        let resumedTimer = await runtime.hasInactivityTimer; XCTAssertTrue(resumedTimer)
        await pause.release(); await background.value
        let retainedTimer = await runtime.hasInactivityTimer; XCTAssertTrue(retainedTimer)
        // This native operation requires claims.foreground == true, and writes
        // only the isolated fixture's local policy (no capture or RPC request).
        _ = try await runtime.perform("claimsLimits",["connectionsPerSecondLimit":1,"concurrency":1])
        await runtime.setActive(false)
        let stoppedTimer = await runtime.hasInactivityTimer; XCTAssertFalse(stoppedTimer)
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
        let settings = try await runtime.perform("getSettings")
        XCTAssertEqual(Set(settings.keys),Set(["theme","autoLockMinutes","rpcHost","rpcPort"]))
        let watch = try await runtime.perform("watchAccount")
        XCTAssertTrue(watch["address"] is NSNull); XCTAssertEqual(watch["connected"] as? Bool,false)
        let snapshots = try await runtime.perform("getRecoverySnapshots")
        XCTAssertEqual(Set(snapshots.keys),Set(["walletId","groups"])); XCTAssertTrue(snapshots["walletId"] is NSNull)
        let saved = try await runtime.perform("saveSettings",settings)
        XCTAssertEqual(try saved.object("state")["locked"] as? Bool,true)
        await runtime.setActive(false)
    }
    func testSuccessfulPasswordChangeRemainsLockedAndPreservesImportedPassphrase() async throws {
        let folder = directory(); defer { try? FileManager.default.removeItem(at:folder) }
        let store = try DurableWalletStore(directory:folder); _ = try original(store)
        let runtime = MobileWalletRuntime(directory:folder); await runtime.setActive(true)
        let nextPassword = "new public fixture password"
        let state = try await runtime.changePassword(old:DesktopCryptoVectors.password,new:nextPassword)
        XCTAssertEqual(state["locked"] as? Bool,true); XCTAssertEqual(state["exists"] as? Bool,true)
        let reopened = try WalletVault.decrypt(store.readVault(),password:nextPassword)
        XCTAssertEqual(try reopened.string("passphrase"),"café 🔑")
        XCTAssertThrowsError(try WalletVault.decrypt(store.readVault(),password:DesktopCryptoVectors.password))
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
