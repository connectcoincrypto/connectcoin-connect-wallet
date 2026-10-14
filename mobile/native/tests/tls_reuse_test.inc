// Included only by host-test builds: inspect no production secrets externally.
namespace {
void TlsExpect(bool value,const char* message) { if(!value) Fail(message); }
void CheckIdleTls() {
    const auto& tls=ThreadTls();
    TlsExpect(!tls.in_use && tls.config.p_rng==nullptr && tls.config.f_rng==nullptr &&
        std::ranges::all_of(tls.signatures,[](auto value){ return value==0; }) &&
        connectcoin_p2c_test_tls_reset_clean(&tls.ssl),"TEST_TLS_IDLE_NOT_CLEAN");
}
void CheckWindowsTlsLeaseCleanup() {
#ifdef _WIN32
    TlsExpect(ThreadTlsStorage()==nullptr,"TEST_TLS_LEASE_NOT_EMPTY");
    for(const bool unwind:{false,true}) {
        try {
            RootStoreScope scope;
            uint256 challenge{};
            { Connection connection(challenge,BAD_SOCKET); connection.Configure("example.com",{0x0403,0,0,0}); }
            TlsExpect(ThreadTlsStorage()!=nullptr,"TEST_TLS_LEASE_FREED_EARLY");
            if(unwind) Fail("TEST_TLS_LEASE_UNWIND");
        } catch(const std::runtime_error& error) {
            if(!unwind || std::string_view(error.what())!="TEST_TLS_LEASE_UNWIND") throw;
        }
        TlsExpect(ThreadTlsStorage()==nullptr,"TEST_TLS_LEASE_NOT_RELEASED");
    }
#endif
}
}
void CheckNativeTlsReuseForTest() {
    InitializeCrypto();
    CheckWindowsTlsLeaseCleanup();
    RootStoreScope scope; // Keep the tested worker alive across nested calls.
    auto& tls=ThreadTls();
    const auto before=tls.setups;
    uint256 challenge{}; challenge[0]=17;
    std::vector<unsigned char> previous;
    const void* buffers=nullptr;
    for(int iteration=0;iteration<8;++iteration) {
        std::vector<unsigned char> hello;
        {
            Connection connection(challenge,BAD_SOCKET);
            const std::array<uint16_t,4> signatures=iteration%2?std::array<uint16_t,4>{0x0804,0,0,0}:std::array<uint16_t,4>{0x0403,0x0804,0x0809,0};
            const std::string domain=iteration%2?"other.example.com":"example.com";
            connection.Configure(domain,signatures);
            TlsExpect(tls.config.sig_algs==tls.signatures.data() && tls.signatures==signatures &&
                std::string(connection.ssl.hostname)==domain,"TEST_TLS_CONFIG_STALE");
            if(iteration==0) buffers=tls.ssl.in_buf;
            if(iteration>0 && iteration<5) TlsExpect(tls.ssl.in_buf==buffers,"TEST_TLS_BUFFER_NOT_REUSED");
            mbedtls_ssl_set_bio(&connection.ssl,&hello,
                [](void* target,const unsigned char* data,size_t size) {
                    auto& out=*static_cast<std::vector<unsigned char>*>(target);
                    out.insert(out.end(),data,data+size); return static_cast<int>(size);
                },[](void*,unsigned char*,size_t) { return MBEDTLS_ERR_SSL_WANT_READ; },nullptr);
            for(int step=0;step<8 && hello.empty();++step) {
                const int result=mbedtls_ssl_handshake_step(&connection.ssl);
                TlsExpect(result==0 || result==MBEDTLS_ERR_SSL_WANT_READ,"TEST_TLS_CLIENT_HELLO");
            }
            TlsExpect(connection.random_set && hello.size()>43 && hello[5]==1 &&
                std::ranges::equal(challenge,std::span<const unsigned char>{hello}.subspan(11,32)),"TEST_TLS_CHALLENGE_BINDING");
            // Same inputs after two captures must still create fresh ECDHE keys.
            if(iteration%2==0) { TlsExpect(previous.empty() || previous!=hello,"TEST_TLS_FRESH_KEYSHARE"); previous=hello; }
            if(iteration==4) tls.fail_next_reset=true; // Exercise conservative discard/re-setup, not an allocator simulation.
        }
        CheckIdleTls();
        if(iteration==4) TlsExpect(!tls.ready && tls.ssl.in_buf==nullptr,"TEST_TLS_RESET_FAILURE_DISCARD");
    }
    TlsExpect(tls.setups==before+2 && tls.discarded==1 && tls.resets==7,"TEST_TLS_SETUP_AMORTIZATION");
    // Exception before setup: detached, freed, and safe for the next capture.
    { Connection connection(challenge,BAD_SOCKET); tls.ready=false; }
    CheckIdleTls();
    { Connection connection(challenge,BAD_SOCKET); connection.Configure("example.com",{0x0403,0,0,0}); }
    CheckIdleTls();
}
ClaimResult CheckTlsCaptureSequenceForTest(const PublicClaimContext& context,uint16_t port,std::span<const unsigned char> roots) {
    InitializeCrypto();
    RootStoreScope scope; // Windows releases only after the whole reuse fixture.
    auto& tls=ThreadTls();
    const auto setups=tls.setups,resets=tls.resets,discards=tls.discarded;
    ClaimResult last;
    for(int iteration=0;iteration<8;++iteration) {
        const auto handle=CreateCancellation();
        if(iteration==2) tls.expire_after_hello=true;
        if(iteration==3) tls.on_client_hello=[handle] { Cancel(handle); };
        if(iteration==5) tls.fail_next_reset=true;
        try {
            if(iteration==4) {
                const auto serialized=NativeWorkStatsForTest().proof_serializations;
                TlsExpect(ProbeRsaLoopbackForTest(context.domain,context.validation_time,3000,handle,port,roots)=="verified",
                    "TEST_TLS_REUSE_PROBE");
                TlsExpect(NativeWorkStatsForTest().proof_serializations==serialized,"TEST_TLS_REUSE_PROBE_SERIALIZED");
            } else {
                last=CaptureLoopbackForTest(context,5000,handle,port,roots);
                if(iteration==1) TlsExpect(!last.valid_proof && last.error_code=="CLAIM_TLS","TEST_TLS_REUSE_BAD_FLIGHT");
                else if(iteration==2) TlsExpect(!last.valid_proof && last.error_code=="CLAIM_TIMEOUT","TEST_TLS_REUSE_TIMEOUT");
                else TlsExpect(iteration!=3 && last.captured && last.validation_passed && last.valid_proof && last.meets_target,"TEST_TLS_REUSE_SUCCESS");
            }
        } catch(const std::runtime_error& error) {
            if(iteration!=3 || std::string_view(error.what())!="CLAIM_CANCELLED") { DestroyCancellation(handle); throw; }
        } catch(...) { DestroyCancellation(handle); throw; }
        TlsExpect(HasStarted(handle),"TEST_TLS_REUSE_STARTED");
        DestroyCancellation(handle);
        CheckIdleTls();
    }
    TlsExpect(tls.setups==setups+2 && tls.resets==resets+7 && tls.discarded==discards+1,"TEST_TLS_REUSE_COUNTS");
    return last;
}
