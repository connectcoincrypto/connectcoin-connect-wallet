package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.NativePaymentChecks;
import com.connectcoincrypto.connectwallet.mobile.alpha.wallet.WalletCrypto;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;

/** Offline synthetic notifications only: no live server, wallet keys or payments. */
public class MobileWalletSubscriptionsTest {
    private static final String ADDRESS = "cc1pljr5t7srjcssh6v5ucna9528khydrjrzkd0mfmlmcc8dhfj576fsfmh0g9";
    private static final String OTHER = "cc1p8w0r8l9z0lanx4h5ghvkfvlfanfjdqn0023x7qez6g6w4nc702nq2p2437";
    private static final String ADDRESS_ID = "11111111-1111-4111-8111-111111111111", TIP_ID = "22222222-2222-4222-8222-222222222222";
    @Test public void subscriptionsUseTheSelectedValidatedHostAndPort() throws Exception {
        Events events = new Events(); AtomicReference<String> hostname = new AtomicReference<>();
        try (Server server = new Server((socket, reader, index) -> { register(socket, reader); hold(reader); });
                MobileWalletSubscriptions client = MobileWalletSubscriptions.localTestClient(events,
                    new MobileRpcClient.TcpEndpoint("CUSTOM.EXAMPLE.COM", server.server.getLocalPort()), host -> {
                        hostname.set(host); return new InetAddress[] { InetAddress.getLoopbackAddress() };
                    })) {
            client.configure(ADDRESS, true); events.expect("connected");
            assertEquals("custom.example.com", hostname.get()); assertEquals(1, server.connections.get());
        }
        assertThrows(IllegalArgumentException.class, () -> new MobileWalletSubscriptions(events, null));
    }
    interface Script { void run(Socket socket, BufferedReader reader, int connection) throws Exception; }
    interface Change { void change(JSONObject value) throws Exception; }
    private static final class Events implements MobileWalletSubscriptions.Listener {
        final BlockingQueue<String> queue = new LinkedBlockingQueue<>();
        final BlockingQueue<MobileWalletSubscriptions.Event> details = new LinkedBlockingQueue<>();
        @Override public void changed(MobileWalletSubscriptions.Event event) { details.add(event); queue.add(event.address + " " + event.reason); }
        void expect(String reason) throws Exception { expect(ADDRESS, reason); }
        void expect(String address, String reason) throws Exception { assertEquals(address + " " + reason, queue.poll(3, TimeUnit.SECONDS)); }
    }
    private static final class Server implements AutoCloseable {
        final ServerSocket server;
        final ExecutorService acceptor = Executors.newSingleThreadExecutor(), handlers = Executors.newFixedThreadPool(2);
        final List<Socket> sockets = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger connections = new AtomicInteger();
        final BlockingQueue<Throwable> errors = new LinkedBlockingQueue<>();
        Server(Script script) throws Exception {
            server = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
            acceptor.execute(() -> {
                try {
                    while (!server.isClosed()) {
                        Socket socket = server.accept(); sockets.add(socket); int index = connections.incrementAndGet();
                        handlers.execute(() -> {
                            try (Socket connection = socket) {
                                socket.setSoTimeout(4000);
                                script.run(socket, new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)), index);
                            } catch (Exception ignored) { /* Cancellation and intentionally malformed frames close the fixture. */ }
                            catch (AssertionError failed) { errors.add(failed); }
                        });
                    }
                } catch (Exception ignored) { /* Fixture shutdown. */ }
            });
        }
        MobileWalletSubscriptions client(Events events) { return client(events, 500, 1000, 500, 500, 500); }
        MobileWalletSubscriptions client(MobileWalletSubscriptions.Listener events, int deadline, int heartbeat, int retry, int retryMax, int quota) {
            return MobileWalletSubscriptions.localTestClient(events, server.getLocalPort(),
                unused -> new InetAddress[]{ InetAddress.getLoopbackAddress() }, deadline, heartbeat, retry, retryMax, quota);
        }
        @Override public void close() throws Exception {
            server.close(); synchronized (sockets) { for (Socket socket : sockets) socket.close(); }
            handlers.shutdownNow(); acceptor.shutdownNow();
            assertTrue(handlers.awaitTermination(3, TimeUnit.SECONDS)); assertTrue(acceptor.awaitTermination(3, TimeUnit.SECONDS));
            if (!errors.isEmpty()) throw new AssertionError(errors.peek());
        }
    }
    private static JSONObject tip() throws Exception { return new JSONObject().put("chain", "main").put("genesis_hash", NativePaymentChecks.GENESIS).put("height", 10).put("hash", "a".repeat(64)).put("mediantime", 1700000000); }
    private static JSONObject request(BufferedReader reader, String method) throws Exception {
        JSONObject request = new JSONObject(reader.readLine()); assertEquals("2.0", request.get("jsonrpc")); assertEquals(method, request.get("method")); assertEquals(4, request.length()); return request;
    }
    private static JSONObject ack(JSONObject request, String id) throws Exception { return reply(request, new JSONObject().put("subscription_id", id).put("tip", tip()).put("cursor", "abc.def").put("changes_only", true)); }
    private static JSONObject tipAck(JSONObject request, String id) throws Exception { return reply(request, new JSONObject().put("subscription_id", id).put("tip", tip()).put("cursor", "abc.def")); }
    private static JSONObject reply(JSONObject request, JSONObject result) throws Exception { return new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id")).put("result", result); }
    private static JSONObject event(String kind, String address) throws Exception {
        JSONObject params = new JSONObject().put("subscription_id", kind.equals("address") ? ADDRESS_ID : TIP_ID).put("kind", kind).put("tip", tip()).put("reorg", false);
        if (kind.equals("address")) params.put("address", address).put("refresh", true);
        return new JSONObject().put("jsonrpc", "2.0").put("method", "subscription").put("params", params);
    }
    private static byte[] bytes(JSONObject value) { return (value + "\n").getBytes(StandardCharsets.UTF_8); }
    private static void write(Socket socket, JSONObject value) throws Exception { socket.getOutputStream().write(bytes(value)); socket.getOutputStream().flush(); }
    private static String register(Socket socket, BufferedReader reader) throws Exception {
        JSONObject address = request(reader, "subscribeaddress"); String own = address.getJSONObject("params").getString("address");
        assertEquals(2, address.getJSONObject("params").length()); assertEquals(Boolean.TRUE, address.getJSONObject("params").get("changes_only"));
        write(socket, ack(address, ADDRESS_ID)); registerTip(socket, reader); return own;
    }
    private static void registerTip(Socket socket, BufferedReader reader) throws Exception {
        JSONObject request = request(reader, "subscribetip"); assertEquals(0, request.getJSONObject("params").length()); write(socket, tipAck(request, TIP_ID));
    }
    private static void hold(BufferedReader reader) throws Exception { while (reader.readLine() != null) { /* Keep fixture alive until native closes it. */ } }

    @Test public void fragmentedCoalescedEventsAroundRegistrationHaveNoCatchupGap() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> {
            JSONObject address = request(reader, "subscribeaddress"); byte[] first = bytes(ack(address, ADDRESS_ID));
            // An address notification can arrive before its registration ACK.
            write(socket, event("address", ADDRESS));
            socket.getOutputStream().write(first, 0, 7); socket.getOutputStream().flush();
            socket.getOutputStream().write(first, 7, first.length - 7); socket.getOutputStream().flush();
            registerTip(socket, reader);
            socket.getOutputStream().write((event("address", ADDRESS) + "\n" + event("address", ADDRESS) + "\n").getBytes(StandardCharsets.UTF_8)); socket.getOutputStream().flush(); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events)) {
            client.configure(ADDRESS, true); events.expect("connected"); events.expect("address"); events.expect("address");
            assertTrue(client.isConnected(ADDRESS)); assertFalse(client.isConnected(OTHER)); assertEquals(1, server.connections.get());
            MobileWalletSubscriptions.Event connected = events.details.remove();
            assertFalse(connected.reorg); assertFalse(connected.resyncRequired);
            assertEquals(List.of(ADDRESS), connected.changedAddresses);
        }
    }
    @Test public void wrongRequestIdCannotRegister() throws Exception {
        rejectedAck(value -> value.put("id", "unrequested"));
    }
    @Test public void legacyServerRejectionNeverFallsBackToBroadAddressSubscription() throws Exception {
        Events events = new Events(); AtomicInteger strictRequests = new AtomicInteger();
        try (Server server = new Server((socket, reader, index) -> {
            JSONObject request = request(reader, "subscribeaddress"), params = request.getJSONObject("params");
            assertEquals(2, params.length()); assertEquals(Boolean.TRUE, params.get("changes_only")); strictRequests.incrementAndGet();
            write(socket, new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
                .put("error", new JSONObject().put("code", -32602).put("message", "Unexpected parameters.")));
            assertNull(reader.readLine());
        }); MobileWalletSubscriptions client = server.client(events, 500, 1000, 50, 100, 200)) {
            client.configure(ADDRESS, true); events.expect("disconnected"); events.expect("disconnected");
            assertFalse(client.isConnected(ADDRESS)); assertEquals(2, strictRequests.get());
        }
    }
    @Test public void ordinaryTipNotificationOnlyProjectsPublicTipAndAddressEventRemainsDistinct() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> {
            register(socket, reader); write(socket, event("tip", ADDRESS)); write(socket, event("address", ADDRESS)); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events)) {
            client.configure(ADDRESS, true); events.expect("connected"); events.expect("tip"); events.expect("address");
            assertTrue(client.isConnected(ADDRESS)); assertTrue(events.queue.isEmpty());
            events.details.remove(); MobileWalletSubscriptions.Event tip = events.details.remove();
            assertEquals(10, tip.tip.getInt("height")); assertFalse(tip.reorg); assertFalse(tip.resyncRequired);
        }
    }
    @Test public void tipRegistrationRequiresExactPinnedSchemaAndDistinctSubscriptionId() throws Exception {
        for (Change change : new Change[]{ value -> value.getJSONObject("result").put("subscription_id", ADDRESS_ID),
                value -> value.getJSONObject("result").put("changes_only", true),
                value -> value.getJSONObject("result").put("cursor", "invalid"),
                value -> value.getJSONObject("result").getJSONObject("tip").put("chain", "testnet4"),
                value -> value.put("id", "unrequested"),
                value -> { value.remove("result"); value.put("error", new JSONObject().put("code", -32601).put("message", "Unsupported method")); } }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> {
                write(socket, ack(request(reader, "subscribeaddress"), ADDRESS_ID));
                JSONObject response = tipAck(request(reader, "subscribetip"), TIP_ID); change.change(response); write(socket, response); hold(reader);
            }); MobileWalletSubscriptions client = server.client(events)) {
                client.configure(ADDRESS, true); events.expect("disconnected"); assertFalse(client.isConnected(ADDRESS)); assertTrue(events.queue.isEmpty());
            }
        }
    }
    @Test public void malformedTipNotificationsCannotBeDelivered() throws Exception {
        for (Change change : new Change[]{ value -> value.getJSONObject("params").put("subscription_id", ADDRESS_ID),
                value -> value.getJSONObject("params").put("reorg", 1),
                value -> value.getJSONObject("params").put("refresh", true),
                value -> value.getJSONObject("params").getJSONObject("tip").put("genesis_hash", "b".repeat(64)) }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> {
                register(socket, reader); JSONObject message = event("tip", ADDRESS); change.change(message); write(socket, message); hold(reader);
            }); MobileWalletSubscriptions client = server.client(events)) {
                client.configure(ADDRESS, true); events.expect("connected"); events.expect("disconnected"); assertTrue(events.queue.isEmpty());
            }
        }
    }
    @Test public void reorgSurvivesRegistrationBufferAndBothNotificationKinds() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> {
            write(socket, ack(request(reader, "subscribeaddress"), ADDRESS_ID));
            JSONObject request = request(reader, "subscribetip"), reset = event("address", ADDRESS);
            reset.getJSONObject("params").put("reorg", true); write(socket, reset); write(socket, tipAck(request, TIP_ID));
            for (String kind : new String[]{"tip", "address"}) {
                JSONObject message = event(kind, ADDRESS); message.getJSONObject("params").put("reorg", true); write(socket, message);
            }
            hold(reader);
        }); MobileWalletSubscriptions client = server.client(events)) {
            client.configure(ADDRESS, true); events.expect("connected"); events.expect("tip"); events.expect("address");
            for (int i = 0; i < 3; i++) {
                MobileWalletSubscriptions.Event detail = events.details.remove();
                assertTrue(detail.reorg); assertNotNull(detail.tip);
                // An actual reorg remains distinct from registration catch-up.
                assertFalse(detail.resyncRequired);
                if (i == 0) assertEquals(List.of(ADDRESS), detail.changedAddresses);
            }
        }
    }
    @Test public void queuedOldConnectionAndLifecycleEventsCannotReviveAfterReconnect() throws Exception {
        Events events = new Events(); CountDownLatch closeFirst = new CountDownLatch(1);
        try (Server server = new Server((socket, reader, index) -> {
            register(socket, reader); if (index == 1) closeFirst.await(3, TimeUnit.SECONDS); else hold(reader);
        }); MobileWalletSubscriptions client = server.client(events, 500, 1000, 30, 100, 200)) {
            client.configure(ADDRESS, true); events.expect("connected"); MobileWalletSubscriptions.Event first = events.details.remove();
            assertTrue(client.isCurrent(first)); closeFirst.countDown(); events.expect("disconnected"); events.expect("connected");
            MobileWalletSubscriptions.Event disconnected = events.details.remove(), second = events.details.remove();
            assertFalse(client.isCurrent(first)); assertFalse(client.isCurrent(disconnected)); assertTrue(client.isCurrent(second));
            client.configure(ADDRESS, false); client.configure(ADDRESS, true); events.expect("connected"); assertFalse(client.isCurrent(second));
        }
    }
    @Test public void nativeCoalescingPreservesCatchupAddressResetAndLatestTipWithoutCrossingConnections() throws Exception {
        MobileWalletSubscriptions.Event ordinary = hint("tip", 10, false, false, 1);
        MobileWalletSubscriptions.Event address = hint("address", 10, false, false, 1);
        MobileWalletSubscriptions.Event latest = hint("tip", 11, false, false, 1);
        MobileWalletSubscriptions.Event combined = MobileWalletSubscriptions.Event.merge(address, latest);
        assertEquals("address", combined.reason); assertEquals(11, combined.tip.getInt("height"));
        combined = MobileWalletSubscriptions.Event.merge(hint("connected", 10, false, false, 1), combined);
        assertEquals("connected", combined.reason);
        combined = MobileWalletSubscriptions.Event.merge(hint("tip", 10, true, true, 1), latest);
        assertTrue(combined.reorg); assertTrue(combined.resyncRequired);
        combined = MobileWalletSubscriptions.Event.merge(ordinary, hint("tip", 9, false, false, 1));
        combined = MobileWalletSubscriptions.Event.merge(combined, latest); assertTrue(combined.reorg);
        combined = MobileWalletSubscriptions.Event.merge(ordinary,
            new MobileWalletSubscriptions.Event(ADDRESS, "tip", tip().put("hash", "b".repeat(64)), false, false, 1, 1));
        assertTrue(combined.reorg);
        MobileWalletSubscriptions.Event disconnected = new MobileWalletSubscriptions.Event(ADDRESS, "disconnected", null, false, false, 1, 1);
        assertSame(disconnected, MobileWalletSubscriptions.Event.merge(combined, disconnected));
        MobileWalletSubscriptions.Event reconnected = hint("connected", 11, false, false, 2);
        assertSame(reconnected, MobileWalletSubscriptions.Event.merge(combined, reconnected));
        assertFalse(reconnected.reorg); assertFalse(reconnected.resyncRequired);
    }
    private static MobileWalletSubscriptions.Event hint(String reason, int height, boolean reorg, boolean resync, long connection) throws Exception {
        return new MobileWalletSubscriptions.Event(ADDRESS, reason, tip().put("height", height).put("hash", String.format("%064x", height)), reorg, resync, 1, connection);
    }
    @Test public void registrationRequiresExactSchemaPinnedGenesisChainAndTip() throws Exception {
        for (Change change : new Change[]{ value -> value.getJSONObject("result").getJSONObject("tip").put("genesis_hash", "b".repeat(64)),
                value -> value.getJSONObject("result").getJSONObject("tip").put("chain", "testnet4"),
                value -> value.getJSONObject("result").getJSONObject("tip").put("height", "10"),
                value -> value.getJSONObject("result").getJSONObject("tip").put("height", -1),
                value -> value.getJSONObject("result").getJSONObject("tip").put("height", 0),
                value -> value.getJSONObject("result").put("subscription_id", "arbitrary"),
                value -> value.getJSONObject("result").put("cursor", "invalid"),
                value -> value.getJSONObject("result").remove("changes_only"),
                value -> value.getJSONObject("result").put("changes_only", false),
                value -> value.getJSONObject("result").put("changes_only", "true"),
                value -> value.getJSONObject("result").put("unexpected", true), value -> value.put("jsonrpc", "1.0") }) rejectedAck(change);
    }
    private static void rejectedAck(Change change) throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> {
            JSONObject ack = ack(request(reader, "subscribeaddress"), ADDRESS_ID); change.change(ack); write(socket, ack); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events)) {
            client.configure(ADDRESS, true); events.expect("disconnected"); assertFalse(client.isConnected(ADDRESS)); assertTrue(events.queue.isEmpty());
        }
    }
    @Test public void notificationsRequireRegisteredIdOwnAddressExactShapeAndPinnedTip() throws Exception {
        for (Change change : new Change[]{ value -> value.getJSONObject("params").put("subscription_id", TIP_ID),
                value -> value.getJSONObject("params").put("address", OTHER), value -> value.getJSONObject("params").put("refresh", false),
                value -> value.getJSONObject("params").put("reorg", "false"), value -> value.getJSONObject("params").put("kind", "bounties"),
                value -> value.getJSONObject("params").put("balance", "100000"),
                value -> value.getJSONObject("params").getJSONObject("tip").put("genesis_hash", "b".repeat(64)),
                value -> value.put("method", "unrecognized"), value -> value.put("id", "unsolicited") }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> {
                register(socket, reader); JSONObject message = event("address", ADDRESS); change.change(message); write(socket, message); hold(reader);
            }); MobileWalletSubscriptions client = server.client(events)) {
                client.configure(ADDRESS, true); events.expect("connected"); events.expect("disconnected"); assertFalse(client.isConnected(ADDRESS)); assertTrue(events.queue.isEmpty());
            }
        }
    }
    @Test public void registrationBufferIsBoundedAndUnknownEventIdsFailBeforeConnected() throws Exception {
        for (boolean overflow : new boolean[]{ false, true }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> {
                JSONObject address = request(reader, "subscribeaddress");
                JSONObject event = event("address", ADDRESS); if (!overflow) event.getJSONObject("params").put("subscription_id", "33333333-3333-4333-8333-333333333333");
                for (int i = 0; i < (overflow ? 17 : 1); i++) write(socket, event);
                write(socket, ack(address, ADDRESS_ID)); if (!overflow) registerTip(socket, reader); hold(reader);
            }); MobileWalletSubscriptions client = server.client(events)) {
                client.configure(ADDRESS, true); events.expect("disconnected"); assertFalse(client.isConnected(ADDRESS)); assertTrue(events.queue.isEmpty());
            }
        }
    }
    @Test public void quietSocketUsesBoundedHeartbeatWithoutBalancePollingOrReconnect() throws Exception {
        Events events = new Events(); CountDownLatch heartbeats = new CountDownLatch(2);
        try (Server server = new Server((socket, reader, index) -> {
            register(socket, reader);
            int height = 10;
            while (true) {
                // Registration is complete; idle requests only check liveness,
                // never balances, history or UTXOs.
                JSONObject ping = request(reader, "getchaintip"); assertEquals(0, ping.getJSONObject("params").length());
                write(socket, reply(ping, tip().put("height", ++height).put("hash", String.format("%064x", height)))); heartbeats.countDown();
            }
        }); MobileWalletSubscriptions client = server.client(events, 500, 80, 500, 500, 500)) {
            client.configure(ADDRESS, true); events.expect("connected"); assertTrue(heartbeats.await(3, TimeUnit.SECONDS));
            assertTrue(client.isConnected(ADDRESS)); assertEquals(1, server.connections.get()); assertTrue(events.queue.isEmpty());
        }
    }
    @Test public void eofReconnectAlwaysRequestsCatchupEvenWhenNoNotificationsOccurred() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> { register(socket, reader); if (index > 1) hold(reader); });
                MobileWalletSubscriptions client = server.client(events, 500, 1000, 30, 100, 200)) {
            client.configure(ADDRESS, true); events.expect("connected"); events.expect("disconnected"); events.expect("connected"); assertEquals(2, server.connections.get());
            MobileWalletSubscriptions.Event first = events.details.remove(), disconnected = events.details.remove(), reconnected = events.details.remove();
            assertEquals("connected", first.reason); assertEquals("disconnected", disconnected.reason); assertEquals("connected", reconnected.reason);
            assertFalse(first.resyncRequired); assertFalse(first.reorg);
            assertFalse(reconnected.resyncRequired); assertFalse(reconnected.reorg);
            assertTrue(reconnected.connection > first.connection);
            assertTrue(client.isCurrent(reconnected));
        }
    }
    @Test public void missingOrWrongNetworkHeartbeatCannotKeepConnectionMarkedReady() throws Exception {
        for (boolean missing : new boolean[]{ false, true }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> {
                register(socket, reader); JSONObject ping = request(reader, "getchaintip");
                if (!missing) write(socket, reply(ping, tip().put("genesis_hash", "b".repeat(64))));
                hold(reader);
            }); MobileWalletSubscriptions client = server.client(events, 100, 80, 500, 500, 500)) {
                client.configure(ADDRESS, true); events.expect("connected"); events.expect("disconnected"); assertFalse(client.isConnected(ADDRESS));
            }
        }
    }
    @Test public void startsInactiveAndRejectsForeignOrInvalidAddressBeforeConnecting() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> { register(socket, reader); hold(reader); }); MobileWalletSubscriptions client = server.client(events)) {
            assertFalse(client.isConnected(ADDRESS)); client.configure(null, true); client.configure("", true); client.configure(ADDRESS, false);
            assertNull(events.queue.poll(30, TimeUnit.MILLISECONDS)); assertEquals(0, server.connections.get());
            for (String invalid : new String[]{ ADDRESS.substring(0, 61) + "z", "t" + ADDRESS, "https://example.com", ADDRESS.substring(0, 5).toUpperCase() + ADDRESS.substring(5) }) {
                try { client.configure(invalid, true); fail("Invalid account was accepted"); } catch (IllegalArgumentException expected) { /* Native caller must supply its own canonical mainnet account. */ }
            }
            assertEquals(0, server.connections.get()); client.configure(ADDRESS, true); events.expect("connected");
        }
    }
    @Test public void stalledRegistrationAndPartialFramesHaveFiniteDeadline() throws Exception {
        for (boolean partial : new boolean[]{ false, true }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> {
                request(reader, "subscribeaddress");
                if (partial) { socket.getOutputStream().write('{'); socket.getOutputStream().flush(); } hold(reader);
            }); MobileWalletSubscriptions client = server.client(events, 100, 1000, 500, 500, 500)) {
                client.configure(ADDRESS, true); events.expect("disconnected"); assertFalse(client.isConnected(ADDRESS));
            }
        }
    }
    @Test public void malformedOversizedUtf8AndDuplicateJsonFieldsFailClosed() throws Exception {
        for (byte[] malformed : new byte[][]{ new byte[]{(byte)0xc0, (byte)0xaf, '\n'}, ("x".repeat(MobileWalletSubscriptions.MAX_FRAME + 1) + "\n").getBytes(StandardCharsets.UTF_8),
                "{\"jsonrpc\":\"2.0\",\"jsonrpc\":\"2.0\"}\n".getBytes(StandardCharsets.UTF_8), "[]\n".getBytes(StandardCharsets.UTF_8) }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> { request(reader, "subscribeaddress"); socket.getOutputStream().write(malformed); socket.getOutputStream().flush(); hold(reader); });
                    MobileWalletSubscriptions client = server.client(events)) {
                client.configure(ADDRESS, true); events.expect("disconnected"); assertFalse(client.isConnected(ADDRESS));
            }
        }
    }
    @Test public void idempotentConfigureAccountSwitchPauseResumeAndCloseFenceGenerations() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> { register(socket, reader); hold(reader); }); MobileWalletSubscriptions client = server.client(events)) {
            client.configure(ADDRESS, true); events.expect("connected");
            for (int i = 0; i < 100; i++) client.configure(ADDRESS, true);
            assertEquals(1, server.connections.get()); assertTrue(client.isConnected(ADDRESS));
            client.configure(OTHER, true); assertFalse(client.isConnected(ADDRESS)); events.expect(OTHER, "connected");
            client.configure(OTHER, false); assertFalse(client.isConnected(OTHER)); assertTrue(events.queue.isEmpty());
            client.configure(OTHER, true); events.expect(OTHER, "connected");
            while (!events.details.isEmpty()) {
                MobileWalletSubscriptions.Event connected = events.details.remove();
                assertEquals("connected", connected.reason);
                assertFalse(connected.resyncRequired); assertFalse(connected.reorg);
            }
            client.close(); assertFalse(client.isConnected(OTHER)); client.configure(ADDRESS, true); assertTrue(events.queue.isEmpty());
        }
    }
    @Test public void quotaCooldownSurvivesPauseResumeAndDoesNotReconnectRapidly() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> {
            JSONObject address = request(reader, "subscribeaddress"); write(socket, new JSONObject().put("jsonrpc", "2.0").put("id", address.get("id"))
                .put("error", new JSONObject().put("code", -32029).put("message", "Limited").put("data", new JSONObject().put("retry_after_ms", 1)))); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events, 500, 1000, 10, 20, 500)) {
            client.configure(ADDRESS, true); events.expect("disconnected");
            client.configure(ADDRESS, false); client.configure(ADDRESS, true);
            assertNull(events.queue.poll(200, TimeUnit.MILLISECONDS)); assertEquals(1, server.connections.get());
            events.expect("disconnected"); assertEquals(2, server.connections.get());
        }
    }
    @Test public void stalledDnsCannotBlockLifecycleOrCreateMoreResolverThreads() throws Exception {
        Events events = new Events(); CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1); AtomicInteger calls = new AtomicInteger();
        MobileWalletSubscriptions.Resolver resolver = unused -> {
            calls.incrementAndGet(); entered.countDown();
            while (release.getCount() > 0) try { release.await(); } catch (InterruptedException ignored) { /* Mimic uninterruptible OS DNS. */ }
            return new InetAddress[]{ InetAddress.getLoopbackAddress() };
        };
        try (MobileWalletSubscriptions client = MobileWalletSubscriptions.localTestClient(events, 1, resolver, 100, 1000, 10, 20, 200)) {
            client.configure(ADDRESS, true); assertTrue(entered.await(2, TimeUnit.SECONDS)); events.expect("disconnected");
            long started = System.nanoTime();
            for (int i = 0; i < 100; i++) { client.configure(ADDRESS, false); client.configure(OTHER, true); }
            client.close(); assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 300); assertEquals(1, calls.get());
        } finally { release.countDown(); }
    }
    @Test public void callbacksCanReconfigureWithoutDeadlockAndNeverRunInline() throws Exception {
        AtomicReference<MobileWalletSubscriptions> reference = new AtomicReference<>(); CountDownLatch callback = new CountDownLatch(1);
        Thread testThread = Thread.currentThread();
        try (Server server = new Server((socket, reader, index) -> { register(socket, reader); hold(reader); });
                MobileWalletSubscriptions client = server.client(event -> {
                    assertNotSame(testThread, Thread.currentThread()); reference.get().configure(event.address, false); callback.countDown();
                }, 500, 1000, 500, 500, 500)) {
            reference.set(client); client.configure(ADDRESS, true); assertTrue(callback.await(3, TimeUnit.SECONDS)); assertFalse(client.isConnected(ADDRESS));
        }
    }
    @Test public void multipleOwnedAddressesShareOneSocketAndKeepStableWalletIdentity() throws Exception {
        Events events = new Events(); String secondId = subscriptionId(2);
        try (Server server = new Server((socket, reader, index) -> {
            assertEquals(OTHER, register(socket, reader));
            JSONObject second = request(reader, "subscribeaddress");
            assertEquals(ADDRESS, second.getJSONObject("params").getString("address"));
            assertEquals(Boolean.TRUE, second.getJSONObject("params").get("changes_only"));
            assertEquals(2, second.getJSONObject("params").length());
            write(socket, ack(second, secondId));
            write(socket, event("address", OTHER));
            JSONObject changed = event("address", ADDRESS); changed.getJSONObject("params").put("subscription_id", secondId); write(socket, changed);
            write(socket, event("tip", ADDRESS)); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events)) {
            client.configure(ADDRESS, List.of(OTHER, ADDRESS, OTHER), true);
            events.expect("connected"); events.expect("address"); events.expect("address"); events.expect("tip");
            assertEquals(1, server.connections.get()); assertTrue(client.isConnected(ADDRESS)); assertFalse(client.isConnected(OTHER));
            assertEquals(2, client.watchedAddressCount(ADDRESS)); assertEquals(2, client.requestedAddressCount(ADDRESS));
            assertFalse(client.isCoverageLimited(ADDRESS));
            MobileWalletSubscriptions.Event connected = events.details.remove();
            assertEquals(2, connected.watched); assertEquals(2, connected.total); assertFalse(connected.coverageLimited);
            assertEquals(List.of(OTHER), events.details.remove().changedAddresses);
            assertEquals(List.of(ADDRESS), events.details.remove().changedAddresses);
            assertTrue(events.details.remove().changedAddresses.isEmpty());
            for (int i = 0; i < 10; i++) client.configure(ADDRESS, List.of(OTHER, ADDRESS, OTHER), true);
            assertEquals(1, server.connections.get());
        }
    }
    @Test public void addressChangeMergingPreservesAllDistinctOwnedHintsAndIsBounded() throws Exception {
        MobileWalletSubscriptions.Event first = new MobileWalletSubscriptions.Event(ADDRESS, "address", tip(), false, false, 1, 1, List.of(OTHER), 2, 2);
        MobileWalletSubscriptions.Event second = new MobileWalletSubscriptions.Event(ADDRESS, "address", tip(), false, false, 1, 1, List.of(ADDRESS), 2, 2);
        MobileWalletSubscriptions.Event merged = MobileWalletSubscriptions.Event.merge(first, second);
        merged = MobileWalletSubscriptions.Event.merge(merged, first);
        merged = MobileWalletSubscriptions.Event.merge(merged,
            new MobileWalletSubscriptions.Event(ADDRESS, "tip", tip(), false, false, 1, 1, List.of(), 2, 2));
        assertEquals(List.of(OTHER, ADDRESS), merged.changedAddresses); assertEquals("address", merged.reason);
        assertFalse(merged.resyncRequired);
        try { merged.changedAddresses.add(ADDRESS); fail("Hints must be immutable"); } catch (UnsupportedOperationException expected) {}
        List<String> many = syntheticAddresses(100);
        MobileWalletSubscriptions.Event bounded = new MobileWalletSubscriptions.Event(ADDRESS, "address", tip(), false, false, 1, 1, many, 99, 100);
        assertEquals(99, bounded.changedAddresses.size()); assertTrue(bounded.resyncRequired); assertTrue(bounded.coverageLimited);
        first = new MobileWalletSubscriptions.Event(ADDRESS, "address", tip(), false, false, 1, 1, many.subList(0, 60), 99, 100);
        second = new MobileWalletSubscriptions.Event(ADDRESS, "address", tip(), false, false, 1, 1, many.subList(60, 100), 99, 100);
        bounded = MobileWalletSubscriptions.Event.merge(first, second);
        assertEquals(99, bounded.changedAddresses.size()); assertTrue(bounded.resyncRequired);
    }
    @Test public void ninetyNineAddressCapIsExplicitAndPreservesCallerPriority() throws Exception {
        List<String> addresses = syntheticAddresses(100); addresses.set(99, ADDRESS);
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> {
            assertEquals(addresses.get(0), register(socket, reader));
            for (int i = 1; i < 99; i++) {
                JSONObject request = request(reader, "subscribeaddress");
                assertEquals(addresses.get(i), request.getJSONObject("params").getString("address"));
                assertEquals(Boolean.TRUE, request.getJSONObject("params").get("changes_only"));
                write(socket, ack(request, subscriptionId(i)));
            }
            // Exactly one tip plus 99 watches, then heartbeat only. Never another address query.
            JSONObject ping = request(reader, "getchaintip"); write(socket, reply(ping, tip())); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events, 1000, 100, 500, 500, 500)) {
            client.configure(ADDRESS, addresses, true); events.expect("connected");
            MobileWalletSubscriptions.Event connected = events.details.remove();
            assertTrue(connected.coverageLimited); assertEquals(99, connected.watched); assertEquals(100, connected.total);
            assertTrue(client.isCoverageLimited(ADDRESS)); assertEquals(99, client.watchedAddressCount(ADDRESS));
            assertEquals(100, client.requestedAddressCount(ADDRESS)); assertEquals(1, server.connections.get());
        }
    }
    @Test public void sharedIpCapacityKeepsExistingWatchesAndReportsPartialCoverage() throws Exception {
        Events events = new Events(); CountDownLatch heartbeat = new CountDownLatch(1);
        try (Server server = new Server((socket, reader, index) -> {
            register(socket, reader); JSONObject second = request(reader, "subscribeaddress");
            write(socket, new JSONObject().put("jsonrpc", "2.0").put("id", second.get("id"))
                .put("error", new JSONObject().put("code", -32005).put("message", "Subscription limit reached")));
            JSONObject ping = request(reader, "getchaintip"); write(socket, reply(ping, tip())); heartbeat.countDown(); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events, 500, 100, 500, 500, 500)) {
            client.configure(ADDRESS, List.of(ADDRESS, OTHER), true); events.expect("connected");
            MobileWalletSubscriptions.Event connected = events.details.remove();
            assertEquals(1, connected.watched); assertEquals(2, connected.total); assertTrue(connected.coverageLimited);
            assertTrue(client.isConnected(ADDRESS)); assertTrue(client.isCoverageLimited(ADDRESS));
            assertTrue(heartbeat.await(3, TimeUnit.SECONDS)); assertEquals(1, server.connections.get()); assertTrue(events.queue.isEmpty());
        }
    }
    @Test public void multiaddressRegistrationRejectsDuplicateIdsAndMissingChangesOnlyAck() throws Exception {
        for (boolean duplicate : new boolean[] { false, true }) {
            Events events = new Events();
            try (Server server = new Server((socket, reader, index) -> {
                register(socket, reader); JSONObject second = ack(request(reader, "subscribeaddress"), duplicate ? ADDRESS_ID : subscriptionId(2));
                if (!duplicate) second.getJSONObject("result").remove("changes_only"); write(socket, second); hold(reader);
            }); MobileWalletSubscriptions client = server.client(events)) {
                client.configure(ADDRESS, List.of(ADDRESS, OTHER), true); events.expect("disconnected");
                assertFalse(client.isConnected(ADDRESS)); assertTrue(events.queue.isEmpty());
            }
        }
    }
    @Test public void foreignOrSwappedAddressNotificationCannotUseAnotherRegisteredId() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> {
            register(socket, reader); write(socket, ack(request(reader, "subscribeaddress"), subscriptionId(2)));
            // OTHER is owned, but it is not bound to ADDRESS_ID.
            write(socket, event("address", OTHER)); hold(reader);
        }); MobileWalletSubscriptions client = server.client(events)) {
            client.configure(ADDRESS, List.of(ADDRESS, OTHER), true); events.expect("connected"); events.expect("disconnected");
            assertTrue(events.queue.isEmpty());
        }
    }
    @Test public void changingInventoryFencesOldEventsAndInvalidInventoryFailsBeforeConnecting() throws Exception {
        Events events = new Events();
        try (Server server = new Server((socket, reader, index) -> { register(socket, reader); hold(reader); }); MobileWalletSubscriptions client = server.client(events)) {
            for (List<String> invalid : List.of(List.<String>of(), List.of(OTHER), List.of(ADDRESS, "invalid"))) {
                try { client.configure(ADDRESS, invalid, true); fail("Invalid inventory accepted"); } catch (IllegalArgumentException expected) {}
            }
            try { client.configure(ADDRESS, null, true); fail(); } catch (IllegalArgumentException expected) {}
            try { client.configure(ADDRESS, Collections.nCopies(10001, ADDRESS), true); fail(); } catch (IllegalArgumentException expected) {}
            assertEquals(0, server.connections.get());
            client.configure(ADDRESS, List.of(ADDRESS), true); events.expect("connected"); MobileWalletSubscriptions.Event first = events.details.remove();
            client.configure(ADDRESS, List.of(OTHER, ADDRESS), true); assertFalse(client.isCurrent(first)); assertFalse(client.isConnected(ADDRESS));
            client.configure(ADDRESS, List.of(), false); assertEquals(0, client.watchedAddressCount(ADDRESS)); assertEquals(0, client.requestedAddressCount(ADDRESS));
        }
    }
    private static String subscriptionId(int index) { return String.format("33333333-3333-4333-8333-%012x", index); }
    private static List<String> syntheticAddresses(int count) {
        ArrayList<String> result = new ArrayList<>();
        for (int counter = 1; result.size() < count; counter++) {
            byte[] x = new byte[32]; x[28] = (byte)(counter >>> 24); x[29] = (byte)(counter >>> 16); x[30] = (byte)(counter >>> 8); x[31] = (byte)counter;
            try { result.add(WalletCrypto.encodeAddress(x)); } catch (IllegalArgumentException invalidPoint) { /* Public test points only. */ }
        }
        return result;
    }
}
