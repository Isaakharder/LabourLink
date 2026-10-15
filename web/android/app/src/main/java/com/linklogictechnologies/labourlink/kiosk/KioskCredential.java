package com.linklogictechnologies.labourlink.kiosk;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Salted PBKDF2-HMAC-SHA256 maintenance credential — pure Java (no Android
 * framework), unit-tested on the JVM.
 *
 * There is deliberately no PIN anywhere in the APK. The only thing a kiosk
 * phone ever stores is this one-way encoded form, delivered per device (or
 * per pilot group) through the EMM's managed configuration
 * ("maintenance_credential", see res/xml/app_restrictions.xml) or set
 * locally from the maintenance screen. Verification runs entirely on the
 * phone, so it works offline. Generate the managed-config value with
 * tools/android-kiosk/kiosk-credential-hash.mjs, which uses this same
 * format.
 *
 * Encoded format: "pbkdf2-sha256$<iterations>$<base64 salt>$<base64 hash>".
 *
 * PBKDF2 is implemented directly on HmacSHA256 rather than through
 * SecretKeyFactory("PBKDF2WithHmacSHA256") so the result can never depend on
 * which JCE provider a given Android build (or the JVM test runner) ships —
 * the provider-specific char-to-byte conversion is exactly the kind of
 * silent mismatch that would make a console-generated hash fail on one OEM.
 */
public final class KioskCredential {

    public static final String PREFIX = "pbkdf2-sha256";
    public static final int DEFAULT_ITERATIONS = 100_000;
    static final int MIN_ITERATIONS = 10_000;
    static final int MAX_ITERATIONS = 2_000_000;
    static final int HASH_BYTES = 32;
    static final int SALT_BYTES = 16;
    public static final int MIN_PIN_LENGTH = 6;
    public static final int MAX_PIN_LENGTH = 32;

    private KioskCredential() {}

    /** Digits only, MIN_PIN_LENGTH..MAX_PIN_LENGTH — the same rule the console tool enforces. */
    public static boolean isAcceptablePin(String pin) {
        if (pin == null || pin.length() < MIN_PIN_LENGTH || pin.length() > MAX_PIN_LENGTH) return false;
        for (int i = 0; i < pin.length(); i++) {
            char c = pin.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    /** True when the string parses as a usable encoded credential. */
    public static boolean isWellFormed(String encoded) {
        return parse(encoded) != null;
    }

    public static String create(String pin) {
        return create(pin, DEFAULT_ITERATIONS, new SecureRandom());
    }

    static String create(String pin, int iterations, SecureRandom random) {
        if (!isAcceptablePin(pin)) throw new IllegalArgumentException("PIN must be " + MIN_PIN_LENGTH + "-" + MAX_PIN_LENGTH + " digits");
        byte[] salt = new byte[SALT_BYTES];
        random.nextBytes(salt);
        byte[] hash = pbkdf2(pin.getBytes(StandardCharsets.UTF_8), salt, iterations, HASH_BYTES);
        Base64.Encoder b64 = Base64.getEncoder();
        return PREFIX + "$" + iterations + "$" + b64.encodeToString(salt) + "$" + b64.encodeToString(hash);
    }

    /** Constant-time comparison; false for any malformed credential or PIN. */
    public static boolean verify(String pin, String encoded) {
        Parsed p = parse(encoded);
        if (p == null || pin == null || pin.isEmpty() || pin.length() > MAX_PIN_LENGTH) return false;
        byte[] candidate = pbkdf2(pin.getBytes(StandardCharsets.UTF_8), p.salt, p.iterations, p.hash.length);
        return MessageDigest.isEqual(candidate, p.hash);
    }

    private static final class Parsed {
        final int iterations;
        final byte[] salt;
        final byte[] hash;

        Parsed(int iterations, byte[] salt, byte[] hash) {
            this.iterations = iterations;
            this.salt = salt;
            this.hash = hash;
        }
    }

    private static Parsed parse(String encoded) {
        if (encoded == null) return null;
        String[] parts = encoded.trim().split("\\$");
        if (parts.length != 4 || !PREFIX.equals(parts[0])) return null;
        try {
            int iterations = Integer.parseInt(parts[1]);
            if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
            byte[] salt = Base64.getDecoder().decode(parts[2]);
            byte[] hash = Base64.getDecoder().decode(parts[3]);
            if (salt.length < 8 || hash.length < 16) return null;
            return new Parsed(iterations, salt, hash);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    // RFC 8018 section 5.2, PRF = HMAC-SHA256.
    static byte[] pbkdf2(byte[] password, byte[] salt, int iterations, int dkLen) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            // HMAC keys may be empty in the RFC, but SecretKeySpec rejects a
            // zero-length key; callers never pass an empty password anyway.
            mac.init(new SecretKeySpec(password, "HmacSHA256"));
            int hLen = mac.getMacLength();
            int blocks = (dkLen + hLen - 1) / hLen;
            byte[] out = new byte[dkLen];
            byte[] u = new byte[hLen];
            byte[] t = new byte[hLen];
            for (int i = 1; i <= blocks; i++) {
                mac.update(salt);
                mac.update(new byte[] { (byte) (i >>> 24), (byte) (i >>> 16), (byte) (i >>> 8), (byte) i });
                mac.doFinal(u, 0);
                System.arraycopy(u, 0, t, 0, hLen);
                for (int c = 1; c < iterations; c++) {
                    mac.update(u);
                    mac.doFinal(u, 0);
                    for (int k = 0; k < hLen; k++) t[k] ^= u[k];
                }
                int offset = (i - 1) * hLen;
                System.arraycopy(t, 0, out, offset, Math.min(hLen, dkLen - offset));
            }
            return out;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 unavailable", e);
        }
    }
}
