package com.linklogictechnologies.labourlink.kiosk;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import org.junit.Test;

public class KioskCredentialTest {

    // Produced by tools/android-kiosk/kiosk-credential-hash.mjs
    // (Node's pbkdf2Sync) with PIN "123456", salt = 16 x 0x07, 10000
    // iterations — proves the console tool and the phone agree.
    private static final String NODE_VECTOR = "pbkdf2-sha256$10000$BwcHBwcHBwcHBwcHBwcHBw==$yUgTPI22831+iEgVuEdV08DsgCk/P7ybyCEbvLoLl/A=";

    @Test
    public void pbkdf2MatchesRfc7914Vector() {
        // RFC 7914 section 11, PBKDF2-HMAC-SHA256 P="passwd" S="salt" c=1 dkLen=64.
        byte[] expected = hex(
            "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783"
        );
        assertArrayEquals(expected, KioskCredential.pbkdf2("passwd".getBytes(StandardCharsets.UTF_8), "salt".getBytes(StandardCharsets.UTF_8), 1, 64));
    }

    @Test
    public void verifiesConsoleToolOutput() {
        assertTrue(KioskCredential.verify("123456", NODE_VECTOR));
        assertFalse(KioskCredential.verify("123457", NODE_VECTOR));
        assertFalse(KioskCredential.verify("", NODE_VECTOR));
    }

    @Test
    public void createThenVerifyRoundTrips() {
        String enc = KioskCredential.create("90817263", 10_000, new SecureRandom());
        assertTrue(KioskCredential.verify("90817263", enc));
        assertFalse(KioskCredential.verify("90817264", enc));
    }

    @Test
    public void saltMakesEachEncodingUnique() {
        assertNotEquals(KioskCredential.create("111111", 10_000, new SecureRandom()), KioskCredential.create("111111", 10_000, new SecureRandom()));
    }

    @Test
    public void rejectsMalformedCredentials() {
        assertFalse(KioskCredential.isWellFormed(null));
        assertFalse(KioskCredential.isWellFormed(""));
        assertFalse(KioskCredential.isWellFormed("123456"));
        assertFalse(KioskCredential.isWellFormed("sha1$10000$AAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAA=="));
        // Too few iterations to be trusted.
        assertFalse(KioskCredential.isWellFormed("pbkdf2-sha256$1$BwcHBwcHBwcHBwcHBwcHBw==$yUgTPI22831+iEgVuEdV08DsgCk/P7ybyCEbvLoLl/A="));
        assertFalse(KioskCredential.isWellFormed("pbkdf2-sha256$10000$not base64!$xx"));
        assertFalse(KioskCredential.verify("123456", "garbage"));
        assertTrue(KioskCredential.isWellFormed(NODE_VECTOR));
    }

    @Test
    public void pinRules() {
        assertTrue(KioskCredential.isAcceptablePin("123456"));
        assertFalse(KioskCredential.isAcceptablePin("12345"));
        assertFalse(KioskCredential.isAcceptablePin("12345a"));
        assertFalse(KioskCredential.isAcceptablePin(null));
        assertFalse(KioskCredential.isAcceptablePin("123456789012345678901234567890123"));
    }

    @Test(expected = IllegalArgumentException.class)
    public void createRefusesWeakPin() {
        KioskCredential.create("1234");
    }

    private static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
}
