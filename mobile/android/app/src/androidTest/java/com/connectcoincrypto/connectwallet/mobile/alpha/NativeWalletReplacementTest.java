package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.AtomicFile;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.activity.result.ActivityResult;
import androidx.lifecycle.Lifecycle;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.Bridge;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Cancellation-only replacement and management checks on a CLEAN, isolated emulator.
 * The owned fixture has an envelope shape but no recovery words or decryptable
 * wallet. Recovery display checks inject clearly public synthetic text directly
 * into the native display callback. These tests never create keys, derive a KDF,
 * unlock, claim, or submit.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeWalletReplacementTest {
    private static final String PROFILE_KEY = "connectwallet.mobile.alpha.public-profile.v1";
    private static final String TITLE = "Replace current wallet?";
    private static final String BACKUP_ACTION = "Save encrypted backup";
    private static final String WALLET_NAME = "mobile-wallet-v1.json";
    private static final byte[] FIXTURE = (" \n{\"format\":\"connectcoin-connect-wallet\",\"version\":1,"
        + "\"kdf\":{\"name\":\"scrypt\",\"N\":131072,\"r\":8,\"p\":1,\"keyLength\":32},"
        + "\"cipher\":\"aes-256-gcm\",\"salt\":\"" + "00".repeat(32) + "\","
        + "\"nonce\":\"" + "00".repeat(12) + "\",\"ciphertext\":\"00\","
        + "\"tag\":\"" + "00".repeat(16) + "\"}\n").getBytes(StandardCharsets.UTF_8);

    private Context context;
    private File vault;
    private boolean ownsFixture;
    private ActivityScenario<MainActivity> scenario;
    private Instrumentation.ActivityMonitor pickerMonitor;
    private Long initialRpcSequence;

    @Before public void requireCleanEmulatorAndInstallOwnedFixture() throws Exception {
        assertTrue("Run replacement tests only on an isolated emulator, never a physical device.",
            "ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE) || Build.MODEL.startsWith("sdk_gphone"));
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.connectcoincrypto.connectwallet.mobile.alpha", context.getPackageName());
        assertNoPaymentClaimsOrProfile();
        Object path = context.getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE).getAll().get("serverBasePath");
        assertTrue("Use an installation without persisted WebView content overrides.", path == null || "".equals(path));
        vault = new File(context.getNoBackupFilesDir(), WALLET_NAME);
        assertAbsent(vault, "Use an isolated installation without an existing wallet.");
        assertNoWalletCompanions();
        NativeWalletBackup.validateSnapshot(FIXTURE);

        // Reserve the exact base path exclusively. A failed precondition never
        // grants cleanup ownership over an existing wallet or its companions.
        assertTrue("The fixture must not replace a file created by another owner.", vault.createNewFile());
        ownsFixture = true;
        assertNoWalletCompanions();
        AtomicFile target = new AtomicFile(vault);
        FileOutputStream output = null;
        try {
            output = target.startWrite();
            output.write(FIXTURE);
            target.finishWrite(output);
            output = null;
        } finally {
            if (output != null) target.failWrite(output);
        }
        assertOwnedWalletUnchanged();
    }

    @After public void closeAndRemoveOnlyUnchangedOwnedFixture() throws Exception {
        try {
            if (scenario != null) scenario.close();
        } finally {
            if (pickerMonitor != null) {
                InstrumentationRegistry.getInstrumentation().removeMonitor(pickerMonitor);
                pickerMonitor = null;
            }
        }
        if (!ownsFixture) return;
        // Failed assertions deliberately leave every file in place for inspection.
        // Never call AtomicFile.delete(), clear preferences, or delete a directory.
        assertOwnedWalletUnchanged();
        assertNoPaymentClaimsOrProfile();
        assertTrue("Only the exact, unchanged test-owned wallet may be removed.", vault.delete());
        ownsFixture = false;
    }

    private static void assertAbsent(File file, String message) { assertFalse(message, file.exists()); }

    private void assertNoWalletCompanions() {
        for (String suffix : new String[] { ".bak", ".new" }) {
            assertAbsent(new File(context.getNoBackupFilesDir(), WALLET_NAME + suffix),
                "Replacement cancellation must not create or consume wallet AtomicFile companions.");
        }
    }

    private void assertNoPaymentClaimsOrProfile() {
        assertFalse("Use an installation without a public profile; never erase user preferences.",
            context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).contains(PROFILE_KEY));
        for (String name : new String[] { "last-payment-public.json", "payment-reservations-v1.json" }) {
            for (String suffix : new String[] { "", ".bak", ".new" }) {
                assertAbsent(new File(context.getNoBackupFilesDir(), name + suffix),
                    "Use an installation without existing payment state.");
            }
        }
        for (String name : new String[] { "claims-public-receipt", "claims-public-policy" }) {
            assertTrue("Use an installation without existing claims state or preferences.",
                context.getSharedPreferences(name, Context.MODE_PRIVATE).getAll().isEmpty());
        }
    }

    private void assertOwnedWalletUnchanged() throws Exception {
        assertTrue("Only the synthetic fixture may be inspected or cleaned up.", ownsFixture);
        assertTrue("The original wallet must still exist.", vault.isFile());
        assertEquals("Cancellation must preserve the exact source length.", FIXTURE.length, vault.length());
        assertNoWalletCompanions();
        // FileInputStream avoids AtomicFile.openRead() recovery mutations in an assertion.
        try (FileInputStream input = new FileInputStream(vault)) {
            byte[] actual = NativeWalletBackup.read(input);
            assertTrue("Cancellation must preserve every original encrypted byte.", Arrays.equals(FIXTURE, actual));
        }
    }

    private void launch() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(activity -> {
            assertEquals(Bridge.DEFAULT_WEB_ASSET_DIR, activity.getBridge().getServerBasePath());
            assertNoWalletWork(plugin(activity));
        });
        awaitReadyUi();
        scenario.onActivity(activity -> assertNoWalletWork(plugin(activity)));
        assertOwnedWalletUnchanged();
    }

    private void awaitReadyUi() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        do {
            if ("true".equals(evaluate("document.documentElement.dataset.ready === 'true'"))) return;
            Thread.sleep(100);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("The bundled UI did not initialize on the isolated emulator.");
    }

    private String evaluate(String expression) throws Exception {
        CompletableFuture<String> result = new CompletableFuture<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(expression, result::complete));
        return result.get(10, TimeUnit.SECONDS);
    }

    private static NativeWalletPlugin plugin(MainActivity activity) {
        return (NativeWalletPlugin) activity.getBridge().getPlugin("NativeWallet").getInstance();
    }

    private static Object field(Object instance, String name) {
        try {
            Field declared = instance.getClass().getDeclaredField(name);
            declared.setAccessible(true);
            return declared.get(instance);
        } catch (ReflectiveOperationException error) {
            throw new AssertionError("Native replacement inspection failed.", error);
        }
    }

    private static boolean hasText(View view, String text) {
        if (view instanceof TextView && text.contentEquals(((TextView) view).getText())) return true;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) if (hasText(group.getChildAt(i), text)) return true;
        }
        return false;
    }

    private static void assertNoInput(View view) {
        assertFalse("Backup confirmation must precede recovery or password input.", view instanceof EditText);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) assertNoInput(group.getChildAt(i));
        }
    }

    private AlertDialog beginReplacement(String buttonId) throws Exception {
        clickAvailable(buttonId);
        return awaitReplacement();
    }
    private void clickAvailable(String buttonId) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        boolean ready = false;
        do {
            ready = "true".equals(evaluate("Boolean(document.getElementById('" + buttonId + "') && !document.getElementById('" + buttonId + "').disabled)"));
            if (ready) break;
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        assertTrue("The replacement action must become available.", ready);
        evaluate("document.getElementById('" + buttonId + "').click(); null");
    }
    private AlertDialog awaitDialog(String title) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        do {
            AtomicReference<AlertDialog> result = new AtomicReference<>();
            scenario.onActivity(activity -> {
                AlertDialog dialog = (AlertDialog)field(plugin(activity), "dialog");
                if (dialog != null && dialog.isShowing() && hasText(dialog.getWindow().getDecorView(), title)) result.set(dialog);
            });
            if (result.get() != null) return result.get();
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        throw new AssertionError("Native dialog did not appear: " + title);
    }
    private AlertDialog awaitReplacement() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        do {
            AtomicReference<AlertDialog> result = new AtomicReference<>();
            scenario.onActivity(activity -> {
                NativeWalletPlugin current = plugin(activity);
                AlertDialog dialog = (AlertDialog) field(current, "dialog");
                if (dialog != null && dialog.isShowing() && hasText(dialog.getWindow().getDecorView(), TITLE)) {
                    assertEquals(BACKUP_ACTION, dialog.getButton(AlertDialog.BUTTON_POSITIVE).getText().toString());
                    assertEquals("Cancel", dialog.getButton(AlertDialog.BUTTON_NEGATIVE).getText().toString());
                    assertNoInput(dialog.getWindow().getDecorView());
                    assertEquals(Boolean.TRUE, field(current, "replacingWallet"));
                    assertNull(field(current, "replacementSource"));
                    assertNull(field(current, "session"));
                    result.set(dialog);
                }
            });
            if (result.get() != null) { assertOwnedWalletUnchanged(); return result.get(); }
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("The native replacement confirmation did not appear.");
        return null;
    }

    private void click(AlertDialog dialog, int button, String label) {
        scenario.onActivity(activity -> {
            assertTrue("The expected confirmation must still be visible.", dialog.isShowing());
            assertSame(dialog, field(plugin(activity), "dialog"));
            assertEquals(label, dialog.getButton(button).getText().toString());
            dialog.getButton(button).performClick();
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    private void assertNoWalletWork(NativeWalletPlugin current) {
        assertNull("Replacement cancellation must not load a public wallet account.", field(current, "account"));
        assertNull("Replacement cancellation must not unlock wallet keys.", field(current, "session"));
        assertEquals(Boolean.FALSE, field(current, "watchActive"));
        assertEquals(Boolean.FALSE, field(current, "broadcasting"));
        Object runtime = field(current, "runtime");
        assertEquals(Boolean.FALSE, field(runtime, "requested"));
        assertEquals(Boolean.FALSE, field(runtime, "service"));
        Object rpc = field(runtime, "rpc");
        synchronized (rpc) {
            long sequence = ((Number) field(rpc, "sequence")).longValue();
            if (initialRpcSequence == null) initialRpcSequence = sequence;
            assertEquals("Cancellation-only replacement must not enqueue RPC work, even while the emulator is online.", initialRpcSequence.longValue(), sequence);
            assertTrue("No wallet RPC requests may remain pending.", ((java.util.Collection<?>) field(rpc, "jobs")).isEmpty());
        }
    }

    private void assertReplacementCleared(NativeWalletPlugin current) {
        assertNull(field(current, "dialogCall"));
        assertFalse(((AtomicBoolean) field(current, "busy")).get());
        for (String name : new String[] { "setupDraft", "replacingWallet", "backupPickerPending", "backupImporting", "replacementBackupVerified", "fileImportMode", "importPickerPending", "exportOnly", "walletCommitted", "recoveryViewed" }) {
            assertEquals("Cancellation must clear " + name + ".", Boolean.FALSE, field(current, name));
        }
        for (String name : new String[] { "replacementSource", "backupDestination", "backupCancellation", "backupDescriptor", "importSource", "importedEnvelope", "pendingPassword", "managementSecrets", "recoveryHide", "session", "account" }) {
            assertNull("Cancellation must release " + name + ".", field(current, name));
        }
        assertNoWalletWork(current);
    }

    private void awaitCancelled() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 5000;
        do {
            AtomicBoolean cancelled = new AtomicBoolean();
            scenario.onActivity(activity -> {
                NativeWalletPlugin current = plugin(activity);
                AlertDialog dialog = (AlertDialog) field(current, "dialog");
                cancelled.set((dialog == null || !dialog.isShowing())
                    && field(current, "dialogCall") == null && !((AtomicBoolean) field(current, "busy")).get());
                if (cancelled.get()) assertReplacementCleared(current);
            });
            if (cancelled.get()) { assertOwnedWalletUnchanged(); assertNoPaymentClaimsOrProfile(); return; }
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("The native replacement call did not cancel.");
    }

    private AlertDialog beginManagement(String buttonId) throws Exception {
        if ("true".equals(evaluate("document.getElementById('settings-panel').hidden"))) clickAvailable("open-settings");
        clickAvailable(buttonId);
        AlertDialog shown = awaitDialog("change-wallet-password".equals(buttonId)
            ? "Change wallet password" : "Authenticate to view recovery phrase");
        scenario.onActivity(activity -> {
            NativeWalletPlugin current = plugin(activity);
            assertEquals("Management requests must contain no password or recovery data.", 0,
                ((PluginCall) field(current, "dialogCall")).getData().length());
            assertEquals(Boolean.FALSE, field(current, "setupDraft"));
            assertNull(field(current, "managementSecrets"));
            assertNull(field(current, "recoveryHide"));
            assertNoWalletWork(current);
        });
        return shown;
    }

    private static void collectInputs(View view, List<EditText> inputs) {
        if (view instanceof EditText) inputs.add((EditText) view);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) collectInputs(group.getChildAt(i), inputs);
        }
    }

    private List<EditText> fillManagementInputs(AlertDialog shown, int expectedCount) {
        List<EditText> inputs = new ArrayList<>();
        scenario.onActivity(activity -> {
            collectInputs(shown.getWindow().getDecorView(), inputs);
            assertEquals(expectedCount, inputs.size());
            for (EditText input : inputs) {
                assertFalse("Password fields must not enter saved Activity state.", input.isSaveEnabled());
                assertEquals(android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD,
                    input.getInputType() & android.text.InputType.TYPE_MASK_VARIATION);
                input.setText("PUBLIC_MANAGEMENT_TEST_PASSWORD");
            }
        });
        return inputs;
    }

    private void assertInputsCleared(List<EditText> inputs) {
        scenario.onActivity(activity -> {
            for (EditText input : inputs) assertEquals("Dismissed native password fields must be cleared.", "", input.getText().toString());
        });
    }

    /** Enter the production display callback without authenticating or touching any keys. */
    private AlertDialog displayPublicRecoveryFixture() throws Exception {
        AlertDialog authentication = beginManagement("view-recovery-phrase");
        char[][] publicText = { "PUBLIC_MANAGEMENT_ALPHA PUBLIC_MANAGEMENT_BETA".toCharArray(),
            "PUBLIC_MANAGEMENT_PASSPHRASE".toCharArray() };
        scenario.onActivity(activity -> {
            NativeWalletPlugin current = plugin(activity);
            PluginCall call = (PluginCall) field(current, "dialogCall");
            long generation = ((Number) field(current, "generation")).longValue();
            // Dismiss only the view; its pending call is reused by the real
            // display callback, just as after the password button is accepted.
            authentication.dismiss();
            try {
                java.lang.reflect.Method retain = NativeWalletPlugin.class.getDeclaredMethod("keepManagementSecrets", PluginCall.class, char[][].class);
                retain.setAccessible(true);
                assertEquals(Boolean.TRUE, retain.invoke(current, call, publicText));
                java.lang.reflect.Method display = NativeWalletPlugin.class.getDeclaredMethod("displayAuthenticatedRecovery", PluginCall.class, long.class, char[][].class);
                display.setAccessible(true);
                display.invoke(current, call, generation, publicText);
            } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
            for (char[] value : publicText) assertArrayEquals("The rendered fixture arrays must be wiped immediately.", new char[value.length], value);
            assertNull(field(current, "managementSecrets"));
            assertNotNull(field(current, "recoveryHide"));
            assertEquals(Boolean.TRUE, field(current, "recoveryViewed"));
            assertNoWalletWork(current);
        });
        AlertDialog shown = awaitDialog("Recovery phrase");
        scenario.onActivity(activity -> {
            assertTrue(hasText(shown.getWindow().getDecorView(), "1. PUBLIC_MANAGEMENT_ALPHA"));
            assertTrue(hasText(shown.getWindow().getDecorView(), "2. PUBLIC_MANAGEMENT_BETA"));
            assertTrue(hasText(shown.getWindow().getDecorView(), "PUBLIC_MANAGEMENT_PASSPHRASE"));
        });
        assertEquals("Public test recovery text must remain outside the WebView.", "false",
            evaluate("document.documentElement.textContent.includes('PUBLIC_MANAGEMENT_')"));
        assertOwnedWalletUnchanged();
        return shown;
    }

    private void assertRecoveryDisplayCleared(AlertDialog shown) {
        scenario.onActivity(activity -> {
            assertFalse("Dismissal must hide the recovery window.", shown.isShowing());
            assertFalse(hasText(shown.getWindow().getDecorView(), "1. PUBLIC_MANAGEMENT_ALPHA"));
            assertFalse(hasText(shown.getWindow().getDecorView(), "2. PUBLIC_MANAGEMENT_BETA"));
            assertFalse(hasText(shown.getWindow().getDecorView(), "PUBLIC_MANAGEMENT_PASSPHRASE"));
            assertReplacementCleared(plugin(activity));
        });
    }

    @Test public void managementPasswordDialogsCancelAndClearWithoutUnlockingOrWriting() throws Exception {
        launch();
        for (String action : new String[] { "change-wallet-password", "view-recovery-phrase" }) {
            for (boolean useCancelEvent : new boolean[] { false, true }) {
                AlertDialog shown = beginManagement(action);
                List<EditText> inputs = fillManagementInputs(shown, "change-wallet-password".equals(action) ? 3 : 1);
                if (useCancelEvent) {
                    scenario.onActivity(activity -> shown.cancel());
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync();
                } else click(shown, AlertDialog.BUTTON_NEGATIVE, "Cancel");
                awaitCancelled(); assertInputsCleared(inputs);
            }
        }
    }

    @Test public void managementPasswordDialogsAreClearedOnPauseAndDoNotReopen() throws Exception {
        launch();
        for (String action : new String[] { "change-wallet-password", "view-recovery-phrase" }) {
            AlertDialog shown = beginManagement(action);
            List<EditText> inputs = fillManagementInputs(shown, "change-wallet-password".equals(action) ? 3 : 1);
            scenario.moveToState(Lifecycle.State.STARTED);
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                assertEquals(Boolean.FALSE, field(plugin(activity), "active"));
                assertFalse(shown.isShowing()); assertReplacementCleared(plugin(activity));
            });
            assertInputsCleared(inputs); assertOwnedWalletUnchanged();
            scenario.moveToState(Lifecycle.State.RESUMED);
            awaitCancelled();
            scenario.onActivity(activity -> assertNull("Returning must not reopen password input.", field(plugin(activity), "dialog")));
        }
    }

    @Test public void publicRecoveryDisplayAutoHideClearsTextAndStaleTimerCannotCancelNextCall() throws Exception {
        launch();
        AlertDialog shown = displayPublicRecoveryFixture();
        AtomicReference<Runnable> expired = new AtomicReference<>();
        scenario.onActivity(activity -> {
            expired.set((Runnable) field(plugin(activity), "recoveryHide"));
            // Invoke the exact scheduled callback without waiting a minute.
            expired.get().run();
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        awaitCancelled(); assertRecoveryDisplayCleared(shown);
        AlertDialog next = beginManagement("change-wallet-password");
        scenario.onActivity(activity -> {
            PluginCall call = (PluginCall) field(plugin(activity), "dialogCall");
            expired.get().run();
            assertSame(call, field(plugin(activity), "dialogCall"));
            assertSame(next, field(plugin(activity), "dialog")); assertTrue(next.isShowing());
        });
        click(next, AlertDialog.BUTTON_NEGATIVE, "Cancel"); awaitCancelled();
    }

    @Test public void publicRecoveryDisplayClosesOnPauseAndNeverReturnsOnResume() throws Exception {
        launch();
        AlertDialog shown = displayPublicRecoveryFixture();
        scenario.moveToState(Lifecycle.State.STARTED);
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
        assertRecoveryDisplayCleared(shown); assertOwnedWalletUnchanged();
        scenario.moveToState(Lifecycle.State.RESUMED);
        awaitCancelled();
        scenario.onActivity(activity -> assertNull(field(plugin(activity), "dialog")));
        assertEquals("false", evaluate("document.documentElement.textContent.includes('PUBLIC_MANAGEMENT_')"));
    }

    @Test public void createConfirmationCancellationPreservesOriginalWallet() throws Exception {
        launch();
        click(beginReplacement("create-wallet"), AlertDialog.BUTTON_NEGATIVE, "Cancel");
        awaitCancelled();
    }

    @Test public void recoveryImportConfirmationCancellationPreservesOriginalWallet() throws Exception {
        launch();
        click(beginReplacement("import-recovery"), AlertDialog.BUTTON_NEGATIVE, "Cancel");
        awaitCancelled();
    }

    @Test public void separateImportControlsSelectTheirOwnNativeFlowWithoutUnlockingWallet() throws Exception {
        launch();
        assertEquals("true", evaluate("['import-wallet','import-recovery'].every(id => Boolean(document.getElementById(id)))"));
        for (String buttonId : new String[]{"import-recovery", "import-wallet"}) {
            AlertDialog confirmation = beginReplacement(buttonId);
            scenario.onActivity(activity -> {
                assertEquals(buttonId.equals("import-wallet"), field(plugin(activity), "fileImportMode"));
                assertNoInput(confirmation.getWindow().getDecorView()); assertNoWalletWork(plugin(activity));
            });
            click(confirmation, AlertDialog.BUTTON_NEGATIVE, "Cancel"); awaitCancelled();
        }
    }

    @Test public void encryptedFileImportRequiresOriginalBackupBeforePasswordOrFileRead() throws Exception {
        launch(); clickAvailable("import-wallet");
        AlertDialog replacement = awaitReplacement();
        scenario.onActivity(activity -> {
            assertEquals(Boolean.TRUE, field(plugin(activity), "fileImportMode"));
            assertEquals(Boolean.FALSE, field(plugin(activity), "importPickerPending"));
            assertNull(field(plugin(activity), "importedEnvelope")); assertNoWalletWork(plugin(activity));
        });
        click(replacement, AlertDialog.BUTTON_NEGATIVE, "Cancel"); awaitCancelled();
    }

    @Test public void lockedWalletCanCancelExportConfirmationAndDocumentPicker() throws Exception {
        launch(); clickAvailable("export-wallet");
        AlertDialog confirmation = awaitDialog("Export encrypted wallet");
        scenario.onActivity(activity -> { assertNoInput(confirmation.getWindow().getDecorView()); assertNoWalletWork(plugin(activity)); });
        click(confirmation, AlertDialog.BUTTON_NEGATIVE, "Cancel"); awaitCancelled();
        clickAvailable("export-wallet"); AlertDialog pickerConfirmation = awaitDialog("Export encrypted wallet");
        IntentFilter filter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
        filter.addCategory(Intent.CATEGORY_OPENABLE); filter.addDataType("application/json");
        pickerMonitor = new Instrumentation.ActivityMonitor(filter, new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true);
        InstrumentationRegistry.getInstrumentation().addMonitor(pickerMonitor);
        try {
            click(pickerConfirmation, AlertDialog.BUTTON_POSITIVE, "Choose location"); awaitCancelled();
            assertEquals(1, pickerMonitor.getHits());
        } finally { InstrumentationRegistry.getInstrumentation().removeMonitor(pickerMonitor); pickerMonitor = null; }
    }

    @Test public void staleImportPickerResultCannotReplaceANewerExportConfirmation() throws Exception {
        launch(); clickAvailable("import-wallet");
        AlertDialog confirmation = awaitReplacement(); AtomicReference<PluginCall> previous = new AtomicReference<>();
        scenario.onActivity(activity -> previous.set((PluginCall)field(plugin(activity), "dialogCall")));
        click(confirmation, AlertDialog.BUTTON_NEGATIVE, "Cancel"); awaitCancelled();
        clickAvailable("export-wallet"); AlertDialog export = awaitDialog("Export encrypted wallet");
        scenario.onActivity(activity -> {
            NativeWalletPlugin current = plugin(activity);
            try {
                java.lang.reflect.Method callback = NativeWalletPlugin.class.getDeclaredMethod("walletImportFileChosen", PluginCall.class, ActivityResult.class);
                callback.setAccessible(true);
                callback.invoke(current, previous.get(), new ActivityResult(Activity.RESULT_OK,
                    new Intent().setData(Uri.parse("content://synthetic.invalid/not-opened"))));
            } catch (ReflectiveOperationException error) { throw new AssertionError(error); }
            assertSame(export, field(current, "dialog")); assertTrue(export.isShowing());
            assertNotSame(previous.get(), field(current, "dialogCall")); assertNull(field(current, "importSource"));
            assertNull(field(current, "importedEnvelope")); assertNoWalletWork(current);
        });
        click(export, AlertDialog.BUTTON_NEGATIVE, "Cancel"); awaitCancelled();
    }

    @Test public void recreationCancelsOldReplacementAndPreservesOriginalWallet() throws Exception {
        launch();
        AlertDialog original = beginReplacement("create-wallet");
        AtomicReference<NativeWalletPlugin> oldPlugin = new AtomicReference<>();
        scenario.onActivity(activity -> oldPlugin.set(plugin(activity)));
        scenario.recreate();
        awaitReadyUi();
        scenario.onActivity(activity -> {
            NativeWalletPlugin previous = oldPlugin.get();
            assertNotSame(previous, plugin(activity));
            assertEquals(Boolean.TRUE, field(previous, "destroyed"));
            assertReplacementCleared(previous);
            assertFalse("Activity recreation must dismiss the original confirmation.", original.isShowing());
            assertNull("Replacement authorization must not survive Activity recreation.", field(plugin(activity), "dialog"));
        });
        awaitCancelled();
        click(beginReplacement("import-wallet"), AlertDialog.BUTTON_NEGATIVE, "Cancel");
        awaitCancelled();
    }

    @Test public void cancelledBackupPickerPreservesOriginalForCreateAndImport() throws Exception {
        launch();
        for (String buttonId : new String[] { "create-wallet", "import-recovery", "import-wallet" }) {
            AlertDialog confirmation = beginReplacement(buttonId);
            IntentFilter filter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
            filter.addCategory(Intent.CATEGORY_OPENABLE);
            filter.addDataType("application/json");
            pickerMonitor = new Instrumentation.ActivityMonitor(filter,
                new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true);
            InstrumentationRegistry.getInstrumentation().addMonitor(pickerMonitor);
            try {
                click(confirmation, AlertDialog.BUTTON_POSITIVE, BACKUP_ACTION);
                awaitCancelled();
                assertEquals("Exactly one SAF backup request must be canceled before a provider opens.", 1, pickerMonitor.getHits());
            } finally {
                InstrumentationRegistry.getInstrumentation().removeMonitor(pickerMonitor);
                pickerMonitor = null;
            }
        }
    }
}
