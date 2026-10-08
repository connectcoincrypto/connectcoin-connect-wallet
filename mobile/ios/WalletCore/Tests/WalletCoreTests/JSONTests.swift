import XCTest
@testable import WalletCore

final class JSONTests: XCTestCase {
    private func decode(_ text: String) throws -> JSONObject { try JSON.decode(Data(text.utf8)) }
    func testDuplicateKeysAndEscapedAliasesAreRejectedRecursively() throws {
        for text in [#"{"a":1,"a":2}"#, #"{"a":1,"\u0061":2}"#,
                     #"{"nested":[{"a":1,"a":2}]}"#] {
            XCTAssertThrowsError(try decode(text))
        }
        let distinct = try decode(#"{"first":{"a":1},"second":{"a":2}}"#)
        XCTAssertEqual(try distinct.object("second").integer("a"),2)
    }
    func testIntegersNeverCoerceBooleansFloatsOrOverflow() throws {
        for value in [true,false,1.0,NSNumber(value:Double(1)),"1",NSNull(),UInt64.max] as [Any] {
            XCTAssertThrowsError(try JSON.integer(value))
        }
        XCTAssertEqual(try JSON.integer(Int64.min),Int64.min)
        XCTAssertEqual(try JSON.integer(Int64.max),Int64.max)
        XCTAssertThrowsError(try JSON.integer(2,min:0,max:1))
        XCTAssertThrowsError(try JSON.boolean(1))
        XCTAssertEqual(try JSON.boolean(true),true)
        for literal in ["true","false","1.0","1e0","9223372036854775808","-9223372036854775809"] {
            let value = try decode("{\"value\":\(literal)}")
            XCTAssertThrowsError(try value.integer("value"),literal)
        }
    }
    func testMalformedGrammarSurrogatesAndInvalidUTF8AreRejected() throws {
        for text in [#"{"x":"\uD800"}"#, #"{"x":"\uDC00"}"#, #"{"x":"\uD800\u0041"}"#,
                     #"{"x":"\q"}"#, #"{"x":01}"#, #"{"x":+1}"#, #"{"x":1.}"#,
                     #"{"x":1e}"#, #"{"x":NaN}"#, #"{"x":Infinity}"#, #"{"x":1,}"#,
                     #"{"x":[1,]}"#, #"{} {}"#, #"[]"#, #"null"#] {
            XCTAssertThrowsError(try decode(text),text)
        }
        XCTAssertThrowsError(try JSON.decode(Data([123,34,120,34,58,34,0xff,34,125])))
        XCTAssertEqual(try decode(#"{"x":"\uD83D\uDD11"}"#).string("x"),"🔑")
    }
    func testDocumentSizeDepthAndNumberBounds() throws {
        XCTAssertThrowsError(try JSON.decode(Data("{}".utf8),maxBytes:1))
        let deep = "{\"v\":" + String(repeating:"[",count:33) + "0" + String(repeating:"]",count:33) + "}"
        XCTAssertThrowsError(try decode(deep))
        XCTAssertThrowsError(try decode("{\"v\":" + String(repeating:"9",count:129) + "}"))
        XCTAssertThrowsError(try decode("{\"v\":\"literal\nnewline\"}"))
    }
    func testUnknownMetadataRoundTripsWithoutAliasing() throws {
        let original: JSONObject = ["known":1,"unknown":["unicode":"café 🔑","bool":true,"null":NSNull(),"rows":[1,2,3]]]
        let clone = try JSON.clone(original)
        XCTAssertEqual(try JSON.encode(original),try JSON.encode(clone))
        XCTAssertTrue(try clone.object("unknown").boolean("bool"))
        XCTAssertThrowsError(try JSON.encode(["infinite":Double.infinity]))
    }
}
