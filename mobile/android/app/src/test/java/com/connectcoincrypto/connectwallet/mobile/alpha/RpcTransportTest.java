package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;
import org.junit.Test;

/** Real loopback TCP only; never queries production or accesses a wallet. */
public class RpcTransportTest {
    private static final String ADDRESS = "cc1pljr5t7srjcssh6v5ucna9528khydrjrzkd0mfmlmcc8dhfj576fsfmh0g9";

    private static final class Outcome {
        final JSONObject result;
        final RpcTransport.RpcFailure error;
        Outcome(JSONObject result, RpcTransport.RpcFailure error) { this.result = result; this.error = error; }
    }
    private static CompletableFuture<Outcome> query(RpcTransport transport, String method, JSONObject params) {
        CompletableFuture<Outcome> promise = new CompletableFuture<>();
        transport.query(method, params, (result, error) -> promise.complete(new Outcome(result, error)));
        return promise;
    }
    private static Outcome await(CompletableFuture<Outcome> promise) throws Exception { return promise.get(3, TimeUnit.SECONDS); }
    private static void code(String expected, Outcome result) {
        assertNull(result.result); assertNotNull(result.error); assertEquals(expected, result.error.code);
    }
    private static JSONObject object(String json) throws Exception { return new JSONObject(json); }
    private static JSONObject addressParams() throws Exception { return new JSONObject().put("address", ADDRESS); }
    private static void invalid(String method, JSONObject params) throws Exception {
        try { RpcTransport.validateParams(method, params); fail("Accepted invalid public request"); }
        catch (RpcTransport.RpcFailure error) { assertEquals("RPC_INVALID", error.code); }
    }
    private static void invalidReply(String text) throws Exception {
        try { RpcTransport.parseReply(text, "mobile-1"); fail("Accepted invalid RPC response"); }
        catch (RpcTransport.RpcFailure error) { assertEquals("RPC_PROTOCOL", error.code); }
    }

    interface Reply { byte[] handle(JSONObject request, Socket socket) throws Exception; }
    private static final class Server implements AutoCloseable {
        final ServerSocket listener = new ServerSocket(0, 8, InetAddress.getLoopbackAddress());
        final ExecutorService acceptor = Executors.newSingleThreadExecutor();
        final ExecutorService handlers = Executors.newFixedThreadPool(2);
        final List<Socket> sockets = new ArrayList<>();
        final AtomicInteger requests = new AtomicInteger();
        Server(Reply reply) throws Exception {
            acceptor.execute(() -> {
                try {
                    while (!listener.isClosed()) {
                        Socket socket = listener.accept();
                        synchronized (sockets) { sockets.add(socket); }
                        handlers.execute(() -> {
                            try (Socket connection = socket) {
                                connection.setSoTimeout(3000);
                                String line = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)).readLine();
                                if (line == null) return;
                                JSONObject request = new JSONObject(line); requests.incrementAndGet();
                                byte[] bytes = reply.handle(request, connection);
                                if (bytes != null) { connection.getOutputStream().write(bytes); connection.getOutputStream().flush(); }
                            } catch (Exception ignored) { /* Cancellation intentionally closes these sockets. */ }
                        });
                    }
                } catch (Exception ignored) { /* Closing the fixture releases accept. */ }
            });
        }
        RpcTransport transport(int timeoutMs) {
            RpcTransport transport = new RpcTransport("localhost", listener.getLocalPort(), timeoutMs,
                host -> new InetAddress[] { InetAddress.getLoopbackAddress() });
            transport.setForeground(true); return transport;
        }
        @Override public void close() throws java.io.IOException {
            try {
                listener.close();
                synchronized (sockets) { for (Socket socket : sockets) socket.close(); }
            } finally {
                handlers.shutdownNow(); acceptor.shutdownNow();
                try {
                    assertTrue(handlers.awaitTermination(3, TimeUnit.SECONDS));
                    assertTrue(acceptor.awaitTermination(3, TimeUnit.SECONDS));
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt(); throw new AssertionError("Test fixture shutdown interrupted", error);
                }
            }
        }
    }
    private static byte[] reply(JSONObject request, JSONObject result) throws Exception {
        return (new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id")).put("result", result) + "\n").getBytes(StandardCharsets.UTF_8);
    }

    @Test public void onlyThreeReadMethodsAndTheirExactPublicParamsAreAllowed() throws Exception {
        assertEquals(0, RpcTransport.validateParams("getchaintip", new JSONObject()).length());
        assertEquals(ADDRESS, RpcTransport.validateParams("getaddressbalance", addressParams()).get("address"));
        assertEquals(JSONObject.NULL, RpcTransport.validateParams("getaddresshistory", addressParams().put("cursor", JSONObject.NULL)).get("cursor"));
        assertEquals("a_b.C-9", RpcTransport.validateParams("getaddresshistory", addressParams().put("cursor", "a_b.C-9")).get("cursor"));
        for (String method : new String[] { "sendrawtransaction", "gettransactions", "subscribeaddress", "getaddresschanges", "GETCHAINTIP", "", null }) invalid(method, new JSONObject());
        invalid("getchaintip", addressParams());
        invalid("getaddressbalance", addressParams().put("password", "not-sent"));
        invalid("getaddressbalance", addressParams().put("host", "127.0.0.1"));
        invalid("getaddressbalance", addressParams().put("cursor", "a"));
        invalid("getaddressbalance", new JSONObject());
        invalid("getaddressbalance", object("{\"address\":[\"" + ADDRESS + "\"]}"));
        invalid("getaddressbalance", object("{\"address\":123}"));
        invalid("getaddresshistory", addressParams().put("cursor", ""));
        invalid("getaddresshistory", addressParams().put("cursor", "a/b"));
        invalid("getaddresshistory", addressParams().put("cursor", "a".repeat(1025)));
        invalid("getaddressbalance", new JSONObject().put("address", "abandon ".repeat(12)));
        invalid("getaddressbalance", new JSONObject().put("address", "f".repeat(64)));
        invalid("getaddressbalance", new JSONObject().put("address", "t" + ADDRESS));
    }

    @Test public void paramsAreCopiedBeforeQueuing() throws Exception {
        JSONObject params = addressParams();
        JSONObject clean = RpcTransport.validateParams("getaddresshistory", params);
        params.put("address", "not-a-valid-address").put("secret", "not-sent");
        assertEquals(ADDRESS, clean.getString("address")); assertFalse(clean.has("secret"));
    }

    @Test public void repliesHaveTypedCorrelatedIdsAndObjectResults() throws Exception {
        assertTrue(RpcTransport.parseReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{\"ok\":true}}", "mobile-1").getBoolean("ok"));
        invalidReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}");
        invalidReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-2\",\"result\":{}}");
        invalidReply("{\"id\":\"mobile-1\",\"result\":{}}");
        invalidReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":[]}");
        invalidReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":null}");
        invalidReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{},\"error\":{}}");
        invalidReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"error\":{\"code\":\"-32029\"}}");
        invalidReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"error\":{\"code\":-32029.5}}");
    }

    @Test public void strictJsonRejectsLenientParserExtensionsDuplicateKeysAndDeepNesting() throws Exception {
        for (String text : new String[] {
            "{'jsonrpc':'2.0','id':'mobile-1','result':{}}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{},}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{},\"result\":{}}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{},\"\\u0069d\":\"mobile-2\"}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{\"a\":NaN}}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{\"a\":01}}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{\"a\":" + "9".repeat(65) + "}}",
            "{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"result\":{}}garbage",
            "{\"a\":".repeat(66) + "0" + "}".repeat(66), "", "[]"
        }) invalidReply(text);
    }

    @Test public void rawServerErrorMessagesNeverLeaveTransport() throws Exception {
        try {
            RpcTransport.parseReply("{\"jsonrpc\":\"2.0\",\"id\":\"mobile-1\",\"error\":{\"code\":-8,\"message\":\"UNTRUSTED secret /path\",\"data\":\"UNTRUSTED\"}}", "mobile-1");
            fail("Expected remote error");
        } catch (RpcTransport.RpcFailure error) {
            assertEquals("-8", error.code); assertFalse(error.getMessage().contains("UNTRUSTED"));
        }
    }

    @Test public void validTcpRoundTripUsesTheExactReadOnlyWireEnvelope() throws Exception {
        try (Server server = new Server((request, socket) -> {
            assertEquals("2.0", request.get("jsonrpc")); assertTrue(request.get("id") instanceof String);
            assertEquals("getaddressbalance", request.get("method"));
            assertEquals(ADDRESS, request.getJSONObject("params").get("address"));
            assertEquals(4, request.length());
            return reply(request, object("{\"unit\":\"connects\",\"available\":\"0\"}"));
        }); RpcTransport transport = server.transport(2000)) {
            Outcome result = await(query(transport, "getaddressbalance", addressParams()));
            assertNull(result.error); assertEquals("0", result.result.get("available")); assertEquals(1, server.requests.get());
        }
    }

    @Test public void foregroundAndClosedStateFailWithoutStartingDns() throws Exception {
        AtomicInteger dns = new AtomicInteger();
        RpcTransport transport = new RpcTransport("localhost", 1, 500, host -> { dns.incrementAndGet(); return new InetAddress[] { InetAddress.getLoopbackAddress() }; });
        code("RPC_BACKGROUND", await(query(transport, "getchaintip", new JSONObject())));
        transport.close(); transport.setForeground(true);
        code("RPC_CANCELLED", await(query(transport, "getchaintip", new JSONObject())));
        assertEquals(0, dns.get());
    }

    @Test public void capacityIsTwoActivePlusEightQueuedAndCancelDropsQueuedRequests() throws Exception {
        CountDownLatch active = new CountDownLatch(2), release = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> { active.countDown(); release.await(2, TimeUnit.SECONDS); return reply(request, new JSONObject()); });
             RpcTransport transport = server.transport(2500)) {
            List<CompletableFuture<Outcome>> requests = new ArrayList<>();
            for (int index = 0; index < 10; index++) requests.add(query(transport, "getchaintip", new JSONObject()));
            assertTrue(active.await(1, TimeUnit.SECONDS));
            code("RPC_BUSY", await(query(transport, "getchaintip", new JSONObject())));
            assertEquals(2, server.requests.get());
            transport.cancelAll();
            for (CompletableFuture<Outcome> request : requests) code("RPC_CANCELLED", await(request));
            release.countDown();
            Outcome resumed = await(query(transport, "getchaintip", new JSONObject()));
            assertNull(resumed.error); assertEquals(3, server.requests.get());
        } finally { release.countDown(); }
    }

    @Test public void pauseClosesSocketRejectsLateSuccessAndResumeAllowsANewGeneration() throws Exception {
        CountDownLatch received = new CountDownLatch(1), closed = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        try (Server server = new Server((request, socket) -> {
            if (calls.incrementAndGet() == 1) {
                received.countDown();
                if (socket.getInputStream().read() == -1) closed.countDown();
            }
            return reply(request, new JSONObject());
        }); RpcTransport transport = server.transport(2000)) {
            CompletableFuture<Outcome> first = query(transport, "getchaintip", new JSONObject());
            assertTrue(received.await(1, TimeUnit.SECONDS)); transport.setForeground(false);
            code("RPC_CANCELLED", await(first)); assertTrue(closed.await(1, TimeUnit.SECONDS));
            code("RPC_BACKGROUND", await(query(transport, "getchaintip", new JSONObject())));
            transport.setForeground(true);
            assertNull(await(query(transport, "getchaintip", new JSONObject())).error);
        }
    }

    @Test public void totalDeadlineIncludesStalledReadsAndDoesNotRetry() throws Exception {
        CountDownLatch closed = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> {
            socket.getOutputStream().write('{'); socket.getOutputStream().flush();
            if (socket.getInputStream().read() == -1) closed.countDown(); return null;
        }); RpcTransport transport = server.transport(120)) {
            code("RPC_TIMEOUT", await(query(transport, "getchaintip", new JSONObject())));
            assertTrue(closed.await(1, TimeUnit.SECONDS)); assertEquals(1, server.requests.get());
        }
    }

    @Test public void dnsDeadlineSettlesWithoutWaitingForResolverAndLateResolverCannotConnect() throws Exception {
        CountDownLatch resolving = new CountDownLatch(1), release = new CountDownLatch(1), returned = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> reply(request, new JSONObject()));
             RpcTransport transport = new RpcTransport("localhost", server.listener.getLocalPort(), 100, host -> {
                 resolving.countDown();
                 try { release.await(2, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                 returned.countDown(); return new InetAddress[] { InetAddress.getLoopbackAddress() };
             })) {
            transport.setForeground(true);
            CompletableFuture<Outcome> pending = query(transport, "getchaintip", new JSONObject());
            assertTrue(resolving.await(1, TimeUnit.SECONDS)); code("RPC_TIMEOUT", await(pending));
            release.countDown(); assertTrue(returned.await(1, TimeUnit.SECONDS));
            assertEquals(0, server.requests.get());
        } finally { release.countDown(); }
    }

    @Test public void rateLimitIsFortyEightTransmissionsPerMethodWithoutAutomaticRetry() throws Exception {
        try (Server server = new Server((request, socket) -> reply(request, new JSONObject())); RpcTransport transport = server.transport(2000)) {
            for (int index = 0; index < 48; index++) assertNull(await(query(transport, "getchaintip", new JSONObject())).error);
            code("-32029", await(query(transport, "getchaintip", new JSONObject())));
            assertEquals(48, server.requests.get());
            assertNull(await(query(transport, "getaddressbalance", addressParams())).error);
            assertEquals(49, server.requests.get());
        }
    }

    @Test public void remoteRateLimitCreatesNativeMethodCooldownWhichSurvivesCancelAndResume() throws Exception {
        try (Server server = new Server((request, socket) -> {
            if (request.getString("method").equals("getchaintip")) return (new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id"))
                .put("error", new JSONObject().put("code", -32029).put("message", "not exposed")) + "\n").getBytes(StandardCharsets.UTF_8);
            return reply(request, new JSONObject());
        }); RpcTransport transport = server.transport(2000)) {
            code("-32029", await(query(transport, "getchaintip", new JSONObject())));
            transport.cancelAll(); transport.setForeground(false); transport.setForeground(true);
            code("-32029", await(query(transport, "getchaintip", new JSONObject())));
            assertEquals(1, server.requests.get());
            assertNull(await(query(transport, "getaddressbalance", addressParams())).error);
        }
    }

    @Test public void malformedUtf8AndOversizedFramesAreRejected() throws Exception {
        for (byte[] bytes : new byte[][] {
            new byte[] { '{', (byte) 0xc3, (byte) 0x28, '}', '\n' },
            (" ".repeat(RpcTransport.MAX_FRAME + 1) + "\n").getBytes(StandardCharsets.UTF_8),
            "{}\n".getBytes(StandardCharsets.UTF_8)
        }) {
            try (Server server = new Server((request, socket) -> bytes); RpcTransport transport = server.transport(2000)) {
                code("RPC_PROTOCOL", await(query(transport, "getchaintip", new JSONObject())));
            }
        }
    }
}
