import XCTest
@testable import WalletCore

final class DurableWalletStoreTests: XCTestCase {
    func testAtomicFilesRoundTripAndOversizedReadsFailClosed() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("connectwallet-store-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try DurableWalletStore(directory: directory)
        XCTAssertFalse(store.exists(.settings))
        XCTAssertNil(try store.read(.settings))
        let original = try JSON.encode(["theme": "dark"])
        try store.write(.settings, original); XCTAssertEqual(try store.read(.settings), original)
        let next = try JSON.encode(["theme": "light"])
        try store.write(.settings, next); XCTAssertEqual(try store.read(.settings), next)
        XCTAssertThrowsError(try store.read(.settings, maxBytes: 1))
        XCTAssertThrowsError(try store.write(.settings, Data()))
        XCTAssertEqual(try store.read(.settings), next)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["settings.json"])
    }
    func testLifecycleRevocationCannotBeAdoptedByStaleOperation() throws {
        let fence = WalletLifecycleFence(), first = fence.token()
        var saved = false
        _ = fence.invalidate()
        XCTAssertThrowsError(try fence.commit(first) { saved = true })
        XCTAssertFalse(saved)
        try fence.commit(fence.token()) { saved = true }
        XCTAssertTrue(saved)
    }
}
