// Included in the native implementation only in host-test builds. No secret,
// alternate trust input or diagnostic API is included in a mobile binary.
namespace {
void PreparedExpect(bool condition,const char* error) { if(!condition) Fail(error); }
}
void CheckNativePreparedContextForTest() {
    PublicClaimContext context{"example.com",std::string(64,'0'),std::string(64,'f'),1,7,1700000000};
    context.challenge_hex.back()='1'; context.target_hex.front()='1';
    const auto initial=Prepare(context);
    const auto before=NativeWorkStatsForTest();
    const auto again=Prepare(context);
    auto current=NativeWorkStatsForTest();
    PreparedExpect(initial==again && current.context_hits==before.context_hits+1 &&
        current.context_builds==before.context_builds && current.context_hex_decodes==before.context_hex_decodes &&
        current.time_checks==before.time_checks+1,"TEST_PREPARED_CACHE_HIT");
    PreparedExpect(initial->challenge[31]==1 && initial->target[31]==0x1f && initial->target[0]==0xff &&
        initial->signatures==std::array<uint16_t,4>{0x0403,0x0804,0x0809,0},"TEST_PREPARED_VALUES");
    auto next=context; ++next.validation_time;
    PreparedExpect(Prepare(next)==initial,"TEST_PREPARED_TIME_IS_NOT_STATIC");
    auto probe=context; probe.challenge_hex[0]='a';
    const auto one_shot=Prepare(probe,false);
    PreparedExpect(one_shot!=initial && one_shot->Matches(probe) && Prepare(context)==initial,
        "TEST_PREPARED_PROBE_NOT_CACHED");
    for(auto timestamp:{int64_t{0},int64_t{-1},int64_t{253402300800LL}}) {
        next=context; next.validation_time=timestamp;
        bool rejected=false;
        try { Prepare(next); } catch(const std::runtime_error& error) { rejected=std::string_view(error.what())=="CLAIM_CONTEXT"; }
        PreparedExpect(rejected,"TEST_PREPARED_TIME_BOUNDS");
    }
    for(int field=0;field<4;++field) {
        next=context;
        if(field==0) next.domain="other.example.com";
        if(field==1) next.challenge_hex[0]='1';
        if(field==2) next.target_hex[0]='0';
        if(field==3) next.signature_mask=2;
        const auto stats=NativeWorkStatsForTest();
        const auto replaced=Prepare(next);
        const auto updated=NativeWorkStatsForTest();
        PreparedExpect(replaced!=initial && replaced->Matches(next) && !replaced->Matches(context) &&
            updated.context_builds==stats.context_builds+1 && updated.context_hex_decodes==stats.context_hex_decodes+2,
            "TEST_PREPARED_STATIC_CHANGE");
        if(field==3) PreparedExpect(replaced->signatures==std::array<uint16_t,4>{0x0804,0,0,0},"TEST_PREPARED_MASK_LIST");
        // A retained capture reference is immutable after cache replacement.
        PreparedExpect(initial->Matches(context) && initial->challenge[31]==1,"TEST_PREPARED_OWNERSHIP");
    }
    for(int field=0;field<10;++field) {
        next=context;
        if(field==0) next.roots_version=2;
        if(field==1) next.signature_mask=8;
        if(field==2) next.signature_mask=0;
        if(field==3) next.domain="EXAMPLE.COM";
        if(field==4) next.domain="127.0.0.1";
        if(field==5) next.challenge_hex[0]='A';
        if(field==6) next.challenge_hex[0]='z';
        if(field==7) next.target_hex[0]='z';
        if(field==8) next.challenge_hex.pop_back();
        if(field==9) next.target_hex+='0';
        const auto valid=Prepare(context);
        bool rejected=false;
        try { Prepare(next); } catch(const std::runtime_error& error) { rejected=std::string_view(error.what())=="CLAIM_CONTEXT"; }
        PreparedExpect(rejected && Prepare(context)==valid,"TEST_PREPARED_INVALID_DOES_NOT_POISON_CACHE");
    }
}
ClaimResult CheckPreparedVerificationForTest(const PublicClaimContext& context,std::span<const unsigned char> proof,std::span<const unsigned char> roots) {
    // Require a winning fixture, then re-use one thread so cached stale fields
    // or a cached validation verdict cannot hide behind separate CLI processes.
    const auto first=VerifyProofForTest(context,proof,roots);
    PreparedExpect(first.valid_proof && first.meets_target && first.proof_hex==EncodeHex(proof),"TEST_PREPARED_FIXTURE");
    const auto before=NativeWorkStatsForTest();
    const auto repeated=VerifyProofForTest(context,proof,roots);
    const auto after=NativeWorkStatsForTest();
    PreparedExpect(repeated.proof_hex==first.proof_hex && after.context_hits==before.context_hits+1 &&
        after.context_builds==before.context_builds && after.context_hex_decodes==before.context_hex_decodes &&
        after.time_checks==before.time_checks+1 && after.proof_serializations==before.proof_serializations+1,
        "TEST_PREPARED_VERIFY_REUSE");
    auto missed=context; missed.target_hex=std::string(64,'0');
    const auto miss=VerifyProofForTest(missed,proof,roots);
    PreparedExpect(miss.valid_proof && miss.validation_passed && !miss.meets_target && miss.proof_hex.empty() &&
        NativeWorkStatsForTest().proof_serializations==after.proof_serializations,"TEST_PREPARED_NO_MISS_SERIALIZATION");
    for(int field=0;field<4;++field) {
        auto changed=context;
        if(field==0) changed.domain="different.example.com";
        if(field==1) changed.challenge_hex[0]=changed.challenge_hex[0]=='0'?'1':'0';
        if(field==2) changed.signature_mask=context.signature_mask==1?2:1;
        if(field==3) changed.validation_time=1;
        const auto result=VerifyProofForTest(changed,proof,roots);
        PreparedExpect(!result.valid_proof && !result.validation_passed && !result.meets_target && result.proof_hex.empty(),
            "TEST_PREPARED_CHANGED_CONTEXT_REJECTED");
        PreparedExpect(VerifyProofForTest(context,proof,roots).valid_proof,"TEST_PREPARED_VALID_RESTORED");
    }
    auto invalid=std::vector<unsigned char>(proof.begin(),proof.end()); invalid.back()^=1;
    const auto serialized=NativeWorkStatsForTest().proof_serializations;
    PreparedExpect(!VerifyProofForTest(context,invalid,roots).valid_proof &&
        NativeWorkStatsForTest().proof_serializations==serialized,"TEST_PREPARED_INVALID_NOT_SERIALIZED");
    PreparedExpect(!VerifyProof(context,proof).valid_proof,"TEST_PREPARED_ROOTS_NOT_REUSED");
    // Advisory probes deliberately return no proof, including on success.
    const auto probe=VerifyPrepared(*Prepare(context),context.validation_time,proof,roots,nullptr,false);
    PreparedExpect(probe.valid_proof && probe.meets_target && probe.proof_hex.empty() &&
        NativeWorkStatsForTest().proof_serializations==serialized,"TEST_PREPARED_PROBE_NOT_SERIALIZED");
    return VerifyProofForTest(context,proof,roots);
}
