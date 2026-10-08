import XCTest
@testable import WalletCore

/// Public metadata only; no network connection, user wallet or broadcast.
final class NativePaymentInventoryTests: XCTestCase {
    private let address = "cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e"
    private let other = "cc1pqy06dh8mh3jc7vcnn6eyu5qx86t0tpnnkkw26f5v2ps6cwpet49s3gas98"
    private let id = String(repeating:"bb",count:32)
    private func tip(_ height: Int = 120) -> JSONObject {
        ["chain":"main","genesis_hash":NativePaymentChecks.GENESIS,"height":height,
         "hash":String(format:"%064x",height),"mediantime":1_700_000_000 + height]
    }
    private func row(_ vout: Int, amount: String = "30000", height: Int = 120) -> JSONObject {
        ["txid":id,"vout":vout,"amount":amount,"block_height":10,"status":"confirmed",
         "confirmations":height - 9,"coinbase":false,"mature":true,"pending_spent_by":NSNull()]
    }
    private func page(_ rows: [JSONObject], _ cursor: String? = nil, height: Int = 120, address: String? = nil) -> JSONObject {
        ["address":address ?? self.address,"tip":tip(height),"unit":"connects","live":true,"items":rows,"next_cursor":cursor as Any? ?? NSNull()]
    }
    private func journal(_ events: [JSONObject] = [], _ cursor: String = "watermark.signature", _ through: Int64 = 10,
                         _ more: Bool = false, height: Int = 120) -> JSONObject {
        ["tip":tip(height),"unit":"connects","changes":events,"next_cursor":cursor,"has_more":more,"through_sequence":through,"journal_epoch":1]
    }
    private func remove(_ sequence: Int, _ vout: Int, address: String? = nil) -> JSONObject {
        ["sequence":sequence,"address":address ?? self.address,"kind":"utxo","action":"remove","txid":id,"vout":vout]
    }
    private func upsert(_ sequence: Int, _ item: JSONObject) throws -> JSONObject {
        var event = remove(sequence, Int(try item.integer("vout"))); event["action"] = "upsert"; event["item"] = item; return event
    }
    private func live(_ scope: NativePaymentInventory.RowBudget.Scope? = nil, address: String? = nil) throws -> NativePaymentInventory {
        try NativePaymentInventory.fromWatermark(address ?? self.address,0,0,journal(),[:],scope)
    }
    private func complete(_ rows: [JSONObject], _ held: JSONObject = [:]) throws -> NativePaymentInventory {
        let inventory = try NativePaymentInventory(address,tip(),held); try inventory.accept(page(rows)); return inventory
    }
    func testOnlyCompleteInventoriesExposeCandidatesAndAtomicPages() throws {
        let inventory = try NativePaymentInventory(address,tip(),[:])
        XCTAssertThrowsError(try inventory.candidates()); try inventory.accept(page([row(0),row(1)],"first.signature"))
        XCTAssertThrowsError(try inventory.accept(page([row(2),row(1)])))
        XCTAssertEqual(inventory.rowCount(),2); XCTAssertEqual(inventory.pageCount(),1)
        XCTAssertThrowsError(try inventory.accept(page([row(2)],"first.signature")))
        XCTAssertThrowsError(try inventory.accept(page([],"next.signature")))
        XCTAssertThrowsError(try inventory.candidates())
        try inventory.accept(page([row(2)])); XCTAssertEqual(try inventory.candidates().count,3)
        XCTAssertThrowsError(try inventory.accept(page([row(3)])))
    }
    func testAggregateBudgetReleasesRejectedPagesAndRevokesLateReaders() throws {
        let budget = try NativePaymentInventory.RowBudget(3), firstScope = try budget.scope(), secondScope = try budget.scope()
        defer { budget.close(); firstScope.close(); secondScope.close() }
        let first = try live(firstScope), second = try live(secondScope)
        try first.accept(page([row(0),row(1)],"first.signature")); XCTAssertEqual(budget.rowCount(),2)
        XCTAssertThrowsError(try second.accept(page([row(10),row(11)]))); XCTAssertEqual(second.rowCount(),0)
        XCTAssertThrowsError(try first.accept(page([row(0)]))); XCTAssertEqual(budget.rowCount(),2)
        firstScope.close(); XCTAssertEqual(budget.rowCount(),0)
        XCTAssertThrowsError(try first.accept(page([row(2)])))
        try second.accept(page([row(10),row(11)])); try second.applyChanges(journal())
        XCTAssertEqual(try second.candidates().count,2)
        secondScope.close(); XCTAssertThrowsError(try second.candidates()); XCTAssertEqual(budget.rowCount(),0)
    }
    func testSixteenConcurrentPagesCannotOverbookBudget() throws {
        let budget = try NativePaymentInventory.RowBudget(10), scope = try budget.scope()
        defer { scope.close(); budget.close() }
        let inventories = try (0..<16).map { _ in try live(scope) }, mutex = NSLock()
        var accepted = 0, failures = [String]()
        DispatchQueue.concurrentPerform(iterations:16) { index in
            do { try inventories[index].accept(page([row(index)])); mutex.lock(); accepted += 1; mutex.unlock() }
            catch { if !error.localizedDescription.contains("memory limit") { mutex.lock(); failures.append(error.localizedDescription); mutex.unlock() } }
        }
        XCTAssertEqual(accepted,10); XCTAssertEqual(budget.rowCount(),10); XCTAssertTrue(failures.isEmpty)
        scope.close(); XCTAssertEqual(budget.rowCount(),0)
        for inventory in inventories { XCTAssertThrowsError(try inventory.accept(page([row(99)]))) }
    }
    func testSharedJournalChargesNetGrowthAcrossAddressOrder() throws {
        let budget = try NativePaymentInventory.RowBudget(2), scope = try budget.scope()
        defer { scope.close(); budget.close() }
        let first = try live(scope), second = try live(scope,address:other)
        try first.accept(page([row(0)])); try second.accept(page([row(1)],address:other))
        let events = try [upsert(11,row(2)),remove(12,1,address:other)]
        try NativePaymentInventory.applySharedChanges([first,second],journal(events,"transfer.signature",12))
        XCTAssertEqual(budget.rowCount(),2); XCTAssertEqual(try first.candidates().count,2); XCTAssertEqual(try second.candidates().count,0)
        try first.beginRefresh([:]); try second.beginRefresh([:])
        XCTAssertThrowsError(try NativePaymentInventory.applySharedChanges([first,second],journal([upsert(13,row(3))],"growth.signature",13)))
        XCTAssertEqual(budget.rowCount(),2); XCTAssertEqual(first.changesCursor(),"transfer.signature"); XCTAssertEqual(second.changesCursor(),"transfer.signature")
        XCTAssertThrowsError(try first.candidates()); XCTAssertThrowsError(try second.candidates())
    }
    func testOnlyValidDifferentSnapshotIsRetryable() throws {
        let inventory = try NativePaymentInventory(address,tip(),[:])
        let changed = page([row(0,height:121)],height:121)
        XCTAssertThrowsError(try inventory.accept(changed)) { XCTAssertTrue($0 is NativePaymentInventory.SnapshotChanged) }
        for fault in ["schema","amount","confirmations","chain","genesis"] {
            var malformed = changed, item = row(0,height:121), block = tip(121)
            switch fault {
            case "schema": malformed["extra"] = true
            case "amount": item["amount"] = "1e10"
            case "confirmations": item["confirmations"] = 111
            case "chain": block["chain"] = "testnet4"
            default: block["genesis_hash"] = String(repeating:"dd",count:32)
            }
            malformed["items"] = [item]; malformed["tip"] = block
            XCTAssertThrowsError(try inventory.accept(malformed)) { XCTAssertFalse($0 is NativePaymentInventory.SnapshotChanged) }
        }
        XCTAssertEqual(inventory.rowCount(),0); try inventory.accept(page([row(0)]))
    }
    func testLiveBaselineReplaysBehindCursorAndFreezesDrainTip() throws {
        let inventory = try live()
        try inventory.accept(page([row(10,height:121)],"baseline.signature",height:121))
        try inventory.accept(page([row(20,height:123)],height:123))
        XCTAssertTrue(inventory.complete()); XCTAssertFalse(inventory.reconciled()); XCTAssertThrowsError(try inventory.candidates())
        try inventory.applyChanges(journal([remove(11,10),upsert(12,row(5,height:124)),upsert(13,row(20,amount:"30001",height:124))],"first.signature",15,true,height:124))
        XCTAssertFalse(inventory.reconciled()); XCTAssertThrowsError(try inventory.candidates())
        XCTAssertThrowsError(try inventory.applyChanges(journal([upsert(14,row(30,height:125))],"wrong.signature",15,true,height:125)))
        XCTAssertEqual(inventory.changesCursor(),"first.signature")
        try inventory.applyChanges(journal([upsert(15,row(30,height:124))],"final.signature",15,false,height:124))
        let candidates = try inventory.candidates(); XCTAssertEqual(candidates.count,3)
        XCTAssertEqual(Set(try candidates.map { try $0.integer("vout") }),Set([5,20,30]))
        for row in candidates { XCTAssertEqual(try row.integer("confirmations"),115) }
        try inventory.verifySelected(candidates,true,"90001")
    }
    func testNetZeroChangesInvalidateOldInputsAndUseAllSnapshot() throws {
        let inventory = try live(); try inventory.accept(page([row(0)])); try inventory.applyChanges(journal())
        let selected = try inventory.candidates(); try inventory.verifySelected(selected,true,"30000")
        try inventory.beginRefresh([:]); XCTAssertThrowsError(try inventory.verifySelected(selected,true,"30000"))
        try inventory.applyChanges(journal([remove(11,0),upsert(12,row(1,height:121))],"replaced.signature",12,false,height:121))
        XCTAssertThrowsError(try inventory.verifySelected(selected,true,"30000"))
        try inventory.verifySelected(inventory.candidates(),true,"30000")
        let added = try complete([row(0),row(1)])
        XCTAssertThrowsError(try added.verifySelected(selected,true,"30000")); try added.verifySelected(selected,false,nil)
    }
    func testMaturityAndLocalReservationsAreProjectedWithoutStorageMutation() throws {
        var immature = row(0); immature["coinbase"] = true; immature["block_height"] = 119; immature["confirmations"] = 2; immature["mature"] = false
        let held: JSONObject = [id + ":1":String(repeating:"cc",count:32)]
        let inventory = try NativePaymentInventory.fromWatermark(address,journal(),held)
        try inventory.accept(page([immature,row(1)])); try inventory.applyChanges(journal([],"mature.signature",10,false,height:218))
        XCTAssertEqual(try inventory.candidates().first?.integer("confirmations"),100)
        let reserved = try inventory.pendingCandidates(); try inventory.verifySelected(reserved,false,nil)
        XCTAssertThrowsError(try inventory.verifySelected(reserved,true,"30000"))
        try inventory.beginRefresh([id + ":1":String(repeating:"dd",count:32)])
        try inventory.applyChanges(journal([],"refreshed.signature",10,false,height:219))
        XCTAssertThrowsError(try inventory.verifySelected(reserved,false,nil))
        XCTAssertEqual(held[id + ":1"] as? String,String(repeating:"cc",count:32))
        try inventory.beginRefresh([:]); try inventory.applyChanges(journal([],"cleared.signature",10,false,height:219))
        XCTAssertEqual(try inventory.candidates().count,2)
    }
    func testJournalRejectsMalformedPagesWithoutPartialPublication() throws {
        let inventory = try live(); try inventory.accept(page([row(0)]))
        for fault in ["address","epoch","through","sequence","item","amount","schema","network","cursor","empty"] {
            var last = try upsert(12,row(2,height:121)), item = row(2,height:121)
            var response = journal([],"valid.signature",12,false,height:121)
            switch fault {
            case "address": last["address"] = other
            case "epoch": response["journal_epoch"] = 2
            case "through": response["through_sequence"] = 11
            case "sequence": last["sequence"] = 11
            case "item": item["vout"] = 99
            case "amount": item["amount"] = "3e4"
            case "schema": last["extra"] = true
            case "network": var block = tip(121); block["genesis_hash"] = String(repeating:"ff",count:32); response["tip"] = block
            case "cursor": response["next_cursor"] = "watermark.signature"
            default: response["has_more"] = true
            }
            last["item"] = item
            response["changes"] = fault == "empty" ? [] : try [upsert(11,row(1,height:121)),last]
            XCTAssertThrowsError(try inventory.applyChanges(response)); XCTAssertEqual(inventory.rowCount(),1)
            XCTAssertEqual(inventory.changesCursor(),"watermark.signature"); XCTAssertFalse(inventory.reconciled())
        }
        try inventory.applyChanges(journal()); XCTAssertEqual(try inventory.candidates().count,1)
    }
    func testMoreThanOneThousandRowsAndAllPaginationLimits() throws {
        let inventory = try NativePaymentInventory(address,tip(),[:])
        try inventory.accept(page((0..<500).map { row($0) },"first.signature"))
        try inventory.accept(page((500..<1000).map { row($0) },"second.signature"))
        try inventory.accept(page((1000..<1201).map { row($0) })); XCTAssertEqual(try inventory.candidates().count,1201)
        let bounded = try NativePaymentInventory(address,tip(),[:])
        for at in 0..<(NativePaymentInventory.MAX_PAGES - 1) { try bounded.accept(page([row(at)],"p\(at).signature")) }
        XCTAssertThrowsError(try bounded.accept(page([row(999)],"overflow.signature")))
        XCTAssertEqual(bounded.pageCount(),511); try bounded.accept(page([row(999)])); XCTAssertEqual(bounded.pageCount(),512)
        XCTAssertThrowsError(try live().applyChanges(journal()))
        var unsafe = journal(); unsafe["through_sequence"] = Int64(9_007_199_254_740_992)
        XCTAssertThrowsError(try NativePaymentInventory.fromWatermark(address,unsafe,[:]))
    }
}
