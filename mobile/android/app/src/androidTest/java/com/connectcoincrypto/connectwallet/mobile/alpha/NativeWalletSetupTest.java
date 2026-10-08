package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;

import android.app.AlertDialog;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.TextView;
import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.Bridge;
import java.io.File;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Native onboarding on a CLEAN, isolated emulator only. Every flow is cancelled
 * before encryption/persistence; no RPC, signing, claims or transaction is run.
 * Temporary generated recovery words stay in Java memory and are never included
 * in assertion output, JavaScript, files or logs.
 */
@RunWith(AndroidJUnit4.class)
public final class NativeWalletSetupTest {
    private static final String PROFILE_KEY = "connectwallet.mobile.alpha.public-profile.v1";
    private static final String WORDS_TITLE = "Step 1 of 3: Recovery words";
    private static final String CONFIRM_TITLE = "Step 2 of 3: Confirm recovery words";
    private static final String PASSWORD_TITLE = "Step 3 of 3: Protect your wallet";
    private static final String MISMATCH = "The words do not match. Check your backup and try again.";
    private Context context;
    private ActivityScenario<MainActivity> scenario;

    @Before public void requireCleanEmulator() {
        assertTrue("Run onboarding tests only on an isolated Android emulator, never a physical device.",
            "ranchu".equals(Build.HARDWARE) || "goldfish".equals(Build.HARDWARE) || Build.MODEL.startsWith("sdk_gphone"));
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.connectcoincrypto.connectwallet.mobile.alpha", context.getPackageName());
        assertFalse("Use an installation without an existing public profile; do not erase user preferences.",
            context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).contains(PROFILE_KEY));
        Object path = context.getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE).getAll().get("serverBasePath");
        assertTrue("Use an installation without persisted WebView content overrides.", path == null || "".equals(path));
        assertNoWallet();
        for (String name : new String[] { "last-payment-public.json", "payment-reservations-v1.json" }) {
            assertFalse("Use an isolated installation without existing payment data.", new File(context.getNoBackupFilesDir(), name).exists());
        }
    }

    @After public void closeActivity() {
        if (scenario != null) scenario.close();
        if (context != null) assertNoWallet();
    }

    private void assertNoWallet() {
        for (String suffix : new String[] { "", ".bak", ".new" }) {
            assertFalse("Cancelled onboarding must not create or replace a wallet file.",
                new File(context.getNoBackupFilesDir(), "mobile-wallet-v1.json" + suffix).exists());
        }
    }

    private void launch() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(activity -> {
            assertEquals(Bridge.DEFAULT_WEB_ASSET_DIR, activity.getBridge().getServerBasePath());
            assertEquals("The Activity must permit screenshots.", 0,
                activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE);
        });
        awaitReadyUi();
    }

    private void awaitReadyUi() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        do {
            if ("true".equals(evaluate("document.documentElement.dataset.ready === 'true'"))) return;
            Thread.sleep(100);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("Bundled UI did not initialize on the isolated emulator.");
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
            throw new AssertionError("Native onboarding inspection failed.", error);
        }
    }

    private static <T extends View> List<T> views(View root, Class<T> type) {
        List<T> result = new ArrayList<>();
        if (type.isInstance(root)) result.add(type.cast(root));
        if (root instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) result.addAll(views(group.getChildAt(i), type));
        }
        return result;
    }

    private static boolean hasText(AlertDialog dialog, String wanted) {
        for (TextView view : views(dialog.getWindow().getDecorView(), TextView.class)) {
            if (wanted.contentEquals(view.getText())) return true;
        }
        return false;
    }

    private static boolean containsText(AlertDialog dialog, String wanted) {
        for (TextView view : views(dialog.getWindow().getDecorView(), TextView.class)) {
            if (view.getText().toString().contains(wanted)) return true;
        }
        return false;
    }

    private AlertDialog awaitDialog(String title) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        do {
            AtomicReference<AlertDialog> result = new AtomicReference<>();
            scenario.onActivity(activity -> {
                AlertDialog dialog = (AlertDialog) field(plugin(activity), "dialog");
                if (dialog != null && dialog.isShowing() && hasText(dialog, title)) {
                    assertEquals("Native onboarding dialogs must permit screenshots.", 0,
                        dialog.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE);
                    result.set(dialog);
                }
            });
            if (result.get() != null) return result.get();
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("Expected native onboarding step did not appear: " + title);
        return null;
    }

    private void inspect(AlertDialog dialog, Consumer<AlertDialog> action) {
        scenario.onActivity(activity -> {
            assertTrue("The expected onboarding dialog must still be visible.", dialog.isShowing());
            assertSame("Only the active native dialog may accept input.", dialog, field(plugin(activity), "dialog"));
            action.accept(dialog);
        });
    }

    private void click(AlertDialog dialog, int button, String label) {
        inspect(dialog, current -> {
            assertNotNull("The native action button is required.", current.getButton(button));
            assertEquals(label, current.getButton(button).getText().toString());
            current.getButton(button).performClick();
        });
        InstrumentationRegistry.getInstrumentation().waitForIdleSync();
    }

    private AlertDialog create() throws Exception {
        awaitSetupButton("create-wallet");
        evaluate("document.getElementById('create-wallet').click(); null");
        return awaitDialog(WORDS_TITLE);
    }

    private void awaitSetupButton(String id) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        do {
            if ("true".equals(evaluate("Boolean(document.getElementById('" + id + "') && !document.getElementById('" + id + "').disabled)"))) return;
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("The bundled setup button did not become available: " + id);
    }

    private String[] recoveryWords(AlertDialog dialog) {
        String[] words = new String[24];
        inspect(dialog, current -> {
            assertEquals("Recovery words must be shown before requesting any input.", 0,
                views(current.getWindow().getDecorView(), EditText.class).size());
            Pattern numbered = Pattern.compile("^(\\d{1,2})\\. ([a-z]+)$");
            int count = 0;
            for (TextView view : views(current.getWindow().getDecorView(), TextView.class)) {
                Matcher match = numbered.matcher(view.getText());
                if (!match.matches()) continue;
                int number = Integer.parseInt(match.group(1));
                assertTrue("Recovery word numbering must be within 1 through 24.", number >= 1 && number <= 24);
                assertTrue("Each recovery position must appear exactly once.", words[number - 1] == null);
                words[number - 1] = match.group(2);
                count++;
            }
            assertEquals("The first step must visibly display all 24 numbered words.", 24, count);
        });
        return words;
    }

    private static EditText hinted(AlertDialog dialog, String hint) {
        for (EditText view : views(dialog.getWindow().getDecorView(), EditText.class)) {
            if (hint.contentEquals(view.getHint())) return view;
        }
        throw new AssertionError("A required native input is missing: " + hint);
    }

    private void fillConfirmation(AlertDialog dialog, String[] words) {
        inspect(dialog, current -> {
            assertEquals("Confirmation must request exactly three words, not a password.", 3,
                views(current.getWindow().getDecorView(), EditText.class).size());
            hinted(current, "Word 3").setText(words[2]);
            hinted(current, "Word 12").setText(words[11]);
            hinted(current, "Word 23").setText(words[22]);
        });
    }

    private AlertDialog reachPassword() throws Exception {
        AlertDialog wordsDialog = create();
        String[] words = recoveryWords(wordsDialog);
        try {
            click(wordsDialog, AlertDialog.BUTTON_POSITIVE, "I wrote down my words");
            AlertDialog confirmation = awaitDialog(CONFIRM_TITLE);
            fillConfirmation(confirmation, words);
            click(confirmation, AlertDialog.BUTTON_POSITIVE, "Continue");
            return awaitDialog(PASSWORD_TITLE);
        } finally { Arrays.fill(words, null); }
    }

    private void assertOperationCancelled() throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 5000;
        do {
            AtomicBoolean cancelled = new AtomicBoolean();
            scenario.onActivity(activity -> {
                NativeWalletPlugin plugin = plugin(activity);
                AlertDialog dialog = (AlertDialog) field(plugin, "dialog");
                cancelled.set((dialog == null || !dialog.isShowing())
                    && field(plugin, "dialogCall") == null && !((AtomicBoolean) field(plugin, "busy")).get());
                assertNull("Cancelled onboarding must not unlock a wallet.", field(plugin, "session"));
                assertNull("Cancelled onboarding must not retain a password buffer.", field(plugin, "pendingPassword"));
                if (cancelled.get()) assertEquals("Cancelled onboarding must not retain a setup draft.", Boolean.FALSE, field(plugin, "setupDraft"));
            });
            if (cancelled.get()) { assertNoWallet(); return; }
            Thread.sleep(50);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("The native onboarding operation did not cancel.");
    }

    @Test public void creationShowsWordsBeforeConfirmationAndPasswordAndAllowsReview() throws Exception {
        launch();
        AlertDialog first = create();
        String[] words = recoveryWords(first);
        try {
            click(first, AlertDialog.BUTTON_POSITIVE, "I wrote down my words");
            AlertDialog confirmation = awaitDialog(CONFIRM_TITLE);
            inspect(confirmation, current -> {
                hinted(current, "Word 3").setText("INVALID");
                hinted(current, "Word 12").setText("INVALID");
                hinted(current, "Word 23").setText("INVALID");
            });
            click(confirmation, AlertDialog.BUTTON_POSITIVE, "Continue");
            AlertDialog mismatch = awaitDialog(CONFIRM_TITLE);
            inspect(mismatch, current -> {
                assertTrue("A mismatched word must produce a retryable inline error.", containsText(current, MISMATCH));
                assertEquals("A mismatch must not advance to a password request.", 3,
                    views(current.getWindow().getDecorView(), EditText.class).size());
            });
            assertNoWallet();
            click(mismatch, AlertDialog.BUTTON_NEUTRAL, "Review words");
            AlertDialog reviewed = awaitDialog(WORDS_TITLE);
            String[] reviewedWords = recoveryWords(reviewed);
            try {
                assertTrue("Review must display the same recovery phrase, never generate another one.", Arrays.equals(words, reviewedWords));
            } finally { Arrays.fill(reviewedWords, null); }
            click(reviewed, AlertDialog.BUTTON_POSITIVE, "I wrote down my words");
            AlertDialog retry = awaitDialog(CONFIRM_TITLE);
            fillConfirmation(retry, words);
            click(retry, AlertDialog.BUTTON_POSITIVE, "Continue");
            AlertDialog password = awaitDialog(PASSWORD_TITLE);
            inspect(password, current -> {
                assertEquals("Password protection must request only password and confirmation.", 2,
                    views(current.getWindow().getDecorView(), EditText.class).size());
                assertFalse("The password step must not display the recovery phrase.", containsText(current, String.join(" ", words)));
                for (TextView text : views(current.getWindow().getDecorView(), TextView.class)) {
                    assertFalse("The password step must not redisplay numbered recovery words.",
                        text.getText().toString().matches("\\d{1,2}\\. [a-z]+"));
                }
                hinted(current, "New password (at least 12 characters)").setText("TEST-ONLY-CANCELLED-PASSWORD");
                hinted(current, "Repeat password").setText("TEST-ONLY-DIFFERENT-PASSWORD");
            });
            assertNoWallet();
            click(password, AlertDialog.BUTTON_POSITIVE, "Create encrypted wallet");
            AlertDialog passwordRetry = awaitDialog(PASSWORD_TITLE);
            inspect(passwordRetry, current -> {
                assertTrue("A password typo must remain on the protection step.", containsText(current, "Passwords do not match."));
                List<EditText> inputs = views(current.getWindow().getDecorView(), EditText.class);
                assertEquals(2, inputs.size());
                for (EditText input : inputs) assertEquals("Retry must clear password fields.", 0, input.length());
            });
            assertNoWallet();
            click(passwordRetry, AlertDialog.BUTTON_NEGATIVE, "Cancel");
            assertOperationCancelled();
        } finally { Arrays.fill(words, null); }
    }

    private void pauseAndResumeDraft(AlertDialog dialog, String title) throws Exception {
        scenario.moveToState(Lifecycle.State.CREATED);
        scenario.onActivity(activity -> {
            NativeWalletPlugin current = plugin(activity);
            assertSame("Switching apps must retain the native onboarding dialog in memory.", dialog, field(current, "dialog"));
            assertEquals(Boolean.TRUE, field(current, "setupDraft"));
            assertNotNull("The in-memory setup operation must remain pending.", field(current, "dialogCall"));
            assertTrue("A second setup operation must remain blocked while this draft exists.", ((AtomicBoolean) field(current, "busy")).get());
            assertNull("Keeping a setup draft must not leave a wallet session unlocked.", field(current, "session"));
            assertNull("Editable password text must not be copied into a pending save buffer.", field(current, "pendingPassword"));
            assertEquals(Boolean.FALSE, field(current, "active"));
            assertEquals(Boolean.FALSE, field(field(current, "runtime"), "foreground"));
        });
        assertNoWallet();
        scenario.moveToState(Lifecycle.State.RESUMED);
        assertSame("Returning to the app must resume the same draft step.", dialog, awaitDialog(title));
    }

    private List<TextView> numberedLabels(AlertDialog dialog) {
        AtomicReference<List<TextView>> shown = new AtomicReference<>();
        inspect(dialog, current -> {
            List<TextView> labels = new ArrayList<>();
            for (TextView view : views(current.getWindow().getDecorView(), TextView.class)) {
                if (view.getText().toString().matches("\\d{1,2}\\. [a-z]+")) {
                    assertFalse("Recovery words must not be saved in Android view state.", view.isSaveEnabled());
                    labels.add(view);
                }
            }
            assertEquals(24, labels.size()); shown.set(labels);
        });
        return shown.get();
    }

    private void assertCleared(List<? extends TextView> values) {
        scenario.onActivity(activity -> {
            for (TextView value : values) assertEquals("Explicit cancellation must clear sensitive native views.", 0, value.length());
        });
    }

    @Test public void switchingAppsKeepsRecoveryWordsUntilExplicitCancellation() throws Exception {
        launch();
        AlertDialog dialog = create();
        String[] before = recoveryWords(dialog);
        List<TextView> shown = numberedLabels(dialog);
        try {
            pauseAndResumeDraft(dialog, WORDS_TITLE);
            String[] after = recoveryWords(dialog);
            try { assertTrue("An ordinary app switch must not regenerate the recovery phrase.", Arrays.equals(before, after)); }
            finally { Arrays.fill(after, null); }
            click(dialog, AlertDialog.BUTTON_NEGATIVE, "Cancel");
            assertOperationCancelled();
            assertCleared(shown);
        } finally { Arrays.fill(before, null); }
    }

    @Test public void switchingAppsKeepsConfirmationStepAndTypedWordsUntilCancellation() throws Exception {
        launch();
        AlertDialog first = create();
        String[] words = recoveryWords(first);
        AtomicReference<List<EditText>> entered = new AtomicReference<>();
        try {
            click(first, AlertDialog.BUTTON_POSITIVE, "I wrote down my words");
            AlertDialog confirmation = awaitDialog(CONFIRM_TITLE);
            fillConfirmation(confirmation, words);
            inspect(confirmation, current -> entered.set(views(current.getWindow().getDecorView(), EditText.class)));
            pauseAndResumeDraft(confirmation, CONFIRM_TITLE);
            inspect(confirmation, current -> {
                assertTrue("Word 3 must survive an ordinary app switch.", words[2].contentEquals(hinted(current, "Word 3").getText()));
                assertTrue("Word 12 must survive an ordinary app switch.", words[11].contentEquals(hinted(current, "Word 12").getText()));
                assertTrue("Word 23 must survive an ordinary app switch.", words[22].contentEquals(hinted(current, "Word 23").getText()));
                for (EditText input : entered.get()) assertFalse("Recovery inputs must not be saved in Android view state.", input.isSaveEnabled());
            });
            click(confirmation, AlertDialog.BUTTON_NEGATIVE, "Cancel");
            assertOperationCancelled();
            assertCleared(entered.get());
        } finally { Arrays.fill(words, null); }
    }

    @Test public void switchingAppsKeepsPasswordStepAndInputsUntilCancellation() throws Exception {
        launch();
        AlertDialog password = reachPassword();
        AtomicReference<List<EditText>> entered = new AtomicReference<>();
        inspect(password, current -> {
            List<EditText> inputs = views(current.getWindow().getDecorView(), EditText.class);
            assertEquals(2, inputs.size());
            // Public test-only text; the accept/save action is never pressed.
            for (EditText input : inputs) input.setText("TEST-ONLY-CANCELLED-PASSWORD");
            entered.set(inputs);
        });
        pauseAndResumeDraft(password, PASSWORD_TITLE);
        inspect(password, current -> {
            for (EditText input : entered.get()) {
                assertTrue("Typed passwords must remain in the draft during ordinary app switching.",
                    "TEST-ONLY-CANCELLED-PASSWORD".contentEquals(input.getText()));
                assertFalse("Passwords must not be saved in Android view state.", input.isSaveEnabled());
            }
        });
        click(password, AlertDialog.BUTTON_NEGATIVE, "Cancel");
        assertOperationCancelled();
        assertCleared(entered.get());
    }

    @Test public void switchingAppsKeepsImportPhraseAndPasswordsUntilCancellation() throws Exception {
        launch();
        AlertDialog generated = create();
        String[] words = recoveryWords(generated);
        AtomicReference<List<EditText>> entered = new AtomicReference<>();
        try {
            click(generated, AlertDialog.BUTTON_NEGATIVE, "Cancel");
            assertOperationCancelled();
            awaitSetupButton("import-recovery");
            evaluate("document.getElementById('import-recovery').click(); null");
            AlertDialog importing = awaitDialog("Import recovery phrase");
            inspect(importing, current -> {
                List<EditText> inputs = views(current.getWindow().getDecorView(), EditText.class);
                assertEquals(3, inputs.size());
                hinted(current, "Recovery words").setText(String.join(" ", words));
                hinted(current, "New password (at least 12 characters)").setText("TEST-ONLY-CANCELLED-PASSWORD");
                hinted(current, "Repeat password").setText("TEST-ONLY-CANCELLED-PASSWORD");
                entered.set(inputs);
            });
            pauseAndResumeDraft(importing, "Import recovery phrase");
            inspect(importing, current -> {
                assertTrue("The imported phrase must survive an ordinary app switch without leaving native memory.",
                    String.join(" ", words).contentEquals(hinted(current, "Recovery words").getText()));
                assertTrue("The import password must survive an ordinary app switch.",
                    "TEST-ONLY-CANCELLED-PASSWORD".contentEquals(hinted(current, "New password (at least 12 characters)").getText()));
                assertTrue("The repeated import password must survive an ordinary app switch.",
                    "TEST-ONLY-CANCELLED-PASSWORD".contentEquals(hinted(current, "Repeat password").getText()));
                for (EditText input : entered.get()) assertFalse("Import inputs must not be saved in Android view state.", input.isSaveEnabled());
            });
            click(importing, AlertDialog.BUTTON_NEGATIVE, "Cancel");
            assertOperationCancelled();
            assertCleared(entered.get());
        } finally { Arrays.fill(words, null); }
    }

    @Test public void freshWalletFileImportOpensDocumentPickerDirectlyAndCancelCreatesNothing() throws Exception {
        launch(); awaitSetupButton("import-wallet"); awaitSetupButton("import-recovery");
        AtomicReference<Long> sequence = new AtomicReference<>();
        scenario.onActivity(activity -> {
            Object rpc = field(field(plugin(activity), "runtime"), "rpc");
            synchronized (rpc) { sequence.set(((Number)field(rpc, "sequence")).longValue()); }
        });
        IntentFilter filter = new IntentFilter(Intent.ACTION_OPEN_DOCUMENT);
        filter.addCategory(Intent.CATEGORY_OPENABLE); filter.addDataType("*/*");
        Instrumentation.ActivityMonitor picker = new Instrumentation.ActivityMonitor(filter,
            new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true);
        InstrumentationRegistry.getInstrumentation().addMonitor(picker);
        try {
            evaluate("document.getElementById('import-wallet').click(); null");
            long deadline = SystemClock.elapsedRealtime() + 10000;
            while (picker.getHits() == 0 && SystemClock.elapsedRealtime() < deadline) Thread.sleep(50);
            assertEquals("The file button must open exactly one document picker without a native method chooser.", 1, picker.getHits());
            assertOperationCancelled();
            scenario.onActivity(activity -> {
                NativeWalletPlugin current = plugin(activity);
                assertNull(field(current, "importedEnvelope")); assertNull(field(current, "importSource"));
                assertEquals(Boolean.FALSE, field(current, "fileImportMode")); assertEquals(Boolean.FALSE, field(current, "importPickerPending"));
                Object rpc = field(field(current, "runtime"), "rpc");
                synchronized (rpc) {
                    assertEquals(sequence.get().longValue(), ((Number)field(rpc, "sequence")).longValue());
                    assertTrue(((java.util.Collection<?>)field(rpc, "jobs")).isEmpty());
                }
            });
        } finally { InstrumentationRegistry.getInstrumentation().removeMonitor(picker); }
    }

    @Test public void activityRecreationCancelsDraftAndRestartCreatesFreshWords() throws Exception {
        launch();
        AlertDialog original = create();
        String[] before = recoveryWords(original);
        List<TextView> shown = numberedLabels(original);
        AtomicReference<NativeWalletPlugin> oldPlugin = new AtomicReference<>();
        scenario.onActivity(activity -> oldPlugin.set(plugin(activity)));
        try {
            scenario.recreate();
            awaitReadyUi();
            scenario.onActivity(activity -> {
                NativeWalletPlugin previous = oldPlugin.get();
                assertNotSame("Activity recreation must create a new plugin, not revive a memory-only draft.", previous, plugin(activity));
                assertEquals(Boolean.TRUE, field(previous, "destroyed"));
                assertEquals(Boolean.FALSE, field(previous, "setupDraft"));
                assertNull("Destroyed onboarding must release its pending native call.", field(previous, "dialogCall"));
                assertFalse(((AtomicBoolean) field(previous, "busy")).get());
                assertNull(field(previous, "session"));
                assertNull(field(previous, "pendingPassword"));
                assertFalse("The old native dialog must be dismissed after Activity destruction.", original.isShowing());
                assertNull("An unfinished draft must not be restored from Android saved state.", field(plugin(activity), "dialog"));
            });
            assertCleared(shown);
            assertOperationCancelled();
            AlertDialog restarted = create();
            String[] after = recoveryWords(restarted);
            try { assertFalse("Restarting after destruction must create a fresh phrase, not restore the discarded draft.", Arrays.equals(before, after)); }
            finally { Arrays.fill(after, null); }
            click(restarted, AlertDialog.BUTTON_NEGATIVE, "Cancel");
            assertOperationCancelled();
        } finally { Arrays.fill(before, null); }
    }
}
