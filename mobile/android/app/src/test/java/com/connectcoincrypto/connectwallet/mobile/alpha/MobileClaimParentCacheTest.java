package com.connectcoincrypto.connectwallet.mobile.alpha;

import static org.junit.Assert.*;
import org.junit.Test;

public class MobileClaimParentCacheTest {
    @Test public void evictsByTotalCharactersBeforeCountLimit() {
        MobileClaimParentCache cache = new MobileClaimParentCache(128, 10);
        cache.putValidated("a", "123456"); cache.putValidated("b", "1234"); assertEquals(10, cache.characters());
        cache.putValidated("c", "12345"); assertNull(cache.get("a")); assertEquals("1234", cache.get("b")); assertEquals(9, cache.characters()); assertEquals(2, cache.size());
    }
    @Test public void oversizedParentIsNotCachedAndDoesNotEvictOthers() {
        MobileClaimParentCache cache = new MobileClaimParentCache(2, 10);
        cache.putValidated("a", "1234"); cache.putValidated("b", "1234"); cache.putValidated("huge", "1".repeat(11));
        assertNull(cache.get("huge")); assertEquals(2, cache.size()); assertEquals(8, cache.characters());
        cache.putValidated("c", "12"); assertNull(cache.get("a")); assertEquals(2, cache.size()); assertEquals(6, cache.characters());
    }
    @Test public void replacementDoesNotLeakItsPreviousSize() {
        MobileClaimParentCache cache = new MobileClaimParentCache(2, 10);
        cache.putValidated("a", "12345678"); cache.putValidated("a", "12"); cache.putValidated("b", "12345678");
        assertEquals(10, cache.characters()); assertEquals(2, cache.size());
    }
}
