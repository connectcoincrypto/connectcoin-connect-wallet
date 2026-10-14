// Deterministic host-only admission races; never opens a socket or uses DNS.
namespace {
struct AdmissionFixture {
    int64_t limiter=CreateStartLimiter(100);
    std::vector<int64_t> owned;
    ~AdmissionFixture() { for(auto id:owned) DestroyCancellation(id); DestroyStartLimiter(limiter); }
    int64_t Handle(const std::string& key="1:a:0",const std::string& count="0",const std::string& target=std::string(64,'f')) {
        const auto id=CreateCancellation(limiter); owned.push_back(id); BindClaimBudget(id,key,target,count); return id;
    }
    std::shared_ptr<Cancellation> State(int64_t id) { std::lock_guard lock(handles_mutex); return handles.at(id); }
};
class AdmissionWaiter {
    int64_t handle;
    std::shared_ptr<Cancellation> state;
    std::mutex mutex;
    std::condition_variable completed;
    bool done=false;
public:
    std::string error;
    bool tcp=false;
    JoiningTestThread worker;
    AdmissionWaiter(int64_t id,std::shared_ptr<Cancellation> value,const EndpointSelection* endpoint=nullptr)
        :handle(id),state(std::move(value)),worker([this,endpoint] {
            try {
                Slot slot(handle);
                WithStartPermit(state,Clock::now()+std::chrono::seconds(5),[&] { state->started=true; tcp=true; return 1; },endpoint);
            } catch(const std::exception& failure) { error=failure.what(); }
            { std::lock_guard lock(mutex); done=true; } completed.notify_all();
        }) {}
    ~AdmissionWaiter() { Cancel(handle); if(worker.joinable()) worker.join(); }
    void Queued() {
        std::unique_lock lock(state->limiter->mutex);
        CapacityExpect(state->limiter->queued_for_test.wait_for(lock,std::chrono::seconds(2),[&] { return state->waiting!=nullptr; }),"Admission waiter did not enter its gate");
    }
    void Done() {
        std::unique_lock lock(mutex);
        CapacityExpect(completed.wait_for(lock,std::chrono::seconds(2),[&] { return done; }),"Admission invalidation did not promptly wake waiter");
        lock.unlock(); worker.join();
    }
};
}
void CheckNativeAdmissionGuardsForTest() {
    // A completed capture remains observable even when cancellation withholds
    // the proof. The next run must import that observation before admission.
    {
        AdmissionFixture fixture;
        const auto id=fixture.Handle("1:cac:0","2");
        auto state=fixture.State(id);
        CapacityExpect(!HasCaptured(id),"Fresh handles cannot invent captures");
        RecordCapture(state); RecordCapture(state); Cancel(id);
        ClaimResult result; result.valid_proof=true; result.meets_target=true; result.proof_hex="abcdef";
        CapacityExpect(CapacityError([&] { FinalizeKnownCapture(result,200,state,Clock::now()+std::chrono::seconds(1)); },"CLAIM_CANCELLED"),"Cancellation still withholds the completed proof");
        CapacityExpect(HasCaptured(id) && HasCaptured(id) && state->budget->successes==3,"Completed cancellation is observable without double charging");
        const auto resumed=fixture.Handle("2:cac:0","3"); auto next=fixture.State(resumed);
        CapacityExpect(CapacityError([&] { WithStartPermit(next,Clock::now()+std::chrono::seconds(1),[] { return 1; }); },"CLAIM_BUDGET"),"Imported cancelled capture preserves cutoff after restart");
        CapacityExpect(!HasCaptured(resumed),"Admission rejection is not a completed capture");
        DestroyCancellation(id); CapacityExpect(!HasCaptured(id),"Destroyed handle cannot report another owner's capture");
        const auto unbound=CreateCancellation(fixture.limiter); fixture.owned.push_back(unbound);
        const auto unbound_state=fixture.State(unbound); Cancel(unbound);
        CapacityExpect(!HasCaptured(unbound),"Cancellation before capture spends no budget");
        RecordCapture(unbound_state);
        CapacityExpect(HasCaptured(unbound),"Capture observation does not depend on a bound budget");
    }
    CapacityExpect(BudgetStopCount(std::string(64,'f'))==3,"Exact maximum target permits equality at 2^257");
    CapacityExpect(BudgetStopCount("7"+std::string(63,'f'))==5,"Exact half target budget");
    CapacityExpect(BudgetStopCount(std::string(64,'0'))==UINT64_MAX,"Tiny target saturates uint64 budget");
    CapacityExpect(BudgetCount("18446744073709551615")==UINT64_MAX,"Full unsigned count is accepted");
    for(const auto* bad:{"","00","-1","18446744073709551616","1.0"})
        CapacityExpect(CapacityError([&] { BudgetCount(bad); },"CLAIM_CONTEXT"),"Malformed/overflow count rejected");
    // Captured and imported exhaustion both revoke head and non-head waiters,
    // but a sibling which passed its connect gate is never cancelled.
    for(const bool imported:{false,true}) {
        AdmissionFixture fixture;
        const auto running=fixture.Handle("1:a:0","2"); auto owner=fixture.State(running);
        WithStartPermit(owner,Clock::now()+std::chrono::seconds(1),[&] { owner->started=true; return 1; });
        SetStartAllowed(fixture.limiter,false);
        const auto first=fixture.Handle(),second=fixture.Handle();
        AdmissionWaiter a(first,fixture.State(first)); a.Queued();
        AdmissionWaiter b(second,fixture.State(second)); b.Queued();
        const auto unrelated=fixture.Handle("1:b:0"); AdmissionWaiter c(unrelated,fixture.State(unrelated)); c.Queued();
        if(imported) fixture.Handle("1:a:0","3"); else { RecordCapture(owner); RecordCapture(owner); }
        a.Done(); b.Done();
        CapacityExpect(!a.tcp && !b.tcp && a.error=="CLAIM_BUDGET" && b.error=="CLAIM_BUDGET","Exhausted queued siblings cannot spend TCP");
        CapacityExpect(owner->started && !owner->cancelled && owner->budget->successes==3,"Only one real capture charged; started sibling retained");
        CapacityExpect(owner->limiter->first==fixture.State(unrelated)->waiting && owner->limiter->pacer.count==1,"Invalidation cleans matching waiters without spending pacing or attempts");
        SetStartAllowed(fixture.limiter,true); c.Done();
        CapacityExpect(c.tcp && c.error.empty(),"Budget exhaustion cannot revoke a different bounty");
        auto stale=fixture.Handle("1:a:0","0");
        CapacityExpect(fixture.State(stale)->budget->successes==3,"Stale import cannot reset budget");
        auto next_run=fixture.Handle("2:a:0","0");
        CapacityExpect(fixture.State(next_run)->budget->successes==0,"New run has independent budget");
        CapacityExpect(CapacityError([&] { fixture.Handle("1:a:0","0",std::string(64,'0')); },"CLAIM_CONTEXT"),"One budget identity cannot change target");
    }
    // Pausing synchronizes with connect; resuming wakes FIFO and cannot bank
    // idle cadence. A paused gate still responds to cancellation/deadlines.
    {
        AdmissionFixture fixture; SetStartAllowed(fixture.limiter,false);
        const auto id=fixture.Handle(); AdmissionWaiter waiter(id,fixture.State(id)); waiter.Queued();
        CapacityExpect(!HasStarted(id),"Closed lifecycle gate cannot start TCP");
        CapacityExpect(CapacityError([&] { BindClaimBudget(id,"1:b:0",std::string(64,'f'),"0"); },"CLAIM_BUSY"),"Active handle budget cannot be rebound");
        SetStartAllowed(fixture.limiter,true); waiter.Done();
        CapacityExpect(waiter.tcp && waiter.error.empty(),"Coherent lifecycle reopens gate");
    }
    {
        AdmissionFixture fixture; SetStartAllowed(fixture.limiter,false);
        const auto id=fixture.Handle(); AdmissionWaiter waiter(id,fixture.State(id)); waiter.Queued(); Cancel(id); waiter.Done();
        CapacityExpect(!waiter.tcp && waiter.error=="CLAIM_CANCELLED","Paused waiter cancellation remains prompt");
    }
    // Exclusion wakes already-selected endpoint/family waiters, without
    // renewing the deadline merely because they observe that exclusion.
    for(const bool family:{false,true}) {
        AdmissionFixture fixture; SetStartAllowed(fixture.limiter,false);
        auto cache=std::make_shared<DnsCache>();
        EndpointPriority priority; priority.reachability=cache->reachability;
        priority.Refresh({TestEndpoint("8.8.8.8"),TestEndpoint("1.1.1.1")});
        auto excluded=priority.Select(7),other=priority.Select(7);
        excluded.cache=cache; other.cache=cache;
        const auto first=fixture.Handle(),second=fixture.Handle("1:b:0");
        AdmissionWaiter a(first,fixture.State(first),&excluded); a.Queued();
        AdmissionWaiter b(second,fixture.State(second),family?&other:&excluded); b.Queued();
        EndpointPriority unaffected; unaffected.reachability=cache->reachability;
        unaffected.Refresh({TestEndpoint(family?"2606:4700:4700::1111":"9.9.9.9")});
        auto safe=unaffected.Select(7); safe.cache=cache;
        const auto third=fixture.Handle("1:c:0"); AdmissionWaiter c(third,fixture.State(third),&safe); c.Queued();
        ExcludeEndpoint(cache,excluded,family);
        Deadline until; { std::lock_guard lock(cache->mutex); until=family?cache->reachability->Family(excluded.endpoint.family):*excluded.unavailable; }
        a.Done(); b.Done();
        CapacityExpect(!a.tcp && !b.tcp && a.error=="CLAIM_LOCAL_UNAVAILABLE" && b.error=="CLAIM_LOCAL_UNAVAILABLE","Known excluded route/family cannot spend queued TCP");
        CapacityExpect((family?cache->reachability->Family(excluded.endpoint.family):*excluded.unavailable)==until,"Queued observations never extend exclusion");
        CapacityExpect(fixture.State(first)->limiter->pacer.count==0,"Excluded waiters spend no rate allowance");
        SetStartAllowed(fixture.limiter,true); c.Done();
        CapacityExpect(c.tcp && c.error.empty(),"Unrelated endpoint/family remains eligible after exclusion");
    }
    // Bound retained budgets while a referenced sibling survives eviction.
    {
        AdmissionFixture fixture; const auto pinned=fixture.Handle(); const auto state=fixture.State(pinned);
        for(size_t i=0;i<StartLimiter::MAX_BUDGETS+10;++i) {
            const auto id=CreateCancellation(fixture.limiter);
            BindClaimBudget(id,"3:"+std::to_string(i),std::string(64,'f'),"0"); DestroyCancellation(id);
        }
        CapacityExpect(state->limiter->budgets.size()==StartLimiter::MAX_BUDGETS && state->limiter->budgets.at("1:a:0")==state->budget,"Bounded eviction cannot discard referenced budget");
    }
}
