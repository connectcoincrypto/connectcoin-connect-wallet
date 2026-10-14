// Minimal public-byte adapter, not a node or private-key implementation.
#pragma once
#include <array>
#include <cstdint>
// Core's begin()/end() are raw byte pointers; std::array's MSVC iterators are
// not convertible to the C provider's pointer arguments, even in Release.
struct uint256 : std::array<unsigned char, 32> {
    unsigned char* begin() noexcept { return data(); }
    unsigned char* end() noexcept { return data()+size(); }
    const unsigned char* begin() const noexcept { return data(); }
    const unsigned char* end() const noexcept { return data()+size(); }
};
