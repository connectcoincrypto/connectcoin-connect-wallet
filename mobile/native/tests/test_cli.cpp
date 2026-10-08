// Offline oracle bridge. Built only for host tests; never packaged into Android.
#include <public_claims.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <thread>
#include <chrono>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <set>
#include <algorithm>
using namespace connectwallet;
#include "parallel_verification.inc"
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
        } else if(std::string(argv[1])=="verify-parallel") {
            result=VerifyParallel(context,Read(argv[8],65536),roots);
        } else if(std::string(argv[1])=="capture-parallel") {
            int port=std::stoi(argv[8]); if(port<1 || port>65535) throw std::runtime_error("TEST_PORT");
            result=CaptureParallel(context,roots,static_cast<uint16_t>(port),argc>=10?std::stoi(argv[9]):5000,argc==11?std::stoi(argv[10]):8);
        } else if(std::string(argv[1])=="probe") {
            int port=std::stoi(argv[8]); if(port<1 || port>65535) throw std::runtime_error("TEST_PORT");
            auto handle=CreateCancellation(); std::thread canceller;
            if(argc==11) canceller=std::thread([handle,delay=std::stoi(argv[10])] { std::this_thread::sleep_for(std::chrono::milliseconds(delay)); Cancel(handle); });
            std::string status;
            try { status=ProbeRsaLoopbackForTest(context.domain,context.validation_time,argc>=10?std::stoi(argv[9]):3000,handle,static_cast<uint16_t>(port),roots); }
            catch(...) { DestroyCancellation(handle); if(canceller.joinable()) canceller.join(); throw; }
            DestroyCancellation(handle); if(canceller.joinable()) canceller.join();
            std::cout<<status<<'\n'; return 0;
        } else if(std::string(argv[1])=="capture") {
            int port=std::stoi(argv[8]); if(port<1 || port>65535) throw std::runtime_error("TEST_PORT");
            auto handle=CreateCancellation();
            if(HasStarted(handle)) throw std::runtime_error("TEST_UNSTARTED_HANDLE");
            std::thread canceller;
            if(argc==11) canceller=std::thread([handle,delay=std::stoi(argv[10])] { std::this_thread::sleep_for(std::chrono::milliseconds(delay)); Cancel(handle); });
            try { result=CaptureLoopbackForTest(context,argc>=10?std::stoi(argv[9]):5000,handle,static_cast<uint16_t>(port),roots); }
            catch(...) { DestroyCancellation(handle); if(canceller.joinable()) canceller.join(); throw; }
            bool started=HasStarted(handle);
            DestroyCancellation(handle); if(canceller.joinable()) canceller.join();
            if(!started || HasStarted(handle)) throw std::runtime_error("TEST_TCP_START_ACK");
        } else throw std::runtime_error("TEST_MODE");
        std::cout<<"{\"captured\":"<<(result.captured?"true":"false")<<",\"validationPassed\":"<<(result.validation_passed?"true":"false")<<",\"validProof\":"<<(result.valid_proof?"true":"false")<<",\"meetsTarget\":"<<(result.meets_target?"true":"false")<<",\"durationMs\":"<<result.duration_ms<<",\"proof\":\""<<result.proof_hex<<"\",\"errorCode\":\""<<result.error_code<<"\"}\n";
        return 0;
    } catch(const std::exception& error) { std::cerr<<error.what()<<'\n'; return 1; }
}
