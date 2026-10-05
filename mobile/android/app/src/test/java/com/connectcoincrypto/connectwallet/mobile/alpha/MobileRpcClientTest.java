package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManagerFactory;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

/** Offline loopback TLS. Synthetic transaction bytes never leave the fixture. */
public class MobileRpcClientTest {
    private static final String ADDRESS = "cc1pljr5t7srjcssh6v5ucna9528khydrjrzkd0mfmlmcc8dhfj576fsfmh0g9";
    private static final String HASH = "a".repeat(64), HEX = "00".repeat(10);
    private static SSLContext serverContext, trustedContext;
    private static Path fixtureDirectory;

    @BeforeClass public static void makeLocalCertificate() throws Exception {
        fixtureDirectory = Files.createTempDirectory("connectwallet-tls-test-");
        Path storeFile = fixtureDirectory.resolve("localhost-test-only.p12");
        String executable = System.getProperty("os.name").startsWith("Windows") ? "keytool.exe" : "keytool";
        Process keytool = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", executable).toString(),
            "-genkeypair", "-alias", "fixture", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2",
            "-dname", "CN=localhost", "-ext", "SAN=dns:localhost", "-storetype", "PKCS12",
            "-keystore", storeFile.toString(), "-storepass", "test-fixture-only", "-keypass", "test-fixture-only", "-noprompt")
            .redirectErrorStream(true).start();
        try {
            assertTrue("Local test certificate generation timed out", keytool.waitFor(20, TimeUnit.SECONDS));
            assertEquals("Local test certificate generation failed", 0, keytool.exitValue());
        } finally { if (keytool.isAlive()) keytool.destroyForcibly(); keytool.getInputStream().close(); }
        KeyStore keyStore = KeyStore.getInstance("PKCS12");
        try (java.io.InputStream input = Files.newInputStream(storeFile)) { keyStore.load(input, "test-fixture-only".toCharArray()); }
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(keyStore, "test-fixture-only".toCharArray());
        KeyStore trust = KeyStore.getInstance("PKCS12"); trust.load(null, null);
        trust.setCertificateEntry("localhost-test-only", keyStore.getCertificate("fixture"));
        TrustManagerFactory trusts = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); trusts.init(trust);
        serverContext = SSLContext.getInstance("TLS"); serverContext.init(keys.getKeyManagers(), null, new SecureRandom());
        trustedContext = SSLContext.getInstance("TLS"); trustedContext.init(null, trusts.getTrustManagers(), new SecureRandom());
    }
    @AfterClass public static void removeLocalCertificate() throws Exception {
        if (fixtureDirectory != null) try (java.util.stream.Stream<Path> paths = Files.walk(fixtureDirectory)) {
            for (Path path : (Iterable<Path>) paths.sorted(Comparator.reverseOrder())::iterator) Files.delete(path);
        }
    }
    interface Reply { byte[] handle(JSONObject request, Socket socket) throws Exception; }
    private static final class Server implements AutoCloseable {
        final SSLServerSocket listener;
        final ExecutorService acceptor = Executors.newSingleThreadExecutor(), handlers = Executors.newFixedThreadPool(2);
        final List<Socket> sockets = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger requests = new AtomicInteger(), connections = new AtomicInteger();
        Server(Reply reply) throws Exception {
            listener = (SSLServerSocket) serverContext.getServerSocketFactory().createServerSocket(0, 8, InetAddress.getLoopbackAddress());
            acceptor.execute(() -> {
                try {
                    while (!listener.isClosed()) {
                        SSLSocket socket = (SSLSocket) listener.accept(); connections.incrementAndGet(); sockets.add(socket);
                        handlers.execute(() -> {
                            try (Socket connection = socket) {
                                connection.setSoTimeout(3000); socket.startHandshake();
                                String line = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8)).readLine();
                                if (line == null) return;
                                JSONObject request = new JSONObject(line); requests.incrementAndGet();
                                byte[] response = reply.handle(request, socket);
                                if (response != null) { socket.getOutputStream().write(response); socket.getOutputStream().flush(); }
                            } catch (Exception ignored) { /* Expected when rejecting certificates or cancelling. */ }
                        });
                    }
                } catch (Exception ignored) { /* Fixture shutdown releases accept. */ }
            });
        }
        MobileRpcClient client(int timeout) { return client("localhost", trustedContext.getSocketFactory(), timeout); }
        MobileRpcClient client(String hostname, SSLSocketFactory factory, int timeout) {
            MobileRpcClient client = MobileRpcClient.localTestClient(hostname, listener.getLocalPort(), factory,
                unused -> new InetAddress[] { InetAddress.getLoopbackAddress() }, timeout);
            client.setActive(true); return client;
        }
        @Override public void close() throws java.io.IOException {
            try { listener.close(); synchronized (sockets) { for (Socket socket : sockets) socket.close(); } }
            finally {
                handlers.shutdownNow(); acceptor.shutdownNow();
                try { assertTrue(handlers.awaitTermination(3, TimeUnit.SECONDS)); assertTrue(acceptor.awaitTermination(3, TimeUnit.SECONDS)); }
                catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError("TLS fixture shutdown interrupted", interrupted); }
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
        catch (MobileRpcClient.RpcFailure error) { assertEquals("RPC_INVALID", error.code); }
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

    @Test public void productionEndpointCannotSelectPlaintextUrlsOrLoopbackHostnames() {
        for (String hostname : new String[] { "localhost", "127.0.0.1", "::1", "https://example.com", "example.com/rpc", "x.local", "a..com", "-bad.com" }) {
            try { new MobileRpcClient.TlsEndpoint(hostname, 443); fail("Accepted " + hostname); } catch (IllegalArgumentException expected) { }
        }
        assertEquals("rpc.example.com", new MobileRpcClient.TlsEndpoint("RPC.EXAMPLE.COM", 443).hostname);
    }

    @Test public void trustedTlsRoundTripUsesFixedEnvelopeWithoutEnablingReadOnlyWrites() throws Exception {
        try (Server server = new Server((request, socket) -> {
            assertEquals(4, request.length()); assertEquals("getaddressutxos", request.get("method")); assertEquals(ADDRESS, request.getJSONObject("params").get("address"));
            assertTrue(((SSLSocket) socket).getSession().getProtocol().startsWith("TLSv1."));
            return response(request, new JSONObject().put("ok", true));
        }); MobileRpcClient client = server.client(3000)) {
            assertTrue(await(client.call("getaddressutxos", params())).getBoolean("ok"));
            error(client.call("sendrawtransaction", new JSONObject().put("transaction_hex", HEX)), "RPC_INVALID");
            error(client.call("getblockbounties", new JSONObject().put("block_hash", HASH)), "RPC_INVALID");
            assertEquals(1, server.requests.get());
        }
        try { RpcTransport.validateParams("sendrawtransaction", new JSONObject().put("transaction_hex", HEX)); fail("Public watch-only transport accepted a write"); }
        catch (RpcTransport.RpcFailure expected) { assertEquals("RPC_INVALID", expected.code); }
    }

    @Test public void certificateAndHostnameValidationAreRealAndHaveNoPlaintextFallback() throws Exception {
        try (Server server = new Server((request, socket) -> response(request, new JSONObject()))) {
            try (MobileRpcClient untrusted = server.client("localhost", (SSLSocketFactory) SSLSocketFactory.getDefault(), 3000)) {
                assertFalse(error(untrusted.broadcast(HEX), "RPC_TLS").unknownOutcome);
            }
            try (MobileRpcClient mismatch = server.client("wrong.example", trustedContext.getSocketFactory(), 3000)) {
                error(mismatch.call("getchaintip", new JSONObject()), "RPC_TLS");
            }
            assertEquals(0, server.requests.get()); assertEquals(2, server.connections.get());
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
                if (problem.equals("eof")) text = text.substring(0, text.lastIndexOf("{\"jsonrpc\""));
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
            }
        }
        try (Server server = new Server((request, socket) -> null); MobileRpcClient client = server.client(3000)) {
            assertTrue(error(client.broadcast(HEX), "RPC_PROTOCOL").unknownOutcome); assertEquals(1, server.requests.get());
        }
    }

    @Test public void cancellationAfterWritePreservesUnknownOutcomeAndClosesSocket() throws Exception {
        CountDownLatch written = new CountDownLatch(1), disconnected = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> { written.countDown(); if (socket.getInputStream().read() == -1) disconnected.countDown(); return null; });
             MobileRpcClient client = server.client(3000)) {
            CompletableFuture<JSONObject> pending = client.broadcast(HEX); assertTrue(written.await(2, TimeUnit.SECONDS));
            assertTrue(pending.cancel(false)); assertTrue(error(pending, "RPC_CANCELLED").unknownOutcome);
            assertTrue(disconnected.await(2, TimeUnit.SECONDS)); assertEquals(1, server.requests.get());
        }
    }

    @Test public void inactiveCancellationBeforeTransmissionAndDnsDeadlineRemainKnown() throws Exception {
        AtomicInteger resolutions = new AtomicInteger(); CountDownLatch release = new CountDownLatch(1), resolving = new CountDownLatch(1);
        try (MobileRpcClient client = MobileRpcClient.localTestClient("localhost", 1, trustedContext.getSocketFactory(), unused -> {
            resolutions.incrementAndGet(); resolving.countDown();
            try { release.await(2, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
            return new InetAddress[] { InetAddress.getLoopbackAddress() };
        }, 120)) {
            assertFalse(error(client.broadcast(HEX), "RPC_INACTIVE").unknownOutcome); assertEquals(0, resolutions.get());
            client.setActive(true); CompletableFuture<JSONObject> pending = client.broadcast(HEX);
            assertTrue(resolving.await(1, TimeUnit.SECONDS)); assertFalse(error(pending, "RPC_TIMEOUT").unknownOutcome); release.countDown();
        } finally { release.countDown(); }
    }

    @Test public void twoActiveEightQueuedBoundCapacityAndCancelAllDrainsWithoutLateWrites() throws Exception {
        CountDownLatch active = new CountDownLatch(2), release = new CountDownLatch(1);
        try (Server server = new Server((request, socket) -> { active.countDown(); release.await(3, TimeUnit.SECONDS); return response(request, new JSONObject()); });
             MobileRpcClient client = server.client(4000)) {
            List<CompletableFuture<JSONObject>> calls = new ArrayList<>();
            for (int index = 0; index < 10; index++) calls.add(client.call("getchaintip", new JSONObject()));
            assertTrue(active.await(2, TimeUnit.SECONDS)); error(client.call("getchaintip", new JSONObject()), "RPC_BUSY");
            client.cancelAll(); for (CompletableFuture<JSONObject> call : calls) error(call, "RPC_CANCELLED");
            release.countDown(); assertEquals(2, server.requests.get());
            assertNotNull(await(client.call("getchaintip", new JSONObject()))); assertEquals(3, server.requests.get());
        } finally { release.countDown(); }
    }

    @Test public void quotasArePerMethodAndSurviveCancellationWithoutAutomaticRetries() throws Exception {
        try (Server server = new Server((request, socket) -> response(request, new JSONObject())); MobileRpcClient client = server.client(3000)) {
            for (int index = 0; index < 6; index++) await(client.call("gettransactions", new JSONObject().put("txids", new JSONArray().put(HASH))));
            client.cancelAll(); error(client.call("gettransactions", new JSONObject().put("txids", new JSONArray().put(HASH))), "-32029");
            assertEquals(6, server.requests.get());
            for (int index = 0; index < 48; index++) await(client.call("getchaintip", new JSONObject()));
            error(client.call("getchaintip", new JSONObject()), "-32029"); assertEquals(54, server.requests.get());
        }
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
            assertTrue(consuming.await(2, TimeUnit.SECONDS)); error(future, "RPC_TIMEOUT"); release.countDown();
        } finally { release.countDown(); }
    }
}
