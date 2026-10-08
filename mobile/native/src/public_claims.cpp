// Copyright (c) 2026 The ConnectCoin developers; MIT, see vendor/core/COPYING.
// Capture state machine adapted from Core wallet/p2c_tls.cpp. The consensus
// rules are preserved; the mobile verifier adapts root-cache ownership only.
#define MBEDTLS_ALLOW_PRIVATE_ACCESS
#include <public_claims.h>
#include <consensus/p2c.h>
#include <consensus/p2c_x509.h>
#include <primitives/transaction.h>
#include <wallet/p2c_tls_private.h>
#include <mbedtls/ssl.h>
#include <mbedtls/version.h>
#include <psa/crypto.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
using Socket = SOCKET;
static constexpr Socket BAD_SOCKET=INVALID_SOCKET;
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#ifdef __APPLE__
#include <Security/SecRandom.h>
#else
#include <sys/random.h>
#include <sys/syscall.h>
#endif
#include <unistd.h>
#include <cerrno>
using Socket = int;
static constexpr Socket BAD_SOCKET=-1;
#endif
static_assert(MBEDTLS_VERSION_NUMBER == 0x03060700, "Review transcript layout on upgrade");
#ifdef _WIN32
void ReleaseMobileP2CRootStoreForThread();
#endif
namespace connectwallet {
namespace {
using Clock=std::chrono::steady_clock;
using Deadline=Clock::time_point;
[[noreturn]] void Fail(const char* code) { throw std::runtime_error(code); }
struct RootStoreScope {
#ifdef _WIN32
    // Trivial TLS data has no teardown callback. Release while all OS-thread
    // infrastructure is still alive, including on exceptions/cancellation.
    static thread_local unsigned depth;
    RootStoreScope() { ++depth; }
    ~RootStoreScope() { if(--depth==0) ReleaseMobileP2CRootStoreForThread(); }
#endif
};
#ifdef _WIN32
thread_local unsigned RootStoreScope::depth=0;
#endif
void CloseSocket(Socket fd) {
#ifdef _WIN32
    closesocket(fd);
#else
    close(fd);
#endif
}
void Shutdown(Socket fd) {
#ifdef _WIN32
    shutdown(fd, SD_BOTH);
#else
    shutdown(fd, SHUT_RDWR);
#endif
}
int SocketError() {
#ifdef _WIN32
    return WSAGetLastError();
#else
    return errno;
#endif
}
bool WouldBlock(int code) {
#ifdef _WIN32
    return code==WSAEWOULDBLOCK || code==WSAEINPROGRESS || code==WSAEINTR;
#else
    return code==EAGAIN || code==EWOULDBLOCK || code==EINPROGRESS || code==EINTR;
#endif
}
void InitializeSockets() {
#ifdef _WIN32
    static const bool ok=[] { WSADATA value{}; return WSAStartup(MAKEWORD(2,2), &value)==0; }();
    if(!ok) Fail("CLAIM_NETWORK");
#endif
}
// Clock-only pacing policy, independently exercised with deterministic time.
// Keep syscall-return observations: expiring these can never release a rolling
// permit before the corresponding actual connect has left its one-second window.
struct StartPacer {
    int rate;
    bool initialized=false;
    Deadline next{}, last{};
    std::array<Deadline,100> returns{};
    size_t first=0, count=0;
    explicit StartPacer(int value):rate(value) {}
    auto Interval() const { return std::chrono::nanoseconds((1000000000LL+rate-1)/rate); }
    void Expire(Deadline now) noexcept {
        while(count && returns[first]+std::chrono::seconds(1)<=now) {
            first=(first+1)%returns.size(); --count;
        }
    }
    Deadline Ready(Deadline now) noexcept {
        Expire(now);
        auto ready=initialized?next:now;
        if(count>=static_cast<size_t>(rate)) ready=std::max(ready,
            returns[(first+count-rate)%returns.size()]+std::chrono::seconds(1));
        return ready;
    }
    void Record(Deadline now) noexcept {
        Expire(now);
        // Advance the shared cadence, then retain at most one SECOND of late
        // queued demand (not one interval). The rolling actual-start ceiling is
        // independent and still limits every catch-up connect.
        next=initialized?std::max(next+Interval(),now-std::chrono::seconds(1)):now+Interval();
        initialized=true; last=now;
        returns[(first+count)%returns.size()]=now; ++count;
    }
    void Resume(Deadline now) noexcept {
        // Idle/lifecycle time is not work demand and cannot bank future starts.
        // Preserve both an unexpired future deadline and the rolling history.
        if(initialized) next=std::max(next,now);
    }
    void SetRate(int value) noexcept {
        if(rate==value) return;
        rate=value;
        if(initialized) next=last+Interval();
        // Never reset history: a lower limit may require old starts to expire.
    }
};
struct StartWaiter {
    std::condition_variable changed;
    StartWaiter *previous=nullptr, *next=nullptr;
    const std::atomic<bool>* cancelled=nullptr;
    Deadline deadline{};
};
struct StartLimiter {
    std::mutex mutex;
    bool destroyed=false, rebase_pending=false;
    StartPacer pacer;
    StartWaiter *first=nullptr, *last=nullptr;
    explicit StartLimiter(int value):pacer(value) {}
    void Push(StartWaiter& waiter) noexcept {
        // Cancelled/expired owners can still be linked until scheduled again.
        // They are not live demand and must not bridge an otherwise idle gap.
        const auto now=Clock::now(); bool live=false;
        for(auto* pending=first;pending;pending=pending->next) {
            if(!pending->cancelled->load() && pending->deadline>now) { live=true; break; }
        }
        if(!live) rebase_pending=true;
        waiter.previous=last;
        if(last) last->next=&waiter; else first=&waiter;
        last=&waiter;
    }
    void Remove(StartWaiter& waiter) noexcept {
        const bool was_first=first==&waiter;
        if(waiter.previous) waiter.previous->next=waiter.next; else first=waiter.next;
        if(waiter.next) waiter.next->previous=waiter.previous; else last=waiter.previous;
        if(was_first && first) first->changed.notify_one();
    }
    Deadline HeadReady(Deadline now) noexcept {
        // Only a live FIFO head consumes an idle/lifecycle reset. Cancelled
        // previous-run nodes may still be linked until their owners wake.
        if(rebase_pending) { pacer.Resume(now); rebase_pending=false; }
        return pacer.Ready(now);
    }
};
struct Cancellation {
    std::atomic<bool> cancelled{false}, active{false}, started{false};
    std::atomic<int64_t> started_at_ns{0};
    std::shared_ptr<StartLimiter> limiter;
    StartWaiter* waiting=nullptr; // Guarded by limiter->mutex; stack-owned by caller.
    std::mutex mutex;
    Socket fd{BAD_SOCKET};
    void cancel() {
        cancelled.store(true);
        if(limiter) {
            std::lock_guard lock(limiter->mutex);
            if(waiting) waiting->changed.notify_one();
        }
        std::lock_guard lock(mutex);
        if(fd!=BAD_SOCKET) Shutdown(fd); // Owner closes; avoids descriptor-reuse races.
    }
};
struct StartQueueEntry {
    StartLimiter& limiter;
    Cancellation& state;
    StartWaiter waiter;
    // Construct/destroy only while the limiter mutex is held. No heap allocation
    // is needed, and all exits (including a throwing start) unlink the waiter.
    StartQueueEntry(StartLimiter& gate,Cancellation& value,Deadline deadline):limiter(gate),state(value) {
        if(state.waiting) Fail("CLAIM_BUSY");
        waiter.cancelled=&state.cancelled; waiter.deadline=deadline;
        limiter.Push(waiter); state.waiting=&waiter;
    }
    ~StartQueueEntry() { state.waiting=nullptr; limiter.Remove(waiter); }
};
std::mutex handles_mutex;
std::unordered_map<int64_t,std::shared_ptr<Cancellation>> handles;
std::unordered_map<int64_t,std::shared_ptr<StartLimiter>> limiters;
int64_t next_handle=0, next_limiter=0;
constexpr int MAX_ACTIVE_CAPTURES=100;
constexpr size_t MAX_CANCELLATION_HANDLES=256;
std::atomic<int> active_captures{0};
void Check(const std::shared_ptr<Cancellation>& state, Deadline deadline) {
    if(state->cancelled.load()) Fail("CLAIM_CANCELLED");
    if(Clock::now()>=deadline) Fail("CLAIM_TIMEOUT");
}
struct Slot {
    std::shared_ptr<Cancellation> state;
    explicit Slot(int64_t handle) {
        { std::lock_guard lock(handles_mutex); auto it=handles.find(handle); if(it==handles.end()) Fail("CLAIM_CANCELLED"); state=it->second; }
        bool expected=false;
        if(!state->active.compare_exchange_strong(expected,true)) Fail("CLAIM_BUSY");
        if(active_captures.fetch_add(1)>=MAX_ACTIVE_CAPTURES) { active_captures.fetch_sub(1); state->active=false; Fail("CLAIM_BUSY"); }
        state->started=false;
        state->started_at_ns=0;
    }
    ~Slot() { state->active=false; active_captures.fetch_sub(1); }
};
struct OwnedSocket {
    std::shared_ptr<Cancellation> state;
    Socket fd;
    OwnedSocket(std::shared_ptr<Cancellation> value,int family):state(std::move(value)),fd(socket(family,SOCK_STREAM,IPPROTO_TCP)) {
        if(fd==BAD_SOCKET) Fail("CLAIM_NETWORK");
#ifdef __APPLE__
        int no_signal=1;
        if(setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&no_signal,sizeof(no_signal))) { CloseSocket(fd); Fail("CLAIM_NETWORK"); }
#endif
        std::lock_guard lock(state->mutex); state->fd=fd;
    }
    ~OwnedSocket() { std::lock_guard lock(state->mutex); state->fd=BAD_SOCKET; CloseSocket(fd); }
};
bool StrongRandom(unsigned char* out,size_t size) {
#ifdef _WIN32
    if(size>std::numeric_limits<ULONG>::max()) return false;
    return BCryptGenRandom(nullptr,out,static_cast<ULONG>(size),BCRYPT_USE_SYSTEM_PREFERRED_RNG)==0;
#elif defined(__APPLE__)
    return SecRandomCopyBytes(kSecRandomDefault,size,out)==errSecSuccess;
#else
    // Direct kernel call also supports Android API24-27, where libc has not
    // exported getrandom yet. ENOSYS is fatal; never fall back to a weak RNG.
    while(size) { ssize_t count=syscall(SYS_getrandom,out,size,0); if(count<0 && errno==EINTR) continue; if(count<=0) return false; out+=count; size-=static_cast<size_t>(count); }
    return true;
#endif
}
bool PublicV4(const unsigned char* ip) {
    if(ip[0]==0 || ip[0]==10 || ip[0]==127 || ip[0]>=224) return false;
    if(ip[0]==100 && (ip[1]&0xc0)==64) return false;
    if(ip[0]==169 && ip[1]==254) return false;
    if(ip[0]==172 && ip[1]>=16 && ip[1]<=31) return false;
    if(ip[0]==192 && (ip[1]==168 || (ip[1]==0 && (ip[2]==0 || ip[2]==2)))) return false;
    if(ip[0]==198 && (ip[1]==18 || ip[1]==19 || (ip[1]==51 && ip[2]==100))) return false;
    if(ip[0]==203 && ip[1]==0 && ip[2]==113) return false;
    return true;
}
bool PublicV6(const unsigned char* ip) {
    // Fail closed outside global-unicast; rejects mapped IPv4, NAT64, local,
    // multicast, and scoped addresses. Also deny special transition ranges.
    if((ip[0]&0xe0)!=0x20) return false;
    if(ip[0]==0x20 && ip[1]==0x01 && ip[2]<=1) return false; // IANA special /23.
    if(ip[0]==0x20 && ip[1]==0x01 && ip[2]==0x0d && ip[3]==0xb8) return false;
    if(ip[0]==0x20 && ip[1]==0x02) return false; // 6to4 can embed private IPv4.
    if(ip[0]==0x3f && (ip[1]&0xf0)==0xf0) return false; // documentation /20.
    return true;
}
struct Endpoint { sockaddr_storage address{}; socklen_t length{}; int family{}; };
bool SameEndpoint(const Endpoint& left,const Endpoint& right) {
    if(left.family!=right.family) return false;
    if(left.family==AF_INET) {
        const auto* a=reinterpret_cast<const sockaddr_in*>(&left.address);
        const auto* b=reinterpret_cast<const sockaddr_in*>(&right.address);
        return a->sin_port==b->sin_port && a->sin_addr.s_addr==b->sin_addr.s_addr;
    }
    if(left.family==AF_INET6) {
        const auto* a=reinterpret_cast<const sockaddr_in6*>(&left.address);
        const auto* b=reinterpret_cast<const sockaddr_in6*>(&right.address);
        return a->sin6_port==b->sin6_port && a->sin6_scope_id==b->sin6_scope_id &&
            std::memcmp(&a->sin6_addr,&b->sin6_addr,sizeof(in6_addr))==0;
    }
    return false;
}
// Wallet-local policy, identical to Core P2CEndpointPriority and desktop's
// EndpointScore. The DNS-cache mutex serializes selections and observations.
struct EndpointScore {
    double connections=0.1, seconds=0.02, credit=0;
    void Record(bool success,double elapsed) {
        if(!std::isfinite(elapsed) || elapsed<0) return;
        connections=0.999*connections+0.001*success;
        seconds=0.999*seconds+0.001*elapsed;
    }
    double Rate() const {
        return std::clamp(connections/seconds,std::numeric_limits<double>::denorm_min(),std::numeric_limits<double>::max());
    }
};
struct EndpointSelection { Endpoint endpoint; std::shared_ptr<EndpointScore> score; };
struct EndpointPriority {
    static constexpr size_t MAX_ENDPOINTS=32, MASK_COUNT=7;
    static constexpr double EXPLORATION=0.01;
    struct Entry { Endpoint endpoint; std::array<std::shared_ptr<EndpointScore>,MASK_COUNT> masks; };
    std::vector<Entry> entries;
    std::array<size_t,MASK_COUNT> next{};
    void Refresh(const std::vector<Endpoint>& endpoints) {
        std::vector<Entry> refreshed;
        refreshed.reserve(std::min(endpoints.size(),MAX_ENDPOINTS));
        for(const auto& endpoint:endpoints) {
            if(std::any_of(refreshed.begin(),refreshed.end(),[&](const auto& item) { return SameEndpoint(item.endpoint,endpoint); })) continue;
            const auto previous=std::find_if(entries.begin(),entries.end(),[&](const auto& item) { return SameEndpoint(item.endpoint,endpoint); });
            refreshed.push_back(previous==entries.end()?Entry{endpoint,{}}:*previous);
            if(refreshed.size()==MAX_ENDPOINTS) break;
        }
        entries=std::move(refreshed);
    }
    EndpointSelection Select(unsigned signature_mask) {
        if(entries.empty()) Fail("CLAIM_DNS");
        if(signature_mask<1 || signature_mask>MASK_COUNT) Fail("CLAIM_CONTEXT");
        const size_t mask=signature_mask-1, count=entries.size();
        std::array<double,MAX_ENDPOINTS> rates{}; double maximum=0, total=0;
        for(size_t index=0;index<count;++index) {
            auto& score=entries[index].masks[mask];
            if(!score) score=std::make_shared<EndpointScore>();
            rates[index]=score->Rate(); maximum=std::max(maximum,rates[index]);
        }
        for(size_t index=0;index<count;++index) { rates[index]/=maximum; total+=rates[index]; }
        for(size_t index=0;index<count;++index) entries[index].masks[mask]->credit+=
            EXPLORATION/count+(1.0-EXPLORATION)*rates[index]/total;
        const size_t cursor=next[mask]%count; size_t selected=cursor;
        for(size_t offset=1;offset<count;++offset) {
            const size_t candidate=(cursor+offset)%count;
            if(entries[candidate].masks[mask]->credit>entries[selected].masks[mask]->credit) selected=candidate;
        }
        auto& entry=entries[selected]; entry.masks[mask]->credit-=1.0; next[mask]=(selected+1)%count;
        return {entry.endpoint,entry.masks[mask]};
    }
};
bool PublicEndpoint(const addrinfo& info) {
    if(info.ai_family==AF_INET && info.ai_addrlen==sizeof(sockaddr_in)) return PublicV4(reinterpret_cast<const unsigned char*>(&reinterpret_cast<const sockaddr_in*>(info.ai_addr)->sin_addr));
    if(info.ai_family==AF_INET6 && info.ai_addrlen==sizeof(sockaddr_in6)) {
        auto* value=reinterpret_cast<const sockaddr_in6*>(info.ai_addr);
        return value->sin6_scope_id==0 && PublicV6(reinterpret_cast<const unsigned char*>(&value->sin6_addr));
    }
    return false;
}
std::vector<Endpoint> LookupPublicEndpoints(const std::string& domain) {
    std::vector<Endpoint> found;
    addrinfo hints{}; hints.ai_family=AF_UNSPEC; hints.ai_socktype=SOCK_STREAM; hints.ai_protocol=IPPROTO_TCP;
    addrinfo* values=nullptr;
    if(getaddrinfo(domain.c_str(),"443",&hints,&values)==0) {
        std::unique_ptr<addrinfo,decltype(&freeaddrinfo)> owner(values,&freeaddrinfo);
        size_t visited=0;
        for(auto* at=values;at && visited++<256 && found.size()<32;at=at->ai_next) {
            if(!PublicEndpoint(*at)) continue;
            Endpoint endpoint; endpoint.family=at->ai_family; endpoint.length=static_cast<socklen_t>(at->ai_addrlen);
            std::memcpy(&endpoint.address,at->ai_addr,at->ai_addrlen);
            if(std::none_of(found.begin(),found.end(),[&](const auto& known) { return SameEndpoint(known,endpoint); })) found.push_back(endpoint);
        }
    }
    return found;
}
struct DnsResult { bool ready=false; Deadline expires{}, last_used{}; EndpointPriority priority; };
struct DnsCache {
    static constexpr size_t MAX_ENTRIES=128, MAX_WORKERS=2;
    std::mutex mutex;
    std::condition_variable changed;
    std::unordered_map<std::string,std::shared_ptr<DnsResult>> entries;
    size_t workers=0;
};
// Shared lifetime also covers getaddrinfo operations that outlive their callers.
const auto dns_cache=std::make_shared<DnsCache>();
template<typename Lookup>
EndpointSelection ResolveCached(const std::shared_ptr<DnsCache>& cache,const std::string& domain,
        const std::shared_ptr<Cancellation>& cancellation,Deadline deadline,Lookup lookup,unsigned signature_mask=7) {
    if(signature_mask<1 || signature_mask>EndpointPriority::MASK_COUNT) Fail("CLAIM_CONTEXT");
    std::shared_ptr<DnsResult> result;
    std::unique_lock lock(cache->mutex);
    while(!result) {
        Check(cancellation,deadline);
        const auto now=Clock::now();
        // Keep expired statistics until this domain refreshes or is evicted.
        // Refresh reuses the SAME score objects for unchanged numeric IPs.
        // In-flight DNS entries cannot be evicted; their callers share a result.
        auto previous=cache->entries.find(domain);
        if(previous!=cache->entries.end() && (!previous->second->ready || previous->second->expires>now)) { result=previous->second; break; }
        // getaddrinfo is not portably cancellable. Never launch more than two
        // resolver threads; waiters retain their own cancellation and deadline.
        if(cache->workers>=DnsCache::MAX_WORKERS) { cache->changed.wait_for(lock,std::chrono::milliseconds(50)); continue; }
        if(previous==cache->entries.end() && cache->entries.size()>=DnsCache::MAX_ENTRIES) {
            auto oldest=cache->entries.end();
            for(auto it=cache->entries.begin();it!=cache->entries.end();++it) {
                if(it->second->ready && (oldest==cache->entries.end() || it->second->last_used<oldest->second->last_used)) oldest=it;
            }
            if(oldest==cache->entries.end()) { cache->changed.wait_for(lock,std::chrono::milliseconds(50)); continue; }
            cache->entries.erase(oldest);
        }
        const bool refreshing=previous!=cache->entries.end();
        result=refreshing?previous->second:std::make_shared<DnsResult>(); result->ready=false; result->last_used=now;
        if(!refreshing) cache->entries.emplace(domain,result);
        ++cache->workers;
        try {
            std::thread([cache,domain,result,lookup] {
                std::vector<Endpoint> found;
                try { found=lookup(domain); } catch(...) { found.clear(); }
                {
                    std::lock_guard completed(cache->mutex);
                    try { result->priority.Refresh(found); } catch(...) { result->priority.entries.clear(); }
                    result->ready=true;
                    result->expires=Clock::now()+(result->priority.entries.empty()?std::chrono::seconds(5):std::chrono::seconds(60));
                    --cache->workers;
                }
                cache->changed.notify_all();
            }).detach();
        } catch(...) { --cache->workers; if(refreshing) result->ready=true; else cache->entries.erase(domain); cache->changed.notify_all(); throw; }
    }
    while(!result->ready) { Check(cancellation,deadline); cache->changed.wait_for(lock,std::chrono::milliseconds(50)); }
    Check(cancellation,deadline);
    result->last_used=Clock::now();
    return result->priority.Select(signature_mask);
}
EndpointSelection Resolve(const std::string& domain,unsigned signature_mask,const std::shared_ptr<Cancellation>& cancellation,Deadline deadline) {
    return ResolveCached(dns_cache,domain,cancellation,deadline,LookupPublicEndpoints,signature_mask);
}
void ObserveEndpoint(const std::shared_ptr<DnsCache>& cache,const EndpointSelection& selected,bool success,double seconds) {
    if(!selected.score) return;
    std::lock_guard lock(cache->mutex);
    // A late result updates only its original object. It cannot reinsert a
    // removed IP or an evicted domain, even if that address appears again.
    selected.score->Record(success,seconds);
}
ClaimResult FailedCaptureResult(const std::string& error,int64_t duration,bool captured,bool validation_passed=false) {
    ClaimResult failed; failed.error_code=error; failed.duration_ms=duration;
    failed.captured=captured; failed.validation_passed=validation_passed;
    // Usable proof fields intentionally retain their false/empty defaults.
    return failed;
}
ClaimResult FinalizeKnownCapture(ClaimResult result,int64_t duration,const std::shared_ptr<Cancellation>& state,Deadline deadline) {
    if(state->cancelled.load()) Fail("CLAIM_CANCELLED");
    // Preserve the terminal validation observation without returning usable
    // proof bytes after the deadline. Consumers learn from validationPassed,
    // not the independent validProof (proof usable for submission) field.
    if(Clock::now()>=deadline) return FailedCaptureResult("CLAIM_TIMEOUT",duration,true,result.valid_proof);
    result.duration_ms=duration; result.captured=true; result.validation_passed=result.valid_proof;
    if(!result.valid_proof) result.error_code="CLAIM_CERTIFICATE";
    return result;
}
void Wait(Socket fd,bool read,const std::shared_ptr<Cancellation>& cancellation,Deadline deadline) {
    Check(cancellation,deadline);
    int milliseconds=static_cast<int>(std::max<int64_t>(1,std::min<int64_t>(100,std::chrono::duration_cast<std::chrono::milliseconds>(deadline-Clock::now()).count())));
#ifdef _WIN32
    WSAPOLLFD item{fd,static_cast<short>(read?POLLRDNORM:POLLWRNORM),0};
    int result=WSAPoll(&item,1,milliseconds);
#else
    pollfd item{fd,static_cast<short>(read?POLLIN:POLLOUT),0}; int result=poll(&item,1,milliseconds);
#endif
    if(result<0 && !WouldBlock(SocketError())) Fail("CLAIM_NETWORK");
    Check(cancellation,deadline);
}
template<typename Start>
auto WithStartPermit(const std::shared_ptr<Cancellation>& state,Deadline deadline,Start start) {
    auto limiter=state->limiter;
    if(!limiter) Fail("CLAIM_CONTEXT");
    std::unique_lock lock(limiter->mutex);
    Check(state,deadline);
    if(limiter->destroyed) Fail("CLAIM_CANCELLED");
    StartQueueEntry queued(*limiter,*state,deadline);
    while(true) {
        Check(state,deadline);
        if(limiter->destroyed) Fail("CLAIM_CANCELLED");
        if(limiter->first!=&queued.waiter) {
            // Non-head callers wake only for their own deadline/cancellation
            // or a FIFO handoff, not at every global pacing tick.
            queued.waiter.changed.wait_until(lock,deadline);
            continue;
        }
        const auto now=Clock::now();
        const auto ready=limiter->HeadReady(now);
        if(now>=ready) break;
        queued.waiter.changed.wait_until(lock,std::min(deadline,ready));
    }
    // Serialize only the nonblocking syscall. Keep the rolling ceiling even
    // when an overdue anchored deadline allows a short catch-up interval.
    Check(state,deadline);
    auto result=start();
    limiter->pacer.Record(Clock::now());
    return result;
}
void Connect(OwnedSocket& sock,const Endpoint& endpoint,Deadline deadline,Deadline& started) {
#ifdef _WIN32
    unsigned long value=1; if(ioctlsocket(sock.fd,FIONBIO,&value)) Fail("CLAIM_NETWORK");
#else
    int flags=fcntl(sock.fd,F_GETFL,0); if(flags<0 || fcntl(sock.fd,F_SETFL,flags|O_NONBLOCK)<0) Fail("CLAIM_NETWORK");
#endif
    const auto result=WithStartPermit(sock.state,deadline,[&] {
        Check(sock.state,deadline);
        started=Clock::now();
        sock.state->started_at_ns=std::chrono::duration_cast<std::chrono::nanoseconds>(started.time_since_epoch()).count();
        sock.state->started=true;
        const int status=connect(sock.fd,reinterpret_cast<const sockaddr*>(&endpoint.address),endpoint.length);
        return std::pair{status,status==0?0:SocketError()};
    });
    if(result.first==0) return;
    if(!WouldBlock(result.second)) Fail("CLAIM_NETWORK");
    while(true) {
        Wait(sock.fd,false,sock.state,deadline);
        sockaddr_storage peer{}; socklen_t length=sizeof(peer);
        if(getpeername(sock.fd,reinterpret_cast<sockaddr*>(&peer),&length)==0) return;
        int error=0; socklen_t bytes=sizeof(error);
        if(getsockopt(sock.fd,SOL_SOCKET,SO_ERROR,reinterpret_cast<char*>(&error),&bytes)!=0 || (error && !WouldBlock(error))) Fail("CLAIM_NETWORK");
    }
}
struct Connection {
    mbedtls_ssl_context ssl{}; mbedtls_ssl_config config{};
    const uint256& challenge; Socket fd; bool random_set=false, captured=false;
    std::array<unsigned char,16389> sent{}; size_t sent_size=0;
    Connection(const uint256& bytes,Socket socket):challenge(bytes),fd(socket) { mbedtls_ssl_init(&ssl); mbedtls_ssl_config_init(&config); }
    ~Connection() { mbedtls_ssl_free(&ssl); mbedtls_ssl_config_free(&config); }
    static int Random(void* context,unsigned char* out,size_t size) {
        auto& self=*static_cast<Connection*>(context);
        if(out==connectcoin_p2c_client_random(&self.ssl) && size==32) { std::copy(self.challenge.begin(),self.challenge.end(),out); self.random_set=true; return 0; }
        return StrongRandom(out,size)?0:MBEDTLS_ERR_SSL_INTERNAL_ERROR;
    }
    static int Send(void* context,const unsigned char* data,size_t size) {
        auto& self=*static_cast<Connection*>(context);
        if(size>16384+256) return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
#ifdef _WIN32
        int result=send(self.fd,reinterpret_cast<const char*>(data),static_cast<int>(size),0);
#elif defined(__APPLE__)
        int result=static_cast<int>(send(self.fd,data,size,0)); // SO_NOSIGPIPE was set when the socket was created.
#else
        int result=static_cast<int>(send(self.fd,data,size,MSG_NOSIGNAL));
#endif
        if(result>0 && !self.captured) { if(static_cast<size_t>(result)>self.sent.size()-self.sent_size) return MBEDTLS_ERR_SSL_INTERNAL_ERROR; std::copy_n(data,result,self.sent.data()+self.sent_size); self.sent_size+=result; }
        return result>=0?result:(WouldBlock(SocketError())?MBEDTLS_ERR_SSL_WANT_WRITE:MBEDTLS_ERR_SSL_INTERNAL_ERROR);
    }
    static int Receive(void* context,unsigned char* data,size_t size) {
        auto& self=*static_cast<Connection*>(context);
        int result=static_cast<int>(recv(self.fd,reinterpret_cast<char*>(data),static_cast<int>(size),0));
        return result>=0?result:(WouldBlock(SocketError())?MBEDTLS_ERR_SSL_WANT_READ:MBEDTLS_ERR_SSL_INTERNAL_ERROR);
    }
};
void Validate(const PublicClaimContext& context) {
    if(!IsCanonicalP2CDomain(context.domain) || context.domain.find('.')==std::string::npos || context.domain.ends_with(".localhost") || context.domain.ends_with(".local") || context.domain.ends_with(".internal")) Fail("CLAIM_CONTEXT");
    if(context.roots_version!=1 || context.signature_mask<1 || context.signature_mask>7 || context.validation_time<=0 || context.validation_time>253402300799LL) Fail("CLAIM_CONTEXT");
    if(context.challenge_hex.size()!=64 || context.target_hex.size()!=64) Fail("CLAIM_CONTEXT");
    DecodeHex(context.challenge_hex,32); DecodeHex(context.target_hex,32);
    in_addr v4{}; in6_addr v6{};
    if(inet_pton(AF_INET,context.domain.c_str(),&v4)==1 || inet_pton(AF_INET6,context.domain.c_str(),&v6)==1) Fail("CLAIM_CONTEXT");
}
uint256 Bytes(std::string_view hex,bool reversed=false) { auto bytes=DecodeHex(hex,32); uint256 out{}; std::copy(bytes.begin(),bytes.end(),out.begin()); if(reversed) std::reverse(out.begin(),out.end()); return out; }
ClaimResult Verify(const PublicClaimContext& context,std::span<const unsigned char> proof,std::span<const unsigned char> test_roots={}) {
    Validate(context);
    InitializeCrypto();
    RootStoreScope root_scope;
    P2CTlsProofView parsed; std::string error;
    ClaimResult result;
    if(!ParseP2CTlsProof(proof,context.domain,Bytes(context.challenge_hex),parsed,error)) return result;
    CTxOut output(PayToDomainOutput{context.domain,Bytes(context.target_hex,true),1,static_cast<uint8_t>(context.signature_mask)});
    result.valid_proof=test_roots.empty()?VerifyP2CCertificateProof(output,parsed,context.validation_time,error):VerifyP2CCertificateProofForTest(output,parsed,context.validation_time,test_roots,error);
    result.validation_passed=result.valid_proof;
    if(result.valid_proof) { result.meets_target=P2CMeetsWorkTarget(parsed.connection_work_hash,Bytes(context.target_hex,true)); result.proof_hex=EncodeHex(proof); }
    return result;
}
} // namespace
std::vector<unsigned char> DecodeHex(std::string_view text,size_t maximum) {
    if(text.size()%2 || text.size()/2>maximum) Fail("CLAIM_CONTEXT");
    std::vector<unsigned char> out; out.reserve(text.size()/2);
    auto digit=[](char ch)->unsigned { if(ch>='0' && ch<='9') return ch-'0'; if(ch>='a' && ch<='f') return ch-'a'+10; Fail("CLAIM_CONTEXT"); };
    for(size_t i=0;i<text.size();i+=2) out.push_back(static_cast<unsigned char>((digit(text[i])<<4)|digit(text[i+1])));
    return out;
}
std::string EncodeHex(std::span<const unsigned char> bytes) { static constexpr char digits[]="0123456789abcdef"; std::string out; out.reserve(bytes.size()*2); for(auto value:bytes) { out+=digits[value>>4]; out+=digits[value&15]; } return out; }
bool IsPublicAddress(std::string_view address) { InitializeSockets(); std::string value(address); in_addr v4{}; in6_addr v6{}; if(inet_pton(AF_INET,value.c_str(),&v4)==1) return PublicV4(reinterpret_cast<const unsigned char*>(&v4)); if(inet_pton(AF_INET6,value.c_str(),&v6)==1) return PublicV6(reinterpret_cast<const unsigned char*>(&v6)); return false; }
int64_t CreateStartLimiter(int rate) {
    if(rate<1 || rate>100) Fail("CLAIM_CONTEXT");
    std::lock_guard lock(handles_mutex);
    if(limiters.size()>=MAX_CANCELLATION_HANDLES || next_limiter==INT64_MAX) Fail("CLAIM_BUSY");
    const auto value=++next_limiter; limiters.emplace(value,std::make_shared<StartLimiter>(rate)); return value;
}
void SetStartRate(int64_t handle,int rate) {
    if(rate<1 || rate>100) Fail("CLAIM_CONTEXT");
    std::shared_ptr<StartLimiter> limiter;
    { std::lock_guard lock(handles_mutex); const auto it=limiters.find(handle); if(it==limiters.end()) Fail("CLAIM_CANCELLED"); limiter=it->second; }
    { std::lock_guard lock(limiter->mutex); if(limiter->destroyed) Fail("CLAIM_CANCELLED"); limiter->pacer.SetRate(rate); if(limiter->first) limiter->first->changed.notify_one(); }
}
void ResetStartSchedule(int64_t handle) {
    std::shared_ptr<StartLimiter> limiter;
    { std::lock_guard lock(handles_mutex); const auto it=limiters.find(handle); if(it==limiters.end()) Fail("CLAIM_CANCELLED"); limiter=it->second; }
    std::lock_guard lock(limiter->mutex);
    if(limiter->destroyed) Fail("CLAIM_CANCELLED");
    limiter->rebase_pending=true;
    if(limiter->first) limiter->first->changed.notify_one();
}
void DestroyStartLimiter(int64_t handle) {
    std::shared_ptr<StartLimiter> limiter;
    { std::lock_guard lock(handles_mutex); const auto it=limiters.find(handle); if(it==limiters.end()) return; limiter=it->second; limiters.erase(it); }
    { std::lock_guard lock(limiter->mutex); limiter->destroyed=true; for(auto* waiter=limiter->first;waiter;waiter=waiter->next) waiter->changed.notify_one(); }
}
int64_t CreateCancellation(int64_t limiter) {
    std::lock_guard lock(handles_mutex);
    if(handles.size()>=MAX_CANCELLATION_HANDLES || next_handle==INT64_MAX) Fail("CLAIM_BUSY");
    auto state=std::make_shared<Cancellation>();
    if(limiter) { const auto it=limiters.find(limiter); if(it==limiters.end()) Fail("CLAIM_CANCELLED"); state->limiter=it->second; }
    else { static const auto default_limiter=std::make_shared<StartLimiter>(100); state->limiter=default_limiter; }
    auto value=++next_handle; handles.emplace(value,std::move(state)); return value;
}
bool HasStarted(int64_t handle) { std::lock_guard lock(handles_mutex); auto it=handles.find(handle); return it!=handles.end() && it->second->started.load(); }
int64_t StartedAtNanos(int64_t handle) { std::lock_guard lock(handles_mutex); auto it=handles.find(handle); return it==handles.end()?0:it->second->started_at_ns.load(); }
int64_t StartedAgeNanos(int64_t handle) { const auto started=StartedAtNanos(handle); return started?std::max<int64_t>(0,std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count()-started):-1; }
void Cancel(int64_t handle) { std::shared_ptr<Cancellation> state; { std::lock_guard lock(handles_mutex); auto it=handles.find(handle); if(it==handles.end()) return; state=it->second; } state->cancel(); }
void DestroyCancellation(int64_t handle) { std::shared_ptr<Cancellation> state; { std::lock_guard lock(handles_mutex); auto it=handles.find(handle); if(it==handles.end()) return; state=it->second; handles.erase(it); } state->cancel(); }
ClaimResult VerifyProof(const PublicClaimContext& context,std::span<const unsigned char> proof) { return Verify(context,proof); }
#ifdef CONNECTWALLET_NATIVE_TESTS
std::atomic<void (*)(const void*)> verification_observer{nullptr};
void SetVerificationObserverForTest(void (*observer)(const void*)) { verification_observer=observer; }
void NativeVerificationObserverForTest(const void* roots) { if(auto observer=verification_observer.load()) observer(roots); }
ClaimResult VerifyProofForTest(const PublicClaimContext& context,std::span<const unsigned char> proof,std::span<const unsigned char> roots) { if(roots.empty() || roots.size()>1024*1024) Fail("CLAIM_CONTEXT"); return Verify(context,proof,roots); }
#endif
static ClaimResult CaptureInternal(const PublicClaimContext& context,int timeout_ms,int64_t handle,
    bool complete_handshake,Deadline deadline
#ifdef CONNECTWALLET_NATIVE_TESTS
    ,uint16_t test_port=0,std::span<const unsigned char> test_roots={}
#endif
) {
    Validate(context); if(timeout_ms<1 || timeout_ms>10000) Fail("CLAIM_CONTEXT");
    Slot slot(handle); auto state=slot.state; Check(state,deadline);
    InitializeSockets(); InitializeCrypto(); RootStoreScope root_scope;
    if(!P2CRootStoreAvailable()) Fail("CLAIM_CRYPTO"); Check(state,deadline);
    EndpointSelection selected;
    Endpoint& endpoint=selected.endpoint;
#ifdef CONNECTWALLET_NATIVE_TESTS
    if(test_port) {
        if(test_roots.empty() || test_roots.size()>1024*1024) Fail("CLAIM_CONTEXT");
        auto* address=reinterpret_cast<sockaddr_in*>(&endpoint.address);
        address->sin_family=AF_INET; address->sin_port=htons(test_port);
        inet_pton(AF_INET,"127.0.0.1",&address->sin_addr);
        endpoint.family=AF_INET; endpoint.length=sizeof(sockaddr_in);
    } else
#endif
    selected=Resolve(context.domain,context.signature_mask,state,deadline);
    Check(state,deadline);
    auto started=Clock::now(); int64_t measured_duration=-1; bool observed=false, observed_validation=false;
    try {
    OwnedSocket socket(state,endpoint.family);
    Connect(socket,endpoint,std::min(deadline,Clock::now()+std::chrono::seconds(8)),started);
    uint256 challenge=Bytes(context.challenge_hex); Connection connection(challenge,socket.fd);
    static constexpr int suites[]{MBEDTLS_TLS1_3_AES_128_GCM_SHA256,MBEDTLS_TLS1_3_CHACHA20_POLY1305_SHA256,0};
    static constexpr uint16_t groups[]{29,23,0};
    std::vector<uint16_t> signatures; if(context.signature_mask&1) signatures.push_back(0x0403); if(context.signature_mask&2) signatures.push_back(0x0804); if(context.signature_mask&4) signatures.push_back(0x0809); signatures.push_back(0);
    {
        Check(state,deadline);
        if(mbedtls_ssl_config_defaults(&connection.config,MBEDTLS_SSL_IS_CLIENT,MBEDTLS_SSL_TRANSPORT_STREAM,MBEDTLS_SSL_PRESET_DEFAULT)) Fail("CLAIM_CRYPTO");
        mbedtls_ssl_conf_min_tls_version(&connection.config,MBEDTLS_SSL_VERSION_TLS1_3); mbedtls_ssl_conf_max_tls_version(&connection.config,MBEDTLS_SSL_VERSION_TLS1_3);
        mbedtls_ssl_conf_tls13_key_exchange_modes(&connection.config,MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_EPHEMERAL);
        mbedtls_ssl_conf_ciphersuites(&connection.config,suites); mbedtls_ssl_conf_groups(&connection.config,groups); mbedtls_ssl_conf_sig_algs(&connection.config,signatures.data());
        mbedtls_ssl_conf_authmode(&connection.config,MBEDTLS_SSL_VERIFY_NONE); // Consensus verification follows before any proof can escape.
        mbedtls_ssl_conf_rng(&connection.config,Connection::Random,&connection);
        if(mbedtls_ssl_setup(&connection.ssl,&connection.config) || mbedtls_ssl_set_hostname(&connection.ssl,context.domain.c_str())) Fail("CLAIM_CRYPTO");
        mbedtls_ssl_set_bio(&connection.ssl,&connection,Connection::Send,Connection::Receive,nullptr);
    }
    std::vector<unsigned char> proof{P2C_PROOF_VERSION}; bool transcript_complete=false;
    while(true) {
        Check(state,deadline); int phase=connection.ssl.state;
        if(phase==MBEDTLS_SSL_CLIENT_HELLO && connection.captured) Fail("CLAIM_TLS");
        int result=mbedtls_ssl_handshake_step(&connection.ssl);
        if(!connection.captured && connection.sent_size>=5) {
            size_t length=static_cast<size_t>(connection.sent[3])*256+connection.sent[4];
            if(connection.sent[0]!=22 || length<4 || length>connection.sent.size()-5) Fail("CLAIM_TLS");
            if(connection.sent_size>=length+5) { if(!connection.random_set || connection.sent[5]!=1) Fail("CLAIM_TLS"); proof.insert(proof.end(),connection.sent.begin()+5,connection.sent.begin()+5+length); connection.captured=true; }
        }
        if(result==MBEDTLS_ERR_SSL_WANT_READ || result==MBEDTLS_ERR_SSL_WANT_WRITE) { Wait(socket.fd,result==MBEDTLS_ERR_SSL_WANT_READ,state,deadline); continue; }
        if(result) Fail("CLAIM_TLS");
        if(phase==MBEDTLS_SSL_SERVER_CERTIFICATE) { const auto* negotiated=connection.ssl.session_negotiate; std::string error; if(!negotiated || !negotiated->peer_cert || !CheckP2CCertificatePublicKeys(*negotiated->peer_cert,error)) Fail("CLAIM_CERTIFICATE"); }
        if(phase==MBEDTLS_SSL_SERVER_HELLO || phase==MBEDTLS_SSL_ENCRYPTED_EXTENSIONS || phase==MBEDTLS_SSL_SERVER_CERTIFICATE || phase==MBEDTLS_SSL_CERTIFICATE_VERIFY) {
            size_t length=connection.ssl.in_hslen; if(length<4 || length>MAX_P2C_PROOF_SIZE-proof.size()) Fail("CLAIM_TLS");
            proof.insert(proof.end(),connection.ssl.in_msg,connection.ssl.in_msg+length);
        }
        if(phase==MBEDTLS_SSL_CERTIFICATE_VERIFY) {
            P2CTlsProofView parsed; std::string error;
            if(!ParseP2CTlsProof(proof,context.domain,challenge,parsed,error) || !P2CSignatureSchemeAllowed(static_cast<uint8_t>(context.signature_mask),parsed.certificate_verify_scheme)) Fail("CLAIM_TLS");
            transcript_complete=true;
            // Claims still stop here, like Core. A separate capability probe
            // must authenticate server Finished and send client Finished too.
            if(!complete_handshake) break;
        }
        if(connection.ssl.state==MBEDTLS_SSL_HANDSHAKE_OVER) {
            if(!complete_handshake || !transcript_complete) Fail("CLAIM_TLS");
            break;
        }
    }
    measured_duration=std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count();
    Check(state,deadline); auto result=Verify(context,proof
#ifdef CONNECTWALLET_NATIVE_TESTS
        ,test_roots
#endif
    );
    // A completed certificate/signature result is known even if cancellation
    // arrived during synchronous verification. Learn exactly once, but still
    // suppress the proof when cancellation/deadline wins before returning it.
    observed_validation=result.valid_proof;
    if(!complete_handshake) ObserveEndpoint(dns_cache,selected,observed_validation,measured_duration/1000.0);
    observed=true;
    return FinalizeKnownCapture(std::move(result),measured_duration,state,deadline);
    } catch(const std::runtime_error& error) {
        // A stopped session is never a failed sample, even if shutdown made
        // the TLS library report EOF first. DNS/queue time is not included.
        if(state->cancelled.load()) Fail("CLAIM_CANCELLED");
        std::string code=error.what();
        if(code!="CLAIM_NETWORK" && code!="CLAIM_TLS" && code!="CLAIM_CERTIFICATE" && code!="CLAIM_TIMEOUT") throw;
        if(!state->started.load()) throw; // DNS/local socket setup are not IP observations.
        auto failed=FailedCaptureResult(code,measured_duration>=0?measured_duration:std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count(),measured_duration>=0,observed && observed_validation);
        if(!observed && !complete_handshake) ObserveEndpoint(dns_cache,selected,false,failed.duration_ms/1000.0);
        return failed;
    }
}
ClaimResult CaptureAndVerify(const PublicClaimContext& context,int timeout_ms,int64_t handle) { return CaptureInternal(context,timeout_ms,handle,false,Clock::now()+std::chrono::milliseconds(timeout_ms)); }
static std::string ProbeRsaInternal(const std::string& domain,int64_t validation_time,int timeout_ms,int64_t handle
#ifdef CONNECTWALLET_NATIVE_TESTS
    ,uint16_t test_port=0,std::span<const unsigned char> test_roots={}
#endif
) {
    if(timeout_ms<1 || timeout_ms>3000) Fail("CLAIM_CONTEXT");
    const Deadline deadline=Clock::now()+std::chrono::milliseconds(timeout_ms);
    PublicClaimContext context{domain,std::string(64,'0'),std::string(64,'f'),1,6,validation_time};
    Validate(context);
    if(domain=="home.arpa" || domain.ends_with(".home.arpa")) Fail("CLAIM_CONTEXT");
    try {
        std::array<unsigned char,32> challenge{};
        if(!StrongRandom(challenge.data(),challenge.size())) Fail("CLAIM_CRYPTO");
        context.challenge_hex=EncodeHex(challenge);
        const auto result=CaptureInternal(context,timeout_ms,handle,true,deadline
#ifdef CONNECTWALLET_NATIVE_TESTS
            ,test_port,test_roots
#endif
        );
        // validation_passed alone can survive expiry for claim EMA accounting;
        // capability success instead requires an unexpired completed handshake.
        if(result.valid_proof && result.captured && result.meets_target && result.error_code.empty()) return "verified";
        return result.error_code=="CLAIM_TIMEOUT"?"timeout":"failed";
    } catch(const std::runtime_error& error) {
        const std::string_view code=error.what();
        if(code=="CLAIM_CANCELLED" || code=="CLAIM_CONTEXT") throw;
        if(code=="CLAIM_TIMEOUT") return "timeout";
        if(code=="CLAIM_BUSY") return "busy";
        if(code=="CLAIM_CRYPTO") return "unavailable";
        if(code=="CLAIM_NETWORK" || code=="CLAIM_DNS" || code=="CLAIM_TLS" || code=="CLAIM_CERTIFICATE") return "failed";
        throw;
    }
}
std::string ProbeRsa(const std::string& domain,int64_t validation_time,int timeout_ms,int64_t handle) {
    return ProbeRsaInternal(domain,validation_time,timeout_ms,handle);
}
#ifdef CONNECTWALLET_NATIVE_TESTS
bool CheckNativeRootStoreForTest() { InitializeCrypto(); RootStoreScope root_scope; return P2CRootStoreAvailable(); }
ClaimResult CaptureLoopbackForTest(const PublicClaimContext& context,int timeout_ms,int64_t handle,uint16_t port,std::span<const unsigned char> roots) {
    if(!port) Fail("CLAIM_CONTEXT");
    return CaptureInternal(context,timeout_ms,handle,false,Clock::now()+std::chrono::milliseconds(timeout_ms),port,roots);
}
std::string ProbeRsaLoopbackForTest(const std::string& domain,int64_t validation_time,int timeout_ms,int64_t handle,uint16_t port,std::span<const unsigned char> roots) {
    if(!port) Fail("CLAIM_CONTEXT");
    return ProbeRsaInternal(domain,validation_time,timeout_ms,handle,port,roots);
}
// Host-only white-box coverage; Android configuration rejects this definition.
#include "../tests/capacity_test.inc"
#include "../tests/endpoint_priority_test.inc"
#include "../tests/start_limiter_test.inc"
#endif
} // namespace connectwallet
