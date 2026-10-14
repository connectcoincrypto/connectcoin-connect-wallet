import Foundation
import Network

struct HdRetryEnvironment {
    var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    var sleep: (Int) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0) * 1_000_000) }
    var isOnline: () -> Bool = { HdNetworkAvailability.shared.online }
    var jitter: () -> Double = { Double.random(in: 0...1) }
    static var live: Self { Self() }
}

private final class HdNetworkAvailability: @unchecked Sendable {
    static let shared = HdNetworkAvailability()
    private let lock = NSLock(), monitor = NWPathMonitor()
    private var available = true
    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock(); self.available = path.status == .satisfied; self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "connectwallet.ios.hd.network"))
    }
    var online: Bool { lock.lock(); defer { lock.unlock() }; return available }
}

/// Revocation is synchronous even while the HD actor is suspended in an RPC.
final class HdRecoveryLease: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    func cancel() { lock.lock(); valid = false; lock.unlock() }
    func check() throws {
        lock.lock(); let current = valid; lock.unlock()
        try Task.checkCancellation()
        if !current { throw CancellationError() }
    }
}

struct HdRetryStatus {
    let state: String, retryAfterMs: Int, retryAttempt: Int, errorCode: String
    let revision: UInt64
}

struct HdRecoveryFailure: Error, LocalizedError {
    let code: String, message: String
    var errorDescription: String? { message }
    static let exhausted = Self(code: "HD_RETRY_EXHAUSTED", message: "HD recovery could not reconnect. Retry to continue scanning.")
    static let rescan = Self(code: "HD_RESCAN_REQUIRED", message: "The address journal changed. Rescan addresses to continue safely.")
    static let invalid = Self(code: "HD_INVALID_RESPONSE", message: "The node returned invalid HD recovery data. Check the node and retry.")
    static let storage = Self(code: "HD_STORAGE", message: "HD recovery could not save wallet progress. Check device storage and retry.")
    static let resource = Self(code: "HD_RESOURCE_LIMIT", message: "HD recovery exceeds this device's address limit. Use ConnectWallet desktop.")
    static let derivation = Self(code: "HD_DERIVATION", message: "HD addresses could not be derived. Reopen the wallet and retry.")
    static let rpc = Self(code: "HD_RPC_REJECTED", message: "The node rejected HD recovery. Check the node and retry.")
}

/// One circuit gate for an entire HD scan. Initial parallel failures close it
/// once; only its single probe consumes a retry round. Existing RPC quotas and
/// the scan's 16-worker bound still govern admission after the probe succeeds.
actor HdRetryCoordinator {
    typealias Reader = (String, JSONObject) async throws -> JSONObject
    private let environment: HdRetryEnvironment, checkOwner: () throws -> Void
    private let progress: (HdRetryStatus) async -> Void
    private var generation: UInt64 = 0, revision: UInt64 = 0
    private var blocked = false, probing = false, retryAttempt = 0
    private var retryAt: TimeInterval = 0, serverCooldownUntil: TimeInterval = 0
    private var terminal: HdRecoveryFailure?
    private var lastReport = "", lastCode = ""
    private struct Ticket { let generation: UInt64; let probe: Bool }

    init(environment: HdRetryEnvironment = .live, check: @escaping () throws -> Void,
         progress: @escaping (HdRetryStatus) async -> Void) {
        self.environment = environment; checkOwner = check; self.progress = progress
    }
    private func check() throws { try Task.checkCancellation(); try checkOwner() }
    private func report(_ state: String, _ delay: Int = 0) async {
        let bounded = max(0, delay), key = "\(state):\((bounded + 999) / 1000):\(retryAttempt):\(lastCode)"
        guard key != lastReport else { return }
        lastReport = key; revision &+= 1
        await progress(HdRetryStatus(state: state, retryAfterMs: bounded, retryAttempt: retryAttempt,
                                     errorCode: lastCode, revision: revision))
    }
    private func admit() async throws -> Ticket {
        while true {
            try check()
            if let terminal { throw terminal }
            if !environment.isOnline() {
                await report("waiting-network")
                try check(); try await environment.sleep(100); continue
            }
            if !blocked {
                let ticket = Ticket(generation: generation, probe: false)
                await report("scanning")
                try check()
                // Reporting may suspend while another worker closes the gate.
                if blocked || ticket.generation != generation { continue }
                return ticket
            }
            let delay = max(0, Int(ceil((retryAt - environment.now()) * 1000)))
            if !probing && delay == 0 {
                probing = true; retryAttempt += 1
                let ticket = Ticket(generation: generation, probe: true)
                await report("retrying"); try check(); return ticket
            }
            await report("retrying", delay)
            try check(); try await environment.sleep(probing ? 100 : min(100, max(1, delay))); continue
        }
    }
    private static func transient(_ error: Error) -> RpcFailure? {
        guard let rpc = error as? RpcFailure, !rpc.unknownOutcome,
              ["RPC_UNAVAILABLE", "RPC_TIMEOUT", "RPC_BUSY", "RPC_INACTIVE", "RPC_CANCELLED",
               "-32001", "-32030", "-32029"].contains(rpc.code) else { return nil }
        return rpc
    }
    private func failed(_ failure: RpcFailure, _ ticket: Ticket) async throws {
        try check()
        if let terminal { throw terminal }
        // A late failure from the pre-outage batch cannot close the recovered
        // connection or spend the newer probe's retry budget.
        guard ticket.generation == generation else { return }
        serverCooldownUntil = max(serverCooldownUntil, environment.now() + Double(max(0, failure.retryAfterMs)) / 1000)
        if blocked && !ticket.probe {
            // Simultaneous failures are one outage, but every server cooldown
            // remains a lower bound even when the first failure was transport.
            if serverCooldownUntil > retryAt {
                retryAt = serverCooldownUntil
                await report(environment.isOnline() ? "retrying" : "waiting-network",
                             environment.isOnline() ? max(0, Int(ceil((retryAt - environment.now()) * 1000))) : 0)
            }
            return
        }
        if ticket.probe && retryAttempt >= 8 {
            terminal = .exhausted; lastCode = HdRecoveryFailure.exhausted.code
            await report("failed"); throw HdRecoveryFailure.exhausted
        }
        blocked = true; probing = false; lastCode = failure.code
        let delays = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
        let base = delays[min(retryAttempt, delays.count - 1)]
        let jitter = min(1, max(0, environment.jitter()))
        let delay = max(max(0, failure.retryAfterMs), Int(Double(base) * (1 + jitter * 0.2)))
        retryAt = max(serverCooldownUntil, environment.now() + Double(delay) / 1000)
        await report(environment.isOnline() ? "retrying" : "waiting-network",
                     environment.isOnline() ? max(0, Int(ceil((retryAt - environment.now()) * 1000))) : 0)
    }
    func call(_ method: String, _ params: JSONObject, reader: @escaping Reader) async throws -> JSONObject {
        try check()
        guard ["getaddresschanges", "getaddresshistory"].contains(method) else { throw HdRecoveryFailure.rpc }
        while true {
            let ticket = try await admit()
            do {
                try check()
                let result = try await reader(method, params)
                try check()
                if ticket.probe && ticket.generation == generation {
                    blocked = false; probing = false; retryAttempt = 0; lastCode = ""; serverCooldownUntil = 0; generation &+= 1
                    await report("scanning"); try check()
                }
                return result
            } catch {
                // Lifecycle ownership is checked before interpreting transport
                // cancellation: lock/background/replacement never becomes retry.
                try check()
                if error is CancellationError { throw error }
                if let failure = Self.transient(error) { try await failed(failure, ticket); continue }
                if let rpc = error as? RpcFailure {
                    if rpc.code == "-32601" {
                        // A supported legacy fallback can follow a successful
                        // reconnect probe; do not leave its gate occupied.
                        if ticket.probe && ticket.generation == generation {
                            blocked = false; probing = false; retryAttempt = 0; lastCode = ""; serverCooldownUntil = 0; generation &+= 1
                        }
                        throw rpc
                    }
                    if rpc.code == "-32011" { throw HdRecoveryFailure.rescan }
                    if rpc.code == "RPC_PROTOCOL" { throw HdRecoveryFailure.invalid }
                    throw HdRecoveryFailure.rpc
                }
                throw error
            }
        }
    }
}
