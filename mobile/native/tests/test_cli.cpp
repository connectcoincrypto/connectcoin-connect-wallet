// Offline oracle bridge. Built only for host tests; never packaged into Android.
#include <public_claims.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <thread>
#include <chrono>
using namespace connectwallet;
std::vector<unsigned char> Read(const char* path,size_t limit) {
    std::ifstream file(path,std::ios::binary);
    if(!file) throw std::runtime_error("TEST_FILE");
    std::vector<unsigned char> result;
    for(char value;file.get(value);) { if(result.size()>=limit) throw std::runtime_error("TEST_SIZE"); result.push_back(static_cast<unsigned char>(value)); }
    return result;
}
int main(int argc,char** argv) {
    try {
        if(argc<9 || argc>11) throw std::runtime_error("TEST_ARGUMENTS");
        PublicClaimContext context{argv[2],argv[3],argv[4],1,std::stoi(argv[5]),std::stoll(argv[6])};
        auto roots=Read(argv[7],1024*1024);
        ClaimResult result;
        if(std::string(argv[1])=="verify") {
            result=VerifyProofForTest(context,Read(argv[8],65536),roots);
        } else if(std::string(argv[1])=="capture") {
            int port=std::stoi(argv[8]); if(port<1 || port>65535) throw std::runtime_error("TEST_PORT");
            auto handle=CreateCancellation();
            std::thread canceller;
            if(argc==11) canceller=std::thread([handle,delay=std::stoi(argv[10])] { std::this_thread::sleep_for(std::chrono::milliseconds(delay)); Cancel(handle); });
            try { result=CaptureLoopbackForTest(context,argc>=10?std::stoi(argv[9]):5000,handle,static_cast<uint16_t>(port),roots); }
            catch(...) { DestroyCancellation(handle); if(canceller.joinable()) canceller.join(); throw; }
            DestroyCancellation(handle); if(canceller.joinable()) canceller.join();
        } else throw std::runtime_error("TEST_MODE");
        std::cout<<"{\"validProof\":"<<(result.valid_proof?"true":"false")<<",\"meetsTarget\":"<<(result.meets_target?"true":"false")<<",\"durationMs\":"<<result.duration_ms<<",\"proof\":\""<<result.proof_hex<<"\",\"errorCode\":\""<<result.error_code<<"\"}\n";
        return 0;
    } catch(const std::exception& error) { std::cerr<<error.what()<<'\n'; return 1; }
}
