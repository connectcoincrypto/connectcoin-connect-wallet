// Host-only tests exercise the production clock policy and exact connect gate.
void CheckNativeStartLimiterForTest() {
    auto require=[](bool value) { if(!value) throw std::runtime_error("TEST_START_LIMITER"); };
    const auto base=Deadline{}+std::chrono::seconds(10);
    const auto millisecond=std::chrono::milliseconds(1);
    for(int rate:{1,7,10,50,100}) {
        const auto second=std::chrono::seconds(1);
        const auto nanosecond=std::chrono::nanoseconds(1);
        for(int offset:{-1,0,1}) {
            StartPacer pacer(rate); pacer.Record(base);
            const auto advanced=pacer.next+pacer.Interval();
            const auto now=advanced+second+offset*nanosecond;
            pacer.Record(now);
            // Increment first, then clamp exactly at fresh return time minus 1s.
            require(pacer.next==advanced+std::max(offset,0)*nanosecond);
            require(pacer.next>=now-second);
        }
        StartPacer modest(rate); modest.Record(base);
        const auto advanced=modest.next+modest.Interval();
        modest.Record(advanced+50*millisecond);
        require(modest.next==advanced); // Keep all 50 ms, even at rates >20/s.

        StartPacer stalled(rate);
        stalled.Record(base-2*stalled.Interval()); // Its next increment lands at base.
        stalled.Record(base+10*second);
        require(stalled.next==base+9*second); // Discard 9s, retain 1s; not all debt.
        require(stalled.count==1); // Expired quota observations are not banked.
    }
    {
        StartPacer pacer(100);
        require(pacer.Ready(base)==base); // Cold start has no artificial delay.
        pacer.Record(base);
        require(pacer.Ready(base)==base+10*millisecond);
        pacer.SetRate(100); // A no-op update must not reset anchored phase.
        require(pacer.Ready(base)==base+10*millisecond);
        const auto idle=base+std::chrono::hours(1);
        pacer.Resume(idle);
        require(pacer.Ready(idle)==idle);
        pacer.Record(idle);
        require(pacer.Ready(idle)==idle+10*millisecond);
        require(pacer.count==1); // Idle time banks no catch-up credit.
        pacer.Resume(idle+5*millisecond);
        require(pacer.Ready(idle+5*millisecond)==idle+10*millisecond);
    }
    {
        // A deterministic 2.5 ms late timer must not turn 100/s into 80/s.
        StartPacer pacer(100); auto now=base;
        std::vector<Deadline> starts;
        for(int i=0;i<1000;++i) {
            const auto ready=pacer.Ready(now);
            if(ready>now) now=ready+std::chrono::microseconds(2500);
            require(pacer.Ready(now)<=now);
            starts.push_back(now); pacer.Record(now);
        }
        require(starts.back()-starts.front()<std::chrono::milliseconds(10100));
        for(size_t i=100;i<starts.size();++i) require(starts[i]-starts[i-100]>=std::chrono::seconds(1));
        // A delayed wake can be followed by less than one nominal interval.
        StartPacer short_gap(100); short_gap.Record(base);
        short_gap.Record(base+std::chrono::microseconds(12500));
        require(short_gap.Ready(base+std::chrono::microseconds(12500))==base+20*millisecond);
    }
    for(int handoff_us:{0,100}) {
        // A Windows-like 15.625 ms clock and a delayed head handoff used to
        // discard active-queue debt and underfill near 96/s. Demand never stops.
        const int64_t tick=15625000;
        StartPacer pacer(100); auto now=base;
        std::vector<Deadline> starts;
        for(int i=0;i<1000;++i) {
            const auto ready=pacer.Ready(now);
            if(ready>now) {
                const auto elapsed=std::chrono::duration_cast<std::chrono::nanoseconds>(ready-base).count();
                now=base+std::chrono::nanoseconds(((elapsed+tick-1)/tick)*tick);
            }
            starts.push_back(now);
            now+=std::chrono::microseconds(handoff_us); // Conservative syscall-return observation.
            pacer.Record(now);
            now+=std::chrono::microseconds(handoff_us); // Next FIFO head gets the CPU late.
        }
        require(starts.back()-starts.front()<std::chrono::milliseconds(handoff_us?10200:10050));
        for(size_t i=100;i<starts.size();++i) require(starts[i]-starts[i-100]>=std::chrono::seconds(1));
    }
    {
        StartPacer pacer(100);
        for(int i=0;i<100;++i) pacer.Record(base+i*10*millisecond);
        require(pacer.count==100);
        require(pacer.Ready(base+999*millisecond)==base+1000*millisecond);
        pacer.SetRate(1);
        require(pacer.Ready(base+999*millisecond)==base+1990*millisecond);
        pacer.SetRate(20);
        require(pacer.Ready(base+999*millisecond)==base+1800*millisecond);
        pacer.SetRate(100); // Increasing the rate must retain the same history.
        require(pacer.count==100);
        require(pacer.Ready(base+999*millisecond)==base+1000*millisecond);
        pacer.Record(base+1000*millisecond);
        require(pacer.count==100);
        pacer.Resume(base+1001*millisecond); // Pause/reset never replenishes quota.
        require(pacer.count==100 && pacer.Ready(base+1001*millisecond)==base+1010*millisecond);
        pacer.SetRate(1);
        require(pacer.Ready(base+1000*millisecond)==base+2000*millisecond);
    }
    for(int rate:{1,3,7,10,50,60,100}) {
        StartPacer pacer(rate); auto now=base;
        std::vector<Deadline> starts;
        for(int i=0;i<350;++i) {
            now=std::max(now,pacer.Ready(now));
            // Stalled continuous demand may catch up, but never bypasses quota.
            if(i%17==0) now+=std::chrono::seconds(2);
            starts.push_back(now); pacer.Record(now);
            require(pacer.count<=static_cast<size_t>(rate));
            require(pacer.next>=now-std::chrono::seconds(1));
        }
        for(size_t i=rate;i<starts.size();++i) require(starts[i]-starts[i-rate]>=std::chrono::seconds(1));
    }
    {
        // Dynamic limits retain prior observations even across long delays and
        // catch-up. Inspect actual starts, independently of the organizer value.
        constexpr int rates[]{1,7,10,50,100};
        StartPacer pacer(100); auto now=base;
        std::vector<Deadline> starts;
        for(int i=0;i<350;++i) {
            const int rate=rates[(i/17)%5]; pacer.SetRate(rate);
            now=std::max(now,pacer.Ready(now));
            if(i%29==0) now+=std::chrono::seconds(10);
            size_t in_window=0;
            for(auto it=starts.rbegin();it!=starts.rend() && *it>now-std::chrono::seconds(1);++it) ++in_window;
            require(in_window<static_cast<size_t>(rate));
            starts.push_back(now); pacer.Record(now);
            require(pacer.next>=now-std::chrono::seconds(1));
            require(pacer.count<=static_cast<size_t>(rate));
        }
    }
    {
        // Work arriving after an idle is rebased; continuously queued work is
        // not. Explicit reset stays pending past cancelled old-run queue nodes.
        const auto limiter=CreateStartLimiter(100);
        const auto old_handle=CreateCancellation(limiter), fresh_handle=CreateCancellation(limiter);
        std::shared_ptr<Cancellation> old_state, fresh_state;
        { std::lock_guard lock(handles_mutex); old_state=handles.at(old_handle); fresh_state=handles.at(fresh_handle); }
        auto gate=old_state->limiter;
        std::unique_ptr<StartQueueEntry> old_entry, fresh_entry;
        {
            std::lock_guard lock(gate->mutex);
            gate->pacer.Record(base);
            old_entry=std::make_unique<StartQueueEntry>(*gate,*old_state,Deadline::max());
            require(gate->rebase_pending);
            require(gate->HeadReady(base+100*millisecond)==base+100*millisecond);
            gate->pacer.Record(base+100*millisecond);
            fresh_entry=std::make_unique<StartQueueEntry>(*gate,*fresh_state,Deadline::max());
            require(!gate->rebase_pending);
            // The old head's stalled handoff must preserve full live-queue phase.
            old_entry.reset();
            require(gate->HeadReady(base+500*millisecond)==base+110*millisecond);
            fresh_entry.reset();
            old_entry=std::make_unique<StartQueueEntry>(*gate,*old_state,Deadline::max());
            gate->rebase_pending=false; // Simulate an already waiting previous run.
        }
        Cancel(old_handle);
        ResetStartSchedule(limiter);
        {
            std::lock_guard lock(gate->mutex);
            require(gate->rebase_pending && gate->pacer.count==2);
            fresh_entry=std::make_unique<StartQueueEntry>(*gate,*fresh_state,Deadline::max());
            require(gate->rebase_pending); // Neither Push nor cancelled nodes consume it.
            old_entry.reset();
            require(gate->HeadReady(base+600*millisecond)==base+600*millisecond);
            require(!gate->rebase_pending && gate->pacer.count==2);
            gate->pacer.Record(base+600*millisecond);
        }
        ResetStartSchedule(limiter);
        {
            std::lock_guard lock(gate->mutex);
            require(gate->HeadReady(base+605*millisecond)==base+610*millisecond); // Preserve future.
            require(gate->pacer.count==3);
            fresh_entry.reset();
            // Ordinary cancellation with no lifecycle API also cannot bridge
            // idle credit. Keep a cancelled node linked and append new demand.
            old_entry=std::make_unique<StartQueueEntry>(*gate,*old_state,Deadline::max());
            gate->rebase_pending=false;
            fresh_entry=std::make_unique<StartQueueEntry>(*gate,*fresh_state,Deadline::max());
            require(gate->rebase_pending);
            old_entry.reset();
            require(gate->HeadReady(base+700*millisecond)==base+700*millisecond);
            fresh_entry.reset();
            // The same protection covers expired (not cancelled) owners.
            fresh_entry=std::make_unique<StartQueueEntry>(*gate,*fresh_state,Clock::now()-millisecond);
            gate->rebase_pending=false;
            auto replacement_state=std::make_shared<Cancellation>(); replacement_state->limiter=gate;
            old_entry=std::make_unique<StartQueueEntry>(*gate,*replacement_state,Deadline::max());
            require(gate->rebase_pending);
            old_entry.reset(); fresh_entry.reset();
        }
        DestroyCancellation(old_handle); DestroyCancellation(fresh_handle); DestroyStartLimiter(limiter);
        try { ResetStartSchedule(limiter); require(false); }
        catch(const std::runtime_error& error) { require(std::string(error.what())=="CLAIM_CANCELLED"); }
    }
    {
        // Record the return of a variably delayed connect, but check the strict
        // one-second ceiling against its EARLIER actual-start observations.
        StartPacer pacer(100); auto now=base;
        std::vector<Deadline> actual_starts;
        for(int i=0;i<400;++i) {
            now=std::max(now,pacer.Ready(now)); actual_starts.push_back(now);
            now+=(i%13==0?30:2)*millisecond;
            pacer.Record(now); require(pacer.count<=100);
        }
        for(size_t i=100;i<actual_starts.size();++i) require(actual_starts[i]-actual_starts[i-100]>=std::chrono::seconds(1));
    }

    const auto limiter=CreateStartLimiter(100);
    std::vector<int64_t> owned;
    std::vector<std::shared_ptr<Cancellation>> states;
    for(int i=0;i<8;++i) {
        owned.push_back(CreateCancellation(limiter));
        std::lock_guard lock(handles_mutex); states.push_back(handles.at(owned.back()));
    }
    auto gate=states.front()->limiter;
    auto recorded_count=[&] { std::lock_guard lock(gate->mutex); return gate->pacer.count; };
    auto deadline=[] { return Clock::now()+std::chrono::seconds(3); };
    auto queued_count=[&] {
        std::lock_guard lock(gate->mutex); size_t count=0;
        for(auto* waiter=gate->first;waiter;waiter=waiter->next) ++count;
        return count;
    };
    auto wait_queued=[&](size_t count) {
        const auto until=deadline();
        while(queued_count()!=count && Clock::now()<until) std::this_thread::yield();
        require(queued_count()==count);
    };
    // Exceptions and expired calls unlink themselves without consuming permits.
    try { WithStartPermit(states[0],deadline(),[]()->int { throw std::runtime_error("TEST_THROW"); }); require(false); }
    catch(const std::runtime_error& error) { require(std::string(error.what())=="TEST_THROW"); }
    require(!gate->pacer.initialized && gate->pacer.count==0 && queued_count()==0);
    try { WithStartPermit(states[0],Clock::now(),[] { return 0; }); require(false); }
    catch(const std::runtime_error& error) { require(std::string(error.what())=="CLAIM_TIMEOUT"); }
    require(!gate->pacer.initialized && gate->pacer.count==0 && queued_count()==0);
    WithStartPermit(states[0],deadline(),[] { return 0; });
    SetStartRate(limiter,1); // Hold the queue while its deterministic order forms.

    std::vector<int> order;
    std::vector<std::string> outcomes(8);
    std::vector<std::jthread> workers;
    for(int i=0;i<8;++i) {
        workers.emplace_back([&,i] {
            try {
                WithStartPermit(states[i],i==2?Clock::now()+250*millisecond:deadline(),[&] { order.push_back(i); return 0; });
                outcomes[i]="OK";
            } catch(const std::runtime_error& error) { outcomes[i]=error.what(); }
        });
        wait_queued(i+1);
    }
    Cancel(owned[0]); // Cancel the head: the next waiter must take over pacing.
    Cancel(owned[4]); // Cancel a middle waiter without waking the entire queue.
    Cancel(owned[7]); // Removing the tail must also repair the next append point.
    workers[0].join(); workers[4].join(); workers[7].join(); workers[2].join();
    require(outcomes[0]=="CLAIM_CANCELLED" && outcomes[4]=="CLAIM_CANCELLED" && outcomes[7]=="CLAIM_CANCELLED" && outcomes[2]=="CLAIM_TIMEOUT");
    { std::lock_guard lock(gate->mutex); require(order.empty()); }
    require(queued_count()==4 && recorded_count()==1);
    SetStartRate(limiter,100); // Wake only the head and recompute its deadline.
    for(auto& worker:workers) if(worker.joinable()) worker.join();
    require(order==std::vector<int>({1,3,5,6}));
    require(queued_count()==0 && recorded_count()==5);
    for(int i:{1,3,5,6}) require(outcomes[i]=="OK");

    // A head deadline (not cancellation) also hands off without a fake start.
    SetStartRate(limiter,1);
    std::jthread expiring([&] {
        try { WithStartPermit(states[2],Clock::now()+60*millisecond,[] { return 0; }); outcomes[2]="BAD"; }
        catch(const std::runtime_error& error) { outcomes[2]=error.what(); }
    });
    wait_queued(1);
    std::jthread successor([&] {
        try { WithStartPermit(states[1],deadline(),[] { return 0; }); outcomes[1]="OK"; }
        catch(const std::runtime_error& error) { outcomes[1]=error.what(); }
    });
    wait_queued(2); expiring.join();
    require(outcomes[2]=="CLAIM_TIMEOUT" && queued_count()==1 && recorded_count()==5);
    SetStartRate(limiter,100); successor.join();
    require(outcomes[1]=="OK" && queued_count()==0 && recorded_count()==6);

    SetStartRate(limiter,1); workers.clear();
    for(int i:{1,3}) {
        workers.emplace_back([&,i] {
            try { WithStartPermit(states[i],deadline(),[] { return 0; }); outcomes[i]="BAD"; }
            catch(const std::runtime_error& error) { outcomes[i]=error.what(); }
        });
    }
    wait_queued(2); DestroyStartLimiter(limiter);
    for(auto& worker:workers) worker.join();
    require(outcomes[1]=="CLAIM_CANCELLED" && outcomes[3]=="CLAIM_CANCELLED");
    require(queued_count()==0 && recorded_count()==6);
    try { WithStartPermit(states[5],deadline(),[] { return 0; }); require(false); }
    catch(const std::runtime_error& error) { require(std::string(error.what())=="CLAIM_CANCELLED"); }
    for(auto handle:owned) { require(StartedAtNanos(handle)==0 && StartedAgeNanos(handle)==-1); DestroyCancellation(handle); }
    require(StartedAgeNanos(owned.front())==-1);
}
