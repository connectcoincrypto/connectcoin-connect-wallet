import XCTest

/// Runs only on a fresh disposable Simulator and the native offline test mode.
/// No fixture is funded, no wallet is persisted, no RPC/capture is permitted.
final class WalletSmokeTests: XCTestCase {
    @MainActor func testPackagedBridgeNativeDialogsAndSettings() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--wallet-ui-smoke"]
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
        let create = app.webViews.buttons["Create wallet"]
        XCTAssertTrue(create.waitForExistence(timeout: 15))
        expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: create)
        waitForExpectations(timeout: 15)
        snapshot(app, "Packaged wallet — clean start")

        create.tap()
        XCTAssertTrue(app.navigationBars["Write down your recovery phrase"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["native-wallet-message"].exists)
        // Do not attach a screenshot containing even a discarded random phrase.
        app.navigationBars.buttons["Cancel"].tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))

        app.webViews.buttons["Import recovery phrase"].tap()
        XCTAssertTrue(app.navigationBars["Import recovery phrase"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textViews["native-wallet-mnemonic"].exists)
        snapshot(app, "Native recovery input — no secret entered")
        app.navigationBars.buttons["Cancel"].tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))

        app.webViews.buttons["Import wallet file"].tap()
        let pickerCancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(pickerCancel.waitForExistence(timeout: 10))
        pickerCancel.tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))

        app.webViews.buttons["Settings"].tap()
        let back = app.webViews.buttons["← Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Settings are saved on this device."].waitForExistence(timeout: 10))
        snapshot(app, "Packaged wallet settings")
        back.tap()
        XCTAssertTrue(create.waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
    }

    @MainActor private func snapshot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
