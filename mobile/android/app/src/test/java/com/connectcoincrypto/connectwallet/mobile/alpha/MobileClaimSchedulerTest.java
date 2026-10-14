package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Test;

/** Golden scheduling cases mirrored from desktop claim-order/scheduler/policy. */
public class MobileClaimSchedulerTest {
    private static final String BLOCK = "00".repeat(32), TXID = "12".repeat(32), TARGET = "ff".repeat(32);
    private static MobileClaimsEngine.Candidate row(String domain, int mask, int vout, long net, int factor) throws Exception {
        JSONObject bounty = new JSONObject().put("txid", TXID).put("vout", vout).put("amount", Long.toString(net + 10)).put("domain", domain)
            .put("connection_work_target", TARGET).put("root_certificates_version", 1).put("signature_algorithms_mask", mask)
            .put("block_hash", BLOCK).put("block_height", 0).put("confirmations", 1).put("coinbase", false).put("status", "available");
        MobileClaimsEngine.Candidate row = new MobileClaimsEngine.Candidate(bounty, BLOCK, 10, factor);
        row.progress.prepared = new JSONObject(); return row;
    }
    private static MobileClaimsEngine.Candidate row(String domain, int mask, int vout, long net) throws Exception { return row(domain, mask, vout, net, 1_000_000); }
    private static MobileClaimsEngine.PerformanceWindow rate(double value) {
        MobileClaimsEngine.PerformanceWindow stats = new MobileClaimsEngine.PerformanceWindow(() -> 0);
        if (value < 5) {
            double duration = 5 / value - 1;
            while (duration > 0) { double sample = Math.min(60, duration); stats.record(false, sample); duration -= sample; }
        } else if (value > 5) {
            int count = (int)Math.ceil(value); double duration = ((5 + count) / value - 1) / count;
            for (int index = 0; index < count; index++) stats.record(true, duration);
        }
        return stats;
    }
    private static void rebuild(MobileClaimScheduler scheduler, List<MobileClaimsEngine.Candidate> rows, Map<String, MobileClaimsEngine.PerformanceWindow> stats, long now) { scheduler.rebuild(rows, stats, new HashSet<>(), now); }

    @Test public void fairAndEconomicTurnsAlternateExactlyLikeDesktop() throws Exception {
        MobileClaimScheduler scheduler = new MobileClaimScheduler();
        rebuild(scheduler, List.of(row("a.example", 7, 0, 600), row("b.example", 7, 1, 200), row("c.example", 7, 2, 200)), new HashMap<>(), 0);
        List<String> actual = new ArrayList<>();
        for (int index = 0; index < 8; index++) { MobileClaimScheduler.Selection selection = scheduler.next(0, true); actual.add(selection.row.domain); assertTrue(scheduler.commit(selection, 0)); }
        assertEquals(List.of("a.example", "a.example", "b.example", "a.example", "c.example", "a.example", "a.example", "a.example"), actual);
    }
    @Test public void peeksAndPreparationDoNotSpendATurnAndCommitIsExactlyOnce() throws Exception {
        MobileClaimsEngine.Candidate a = row("a.example", 7, 0, 600), b = row("b.example", 7, 1, 200); a.progress.prepared = null;
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(a, b), new HashMap<>(), 0);
        assertSame(a, scheduler.next(0, false).row); assertSame(a, scheduler.next(0, false).row);
        assertSame(b, scheduler.next(0, true).row); assertSame(b, scheduler.next(0, true).row);
        a.progress.prepared = new JSONObject(); MobileClaimScheduler.Selection selected = scheduler.next(0, true);
        assertSame(a, selected.row); assertTrue(scheduler.commit(selected, 0)); assertFalse(scheduler.commit(selected, 0));
        assertTrue(scheduler.next(0, true).economic);
    }
    @Test public void preparationSkipsTheWholeUnreadyDomainNotToItsWorseBounty() throws Exception {
        MobileClaimsEngine.Candidate best = row("a.example", 7, 0, 1000), worse = row("a.example", 7, 1, 500), other = row("b.example", 7, 2, 200);
        best.progress.prepared = null;
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(best, worse, other), new HashMap<>(), 0);
        assertSame(best, scheduler.next(0, false).row); assertSame(other, scheduler.next(0, true).row);
        best.progress.prepared = new JSONObject(); assertSame(best, scheduler.next(0, true).row);
        for (int index = 0; index < 100; index++) { MobileClaimScheduler.Selection selection = scheduler.next(0, true); if (selection.row.domain.equals("a.example")) assertSame(best, selection.row); scheduler.commit(selection, 0); }
    }
    @Test public void exactStableRandomFactorBreaksNearTiesButNotLargeDifficultyDifferences() throws Exception {
        MobileClaimsEngine.Candidate boosted = row("a.example", 7, 0, 1000, 1_100_000), near = row("a.example", 7, 1, 1099), larger = row("a.example", 7, 2, 1101);
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(boosted, near), new HashMap<>(), 0);
        assertSame(boosted, scheduler.next(0, true).row);
        rebuild(scheduler, List.of(boosted.copy(), near.copy()), new HashMap<>(), 10);
        assertEquals(boosted.key, scheduler.next(10, true).row.key); assertEquals(1_100_000, boosted.copy().progress.factor);
        rebuild(scheduler, List.of(boosted, larger), new HashMap<>(), 20); assertSame(larger, scheduler.next(20, true).row);
        JSONObject hardData = new JSONObject(boosted.bounty.toString()).put("connection_work_target", "0001" + "ff".repeat(30));
        JSONObject easyData = new JSONObject(near.bounty.toString()).put("amount", "1010").put("connection_work_target", "003f" + "ff".repeat(30));
        MobileClaimsEngine.Candidate hard = new MobileClaimsEngine.Candidate(hardData, BLOCK, 10, 1_100_000), easy = new MobileClaimsEngine.Candidate(easyData, BLOCK, 10, 1_000_000);
        assertTrue(MobileClaimScheduler.compare(easy, hard) < 0);
    }
    @Test public void floorUsesUnboostedRawReturnAndIncludesExactly1000() throws Exception {
        MobileClaimsEngine.Candidate below = row("a.example", 7, 0, 199, 1_100_000), equal = row("b.example", 7, 1, 200);
        assertFalse(MobileClaimScheduler.worth(below.raw, 5)); assertTrue(MobileClaimScheduler.worth(equal.raw, 5));
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(below, equal), new HashMap<>(), 0);
        MobileClaimScheduler.Selection probe = scheduler.next(0, true); assertSame(below, probe.row); assertTrue(probe.recovery);
        scheduler.commit(probe, 0);
        assertSame(equal, scheduler.next(0, true).row); assertFalse(scheduler.next(0, true).recovery); assertEquals(1, scheduler.probeCount());
    }
    @Test public void exactMasksHaveSeparateRatesAndBothTurnsUseTheSameDomainLeader() throws Exception {
        MobileClaimsEngine.Candidate slower = row("a.example", 1, 0, 1000), fast = row("a.example", 2, 1, 300), other = row("b.example", 7, 2, 200);
        Map<String, MobileClaimsEngine.PerformanceWindow> stats = new HashMap<>(); stats.put(slower.policy, rate(1)); stats.put(fast.policy, rate(5));
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(slower, fast, other), stats, 0);
        MobileClaimScheduler.Selection fair = scheduler.next(0, true); assertSame(fast, fair.row); scheduler.commit(fair, 0);
        assertSame(fast, scheduler.next(0, true).row);
        stats.put(slower.policy, rate(10)); rebuild(scheduler, List.of(slower, fast, other), stats, 10); assertSame(slower, scheduler.next(10, true).row);
    }
    @Test public void bootstrapIsThirtyTwoActualStartsThenMinuteRecoveryAcrossRepresentativeChanges() throws Exception {
        MobileClaimsEngine.Candidate first = row("a.example", 7, 0, 200), replacement = row("a.example", 7, 1, 300);
        Map<String, MobileClaimsEngine.PerformanceWindow> stats = new HashMap<>(); stats.put(first.policy, rate(0.01));
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(first), stats, 0);
        MobileClaimScheduler.Selection probe = scheduler.next(0, true); assertTrue(probe.recovery);
        // A catalog refresh replaces the representative while the OLD native
        // request is still awaiting its TCP-start acknowledgement.
        rebuild(scheduler, List.of(replacement), stats, 0);
        assertSame(replacement, scheduler.next(0, true).row);
        assertTrue(scheduler.commit(probe, 0));
        for (int index = 1; index < 32; index++) {
            assertNull(scheduler.next(index * 250L - 1, true));
            MobileClaimScheduler.Selection next = scheduler.next(index * 250L, true); assertTrue(next.recovery);
            assertTrue(scheduler.commit(next, index * 250L));
            rebuild(scheduler, List.of(replacement.copy()), stats, index * 250L);
        }
        assertNull(scheduler.next(67749, true)); assertNotNull(scheduler.next(67750, true));
    }
    @Test public void recoveryRequiresNoHealthyBountyForThatExactPolicy() throws Exception {
        MobileClaimsEngine.Candidate excluded = row("a.example", 1, 0, 200), healthy = row("a.example", 1, 1, 200000), otherMask = row("a.example", 2, 2, 200);
        Map<String, MobileClaimsEngine.PerformanceWindow> stats = new HashMap<>(); stats.put(excluded.policy, rate(0.01)); stats.put(otherMask.policy, rate(0.01));
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(excluded, healthy, otherMask), stats, 0);
        assertEquals(1, scheduler.probeCount()); assertSame(healthy, scheduler.next(0, true).row);
    }
    @Test public void boundedRecoveryAdmissionCannotTurnEvictionIntoImmediateProbes() throws Exception {
        List<MobileClaimsEngine.Candidate> rows = new ArrayList<>(); Map<String, MobileClaimsEngine.PerformanceWindow> stats = new HashMap<>();
        for (int i = 0; i < 300; i++) { MobileClaimsEngine.Candidate row = row("domain" + i + ".example", 7, i, 1000); rows.add(row); stats.put(row.policy, rate(0.01)); }
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, rows, stats, 0);
        assertEquals(256, scheduler.probeCount()); assertTrue(scheduler.commit(scheduler.next(0, true), 0));
        rebuild(scheduler, rows.subList(44, 300), stats, 1);
        assertEquals(256, scheduler.probeCount());
        assertNull(scheduler.next(249, true)); assertNotNull(scheduler.next(250, true));
        scheduler.clear(); rebuild(scheduler, List.of(rows.get(299)), stats, 2);
        assertNull(scheduler.next(249, true)); assertNotNull(scheduler.next(250, true));
    }
    @Test public void startAcknowledgementSurvivesRefreshAndDeletionOfItsEntry() throws Exception {
        MobileClaimsEngine.Candidate a = row("a.example", 7, 0, 600), b = row("b.example", 7, 1, 200);
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(a, b), new HashMap<>(), 0);
        MobileClaimScheduler.Selection pending = scheduler.next(0, true); scheduler.remove(a.key); rebuild(scheduler, List.of(b), new HashMap<>(), 1);
        assertTrue(scheduler.commit(pending, 1)); assertFalse(scheduler.commit(pending, 1)); assertTrue(scheduler.next(1, true).economic);
    }
    @Test public void rawCaptureBudgetUsesUint64SaturationAndDoesNotReserveInflightWork() throws Exception {
        MobileClaimsEngine.Candidate candidate = row("a.example", 7, 0, 600);
        candidate.progress.captures = BigInteger.valueOf(2); assertTrue(candidate.budget()); candidate.progress.captures = BigInteger.valueOf(3); assertFalse(candidate.budget());
        JSONObject hardData = new JSONObject(candidate.bounty.toString()).put("connection_work_target", "00".repeat(32));
        MobileClaimsEngine.Candidate hard = new MobileClaimsEngine.Candidate(hardData, BLOCK, 10, 1_000_000);
        hard.progress.captures = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.valueOf(2)); assertTrue(hard.budget());
        hard.progress.captures = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE); assertFalse(hard.budget());
    }
    @Test public void cachedBudgetMatchesOriginalExactProductAcrossTargetAndCountBoundaries() throws Exception {
        java.util.Random random = new java.util.Random(921);
        for (int sample = 0; sample < 400; sample++) {
            MobileClaimsEngine.Candidate source = row("a.example", 7, sample, 600);
            BigInteger target = sample < 256 ? BigInteger.ONE.shiftLeft(sample).subtract(BigInteger.ONE) : new BigInteger(256, random);
            JSONObject data = new JSONObject(source.bounty.toString()).put("connection_work_target", String.format("%064x", target));
            MobileClaimsEngine.Candidate candidate = new MobileClaimsEngine.Candidate(data, BLOCK, 10, 1_000_000);
            for (BigInteger count : List.of(BigInteger.ZERO, BigInteger.ONE, candidate.captureStopCount.subtract(BigInteger.ONE), candidate.captureStopCount, BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE))) {
                candidate.progress.captures = count;
                boolean expected = count.compareTo(BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE)) < 0 && count.multiply(target.add(BigInteger.ONE)).compareTo(BigInteger.ONE.shiftLeft(257)) <= 0;
                assertEquals("target=" + target + " count=" + count, expected, candidate.budget());
            }
        }
    }
    @Test public void removingUnpreparedLeaderImmediatelyAdmitsRemainingPreparation() throws Exception {
        MobileClaimsEngine.Candidate leader = row("a.example", 7, 0, 1000), replacement = row("a.example", 7, 1, 500);
        leader.progress.prepared = replacement.progress.prepared = null;
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(leader, replacement), new HashMap<>(), 0);
        assertSame(leader, scheduler.next(0, false).row);
        scheduler.remove(leader.key);
        assertSame(replacement, scheduler.next(0, false).row);
        replacement.progress.prepared = new JSONObject();
        assertSame(replacement, scheduler.next(0, true).row);
    }
    @Test public void cachedPriorityFollowsRestoredProgressFactor() throws Exception {
        MobileClaimsEngine.Candidate candidate = row("a.example", 7, 0, 600);
        assertEquals(candidate.raw.multiply(BigInteger.valueOf(1_000_000)), candidate.priority());
        candidate.progress = new MobileClaimsEngine.Candidate.Progress(1_100_000, BLOCK, candidate.height, candidate.policy, candidate.progress.metadata);
        assertEquals(candidate.raw.multiply(BigInteger.valueOf(1_100_000)), candidate.priority());
        assertEquals(candidate.priority(), candidate.copy().priority());
    }
    @Test public void economicConversionUsesTheDesktopWordOrderAndFiniteOverflowRule() {
        BigInteger raw = BigInteger.ONE.shiftLeft(256).multiply(BigInteger.valueOf(200));
        assertEquals(1000, MobileClaimScheduler.score(raw, 5, 1), 0);
        assertEquals(1100, MobileClaimScheduler.score(raw.multiply(BigInteger.valueOf(1_100_000)), 5, 1_000_000), 0);
        assertEquals(Double.MAX_VALUE, MobileClaimScheduler.score(raw, Double.MAX_VALUE, 1), 0);
        assertFalse(MobileClaimScheduler.worth(BigInteger.ZERO, 5));
    }
    @Test public void dispatchReservesFairnessAndReversedAcknowledgementsCannotChangeIt() throws Exception {
        MobileClaimScheduler scheduler = new MobileClaimScheduler();
        rebuild(scheduler, List.of(row("a.example", 7, 0, 600), row("b.example", 7, 1, 200), row("c.example", 7, 2, 200)), new HashMap<>(), 0);
        List<MobileClaimScheduler.Selection> pending = new ArrayList<>(); List<String> actual = new ArrayList<>();
        for (int i = 0; i < 6; i++) { MobileClaimScheduler.Selection selection = scheduler.next(0, true); pending.add(selection); actual.add(selection.row.domain); assertTrue(scheduler.reserve(selection)); }
        assertEquals(List.of("a.example", "a.example", "b.example", "a.example", "c.example", "a.example"), actual);
        for (int i = pending.size() - 1; i >= 0; i--) { assertTrue(scheduler.acknowledge(pending.get(i), 10)); assertFalse(scheduler.acknowledge(pending.get(i), 11)); }
        assertEquals("a.example", scheduler.next(12, true).row.domain);
        assertFalse(scheduler.next(12, true).economic);
    }
    @Test public void recoveryReservationSurvivesRepresentativeChangesAndUnstartedReleaseDoesNotSpendIt() throws Exception {
        MobileClaimsEngine.Candidate first = row("a.example", 7, 0, 200), replacement = row("a.example", 7, 1, 300);
        Map<String, MobileClaimsEngine.PerformanceWindow> stats = new HashMap<>(); stats.put(first.policy, rate(0.01));
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(first), stats, 0);
        MobileClaimScheduler.Selection old = scheduler.next(60000, true); assertTrue(scheduler.reserve(old));
        rebuild(scheduler, List.of(replacement), stats, 60001); assertNull(scheduler.next(60001, true));
        scheduler.release(old);
        MobileClaimScheduler.Selection current = scheduler.next(60001, true); assertSame(replacement, current.row); assertTrue(scheduler.reserve(current));
        scheduler.release(old); assertNull("An old worker cannot clear a newer policy reservation", scheduler.next(60002, true));
        assertTrue(scheduler.acknowledge(current, 65000)); assertNull(scheduler.next(65249, true));
        assertSame(replacement, scheduler.next(65250, true).row);
    }

    @Test public void singleGlobalPreAckProbeDoesNotBlockEconomicAndCancelledStartIsFree() throws Exception {
        MobileClaimsEngine.Candidate a = row("a.example", 7, 0, 1), b = row("b.example", 1, 1, 1), economic = row("z.example", 7, 2, 200);
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); rebuild(scheduler, List.of(a, b, economic), new HashMap<>(), 0);
        MobileClaimScheduler.Selection pending = scheduler.next(0, true); assertTrue(pending.recovery); assertTrue(scheduler.reserve(pending, 0));
        assertSame(economic, scheduler.next(0, true).row); scheduler.remove(economic.key); assertNull(scheduler.next(10000, true));
        scheduler.release(pending); MobileClaimScheduler.Selection retry = scheduler.next(10000, true);
        assertTrue(scheduler.reserve(retry, 10000)); scheduler.release(pending); assertNull(scheduler.next(20000, true));
        assertTrue(scheduler.acknowledge(retry, 20000)); assertFalse(scheduler.acknowledge(retry, 20000));
        assertNull(scheduler.next(20249, true)); assertNotNull(scheduler.next(20250, true));
    }

    @Test public void positiveNetColdTwentyBitPolicyCanLearnButZeroNetCannotProbe() throws Exception {
        MobileClaimsEngine.Candidate source = row("a.example", 7, 0, 75_000_000);
        JSONObject data = new JSONObject(source.bounty.toString()).put("connection_work_target", "00000" + "f".repeat(59));
        MobileClaimsEngine.Candidate cold = new MobileClaimsEngine.Candidate(data, BLOCK, 10, 1_000_000); cold.progress.prepared = new JSONObject();
        MobileClaimsEngine.Candidate zero = row("b.example", 7, 1, 0), negative = row("c.example", 7, 2, -1);
        MobileClaimScheduler scheduler = new MobileClaimScheduler(); Map<String, MobileClaimsEngine.PerformanceWindow> stats = new HashMap<>();
        rebuild(scheduler, List.of(cold, zero, negative), stats, 0);
        assertFalse(MobileClaimScheduler.worth(cold.raw, 5)); assertTrue(scheduler.next(0, true).recovery);
        assertTrue(scheduler.commit(scheduler.next(0, true), 0)); assertNull(scheduler.next(249, true));
        stats.put(cold.policy, rate(20)); rebuild(scheduler, List.of(cold, zero, negative), stats, 1);
        assertSame(cold, scheduler.next(1, true).row); assertFalse(scheduler.next(1, true).recovery);
        cold.progress.budgetExhausted = true; rebuild(scheduler, List.of(cold, zero, negative), stats, 2); assertNull(scheduler.next(100000, true));
    }

    @Test public void relocatedOutpointPreservesBudgetAndFactorButNotPreparedContext() throws Exception {
        MobileClaimsEngine.Candidate old = row("a.example", 7, 0, 600, 1_100_000);
        old.progress.captures = BigInteger.valueOf(3); old.progress.budgetExhausted = true;
        String block = "34".repeat(32);
        JSONObject data = new JSONObject(old.bounty.toString()).put("block_hash", block).put("block_height", 2);
        MobileClaimsEngine.Candidate relocated = new MobileClaimsEngine.Candidate(data, block, 10, 1_000_000);
        relocated.reuse(old.progress);
        assertEquals(old.key, relocated.key); assertEquals(old.progress.factor, relocated.progress.factor);
        assertEquals(old.progress.captures, relocated.progress.captures); assertTrue(relocated.progress.budgetExhausted);
        assertFalse(relocated.budget()); assertNull(relocated.progress.prepared); assertNotSame(old.progress, relocated.progress);
        assertNotNull(old.progress.prepared); assertEquals(old.priority(), relocated.priority());
        MobileClaimsEngine.Candidate fake = new MobileClaimsEngine.Candidate(data.put("domain", "evil.example"), block, 10);
        assertThrows(IllegalArgumentException.class, () -> fake.reuse(old.progress));
    }
}
