// Copyright (c) 2026 The ConnectCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or https://opensource.org/license/mit/.

#ifndef CONNECTCOIN_CONSENSUS_P2C_X509_MUTEX_H
#define CONNECTCOIN_CONSENSUS_P2C_X509_MUTEX_H

#include <atomic>
#include <mutex>
#include <version>

namespace consensus::p2c {

/** BasicLockable fallback for the bare-metal libstdc++ build without gthreads.
 * atomic_flag is always lock-free and requires no OS threading runtime. Keep
 * mutual exclusion even on this backend; hosted builds use a blocking mutex.
 */
class RootKeyCacheSpinMutex
{
    std::atomic_flag m_locked{};

public:
    void lock() noexcept
    {
        while (m_locked.test_and_set(std::memory_order_acquire)) {}
    }
    void unlock() noexcept { m_locked.clear(std::memory_order_release); }
};

#if defined(__GLIBCXX__) && !defined(_GLIBCXX_HAS_GTHREADS)
using RootKeyCacheMutex = RootKeyCacheSpinMutex;
#else
using RootKeyCacheMutex = std::mutex;
#endif

} // namespace consensus::p2c

#endif // CONNECTCOIN_CONSENSUS_P2C_X509_MUTEX_H
