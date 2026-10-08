// Host-only synthetic scheduling fixtures. Numeric addresses are never used
// for DNS, socket creation, or public TLS connections by any of these tests.
namespace {
Endpoint TestEndpoint(const char* text) {
    Endpoint endpoint; endpoint.family=std::strchr(text,':')?AF_INET6:AF_INET;
    if(endpoint.family==AF_INET) {
        auto* address=reinterpret_cast<sockaddr_in*>(&endpoint.address);
        address->sin_family=AF_INET; address->sin_port=htons(443);
        CapacityExpect(inet_pton(AF_INET,text,&address->sin_addr)==1,"Test IPv4 parse");
        endpoint.length=sizeof(sockaddr_in);
    } else {
        auto* address=reinterpret_cast<sockaddr_in6*>(&endpoint.address);
        address->sin6_family=AF_INET6; address->sin6_port=htons(443);
        CapacityExpect(inet_pton(AF_INET6,text,&address->sin6_addr)==1,"Test IPv6 parse");
        endpoint.length=sizeof(sockaddr_in6);
    }
    return endpoint;
}
std::vector<size_t> CountEndpoints(EndpointPriority& priority,unsigned mask,size_t attempts) {
    std::vector<size_t> counts(priority.entries.size());
    for(size_t i=0;i<attempts;++i) {
        auto selected=priority.Select(mask);
        auto found=std::find_if(priority.entries.begin(),priority.entries.end(),[&](const auto& entry) { return SameEndpoint(entry.endpoint,selected.endpoint); });
        CapacityExpect(found!=priority.entries.end(),"Selected IP belongs to active DNS set");
        ++counts[static_cast<size_t>(found-priority.entries.begin())];
    }
    return counts;
}
void CheckEndpointSequenceForTest() {
    const std::vector<Endpoint> endpoints{TestEndpoint("8.8.8.8"),TestEndpoint("1.1.1.1"),TestEndpoint("2001:4860:4860::8888")};
    EndpointPriority priority; priority.Refresh(endpoints);
    for(size_t i=0;i<9;++i) CapacityExpect(SameEndpoint(priority.Select(1).endpoint,endpoints[i%3]),"Equal-prior selection rotates deterministically");
    auto changed=priority.Select(1).score;
    for(int i=0;i<1000;++i) changed->Record(false,10);
    for(unsigned mask=2;mask<=7;++mask) {
        auto selected=priority.Select(mask);
        CapacityExpect(SameEndpoint(selected.endpoint,endpoints[0]) && selected.score!=changed && selected.score->Rate()==5.0,"Every exact signature mask has independent EMA and cursor");
    }
    EndpointPriority other; other.Refresh(endpoints);
    auto unrelated=other.Select(1);
    CapacityExpect(unrelated.score!=changed && unrelated.score->Rate()==5.0,"Domains never share IP scores");
    for(unsigned mask:{0U,8U,255U}) CapacityExpect(CapacityError([&] { priority.Select(mask); },"CLAIM_CONTEXT"),"Invalid signature masks rejected");

    EndpointPriority weighted; weighted.Refresh(endpoints); weighted.Select(1);
    const std::array<double,3> rates{20,5,1};
    for(size_t i=0;i<3;++i) { auto score=weighted.entries[i].masks[0]; score->connections=rates[i]; score->seconds=1; score->credit=0; }
    weighted.next[0]=0;
    // Specification/Core/desktop smooth weighted round-robin reference vector:
    // 1%/3 exploration +99%*(20,5,1)/26, max-normalized summation, rotating ties.
    const std::array<size_t,40> expected{0,0,1,0,0,0,1,0,0,0,2,0,0,1,0,0,0,0,1,0,0,0,0,1,0,0,0,1,0,0,0,0,1,0,0,0,2,0,0,1};
    for(auto index:expected) CapacityExpect(SameEndpoint(weighted.Select(1).endpoint,endpoints[index]),"Weighted endpoint reference sequence parity");

    priority.Refresh({endpoints[0],endpoints[0],endpoints[1],endpoints[1]});
    CapacityExpect(priority.entries.size()==2,"DNS duplicate IPs do not gain extra scheduling weight");
    std::vector<Endpoint> many;
    for(int i=1;i<=40;++i) many.push_back(TestEndpoint(("8.8.8."+std::to_string(i)).c_str()));
    priority.Refresh(many); CapacityExpect(priority.entries.size()==32,"32 distinct endpoints maximum");
}
void CheckEndpointLearningForTest() {
    const std::vector<Endpoint> endpoints{TestEndpoint("8.8.8.8"),TestEndpoint("1.1.1.1")};
    EndpointPriority priority; priority.Refresh(endpoints);
    auto fast=priority.Select(1).score, slow=priority.Select(1).score;
    for(int i=0;i<1000;++i) { const bool valid=i%5!=0; fast->Record(valid,0.02); slow->Record(valid,2.0); }
    CapacityExpect(fast->Rate()>50*slow->Rate(),"TCP/TLS latency matters independently of success ratio");
    auto counts=CountEndpoints(priority,1,20000);
    double expectedSlow=20000*(0.005+0.99*slow->Rate()/(fast->Rate()+slow->Rate()));
    CapacityExpect(std::abs(static_cast<double>(counts[1])-expectedSlow)<2,"Lower-latency weighting matches Core");
    double before=slow->Rate();
    for(int i=0;i<10000;++i) { fast->Record(true,0.2); slow->Record(false,0.2); }
    CapacityExpect(slow->Rate()<before && slow->Rate()>0,"Invalid IP decays without a policy floor");
    counts=CountEndpoints(priority,1,20000);
    CapacityExpect(counts[0]>19700 && counts[1]>=99,"Failing IP retains one-percent uniform exploration share");
    const double oldConnections=fast->connections, oldSeconds=fast->seconds;
    fast->Record(false,-1); fast->Record(false,std::numeric_limits<double>::quiet_NaN()); fast->Record(false,std::numeric_limits<double>::infinity());
    CapacityExpect(fast->connections==oldConnections && fast->seconds==oldSeconds,"Malformed observations are neutral");
    for(int i=0;i<10000;++i) { fast->Record(false,0.2); slow->Record(true,0.2); }
    counts=CountEndpoints(priority,1,20000);
    CapacityExpect(counts[1]>19700,"Exploration allows a formerly failing IP to recover");

    fast->connections=std::numeric_limits<double>::max(); fast->seconds=std::numeric_limits<double>::denorm_min();
    slow->connections=std::numeric_limits<double>::max(); slow->seconds=std::numeric_limits<double>::denorm_min();
    counts=CountEndpoints(priority,1,2000);
    CapacityExpect(std::abs(static_cast<double>(counts[0])-1000)<2 && std::isfinite(fast->credit) && std::isfinite(slow->credit),"Extreme rates do not overflow scheduling credits");
}
void CheckEndpointDnsRefreshForTest() {
    const auto a=TestEndpoint("8.8.8.8"), b=TestEndpoint("1.1.1.1"), c=TestEndpoint("2001:4860:4860::8888");
    auto cache=std::make_shared<DnsCache>(); auto stage=std::make_shared<std::atomic<int>>(0);
    auto lookup=[=](const std::string&) {
        switch(stage->load()) { case 0: return std::vector<Endpoint>{a,b}; case 1: return std::vector<Endpoint>{b,c,a}; case 2: return std::vector<Endpoint>{b,c}; default: return std::vector<Endpoint>{a}; }
    };
    auto resolve=[&](unsigned mask=1) { return ResolveCached(cache,"refresh.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(2),lookup,mask); };
    auto expire=[&] { std::lock_guard lock(cache->mutex); cache->entries.at("refresh.example")->expires=Clock::now(); };
    const auto original=resolve(), unchanged=resolve();
    CapacityExpect(SameEndpoint(original.endpoint,a) && SameEndpoint(unchanged.endpoint,b),"Initial selection order");
    ObserveEndpoint(cache,original,false,10);
    const double prior=original.score->Rate(), credit=original.score->credit;
    stage->store(1); expire(); resolve(2);
    {
        std::lock_guard lock(cache->mutex); const auto& entries=cache->entries.at("refresh.example")->priority.entries;
        CapacityExpect(entries[2].masks[0]==original.score && entries[0].masks[0]==unchanged.score,"Refresh retains unchanged IP score objects even when reordered");
        CapacityExpect(original.score->credit==credit && original.score->Rate()==prior,"Refreshing another mask does not reset learned state");
    }
    ObserveEndpoint(cache,original,true,0.2);
    CapacityExpect(original.score->Rate()!=prior,"Late validation contributes to retained IP statistics");
    stage->store(2); expire(); resolve(); ObserveEndpoint(cache,original,false,10);
    {
        std::lock_guard lock(cache->mutex); const auto& entries=cache->entries.at("refresh.example")->priority.entries;
        CapacityExpect(entries.size()==2 && !SameEndpoint(entries[0].endpoint,a) && !SameEndpoint(entries[1].endpoint,a),"Late removed-IP result cannot restore IP");
    }
    stage->store(3); expire(); const auto readded=resolve();
    CapacityExpect(readded.score!=original.score && readded.score->Rate()==5,"Readded IP starts fresh");
    ObserveEndpoint(cache,original,true,0);
    CapacityExpect(readded.score->Rate()==5,"Stale removed-IP completion does not affect new incarnation");
    { std::lock_guard lock(cache->mutex); cache->entries.clear(); }
    ObserveEndpoint(cache,readded,false,1);
    CapacityExpect(cache->entries.empty(),"Observation cannot resurrect evicted domain");
    auto replaced=resolve(); CapacityExpect(replaced.score!=readded.score && replaced.score->Rate()==5,"Evicted/readded domain starts fresh");
    auto stopped=std::make_shared<Cancellation>(); stopped->cancel();
    CapacityExpect(CapacityError([&] { ResolveCached(cache,"refresh.example",stopped,Clock::now()+std::chrono::seconds(1),lookup,1); },"CLAIM_CANCELLED"),"Cancelled DNS selection does not consume endpoint turn");
    CapacityExpect(replaced.score->Rate()==5,"Cancellation without known network outcome is not a failed sample");
}
void CheckEndpointConcurrentObservationsForTest() {
    auto cache=std::make_shared<DnsCache>(); const auto endpoint=TestEndpoint("8.8.8.8");
    auto lookup=[=](const std::string&) { return std::vector<Endpoint>{endpoint}; };
    const auto first=ResolveCached(cache,"parallel.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(2),lookup,1);
    auto gate=std::make_shared<ResolverGate>();
    std::atomic<int> selected{0}, failed{0}; std::vector<std::thread> workers;
    try {
        for(int i=0;i<100;++i) workers.emplace_back([&,i] {
            try {
                auto value=ResolveCached(cache,"parallel.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(5),lookup,1);
                ++selected;
                { std::unique_lock lock(gate->mutex); gate->changed.wait(lock,[&] { return gate->released; }); }
                // One interrupted capture contributes no outcome; others report
                // known validated successes after the DNS refresh below.
                if(i!=0) ObserveEndpoint(cache,value,true,0.2);
            } catch(...) { ++failed; }
        });
    } catch(...) { gate->release(); for(auto& worker:workers) worker.join(); throw; }
    const auto until=Clock::now()+std::chrono::seconds(5);
    while(selected.load()+failed.load()<100 && Clock::now()<until) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    { std::lock_guard lock(cache->mutex); cache->entries.at("parallel.example")->expires=Clock::now(); }
    bool refreshed=false;
    try { refreshed=ResolveCached(cache,"parallel.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(2),lookup,1).score==first.score; }
    catch(...) { ++failed; }
    gate->release(); for(auto& worker:workers) worker.join();
    double expectedConnections=0.1, expectedSeconds=0.02;
    for(int i=0;i<99;++i) { expectedConnections=0.999*expectedConnections+0.001; expectedSeconds=0.999*expectedSeconds+0.0002; }
    CapacityExpect(refreshed && selected.load()==100 && failed.load()==0,"100 concurrent selections retain scores across DNS refresh");
    CapacityExpect(first.score->connections==expectedConnections && std::abs(first.score->seconds-expectedSeconds)<1e-15,"Concurrent outcomes recorded exactly once; cancellation is neutral");
}
void CheckKnownValidationFinalizationForTest() {
    auto state=std::make_shared<Cancellation>();
    ClaimResult valid; valid.valid_proof=true; valid.meets_target=true; valid.proof_hex="abcdef";
    auto late=FinalizeKnownCapture(valid,200,state,Clock::now()-std::chrono::seconds(1));
    CapacityExpect(late.captured && late.validation_passed && !late.valid_proof && !late.meets_target && late.proof_hex.empty() && late.error_code=="CLAIM_TIMEOUT" && late.duration_ms==200,"Known-valid expired result retains EMA observation but cannot expose usable proof");
    auto timely=FinalizeKnownCapture(valid,200,state,Clock::now()+std::chrono::seconds(1));
    CapacityExpect(timely.captured && timely.validation_passed && timely.valid_proof && timely.proof_hex=="abcdef","Unexpired valid result remains usable");
    valid.meets_target=false;
    auto miss=FinalizeKnownCapture(valid,200,state,Clock::now()+std::chrono::seconds(1));
    CapacityExpect(miss.validation_passed && miss.valid_proof && !miss.meets_target,"Target miss still counts as validated success");
    ClaimResult invalid;
    auto rejected=FinalizeKnownCapture(invalid,200,state,Clock::now()+std::chrono::seconds(1));
    CapacityExpect(rejected.captured && !rejected.validation_passed && !rejected.valid_proof && rejected.proof_hex.empty(),"Invalid certificate never counts as validated success");
    state->cancel();
    CapacityExpect(CapacityError([&] { FinalizeKnownCapture(valid,200,state,Clock::now()+std::chrono::seconds(1)); },"CLAIM_CANCELLED"),"Cancelled known outcome never exposes a proof");
    auto network=FailedCaptureResult("CLAIM_NETWORK",200,false);
    CapacityExpect(!network.captured && !network.validation_passed && !network.valid_proof,"Incomplete network failure is not a completed handshake");
}
} // namespace
void CheckNativeEndpointPriorityForTest() {
    CheckEndpointSequenceForTest(); CheckEndpointLearningForTest(); CheckEndpointDnsRefreshForTest(); CheckEndpointConcurrentObservationsForTest(); CheckKnownValidationFinalizationForTest();
}
