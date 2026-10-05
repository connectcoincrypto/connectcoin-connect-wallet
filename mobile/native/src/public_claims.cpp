// Copyright (c) 2026 The ConnectCoin developers; MIT, see vendor/core/COPYING.
// Capture state machine adapted from Core wallet/p2c_tls.cpp. The consensus
// parser/verifier are compiled unmodified against small public-data adapters.
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
namespace connectwallet {
namespace {
using Clock=std::chrono::steady_clock;
using Deadline=Clock::time_point;
[[noreturn]] void Fail(const char* code) { throw std::runtime_error(code); }
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
struct Cancellation {
    std::atomic<bool> cancelled{false}, active{false};
    std::mutex mutex;
    Socket fd{BAD_SOCKET};
    void cancel() {
        cancelled.store(true);
        std::lock_guard lock(mutex);
        if(fd!=BAD_SOCKET) Shutdown(fd); // Owner closes; avoids descriptor-reuse races.
    }
};
std::mutex handles_mutex, tls_mutex;
std::unordered_map<int64_t,std::shared_ptr<Cancellation>> handles;
int64_t next_handle=0;
std::atomic<int> dns_workers{0}, active_captures{0};
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
        if(active_captures.fetch_add(1)>=4) { active_captures.fetch_sub(1); state->active=false; Fail("CLAIM_BUSY"); }
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
bool PublicEndpoint(const addrinfo& info) {
    if(info.ai_family==AF_INET && info.ai_addrlen==sizeof(sockaddr_in)) return PublicV4(reinterpret_cast<const unsigned char*>(&reinterpret_cast<const sockaddr_in*>(info.ai_addr)->sin_addr));
    if(info.ai_family==AF_INET6 && info.ai_addrlen==sizeof(sockaddr_in6)) {
        auto* value=reinterpret_cast<const sockaddr_in6*>(info.ai_addr);
        return value->sin6_scope_id==0 && PublicV6(reinterpret_cast<const unsigned char*>(&value->sin6_addr));
    }
    return false;
}
Endpoint Resolve(const std::string& domain,const std::shared_ptr<Cancellation>& cancellation,Deadline deadline) {
    // getaddrinfo cannot be killed portably. Only two detached DNS operations
    // may exist; callers still return on deadline/cancel and never connect late.
    if(dns_workers.fetch_add(1)>=2) { dns_workers.fetch_sub(1); Fail("CLAIM_BUSY"); }
    struct Result { std::mutex mutex; std::condition_variable changed; bool ready=false; std::vector<Endpoint> endpoints; };
    auto result=std::make_shared<Result>();
    try {
        std::thread([domain,result] {
            std::vector<Endpoint> found;
            try {
                addrinfo hints{}; hints.ai_family=AF_UNSPEC; hints.ai_socktype=SOCK_STREAM; hints.ai_protocol=IPPROTO_TCP;
                addrinfo* values=nullptr;
                if(getaddrinfo(domain.c_str(),"443",&hints,&values)==0) {
                    std::unique_ptr<addrinfo,decltype(&freeaddrinfo)> owner(values,&freeaddrinfo);
                    size_t visited=0;
                    for(auto* at=values;at && visited++<256 && found.size()<32;at=at->ai_next) {
                        if(!PublicEndpoint(*at)) continue;
                        Endpoint endpoint; endpoint.family=at->ai_family; endpoint.length=static_cast<socklen_t>(at->ai_addrlen);
                        std::memcpy(&endpoint.address,at->ai_addr,at->ai_addrlen); found.push_back(endpoint);
                    }
                }
            } catch(...) { found.clear(); }
            { std::lock_guard lock(result->mutex); result->endpoints=std::move(found); result->ready=true; }
            dns_workers.fetch_sub(1); result->changed.notify_one();
        }).detach();
    } catch(...) { dns_workers.fetch_sub(1); throw; }
    std::unique_lock lock(result->mutex);
    while(!result->ready) { Check(cancellation,deadline); result->changed.wait_for(lock,std::chrono::milliseconds(50)); }
    Check(cancellation,deadline);
    if(result->endpoints.empty()) Fail("CLAIM_DNS");
    uint32_t random{}; if(!StrongRandom(reinterpret_cast<unsigned char*>(&random),sizeof(random))) Fail("CLAIM_CRYPTO");
    return result->endpoints[random%result->endpoints.size()];
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
void Connect(OwnedSocket& sock,const Endpoint& endpoint,Deadline deadline) {
#ifdef _WIN32
    unsigned long value=1; if(ioctlsocket(sock.fd,FIONBIO,&value)) Fail("CLAIM_NETWORK");
#else
    int flags=fcntl(sock.fd,F_GETFL,0); if(flags<0 || fcntl(sock.fd,F_SETFL,flags|O_NONBLOCK)<0) Fail("CLAIM_NETWORK");
#endif
    Check(sock.state,deadline);
    if(connect(sock.fd,reinterpret_cast<const sockaddr*>(&endpoint.address),endpoint.length)==0) return;
    if(!WouldBlock(SocketError())) Fail("CLAIM_NETWORK");
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
    ~Connection() { std::lock_guard lock(tls_mutex); mbedtls_ssl_free(&ssl); mbedtls_ssl_config_free(&config); }
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
    // This standalone Mbed TLS configuration does not install PSA threading
    // callbacks. Serialize library calls, not DNS or socket polling, across
    // capture and validation; the same lock protects context destruction.
    std::lock_guard crypto_lock(tls_mutex);
    P2CTlsProofView parsed; std::string error;
    ClaimResult result;
    if(!ParseP2CTlsProof(proof,context.domain,Bytes(context.challenge_hex),parsed,error)) return result;
    CTxOut output(PayToDomainOutput{context.domain,Bytes(context.target_hex,true),1,static_cast<uint8_t>(context.signature_mask)});
    result.valid_proof=test_roots.empty()?VerifyP2CCertificateProof(output,parsed,context.validation_time,error):VerifyP2CCertificateProofForTest(output,parsed,context.validation_time,test_roots,error);
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
int64_t CreateCancellation() { std::lock_guard lock(handles_mutex); if(handles.size()>=32 || next_handle==INT64_MAX) Fail("CLAIM_BUSY"); auto value=++next_handle; handles.emplace(value,std::make_shared<Cancellation>()); return value; }
void Cancel(int64_t handle) { std::shared_ptr<Cancellation> state; { std::lock_guard lock(handles_mutex); auto it=handles.find(handle); if(it==handles.end()) return; state=it->second; } state->cancel(); }
void DestroyCancellation(int64_t handle) { std::shared_ptr<Cancellation> state; { std::lock_guard lock(handles_mutex); auto it=handles.find(handle); if(it==handles.end()) return; state=it->second; handles.erase(it); } state->cancel(); }
ClaimResult VerifyProof(const PublicClaimContext& context,std::span<const unsigned char> proof) { return Verify(context,proof); }
#ifdef CONNECTWALLET_NATIVE_TESTS
ClaimResult VerifyProofForTest(const PublicClaimContext& context,std::span<const unsigned char> proof,std::span<const unsigned char> roots) { if(roots.empty() || roots.size()>1024*1024) Fail("CLAIM_CONTEXT"); return Verify(context,proof,roots); }
#endif
static ClaimResult CaptureInternal(const PublicClaimContext& context,int timeout_ms,int64_t handle
#ifdef CONNECTWALLET_NATIVE_TESTS
    ,uint16_t test_port=0,std::span<const unsigned char> test_roots={}
#endif
) {
    Validate(context); if(timeout_ms<1 || timeout_ms>10000) Fail("CLAIM_CONTEXT");
    Slot slot(handle); auto state=slot.state; Deadline deadline=Clock::now()+std::chrono::milliseconds(timeout_ms); Check(state,deadline);
    InitializeSockets(); { std::lock_guard crypto_lock(tls_mutex); if(!P2CRootStoreAvailable()) Fail("CLAIM_CRYPTO"); } Check(state,deadline);
    Endpoint endpoint;
#ifdef CONNECTWALLET_NATIVE_TESTS
    if(test_port) {
        if(test_roots.empty() || test_roots.size()>1024*1024) Fail("CLAIM_CONTEXT");
        auto* address=reinterpret_cast<sockaddr_in*>(&endpoint.address);
        address->sin_family=AF_INET; address->sin_port=htons(test_port);
        inet_pton(AF_INET,"127.0.0.1",&address->sin_addr);
        endpoint.family=AF_INET; endpoint.length=sizeof(sockaddr_in);
    } else
#endif
    endpoint=Resolve(context.domain,state,deadline);
    Check(state,deadline);
    auto started=Clock::now(); int64_t measured_duration=-1;
    try {
    OwnedSocket socket(state,endpoint.family);
    Connect(socket,endpoint,std::min(deadline,Clock::now()+std::chrono::seconds(8)));
    uint256 challenge=Bytes(context.challenge_hex); Connection connection(challenge,socket.fd);
    static constexpr int suites[]{MBEDTLS_TLS1_3_AES_128_GCM_SHA256,MBEDTLS_TLS1_3_CHACHA20_POLY1305_SHA256,0};
    static constexpr uint16_t groups[]{29,23,0};
    std::vector<uint16_t> signatures; if(context.signature_mask&1) signatures.push_back(0x0403); if(context.signature_mask&2) signatures.push_back(0x0804); if(context.signature_mask&4) signatures.push_back(0x0809); signatures.push_back(0);
    {
        std::lock_guard lock(tls_mutex); Check(state,deadline);
        if(psa_crypto_init()!=PSA_SUCCESS || mbedtls_ssl_config_defaults(&connection.config,MBEDTLS_SSL_IS_CLIENT,MBEDTLS_SSL_TRANSPORT_STREAM,MBEDTLS_SSL_PRESET_DEFAULT)) Fail("CLAIM_CRYPTO");
        mbedtls_ssl_conf_min_tls_version(&connection.config,MBEDTLS_SSL_VERSION_TLS1_3); mbedtls_ssl_conf_max_tls_version(&connection.config,MBEDTLS_SSL_VERSION_TLS1_3);
        mbedtls_ssl_conf_tls13_key_exchange_modes(&connection.config,MBEDTLS_SSL_TLS1_3_KEY_EXCHANGE_MODE_EPHEMERAL);
        mbedtls_ssl_conf_ciphersuites(&connection.config,suites); mbedtls_ssl_conf_groups(&connection.config,groups); mbedtls_ssl_conf_sig_algs(&connection.config,signatures.data());
        mbedtls_ssl_conf_authmode(&connection.config,MBEDTLS_SSL_VERIFY_NONE); // Consensus verification follows before any proof can escape.
        mbedtls_ssl_conf_rng(&connection.config,Connection::Random,&connection);
        if(mbedtls_ssl_setup(&connection.ssl,&connection.config) || mbedtls_ssl_set_hostname(&connection.ssl,context.domain.c_str())) Fail("CLAIM_CRYPTO");
        mbedtls_ssl_set_bio(&connection.ssl,&connection,Connection::Send,Connection::Receive,nullptr);
    }
    std::vector<unsigned char> proof{P2C_PROOF_VERSION}; bool captured_verify=false;
    while(true) {
        Check(state,deadline); int phase=connection.ssl.state;
        if(phase==MBEDTLS_SSL_CLIENT_HELLO && connection.captured) Fail("CLAIM_TLS");
        int result; { std::lock_guard lock(tls_mutex); Check(state,deadline); result=mbedtls_ssl_handshake_step(&connection.ssl); }
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
        if(phase==MBEDTLS_SSL_CERTIFICATE_VERIFY) { P2CTlsProofView parsed; std::string error; if(!ParseP2CTlsProof(proof,context.domain,challenge,parsed,error) || !P2CSignatureSchemeAllowed(static_cast<uint8_t>(context.signature_mask),parsed.certificate_verify_scheme)) Fail("CLAIM_TLS"); captured_verify=true; }
        if(connection.ssl.state==MBEDTLS_SSL_HANDSHAKE_OVER) { if(!captured_verify) Fail("CLAIM_TLS"); break; }
    }
    measured_duration=std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count();
    Check(state,deadline); auto result=Verify(context,proof
#ifdef CONNECTWALLET_NATIVE_TESTS
        ,test_roots
#endif
    ); Check(state,deadline); result.duration_ms=measured_duration;
    if(!result.valid_proof) result.error_code="CLAIM_CERTIFICATE";
    return result;
    } catch(const std::runtime_error& error) {
        // A stopped session is never a failed sample, even if shutdown made
        // the TLS library report EOF first. DNS/queue time is not included.
        if(state->cancelled.load()) Fail("CLAIM_CANCELLED");
        std::string code=error.what();
        if(code!="CLAIM_NETWORK" && code!="CLAIM_TLS" && code!="CLAIM_CERTIFICATE" && code!="CLAIM_TIMEOUT") throw;
        ClaimResult failed; failed.error_code=code;
        failed.duration_ms=measured_duration>=0?measured_duration:std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now()-started).count();
        return failed;
    }
}
ClaimResult CaptureAndVerify(const PublicClaimContext& context,int timeout_ms,int64_t handle) { return CaptureInternal(context,timeout_ms,handle); }
#ifdef CONNECTWALLET_NATIVE_TESTS
ClaimResult CaptureLoopbackForTest(const PublicClaimContext& context,int timeout_ms,int64_t handle,uint16_t port,std::span<const unsigned char> roots) {
    if(!port) Fail("CLAIM_CONTEXT");
    return CaptureInternal(context,timeout_ms,handle,port,roots);
}
#endif
} // namespace connectwallet
