#include <public_claims.h>
#include <consensus/p2c.h>
#include <consensus/p2c_x509.h>
#include <hash.h>
#include <primitives/transaction.h>
#include <iostream>
#include <stdexcept>
using namespace connectwallet;
void Expect(bool value,const char* message) { if(!value) throw std::runtime_error(message); }
int main() {
    try {
        Expect(P2CRootStoreAvailable(),"Pinned roots parse and RSA exponent checks");
        for(auto value:{"127.0.0.1","10.1.2.3","169.254.169.254","100.64.0.1","192.168.0.1","198.18.0.1","224.0.0.1","::1","::ffff:127.0.0.1","64:ff9b::7f00:1","fe80::1","fc00::1","2001:db8::1","2002:7f00:1::1"}) Expect(!IsPublicAddress(value),"Special endpoint rejected");
        Expect(IsPublicAddress("8.8.8.8") && IsPublicAddress("2606:4700:4700::1111"),"Public numeric classification");
        uint256 hash{}; CSHA256().Write(reinterpret_cast<const unsigned char*>("abc"),3).Finalize(hash.data());
        Expect(EncodeHex(hash)=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","SHA256 adapter vector");
        uint256 zero{}, one{}; one[0]=1; Expect(P2CMeetsWorkTarget(one,one) && !P2CMeetsWorkTarget(one,zero),"Little endian target including equality");
        PublicClaimContext context{"example.com",std::string(64,'0'),std::string(64,'f'),1,7,1700000000};
        Expect(!VerifyProof(context,{}).valid_proof,"Malformed proof rejected");
        auto handle=CreateCancellation(); Cancel(handle);
        try { CaptureAndVerify(context,100,handle); Expect(false,"Cancelled capture must not resolve/connect"); } catch(const std::runtime_error& error) { Expect(std::string(error.what())=="CLAIM_CANCELLED","Cancellation code"); }
        DestroyCancellation(handle);
        try { CaptureAndVerify(context,100,handle); Expect(false,"Destroyed handle rejected"); } catch(const std::runtime_error& error) { Expect(std::string(error.what())=="CLAIM_CANCELLED","Destroyed handle code"); }
        std::vector<int64_t> handles; for(int i=0;i<32;++i) handles.push_back(CreateCancellation());
        try { CreateCancellation(); Expect(false,"Handle limit"); } catch(const std::runtime_error& error) { Expect(std::string(error.what())=="CLAIM_BUSY","Bounded handles"); }
        for(auto value:handles) DestroyCancellation(value);
        std::cout<<"Offline public P2C smoke passed\n"; return 0;
    } catch(const std::exception& error) { std::cerr<<error.what()<<'\n'; return 1; }
}
