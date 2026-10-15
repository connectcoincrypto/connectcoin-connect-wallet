import XCTest
@testable import WalletCore

final class ClaimCompactTrafficTests: XCTestCase {
    private func hash(_ n: Int) -> String { String(format: "%064x", n) }
    private func window(_ height: Int = 3, count: Int = 1) throws -> ClaimRecentWindow {
        let blocks: [JSONObject] = (0...height).reversed().map { h in
            ["height": h, "hash": h == 0 ? NativePaymentChecks.GENESIS : hash(h), "bounty_count": h == height ? count : 0]
        }
        return try ClaimRecentWindow(["window": 600, "bounty_counts": 1, "blocks": blocks,
            "tip": ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS, "height": height,
                "hash": hash(height), "mediantime": 1_700_000_000 + height] as JSONObject])
    }
    private func row(_ window: ClaimRecentWindow, vout: Int = 0) -> JSONObject {
        ["txid": hash(99), "vout": vout, "block_hash": window.tip.hash, "block_height": window.tip.height,
            "confirmations": 1, "amount": "1000000", "domain": "example.com", "connection_work_target": String(repeating: "f", count: 64),
            "root_certificates_version": 1, "signature_algorithms_mask": 7, "coinbase": false, "status": "available", "spending_txid": NSNull()]
    }
    private func added(_ row: JSONObject, sequence: Int = 1, ref: Int = -1) -> JSONObject {
        ["type": "added", "sequence": sequence, "tip_ref": ref, "bounty": row]
    }
    private func page(_ changes: [JSONObject], cursor: String = "next") -> JSONObject {
        ["compact": 3, "tip": NSNull(), "block_delta": [Any](), "changes": changes, "next_cursor": cursor]
    }
    func testWireDigestsMatchIndependentJavaScriptGoldenVectors() throws {
        let known = try window()
        XCTAssertEqual(try ClaimBountyCodec.stateDigest(known.tip, "base"), "08da12f0a00745d4b4c7e3aed6facfe2c95a51bd74809d76917b4667622e23d9")
        XCTAssertEqual(try ClaimBountyCodec.immutableDigest(row(known)), "164b61790e3b4ffb55d4614cd873945ef2122439a6c8a66891a2410edd0a46de")
    }
    func testCompactV1AndV2RealStateEventsMayOmitOuterBlockHash() throws {
        let known = try window(), full = row(known), cached = try ClaimCandidate(full, block: known.tip.hash, fee: 0)
        for version in 1...3 {
            let event: JSONObject = ["type": "pending_spend", "sequence": 1, "txid": full["txid"]!, "vout": 0,
                "tip_ref": 0, "bounty_ref": try ClaimBountyCodec.immutableDigest(full), "spending_txid": hash(400),
                "bounty_delta": ["status": "pending_spend", "spending_txid": hash(400), "confirmations": 1] as JSONObject]
            var wire: JSONObject = ["compact": version, "tip": known.tip.json, "tips": [known.tip.json],
                "changes": [event], "has_more": false, "next_cursor": "next"]
            if version == 1 { wire["bounty_deltas"] = 1 }
            let expanded = try ClaimBountyCodec.expand(wire, window: known, cursor: "base", rows: [cached.key: cached])
            let bounty = try PJ.object(PJ.objects(expanded["changes"])[0]["bounty"])
            XCTAssertEqual(bounty["status"] as? String, "pending_spend")
            XCTAssertEqual(bounty["block_hash"] as? String, known.tip.hash)
        }
    }
    func testResetRequiresCurrentFullManifestAndDiscardsOldCountCapabilities() async throws {
        let known = try window(), blockRows = known.blocks.map { ["hash": $0.hash, "height": $0.height] as JSONObject }
        var calls: [JSONObject] = []
        let refreshed = try await ClaimRecentWindow.refresh(expected: known.tip, known: known, force: true) { params in
            calls.append(params)
            return ["window": 600, "tip": known.tip.json, "blocks": blockRows]
        }
        XCTAssertEqual(calls.count, 1); XCTAssertNil(calls[0]["count"])
        XCTAssertTrue(refreshed.counts.isEmpty)
    }
    func testUnknownReferenceDoesNotMaskMalformedBlockDeltaOrAddedSibling() throws {
        let known = try window(), full = row(known)
        let unknown: JSONObject = ["type": "matured", "sequence": 1, "txid": full["txid"]!, "vout": 0,
            "tip_ref": -1, "bounty_ref": try ClaimBountyCodec.immutableDigest(full),
            "bounty_delta": ["status": "available", "spending_txid": NSNull()] as JSONObject]
        var wrongDelta = page([unknown]); wrongDelta["tip"] = [4, hash(4), 1_700_000_004] as [Any]
        wrongDelta["block_delta"] = [[known.tip.hash, 1] as [Any]]
        var missingAdded = added(full, sequence: 2); missingAdded.removeValue(forKey: "bounty")
        for malformed in [wrongDelta, page([unknown, missingAdded])] {
            XCTAssertThrowsError(try ClaimBountyCodec.expand(malformed, window: known, cursor: "base", rows: [:])) { error in
                XCTAssertNotEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_REFERENCE")
            }
        }
    }
    func testUnknownReferenceCannotMaskCanonicalPublicationOrRowContradictions() throws {
        let known = try window(), empty = try window(count: 0), full = row(known)
        let unknown: JSONObject = ["type": "matured", "sequence": 1, "txid": full["txid"]!, "vout": 0,
            "tip_ref": -1, "bounty_ref": try ClaimBountyCodec.immutableDigest(full),
            "bounty_delta": ["status": "available", "spending_txid": NSNull()] as JSONObject]
        var historical = row(known, vout: 1); historical["block_height"] = 2; historical["block_hash"] = hash(2)
        var orphanPublication = page([unknown, added(historical, sequence: 2, ref: 0)])
        orphanPublication["tips"] = [["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
            "height": 2, "hash": hash(800), "mediantime": 1_700_000_002] as JSONObject]
        var orphanRow = row(known, vout: 1); orphanRow["block_hash"] = hash(800)
        let cases: [(JSONObject, ClaimRecentWindow)] = [
            (orphanPublication, known), (page([unknown, added(orphanRow, sequence: 2)]), known),
            (page([unknown, added(full, sequence: 2)]), empty)
        ]
        for (wire, base) in cases {
            XCTAssertThrowsError(try ClaimBountyCodec.expand(wire, window: base, cursor: "base", rows: [:])) { error in
                XCTAssertNotEqual((error as? WalletError)?.message, "CLAIMS_UNKNOWN_REFERENCE")
            }
        }
    }
    func testPartialEvidenceIsRetainedAndComparedAgainstCompleteStream() async throws {
        let known = try window(count: 2), full = row(known), other = row(known, vout: 1)
        let first = try await ClaimDiscoveryReplay.read(known: known, cursor: "base", catalog: [:], loaded: []) { _, _ in self.page([self.added(full)]) }
        XCTAssertEqual(first.incomplete.count, 1); XCTAssertTrue(first.catalog.isEmpty)
        let a = try ClaimCandidate(full, block: known.tip.hash, fee: 0), b = try ClaimCandidate(other, block: known.tip.hash, fee: 0)
        let complete = try await ClaimDiscoveryReplay.read(known: known, cursor: first.cursor, catalog: [:], loaded: first.loaded,
            newBlock: known.tip.hash, staged: [a.key: a, b.key: b], incomplete: first.incomplete) { _, _ in ["compact": 3, "unchanged": true] }
        XCTAssertEqual(complete.catalog.count, 2); XCTAssertTrue(complete.incomplete.isEmpty)
        do {
            _ = try await ClaimDiscoveryReplay.read(known: known, cursor: first.cursor, catalog: [:], loaded: first.loaded,
                newBlock: known.tip.hash, staged: [b.key: b], incomplete: first.incomplete) { _, _ in ["compact": 3, "unchanged": true] }
            XCTFail("A stream silently dropped a previously authenticated inline row")
        } catch {}
    }
    func testV3UnchangedReconstructsOnlyAuthenticatedBase() throws {
        let known = try window()
        let result = try ClaimBountyCodec.expand(["compact": 3, "unchanged": true], window: known, cursor: "base", rows: [:])
        XCTAssertEqual(result["next_cursor"] as? String, "base")
        XCTAssertTrue(try PJ.objects(result["changes"]).isEmpty)
        XCTAssertEqual(try known.applying(result), known)
        XCTAssertThrowsError(try ClaimBountyCodec.expand(["compact": 3, "unchanged": true], window: nil, cursor: "base", rows: [:]))
        XCTAssertThrowsError(try ClaimBountyCodec.expand(["compact": 3, "unchanged": true, "tip": NSNull()], window: known, cursor: "base", rows: [:]))
    }
    func testCompactResyncUsesExistingSnapshotRecovery() throws {
        for version in 1...3 {
            XCTAssertThrowsError(try ClaimBountyCodec.expand(["compact": version, "changes": [["type": "resync_required"]]],
                window: window(), cursor: "base", rows: [:])) { error in
                XCTAssertEqual((error as? RpcFailure)?.code, "-32011")
            }
        }
    }
    func testV3AliasesDoNotRepairInvalidWireTipIndices() throws {
        let known = try window(count: 2), a = row(known), b = row(known, vout: 1)
        for refs in [[-2, 0], [0, -2]] {
            XCTAssertThrowsError(try ClaimBountyCodec.expand(page([added(a, ref: refs[0]), added(b, sequence: 2, ref: refs[1])]),
                window: known, cursor: "base", rows: [:]))
        }
        let valid = try ClaimBountyCodec.expand(page([added(a, ref: -2)]), window: known, cursor: "base", rows: [:])
        XCTAssertEqual(try PJ.objects(valid["changes"]).count, 1)
    }
    func testV3HistoricalConfirmationsAreDerivedFromPublicationNotCurrentTip() throws {
        let old = try window(), current = try window(4), full = row(old)
        let cached = try ClaimCandidate(full, block: old.tip.hash, fee: 0)
        let event: JSONObject = ["type": "pending_spend", "sequence": 1, "txid": full["txid"]!, "vout": 0,
            "block_hash": old.tip.hash, "tip_ref": -2, "bounty_ref": try ClaimBountyCodec.immutableDigest(full),
            "spending_txid_ref": true, "bounty_delta": ["status": "pending_spend", "spending_txid": hash(100)] as JSONObject]
        let wire: JSONObject = ["compact": 3, "tip": [current.tip.height, current.tip.hash, current.tip.medianTime] as [Any],
            "block_delta": [[NSNull(), 1] as [Any]], "changes": [event], "next_cursor": "next"]
        let expanded = try ClaimBountyCodec.expand(wire, window: old, cursor: "base", rows: [cached.key: cached])
        let output = try PJ.object(PJ.objects(expanded["changes"])[0]["bounty"])
        XCTAssertEqual(try PJ.integer(output["confirmations"]), 1)
        var invalid = event; invalid["bounty_ref"] = hash(400)
        var bad = wire; bad["changes"] = [invalid]
        XCTAssertThrowsError(try ClaimBountyCodec.expand(bad, window: old, cursor: "base", rows: [cached.key: cached]))
    }
    func testV3RejectsExplicitBadDefaultsAndDuplicateSequencesBeforeFallback() throws {
        let known = try window(), full = row(known)
        for key in ["changes", "tips", "has_more", "next_cursor"] {
            var bad = page([added(full)]); bad[key] = NSNull()
            XCTAssertThrowsError(try ClaimBountyCodec.expand(bad, window: known, cursor: "base", rows: [:]), key)
        }
        XCTAssertThrowsError(try ClaimBountyCodec.expand(page([added(full), added(full)]), window: known, cursor: "base", rows: [:]))
    }
    func testCanonicalCountsAndBlockDeltaRejectContradictions() throws {
        let known = try window(), next = try window(4, count: 0)
        let wire: JSONObject = ["compact": 3, "tip": [next.tip.height, next.tip.hash, next.tip.medianTime] as [Any],
            "block_delta": [[NSNull(), 0] as [Any]]]
        let expanded = try ClaimBountyCodec.expand(wire, window: known, cursor: "base", rows: [:])
        let result = try XCTUnwrap(known.applying(expanded))
        XCTAssertEqual(result.tip, next.tip); XCTAssertEqual(result.counts[next.tip.hash], 0)
        XCTAssertEqual(result.counts[known.tip.hash], 1)
        var bad = expanded; bad["block_delta"] = ["base_hash": hash(700), "base_height": 3, "blocks": []] as JSONObject
        XCTAssertThrowsError(try known.applying(bad))
    }
    func testCompleteInlineRowsSkipStreamAndFenceButPreserveProgress() async throws {
        let known = try window(), full = row(known)
        var methods: [String] = []
        let result = try await ClaimDiscoveryReplay.read(known: known, cursor: "base", catalog: [:], loaded: []) { method, params in
            methods.append(method); XCTAssertEqual(method, "getbountychanges")
            XCTAssertEqual(params["known_state"] as? String, try ClaimBountyCodec.stateDigest(known.tip, "base"))
            return self.page([self.added(full)])
        }
        XCTAssertEqual(methods, ["getbountychanges"])
        XCTAssertTrue(result.loaded.contains(known.tip.hash)); XCTAssertEqual(result.catalog.count, 1)
        let saved = try XCTUnwrap(result.catalog.values.first); saved.progress.captures = 22
        let unchanged = try await ClaimDiscoveryReplay.read(known: result.window, cursor: result.cursor,
            catalog: result.catalog, loaded: result.loaded) { _, _ in ["compact": 3, "unchanged": true] }
        XCTAssertTrue(unchanged.catalog[saved.key]?.progress === saved.progress)
        XCTAssertEqual(unchanged.catalog[saved.key]?.progress.captures, 22)
    }
    func testPartialInlineRowsNeverBecomeSchedulerCandidates() async throws {
        let known = try window(count: 2), full = row(known)
        let result = try await ClaimDiscoveryReplay.read(known: known, cursor: "base", catalog: [:], loaded: []) { _, _ in self.page([self.added(full)]) }
        XCTAssertFalse(result.loaded.contains(known.tip.hash)); XCTAssertTrue(result.catalog.isEmpty)
        XCTAssertEqual(result.incomplete.count, 1)
        XCTAssertTrue(result.requiresStreams.isEmpty)
    }
    func testMixedLegacyPageInvalidatesInlineAccumulator() async throws {
        let known = try window(), full = row(known)
        var calls = 0
        let result = try await ClaimDiscoveryReplay.read(known: known, cursor: "base", catalog: [:], loaded: []) { method, _ in
            if method == "getchaintip" { return known.tip.json }
            calls += 1
            if calls == 1 { var first = self.page([self.added(full)]); first["has_more"] = true; return first }
            return ["tip": known.tip.json, "has_more": false, "next_cursor": "last", "changes": [
                ["type": "pending_spend", "sequence": 2, "txid": full["txid"]!, "vout": 0, "spending_txid": self.hash(500)] as JSONObject]]
        }
        XCTAssertFalse(result.loaded.contains(known.tip.hash)); XCTAssertTrue(result.catalog.isEmpty)
        XCTAssertEqual(result.incomplete.count, 1)
        XCTAssertTrue(result.requiresStreams.contains(known.tip.hash))
    }
    func testRelocatedSameOutputRequiresFreshSnapshotInsteadOfFatalCorruption() throws {
        let known = try window(), full = row(known), cached = try ClaimCandidate(full, block: known.tip.hash, fee: 0)
        let forkHash = hash(900)
        let fork: JSONObject = ["chain": "main", "genesis_hash": NativePaymentChecks.GENESIS,
            "height": 3, "hash": forkHash, "mediantime": 1_700_000_004]
        var relocated = full; relocated["block_hash"] = forkHash
        let wire: JSONObject = ["compact": 3, "tip": fork, "block_delta": NSNull(),
            "changes": [added(relocated)], "next_cursor": "fork"]
        XCTAssertThrowsError(try ClaimBountyCodec.expand(wire, window: known, cursor: "base", rows: [cached.key: cached])) { error in
            XCTAssertEqual((error as? RpcFailure)?.code, "-32011")
        }
    }
    func testCoalescedStateComesFromRowRatherThanEventLabel() async throws {
        let known = try window(), full = row(known), cached = try ClaimCandidate(full, block: known.tip.hash, fee: 0)
        let event: JSONObject = ["type": "pending_spend", "sequence": 1, "txid": full["txid"]!, "vout": 0,
            "block_hash": known.tip.hash, "tip_ref": -1, "bounty_ref": try ClaimBountyCodec.immutableDigest(full),
            "bounty_delta": ["status": "available", "spending_txid": NSNull()] as JSONObject]
        let result = try await ClaimDiscoveryReplay.read(known: known, cursor: "base", catalog: [cached.key: cached], loaded: [cached.block]) { _, _ in self.page([event]) }
        XCTAssertEqual(result.catalog[cached.key]?.state, "available")
        XCTAssertNil(result.catalog[cached.key]?.spendingTxid)
    }
    func testUnknownReferenceReplaysSameCursorExpandedAndKeepsCanonicalValidation() async throws {
        let known = try window(), full = row(known)
        let event: JSONObject = ["type": "matured", "sequence": 1, "txid": full["txid"]!, "vout": 0,
            "block_hash": known.tip.hash, "tip_ref": -1, "bounty_ref": try ClaimBountyCodec.immutableDigest(full),
            "bounty_delta": ["status": "available", "spending_txid": NSNull()] as JSONObject]
        var calls = 0
        let result = try await ClaimDiscoveryReplay.read(known: known, cursor: "base", catalog: [:], loaded: []) { method, params in
            XCTAssertEqual(method, "getbountychanges"); XCTAssertEqual(params["cursor"] as? String, "base")
            calls += 1
            if calls == 1 { return self.page([event]) }
            XCTAssertNil(params["compact"])
            var expanded = event; expanded.removeValue(forKey: "tip_ref"); expanded.removeValue(forKey: "bounty_ref"); expanded.removeValue(forKey: "bounty_delta")
            expanded["tip"] = known.tip.json; expanded["bounty"] = full
            return ["tip": known.tip.json, "bounty_deltas": 1, "changes": [expanded], "has_more": false, "next_cursor": "next"]
        }
        XCTAssertEqual(calls, 2); XCTAssertEqual(result.catalog.count, 1)
    }
}
