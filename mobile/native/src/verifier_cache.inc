// Included in the generated, pinned Core verifier after its time helpers.
// Memoize immutable DER and successful static signature arithmetic only.
// Hostnames, roots/path selection, current validation time, masks, dynamic
// CertificateVerify and work targets remain checked for every proof.
struct MobileCachedChain {
    mutable CertificateChain chain; // Provider lazily caches public-key arithmetic.
    std::vector<unsigned char> message;
    std::array<std::pair<int64_t,int64_t>,MAX_P2C_CERTIFICATES> times{};
    size_t count{};
    bool dates_valid{true}, usage_valid{};
};
struct MobileVerifierCache {
    std::unique_ptr<MobileCachedChain> chain;
    struct Signature { std::vector<unsigned char> child, parent; };
    std::deque<Signature> signatures;
    size_t signature_bytes{};
#ifdef CONNECTWALLET_NATIVE_TESTS
    size_t parse_hits{},parse_misses{},time_checks{},signature_hits{};
#endif
};
MobileVerifierCache* MobileCaches(bool release=false) {
#ifdef _WIN32
    // Match the existing root lease; avoid MinGW TLS-destructor teardown races.
    static thread_local MobileVerifierCache* cache=nullptr;
    if(release) { delete cache; cache=nullptr; return nullptr; }
    if(!cache) cache=new MobileVerifierCache;
    return cache;
#else
    (void)release;
    static thread_local MobileVerifierCache cache;
    return &cache;
#endif
}
const MobileCachedChain* MobileCertificates(const P2CTlsProofView& proof,std::string& error) {
    auto& cache=*MobileCaches();
    if(cache.chain && std::ranges::equal(cache.chain->message,proof.certificate)) {
        // Also bind the spans if an internal test constructs a view manually;
        // the public mobile API always parses these from its own proof bytes.
        const auto* certificate=&cache.chain->chain.value;
        bool matches=true;
        for(const auto der:proof.certificate_chain) {
            if(!certificate || !std::ranges::equal(der,std::span<const unsigned char>{certificate->raw.p,certificate->raw.len})) { matches=false; break; }
            certificate=certificate->next;
        }
        if(matches && !certificate) {
#ifdef CONNECTWALLET_NATIVE_TESTS
            ++cache.parse_hits;
#endif
            return cache.chain.get();
        }
    }
#ifdef CONNECTWALLET_NATIVE_TESTS
    ++cache.parse_misses;
#endif
    auto candidate=std::make_unique<MobileCachedChain>();
    if(!ParseCertificateChain(proof,candidate->chain,error) ||
       !CheckP2CCertificatePublicKeys(candidate->chain.value,error)) return nullptr;
    const auto& leaf=candidate->chain.value;
    candidate->usage_valid=mbedtls_x509_crt_check_key_usage(&leaf,MBEDTLS_X509_KU_DIGITAL_SIGNATURE)==0 &&
        mbedtls_x509_crt_check_extended_key_usage(&leaf,MBEDTLS_OID_SERVER_AUTH,MBEDTLS_OID_SIZE(MBEDTLS_OID_SERVER_AUTH))==0;
    for(auto* certificate=&leaf;certificate;certificate=certificate->next) {
        if(candidate->count==candidate->times.size()) { SetError(error,"too many P2C certificates"); return nullptr; }
        auto& [from,to]=candidate->times[candidate->count++];
        bool from_ok=X509TimeToUnix(certificate->valid_from,from),to_ok=X509TimeToUnix(certificate->valid_to,to);
        candidate->dates_valid=candidate->dates_valid && from_ok && to_ok;
    }
    candidate->message.assign(proof.certificate.begin(),proof.certificate.end());
    cache.chain=std::move(candidate);
    return cache.chain.get();
}
bool MobileCheckCertificateTime(const MobileCachedChain& cached,int64_t time,std::string& error) {
#ifdef CONNECTWALLET_NATIVE_TESTS
    ++MobileCaches()->time_checks;
#endif
    if(time<=0) return SetError(error,"P2C certificate validation time is unavailable");
    if(!cached.dates_valid) return SetError(error,"P2C certificate is not valid at block median time");
    for(size_t i=0;i<cached.count;++i) {
        if(time<cached.times[i].first || time>cached.times[i].second)
            return SetError(error,"P2C certificate is not valid at block median time");
    }
    if(!cached.usage_valid) return SetError(error,"P2C leaf certificate is not authorized for TLS server signatures");
    return true;
}
int MobileSignatureLookup(void*,const mbedtls_x509_crt* child,const mbedtls_x509_crt* parent) noexcept {
    try {
        const std::span<const unsigned char> child_der{child->raw.p,child->raw.len},parent_der{parent->raw.p,parent->raw.len};
        const bool hit=std::ranges::any_of(MobileCaches()->signatures,[&](const auto& entry) {
            return std::ranges::equal(entry.child,child_der) && std::ranges::equal(entry.parent,parent_der);
        });
#ifdef CONNECTWALLET_NATIVE_TESTS
        if(hit) ++MobileCaches()->signature_hits;
#endif
        return hit?1:0;
    } catch(...) { return 0; }
}
void MobileSignatureRemember(void*,const mbedtls_x509_crt* child,const mbedtls_x509_crt* parent) noexcept {
    if(!child->raw.len || !parent->raw.len || child->raw.len>MAX_P2C_CERTIFICATE_SIZE || parent->raw.len>MAX_P2C_CERTIFICATE_SIZE) return;
    const size_t size=child->raw.len+parent->raw.len;
    try {
        auto& cache=*MobileCaches();
        while(!cache.signatures.empty() && (cache.signatures.size()>=8 || cache.signature_bytes+size>65536)) {
            cache.signature_bytes-=cache.signatures.front().child.size()+cache.signatures.front().parent.size();
            cache.signatures.pop_front();
        }
        MobileVerifierCache::Signature entry{{child->raw.p,child->raw.p+child->raw.len},{parent->raw.p,parent->raw.p+parent->raw.len}};
        cache.signatures.push_back(std::move(entry)); cache.signature_bytes+=size;
    } catch(...) { /* Cache allocation failure never changes verification. */ }
}
