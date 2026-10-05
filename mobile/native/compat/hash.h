#pragma once
#include <crypto/sha256.h>
#include <uint256.h>
#include <span>
#include <string_view>
class HashWriter {
    CSHA256 hash;
public:
    void write(std::span<const std::byte> bytes) { hash.Write(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size()); }
    HashWriter& operator<<(const uint256& value) { hash.Write(value.data(), value.size()); return *this; }
    HashWriter& operator<<(uint32_t value) { unsigned char bytes[4]; for (int i=0;i<4;++i) bytes[i]=static_cast<unsigned char>(value>>(8*i)); hash.Write(bytes,4); return *this; }
    uint256 GetSHA256() { uint256 result{}; hash.Finalize(result.data()); return result; }
};
inline HashWriter TaggedHash(std::string_view tag) {
    uint256 digest{}; CSHA256().Write(reinterpret_cast<const unsigned char*>(tag.data()), tag.size()).Finalize(digest.data());
    HashWriter result; result << digest << digest; return result;
}
