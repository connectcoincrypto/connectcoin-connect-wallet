package com.connectcoincrypto.connectwallet.mobile.alpha;

import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentInventory;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativeTransactions;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Native public reads for a complete inventory reconciled with its mutation
 * journal. A changing chain tip alone does not restart a large wallet scan. */
public final class MobilePaymentPreparation {
    private static final int MAX_ATTEMPTS = 3;
    private MobilePaymentPreparation() {}

    public static NativePaymentInventory inventory(String address, JSONObject reservations,
            MobilePaymentFunding.Session session) throws Exception {
        return prepare(address, 0, 0, reservations, session, null);
    }

    /** Normally reads only the journal since the previous reconciliation. If
     * its cursor explicitly expires, obtain a new baseline within the same
     * bounded attempt budget. The caller must use the returned inventory. */
    public static NativePaymentInventory refresh(NativePaymentInventory inventory, JSONObject reservations,
            MobilePaymentFunding.Session session) throws Exception {
        if (inventory == null) throw new IllegalArgumentException("Missing payment output inventory.");
        return prepare(inventory.address(), inventory.index(), inventory.change(), reservations, session, inventory);
    }

    /** A native-owned set of fully reconciled per-address inventories. No
     * renderer/RPC-supplied derivation metadata enters this collection. */
    public static final class HdInventory {
        private final NativePaymentInventory.RowBudget budget;
        private final List<Group> groups;
        private final List<NativePaymentInventory> inventories;
        private HdInventory(List<Group> groups, NativePaymentInventory.RowBudget budget) throws Exception {
            this.groups = groups; this.budget = budget; inventories = new ArrayList<>();
            for (Group group : groups) inventories.addAll(group.inventories);
            int rows = 0;
            for (NativePaymentInventory inventory : inventories) rows = Math.addExact(rows, inventory.rowCount());
            if (rows > NativeTransactions.MAX_PAYMENT_CANDIDATES) throw new IllegalArgumentException("Wallet outputs exceed the mobile memory limit.");
        }
        public JSONArray candidates() throws Exception { return candidates(false); }
        public JSONArray pendingCandidates() throws Exception { return candidates(true); }
        private JSONArray candidates(boolean pending) throws Exception {
            requireCoherent();
            JSONArray all = new JSONArray(); HashSet<String> seen = new HashSet<>();
            for (NativePaymentInventory inventory : inventories) {
                JSONArray rows = pending ? inventory.pendingCandidates() : inventory.candidates();
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject row = rows.getJSONObject(i);
                    if (!seen.add(row.getString("txid") + ":" + row.getLong("vout"))) throw new IllegalArgumentException("Duplicate output across wallet addresses.");
                    if (all.length() >= NativeTransactions.MAX_PAYMENT_CANDIDATES) throw new IllegalArgumentException("Wallet outputs exceed the mobile memory limit.");
                    all.put(row);
                }
            }
            return all;
        }
        public void verifySelected(JSONArray selected, boolean useAll, String expectedAmount) throws Exception {
            requireCoherent();
            if (selected == null || selected.length() < 1 || selected.length() > NativeTransactions.MAX_PAYMENT_INPUTS) throw new IllegalArgumentException("Invalid selected payment input count.");
            Map<String, JSONArray> byPath = new LinkedHashMap<>(); HashSet<String> seen = new HashSet<>();
            long selectedTotal = 0;
            for (int i = 0; i < selected.length(); i++) {
                JSONObject row = selected.getJSONObject(i);
                if (!(row.opt("index") instanceof Integer) || !(row.opt("change") instanceof Integer)) throw new IllegalArgumentException("Invalid native payment path.");
                if (!seen.add(row.getString("txid") + ":" + row.getLong("vout"))) throw new IllegalArgumentException("Duplicate selected payment input.");
                byPath.computeIfAbsent(row.getInt("change") + ":" + row.getInt("index"), key -> new JSONArray()).put(row);
                selectedTotal = Math.addExact(selectedTotal, NativeTransactions.amount(row.getString("amount")));
                NativeTransactions.amount(Long.toString(selectedTotal));
            }
            for (NativePaymentInventory inventory : inventories) {
                JSONArray rows = byPath.remove(inventory.change() + ":" + inventory.index());
                if (rows != null) inventory.verifySelected(rows, false, null);
            }
            if (!byPath.isEmpty()) throw new IllegalArgumentException("Payment input is outside this wallet's address inventory.");
            if (useAll) {
                JSONArray available = candidates(); long total = 0;
                for (int i = 0; i < available.length(); i++) {
                    total = Math.addExact(total, NativeTransactions.amount(available.getJSONObject(i).getString("amount")));
                    NativeTransactions.amount(Long.toString(total));
                }
                long expected = NativeTransactions.amount(expectedAmount);
                if (total != expected || selectedTotal != expected) throw new IllegalArgumentException("Available funds changed. Refresh the balance and use all again.");
                for (int i = 0; i < selected.length(); i++) if (!selected.getJSONObject(i).isNull("pending_spent_by")) throw new IllegalArgumentException("Available payment funds are reserved.");
            }
        }
        /** Validate an oversized payment as independently standard transactions,
         * without raising any per-transaction or per-address signing bound. */
        public void verifyBatch(JSONArray plans, boolean useAll, String expectedAmount) throws Exception {
            requireCoherent();
            if (plans == null || plans.length() < 2 || plans.length() > 32) throw new IllegalArgumentException("Invalid payment batch size.");
            HashSet<String> selectedKeys = new HashSet<>(); long selectedTotal = 0;
            for (int part = 0; part < plans.length(); part++) {
                JSONArray selected = plans.getJSONObject(part).getJSONArray("selected");
                verifySelected(selected, false, null);
                for (int i = 0; i < selected.length(); i++) {
                    JSONObject row = selected.getJSONObject(i);
                    if (!row.isNull("pending_spent_by") || !selectedKeys.add(row.getString("txid") + ":" + row.getLong("vout"))) {
                        throw new IllegalArgumentException("Payment batches require distinct unreserved confirmed inputs.");
                    }
                    if (selectedKeys.size() > NativeTransactions.MAX_PAYMENT_CANDIDATES) throw new IllegalArgumentException("Payment batch exceeds the mobile input limit.");
                    selectedTotal = Math.addExact(selectedTotal, NativeTransactions.amount(row.getString("amount")));
                    NativeTransactions.amount(Long.toString(selectedTotal));
                }
            }
            if (useAll) {
                JSONArray available = candidates(); long availableTotal = 0;
                if (available.length() != selectedKeys.size()) throw new IllegalArgumentException("Available funds changed. Refresh the balance and use all again.");
                for (int i = 0; i < available.length(); i++) {
                    JSONObject row = available.getJSONObject(i);
                    if (!selectedKeys.remove(row.getString("txid") + ":" + row.getLong("vout"))) throw new IllegalArgumentException("Available funds changed. Refresh the balance and use all again.");
                    availableTotal = Math.addExact(availableTotal, NativeTransactions.amount(row.getString("amount")));
                    NativeTransactions.amount(Long.toString(availableTotal));
                }
                long expected = NativeTransactions.amount(expectedAmount);
                if (!selectedKeys.isEmpty() || availableTotal != expected || selectedTotal != expected) throw new IllegalArgumentException("Available funds changed. Refresh the balance and use all again.");
            }
        }
        private boolean coherent() throws Exception {
            NativePaymentInventory first = inventories.get(0); JSONObject firstTip = first.tip();
            for (NativePaymentInventory inventory : inventories) {
                JSONObject tip = inventory.tip();
                if (!inventory.reconciled() || inventory.journalEpoch() != first.journalEpoch() || inventory.throughSequence() != first.throughSequence()
                        || tip.getLong("height") != firstTip.getLong("height") || !tip.getString("hash").equals(firstTip.getString("hash"))
                        || tip.getLong("mediantime") != firstTip.getLong("mediantime")) return false;
            }
            return true;
        }
        private void requireCoherent() throws Exception {
            if (!coherent()) throw new IllegalArgumentException("Wallet funding snapshots changed during synchronization. Review again.");
        }
    }
    private static final class Group {
        final List<JSONObject> accounts;
        final JSONArray addresses;
        final List<NativePaymentInventory> inventories;
        final NativePaymentInventory.RowBudget.Scope scope;
        Group(List<JSONObject> accounts, JSONArray addresses, List<NativePaymentInventory> inventories, NativePaymentInventory.RowBudget.Scope scope) {
            this.accounts = accounts; this.addresses = addresses; this.inventories = inventories; this.scope = scope;
        }
        void discard() {
            scope.close();
            // Completed groups have no active baseline workers. Drop their old
            // rows before a stale cursor forces a replacement baseline.
            for (NativePaymentInventory inventory : inventories) inventory.discard();
        }
    }
    public static HdInventory inventory(JSONArray nativeAccounts, JSONObject reservations, MobilePaymentFunding.Session session) throws Exception {
        return inventory(nativeAccounts, reservations, session, new NativePaymentInventory.RowBudget());
    }
    static HdInventory inventory(JSONArray nativeAccounts, JSONObject reservations, MobilePaymentFunding.Session session,
            NativePaymentInventory.RowBudget budget) throws Exception {
        try { return loadInventory(nativeAccounts, reservations, session, budget); }
        catch (Exception | Error failure) { budget.close(); throw failure; }
    }
    private static HdInventory loadInventory(JSONArray nativeAccounts, JSONObject reservations, MobilePaymentFunding.Session session,
            NativePaymentInventory.RowBudget budget) throws Exception {
        if (nativeAccounts == null || nativeAccounts.length() < 1 || nativeAccounts.length() > 10000) throw new IllegalArgumentException("Invalid native wallet address count.");
        List<JSONObject> accounts = new ArrayList<>(); HashSet<String> addresses = new HashSet<>(), paths = new HashSet<>();
        for (int i = 0; i < nativeAccounts.length(); i++) {
            JSONObject row = nativeAccounts.getJSONObject(i); String address = row.getString("address");
            WalletCrypto.decodeAddress(address);
            if (!(row.opt("index") instanceof Integer) || !(row.opt("change") instanceof Integer) || row.getInt("index") < 0 || row.getInt("change") < 0 || row.getInt("change") > 1
                    || !addresses.add(address) || !paths.add(row.getInt("change") + ":" + row.getInt("index"))) throw new IllegalArgumentException("Invalid native wallet address set.");
            accounts.add(new JSONObject(row.toString()));
        }
        List<Group> groups = new ArrayList<>();
        for (int start = 0; start < accounts.size(); start += 100) {
            groups.add(prepareGroup(new ArrayList<>(accounts.subList(start, Math.min(accounts.size(), start + 100))), reservations, session, null, budget));
        }
        return align(new HdInventory(groups, budget), reservations, session);
    }
    public static HdInventory refresh(HdInventory previous, JSONObject reservations, MobilePaymentFunding.Session session) throws Exception {
        if (previous == null) throw new IllegalArgumentException("Missing HD payment inventory.");
        try {
            List<Group> groups = new ArrayList<>();
            for (Group group : previous.groups) groups.add(prepareGroup(group.accounts, reservations, session, group, previous.budget));
            return align(new HdInventory(groups, previous.budget), reservations, session);
        } catch (Exception | Error failure) { previous.budget.close(); throw failure; }
    }
    private static HdInventory align(HdInventory current, JSONObject reservations, MobilePaymentFunding.Session session) throws Exception {
        // A group uses one shared frozen watermark. Larger wallets require
        // matching group watermarks too; never accept a partial/mixed total.
        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            session.check(); if (current.coherent()) return current;
            List<Group> groups = new ArrayList<>();
            for (Group group : current.groups) groups.add(prepareGroup(group.accounts, reservations, session, group, current.budget));
            current = new HdInventory(groups, current.budget);
        }
        current.requireCoherent(); return current;
    }
    private static Group prepareGroup(List<JSONObject> accounts, JSONObject reservations, MobilePaymentFunding.Session session, Group previous,
            NativePaymentInventory.RowBudget budget) throws Exception {
        JSONArray addresses = new JSONArray(); for (JSONObject account : accounts) addresses.put(account.getString("address"));
        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            session.check();
            NativePaymentInventory.RowBudget.Scope scope = previous == null ? budget.scope() : previous.scope;
            boolean retained = false;
            try {
                List<NativePaymentInventory> inventories;
                if (previous == null) {
                    JSONObject watermark = session.read("getaddresschanges", new JSONObject().put("addresses", addresses), "outputs", 0, accounts.size());
                    inventories = parallel(accounts.size(), session, position -> {
                        JSONObject account = accounts.get(position);
                        NativePaymentInventory inventory = NativePaymentInventory.fromWatermark(account.getString("address"), account.getInt("index"), account.getInt("change"), watermark, reservations, scope);
                        return baselinePages(inventory, session);
                    });
                } else {
                    inventories = previous.inventories;
                    for (NativePaymentInventory inventory : inventories) inventory.beginRefresh(reservations);
                }
                NativePaymentInventory first = inventories.get(0);
                while (!first.reconciled()) {
                    session.check(); JSONObject params = new JSONObject().put("addresses", addresses).put("cursor", first.changesCursor());
                    JSONObject page = session.read("getaddresschanges", params, "outputs", 0, inventories.size());
                    // Validate every event once against this complete native
                    // address set before distributing a shared frozen page.
                    NativeHdWallet.usedAddresses("getaddresschanges", params, page);
                    session.check(); NativePaymentInventory.applySharedChanges(inventories, page);
                }
                session.check(); scope.check(); retained = true;
                return new Group(accounts, addresses, inventories, scope);
            } catch (Exception error) {
                if (previous != null) previous.discard();
                session.check(); if (!stale(error) || attempt + 1 == MAX_ATTEMPTS) throw error; previous = null;
            } finally {
                // Invalidate before a retry can start. An interrupted sibling
                // returning late cannot charge or publish more retained rows.
                if (!retained) scope.close();
            }
        }
        throw new IllegalStateException("HD funding journal could not be reconciled.");
    }
    private interface InventoryTask { NativePaymentInventory read(int position) throws Exception; }
    private static List<NativePaymentInventory> parallel(int size, MobilePaymentFunding.Session session, InventoryTask task) throws Exception {
        // A rolling window frees a slot immediately, even when another address
        // is slow. The shared transport enforces the same sixteen-read bound.
        ExecutorService readers = Executors.newFixedThreadPool(MobileRpcClient.MAX_IN_FLIGHT, runnable -> { Thread thread = new Thread(runnable, "connectwallet-hd-funding"); thread.setDaemon(true); return thread; });
        ExecutorCompletionService<NativePaymentInventory> completed = new ExecutorCompletionService<>(readers);
        List<NativePaymentInventory> result = new ArrayList<>(); HashSet<Future<NativePaymentInventory>> pending = new HashSet<>();
        int rows = 0;
        try {
            int next = 0;
            for (; next < Math.min(size, MobileRpcClient.MAX_IN_FLIGHT); next++) { final int position = next; pending.add(completed.submit(() -> task.read(position))); }
            while (!pending.isEmpty()) {
                session.check(); Future<NativePaymentInventory> future = completed.poll(100, TimeUnit.MILLISECONDS);
                if (future == null) continue;
                pending.remove(future); NativePaymentInventory inventory;
                try { inventory = future.get(); }
                catch (java.util.concurrent.ExecutionException failed) {
                    if (failed.getCause() instanceof Exception) throw (Exception)failed.getCause();
                    throw new IllegalStateException("Could not read wallet funding.", failed);
                }
                rows = Math.addExact(rows, inventory.rowCount());
                if (rows > NativeTransactions.MAX_PAYMENT_CANDIDATES) throw new IllegalArgumentException("Wallet outputs exceed the mobile memory limit.");
                result.add(inventory);
                if (next < size) { final int position = next++; pending.add(completed.submit(() -> task.read(position))); }
            }
            session.check(); return result;
        } finally { for (Future<?> future : pending) future.cancel(true); readers.shutdownNow(); }
    }

    private static NativePaymentInventory prepare(String address, int index, int change, JSONObject reservations,
            MobilePaymentFunding.Session session, NativePaymentInventory previous) throws Exception {
        for (int attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            session.check();
            try {
                NativePaymentInventory inventory;
                if (previous == null) inventory = baseline(address, index, change, reservations, session);
                else { inventory = previous; inventory.beginRefresh(reservations); }
                drain(inventory, session);
                session.check(); return inventory;
            } catch (Exception error) {
                session.check();
                if (!stale(error) || attempt + 1 == MAX_ATTEMPTS) throw error;
                previous = null;
            }
        }
        throw new IllegalStateException("Payment output inventory could not be reconciled.");
    }

    private static boolean stale(Exception error) {
        return error instanceof NativePaymentInventory.SnapshotChanged ||
            error instanceof MobileRpcClient.RpcFailure && "-32011".equals(((MobileRpcClient.RpcFailure)error).code);
    }

    private static NativePaymentInventory baseline(String address, int index, int change, JSONObject reservations,
            MobilePaymentFunding.Session session) throws Exception {
        // Capture first: keyset insertion/removal behind a later page cursor is
        // recovered by replay after every baseline page has been validated.
        JSONObject watermark = session.read("getaddresschanges", changes(address, null), "outputs", 0, 0);
        NativePaymentInventory inventory = NativePaymentInventory.fromWatermark(address, index, change, watermark, reservations);
        return baselinePages(inventory, session);
    }
    private static NativePaymentInventory baselinePages(NativePaymentInventory inventory, MobilePaymentFunding.Session session) throws Exception {
        while (!inventory.complete()) {
            session.check();
            JSONObject params = new JSONObject().put("address", inventory.address()).put("include_pending_spent", true);
            String cursor = inventory.nextCursor(); if (cursor != null) params.put("cursor", cursor);
            JSONObject page = session.read("getaddressutxos", params, "outputs", inventory.rowCount(), 0);
            inventory.accept(page);
        }
        return inventory;
    }

    private static void drain(NativePaymentInventory inventory, MobilePaymentFunding.Session session) throws Exception {
        while (!inventory.reconciled()) {
            session.check();
            JSONObject response = session.read("getaddresschanges", changes(inventory.address(), inventory.changesCursor()),
                "outputs", inventory.rowCount(), 0);
            inventory.applyChanges(response);
        }
    }

    private static JSONObject changes(String address, String cursor) throws Exception {
        JSONObject params = new JSONObject().put("addresses", new JSONArray().put(address));
        if (cursor != null) params.put("cursor", cursor);
        return params;
    }
}
