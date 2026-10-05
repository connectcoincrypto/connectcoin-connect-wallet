#include <jni.h>
#include <public_claims.h>
#include <stdexcept>
#include <string>
#include <string_view>
namespace {
std::string Text(JNIEnv* env,jstring value,size_t maximum) {
    if(!value || env->GetStringUTFLength(value)>static_cast<jsize>(maximum)) throw std::runtime_error("CLAIM_CONTEXT");
    const char* bytes=env->GetStringUTFChars(value,nullptr);
    if(!bytes) throw std::runtime_error("CLAIM_MEMORY");
    try { std::string result(bytes); env->ReleaseStringUTFChars(value,bytes); return result; }
    catch(...) { env->ReleaseStringUTFChars(value,bytes); throw; }
}
void Error(JNIEnv* env,const char* code) {
    if(env->ExceptionCheck()) return;
    // Never return implementation/path/OS exception strings to the renderer.
    bool known=false;
    for(auto allowed:{"CLAIM_CONTEXT","CLAIM_MEMORY","CLAIM_CANCELLED","CLAIM_TIMEOUT","CLAIM_BUSY","CLAIM_NETWORK","CLAIM_DNS","CLAIM_TLS","CLAIM_CERTIFICATE","CLAIM_CRYPTO","CLAIM_NATIVE"}) {
        if(std::string_view(code)==allowed) { known=true; break; }
    }
    if(!known) code="CLAIM_NATIVE";
    jclass kind=env->FindClass("java/lang/IllegalStateException");
    if(kind) { env->ThrowNew(kind,code); env->DeleteLocalRef(kind); }
}
}
extern "C" JNIEXPORT jlong JNICALL Java_com_connectcoincrypto_connectwallet_mobile_alpha_NativeClaims_nativeCreate(JNIEnv* env,jclass) {
    try { return connectwallet::CreateCancellation(); } catch(const std::runtime_error& error) { Error(env,error.what()); } catch(...) { Error(env,"CLAIM_NATIVE"); } return 0;
}
extern "C" JNIEXPORT void JNICALL Java_com_connectcoincrypto_connectwallet_mobile_alpha_NativeClaims_nativeCancel(JNIEnv* env,jclass,jlong handle) { try { connectwallet::Cancel(handle); } catch(...) { Error(env,"CLAIM_NATIVE"); } }
extern "C" JNIEXPORT void JNICALL Java_com_connectcoincrypto_connectwallet_mobile_alpha_NativeClaims_nativeDestroy(JNIEnv* env,jclass,jlong handle) { try { connectwallet::DestroyCancellation(handle); } catch(...) { Error(env,"CLAIM_NATIVE"); } }
extern "C" JNIEXPORT jstring JNICALL Java_com_connectcoincrypto_connectwallet_mobile_alpha_NativeClaims_nativeCapture(JNIEnv* env,jclass,jstring domain,jstring challenge,jstring target,jint roots,jint mask,jlong time,jint timeout,jlong handle) {
    try {
        connectwallet::PublicClaimContext context{Text(env,domain,253),Text(env,challenge,64),Text(env,target,64),roots,mask,time};
        auto result=connectwallet::CaptureAndVerify(context,timeout,handle);
        std::string json="{\"proof\":\""+result.proof_hex+"\",\"validProof\":"+(result.valid_proof?"true":"false")+",\"meetsTarget\":"+(result.meets_target?"true":"false")+",\"durationMs\":"+std::to_string(result.duration_ms)+",\"errorCode\":\""+result.error_code+"\"}";
        return env->NewStringUTF(json.c_str());
    } catch(const std::runtime_error& error) { Error(env,error.what()); } catch(...) { Error(env,"CLAIM_NATIVE"); }
    return nullptr;
}
