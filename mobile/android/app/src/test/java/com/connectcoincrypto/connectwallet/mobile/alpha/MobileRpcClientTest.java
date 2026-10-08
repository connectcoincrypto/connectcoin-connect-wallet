package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Offline plaintext TCP loopback. Synthetic transaction bytes never leave the fixture. */
public class MobileRpcClientTest {
    private static final String ADDRESS = "cc1pljr5t7srjcssh6v5ucna9528khydrjrzkd0mfmlmcc8dhfj576fsfmh0g9";
    private static final String HASH = "a".repeat(64), HEX = "00".repeat(10);
    interface Reply { byte[] handle(JSONObject request, Socket socket) throws Exception; }
    private static final class Server implements AutoCloseable {
        final ServerSocket listener;
        final ExecutorService acceptor = Executors.newSingleThreadExecutor(), readers = Executors.newCachedThreadPool(), handlers = Executors.newFixedThreadPool(16);
        final List<Socket> sockets = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger requests = new AtomicInteger(), connections = new AtomicInteger(), firstCharacter = new AtomicInteger(-1);
        Server(Reply reply) throws Exception {
            listener = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
            acceptor.execute(() -> {
                try {
                    while (!listener.isClosed()) {
                        Socket socket = listener.accept(); connections.incrementAndGet(); sockets.add(socket);
                        readers.execute(() -> {
                            try (Socket connection = socket) {
                                BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                                String line;
                                while ((line = input.readLine()) != null) {
                                    if (!line.isEmpty()) firstCharacter.compareAndSet(-1, line.charAt(0));
                                    JSONObject request = new JSONObject(line); requests.incrementAndGet();
                                    handlers.execute(() -> {
                                        try {
                                            byte[] response = reply.handle(request, socket);
                                            if (response == null) socket.close();
                                            else synchronized (socket) { socket.getOutputStream().write(response); socket.getOutputStream().flush(); }
                                        } catch (Exception ignored) { try { socket.close(); } catch (Exception closed) { } }
                                    });
                                }
                            } catch (Exception ignored) { /* Expected when cancelling or closing malformed fixtures. */ }
                        });
                    }
                } catch (Exception ignored) { /* Fixture shutdown releases accept. */ }
            });
        }
        MobileRpcClient client(int timeout) {
            return client(timeout, 60000);
        }
        MobileRpcClient client(int timeout, long windowMs) {
            MobileRpcClient client = MobileRpcClient.localTestClient("localhost", listener.getLocalPort(),
                unused -> new InetAddress[] { InetAddress.getLoopbackAddress() }, timeout, windowMs);
            client.setActive(true); return client;
        }
        @Override public void close() throws java.io.IOException {
            try { listener.close(); synchronized (sockets) { for (Socket socket : sockets) socket.close(); } }
            finally {
                handlers.shutdownNow(); readers.shutdownNow(); acceptor.shutdownNow();
                try { assertTrue(handlers.awaitTermination(3, TimeUnit.SECONDS)); assertTrue(readers.awaitTermination(3, TimeUnit.SECONDS)); assertTrue(acceptor.awaitTermination(3, TimeUnit.SECONDS)); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError("TCP fixture shutdown interrupted", interrupted); }
            }
        }
    }
    private static byte[] response(JSONObject request, JSONObject result) throws Exception {
        return bytes(new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id")).put("result", result));
    }
    private static byte[] bytes(JSONObject json) { return (json + "\n").getBytes(StandardCharsets.UTF_8); }
    private static JSONObject params() throws Exception { return new JSONObject().put("address", ADDRESS); }
    private static JSONObject await(CompletableFuture<JSONObject> future) throws Exception { return future.get(5, TimeUnit.SECONDS); }
    private static MobileRpcClient.RpcFailure error(CompletableFuture<JSONObject> future, String code) throws Exception {
        try { await(future); fail("Expected " + code); return null; }
        catch (ExecutionException failed) {
            assertTrue(failed.getCause() instanceof MobileRpcClient.RpcFailure);
            MobileRpcClient.RpcFailure error = (MobileRpcClient.RpcFailure) failed.getCause(); assertEquals(code, error.code); return error;
        }
    }
    private static void invalid(String method, JSONObject params) throws Exception {
        try { MobileRpcClient.validateParams(method, params); fail("Accepted invalid method/parameters"); }
        catch (MobileRpcClient.RpcFailure error) {
            assertEquals("RPC_INVALID", error.code); assertEquals("", error.method); assertEquals("", error.phase);
            assertEquals(0, error.elapsedMs); assertEquals(0, error.queuedMs); assertEquals(0, error.bytesReceived);
        }
    }
    private static void diagnostic(MobileRpcClient.RpcFailure failure, String method, String phase) {
        assertEquals(method, failure.method); assertEquals(phase, failure.phase);
        assertTrue(failure.elapsedMs >= 0); assertTrue(failure.queuedMs >= 0); assertTrue(failure.queuedMs <= failure.elapsedMs);
        assertTrue(failure.bytesReceived >= 0);
        assertFalse(failure.getMessage().contains(ADDRESS)); assertFalse(failure.getMessage().contains(HASH));
        assertFalse(failure.getMessage().contains("localhost")); assertFalse(failure.getMessage().contains("untrusted"));
    }

    @Test public void exactNativeAllowlistCopiesArraysAndRejectsSecretsCoercionAndSubscriptions() throws Exception {
        for (String method : new String[] { "getchaintip", "getrecentblockhashes", "getbountychanges" }) assertEquals(0, MobileRpcClient.validateParams(method, new JSONObject()).length());
        assertTrue(MobileRpcClient.validateParams("getaddressutxos", params().put("include_pending_spent", true)).getBoolean("include_pending_spent"));
        assertEquals(JSONObject.NULL, MobileRpcClient.validateParams("getaddresshistory", params().put("cursor", JSONObject.NULL)).get("cursor"));
        JSONArray txids = new JSONArray().put(HASH.toUpperCase()); JSONObject original = new JSONObject().put("txids", txids);
        JSONObject clean = MobileRpcClient.validateParams("gettransactions", original); txids.put(0, "changed"); original.put("seed", "not transmitted");
        assertEquals(HASH, clean.getJSONArray("txids").get(0)); assertFalse(clean.has("seed"));
        assertEquals(ADDRESS, MobileRpcClient.validateParams("getaddresschanges", new JSONObject().put("addresses", new JSONArray().put(ADDRESS.toUpperCase()))).getJSONArray("addresses").get(0));
        assertEquals(HEX, MobileRpcClient.validateParams("sendrawtransaction", new JSONObject().put("transaction_hex", HEX)).get("transaction_hex"));
        for (String method : new String[] { "subscribeaddress", "subscribetip", "subscribebounties", "unsubscribe", "estimatesmartfee", "submitclaim", "getblock", "", null }) invalid(method, new JSONObject());
        invalid("getchaintip", new JSONObject().put("password", "not transmitted"));
        invalid("getaddressutxos", params().put("include_pending_spent", "true"));
        invalid("getaddresschanges", new JSONObject().put("addresses", new JSONArray().put(ADDRESS).put(ADDRESS.toUpperCase())));
        invalid("gettransactions", new JSONObject().put("txids", new JSONArray().put(HASH).put(HASH.toUpperCase())));
        invalid("gettransactions", new JSONObject().put("txids", new JSONArray()));
        JSONArray tooMany = new JSONArray(); for (int index = 0; index < 33; index++) tooMany.put(String.format("%064x", index));
        invalid("gettransactions", new JSONObject().put("txids", tooMany));
        invalid("getaddresshistory", params().put("cursor", "a".repeat(1025)));
        invalid("getaddressbalance", new JSONObject().put("address", "t" + ADDRESS));
        invalid("gettransaction", new JSONObject().put("txid", 1));
        for (String hex : new String[] { "", "00", "0".repeat(21), "g".repeat(20), "0".repeat(800002) }) invalid("sendrawtransaction", new JSONObject().put("transaction_hex", hex));
    }

    @Test public void productionEndpointRequiresPinnedPublicHostnameAndValidPort() {
        for (String hostname : new String[] { "localhost", "127.0.0.1", "::1", "https://example.com", "tcp://example.com", "example.com/rpc", "x.local", "a..com", "-bad.com" }) {
            try { new MobileRpcClient.TcpEndpoint(hostname, 48190); fail("Accepted " + hostname); } catch (IllegalArgumentException expected) { }
        }
        for (int port : new int[] { -1, 0, 65536 }) {
            try { new MobileRpcClient.TcpEndpoint("rpc.example.com", port); fail("Accepted port " + port); } catch (IllegalArgumentException expected) { }
        }
        MobileRpcClient.TcpEndpoint endpoint = new MobileRpcClient.TcpEndpoint("RPC.EXAMPLE.COM", 48190);
        assertEquals("rpc.example.com", endpoint.hostname); assertEquals(48190, endpoint.port);
    }

    @Test public void endpointReplacementCancelsOldQueriesAndRoutesOnlyToTheSelectedEndpoint() throws Exception {
        CountDownLatch querySeen = new CountDownLatch(1), release = new CountDownLatch(1);
        try (Server oldServer = new Server((request, socket) -> { querySeen.countDown(); release.await(3, TimeUnit.SECONDS); return response(request, new JSONObject()); });
                Server nextServer = new Server((request, socket) -> response(request, new JSONObject().put("selected", true)));
                MobileRpcClient old = oldServer.client(3000);
                MobileRpcClient next = old.prepareReplacement(new MobileRpcClient.TcpEndpoint("new.example.com", nextServer.listener.getLocalPort()))) {
            CompletableFuture<JSONObject> query = old.call("getchaintip", new JSONObject()); assertTrue(querySeen.await(2, TimeUnit.SECONDS));
            assertTrue(old.canChangeEndpoint()); AtomicInteger commits = new AtomicInteger();
            old.replaceWith(next, commits::incrementAndGet);
            error(query, "RPC_CANCELLED"); error(old.call("getchaintip", new JSONObject()), "RPC_CANCELLED");
            assertTrue(await(next.call("getchaintip", new JSONObject())).getBoolean("selected"));
            assertEquals(1, commits.get()); assertEquals(1, oldServer.requests.get()); assertEquals(1, nextServer.requests.get());
            release.countDown();
        } finally { release.countDown(); }
    }

    @Test public void endpointReplacementCannotCancelAWrittenBroadcast() throws Exception {
        CountDownLatch written = new CountDownLatch(1), release = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> { written.countDown(); release.await(3, TimeUnit.SECONDS); return response(request, new JSONObject().put("txid", HASH)); });
                MobileRpcClient client = server.client(3000);
                MobileRpcClient next = client.prepareReplacement(new MobileRpcClient.TcpEndpoint("next.example.com", server.listener.getLocalPort()))) {
            CompletableFuture<JSONObject> broadcast = client.broadcast(HEX); assertTrue(written.await(2, TimeUnit.SECONDS));
            assertFalse(client.canChangeEndpoint()); AtomicInteger commits = new AtomicInteger();
            assertThrows(IllegalStateException.class, () -> client.replaceWith(next, commits::incrementAndGet));
            assertEquals(0, commits.get()); assertFalse(broadcast.isDone());
            release.countDown(); assertEquals(HASH, await(broadcast).getString("txid")); assertTrue(client.canChangeEndpoint());
            assertEquals(1, server.requests.get());
        } finally { release.countDown(); }
    }

    @Test public void failedSettingsCommitLeavesTheOriginalEndpointUsable() throws Exception {
        try (Server server = new Server((request, socket) -> response(request, new JSONObject().put("old", true)));
                MobileRpcClient client = server.client(3000);
                MobileRpcClient next = client.prepareReplacement(new MobileRpcClient.TcpEndpoint("next.example.com", 1))) {
            assertThrows(IllegalStateException.class, () -> client.replaceWith(next, () -> { throw new IllegalStateException("commit failed"); }));
            assertTrue(client.canChangeEndpoint()); assertTrue(await(client.call("getchaintip", new JSONObject())).getBoolean("old"));
            error(next.call("getchaintip", new JSONObject()), "RPC_INACTIVE"); assertEquals(1, server.requests.get());
        }
    }

    @Test public void endpointReplacementKeepsAllFortyEightQueryAndSixBatchQuotaSlots() throws Exception {
        try (Server server = new Server((request, socket) -> response(request, new JSONObject()));
                MobileRpcClient client = server.client(3000, 10000);
                MobileRpcClient next = client.prepareReplacement(new MobileRpcClient.TcpEndpoint("next.example.com", server.listener.getLocalPort()));
                MobileRpcClient back = next.prepareReplacement(new MobileRpcClient.TcpEndpoint("original.example.com", server.listener.getLocalPort()))) {
            JSONObject batch = new JSONObject().put("txids", new JSONArray().put(HASH));
            for (int i = 0; i < 48; i++) await(client.call("getchaintip", new JSONObject()));
            for (int i = 0; i < 6; i++) await(client.call("gettransactions", batch));
            client.replaceWith(next, () -> {}); next.replaceWith(back, () -> {});
            CompletableFuture<JSONObject> tip = back.call("getchaintip", new JSONObject()), parents = back.call("gettransactions", batch);
            assertThrows(java.util.concurrent.TimeoutException.class, () -> tip.get(100, TimeUnit.MILLISECONDS));
            assertThrows(java.util.concurrent.TimeoutException.class, () -> parents.get(100, TimeUnit.MILLISECONDS));
            assertEquals(54, server.requests.get());
            await(back.call("getrecentblockhashes", new JSONObject())); assertEquals(55, server.requests.get());
            tip.cancel(false); parents.cancel(false);
        }
    }

    @Test public void endpointReplacementKeepsServerCooldowns() throws Exception {
        try (Server server = new Server((request, socket) -> bytes(new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
                    .put("error", new JSONObject().put("code", -32029).put("message", "fixture").put("data", new JSONObject().put("retry_after_ms", 10000)))));
                MobileRpcClient client = server.client(3000, 10000);
                MobileRpcClient next = client.prepareReplacement(new MobileRpcClient.TcpEndpoint("next.example.com", server.listener.getLocalPort()))) {
            error(client.call("getchaintip", new JSONObject()), "-32029"); client.replaceWith(next, () -> {});
            CompletableFuture<JSONObject> waiting = next.call("getchaintip", new JSONObject());
            assertThrows(java.util.concurrent.TimeoutException.class, () -> waiting.get(100, TimeUnit.MILLISECONDS));
            assertEquals(1, server.requests.get()); waiting.cancel(false);
        }
    }

    @Test public void plainTcpRoundTripStartsWithJsonWithoutEnablingReadOnlyWrites() throws Exception {
        try (Server server = new Server((request, socket) -> {
            assertEquals(4, request.length()); assertEquals("getaddressutxos", request.get("method")); assertEquals(ADDRESS, request.getJSONObject("params").get("address"));
            return response(request, new JSONObject().put("ok", true));
        }); MobileRpcClient client = server.client(3000)) {
            assertTrue(await(client.call("getaddressutxos", params())).getBoolean("ok"));
            assertEquals('{', server.firstCharacter.get()); assertEquals(1, server.connections.get());
            error(client.call("sendrawtransaction", new JSONObject().put("transaction_hex", HEX)), "RPC_INVALID");
            error(client.call("getblockbounties", new JSONObject().put("block_hash", HASH)), "RPC_INVALID");
            assertEquals(1, server.requests.get());
        }
        try { RpcTransport.validateParams("sendrawtransaction", new JSONObject().put("transaction_hex", HEX)); fail("Public watch-only transport accepted a write"); }
        catch (RpcTransport.RpcFailure expected) { assertEquals("RPC_INVALID", expected.code); }
    }

    @Test public void dnsFailureAndConnectionRefusalBeforeWriteHaveKnownOutcomeAndNoRetry() throws Exception {
        AtomicInteger resolutions = new AtomicInteger();
        try (MobileRpcClient client = MobileRpcClient.localTestClient("localhost", 1, hostname -> {
            assertEquals("localhost", hostname); resolutions.incrementAndGet(); throw new java.net.UnknownHostException("fixture");
        }, 3000)) {
            client.setActive(true); MobileRpcClient.RpcFailure failed = error(client.broadcast(HEX), "RPC_UNAVAILABLE");
            assertFalse(failed.unknownOutcome); diagnostic(failed, "sendrawtransaction", "dns"); assertEquals(0, failed.bytesReceived);
            assertEquals(1, resolutions.get());
        }
        int refusedPort;
        try (ServerSocket reservation = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) { refusedPort = reservation.getLocalPort(); }
        try (MobileRpcClient client = MobileRpcClient.localTestClient("localhost", refusedPort, hostname -> {
            resolutions.incrementAndGet(); return new InetAddress[] { InetAddress.getLoopbackAddress() };
        }, 3000)) {
            client.setActive(true); MobileRpcClient.RpcFailure failed = error(client.broadcast(HEX), "RPC_UNAVAILABLE");
            assertFalse(failed.unknownOutcome); diagnostic(failed, "sendrawtransaction", "connect"); assertEquals(0, failed.bytesReceived);
            assertEquals(2, resolutions.get());
        }
    }

    private static String notification(String method, JSONObject params) throws Exception {
        return new JSONObject().put("jsonrpc", "2.0").put("method", method).put("params", params) + "\n";
    }
    private static String chunk(int sequence, JSONObject item) throws Exception {
        return notification("stream.chunk", new JSONObject().put("stream_id", "fixture").put("sequence", sequence).put("items", item));
    }
    private static String stream(JSONObject request, boolean complete, int secondSequence) throws Exception {
        return new String(response(request, new JSONObject().put("stream_id", "fixture")), StandardCharsets.UTF_8) +
            chunk(0, new JSONObject().put("type", "snapshot").put("block_hash", HASH).put("tip", new JSONObject()).put("cursor", "a.b").put("unit", "connects").put("live", true)) +
            chunk(secondSequence, new JSONObject().put("type", "bounties").put("tip", new JSONObject()).put("items", new JSONArray().put(new JSONObject().put("txid", HASH)))) +
            chunk(2, new JSONObject().put("type", "state").put("tip", new JSONObject()).put("cursor", "c.d")) +
            notification("stream.end", new JSONObject().put("stream_id", "fixture").put("complete", complete).put("chunks", 3));
    }

    @Test public void coalescedFramesAndSplitUtf8StreamRequireCompleteOrderedEnd() throws Exception {
        try (Server server = new Server((request, socket) -> {
            byte[] bytes = stream(request, true, 1).getBytes(StandardCharsets.UTF_8);
            socket.getOutputStream().write(bytes, 0, 7); socket.getOutputStream().flush();
            return java.util.Arrays.copyOfRange(bytes, 7, bytes.length);
        }); MobileRpcClient client = server.client(3000)) {
            List<String> types = new ArrayList<>();
            JSONObject completed = await(client.streamBounties(HASH, value -> types.add(value.getString("type"))));
            assertTrue(completed.getBoolean("complete")); assertEquals(3, completed.getInt("chunks"));
            assertEquals(java.util.Arrays.asList("snapshot", "bounties", "state"), types);
        }
        for (String problem : new String[] { "incomplete", "sequence", "eof" }) {
            try (Server server = new Server((request, socket) -> {
                String text = stream(request, !problem.equals("incomplete"), problem.equals("sequence") ? 9 : 1);
                if (problem.equals("eof")) {
                    text = text.substring(0, text.lastIndexOf("{\"jsonrpc\""));
                    socket.getOutputStream().write(text.getBytes(StandardCharsets.UTF_8)); socket.getOutputStream().flush();
                    return null;
                }
                return text.getBytes(StandardCharsets.UTF_8);
            }); MobileRpcClient client = server.client(3000)) {
                error(client.streamBounties(HASH, unused -> {}), problem.equals("sequence") ? "RPC_PROTOCOL" : "RPC_STREAM_INCOMPLETE");
            }
        }
    }

    @Test public void broadcastSuccessExplicitRejectionAndUncertainEofAreDistinctWithoutRetries() throws Exception {
        try (Server server = new Server((request, socket) -> response(request, new JSONObject().put("txid", HASH))); MobileRpcClient client = server.client(3000)) {
            assertEquals(HASH, await(client.broadcast(HEX)).get("txid")); assertEquals(1, server.requests.get());
        }
        for (int nodeCode : new int[] { -26, -27 }) {
            try (Server server = new Server((request, socket) -> bytes(new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
                .put("error", new JSONObject().put("code", -32020).put("message", "untrusted private text").put("data", new JSONObject().put("node_code", nodeCode)))));
                MobileRpcClient client = server.client(3000)) {
                MobileRpcClient.RpcFailure error = error(client.broadcast(HEX), "-32020");
                assertFalse(error.unknownOutcome); assertEquals(Integer.valueOf(nodeCode), error.nodeCode); assertFalse(error.getMessage().contains("private"));
                diagnostic(error, "sendrawtransaction", "parse"); assertTrue(error.bytesReceived > 0); assertEquals(1, server.requests.get());
            }
        }
        try (Server server = new Server((request, socket) -> null); MobileRpcClient client = server.client(3000)) {
            assertTrue(error(client.broadcast(HEX), "RPC_PROTOCOL").unknownOutcome); assertEquals(1, server.requests.get());
        }
    }

    @Test public void cancellationAfterWritePreservesUnknownOutcomeAndDrainsReplyOnSharedSocket() throws Exception {
        CountDownLatch written = new CountDownLatch(1), release = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> { written.countDown(); release.await(3, TimeUnit.SECONDS); return response(request, new JSONObject().put("txid", HASH)); });
             MobileRpcClient client = server.client(3000)) {
            CompletableFuture<JSONObject> pending = client.broadcast(HEX); assertTrue(written.await(2, TimeUnit.SECONDS));
            assertFalse("Pre-write-only cancellation cannot interrupt a broadcast already sent", client.cancelBeforeWrite(pending));
            assertFalse(pending.isDone());
            assertTrue(pending.cancel(false)); MobileRpcClient.RpcFailure failed = error(pending, "RPC_CANCELLED");
            assertTrue(failed.unknownOutcome); assertEquals("sendrawtransaction", failed.method); assertEquals(0, failed.bytesReceived);
            release.countDown(); assertEquals(1, server.requests.get()); assertEquals(1, server.connections.get());
        } finally { release.countDown(); }
    }

    @Test public void inactiveCancellationBeforeTransmissionAndDnsDeadlineRemainKnown() throws Exception {
        AtomicInteger resolutions = new AtomicInteger(); CountDownLatch release = new CountDownLatch(1), resolving = new CountDownLatch(1);
        try (MobileRpcClient client = MobileRpcClient.localTestClient("localhost", 1, unused -> {
            resolutions.incrementAndGet(); resolving.countDown();
            try { release.await(2, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            return new InetAddress[] { InetAddress.getLoopbackAddress() };
        }, 120)) {
            assertFalse(error(client.broadcast(HEX), "RPC_INACTIVE").unknownOutcome); assertEquals(0, resolutions.get());
            client.setActive(true); CompletableFuture<JSONObject> pending = client.broadcast(HEX);
            assertTrue(resolving.await(1, TimeUnit.SECONDS)); MobileRpcClient.RpcFailure failed = error(pending, "RPC_TIMEOUT");
            assertFalse(failed.unknownOutcome); diagnostic(failed, "sendrawtransaction", "dns"); assertEquals(0, failed.bytesReceived);
            assertTrue(failed.elapsedMs >= 100); assertEquals(1, resolutions.get()); release.countDown();
        } finally { release.countDown(); }
    }

    @Test public void sixteenActiveAndBoundedQueuedCancelAllWithoutLateWrites() throws Exception {
        CountDownLatch active = new CountDownLatch(16), release = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> { active.countDown(); release.await(3, TimeUnit.SECONDS); return response(request, new JSONObject()); });
             MobileRpcClient client = server.client(4000)) {
            List<CompletableFuture<JSONObject>> calls = new ArrayList<>();
            for (int index = 0; index < MobileRpcClient.MAX_JOBS; index++) calls.add(client.call("getchaintip", new JSONObject()));
            assertTrue(active.await(2, TimeUnit.SECONDS)); error(client.call("getchaintip", new JSONObject()), "RPC_BUSY");
            client.cancelAll(); for (CompletableFuture<JSONObject> call : calls) error(call, "RPC_CANCELLED");
            release.countDown(); assertEquals(16, server.requests.get()); assertEquals(1, server.connections.get());
            assertNotNull(await(client.call("getchaintip", new JSONObject()))); assertEquals(17, server.requests.get()); assertEquals(2, server.connections.get());
        } finally { release.countDown(); }
    }

    @Test public void quotasArePerMethodAndSurviveCancellationWithoutOpeningWaitingSockets() throws Exception {
        try (Server server = new Server((request, socket) -> response(request, new JSONObject())); MobileRpcClient client = server.client(3000)) {
            for (int index = 0; index < 6; index++) await(client.call("gettransactions", new JSONObject().put("txids", new JSONArray().put(HASH))));
            client.cancelAll(); CompletableFuture<JSONObject> batch = client.call("gettransactions", new JSONObject().put("txids", new JSONArray().put(HASH)));
            assertFalse(batch.isDone()); assertTrue(client.cancelBeforeWrite(batch));
            diagnostic(error(batch, "RPC_CANCELLED"), "gettransactions", "quota");
            assertEquals(6, server.requests.get());
            for (int index = 0; index < 48; index++) await(client.call("getchaintip", new JSONObject()));
            CompletableFuture<JSONObject> tip = client.call("getchaintip", new JSONObject());
            assertFalse(tip.isDone()); assertTrue(client.cancelBeforeWrite(tip));
            diagnostic(error(tip, "RPC_CANCELLED"), "getchaintip", "quota"); assertEquals(54, server.requests.get());
            assertEquals(2, server.connections.get());
        }
    }

    @Test public void quotaWaitLongerThanOperationTimeoutUsesNoWorkerAndSendsOnceWhenWindowOpens() throws Exception {
        try (Server server = new Server((request, socket) -> response(request,
                request.getString("method").equals("sendrawtransaction") ? new JSONObject().put("txid", HASH) : new JSONObject()));
             MobileRpcClient client = server.client(750, 3000)) {
            for (int index = 0; index < 48; index++) assertEquals(HASH, await(client.broadcast(HEX)).getString("txid"));
            CompletableFuture<JSONObject> waiting = client.broadcast(HEX);
            // An intentional quota wait must outlive the ordinary 750ms deadline.
            try { waiting.get(1000, TimeUnit.MILLISECONDS); fail("Quota did not hold the 49th broadcast"); }
            catch (java.util.concurrent.TimeoutException expected) { }
            assertEquals(48, server.requests.get()); assertEquals(1, server.connections.get());
            for (int index = 0; index < 3; index++) assertNotNull(await(client.call("getchaintip", new JSONObject())));
            assertEquals(HASH, await(waiting).getString("txid"));
            assertEquals(52, server.requests.get()); assertEquals(1, server.connections.get());
            assertFalse(client.cancelBeforeWrite(waiting));
        }
    }

    @Test public void allQuotaWaitersRemainBoundedAndLifecycleCancellationNeverWritesThemLater() throws Exception {
        for (String mode : new String[] { "cancelBeforeWrite", "offline", "close" }) {
            try (Server server = new Server((request, socket) -> response(request, new JSONObject().put("txid", HASH)));
                 MobileRpcClient client = server.client(1000, 1800)) {
                for (int index = 0; index < 48; index++) await(client.broadcast(HEX));
                List<CompletableFuture<JSONObject>> waiting = new ArrayList<>();
                for (int index = 0; index < MobileRpcClient.MAX_JOBS; index++) waiting.add(client.broadcast(HEX));
                error(client.broadcast(HEX), "RPC_BUSY");
                assertEquals(1, server.connections.get());
                if (mode.equals("cancelBeforeWrite")) for (CompletableFuture<JSONObject> pending : waiting) assertTrue(client.cancelBeforeWrite(pending));
                else if (mode.equals("offline")) client.setActive(false);
                else client.close();
                for (CompletableFuture<JSONObject> pending : waiting) {
                    MobileRpcClient.RpcFailure failed = error(pending, "RPC_CANCELLED");
                    diagnostic(failed, "sendrawtransaction", "quota"); assertFalse(failed.unknownOutcome); assertEquals(0, failed.bytesReceived);
                    assertFalse(client.cancelBeforeWrite(pending));
                }
                // Hold the fixture past the quota wake-up to detect late writes.
                CountDownLatch delay = new CountDownLatch(1); assertFalse(delay.await(1900, TimeUnit.MILLISECONDS));
                assertEquals(48, server.requests.get()); assertEquals(1, server.connections.get());
            }
        }
    }

    @Test public void remoteRateRejectionIsNotRetriedAndRetainsBroadcastUncertainty() throws Exception {
        for (boolean broadcast : new boolean[] { false, true }) {
            try (Server server = new Server((request, socket) -> bytes(new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
                    .put("error", new JSONObject().put("code", -32029).put("message", "rate limited").put("data", new JSONObject().put("retry_after_ms", 400)))));
                 MobileRpcClient client = server.client(1000, 400)) {
                MobileRpcClient.RpcFailure failed = error(broadcast ? client.broadcast(HEX) : client.call("getchaintip", new JSONObject()), "-32029");
                diagnostic(failed, broadcast ? "sendrawtransaction" : "getchaintip", "parse");
                assertEquals(broadcast, failed.unknownOutcome); assertEquals(400, failed.retryAfterMs);
                assertEquals(1, server.requests.get());
                CompletableFuture<JSONObject> next = broadcast ? client.broadcast(HEX) : client.call("getchaintip", new JSONObject());
                assertFalse(next.isDone()); assertTrue(client.cancelBeforeWrite(next));
                diagnostic(error(next, "RPC_CANCELLED"), broadcast ? "sendrawtransaction" : "getchaintip", "quota");
                assertFalse(new CountDownLatch(1).await(450, TimeUnit.MILLISECONDS)); assertEquals(1, server.requests.get());
            }
        }
    }

    @Test public void sixteenConcurrentRequestsReserveOnlyTheRemainingPerMinuteAllowance() throws Exception {
        for (String method : new String[] { "getchaintip", "gettransactions" }) {
            int limit = method.equals("gettransactions") ? 6 : 48;
            JSONObject params = method.equals("gettransactions") ? new JSONObject().put("txids", new JSONArray().put(HASH)) : new JSONObject();
            try (Server server = new Server((request, socket) -> response(request, new JSONObject())); MobileRpcClient client = server.client(1500, 3000)) {
                for (int index = 0; index < limit - 1; index++) await(client.call(method, params));
                List<CompletableFuture<JSONObject>> calls = new ArrayList<>();
                for (int index = 0; index < 16; index++) calls.add(client.call(method, params));
                assertNotNull(CompletableFuture.anyOf(calls.toArray(new CompletableFuture<?>[0])).get(2, TimeUnit.SECONDS));
                assertEquals("Only the final quota slot may be written", limit, server.requests.get());
                int completed = 0;
                for (CompletableFuture<JSONObject> pending : calls) {
                    if (pending.isDone()) { await(pending); completed++; }
                    else { assertTrue(client.cancelBeforeWrite(pending)); assertFalse(error(pending, "RPC_CANCELLED").unknownOutcome); }
                }
                assertEquals(1, completed); assertEquals(1, server.connections.get());
                assertFalse(new CountDownLatch(1).await(3100, TimeUnit.MILLISECONDS));
                assertEquals(limit, server.requests.get());
                assertNotNull(await(client.call(method, params))); assertEquals(limit + 1, server.requests.get());
            }
        }
    }

    @Test public void streamQuotasRetainEightPerBlockAndFortyEightTotalWhileWaitingOffWorker() throws Exception {
        try (Server server = new Server((request, socket) -> stream(request, true, 1)
                .replace(HASH, request.getJSONObject("params").getString("block_hash")).getBytes(StandardCharsets.UTF_8));
             MobileRpcClient client = server.client(3000)) {
            for (int index = 0; index < 8; index++) await(client.streamBounties(HASH, unused -> {}));
            CompletableFuture<JSONObject> sameBlock = client.streamBounties(HASH, unused -> {});
            assertFalse(sameBlock.isDone()); assertEquals(1, server.connections.get());
            for (int index = 0; index < 40; index++) await(client.streamBounties(String.format("%064x", index), unused -> {}));
            CompletableFuture<JSONObject> total = client.streamBounties("b".repeat(64), unused -> {});
            assertFalse(total.isDone()); assertEquals(48, server.requests.get()); assertEquals(1, server.connections.get());
            assertTrue(client.cancelBeforeWrite(sameBlock)); assertTrue(client.cancelBeforeWrite(total));
            diagnostic(error(sameBlock, "RPC_CANCELLED"), "getblockbounties", "quota");
            diagnostic(error(total, "RPC_CANCELLED"), "getblockbounties", "quota");
        }
    }

    @Test public void resumedQuotaWaitStillHasItsNormalReadDeadlineAfterTheSingleWrite() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger count = new AtomicInteger();
        try (Server server = new Server((request, socket) -> {
            if (count.incrementAndGet() == 7) { release.await(2, TimeUnit.SECONDS); return null; }
            return response(request, new JSONObject());
        }); MobileRpcClient client = server.client(350, 1400)) {
            JSONObject batch = new JSONObject().put("txids", new JSONArray().put(HASH));
            for (int index = 0; index < 6; index++) await(client.call("gettransactions", batch));
            MobileRpcClient.RpcFailure failed = error(client.call("gettransactions", batch), "RPC_TIMEOUT");
            diagnostic(failed, "gettransactions", "read");
            assertTrue("Quota time is excluded, then the normal deadline expires", failed.elapsedMs > 1000);
            assertEquals(7, server.requests.get()); assertEquals(0, failed.bytesReceived); release.countDown();
        } finally { release.countDown(); }
    }

    @Test public void malformedFramesDuplicateKeysMismatchedIdsAndOversizeNeverSucceed() throws Exception {
        for (String mode : new String[] { "duplicate", "id", "utf8", "oversize", "broadcast-id" }) {
            try (Server server = new Server((request, socket) -> {
                if (mode.equals("utf8")) return new byte[] { '{', (byte) 0xc3, (byte) 0x28, '}', '\n' };
                if (mode.equals("oversize")) return (" ".repeat(MobileRpcClient.MAX_FRAME + 1) + "\n").getBytes(StandardCharsets.UTF_8);
                if (mode.equals("broadcast-id")) return response(request, new JSONObject().put("txid", "wrong"));
                String text = new String(response(request, new JSONObject()), StandardCharsets.UTF_8);
                if (mode.equals("duplicate")) text = text.replace("\"result\":{}", "\"result\":{},\"result\":{}");
                else text = text.replace(request.getString("id"), "wrong");
                return text.getBytes(StandardCharsets.UTF_8);
            }); MobileRpcClient client = server.client(3000)) {
                MobileRpcClient.RpcFailure error = error(mode.equals("broadcast-id") ? client.broadcast(HEX) : client.call("getchaintip", new JSONObject()), "RPC_PROTOCOL");
                assertEquals(mode.equals("broadcast-id"), error.unknownOutcome);
            }
        }
    }

    @Test public void streamConsumerCannotBlockDeadlineOrPublishACompletePartialSnapshot() throws Exception {
        CountDownLatch consuming = new CountDownLatch(1), release = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> stream(request, true, 1).getBytes(StandardCharsets.UTF_8)); MobileRpcClient client = server.client(300)) {
            CompletableFuture<JSONObject> future = client.streamBounties(HASH, chunk -> { consuming.countDown(); release.await(2, TimeUnit.SECONDS); });
            assertTrue(consuming.await(2, TimeUnit.SECONDS)); MobileRpcClient.RpcFailure failed = error(future, "RPC_TIMEOUT");
            diagnostic(failed, "getblockbounties", "consumer"); assertTrue(failed.bytesReceived > 0); release.countDown();
        } finally { release.countDown(); }
    }

    @Test public void consumerFailureDrainsOnlyItsStreamAndPreservesUnrelatedWrittenPayment() throws Exception {
        for (boolean cancelled : new boolean[] { false, true }) {
            CountDownLatch consuming = new CountDownLatch(1), releaseConsumer = new CountDownLatch(1);
            CountDownLatch paymentWritten = new CountDownLatch(1), releasePayment = new CountDownLatch(1);
            try (Server server = new Server((request, socket) -> {
                if (request.getString("method").equals("getblockbounties")) return stream(request, true, 1).getBytes(StandardCharsets.UTF_8);
                paymentWritten.countDown(); assertTrue(releasePayment.await(3, TimeUnit.SECONDS));
                return response(request, new JSONObject().put("txid", HASH));
            }); MobileRpcClient client = server.client(3000)) {
                CompletableFuture<JSONObject> stream = client.streamBounties(HASH, chunk -> {
                    consuming.countDown(); assertTrue(releaseConsumer.await(3, TimeUnit.SECONDS));
                    if (cancelled) throw new java.util.concurrent.CancellationException();
                    throw new IllegalArgumentException("Synthetic consumer failure");
                });
                assertTrue(consuming.await(2, TimeUnit.SECONDS));
                CompletableFuture<JSONObject> payment = client.broadcast(HEX);
                assertTrue(paymentWritten.await(2, TimeUnit.SECONDS)); releaseConsumer.countDown();
                error(stream, cancelled ? "RPC_CANCELLED" : "RPC_PROTOCOL");
                assertFalse(payment.isDone()); releasePayment.countDown();
                assertEquals(HASH, await(payment).getString("txid")); assertEquals(1, server.connections.get());
            } finally { releaseConsumer.countDown(); releasePayment.countDown(); }
        }
    }

    @Test public void sharedDnsTimeoutKeepsQueuedBroadcastKnownAndNeverWritesIt() throws Exception {
        CountDownLatch resolving = new CountDownLatch(1), release = new CountDownLatch(1);
        AtomicInteger resolutions = new AtomicInteger();
        try (MobileRpcClient client = MobileRpcClient.localTestClient("localhost", 1, unused -> {
            resolutions.incrementAndGet(); resolving.countDown();
            try { release.await(3, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            return new InetAddress[] { InetAddress.getLoopbackAddress() };
        }, 500)) {
            client.setActive(true);
            List<CompletableFuture<JSONObject>> active = new ArrayList<>();
            for (int i = 0; i < 16; i++) active.add(client.call("getchaintip", new JSONObject()));
            assertTrue(resolving.await(2, TimeUnit.SECONDS));
            MobileRpcClient.RpcFailure failed = error(client.broadcast(HEX), "RPC_TIMEOUT");
            diagnostic(failed, "sendrawtransaction", "queue"); assertTrue(failed.elapsedMs - failed.queuedMs <= 20);
            assertTrue(failed.elapsedMs >= 450); assertEquals(0, failed.bytesReceived); assertFalse(failed.unknownOutcome);
            assertEquals(1, resolutions.get());
            for (CompletableFuture<JSONObject> pending : active) diagnostic(error(pending, "RPC_TIMEOUT"), "getchaintip", "dns");
        } finally { release.countDown(); }
    }

    @Test public void missingOrPartialResponseReportsReadTimeoutAndReceivedBytesWithoutRetry() throws Exception {
        for (boolean partial : new boolean[] { false, true }) {
            CountDownLatch written = new CountDownLatch(1), release = new CountDownLatch(1);
            byte[] prefix = "{\"jsonrpc\":\"2.0\",\"result\":{\"untrusted\":\"".getBytes(StandardCharsets.UTF_8);
            try (Server server = new Server((request, socket) -> {
                if (partial) { socket.getOutputStream().write(prefix); socket.getOutputStream().flush(); }
                written.countDown(); release.await(3, TimeUnit.SECONDS); return null;
            }); MobileRpcClient client = server.client(500)) {
                CompletableFuture<JSONObject> pending = partial ? client.broadcast(HEX) : client.call("getchaintip", new JSONObject());
                assertTrue(written.await(2, TimeUnit.SECONDS));
                MobileRpcClient.RpcFailure failed = error(pending, "RPC_TIMEOUT");
                diagnostic(failed, partial ? "sendrawtransaction" : "getchaintip", "read");
                assertEquals(partial ? prefix.length : 0, failed.bytesReceived); assertEquals(partial, failed.unknownOutcome);
                assertNull(failed.nodeCode); assertEquals(0, failed.retryAfterMs); assertEquals(1, server.requests.get());
                assertFalse(pending.cancel(false)); release.countDown();
            } finally { release.countDown(); }
        }
    }

    @Test public void diagnosticCopyRetainsServerRetryDelayAndIgnoresUntrustedErrorMetadata() throws Exception {
        final AtomicInteger receivedLength = new AtomicInteger();
        try (Server server = new Server((request, socket) -> {
            byte[] reply = bytes(new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
                .put("error", new JSONObject().put("code", -32029).put("message", "untrusted " + ADDRESS)
                    .put("data", new JSONObject().put("retry_after_ms", 12345).put("method", ADDRESS).put("phase", HASH))));
            receivedLength.set(reply.length); return reply;
        }); MobileRpcClient client = server.client(3000)) {
            MobileRpcClient.RpcFailure failed = error(client.call("getchaintip", new JSONObject()), "-32029");
            diagnostic(failed, "getchaintip", "parse"); assertEquals(12345, failed.retryAfterMs);
            assertEquals(receivedLength.get(), failed.bytesReceived); assertFalse(failed.unknownOutcome); assertNull(failed.nodeCode);
            assertEquals(1, server.requests.get());
        }
    }
}
