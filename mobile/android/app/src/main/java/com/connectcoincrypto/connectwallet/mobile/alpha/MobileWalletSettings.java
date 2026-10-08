package com.connectcoincrypto.connectwallet.mobile.alpha;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONException;
import org.json.JSONObject;

/** Native-owned preferences. This value is never an unrestricted RPC request. */
final class MobileWalletSettings {
    private static final String STORE = "wallet-public-settings", KEY = "settings";

    static final class Settings {
        final String theme, rpcHost;
        final int autoLockMinutes, rpcPort;

        private Settings(String theme, int autoLockMinutes, MobileRpcClient.TcpEndpoint endpoint) {
            this.theme = theme; this.autoLockMinutes = autoLockMinutes;
            rpcHost = endpoint.hostname; rpcPort = endpoint.port;
        }

        JSONObject toJson() {
            try {
                return new JSONObject().put("theme", theme).put("autoLockMinutes", autoLockMinutes)
                    .put("rpcHost", rpcHost).put("rpcPort", rpcPort);
            } catch (JSONException impossible) { throw new IllegalStateException("Cannot read wallet settings.", impossible); }
        }

        MobileRpcClient.TcpEndpoint endpoint() { return new MobileRpcClient.TcpEndpoint(rpcHost, rpcPort); }

        boolean sameEndpoint(Settings other) {
            return other != null && rpcHost.equals(other.rpcHost) && rpcPort == other.rpcPort;
        }
    }

    static Settings defaults() {
        return new Settings("dark", 0, new MobileRpcClient.TcpEndpoint("connectcoin4.com", 48190));
    }

    /** Pure JSON policy: no Android calls, coercion, partial updates or extra keys. */
    static Settings parse(JSONObject data) {
        if (data == null || data.length() != 4) throw new IllegalArgumentException("Invalid wallet settings.");
        Object theme = data.opt("theme"), host = data.opt("rpcHost");
        if (!(theme instanceof String) || !(theme.equals("dark") || theme.equals("light") || theme.equals("system"))) {
            throw new IllegalArgumentException("Choose dark, light or system theme.");
        }
        if (!(host instanceof String)) throw new IllegalArgumentException("Enter a public DNS hostname for RPC.");
        int minutes = integer(data.opt("autoLockMinutes"), 0, 1440, "Auto-lock must be a whole number from 0 to 1440 minutes.");
        int port = integer(data.opt("rpcPort"), 1, 65535, "RPC port must be a whole number from 1 to 65535.");
        return new Settings((String) theme, minutes, new MobileRpcClient.TcpEndpoint((String) host, port));
    }

    private static int integer(Object value, int minimum, int maximum, String message) {
        if (!(value instanceof Integer || value instanceof Long) || ((Number) value).longValue() < minimum ||
                ((Number) value).longValue() > maximum) throw new IllegalArgumentException(message);
        return ((Number) value).intValue();
    }

    /** A malformed or incomplete persisted record cannot silently select a partial endpoint. */
    static Settings restore(Object saved) {
        if (!(saved instanceof String)) return defaults();
        try { return parse(new JSONObject((String) saved)); }
        catch (JSONException | IllegalArgumentException invalid) { return defaults(); }
    }

    static synchronized Settings read(Context context) {
        return restore(context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getAll().get(KEY));
    }

    /** One synchronous record commit covers all four settings before success is reported. */
    static synchronized void save(Context context, Settings settings) {
        if (settings == null) throw new IllegalArgumentException("Invalid wallet settings.");
        SharedPreferences preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
        Object previous = preferences.getAll().get(KEY);
        if (!preferences.edit().putString(KEY, settings.toJson().toString()).commit()) {
            // Android applies an editor to memory even when its disk commit fails.
            // Restore the old complete value there as well as on disk when possible.
            SharedPreferences.Editor rollback = preferences.edit();
            if (previous instanceof String) rollback.putString(KEY, (String) previous); else rollback.remove(KEY);
            rollback.commit();
            throw new IllegalStateException("Could not save wallet settings.");
        }
    }
}
