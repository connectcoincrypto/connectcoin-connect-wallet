#pragma once
#include <uint256.h>
#include <algorithm>
inline uint256 UintToArith256(const uint256& value) {
    uint256 big_endian{};
    std::reverse_copy(value.begin(), value.end(), big_endian.begin());
    return big_endian;
}
