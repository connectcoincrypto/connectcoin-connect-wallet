package com.connectcoincrypto.connectwallet.mobile.alpha.wallet;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class StrictWalletJsonTest {
    @Test public void preservesCompatibleNestedMetadataEscapesAndUnicode() throws Exception {
        JSONObject value = StrictWalletJson.object(" {\"name\":\"caf\u00e9 \ud83d\udd11\",\"future\":{\"list\":[null,true,false,-1,1.25,2e3,\"a\\n\\t\\u0062\"]}} \r\n");
        assertEquals("caf\u00e9 \ud83d\udd11", value.getString("name"));
        assertEquals(7, value.getJSONObject("future").getJSONArray("list").length());
        assertEquals("a\n\tb", value.getJSONObject("future").getJSONArray("list").getString(6));
    }
    @Test public void rejectsAmbiguityAndNonJsonExtensionsAtEveryDepth() {
        for (String input : new String[]{"[]", "null", "{}{}", "{} trailing", "{'x':1}", "{x:1}", "{\"x\":1,}",
                "{\"x\":01}", "{\"x\":+1}", "{\"x\":1.}", "{\"x\":.1}", "{\"x\":1e}", "{\"x\":NaN}", "{\"x\":1e10000}",
                "{\"x\":[1,]}", "{\"x\":[,1]}", "{\"x\":\"\\q\"}", "{\"x\":\"line\nbreak\"}",
                "{\"x\":{\"a\":1,\"\\u0061\":2}}", "{\"x\":1,\"x\":2}", "{/*x*/\"x\":1}",
                "{\"x\":\"\\ud800\"}", "{\"x\":\"\\udc00\"}", "{\"x\":\"\ud800\"}"}) {
            assertThrows(input, IllegalArgumentException.class, () -> StrictWalletJson.object(input));
        }
    }
    @Test public void excessiveNestingAndMemberCountsFailBeforeRecursiveParserWork() {
        assertThrows(IllegalArgumentException.class, () -> StrictWalletJson.object("{\"x\":" + "[".repeat(40) + "0" + "]".repeat(40) + "}"));
        assertThrows(IllegalArgumentException.class, () -> StrictWalletJson.object("{\"x\":[" + "0,".repeat(8192) + "0]}"));
    }
}
