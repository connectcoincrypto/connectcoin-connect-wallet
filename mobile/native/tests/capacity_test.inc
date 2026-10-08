// Included only by the host-test translation unit. No DNS or sockets are used.
namespace {
void CapacityExpect(bool condition,const char* message) { if(!condition) throw std::runtime_error(message); }
struct ResolverGate {
    std::mutex mutex;
    std::condition_variable changed;
    size_t calls=0, active=0, peak=0;
    bool released=false;
    std::vector<Endpoint> lookup(const std::string&) {
        std::unique_lock lock(mutex);
        ++calls; ++active; peak=std::max(peak,active); changed.notify_all();
        changed.wait(lock,[&] { return released; }); --active;
        Endpoint endpoint; endpoint.family=AF_INET; endpoint.length=sizeof(sockaddr_in);
        auto* address=reinterpret_cast<sockaddr_in*>(&endpoint.address);
        address->sin_family=AF_INET; address->sin_port=htons(443);
        inet_pton(AF_INET,"8.8.8.8",&address->sin_addr);
        return {endpoint}; // Synthetic numeric result; never connected.
    }
    bool awaitCalls(size_t count) {
        std::unique_lock lock(mutex);
        return changed.wait_for(lock,std::chrono::seconds(5),[&] { return calls>=count; });
    }
    void release() { std::lock_guard lock(mutex); released=true; changed.notify_all(); }
};
template<typename Work> bool CapacityError(Work work,const char* expected) {
    try { work(); } catch(const std::runtime_error& error) { return std::string(error.what())==expected; }
    return false;
}
void CheckCaptureSlotsForTest() {
    std::vector<int64_t> ids;
    std::vector<std::unique_ptr<Slot>> slots;
    try {
        for(int i=0;i<=100;++i) ids.push_back(CreateCancellation());
        for(int i=0;i<100;++i) slots.push_back(std::make_unique<Slot>(ids[i]));
        CapacityExpect(active_captures.load()==100,"100 native capture slots must be available");
        CapacityExpect(CapacityError([&] { Slot extra(ids[100]); },"CLAIM_BUSY"),"101st native capture must be bounded");
        CapacityExpect(CapacityError([&] { Slot reused(ids[0]); },"CLAIM_BUSY"),"One capture per handle");
        slots.pop_back(); slots.push_back(std::make_unique<Slot>(ids[100]));
        CapacityExpect(active_captures.load()==100,"Failed admission must not leak capacity");
    } catch(...) { slots.clear(); for(auto id:ids) DestroyCancellation(id); throw; }
    slots.clear(); for(auto id:ids) DestroyCancellation(id);
    CapacityExpect(active_captures.load()==0,"Native capture slots released");
}
void CheckSharedDnsForTest() {
    auto cache=std::make_shared<DnsCache>();
    auto gate=std::make_shared<ResolverGate>();
    auto lookup=[gate](const std::string& domain) { return gate->lookup(domain); };
    std::vector<std::shared_ptr<Cancellation>> states;
    std::vector<std::thread> waiters;
    std::atomic<int> started{0}, completed{0}, cancelled{0}, failed{0};
    for(int i=0;i<100;++i) states.push_back(std::make_shared<Cancellation>());
    try {
        for(int i=0;i<100;++i) waiters.emplace_back([&,i] {
            ++started;
            try {
                auto endpoint=ResolveCached(cache,"same.example",states[i],Clock::now()+std::chrono::seconds(10),lookup);
                if(endpoint.endpoint.family==AF_INET) ++completed; else ++failed;
            } catch(const std::runtime_error& error) {
                if(i==0 && std::string(error.what())=="CLAIM_CANCELLED") ++cancelled; else ++failed;
            } catch(...) { ++failed; }
        });
    } catch(...) { gate->release(); for(auto& waiter:waiters) waiter.join(); throw; }
    bool began=gate->awaitCalls(1);
    states[0]->cancel();
    bool timedOut=CapacityError([&] {
        ResolveCached(cache,"same.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::milliseconds(20),lookup);
    },"CLAIM_TIMEOUT");
    const auto until=Clock::now()+std::chrono::seconds(5);
    while(cancelled.load()==0 && Clock::now()<until) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    bool cancelledBeforeDns=cancelled.load()==1;
    gate->release(); for(auto& waiter:waiters) waiter.join();
    CapacityExpect(began && started.load()==100,"100 shared DNS callers start");
    CapacityExpect(timedOut && cancelledBeforeDns,"Shared DNS waiters honor individual deadlines/cancellation");
    CapacityExpect(completed.load()==99 && failed.load()==0,"One cancelled waiter does not abandon shared DNS");
    CapacityExpect(gate->calls==1 && gate->peak==1,"100 same-domain callers use one resolver");
    ResolveCached(cache,"same.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(1),lookup);
    CapacityExpect(gate->calls==1,"Completed public endpoint cache is reused");
    { std::lock_guard lock(cache->mutex); cache->entries.at("same.example")->expires=Clock::now(); }
    ResolveCached(cache,"same.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(1),lookup);
    CapacityExpect(gate->calls==2,"Expired DNS result is refreshed");
}
void CheckBoundedDnsForTest() {
    auto cache=std::make_shared<DnsCache>();
    auto gate=std::make_shared<ResolverGate>();
    auto lookup=[gate](const std::string& domain) { return gate->lookup(domain); };
    std::atomic<int> completed{0}, failed{0};
    std::vector<std::thread> waiters;
    try {
        for(int i=0;i<12;++i) waiters.emplace_back([&,i] {
            try { ResolveCached(cache,std::to_string(i)+".example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(10),lookup); ++completed; }
            catch(...) { ++failed; }
        });
    } catch(...) { gate->release(); for(auto& waiter:waiters) waiter.join(); throw; }
    bool began=gate->awaitCalls(2);
    bool deadline=CapacityError([&] {
        ResolveCached(cache,"deadline.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::milliseconds(20),lookup);
    },"CLAIM_TIMEOUT");
    auto stopped=std::make_shared<Cancellation>(); stopped->cancel();
    bool cancelled=CapacityError([&] {
        ResolveCached(cache,"cancelled.example",stopped,Clock::now()+std::chrono::seconds(1),lookup);
    },"CLAIM_CANCELLED");
    gate->release(); for(auto& waiter:waiters) waiter.join();
    CapacityExpect(began && deadline && cancelled,"DNS slot waiting is deadline/cancellation bounded");
    CapacityExpect(completed.load()==12 && failed.load()==0 && gate->peak<=2,"DNS capacity waits rather than returning busy");
    for(int i=0;i<150;++i) ResolveCached(cache,std::to_string(i)+".cache.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(1),lookup);
    { std::lock_guard lock(cache->mutex); CapacityExpect(cache->entries.size()<=128 && cache->workers==0,"DNS cache and workers stay bounded"); }
    auto failures=std::make_shared<DnsCache>(); auto lookups=std::make_shared<std::atomic<int>>(0);
    auto missing=[lookups](const std::string&) { ++*lookups; return std::vector<Endpoint>{}; };
    for(int i=0;i<2;++i) CapacityExpect(CapacityError([&] {
        ResolveCached(failures,"missing.example",std::make_shared<Cancellation>(),Clock::now()+std::chrono::seconds(1),missing);
    },"CLAIM_DNS"),"Missing DNS still reports DNS failure");
    CapacityExpect(lookups->load()==1,"Brief negative cache avoids same-domain failure lookup storms");
}
} // namespace
void CheckNativeCapacityForTest() {
    CheckCaptureSlotsForTest(); CheckSharedDnsForTest(); CheckBoundedDnsForTest();
}
