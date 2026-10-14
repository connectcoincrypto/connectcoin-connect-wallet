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
    struct Entry { std::shared_ptr<MobileCachedChain> chain; size_t bytes{},estimated_bytes{}; };
    static constexpr size_t MAX_ENTRIES=4,MAX_BYTES=65536,MAX_ESTIMATED_BYTES=262144;
    static_assert(MBEDTLS_ECP_WINDOW_SIZE<=7 && MBEDTLS_ECP_MAX_BITS<=521,
        "Review parsed public-key cache reserve after changing EC limits");
    std::array<Entry,MAX_ENTRIES> chains;
    size_t count{},bytes{},estimated_bytes{};
    struct Signature { std::vector<unsigned char> child, parent; };
    std::deque<Signature> signatures;
    size_t signature_bytes{};
#ifdef CONNECTWALLET_NATIVE_TESTS
    size_t parse_hits{},parse_misses{},time_checks{},signature_hits{};
#endif
    void Remember(const std::shared_ptr<MobileCachedChain>& chain) {
        size_t der_bytes{},structural_bytes{};
        const auto nodes=[](const auto* node) {
            size_t size{}; for(;node;node=node->next) size+=sizeof(*node)+64; return size;
        };
        for(const auto* cert=&chain->chain.value;cert;cert=cert->next) {
            der_bytes+=cert->raw.len;
            structural_bytes+=sizeof(*cert)+64+nodes(&cert->issuer)+nodes(&cert->subject)+
                nodes(&cert->subject_alt_names)+nodes(&cert->ext_key_usage)+
                nodes(&cert->certificate_policies)+nodes(&cert->authority_key_id.authorityCertIssuer);
            // Conservative charge including future RSA/EC public arithmetic
            // caches; not a measurement of allocator RSS. Pinned provider only.
            structural_bytes+=32768+32*mbedtls_pk_get_len(&cert->pk);
        }
        Entry candidate{chain,chain->message.capacity()+der_bytes};
        candidate.estimated_bytes=candidate.bytes+structural_bytes+sizeof(Entry)+sizeof(MobileCachedChain)+128;
        if(candidate.bytes>MAX_BYTES || candidate.estimated_bytes>MAX_ESTIMATED_BYTES) return;
        // Construction and admission finish before any eviction; malformed or
        // oversized inputs leave existing entries intact. The caller owns even
        // uncached chains, and its reference remains valid across eviction.
        while(count && (count==MAX_ENTRIES || bytes+candidate.bytes>MAX_BYTES ||
                estimated_bytes+candidate.estimated_bytes>MAX_ESTIMATED_BYTES)) {
            bytes-=chains[0].bytes; estimated_bytes-=chains[0].estimated_bytes;
            for(size_t i=1;i<count;++i) chains[i-1]=std::move(chains[i]);
            chains[--count]=Entry{};
        }
        bytes+=candidate.bytes; estimated_bytes+=candidate.estimated_bytes;
        chains[count++]=std::move(candidate);
    }
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
std::shared_ptr<const MobileCachedChain> MobileCertificates(const P2CTlsProofView& proof,std::string& error) {
    auto& cache=*MobileCaches();
    for(size_t index=0;index<cache.count;++index) {
        const auto& cached=cache.chains[index].chain;
        if(!std::ranges::equal(cached->message,proof.certificate)) continue;
        // Also bind the spans if an internal test constructs a view manually;
        // the public mobile API always parses these from its own proof bytes.
        const auto* certificate=&cached->chain.value;
        bool matches=true;
        for(const auto der:proof.certificate_chain) {
            if(!certificate || !std::ranges::equal(der,std::span<const unsigned char>{certificate->raw.p,certificate->raw.len})) { matches=false; break; }
            certificate=certificate->next;
        }
        if(matches && !certificate) {
#ifdef CONNECTWALLET_NATIVE_TESTS
            ++cache.parse_hits;
#endif
            auto hit=std::move(cache.chains[index]);
            for(size_t i=index+1;i<cache.count;++i) cache.chains[i-1]=std::move(cache.chains[i]);
            cache.chains[cache.count-1]=std::move(hit);
            return cache.chains[cache.count-1].chain;
        }
    }
#ifdef CONNECTWALLET_NATIVE_TESTS
    ++cache.parse_misses;
#endif
    auto candidate=std::make_shared<MobileCachedChain>();
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
    cache.Remember(candidate);
    return candidate;
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
#ifdef CONNECTWALLET_NATIVE_TESTS
void MobileCheckLru(const P2CTlsProofView& fixture) {
    auto& cache=*MobileCaches();
    struct Restore { MobileVerifierCache& target; MobileVerifierCache saved; ~Restore(){ target=std::move(saved); } } restore{cache,std::move(cache)};
    cache=MobileVerifierCache{};
    const auto require=[](bool value) { if(!value) throw std::runtime_error("TEST_CERTIFICATE_LRU"); };
    // Cache-mechanics test: exact message keys deliberately vary independently
    // of the same real DER fixture. Production callers always parse the view
    // from the canonical proof first; this is not an authentication shortcut.
    std::array<std::vector<unsigned char>,5> keys;
    std::array<std::shared_ptr<const MobileCachedChain>,5> held;
    for(size_t i=0;i<keys.size();++i) {
        keys[i].assign(fixture.certificate.begin(),fixture.certificate.end()); keys[i].push_back(static_cast<unsigned char>(i));
    }
    const auto load=[&](size_t i) {
        auto view=fixture; view.certificate=keys[i]; std::string error;
        auto result=MobileCertificates(view,error); require(result!=nullptr); return result;
    };
    // One-cert fixtures exercise the entry ceiling independently of the byte
    // ceiling (large fixture chains may correctly retain fewer entries).
    if(fixture.certificate_chain.size()==1) {
        for(size_t i=0;i<4;++i) held[i]=load(i);
        require(cache.count==4);
        const auto misses=cache.parse_misses;
        require(load(0)==held[0] && load(2)==held[2] && cache.parse_misses==misses);
        held[4]=load(4); // LRU is now 1, not 0 or 2.
        require(cache.count==4 && load(0)==held[0] && load(2)==held[2]);
        require(load(1)!=held[1]);
        require(held[1]->chain.value.raw.len==fixture.certificate_chain[0].size());
        require(std::ranges::equal(held[1]->message,keys[1])); // Eviction cannot invalidate a borrower.
    }
    const auto count=cache.count,bytes=cache.bytes,estimated=cache.estimated_bytes;
    auto oversized=fixture;
    std::vector<unsigned char> large(65537,17); oversized.certificate=large;
    std::string error;
    const auto uncached=MobileCertificates(oversized,error);
    require(uncached && cache.count==count && cache.bytes==bytes && cache.estimated_bytes==estimated);
    // Eight parsed keys exceed the conservative public-key allocation budget,
    // even with tiny wire/DER. No entry is evicted to try an impossible fit.
    oversized.certificate=keys[4]; oversized.certificate_chain.assign(8,fixture.certificate_chain[0]);
    require(MobileCertificates(oversized,error)!=nullptr && cache.count==count && cache.bytes==bytes && cache.estimated_bytes==estimated);
    auto invalid=fixture;
    const std::array<unsigned char,1> bad{0}; invalid.certificate=bad; invalid.certificate_chain={bad};
    require(!MobileCertificates(invalid,error) && cache.count==count && cache.bytes==bytes && cache.estimated_bytes==estimated);
    require(cache.bytes<=MobileVerifierCache::MAX_BYTES && cache.estimated_bytes<=MobileVerifierCache::MAX_ESTIMATED_BYTES);
    cache=MobileVerifierCache{};
    // Aggregate byte retention, not only an individually oversized entry.
    for(size_t i=0;i<4;++i) {
        keys[i].resize(24000,static_cast<unsigned char>(i));
        auto view=fixture; view.certificate=keys[i]; view.certificate_chain={fixture.certificate_chain[0]};
        require(MobileCertificates(view,error)!=nullptr);
        require(cache.bytes<=MobileVerifierCache::MAX_BYTES && cache.estimated_bytes<=MobileVerifierCache::MAX_ESTIMATED_BYTES);
    }
    require(cache.count==2);
    cache=MobileVerifierCache{};
    // Three ordinary public keys per entry fill the estimated-allocation
    // budget before either four entries or the wire/DER byte budget.
    for(size_t i=0;i<4;++i) {
        keys[i].resize(fixture.certificate.size()+1);
        auto view=fixture; view.certificate=keys[i]; view.certificate_chain.assign(3,fixture.certificate_chain[0]);
        require(MobileCertificates(view,error)!=nullptr);
        require(cache.bytes<=MobileVerifierCache::MAX_BYTES && cache.estimated_bytes<=MobileVerifierCache::MAX_ESTIMATED_BYTES);
    }
    require(cache.count>0 && cache.count<4);
}
#endif
