// Test observer runs at the former Core path-lock boundary. A restored global
// lock cannot satisfy this barrier, even on a single-core host.
namespace {
constexpr int VERIFY_WORKERS=8;
std::mutex probe_mutex;
std::condition_variable probe_changed;
std::set<const void*> probe_roots;
int probe_entered=0;
bool probe_failed=false;
void ProbeParallelRoots(const void* roots) {
    std::unique_lock lock(probe_mutex);
    probe_roots.insert(roots); ++probe_entered; probe_changed.notify_all();
    if(!probe_changed.wait_for(lock,std::chrono::seconds(3),[] { return probe_failed || probe_entered>=VERIFY_WORKERS; })) {
        probe_failed=true; probe_changed.notify_all();
    }
}
}
ClaimResult VerifyParallel(const PublicClaimContext& context,const std::vector<unsigned char>& proof,const std::vector<unsigned char>& roots) {
    SetVerificationObserverForTest(ProbeParallelRoots);
    std::vector<std::thread> workers;
    std::atomic<bool> invalid_result{false};
    for(int i=0;i<VERIFY_WORKERS;++i) workers.emplace_back([&] {
        try { if(VerifyProof(context,proof).valid_proof) invalid_result=true; }
        catch(...) { invalid_result=true; }
    });
    for(auto& worker:workers) worker.join();
    SetVerificationObserverForTest(nullptr);
    if(probe_failed || probe_entered!=VERIFY_WORKERS || probe_roots.size()!=VERIFY_WORKERS || invalid_result) throw std::runtime_error("TEST_PARALLEL_ROOT_ISOLATION");
    workers.clear();
    for(int i=0;i<VERIFY_WORKERS;++i) workers.emplace_back([&] {
        try {
            for(int pass=0;pass<8;++pass) {
                auto valid=VerifyProofForTest(context,proof,roots);
                auto tampered=proof; tampered.back()^=1;
                if(!valid.valid_proof || VerifyProofForTest(context,tampered,roots).valid_proof) invalid_result=true;
            }
        } catch(...) { invalid_result=true; }
    });
    for(auto& worker:workers) worker.join();
    if(invalid_result) throw std::runtime_error("TEST_PARALLEL_VALIDATION");
    return VerifyProofForTest(context,proof,roots);
}
ClaimResult CaptureParallel(const PublicClaimContext& context,const std::vector<unsigned char>& roots,uint16_t port,int timeout,int worker_count=VERIFY_WORKERS) {
    if(worker_count<2 || worker_count>100) throw std::runtime_error("TEST_WORKERS");
    const auto limiter=CreateStartLimiter(100);
    std::vector<int64_t> handles;
    for(int i=0;i<worker_count;++i) handles.push_back(CreateCancellation(limiter));
    std::vector<ClaimResult> results(worker_count);
    std::vector<int64_t> starts(worker_count);
    std::atomic<bool> failed{false};
    std::vector<std::thread> workers;
    for(int i=0;i<worker_count;++i) workers.emplace_back([&,i] {
        try {
            results[i]=CaptureLoopbackForTest(context,timeout,handles[i],port,roots);
            starts[i]=StartedAtNanos(handles[i]);
            if(!HasStarted(handles[i]) || StartedAgeNanos(handles[i])<0) failed=true;
        } catch(...) { failed=true; }
        DestroyCancellation(handles[i]);
    });
    for(auto& worker:workers) worker.join();
    DestroyStartLimiter(limiter);
    std::sort(starts.begin(),starts.end());
    // Fresh/cold limiter: no start can precede its anchored cadence. Individual
    // gaps may be shorter than 10 ms to recover a late wake, unlike the old gate.
    for(size_t i=1;i<starts.size();++i) if(starts[i]-starts.front()<static_cast<int64_t>(i)*10000000) failed=true;
    for(size_t i=100;i<starts.size();++i) if(starts[i]-starts[i-100]<1000000000) failed=true;
    std::set<std::string> proofs;
    for(const auto& result:results) {
        if(result.valid_proof!=results.front().valid_proof || result.error_code!=results.front().error_code) failed=true;
        if(result.valid_proof) proofs.insert(result.proof_hex);
    }
    if(results.front().valid_proof && proofs.size()!=static_cast<size_t>(worker_count)) failed=true;
    if(failed) throw std::runtime_error("TEST_PARALLEL_CAPTURE");
    return results.front();
}
