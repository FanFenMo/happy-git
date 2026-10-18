package com.happygit.app.nativebridge;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.security.KeyStore;

public class CredentialStore {

    private static final String PREF_NAME = "happygit_secure_prefs";
    private static final String KEY_CREDENTIALS = "enc_credentials";
    private static final String KEY_ALIAS = "HappyGitKeyAlias";
    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_LENGTH = 128;

    private final SharedPreferences prefs;

    public CredentialStore(Context context) {
        this.prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
            KeyGenParameterSpec keyGenParameterSpec = new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build();
            keyGenerator.init(keyGenParameterSpec);
            return keyGenerator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    public synchronized JSONObject read() {
        String encryptedData = prefs.getString(KEY_CREDENTIALS, null);
        if (encryptedData == null) return null;
        try {
            byte[] combined = Base64.decode(encryptedData, Base64.DEFAULT);
            if (combined.length < 13) return null; // 1 byte version + 12 bytes IV
            byte ivLength = 12;
            byte[] iv = new byte[ivLength];
            System.arraycopy(combined, 1, iv, 0, ivLength);

            int cipherTextSize = combined.length - 1 - ivLength;
            byte[] cipherText = new byte[cipherTextSize];
            System.arraycopy(combined, 1 + ivLength, cipherText, 0, cipherTextSize);

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_LENGTH, iv));
            byte[] plaintext = cipher.doFinal(cipherText);

            return new JSONObject(new String(plaintext, "UTF-8"));
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }

    public synchronized void save(JSONObject credentials) {
        try {
            byte[] plaintext = credentials.toString().getBytes("UTF-8");
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(plaintext);

            // 格式: [version(1 byte)] + [IV(12 bytes)] + [ciphertext]
            byte[] combined = new byte[1 + iv.length + ciphertext.length];
            combined[0] = 1; // version 1
            System.arraycopy(iv, 0, combined, 1, iv.length);
            System.arraycopy(ciphertext, 0, combined, 1 + iv.length, ciphertext.length);

            String encoded = Base64.encodeToString(combined, Base64.DEFAULT);
            prefs.edit().putString(KEY_CREDENTIALS, encoded).commit();
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public synchronized void clear() {
        prefs.edit().remove(KEY_CREDENTIALS).commit();
    }
}
