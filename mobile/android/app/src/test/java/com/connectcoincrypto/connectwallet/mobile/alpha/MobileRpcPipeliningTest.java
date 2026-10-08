package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;

/** Independent wire-level regression tests. One loopback TCP connection, no real funds/server. */
public class MobileRpcPipeliningTest {
    @FunctionalInterface interface Script { void run(Socket socket, BufferedReader input) throws Exception; }
    private static final class Fixture implements AutoCloseable {
        final ServerSocket listener = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        final ExecutorService thread = Executors.newSingleThreadExecutor();
        final CountDownLatch close = new CountDownLatch(1);
        final Future<?> server;
        volatile Socket socket;
        Fixture(Script script) throws Exception {
            server = thread.submit(() -> {
                try (Socket accepted = listener.accept()) {
                    socket = accepted; accepted.setSoTimeout(4000);
                    script.run(accepted, new BufferedReader(new InputStreamReader(accepted.getInputStream(), StandardCharsets.UTF_8)));
                    assertTrue("Fixture must be closed", close.await(8, TimeUnit.SECONDS));
                } catch (Exception failure) { throw new RuntimeException(failure); }
            });
        }
        MobileRpcClient client() {
            MobileRpcClient client = MobileRpcClient.localTestClient("localhost", listener.getLocalPort(),
                unused -> new InetAddress[]{InetAddress.getLoopbackAddress()}, 6000);
            client.setActive(true); return client;
        }
        @Override public void close() throws Exception {
            close.countDown();
            try { server.get(5, TimeUnit.SECONDS); }
            finally {
                listener.close(); if (socket != null) socket.close(); thread.shutdownNow();
                assertTrue(thread.awaitTermination(3, TimeUnit.SECONDS));
            }
        }
    }
    private static String hash(int index) { return String.format("%064x", index); }
    private static JSONObject read(BufferedReader input) throws Exception {
        String line = input.readLine(); assertNotNull("Expected another request on the SAME socket", line);
        return new JSONObject(line);
    }
    private static void reply(Socket socket, JSONObject request) throws Exception {
        JSONObject result = new JSONObject().put("echo", request.getJSONObject("params").getString("txid"));
        reply(socket, request, result);
    }
    private static void reply(Socket socket, JSONObject request, JSONObject result) throws Exception {
        byte[] bytes = (new JSONObject().put("jsonrpc", "2.0").put("id", request.get("id")).put("result", result) + "\n").getBytes(StandardCharsets.UTF_8);
        socket.getOutputStream().write(bytes); socket.getOutputStream().flush();
    }
    private static void noFrame(Socket socket, BufferedReader input) throws Exception {
        socket.setSoTimeout(150);
        try { input.readLine(); fail("The seventeenth wire slot was released too early"); }
        catch (SocketTimeoutException expected) { }
        finally { socket.setSoTimeout(4000); }
    }
    private static List<CompletableFuture<JSONObject>> reads(MobileRpcClient client, int count) throws Exception {
        List<CompletableFuture<JSONObject>> result = new ArrayList<>();
        for (int index = 0; index < count; index++) result.add(client.call("gettransaction", new JSONObject().put("txid", hash(index))));
        return result;
    }
    private static MobileRpcClient.RpcFailure failure(CompletableFuture<JSONObject> future) throws Exception {
        try { future.get(5, TimeUnit.SECONDS); throw new AssertionError("Expected cancellation"); }
        catch (ExecutionException failed) {
            assertTrue(failed.getCause() instanceof MobileRpcClient.RpcFailure);
            return (MobileRpcClient.RpcFailure)failed.getCause();
        }
    }

    @Test(timeout = 15000) public void sixteenRequestsAreWrittenBeforeAnyResponseAndOneConnectionIsReused() throws Exception {
        CountDownLatch allRead = new CountDownLatch(1), release = new CountDownLatch(1);
        try (Fixture fixture = new Fixture((socket, input) -> {
            List<JSONObject> requests = new ArrayList<>();
            for (int index = 0; index < 16; index++) requests.add(read(input));
            allRead.countDown(); assertTrue(release.await(4, TimeUnit.SECONDS));
            // IDs, not arrival order, must associate replies with the correct caller.
            for (int index = requests.size() - 1; index >= 0; index--) reply(socket, requests.get(index));
            JSONObject reused = read(input); assertEquals(hash(16), reused.getJSONObject("params").getString("txid"));
            reply(socket, reused);
        }); MobileRpcClient client = fixture.client()) {
            List<CompletableFuture<JSONObject>> calls = reads(client, 16);
            try {
                assertTrue("Not sixteen pending frames on one TCP connection", allRead.await(4, TimeUnit.SECONDS));
                for (CompletableFuture<JSONObject> call : calls) assertFalse(call.isDone());
            } finally { release.countDown(); }
            for (int index = 0; index < 16; index++) assertEquals(hash(index), calls.get(index).get(5, TimeUnit.SECONDS).getString("echo"));
            assertEquals(hash(16), client.call("gettransaction", new JSONObject().put("txid", hash(16))).get(5, TimeUnit.SECONDS).getString("echo"));
        } finally { release.countDown(); }
    }

    @Test(timeout = 15000) public void cancelledWrittenReadKeepsItsWireSlotUntilTheReplyIsDrained() throws Exception {
        CountDownLatch allRead = new CountDownLatch(1), cancelled = new CountDownLatch(1);
        try (Fixture fixture = new Fixture((socket, input) -> {
            List<JSONObject> requests = new ArrayList<>(); JSONObject abandoned = null;
            for (int index = 0; index < 16; index++) {
                JSONObject request = read(input); requests.add(request);
                if (hash(0).equals(request.getJSONObject("params").getString("txid"))) abandoned = request;
            }
            assertNotNull(abandoned); allRead.countDown(); assertTrue(cancelled.await(4, TimeUnit.SECONDS));
            noFrame(socket, input);
            reply(socket, abandoned);
            JSONObject next = read(input); assertEquals(hash(16), next.getJSONObject("params").getString("txid"));
            reply(socket, next);
            for (JSONObject request : requests) if (request != abandoned) reply(socket, request);
        }); MobileRpcClient client = fixture.client()) {
            List<CompletableFuture<JSONObject>> calls = reads(client, 16);
            try {
                assertTrue(allRead.await(4, TimeUnit.SECONDS));
                assertTrue(calls.get(0).cancel(false));
                assertEquals("RPC_CANCELLED", failure(calls.get(0)).code);
                calls.add(client.call("gettransaction", new JSONObject().put("txid", hash(16))));
            } finally { cancelled.countDown(); }
            for (int index = 1; index <= 16; index++) assertEquals(hash(index), calls.get(index).get(5, TimeUnit.SECONDS).getString("echo"));
        } finally { cancelled.countDown(); }
    }

    @Test(timeout = 15000) public void preWriteBroadcastCancellationNeverSendsAndDoesNotDisconnectTheOtherSixteenReads() throws Exception {
        CountDownLatch allRead = new CountDownLatch(1), cancelled = new CountDownLatch(1);
        try (Fixture fixture = new Fixture((socket, input) -> {
            List<JSONObject> requests = new ArrayList<>();
            for (int index = 0; index < 16; index++) requests.add(read(input));
            allRead.countDown(); assertTrue(cancelled.await(4, TimeUnit.SECONDS)); noFrame(socket, input);
            for (JSONObject request : requests) reply(socket, request);
            JSONObject next = read(input); assertEquals("gettransaction", next.getString("method"));
            assertEquals(hash(16), next.getJSONObject("params").getString("txid")); reply(socket, next);
        }); MobileRpcClient client = fixture.client()) {
            List<CompletableFuture<JSONObject>> calls = reads(client, 16);
            try {
                assertTrue(allRead.await(4, TimeUnit.SECONDS));
                CompletableFuture<JSONObject> broadcast = client.broadcast("00".repeat(10));
                assertTrue(client.cancelBeforeWrite(broadcast));
                MobileRpcClient.RpcFailure error = failure(broadcast);
                assertEquals("RPC_CANCELLED", error.code); assertFalse(error.unknownOutcome);
            } finally { cancelled.countDown(); }
            for (int index = 0; index < 16; index++) assertEquals(hash(index), calls.get(index).get(5, TimeUnit.SECONDS).getString("echo"));
            assertEquals(hash(16), client.call("gettransaction", new JSONObject().put("txid", hash(16))).get(5, TimeUnit.SECONDS).getString("echo"));
        } finally { cancelled.countDown(); }
    }

    @Test(timeout = 15000) public void cancellingAWrittenSiblingDoesNotMakeAnOutstandingBroadcastUnknown() throws Exception {
        CountDownLatch written = new CountDownLatch(1), cancelled = new CountDownLatch(1);
        try (Fixture fixture = new Fixture((socket, input) -> {
            JSONObject first = read(input), second = read(input);
            JSONObject broadcast = "sendrawtransaction".equals(first.getString("method")) ? first : second;
            JSONObject abandoned = broadcast == first ? second : first;
            assertEquals("sendrawtransaction", broadcast.getString("method"));
            assertEquals("gettransaction", abandoned.getString("method"));
            written.countDown(); assertTrue(cancelled.await(4, TimeUnit.SECONDS));
            reply(socket, abandoned);
            reply(socket, broadcast, new JSONObject().put("txid", hash(900)));
            reply(socket, read(input));
        }); MobileRpcClient client = fixture.client()) {
            CompletableFuture<JSONObject> reading = client.call("gettransaction", new JSONObject().put("txid", hash(0)));
            CompletableFuture<JSONObject> broadcast = client.broadcast("00".repeat(10));
            try {
                assertTrue(written.await(4, TimeUnit.SECONDS)); assertTrue(reading.cancel(false));
                assertEquals("RPC_CANCELLED", failure(reading).code);
            } finally { cancelled.countDown(); }
            assertEquals(hash(900), broadcast.get(5, TimeUnit.SECONDS).getString("txid"));
            assertEquals(hash(1), client.call("gettransaction", new JSONObject().put("txid", hash(1))).get(5, TimeUnit.SECONDS).getString("echo"));
        } finally { cancelled.countDown(); }
    }

    @Test(timeout = 10000) public void deadlineCompletionNeverCallsWalletCodeWhileHoldingTheRpcMonitor() throws Exception {
        CountDownLatch written = new CountDownLatch(1), release = new CountDownLatch(1);
        try (Fixture fixture = new Fixture((socket, input) -> {
            read(input); written.countDown(); assertTrue(release.await(4, TimeUnit.SECONDS));
        }); MobileRpcClient client = MobileRpcClient.localTestClient("localhost", fixture.listener.getLocalPort(),
                unused -> new InetAddress[]{InetAddress.getLoopbackAddress()}, 500)) {
            client.setActive(true);
            CompletableFuture<JSONObject> pending = client.call("getchaintip", new JSONObject());
            CompletableFuture<?> checked = pending.handle((result, error) -> {
                assertFalse("A callback holding a wallet lock must be able to call RPC without lock inversion", Thread.holdsLock(client));
                return null;
            });
            try {
                assertTrue(written.await(2, TimeUnit.SECONDS));
                assertEquals("RPC_TIMEOUT", failure(pending).code); checked.get(3, TimeUnit.SECONDS);
            } finally { release.countDown(); }
        } finally { release.countDown(); }
    }
}
