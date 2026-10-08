package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** A complete native-owned UTXO snapshot. Does not fetch, sign or discard reservations. */
public final class NativePaymentInventory {
    public static final int MAX_PAGES = 512, MAX_CHANGE_PAGES = 1000, MAX_CHANGE_EVENTS = 100000;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;
    private final String address;
    private final int index, change;
    private RowBudget.Scope budget;
    private JSONObject anchor, reservations;
    private Map<String, JSONObject> outputs = new LinkedHashMap<>();
    private final Set<String> cursors = new HashSet<>();
    private String cursor;
    private int pages;
    private boolean complete, journal, reconciled;
    private String journalCursor;
    private long journalEpoch, sequence, drainThrough = -1;
    private JSONObject drainTip;
    private int changePages, changeEvents;
    private final Set<String> changeCursors = new HashSet<>();

    /** One aggregate budget across every concurrently loading HD address and
     * every completed group. A discarded scope cannot admit late worker rows. */
    public static final class RowBudget implements AutoCloseable {
        private final int limit;
        private int rows;
        private boolean closed;
        public RowBudget() { this(NativeTransactions.MAX_PAYMENT_CANDIDATES); }
        public RowBudget(int limit) {
            require(limit > 0 && limit <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Invalid payment inventory budget.");
            this.limit = limit;
        }
        public synchronized Scope scope() {
            require(!closed, "Payment output inventory was cancelled."); return new Scope();
        }
        public synchronized int rowCount() { return rows; }
        @Override public synchronized void close() { closed = true; }
        public final class Scope implements AutoCloseable {
            private int retained;
            private boolean discarded;
            public void check() {
                synchronized (RowBudget.this) { require(!closed && !discarded, "Payment output inventory was cancelled."); }
            }
            private void adjust(int delta) {
                synchronized (RowBudget.this) {
                    check();
                    require(delta >= -retained && rows + delta <= limit, "Wallet outputs exceed the mobile memory limit.");
                    retained += delta; rows += delta;
                }
            }
            private void publish(int delta, Runnable publication) {
                synchronized (RowBudget.this) { adjust(delta); publication.run(); }
            }
            @Override public void close() {
                synchronized (RowBudget.this) {
                    if (!discarded) { rows -= retained; retained = 0; discarded = true; }
                }
            }
        }
    }

    /** Only valid data from a different snapshot is eligible for a bounded read retry. */
    public static final class SnapshotChanged extends IllegalArgumentException {
        public SnapshotChanged() { super("Payment snapshot changed. Refresh and review again."); }
    }

    public NativePaymentInventory(String address, JSONObject tip, JSONObject reservations) throws Exception {
        this(address, 0, 0, tip, reservations);
    }
    public NativePaymentInventory(String address, int index, int change, JSONObject tip, JSONObject reservations) throws Exception {
        WalletCrypto.decodeAddress(address);
        require(index >= 0 && (change == 0 || change == 1), "Invalid native payment derivation path.");
        require(reservations != null, "Missing payment reservations.");
        this.address = address;
        this.index = index; this.change = change;
        anchor = NativePaymentChecks.tip(tip);
        this.reservations = new JSONObject(reservations.toString());
    }

    /** Start a live baseline with a journal watermark obtained before its first
     * page. Replay every intervening mutation before exposing spend candidates. */
    public static NativePaymentInventory fromWatermark(String address, JSONObject watermark, JSONObject reservations) throws Exception {
        return fromWatermark(address, 0, 0, watermark, reservations);
    }
    public static NativePaymentInventory fromWatermark(String address, int index, int change, JSONObject watermark, JSONObject reservations) throws Exception {
        JSONObject tip = journalResponse(watermark);
        require(watermark.getJSONArray("changes").length() == 0 && !watermark.getBoolean("has_more"), "Invalid payment journal watermark.");
        NativePaymentInventory inventory = new NativePaymentInventory(address, index, change, tip, reservations);
        inventory.journal = true;
        inventory.sequence = integer(watermark.opt("through_sequence"), 0, MAX_SAFE_INTEGER);
        inventory.journalEpoch = integer(watermark.opt("journal_epoch"), 0, MAX_SAFE_INTEGER);
        inventory.journalCursor = changeCursor(watermark);
        inventory.changeCursors.add(inventory.journalCursor);
        return inventory;
    }
    public static NativePaymentInventory fromWatermark(String address, int index, int change, JSONObject watermark,
            JSONObject reservations, RowBudget.Scope budget) throws Exception {
        require(budget != null, "Missing aggregate payment inventory budget."); budget.check();
        NativePaymentInventory inventory = fromWatermark(address, index, change, watermark, reservations);
        inventory.budget = budget; return inventory;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalArgumentException(message);
    }
    private static void fields(JSONObject object, String... expected) {
        require(object != null, "Invalid payment journal data.");
        Set<String> actual = new HashSet<>(); Iterator<String> keys = object.keys();
        while (keys.hasNext()) actual.add(keys.next());
        require(actual.equals(new HashSet<>(Arrays.asList(expected))), "Invalid payment journal schema.");
    }
    private static long integer(Object value, long minimum, long maximum) {
        require(value instanceof Integer || value instanceof Long, "Invalid payment journal integer.");
        long number = ((Number)value).longValue();
        require(number >= minimum && number <= maximum, "Invalid payment journal integer.");
        return number;
    }
    private static String hash(Object value) {
        require(value instanceof String && ((String)value).matches("[0-9a-f]{64}"), "Invalid payment journal hash.");
        return (String)value;
    }
    private static JSONObject copy(JSONObject source) throws Exception {
        JSONObject copy = new JSONObject(); Iterator<String> keys = source.keys();
        while (keys.hasNext()) { String key = keys.next(); copy.put(key, source.get(key)); }
        return copy;
    }
    private static String changeCursor(JSONObject response) throws Exception {
        return NativePaymentChecks.cursor(response);
    }
    private static JSONObject journalResponse(JSONObject response) throws Exception {
        fields(response, "tip", "unit", "changes", "next_cursor", "has_more", "through_sequence", "journal_epoch");
        require("connects".equals(response.opt("unit")) && response.opt("changes") instanceof JSONArray
            && response.getJSONArray("changes").length() <= 500 && response.opt("has_more") instanceof Boolean,
            "Invalid payment journal response.");
        require(changeCursor(response) != null, "Missing payment journal cursor.");
        integer(response.opt("through_sequence"), 0, MAX_SAFE_INTEGER);
        integer(response.opt("journal_epoch"), 0, MAX_SAFE_INTEGER);
        return NativePaymentChecks.tip(response.getJSONObject("tip"));
    }
    private static String outpoint(JSONObject row) throws Exception {
        Object txid = row.opt("txid"), index = row.opt("vout");
        require(txid instanceof String && ((String)txid).matches("[0-9a-f]{64}")
            && (index instanceof Integer || index instanceof Long), "Invalid selected payment input.");
        long vout = ((Number)index).longValue();
        require(vout >= 0 && vout <= 0xffffffffL, "Invalid selected payment input.");
        return txid + ":" + vout;
    }
    private static String pendingSpender(JSONObject row) throws Exception {
        require(row.has("pending_spent_by"), "Payment reservation changed. Review again.");
        if (row.isNull("pending_spent_by")) return null;
        Object value = row.opt("pending_spent_by");
        require(value instanceof String && ((String)value).matches("[0-9a-f]{64}"), "Invalid payment reservation.");
        return (String)value;
    }
    private static boolean same(String first, String second) {
        return first == null ? second == null : first.equals(second);
    }
    private void requireComplete() {
        if (budget != null) budget.check();
        require(complete && (!journal || reconciled), "Payment outputs are incomplete. Refresh and review again.");
    }
    private JSONObject reservedView(JSONObject source) throws Exception {
        JSONObject row = copy(source); String key = outpoint(row);
        if (row.isNull("pending_spent_by") && reservations.has(key)) {
            Object reservedBy = reservations.get(key);
            require(reservedBy instanceof String && ((String)reservedBy).matches("[0-9a-f]{64}"), "Invalid payment reservation.");
            row.put("pending_spent_by", reservedBy);
        }
        return row;
    }

    /** Stage and validate an entire page before publishing any of its rows. */
    public void accept(JSONObject page) throws Exception {
        if (budget != null) budget.check();
        require(!complete && pages < MAX_PAGES, "Invalid or oversized UTXO pagination.");
        require(page != null && page.opt("tip") instanceof JSONObject, "Invalid payment snapshot.");
        JSONObject pageTip = NativePaymentChecks.tip(page.getJSONObject("tip"));
        // Validate all fields and rows first: malformed responses must never be
        // classified as a transient tip change, even when their tip differs.
        JSONArray rows = NativePaymentChecks.utxos(page, address, pageTip);
        if (!journal) {
            for (String field : new String[]{"hash", "height", "mediantime"}) {
                if (!anchor.get(field).toString().equals(pageTip.get(field).toString())) throw new SnapshotChanged();
            }
            NativePaymentChecks.sameTip(anchor, pageTip);
        }
        require(outputs.size() + rows.length() <= NativeTransactions.MAX_PAYMENT_CANDIDATES,
            "Payment output inventory exceeds the mobile memory limit.");
        String next = NativePaymentChecks.cursor(page);
        require(next == null || !cursors.contains(next), "Repeated UTXO pagination cursor.");
        require(next == null || pages + 1 < MAX_PAGES, "Invalid or oversized UTXO pagination.");
        // Reserve before cloning the page. Sixteen paginated readers must not
        // each accumulate an independent 50k-row inventory before aggregation.
        if (budget != null) budget.adjust(rows.length());
        Map<String, JSONObject> staged = new LinkedHashMap<>();
        try {
            for (int i = 0; i < rows.length(); i++) {
                JSONObject row = new JSONObject(rows.getJSONObject(i).toString());
                String key = outpoint(row);
                require(!outputs.containsKey(key), "Duplicate output across RPC pages. Refresh again.");
                row.put("index", index).put("change", change);
                reservedView(row); // Validate local metadata without overwriting the remote state.
                staged.put(key, row);
            }
        } catch (Exception error) {
            if (budget != null) {
                try { budget.adjust(-rows.length()); } catch (IllegalArgumentException cancelled) { /* Scope already released. */ }
            }
            throw error;
        }
        Runnable publish = () -> {
            outputs.putAll(staged); pages++; cursor = next;
            if (next == null) { complete = true; reconciled = !journal; }
            else cursors.add(next);
        };
        if (budget == null) publish.run(); else budget.publish(0, publish);
    }

    /** Stage each complete journal page privately. Candidates remain unavailable
     * throughout the drain, including after an earlier page has validated. */
    public void applyChanges(JSONObject response) throws Exception {
        stageChanges(response, false).publish();
    }
    /** Internal aggregate inventory use only: its caller validates every
     * mutation against the complete native-owned address set before fanout.
     * Every member advances through the same frozen global journal page. */
    public void applySharedChanges(JSONObject response) throws Exception {
        stageChanges(response, true).publish();
    }
    /** Validate the whole native group before atomically charging its net page
     * growth. A transfer removing from B and adding to A must not depend on
     * which address finished its baseline first. */
    public static void applySharedChanges(List<NativePaymentInventory> inventories, JSONObject response) throws Exception {
        require(inventories != null && !inventories.isEmpty(), "Missing shared payment inventory.");
        RowBudget.Scope sharedBudget = inventories.get(0).budget;
        List<JournalUpdate> updates = new ArrayList<>(); int delta = 0;
        for (NativePaymentInventory inventory : inventories) {
            require(inventory.budget == sharedBudget, "Mismatched shared payment inventory budget.");
            JournalUpdate update = inventory.stageChanges(response, true); updates.add(update);
            delta = Math.addExact(delta, update.delta());
        }
        Runnable publish = () -> { for (JournalUpdate update : updates) update.commit(); };
        if (sharedBudget == null) publish.run(); else sharedBudget.publish(delta, publish);
    }
    private final class JournalUpdate {
        final Map<String, JSONObject> staged;
        final JSONObject tip;
        final long through, last;
        final String next;
        final boolean more;
        final int events;
        JournalUpdate(Map<String, JSONObject> staged, JSONObject tip, long through, long last, String next, boolean more, int events) {
            this.staged = staged; this.tip = tip; this.through = through; this.last = last; this.next = next; this.more = more; this.events = events;
        }
        int delta() { return staged.size() - outputs.size(); }
        void publish() { if (budget == null) commit(); else budget.publish(delta(), this::commit); }
        void commit() {
            outputs = staged; changePages++; changeEvents += events;
            drainThrough = through; drainTip = tip; journalCursor = next; changeCursors.add(next);
            sequence = more ? last : through;
            if (!more) { anchor = tip; reconciled = true; }
        }
    }
    private JournalUpdate stageChanges(JSONObject response, boolean shared) throws Exception {
        if (budget != null) budget.check();
        require(journal && complete && !reconciled && changePages < MAX_CHANGE_PAGES, "Invalid payment journal state.");
        JSONObject tip = journalResponse(response);
        long through = integer(response.opt("through_sequence"), 0, MAX_SAFE_INTEGER);
        require(integer(response.opt("journal_epoch"), 0, MAX_SAFE_INTEGER) == journalEpoch, "Payment journal epoch changed. Review again.");
        require(through >= sequence && (drainThrough < 0 || through == drainThrough), "Payment journal watermark changed during transfer.");
        if (drainTip != null) NativePaymentChecks.sameTip(drainTip, tip);
        JSONArray changes = response.getJSONArray("changes"); boolean more = response.getBoolean("has_more");
        require(!more || changes.length() > 0, "Empty continuing payment journal page.");
        require(!more || changePages + 1 < MAX_CHANGE_PAGES, "Payment journal exceeds the page limit.");
        require(changeEvents + changes.length() <= MAX_CHANGE_EVENTS, "Payment journal exceeds the event limit.");
        String next = changeCursor(response);
        require(!(more || changes.length() > 0) || !next.equals(journalCursor), "Payment journal cursor did not advance.");
        require(!changeCursors.contains(next) || next.equals(journalCursor) && !more && changes.length() == 0,
            "Repeated payment journal cursor.");
        long last = sequence;
        Map<String, JSONObject> staged = new LinkedHashMap<>(outputs);
        for (int i = 0; i < changes.length(); i++) {
            JSONObject event = changes.getJSONObject(i);
            long eventSequence = integer(event.opt("sequence"), 0, MAX_SAFE_INTEGER);
            require(eventSequence > last && eventSequence <= through, "Invalid payment journal sequence or address.");
            if (shared && !address.equals(event.opt("address"))) { last = eventSequence; continue; }
            require(address.equals(event.opt("address")), "Invalid payment journal sequence or address.");
            String id = hash(event.opt("txid")); Object kind = event.opt("kind"), action = event.opt("action");
            require(("utxo".equals(kind) || "history".equals(kind)) && ("upsert".equals(action) || "remove".equals(action)), "Invalid payment journal mutation.");
            boolean utxo = "utxo".equals(kind), upsert = "upsert".equals(action);
            if (utxo && upsert) fields(event, "sequence", "address", "kind", "action", "txid", "vout", "item");
            else if (utxo) fields(event, "sequence", "address", "kind", "action", "txid", "vout");
            else if (upsert) fields(event, "sequence", "address", "kind", "action", "txid", "item");
            else fields(event, "sequence", "address", "kind", "action", "txid");
            if (utxo) {
                long vout = integer(event.opt("vout"), 0, 0xffffffffL); String key = id + ":" + vout;
                if (!upsert) staged.remove(key);
                else {
                    JSONObject row = event.getJSONObject("item");
                    JSONObject syntheticPage = new JSONObject().put("address", address).put("tip", tip).put("unit", "connects")
                        .put("live", true).put("items", new JSONArray().put(row)).put("next_cursor", JSONObject.NULL);
                    NativePaymentChecks.utxos(syntheticPage, address, tip);
                    require(key.equals(outpoint(row)), "Payment journal item does not match its output.");
                    JSONObject held = copy(row).put("index", index).put("change", change);
                    reservedView(held); staged.put(key, held);
                }
            } else if (upsert) validateHistory(event.getJSONObject("item"), id, tip);
            last = eventSequence;
        }
        require(!more || last < through, "Invalid continuing payment journal watermark.");
        require(staged.size() <= NativeTransactions.MAX_PAYMENT_CANDIDATES, "Payment output inventory exceeds the mobile memory limit.");
        if (!more) {
            // Untouched coinbase outputs can mature during normal chain growth.
            // Reproject every row at the frozen drain tip, not its baseline page.
            long height = tip.getLong("height");
            for (Map.Entry<String, JSONObject> entry : staged.entrySet()) {
                JSONObject row = copy(entry.getValue()); long confirmations = 0;
                if ("confirmed".equals(row.getString("status"))) {
                    long blockHeight = row.getLong("block_height");
                    require(blockHeight <= height, "Payment inventory contains outputs beyond its reconciled tip.");
                    confirmations = height - blockHeight + 1;
                }
                row.put("confirmations", confirmations).put("mature", !row.getBoolean("coinbase") || confirmations >= 100);
                reservedView(row); entry.setValue(row);
            }
        }
        return new JournalUpdate(staged, tip, through, last, next, more, changes.length());
    }

    private static void validateHistory(JSONObject row, String id, JSONObject tip) throws Exception {
        fields(row, "txid", "status", "block_height", "block_hash", "received", "spent", "balance_delta", "confirmations");
        require(id.equals(hash(row.opt("txid"))), "Payment journal history ID changed.");
        require(row.opt("received") instanceof String && row.opt("spent") instanceof String && row.opt("balance_delta") instanceof String,
            "Invalid payment journal history amount.");
        long received = NativeTransactions.amount(row.getString("received")), spent = NativeTransactions.amount(row.getString("spent"));
        String delta = row.getString("balance_delta");
        require(delta.matches("0|-?[1-9][0-9]{0,18}"), "Invalid payment journal history amount.");
        long value = Long.parseLong(delta);
        require(value >= -NativeTransactions.MAX_MONEY && value <= NativeTransactions.MAX_MONEY && received - spent == value, "Invalid payment journal history total.");
        long confirmations = integer(row.opt("confirmations"), 0, (long)Integer.MAX_VALUE + 1);
        if ("pending".equals(row.opt("status"))) require(row.isNull("block_height") && row.isNull("block_hash") && confirmations == 0, "Invalid payment journal history location.");
        else {
            require("confirmed".equals(row.opt("status")), "Invalid payment journal history status.");
            long height = integer(row.opt("block_height"), 0, tip.getLong("height")); hash(row.opt("block_hash"));
            require(confirmations == tip.getLong("height") - height + 1, "Invalid payment journal history confirmations.");
        }
    }

    /** Refresh only mutations after the previously reconciled cursor. Local
     * reservations are refreshed independently and never removed from storage. */
    public void beginRefresh(JSONObject reservations) throws Exception {
        if (budget != null) budget.check();
        require(journal && reconciled && reservations != null, "Payment inventory is not ready for refresh.");
        JSONObject nextReservations = new JSONObject(reservations.toString());
        this.reservations = nextReservations; reconciled = false;
        changePages = 0; changeEvents = 0; drainThrough = -1; drainTip = null;
        changeCursors.clear(); changeCursors.add(journalCursor);
    }
    /** Retire a failed/replaced group before loading its replacement. */
    public void discard() {
        if (budget != null) budget.close();
        outputs = new LinkedHashMap<>(); complete = false; reconciled = false;
    }

    public String address() { return address; }
    public int index() { return index; }
    public int change() { return change; }
    public long journalEpoch() { return journalEpoch; }
    public long throughSequence() { return sequence; }
    public String nextCursor() { return cursor; }
    public String changesCursor() { return journalCursor; }
    public boolean reconciled() { return reconciled; }
    public boolean complete() { return complete; }
    public int rowCount() { return outputs.size(); }
    public int pageCount() { return pages; }
    public JSONObject tip() throws Exception { return new JSONObject(anchor.toString()); }
    private JSONArray candidates(boolean reserved) throws Exception {
        requireComplete(); JSONArray rows = new JSONArray();
        for (JSONObject source : outputs.values()) {
            JSONObject row = reservedView(source);
            if (row.getBoolean("mature") && "confirmed".equals(row.getString("status")) && (pendingSpender(row) != null) == reserved) rows.put(row);
        }
        return rows;
    }
    public JSONArray candidates() throws Exception { return candidates(false); }
    public JSONArray pendingCandidates() throws Exception { return candidates(true); }

    /** Revalidate exactly the reviewed inputs against a fresh complete snapshot. */
    public void verifySelected(JSONArray selected, boolean useAll, String expectedAmount) throws Exception {
        requireComplete();
        require(selected != null && selected.length() > 0 && selected.length() <= NativeTransactions.MAX_PAYMENT_INPUTS,
            "Invalid selected payment input count.");
        Set<String> seen = new HashSet<>();
        long selectedTotal = 0;
        for (int i = 0; i < selected.length(); i++) {
            JSONObject reviewed = selected.getJSONObject(i);
            String key = outpoint(reviewed);
            require(seen.add(key), "Duplicate selected payment input.");
            JSONObject fresh = outputs.get(key);
            if (fresh != null) fresh = reservedView(fresh);
            require(fresh != null && Boolean.TRUE.equals(fresh.opt("mature")) && "confirmed".equals(fresh.opt("status")),
                "Selected payment funds changed or were spent. Review again.");
            require(Boolean.TRUE.equals(reviewed.opt("mature")) && "confirmed".equals(reviewed.opt("status"))
                && reviewed.opt("amount") instanceof String && fresh.getString("amount").equals(reviewed.getString("amount"))
                && Integer.valueOf(index).equals(reviewed.opt("index")) && Integer.valueOf(change).equals(reviewed.opt("change")),
                "Selected payment input changed. Review again.");
            String spender = pendingSpender(fresh);
            require(same(spender, pendingSpender(reviewed)) && (!useAll || spender == null),
                "Selected payment reservation changed. Review again.");
            selectedTotal = Math.addExact(selectedTotal, NativeTransactions.amount(fresh.getString("amount")));
            NativeTransactions.amount(Long.toString(selectedTotal));
        }
        if (useAll) {
            long total = 0;
            JSONArray available = candidates();
            for (int i = 0; i < available.length(); i++) {
                total = Math.addExact(total, NativeTransactions.amount(available.getJSONObject(i).getString("amount")));
                NativeTransactions.amount(Long.toString(total));
            }
            long expected = NativeTransactions.amount(expectedAmount);
            require(total == expected && selectedTotal == expected,
                "Available funds changed. Refresh the balance and use all again.");
        }
    }
}
