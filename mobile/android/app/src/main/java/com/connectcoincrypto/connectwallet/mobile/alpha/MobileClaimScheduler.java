package com.connectcoincrypto.connectwallet.mobile.alpha;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/** Desktop claim-priority/claim-scheduler policy, without I/O or private keys.
 * Refresh snapshots ranks/rates; the dispatch path only visits at most seven
 * mask leaders per domain, never every bounty or a new BigInteger per attempt.
 * All access is serialized by the owning engine's lifecycle lock.
 */
final class MobileClaimScheduler {
    static final int FACTOR_SCALE = 1_000_000, FACTOR_MAX = 1_100_000, MIN_RETURN = 1000, MAX_PROBES = 256;
    static final long PROBE_INTERVAL_MS = 60000;
    private static final double SPACE = Math.scalb(1.0, 256);
    private static final BigInteger WORD = BigInteger.valueOf(0xffffffffL);
    private final Map<String, Entry> entries = new HashMap<>();
    private final TreeMap<String, Group> groups = new TreeMap<>();
    private final LinkedHashMap<String, Long> probes = new LinkedHashMap<>();
    private final Map<String, Selection> pendingProbes = new HashMap<>();
    private boolean preferReward;
    private String domainAfter;
    private long serial;

    interface Rates { double rate(MobileClaimsEngine.Candidate row); }
    private static final class Group {
        final String domain;
        final Map<Integer, TreeSet<Entry>> masks = new TreeMap<>();
        Group(String domain) { this.domain = domain; }
    }
    private static final class Entry {
        final MobileClaimsEngine.Candidate row; final BigInteger priority; final double score; final boolean recovery;
        final Group group; final long transportDue;
        Entry(MobileClaimsEngine.Candidate row, double rate, boolean recovery, Group group, long transportDue) {
            this.row = row; this.priority = row.priority(); this.score = score(priority, rate, FACTOR_SCALE);
            this.recovery = recovery; this.group = group; this.transportDue = transportDue;
        }
    }
    static final class Selection {
        final MobileClaimsEngine.Candidate row;
        final boolean economic, recovery;
        final long serial;
        boolean reserved, committed;
        Selection(Entry entry, boolean economic, long serial) { row = entry.row; recovery = entry.recovery; this.economic = economic; this.serial = serial; }
    }
    static double score(BigInteger priority, double rate, int scale) {
        if (priority.signum() < 0 || priority.bitLength() > 352 || !Double.isFinite(rate) || rate <= 0 || scale <= 0) return Double.NaN;
        double numerator = 0;
        for (int shift = 320; shift >= 0; shift -= 32) numerator = numerator * 4294967296.0 + priority.shiftRight(shift).and(WORD).longValue();
        double expected = numerator / SPACE, result = expected * rate / scale;
        return result == Double.POSITIVE_INFINITY ? Math.min(Double.MAX_VALUE, (expected / scale) * rate) : result;
    }
    static boolean worth(BigInteger raw, double rate) { return score(raw, rate, 1) >= MIN_RETURN; }
    static int compare(MobileClaimsEngine.Candidate left, MobileClaimsEngine.Candidate right) {
        int rank = right.priority().compareTo(left.priority());
        return rank != 0 ? rank : MobileClaimsEngine.compareOutpoints(left, right);
    }
    private static int compareEntries(Entry a, Entry b) {
        int rank = b.priority.compareTo(a.priority);
        return rank != 0 ? rank : MobileClaimsEngine.compareOutpoints(a.row, b.row);
    }
    private static boolean eligible(MobileClaimsEngine.Candidate row, Set<String> retired) {
        return row.supported && row.state.equals("available") && !retired.contains(row.key) && row.budget() && row.raw.signum() > 0;
    }
    void rebuild(Iterable<MobileClaimsEngine.Candidate> rows, Map<String, MobileClaimsEngine.Ema> stats, Set<String> retired, long now) {
        entries.clear(); groups.clear();
        List<MobileClaimsEngine.Candidate> candidates = new ArrayList<>();
        Set<String> policies = new HashSet<>(), healthy = new HashSet<>();
        Map<String, MobileClaimsEngine.Candidate> recovery = new HashMap<>();
        for (MobileClaimsEngine.Candidate row : rows) {
            policies.add(row.policy);
            if (!eligible(row, retired)) continue;
            candidates.add(row); double rate = rate(row, stats);
            if (worth(row.raw, rate)) healthy.add(row.policy);
            else if (worth(row.raw, 5)) {
                MobileClaimsEngine.Candidate previous = recovery.get(row.policy);
                if (previous == null || compare(row, previous) < 0) recovery.put(row.policy, row);
            }
        }
        probes.keySet().retainAll(policies);
        List<MobileClaimsEngine.Candidate> representatives = new ArrayList<>();
        for (Map.Entry<String, MobileClaimsEngine.Candidate> item : recovery.entrySet()) if (!healthy.contains(item.getKey())) representatives.add(item.getValue());
        representatives.sort(MobileClaimScheduler::compare);
        Set<String> admitted = new HashSet<>();
        for (int index = 0; index < Math.min(MAX_PROBES, representatives.size()); index++) {
            MobileClaimsEngine.Candidate row = representatives.get(index); admitted.add(row.key); probeDue(row.policy, now);
        }
        for (MobileClaimsEngine.Candidate row : candidates) {
            double rate = rate(row, stats); boolean recovering = !worth(row.raw, rate);
            if (recovering && !admitted.contains(row.key)) continue;
            Group group = groups.computeIfAbsent(row.domain, Group::new);
            MobileClaimsEngine.Ema observed = stats.get(row.policy);
            Entry entry = new Entry(row, rate, recovering, group, observed == null ? 0 : observed.retryAfter);
            if (!Double.isFinite(entry.score)) continue;
            group.masks.computeIfAbsent(row.mask, unused -> new TreeSet<>(MobileClaimScheduler::compareEntries)).add(entry);
            entries.put(row.key, entry);
        }
    }
    static double rate(MobileClaimsEngine.Candidate row, Map<String, MobileClaimsEngine.Ema> stats) {
        MobileClaimsEngine.Ema value = stats.get(row.policy); return value == null ? 5 : value.rate();
    }
    private long probeDue(String policy, long now) {
        Long due = probes.get(policy);
        if (due == null) {
            if (probes.size() >= MAX_PROBES) { Iterator<String> oldest = probes.keySet().iterator(); oldest.next(); oldest.remove(); }
            due = now + PROBE_INTERVAL_MS; probes.put(policy, due);
        }
        return due;
    }
    private Entry leader(Group group, long now) {
        Entry best = null;
        for (TreeSet<Entry> mask : group.masks.values()) {
            if (mask.isEmpty()) continue;
            Entry row = mask.first();
            if (row.transportDue > now || row.recovery && (pendingProbes.containsKey(row.row.policy) || probeDue(row.row.policy, now) > now)) continue;
            if (best == null || row.score > best.score || row.score == best.score && compareEntries(row, best) < 0) best = row;
        }
        return best;
    }
    /** Peek only. Unprepared domain leaders never cause a worse bounty in the
     * same domain to be tried, and never block other already prepared domains. */
    Selection next(long now, boolean prepared) {
        Entry best = null, after = null, first = null;
        for (Group group : groups.values()) {
            Entry entry = leader(group, now);
            if (entry == null || (entry.row.progress.prepared != null) != prepared) continue;
            if (preferReward) {
                if (best == null || entry.score > best.score || entry.score == best.score && compareEntries(entry, best) < 0) best = entry;
            } else {
                if (first == null) first = entry;
                if (after == null && (domainAfter == null || group.domain.compareTo(domainAfter) > 0)) after = entry;
            }
        }
        if (!preferReward) best = after != null ? after : first;
        return best == null ? null : new Selection(best, preferReward, serial);
    }
    /** Dispatch reserves the fair/economic turn before another DNS worker can
     * select. Recovery reservations belong to the policy across catalog edits. */
    boolean reserve(Selection selection) {
        if (selection == null || selection.reserved || selection.serial != serial || selection.recovery && pendingProbes.containsKey(selection.row.policy)) return false;
        selection.reserved = true;
        if (!selection.economic) domainAfter = selection.row.domain;
        preferReward = !selection.economic; serial++;
        if (selection.recovery) pendingProbes.put(selection.row.policy, selection);
        return true;
    }
    /** Only an actual TCP event spends a recovery probe. Ack order does not
     * change fair/economic turns, which were fixed at dispatch. */
    boolean acknowledge(Selection selection, long now) {
        if (selection == null || !selection.reserved || selection.committed) return false;
        selection.committed = true;
        if (selection.recovery) {
            probeDue(selection.row.policy, now); probes.remove(selection.row.policy); probes.put(selection.row.policy, now + PROBE_INTERVAL_MS);
        }
        release(selection);
        return true;
    }
    void release(Selection selection) { if (selection != null && selection.recovery) pendingProbes.remove(selection.row.policy, selection); }
    boolean commit(Selection selection, long now) { return reserve(selection) && acknowledge(selection, now); }
    void remove(String key) {
        Entry entry = entries.remove(key);
        if (entry != null) entry.group.masks.get(entry.row.mask).remove(entry);
    }
    void clear() { entries.clear(); groups.clear(); }
    int probeCount() { return probes.size(); }
}
