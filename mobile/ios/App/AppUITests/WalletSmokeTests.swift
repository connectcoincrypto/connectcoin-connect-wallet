import XCTest

/// Runs only on a fresh disposable Simulator and the native offline test mode.
/// Only public test keys are persisted, in an isolated temporary directory.
/// No fixture is funded and no RPC/capture is permitted.
final class WalletSmokeTests: XCTestCase {
    @MainActor func testPackagedBridgeNativeDialogsAndSettings() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--wallet-ui-smoke"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
        let isolation = app.staticTexts["wallet-native-security-check"]
        XCTAssertTrue(isolation.waitForExistence(timeout: 15))
        XCTAssertEqual(isolation.label, "Native isolation verified")
        let create = app.webViews.buttons["Create wallet"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: create)
        waitForExpectations(timeout: 15)
        assertNativeTopSafeArea(app, checkHeader: true)
        snapshot(app, "Packaged wallet — clean start")

        tapWebButton(app, "Create wallet")
        XCTAssertTrue(app.navigationBars["Write down your recovery phrase"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["native-wallet-message"].exists)
        // Do not attach a screenshot containing even a discarded random phrase.
        app.navigationBars.buttons["Cancel"].tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))

        tapWebButton(app, "Import recovery phrase")
        XCTAssertTrue(app.navigationBars["Import recovery phrase"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textViews["native-wallet-mnemonic"].exists)
        snapshot(app, "Native recovery input — no secret entered")
        app.navigationBars.buttons["Cancel"].tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))

        tapWebButton(app, "Import wallet file")
        let pickerCancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(pickerCancel.waitForExistence(timeout: 10))
        pickerCancel.tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))

        tapWebButton(app, "Settings")
        let back = app.webViews.buttons["← Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Settings are saved on this device."].waitForExistence(timeout: 10))
        snapshot(app, "Packaged wallet settings")
        back.tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
    }

    @MainActor func testOfflinePublicFixtureImportLockAndUnlock() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--wallet-ui-smoke"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
        let isolation = app.staticTexts["wallet-native-security-check"]
        XCTAssertTrue(isolation.waitForExistence(timeout: 15))
        XCTAssertEqual(isolation.label, "Native isolation verified")
        tapWebButton(app, "Import recovery phrase")
        let words = app.textViews["native-wallet-mnemonic"]
        XCTAssertTrue(words.waitForExistence(timeout: 10))
        words.tap()
        // Official public BIP39 fixture. Never replace with a user's recovery.
        words.typeText(Array(repeating: "abandon", count: 11).joined(separator: " ") + " about")
        app.toolbars.buttons["Done"].tap()
        app.buttons["native-wallet-confirm"].tap()
        XCTAssertTrue(app.navigationBars["Encrypt imported wallet"].waitForExistence(timeout: 10))
        let password = "Public test password only!"
        let first = app.secureTextFields["native-wallet-password"], second = app.secureTextFields["native-wallet-confirm"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        first.tap(); first.typeText(password)
        second.tap(); second.typeText(password + "\n")
        app.buttons["native-wallet-confirm"].tap()
        let address = "cc1p4t449ht5jnpkzpyaue7vdq8g867th0d7kymr0kfvmpzlwqcg4a0qc59p3e"
        XCTAssertTrue(app.webViews.staticTexts[address].waitForExistence(timeout: 90))
        snapshot(app, "Public fixture — native import complete")

        tapWebButton(app, "Send")
        tapWebButton(app, "Lock")
        XCTAssertTrue(app.webViews.staticTexts["Wallet locked. Unlock to review a payment."].waitForExistence(timeout: 10))
        tapWebButton(app, "Unlock native wallet")
        XCTAssertTrue(app.navigationBars["Unlock wallet"].waitForExistence(timeout: 10))
        let unlock = app.secureTextFields["native-wallet-password"]
        unlock.tap(); unlock.typeText(password + "\n")
        app.buttons["native-wallet-confirm"].tap()
        let lock = app.webViews.buttons["Lock"]
        XCTAssertTrue(lock.waitForExistence(timeout: 90))
        XCTAssertTrue(app.webViews.staticTexts[address].exists)
        assertNativeTopSafeArea(app, checkHeader: false)
        snapshot(app, "Public fixture — native unlock complete")
        tapWebButton(app, "Lock")
        XCTAssertTrue(app.webViews.buttons["Unlock native wallet"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
    }

    @MainActor private func assertNativeTopSafeArea(_ app: XCUIApplication, checkHeader: Bool) {
        let window = app.windows.firstMatch.frame
        let web = app.webViews.firstMatch.frame
        // The CI iPhone has a status bar. Its immutable native safe region must
        // remain outside the WebView's scrolling rectangle, including on Send.
        XCTAssertGreaterThan(web.minY, window.minY + 20)
        XCTAssertLessThan(web.minY, window.minY + 100)
        XCTAssertEqual(web.maxY, window.maxY, accuracy: 1)
        if checkHeader {
            let settings = app.webViews.buttons["Settings"]
            XCTAssertTrue(settings.waitForExistence(timeout: 10))
            let topGap = settings.frame.minY - web.minY
            // The packaged topbar has22px top padding, not another native inset.
            XCTAssertGreaterThanOrEqual(topGap, 16)
            XCTAssertLessThanOrEqual(topGap, 40)
        }
    }

    @MainActor private func tapWebButton(_ app: XCUIApplication, _ title: String) {
        let button = app.webViews.buttons[title]
        XCTAssertTrue(button.waitForExistence(timeout: 20))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: button)
        waitForExpectations(timeout: 20)
        for _ in 0..<4 where !button.isHittable { app.webViews.firstMatch.swipeUp() }
        XCTAssertTrue(button.isHittable, "Button is not reachable: " + title)
        button.tap()
    }

    @MainActor private func snapshot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
