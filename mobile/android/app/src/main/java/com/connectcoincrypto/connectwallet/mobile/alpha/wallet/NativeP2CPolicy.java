package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import java.math.BigInteger;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/** Public bounty creation policy. No network, keys, renderer-supplied transaction or signing API. */
public final class NativeP2CPolicy {
    private static final BigInteger MAX_EXPECTED = BigInteger.ONE.shiftLeft(256);
    private NativeP2CPolicy() {}
    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalArgumentException(message);
    }

    public static Request request(JSONObject input) throws Exception {
        require(input != null && input.length() == (input.has("fundingAddresses") ? 4 : 3) && input.opt("domain") instanceof String
            && input.opt("amount") instanceof String && input.opt("expectedConnections") instanceof String,
            "Enter only a domain, decimal CONN reward and expected connections.");
        String rawDomain = input.getString("domain");
        require(rawDomain.length() <= 1024, "Domain is too long.");
        require(rawDomain.matches("[\\x09-\\x0d\\x20-\\x7e]+"), "Use an ASCII public domain or punycode, not a URL.");
        String domain = rawDomain.trim().toLowerCase(Locale.ROOT);
        require(NativeTransactions.canonicalDomain(domain) && domain.contains("."),
            "Use an ASCII public domain or punycode, not a URL.");
        String tld = domain.substring(domain.lastIndexOf('.') + 1);
        require(!tld.matches("[0-9]+"), "Use a public domain, not an IP address.");
        for (String suffix : new String[]{"localhost", "local", "localdomain", "internal", "test", "invalid", "onion"}) {
            require(!tld.equals(suffix), "Use a public Internet domain.");
        }
        require(!domain.equals("home.arpa") && !domain.endsWith(".home.arpa"), "Use a public Internet domain.");
        String expected = input.getString("expectedConnections");
        require(expected.matches("[1-9][0-9]{0,77}") && new BigInteger(expected).compareTo(MAX_EXPECTED) <= 0,
            "Expected connections must be an integer from 1 through 2^256.");
        long reward = NativeTransactions.coinAmount(input.getString("amount"));
        Request request = new Request(domain, Long.toString(reward), expected, "unavailable", NativeFundingScope.optional(input));
        NativeTransactions.recipient(request.destination()); // Includes typed-output dust and policy checks.
        return request;
    }

    /** Immutable values are retained by the native review; every returned JSON object is a fresh copy. */
    public static final class Request {
        public final String domain, amount, expectedConnections, rsaProbeStatus;
        public final int signatureMask;
        public final NativeFundingScope fundingScope;
        private Request(String domain, String amount, String expectedConnections, String rsaProbeStatus, NativeFundingScope fundingScope) {
            this.domain = domain; this.amount = amount; this.expectedConnections = expectedConnections;
            this.rsaProbeStatus = rsaProbeStatus; signatureMask = "verified".equals(rsaProbeStatus) ? 6 : 7;
            this.fundingScope = fundingScope;
        }
        /** Only native orchestration supplies this outcome; it is never a bridge input. */
        public Request withProbe(String status) {
            String outcome = "verified".equals(status) || "timeout".equals(status) || "busy".equals(status)
                || "unavailable".equals(status) ? status : "failed";
            return new Request(domain, amount, expectedConnections, outcome, fundingScope);
        }
        public JSONObject destination() throws Exception {
            return new JSONObject().put("domain", domain).put("amount", amount)
                .put("expectedConnections", expectedConnections).put("mask", signatureMask);
        }
        public void verifyPlan(JSONObject plan, String changeAddress) throws Exception {
            JSONObject recipient = NativeTransactions.recipient(destination());
            JSONArray outputs = plan.getJSONObject("transaction").getJSONArray("outputs");
            require(outputs.length() >= 1 && outputs.length() <= 2, "Bounty review changed. Review again.");
            JSONObject output = outputs.getJSONObject(0);
            require(output.length() == recipient.length(), "Bounty review changed. Review again.");
            for (String key : new String[]{"type", "amount", "domain", "target", "rootVersion", "mask"}) {
                require(recipient.get(key).equals(output.opt(key)), "Bounty review changed. Review again.");
            }
            require(amount.equals(plan.getString("total")) && amount.equals(plan.getString("requestedTotal")),
                "Bounty reward changed. Review again.");
            long change = NativeTransactions.amount(plan.getString("change"));
            require((change > 0) == (outputs.length() == 2), "Bounty change changed. Review again.");
            if (change > 0) {
                JSONObject returned = outputs.getJSONObject(1);
                require(returned.length() == 3 && returned.getInt("type") == 1
                    && Long.toString(change).equals(returned.opt("amount"))
                    && WalletCrypto.hex(WalletCrypto.decodeAddress(changeAddress)).equals(returned.opt("publicKey")),
                    "Bounty change changed. Review again.");
            }
            long fee = NativeTransactions.amount(plan.getString("fee"));
            require(fee <= NativeTransactions.COIN
                && Math.addExact(Math.addExact(NativeTransactions.amount(amount), change), fee)
                    == NativeTransactions.amount(plan.getString("inputTotal")),
                "Bounty totals changed. Review again.");
        }
        public String review(JSONObject plan, String changeAddress) throws Exception {
            verifyPlan(plan, changeAddress);
            return "MAINNET — CREATE PUBLIC P2C BOUNTY\n\nDomain: " + domain
                + "\nPublic reward: " + NativeTransactions.format(NativeTransactions.amount(amount)) + " CONN"
                + "\nExpected connections: " + expectedConnections
                + " (statistical average, not a guaranteed number of attempts)"
                + "\nAllowed signatures: " + (signatureMask == 6
                    ? "RSA-PSS-RSAE / SHA-256 and RSA-PSS-PSS / SHA-256 only (mask 6)"
                    : "ECDSA P-256 / SHA-256, RSA-PSS-RSAE / SHA-256 and RSA-PSS-PSS / SHA-256 (mask 7)")
                + "\nCertificate roots: version 1"
                + "\n" + probeDescription()
                + "\nMining fee: " + NativeTransactions.format(NativeTransactions.amount(plan.getString("fee"))) + " CONN"
                + "\nChange: " + NativeTransactions.format(NativeTransactions.amount(plan.getString("change"))) + " CONN"
                + "\nWallet change address: " + changeAddress
                + "\n\nThis creates a public bounty, not a payment to the domain owner. Anyone who submits a valid qualifying proof can claim the reward. Creating it spends your coins and cannot be undone.";
        }
        private String probeDescription() {
            if (signatureMask == 6) return "RSA support verified with one authenticated TLS 1.3 connection. This checks one server now, not every server or future availability.";
            String reason = "timeout".equals(rsaProbeStatus) ? "The RSA check timed out."
                : "busy".equals(rsaProbeStatus) ? "The RSA checker is busy."
                : "unavailable".equals(rsaProbeStatus) ? "The RSA checker is unavailable."
                : "The RSA check did not verify support.";
            return reason + " RSA support is unconfirmed. All supported signature schemes remain allowed; this does not mean the domain cannot be claimed.";
        }
    }
}
