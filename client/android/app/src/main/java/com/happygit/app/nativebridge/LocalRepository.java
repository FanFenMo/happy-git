package com.happygit.app.nativebridge;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;

public class LocalRepository {

    private final HappyGitDbHelper dbHelper;

    public LocalRepository(Context context) {
        this.dbHelper = new HappyGitDbHelper(context);
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        this.dbHelper.createV2Tables(db);
        this.dbHelper.createV3Tables(db);
        db.execSQL("DELETE FROM repository_cache WHERE NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.account_id = repository_cache.account_id AND s.kind = repository_cache.kind AND s.active_generation = repository_cache.generation_id)");
        db.execSQL("UPDATE sync_state SET staging_generation = NULL, staging_next_page = NULL, staging_next_url = NULL, staging_page_seq = 0, staging_count = 0");
        try (Cursor accounts = db.rawQuery("SELECT account_id FROM accounts", null)) {
            while (accounts.moveToNext()) {
                String accId = accounts.getString(0);
                ensureAccountV3State(db, accId, System.currentTimeMillis());
                pruneHistory(db, accId, System.currentTimeMillis());
            }
        }
    }

    public static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException("SHA256_FAILED", e);
        }
    }

    public static String computeOpenPayloadHash(String eventId, long streamEpoch, long deviceSeq, long analysisEpoch, String repoId, long occurredAt, String source) {
        JSONArray tuple = new JSONArray();
        tuple.put("1.0.0");
        tuple.put(eventId);
        tuple.put(streamEpoch);
        tuple.put(deviceSeq);
        tuple.put(analysisEpoch);
        tuple.put(repoId);
        tuple.put(occurredAt);
        tuple.put(source != null ? source : "browse");
        return sha256Hex(tuple.toString());
    }

    public static String computeDiscardPayloadHash(String eventId, long streamEpoch, long deviceSeq, long analysisEpoch) {
        JSONArray tuple = new JSONArray();
        tuple.put("1.0.0");
        tuple.put(eventId);
        tuple.put(streamEpoch);
        tuple.put(deviceSeq);
        tuple.put(analysisEpoch);
        tuple.put("discard");
        return sha256Hex(tuple.toString());
    }

    private String getOrCreateInstallationId(SQLiteDatabase db) {
        try (Cursor c = db.rawQuery("SELECT value_json FROM app_settings WHERE setting_key = 'installation_id'", null)) {
            if (c.moveToFirst()) {
                String raw = c.getString(0);
                if (raw != null && raw.length() >= 8) {
                    return raw.replace("\"", "").trim();
                }
            }
        }
        String newId = "inst_" + UUID.randomUUID().toString().replace("-", "");
        ContentValues cv = new ContentValues();
        cv.put("setting_key", "installation_id");
        cv.put("value_json", "\"" + newId + "\"");
        db.insertWithOnConflict("app_settings", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        return newId;
    }

    private void ensureAccountV3State(SQLiteDatabase db, String accountId, long now) {
        String installationId = getOrCreateInstallationId(db);
        db.execSQL("INSERT OR IGNORE INTO cloud_account_state (account_id, installation_id, stream_epoch, analysis_epoch, analysis_enabled, cloud_bound, updated_at) " +
                "VALUES (?, ?, 1, 1, 1, 0, ?);", new Object[]{accountId, installationId, now});
        db.execSQL("INSERT OR IGNORE INTO local_sync_state (account_id, stream_epoch, analysis_epoch, next_device_seq, accepted_through, exported_through, processed_through) " +
                "VALUES (?, 1, 1, 1, 0, 0, 0);", new Object[]{accountId});
    }

    public synchronized JSONObject getAccountRevisions(String accountId) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        try {
            Cursor c = db.rawQuery("SELECT * FROM account_revisions WHERE account_id = ?", new String[]{accountId});
            if (c.moveToFirst()) {
                res.put("profileRevision", c.getInt(c.getColumnIndexOrThrow("profile_revision")));
                res.put("collectionRevision", c.getInt(c.getColumnIndexOrThrow("collection_revision")));
                res.put("historyRevision", c.getInt(c.getColumnIndexOrThrow("history_revision")));
                res.put("preferenceRevision", c.getInt(c.getColumnIndexOrThrow("preference_revision")));
                res.put("feedbackRevision", c.getInt(c.getColumnIndexOrThrow("feedback_revision")));
                res.put("discoveryRevision", c.getInt(c.getColumnIndexOrThrow("discovery_revision")));
                res.put("starMutationRevision", c.getInt(c.getColumnIndexOrThrow("star_mutation_revision")));
            } else {
                res.put("profileRevision", 0);
                res.put("collectionRevision", 0);
                res.put("historyRevision", 0);
                res.put("preferenceRevision", 0);
                res.put("feedbackRevision", 0);
                res.put("discoveryRevision", 0);
                res.put("starMutationRevision", 0);
            }
            c.close();
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    private void bumpRevision(SQLiteDatabase db, String accountId, String col) {
        db.execSQL("INSERT INTO account_revisions (account_id, " + col + ") VALUES (?, 1) " +
                "ON CONFLICT(account_id) DO UPDATE SET " + col + " = " + col + " + 1;", new Object[]{accountId});
    }

    public synchronized void saveProfile(String accountId, JSONObject profile) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            String login = profile.optString("login", "");
            ContentValues cv = new ContentValues();
            cv.put("account_id", accountId);
            cv.put("login", login);
            cv.put("profile_json", profile.toString());
            cv.put("profile_synced_at", now);
            if (db.update("accounts", cv, "account_id = ?", new String[]{accountId}) == 0)
                db.insertOrThrow("accounts", null, cv);

            ContentValues prefCv = new ContentValues();
            prefCv.put("account_id", accountId);
            prefCv.put("history_enabled", 1);
            prefCv.put("manual_tags_json", "[]");
            prefCv.put("updated_at", now);
            db.insertWithOnConflict("account_preferences", null, prefCv, SQLiteDatabase.CONFLICT_IGNORE);

            db.execSQL("INSERT OR IGNORE INTO account_revisions (account_id) VALUES (?);", new Object[]{accountId});
            ensureAccountV3State(db, accountId, now);
            bumpRevision(db, accountId, "profile_revision");

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized JSONObject readCloudSyncState(String accountId) {
        if (accountId == null || accountId.isEmpty()) return null;
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        try {
            try (Cursor actC = db.rawQuery("SELECT 1 FROM accounts WHERE account_id = ?", new String[]{accountId})) {
                if (!actC.moveToFirst()) return null;
            }
            ensureAccountV3State(db, accountId, System.currentTimeMillis());

            JSONObject res = new JSONObject();
            res.put("accountId", accountId);

            String subjectId = null;
            String deviceId = null;
            String installationId = getOrCreateInstallationId(db);
            boolean cloudBound = false;
            String cloudAccountId = null;
            boolean analysisEnabled = true;
            long sessionExpiresAt = 0;

            try (Cursor c = db.rawQuery("SELECT * FROM cloud_account_state WHERE account_id = ?", new String[]{accountId})) {
                if (c.moveToFirst()) {
                    subjectId = c.isNull(c.getColumnIndexOrThrow("subject_id")) ? null : c.getString(c.getColumnIndexOrThrow("subject_id"));
                    deviceId = c.isNull(c.getColumnIndexOrThrow("device_id")) ? null : c.getString(c.getColumnIndexOrThrow("device_id"));
                    installationId = c.getString(c.getColumnIndexOrThrow("installation_id"));
                    cloudBound = c.getInt(c.getColumnIndexOrThrow("cloud_bound")) == 1;
                    cloudAccountId = c.isNull(c.getColumnIndexOrThrow("cloud_account_id")) ? null : c.getString(c.getColumnIndexOrThrow("cloud_account_id"));
                    analysisEnabled = c.getInt(c.getColumnIndexOrThrow("analysis_enabled")) == 1;
                    sessionExpiresAt = c.isNull(c.getColumnIndexOrThrow("session_expires_at")) ? 0 : c.getLong(c.getColumnIndexOrThrow("session_expires_at"));
                }
            }

            long streamEpoch = 1;
            long analysisEpoch = 1;
            long nextDeviceSeq = 1;
            long acceptedThrough = 0;
            long exportedThrough = 0;
            long processedThrough = 0;
            long lastSyncAt = 0;
            long lastServerTime = 0;
            String lastErrorCode = null;
            long retryAt = 0;

            try (Cursor s = db.rawQuery("SELECT * FROM local_sync_state WHERE account_id = ?", new String[]{accountId})) {
                if (s.moveToFirst()) {
                    streamEpoch = s.getLong(s.getColumnIndexOrThrow("stream_epoch"));
                    analysisEpoch = s.getLong(s.getColumnIndexOrThrow("analysis_epoch"));
                    nextDeviceSeq = s.getLong(s.getColumnIndexOrThrow("next_device_seq"));
                    acceptedThrough = s.getLong(s.getColumnIndexOrThrow("accepted_through"));
                    exportedThrough = s.getLong(s.getColumnIndexOrThrow("exported_through"));
                    processedThrough = s.getLong(s.getColumnIndexOrThrow("processed_through"));
                    lastSyncAt = s.isNull(s.getColumnIndexOrThrow("last_sync_at")) ? 0 : s.getLong(s.getColumnIndexOrThrow("last_sync_at"));
                    lastServerTime = s.isNull(s.getColumnIndexOrThrow("last_server_time")) ? 0 : s.getLong(s.getColumnIndexOrThrow("last_server_time"));
                    lastErrorCode = s.isNull(s.getColumnIndexOrThrow("last_error_code")) ? null : s.getString(s.getColumnIndexOrThrow("last_error_code"));
                    retryAt = s.isNull(s.getColumnIndexOrThrow("retry_at")) ? 0 : s.getLong(s.getColumnIndexOrThrow("retry_at"));
                }
            }

            int pendingCount = 0;
            try (Cursor p = db.rawQuery("SELECT COUNT(*) FROM event_outbox WHERE account_id = ? AND stream_epoch = ? AND acknowledged = 0",
                    new String[]{accountId, String.valueOf(streamEpoch)})) {
                if (p.moveToFirst()) pendingCount = p.getInt(0);
            }

            JSONObject collections = new JSONObject();
            try (Cursor colC = db.rawQuery("SELECT * FROM cloud_collection_sync WHERE account_id = ?", new String[]{accountId})) {
                while (colC.moveToNext()) {
                    JSONObject item = new JSONObject();
                    item.put("syncedRevision", colC.getLong(colC.getColumnIndexOrThrow("synced_revision")));
                    item.put("syncedComplete", colC.getInt(colC.getColumnIndexOrThrow("synced_complete")) == 1);
                    long syncedAt = colC.isNull(colC.getColumnIndexOrThrow("last_synced_at")) ? 0 : colC.getLong(colC.getColumnIndexOrThrow("last_synced_at"));
                    item.put("lastSyncedAt", syncedAt > 0 ? syncedAt : JSONObject.NULL);
                    collections.put(colC.getString(colC.getColumnIndexOrThrow("collection_kind")), item);
                }
            }

            boolean accountMatched = cloudBound && cloudAccountId != null && cloudAccountId.equals(accountId);
            res.put("subjectId", subjectId != null ? subjectId : JSONObject.NULL);
            res.put("deviceId", deviceId != null ? deviceId : JSONObject.NULL);
            res.put("installationId", installationId);
            res.put("cloudBound", cloudBound);
            res.put("cloudAccountId", cloudAccountId != null ? cloudAccountId : JSONObject.NULL);
            res.put("accountMatched", accountMatched);
            res.put("analysisEnabled", analysisEnabled);
            res.put("sessionExpiresAt", sessionExpiresAt > 0 ? sessionExpiresAt : JSONObject.NULL);
            res.put("streamEpoch", streamEpoch);
            res.put("analysisEpoch", analysisEpoch);
            res.put("nextDeviceSeq", nextDeviceSeq);
            res.put("acceptedThrough", acceptedThrough);
            res.put("exportedThrough", exportedThrough);
            res.put("processedThrough", processedThrough);
            res.put("pendingCount", pendingCount);
            res.put("lastSyncAt", lastSyncAt > 0 ? lastSyncAt : JSONObject.NULL);
            res.put("lastServerTime", lastServerTime > 0 ? lastServerTime : JSONObject.NULL);
            res.put("lastErrorCode", lastErrorCode != null ? lastErrorCode : JSONObject.NULL);
            res.put("retryAt", retryAt > 0 ? retryAt : JSONObject.NULL);
            res.put("collections", collections);
            return res;
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
    }

    public synchronized JSONObject readAccountSnapshot(String accountId) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject result = new JSONObject();
        try {
            Cursor cProfile = db.rawQuery("SELECT profile_json FROM accounts WHERE account_id = ?", new String[]{accountId});
            if (cProfile.moveToFirst()) {
                result.put("profile", new JSONObject(cProfile.getString(0)));
            } else {
                result.put("profile", JSONObject.NULL);
            }
            cProfile.close();

            JSONObject cloudState = readCloudSyncState(accountId);
            boolean analysisEnabled = cloudState == null || cloudState.optBoolean("analysisEnabled", true);

            Cursor cPref = db.rawQuery("SELECT history_enabled, manual_tags_json FROM account_preferences WHERE account_id = ?", new String[]{accountId});
            JSONObject prefObj = new JSONObject();
            if (cPref.moveToFirst()) {
                prefObj.put("historyEnabled", cPref.getInt(0) == 1);
                prefObj.put("analysisEnabled", analysisEnabled);
                prefObj.put("manualTags", new JSONArray(cPref.getString(1)));
            } else {
                prefObj.put("historyEnabled", true);
                prefObj.put("analysisEnabled", analysisEnabled);
                prefObj.put("manualTags", new JSONArray());
            }
            cPref.close();
            result.put("preferences", prefObj);

            result.put("repoSync", getSyncState(db, accountId, "repos"));
            result.put("starSync", getSyncState(db, accountId, "stars"));
            result.put("revisions", getAccountRevisions(accountId));
            result.put("cloudSync", cloudState != null ? cloudState : JSONObject.NULL);
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return result;
    }

    private JSONObject getSyncState(SQLiteDatabase db, String accountId, String kind) {
        JSONObject obj = new JSONObject();
        try {
            Cursor c = db.rawQuery("SELECT * FROM sync_state WHERE account_id = ? AND kind = ?", new String[]{accountId, kind});
            if (c.moveToFirst()) {
                String staging = c.getString(c.getColumnIndexOrThrow("staging_generation"));
                int activeComplete = c.getInt(c.getColumnIndexOrThrow("active_complete"));
                int activeCount = c.getInt(c.getColumnIndexOrThrow("active_count"));
                int stagingCount = c.getInt(c.getColumnIndexOrThrow("staging_count"));
                long lastSynced = c.getLong(c.getColumnIndexOrThrow("last_completed_at"));
                String err = c.getString(c.getColumnIndexOrThrow("last_error_code"));
                long retryAt = c.getLong(c.getColumnIndexOrThrow("retry_at"));

                boolean hasStaging = staging != null && !staging.isEmpty();
                obj.put("status", hasStaging ? "loading" : (activeComplete == 1 ? "ready" : (err != null ? "error" : "idle")));
                obj.put("loadedCount", hasStaging ? stagingCount : activeCount);
                obj.put("complete", activeComplete == 1);
                obj.put("lastSyncedAt", lastSynced > 0 ? lastSynced : JSONObject.NULL);
                obj.put("errorCode", err != null ? err : JSONObject.NULL);
                obj.put("retryAt", retryAt > 0 ? retryAt : JSONObject.NULL);
            } else {
                obj.put("status", "idle");
                obj.put("loadedCount", 0);
                obj.put("complete", false);
                obj.put("lastSyncedAt", JSONObject.NULL);
                obj.put("errorCode", JSONObject.NULL);
                obj.put("retryAt", JSONObject.NULL);
            }
            c.close();
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return obj;
    }

    public synchronized void savePreferences(String accountId, JSONObject preferences) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            ContentValues cv = new ContentValues();
            cv.put("account_id", accountId);
            cv.put("history_enabled", preferences.optBoolean("historyEnabled", true) ? 1 : 0);
            cv.put("manual_tags_json", preferences.optJSONArray("manualTags") != null ? preferences.optJSONArray("manualTags").toString() : "[]");
            cv.put("updated_at", now);
            db.insertWithOnConflict("account_preferences", null, cv, SQLiteDatabase.CONFLICT_REPLACE);

            if (preferences.has("analysisEnabled")) {
                ensureAccountV3State(db, accountId, now);
                ContentValues cloudCv = new ContentValues();
                cloudCv.put("analysis_enabled", preferences.optBoolean("analysisEnabled", true) ? 1 : 0);
                cloudCv.put("updated_at", now);
                db.update("cloud_account_state", cloudCv, "account_id = ?", new String[]{accountId});
            }

            bumpRevision(db, accountId, "preference_revision");
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized String beginSync(String accountId, String kind) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        String generationId = "gen_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 6);
        db.beginTransaction();
        try {
            db.execSQL("DELETE FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id != COALESCE((SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = ?), '')", new Object[]{accountId, kind, accountId, kind});

            ContentValues cv = new ContentValues();
            cv.put("account_id", accountId);
            cv.put("kind", kind);
            cv.put("staging_generation", generationId);
            cv.put("staging_next_page", 1);
            cv.put("staging_count", 0);
            cv.putNull("staging_next_url");
            cv.put("staging_page_seq", 0);
            if (db.update("sync_state", cv, "account_id = ? AND kind = ?", new String[]{accountId, kind}) == 0)
                db.insertOrThrow("sync_state", null, cv);

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return generationId;
    }

    public synchronized JSONObject writeSyncPage(String accountId, String kind, String generationId, int pageSeq, JSONArray items, String nextUrl, Integer nextPage) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            try (Cursor state = db.rawQuery("SELECT staging_generation FROM sync_state WHERE account_id = ? AND kind = ?", new String[]{accountId, kind})) {
                if (!state.moveToFirst() || !generationId.equals(state.getString(0))) throw new IllegalStateException("SYNC_GENERATION_MISMATCH");
            }
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.getJSONObject(i);
                String repoKey = item.optString("repoId", "");
                if (repoKey.isEmpty()) repoKey = item.optString("canonicalKey", "");
                long sortTime = item.optLong("starredAt", item.optLong("updatedAt", item.optLong("createdAt", System.currentTimeMillis())));

                ContentValues cv = new ContentValues();
                cv.put("account_id", accountId);
                cv.put("kind", kind);
                cv.put("generation_id", generationId);
                cv.put("repo_id", repoKey);
                cv.put("sort_time", sortTime);
                cv.put("repository_json", item.toString());
                db.insertWithOnConflict("repository_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            }

            Cursor c = db.rawQuery("SELECT COUNT(*) FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id = ?",
                    new String[]{accountId, kind, generationId});
            int count = 0;
            if (c.moveToFirst()) count = c.getInt(0);
            c.close();

            ContentValues upd = new ContentValues();
            upd.put("staging_count", count);
            upd.put("staging_page_seq", pageSeq);
            if (nextUrl != null) upd.put("staging_next_url", nextUrl);
            else upd.putNull("staging_next_url");
            if (nextPage != null) upd.put("staging_next_page", nextPage);
            else upd.putNull("staging_next_page");
            db.update("sync_state", upd, "account_id = ? AND kind = ?", new String[]{accountId, kind});

            db.setTransactionSuccessful();

            res.put("kind", kind);
            res.put("loadedCount", count);
            res.put("nextUrl", nextUrl != null ? nextUrl : JSONObject.NULL);
            res.put("nextPage", nextPage != null ? nextPage : JSONObject.NULL);
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            db.endTransaction();
        }
        return res;
    }

    public synchronized JSONObject finishSync(String accountId, String kind, String generationId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            try (Cursor state = db.rawQuery("SELECT staging_generation, staging_next_page, staging_next_url FROM sync_state WHERE account_id = ? AND kind = ?", new String[]{accountId, kind})) {
                if (!state.moveToFirst() || !generationId.equals(state.getString(0))) throw new IllegalStateException("SYNC_GENERATION_MISMATCH");
                if (!state.isNull(1) || !state.isNull(2)) throw new IllegalStateException("SYNC_UNFINISHED");
            }
            db.delete("repository_cache", "account_id = ? AND kind = ? AND generation_id != ?", new String[]{accountId, kind, generationId});

            Cursor c = db.rawQuery("SELECT staging_count FROM sync_state WHERE account_id = ? AND kind = ?", new String[]{accountId, kind});
            int count = 0;
            if (c.moveToFirst()) count = c.getInt(0);
            c.close();

            long now = System.currentTimeMillis();
            ContentValues upd = new ContentValues();
            upd.put("active_generation", generationId);
            upd.put("active_complete", 1);
            upd.put("active_count", count);
            upd.putNull("staging_generation");
            upd.putNull("staging_next_page");
            upd.putNull("staging_next_url");
            upd.put("staging_page_seq", 0);
            upd.put("staging_count", 0);
            upd.put("last_completed_at", now);
            upd.putNull("last_error_code");
            upd.putNull("retry_at");
            db.update("sync_state", upd, "account_id = ? AND kind = ?", new String[]{accountId, kind});

            bumpRevision(db, accountId, "collection_revision");

            db.setTransactionSuccessful();

            res.put("kind", kind);
            res.put("activeCount", count);
            res.put("complete", true);
            res.put("lastSyncedAt", now);
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            db.endTransaction();
        }
        return res;
    }

    public synchronized void abortSync(String accountId, String kind, String generationId, String errorCode, Long retryAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            try (Cursor state = db.rawQuery("SELECT staging_generation FROM sync_state WHERE account_id = ? AND kind = ?", new String[]{accountId, kind})) {
                if (!state.moveToFirst() || !generationId.equals(state.getString(0))) { db.setTransactionSuccessful(); return; }
            }
            db.delete("repository_cache", "account_id = ? AND kind = ? AND generation_id = ?", new String[]{accountId, kind, generationId});

            ContentValues upd = new ContentValues();
            upd.putNull("staging_generation");
            upd.putNull("staging_next_page");
            upd.putNull("staging_next_url");
            upd.put("staging_page_seq", 0);
            upd.put("staging_count", 0);
            if (errorCode != null) upd.put("last_error_code", errorCode);
            if (retryAt != null) upd.put("retry_at", retryAt);
            db.update("sync_state", upd, "account_id = ? AND kind = ?", new String[]{accountId, kind});

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized JSONObject listRepositories(String accountId, String kind, int offset, int limit) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        try {
            Cursor cState = db.rawQuery("SELECT active_generation, active_complete, active_count FROM sync_state WHERE account_id = ? AND kind = ?",
                    new String[]{accountId, kind});
            String activeGen = null;
            boolean complete = false;
            int activeCount = 0;
            if (cState.moveToFirst()) {
                activeGen = cState.getString(0);
                complete = cState.getInt(1) == 1;
                activeCount = cState.getInt(2);
            }
            cState.close();

            if (activeGen == null) {
                res.put("items", new JSONArray());
                res.put("total", JSONObject.NULL);
                res.put("loadedCount", 0);
                res.put("complete", false);
                res.put("nextOffset", JSONObject.NULL);
                return res;
            }

            Cursor c = db.rawQuery(
                    "SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id = ? " +
                            "ORDER BY sort_time DESC, repo_id DESC LIMIT ? OFFSET ?",
                    new String[]{accountId, kind, activeGen, String.valueOf(limit), String.valueOf(offset)}
            );

            JSONArray items = new JSONArray();
            while (c.moveToNext()) {
                items.put(new JSONObject(c.getString(0)));
            }
            c.close();

            res.put("items", items);
            res.put("total", complete ? activeCount : JSONObject.NULL);
            res.put("loadedCount", activeCount);
            res.put("complete", complete);
            res.put("nextOffset", offset + items.length() < activeCount ? (offset + items.length()) : JSONObject.NULL);
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    public synchronized void applyConfirmedStar(String accountId, JSONObject repository, boolean starred) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            String repoKey = repository.optString("repoId", "");
            if (repoKey.isEmpty()) repoKey = repository.optString("canonicalKey", "");

            Cursor c = db.rawQuery("SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'stars'", new String[]{accountId});
            String activeGen = "active_stars_local";
            if (c.moveToFirst()) {
                String existing = c.getString(0);
                if (existing != null && !existing.isEmpty()) activeGen = existing;
            }
            c.close();

            ContentValues initial = new ContentValues();
            initial.put("account_id", accountId); initial.put("kind", "stars"); initial.put("active_generation", activeGen);
            db.insertWithOnConflict("sync_state", null, initial, SQLiteDatabase.CONFLICT_IGNORE);
            ContentValues active = new ContentValues(); active.put("active_generation", activeGen);
            db.update("sync_state", active, "account_id = ? AND kind = 'stars'", new String[]{accountId});

            long now = System.currentTimeMillis();
            if (starred) {
                ContentValues cv = new ContentValues();
                cv.put("account_id", accountId);
                cv.put("kind", "stars");
                cv.put("generation_id", activeGen);
                cv.put("repo_id", repoKey);
                cv.put("sort_time", now);
                cv.put("repository_json", repository.toString());
                db.insertWithOnConflict("repository_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            } else {
                db.delete("repository_cache", "account_id = ? AND kind = 'stars' AND generation_id = ? AND repo_id = ?",
                        new String[]{accountId, activeGen, repoKey});
            }

            Cursor cntC = db.rawQuery("SELECT COUNT(*) FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ?",
                    new String[]{accountId, activeGen});
            int cnt = 0;
            if (cntC.moveToFirst()) cnt = cntC.getInt(0);
            cntC.close();

            ContentValues upd = new ContentValues();
            upd.put("active_count", cnt);
            db.update("sync_state", upd, "account_id = ? AND kind = 'stars'", new String[]{accountId});

            String repoId = repository.optString("repoId", null);
            if (repoId != null && !repoId.isEmpty()) {
                db.execSQL("INSERT INTO star_state (account_id, repo_id, starred, observed_at, mutation_revision) " +
                        "VALUES (?, ?, ?, ?, 1) ON CONFLICT(account_id, repo_id) DO UPDATE SET " +
                        "starred = excluded.starred, observed_at = excluded.observed_at, mutation_revision = star_state.mutation_revision + 1;",
                        new Object[]{accountId, repoId, starred ? 1 : 0, now});
            }

            bumpRevision(db, accountId, "star_mutation_revision");
            bumpRevision(db, accountId, "collection_revision");

            db.setTransactionSuccessful();
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            db.endTransaction();
        }
    }

    public synchronized JSONObject readStarState(String accountId, String repoId, String fullName) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        try {
            if (repoId != null && !repoId.isEmpty()) {
                Cursor c = db.rawQuery("SELECT starred, observed_at FROM star_state WHERE account_id = ? AND repo_id = ?", new String[]{accountId, repoId});
                if (c.moveToFirst()) {
                    res.put("state", c.getInt(0) == 1 ? "starred" : "unstarred");
                    res.put("observedAt", c.getLong(1));
                    c.close();
                    return res;
                }
                c.close();
            }

            JSONObject activeStar = isRepositoryStarred(accountId, (repoId != null && !repoId.isEmpty()) ? repoId : (fullName != null ? fullName.toLowerCase() : ""));
            if (activeStar.getBoolean("known")) {
                res.put("state", activeStar.getBoolean("starred") ? "starred" : "unstarred");
                res.put("observedAt", System.currentTimeMillis());
            } else {
                res.put("state", "unknown");
                res.put("observedAt", JSONObject.NULL);
            }
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    public synchronized JSONObject isRepositoryStarred(String accountId, String repoId) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        try {
            Cursor c = db.rawQuery("SELECT active_generation, active_complete FROM sync_state WHERE account_id = ? AND kind = 'stars'", new String[]{accountId});
            String activeGen = null;
            boolean complete = false;
            if (c.moveToFirst()) {
                activeGen = c.getString(0);
                complete = c.getInt(1) == 1;
            }
            c.close();

            if (activeGen == null || activeGen.isEmpty()) {
                res.put("known", false);
                res.put("starred", false);
                return res;
            }

            Cursor checkC = db.rawQuery("SELECT 1 FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ? AND repo_id = ?",
                    new String[]{accountId, activeGen, repoId});
            boolean exists = checkC.moveToFirst();
            checkC.close();

            if (exists) {
                res.put("known", true);
                res.put("starred", true);
            } else if (complete) {
                res.put("known", true);
                res.put("starred", false);
            } else {
                res.put("known", false);
                res.put("starred", false);
            }
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    public synchronized JSONObject recordBrowse(String accountId, JSONObject repository, String source, long viewedAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            try (Cursor prefC = db.rawQuery("SELECT history_enabled FROM account_preferences WHERE account_id = ?", new String[]{accountId})) {
                if (prefC.moveToFirst() && prefC.getInt(0) == 0) {
                    res.put("skipped", true);
                    res.put("reason", "HISTORY_DISABLED");
                    db.setTransactionSuccessful();
                    return res;
                }
            }

            String repoKey = repository.optString("repoId", "");
            if (repoKey.isEmpty()) repoKey = repository.optString("canonicalKey", "");

            boolean shouldCount = true;
            Cursor c = db.rawQuery("SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?", new String[]{accountId, repoKey});
            if (!c.moveToFirst()) {
                c.close();
                ContentValues cv = new ContentValues();
                cv.put("account_id", accountId);
                cv.put("repo_id", repoKey);
                cv.put("full_name", repository.getString("fullName"));
                if (repository.has("description") && !repository.isNull("description")) cv.put("description", repository.getString("description"));
                else cv.putNull("description");
                cv.put("repository_json", repository.toString());
                cv.put("first_viewed_at", viewedAt);
                cv.put("last_viewed_at", viewedAt);
                cv.put("last_counted_at", viewedAt);
                cv.put("visit_count", 1);
                cv.put("last_source", source);
                db.insertOrThrow("browse_history", null, cv);
            } else {
                long lastViewed = c.getLong(c.getColumnIndexOrThrow("last_viewed_at"));
                long lastCounted = c.getLong(c.getColumnIndexOrThrow("last_counted_at"));
                int visitCount = c.getInt(c.getColumnIndexOrThrow("visit_count"));
                c.close();

                long nextViewed = Math.max(lastViewed, viewedAt);
                shouldCount = (viewedAt - lastCounted) >= 30000L;
                int nextCount = shouldCount ? (visitCount + 1) : visitCount;
                long nextCounted = shouldCount ? viewedAt : lastCounted;

                ContentValues upd = new ContentValues();
                upd.put("full_name", repository.getString("fullName"));
                if (repository.has("description") && !repository.isNull("description")) upd.put("description", repository.getString("description"));
                else upd.putNull("description");
                upd.put("repository_json", repository.toString());
                upd.put("last_viewed_at", nextViewed);
                upd.put("last_counted_at", nextCounted);
                upd.put("visit_count", nextCount);
                upd.put("last_source", source);
                db.update("browse_history", upd, "account_id = ? AND repo_id = ?", new String[]{accountId, repoKey});
            }

            String createdEventId = null;
            Long enqueuedSeq = null;

            if (shouldCount) {
                ensureAccountV3State(db, accountId, viewedAt);
                boolean analysisEnabled = true;
                try (Cursor ca = db.rawQuery("SELECT analysis_enabled FROM cloud_account_state WHERE account_id = ?", new String[]{accountId})) {
                    if (ca.moveToFirst()) analysisEnabled = ca.getInt(0) == 1;
                }

                long streamEpoch = 1;
                long analysisEpoch = 1;
                long nextSeq = 1;
                try (Cursor ls = db.rawQuery("SELECT stream_epoch, analysis_epoch, next_device_seq FROM local_sync_state WHERE account_id = ?", new String[]{accountId})) {
                    if (ls.moveToFirst()) {
                        streamEpoch = ls.getLong(0);
                        analysisEpoch = ls.getLong(1);
                        nextSeq = ls.getLong(2);
                    }
                }

                String safeAcc = accountId.replaceAll("[^A-Za-z0-9_.-]", "_");
                String randSuffix = UUID.randomUUID().toString().replace("-", "").substring(0, 8);
                createdEventId = "evt_" + safeAcc + "_" + viewedAt + "_" + randSuffix;

                ContentValues actCv = new ContentValues();
                actCv.put("event_id", createdEventId);
                actCv.put("account_id", accountId);
                actCv.put("repo_id", repoKey);
                actCv.put("full_name", repository.optString("fullName", repoKey));
                actCv.put("record_kind", "open");
                actCv.put("source", "browse");
                actCv.put("entry_source", source != null ? source : "browse");
                actCv.put("occurred_at", viewedAt);
                actCv.put("effective_at", viewedAt);
                actCv.put("time_flag", "normal");
                actCv.put("analysis_epoch", analysisEpoch);
                actCv.put("repository_json", repository.toString());
                db.insertOrThrow("local_activity_events", null, actCv);

                String canonicalRepoId = repository.optString("repoId", repoKey).trim();
                if (analysisEnabled && !canonicalRepoId.isEmpty()) {
                    enqueuedSeq = nextSeq;
                    String payloadHash = computeOpenPayloadHash(
                            createdEventId, streamEpoch, nextSeq, analysisEpoch, canonicalRepoId, viewedAt, "browse");

                    JSONObject eventPayload = new JSONObject();
                    eventPayload.put("schemaVersion", "1.0.0");
                    eventPayload.put("eventId", createdEventId);
                    eventPayload.put("streamEpoch", streamEpoch);
                    eventPayload.put("deviceSeq", nextSeq);
                    eventPayload.put("analysisEpoch", analysisEpoch);
                    eventPayload.put("recordKind", "open");
                    eventPayload.put("repoId", canonicalRepoId);
                    eventPayload.put("source", "browse");
                    eventPayload.put("entrySource", source != null ? source : "browse");
                    eventPayload.put("occurredAt", viewedAt);
                    eventPayload.put("payloadHash", payloadHash);

                    ContentValues outCv = new ContentValues();
                    outCv.put("account_id", accountId);
                    outCv.put("stream_epoch", streamEpoch);
                    outCv.put("device_seq", nextSeq);
                    outCv.put("event_id", createdEventId);
                    outCv.put("analysis_epoch", analysisEpoch);
                    outCv.put("record_kind", "open");
                    outCv.put("repo_id", canonicalRepoId);
                    outCv.put("source", "browse");
                    outCv.put("entry_source", source != null ? source : "browse");
                    outCv.put("occurred_at", viewedAt);
                    outCv.put("payload_hash", payloadHash);
                    outCv.put("payload_json", eventPayload.toString());
                    outCv.put("acknowledged", 0);
                    outCv.put("created_at", viewedAt);
                    outCv.put("updated_at", viewedAt);
                    db.insertOrThrow("event_outbox", null, outCv);

                    ContentValues seqUpd = new ContentValues();
                    seqUpd.put("next_device_seq", nextSeq + 1);
                    db.update("local_sync_state", seqUpd, "account_id = ?", new String[]{accountId});
                }
            }

            pruneHistory(db, accountId, viewedAt);
            bumpRevision(db, accountId, "history_revision");

            Cursor finalC = db.rawQuery("SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?", new String[]{accountId, repoKey});
            if (finalC.moveToFirst()) {
                res.put("accountId", finalC.getString(finalC.getColumnIndexOrThrow("account_id")));
                res.put("repoId", finalC.getString(finalC.getColumnIndexOrThrow("repo_id")));
                res.put("repository", new JSONObject(finalC.getString(finalC.getColumnIndexOrThrow("repository_json"))));
                res.put("firstViewedAt", finalC.getLong(finalC.getColumnIndexOrThrow("first_viewed_at")));
                res.put("lastViewedAt", finalC.getLong(finalC.getColumnIndexOrThrow("last_viewed_at")));
                res.put("lastCountedAt", finalC.getLong(finalC.getColumnIndexOrThrow("last_counted_at")));
                res.put("visitCount", finalC.getInt(finalC.getColumnIndexOrThrow("visit_count")));
                res.put("lastSource", finalC.getString(finalC.getColumnIndexOrThrow("last_source")));
                res.put("countedVisit", shouldCount);
                res.put("eventId", createdEventId != null ? createdEventId : JSONObject.NULL);
                res.put("deviceSeq", enqueuedSeq != null ? enqueuedSeq : JSONObject.NULL);
            }
            finalC.close();

            db.setTransactionSuccessful();
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            db.endTransaction();
        }
        return res;
    }

    private void pruneHistory(SQLiteDatabase db, String accountId, long now) {
        long ninetyDaysAgo = now - (90L * 24 * 60 * 60 * 1000);
        db.delete("browse_history", "account_id = ? AND last_viewed_at < ?", new String[]{accountId, String.valueOf(ninetyDaysAgo)});
        db.delete("local_activity_events", "account_id = ? AND occurred_at < ?", new String[]{accountId, String.valueOf(ninetyDaysAgo)});

        Cursor countC = db.rawQuery("SELECT COUNT(*) FROM browse_history WHERE account_id = ?", new String[]{accountId});
        int count = 0;
        if (countC.moveToFirst()) count = countC.getInt(0);
        countC.close();

        if (count > 5000) {
            db.execSQL("DELETE FROM browse_history WHERE account_id = ? AND repo_id NOT IN (" +
                    "SELECT repo_id FROM browse_history WHERE account_id = ? " +
                    "ORDER BY last_viewed_at DESC, repo_id DESC LIMIT 5000)", new Object[]{accountId, accountId});
        }
    }

    private void convertPendingOutboxToDiscard(SQLiteDatabase db, String accountId, String repoId) {
        long now = System.currentTimeMillis();
        String sql = repoId != null
                ? "SELECT event_id, stream_epoch, device_seq, analysis_epoch FROM event_outbox WHERE account_id = ? AND repo_id = ? AND acknowledged = 0 AND record_kind = 'open'"
                : "SELECT event_id, stream_epoch, device_seq, analysis_epoch FROM event_outbox WHERE account_id = ? AND acknowledged = 0 AND record_kind = 'open'";
        String[] args = repoId != null ? new String[]{accountId, repoId} : new String[]{accountId};

        List<long[]> seqInfo = new ArrayList<>();
        List<String> eventIds = new ArrayList<>();
        try (Cursor c = db.rawQuery(sql, args)) {
            while (c.moveToNext()) {
                eventIds.add(c.getString(0));
                seqInfo.add(new long[]{c.getLong(1), c.getLong(2), c.getLong(3)});
            }
        }

        for (int i = 0; i < eventIds.size(); i++) {
            String eid = eventIds.get(i);
            long[] info = seqInfo.get(i);
            String discardHash = computeDiscardPayloadHash(eid, info[0], info[1], info[2]);
            ContentValues upd = new ContentValues();
            upd.put("record_kind", "discard");
            upd.putNull("repo_id");
            upd.putNull("source");
            upd.putNull("entry_source");
            upd.putNull("occurred_at");
            upd.put("payload_hash", discardHash);
            upd.putNull("payload_json");
            upd.put("updated_at", now);
            db.update("event_outbox", upd, "account_id = ? AND stream_epoch = ? AND device_seq = ?",
                    new String[]{accountId, String.valueOf(info[0]), String.valueOf(info[1])});
        }

        ContentValues clearFlight = new ContentValues();
        clearFlight.putNull("in_flight_request_id");
        clearFlight.putNull("in_flight_first_seq");
        clearFlight.putNull("in_flight_last_seq");
        db.update("local_sync_state", clearFlight, "account_id = ?", new String[]{accountId});
    }

    public synchronized JSONObject listHistory(String accountId, JSONObject cursor, int limit, String keyword) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        limit = Math.max(1, Math.min(100, limit));
        try {
            StringBuilder sql = new StringBuilder("SELECT * FROM browse_history WHERE account_id = ?");
            List<String> args = new ArrayList<>();
            args.add(accountId);

            if (keyword != null && !keyword.trim().isEmpty()) {
                String kw = "%" + keyword.trim().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
                sql.append(" AND (full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
                args.add(kw);
                args.add(kw);
            }

            if (cursor != null && cursor.has("lastViewedAt") && !cursor.isNull("lastViewedAt")) {
                sql.append(" AND (last_viewed_at < ? OR (last_viewed_at = ? AND repo_id < ?))");
                args.add(String.valueOf(cursor.getLong("lastViewedAt")));
                args.add(String.valueOf(cursor.getLong("lastViewedAt")));
                args.add(cursor.getString("repoId"));
            }

            sql.append(" ORDER BY last_viewed_at DESC, repo_id DESC LIMIT ?");
            args.add(String.valueOf(limit));

            Cursor c = db.rawQuery(sql.toString(), args.toArray(new String[0]));
            JSONArray items = new JSONArray();
            while (c.moveToNext()) {
                JSONObject item = new JSONObject();
                item.put("accountId", c.getString(c.getColumnIndexOrThrow("account_id")));
                item.put("repoId", c.getString(c.getColumnIndexOrThrow("repo_id")));
                item.put("repository", new JSONObject(c.getString(c.getColumnIndexOrThrow("repository_json"))));
                item.put("firstViewedAt", c.getLong(c.getColumnIndexOrThrow("first_viewed_at")));
                item.put("lastViewedAt", c.getLong(c.getColumnIndexOrThrow("last_viewed_at")));
                item.put("lastCountedAt", c.getLong(c.getColumnIndexOrThrow("last_counted_at")));
                item.put("visitCount", c.getInt(c.getColumnIndexOrThrow("visit_count")));
                item.put("lastSource", c.getString(c.getColumnIndexOrThrow("last_source")));
                items.put(item);
            }
            c.close();

            JSONObject nextCursor = null;
            if (items.length() == limit) {
                JSONObject last = items.getJSONObject(items.length() - 1);
                nextCursor = new JSONObject();
                nextCursor.put("lastViewedAt", last.getLong("lastViewedAt"));
                nextCursor.put("repoId", last.getString("repoId"));
            }

            StringBuilder countSql = new StringBuilder("SELECT COUNT(*) FROM browse_history WHERE account_id = ?");
            List<String> countArgs = new ArrayList<>();
            countArgs.add(accountId);
            if (keyword != null && !keyword.trim().isEmpty()) {
                String kw = "%" + keyword.trim().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%";
                countSql.append(" AND (full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
                countArgs.add(kw);
                countArgs.add(kw);
            }
            Cursor countC = db.rawQuery(countSql.toString(), countArgs.toArray(new String[0]));
            int total = 0;
            if (countC.moveToFirst()) total = countC.getInt(0);
            countC.close();

            res.put("items", items);
            res.put("nextCursor", nextCursor != null ? nextCursor : JSONObject.NULL);
            res.put("total", total);
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    public synchronized void deleteHistory(String accountId, String repoId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            db.delete("browse_history", "account_id = ? AND repo_id = ?", new String[]{accountId, repoId});
            db.delete("local_activity_events", "account_id = ? AND repo_id = ?", new String[]{accountId, repoId});
            convertPendingOutboxToDiscard(db, accountId, repoId);
            bumpRevision(db, accountId, "history_revision");
            db.delete("interest_profiles", "account_id = ?", new String[]{accountId});
            db.delete("recommendation_batches", "account_id = ?", new String[]{accountId});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized void clearHistory(String accountId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            db.delete("browse_history", "account_id = ?", new String[]{accountId});
            db.delete("local_activity_events", "account_id = ?", new String[]{accountId});
            convertPendingOutboxToDiscard(db, accountId, null);
            bumpRevision(db, accountId, "history_revision");
            db.delete("interest_profiles", "account_id = ?", new String[]{accountId});
            db.delete("discovery_cache", "account_id = ?", new String[]{accountId});
            db.delete("recommendation_batches", "account_id = ?", new String[]{accountId});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized JSONObject saveCloudAccountState(String accountId, JSONObject patch) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            ensureAccountV3State(db, accountId, now);
            ContentValues cv = new ContentValues();
            if (patch.has("subjectId")) {
                if (patch.isNull("subjectId")) cv.putNull("subject_id");
                else cv.put("subject_id", patch.optString("subjectId"));
            }
            if (patch.has("deviceId")) {
                if (patch.isNull("deviceId")) cv.putNull("device_id");
                else cv.put("device_id", patch.optString("deviceId"));
            }
            if (patch.has("streamEpoch")) cv.put("stream_epoch", patch.optLong("streamEpoch", 1));
            if (patch.has("analysisEpoch")) cv.put("analysis_epoch", patch.optLong("analysisEpoch", 1));
            if (patch.has("analysisEnabled")) cv.put("analysis_enabled", patch.optBoolean("analysisEnabled", true) ? 1 : 0);
            if (patch.has("cloudBound")) cv.put("cloud_bound", patch.optBoolean("cloudBound", false) ? 1 : 0);
            if (patch.has("cloudAccountId")) {
                if (patch.isNull("cloudAccountId")) cv.putNull("cloud_account_id");
                else cv.put("cloud_account_id", patch.optString("cloudAccountId"));
            }
            if (patch.has("sessionExpiresAt")) {
                if (patch.isNull("sessionExpiresAt")) cv.putNull("session_expires_at");
                else cv.put("session_expires_at", patch.optLong("sessionExpiresAt"));
            }
            cv.put("updated_at", now);
            db.update("cloud_account_state", cv, "account_id = ?", new String[]{accountId});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return readCloudSyncState(accountId);
    }

    public synchronized JSONObject syncCloudStreamState(String accountId, JSONObject serverState) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            ensureAccountV3State(db, accountId, now);

            long oldStreamEpoch = 1;
            long oldAnalysisEpoch = 1;
            long nextDeviceSeq = 1;
            long curAccepted = 0;
            long curExported = 0;
            long curProcessed = 0;

            try (Cursor c = db.rawQuery("SELECT stream_epoch, analysis_epoch, next_device_seq, accepted_through, exported_through, processed_through FROM local_sync_state WHERE account_id = ?", new String[]{accountId})) {
                if (c.moveToFirst()) {
                    oldStreamEpoch = c.getLong(0);
                    oldAnalysisEpoch = c.getLong(1);
                    nextDeviceSeq = c.getLong(2);
                    curAccepted = c.getLong(3);
                    curExported = c.getLong(4);
                    curProcessed = c.getLong(5);
                }
            }

            long newStreamEpoch = serverState.optLong("streamEpoch", oldStreamEpoch);
            long newAnalysisEpoch = serverState.optLong("analysisEpoch", oldAnalysisEpoch);
            long acceptedThrough = serverState.optLong("acceptedThrough", curAccepted);
            long exportedThrough = serverState.optLong("exportedThrough", curExported);
            long processedThrough = serverState.optLong("processedThrough", curProcessed);

            ContentValues accUpd = new ContentValues();
            if (serverState.has("deviceId") && !serverState.isNull("deviceId")) {
                accUpd.put("device_id", serverState.optString("deviceId"));
            }
            accUpd.put("stream_epoch", newStreamEpoch);
            accUpd.put("analysis_epoch", newAnalysisEpoch);
            JSONObject prefs = serverState.optJSONObject("preferences");
            if (prefs != null && prefs.has("analysisEnabled")) {
                accUpd.put("analysis_enabled", prefs.optBoolean("analysisEnabled", true) ? 1 : 0);
            }
            accUpd.put("updated_at", now);
            db.update("cloud_account_state", accUpd, "account_id = ?", new String[]{accountId});

            if (oldStreamEpoch == newStreamEpoch && acceptedThrough > 0) {
                ContentValues ackCv = new ContentValues();
                ackCv.put("acknowledged", 1);
                ackCv.putNull("payload_json");
                ackCv.put("updated_at", now);
                db.update("event_outbox", ackCv, "account_id = ? AND stream_epoch = ? AND device_seq <= ?",
                        new String[]{accountId, String.valueOf(newStreamEpoch), String.valueOf(acceptedThrough)});
            }

            long finalNextSeq = Math.max(acceptedThrough + 1, nextDeviceSeq);
            ContentValues syncUpd = new ContentValues();
            syncUpd.put("stream_epoch", newStreamEpoch);
            syncUpd.put("analysis_epoch", newAnalysisEpoch);
            syncUpd.put("next_device_seq", finalNextSeq);
            syncUpd.put("accepted_through", acceptedThrough);
            syncUpd.put("exported_through", exportedThrough);
            syncUpd.put("processed_through", processedThrough);
            if (serverState.has("serverTime")) syncUpd.put("last_server_time", serverState.optLong("serverTime"));
            syncUpd.putNull("last_error_code");
            syncUpd.putNull("retry_at");
            syncUpd.putNull("in_flight_request_id");
            syncUpd.putNull("in_flight_first_seq");
            syncUpd.putNull("in_flight_last_seq");
            db.update("local_sync_state", syncUpd, "account_id = ?", new String[]{accountId});

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return readCloudSyncState(accountId);
    }

    public synchronized JSONObject readOutboxBatch(String accountId, int maxItems, int maxBytes) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            ensureAccountV3State(db, accountId, System.currentTimeMillis());
            long streamEpoch = 1;
            long analysisEpoch = 1;
            long acceptedThrough = 0;
            String inFlightId = null;
            long inFlightFirst = -1;
            long inFlightLast = -1;

            try (Cursor s = db.rawQuery("SELECT stream_epoch, analysis_epoch, accepted_through, in_flight_request_id, in_flight_first_seq, in_flight_last_seq FROM local_sync_state WHERE account_id = ?", new String[]{accountId})) {
                if (s.moveToFirst()) {
                    streamEpoch = s.getLong(0);
                    analysisEpoch = s.getLong(1);
                    acceptedThrough = s.getLong(2);
                    inFlightId = s.isNull(3) ? null : s.getString(3);
                    inFlightFirst = s.isNull(4) ? -1 : s.getLong(4);
                    inFlightLast = s.isNull(5) ? -1 : s.getLong(5);
                }
            }

            long expectedFirstSeq = acceptedThrough + 1;
            JSONArray events = new JSONArray();
            long expectedSeq = -1;
            long firstSeq = -1;
            long lastSeq = -1;
            int accumulatedBytes = 128;

            try (Cursor c = db.rawQuery(
                    "SELECT event_id, device_seq, record_kind, repo_id, occurred_at, source, entry_source, payload_hash " +
                            "FROM event_outbox WHERE account_id = ? AND stream_epoch = ? AND acknowledged = 0 AND device_seq >= ? " +
                            "ORDER BY device_seq ASC LIMIT ?",
                    new String[]{accountId, String.valueOf(streamEpoch), String.valueOf(expectedFirstSeq), String.valueOf(Math.min(500, Math.max(1, maxItems)))})) {
                while (c.moveToNext()) {
                    long seq = c.getLong(1);
                    if (expectedSeq == -1) {
                        expectedSeq = seq;
                        firstSeq = seq;
                    } else if (seq != expectedSeq) {
                        break;
                    }

                    String kind = c.getString(2);
                    JSONObject ev = new JSONObject();
                    ev.put("eventId", c.getString(0));
                    ev.put("deviceSeq", seq);
                    ev.put("recordKind", kind);
                    if ("open".equals(kind)) {
                        ev.put("repoId", c.getString(3));
                        ev.put("occurredAt", c.getLong(4));
                        ev.put("source", c.isNull(5) ? "browse" : c.getString(5));
                        ev.put("entrySource", c.isNull(6) ? "browse" : c.getString(6));
                    }
                    ev.put("payloadHash", c.getString(7));

                    int itemBytes = ev.toString().getBytes(StandardCharsets.UTF_8).length + 2;
                    if (events.length() > 0 && accumulatedBytes + itemBytes > maxBytes) {
                        break;
                    }
                    events.put(ev);
                    accumulatedBytes += itemBytes;
                    lastSeq = seq;
                    expectedSeq = seq + 1;
                }
            }

            if (events.length() == 0) {
                res.put("hasBatch", false);
                res.put("events", events);
                db.setTransactionSuccessful();
                return res;
            }

            String requestId = inFlightId;
            if (requestId == null || inFlightFirst != firstSeq || inFlightLast != lastSeq) {
                requestId = "req_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
                ContentValues flightCv = new ContentValues();
                flightCv.put("in_flight_request_id", requestId);
                flightCv.put("in_flight_first_seq", firstSeq);
                flightCv.put("in_flight_last_seq", lastSeq);
                db.update("local_sync_state", flightCv, "account_id = ?", new String[]{accountId});
            }

            res.put("hasBatch", true);
            res.put("requestId", requestId);
            res.put("streamEpoch", streamEpoch);
            res.put("analysisEpoch", analysisEpoch);
            res.put("firstSeq", firstSeq);
            res.put("lastSeq", lastSeq);
            res.put("events", events);
            db.setTransactionSuccessful();
            return res;
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            db.endTransaction();
        }
    }

    public synchronized JSONObject applyOutboxAck(String accountId, JSONObject ackPayload) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            ensureAccountV3State(db, accountId, now);

            long curStream = 1, curAnalysis = 1, curAccepted = 0, curExported = 0, curProcessed = 0;
            try (Cursor s = db.rawQuery("SELECT stream_epoch, analysis_epoch, accepted_through, exported_through, processed_through FROM local_sync_state WHERE account_id = ?", new String[]{accountId})) {
                if (s.moveToFirst()) {
                    curStream = s.getLong(0);
                    curAnalysis = s.getLong(1);
                    curAccepted = s.getLong(2);
                    curExported = s.getLong(3);
                    curProcessed = s.getLong(4);
                }
            }

            long streamEpoch = ackPayload.optLong("streamEpoch", curStream);
            long analysisEpoch = ackPayload.optLong("analysisEpoch", curAnalysis);
            long acceptedThrough = Math.max(curAccepted, ackPayload.optLong("acceptedThrough", 0));
            long exportedThrough = Math.max(curExported, ackPayload.optLong("exportedThrough", 0));
            long processedThrough = ackPayload.has("processedThrough")
                    ? Math.max(curProcessed, ackPayload.optLong("processedThrough", 0))
                    : curProcessed;

            ContentValues ackCv = new ContentValues();
            ackCv.put("acknowledged", 1);
            ackCv.putNull("payload_json");
            ackCv.put("updated_at", now);
            db.update("event_outbox", ackCv, "account_id = ? AND stream_epoch = ? AND device_seq <= ?",
                    new String[]{accountId, String.valueOf(streamEpoch), String.valueOf(acceptedThrough)});

            JSONArray timeAdjs = ackPayload.optJSONArray("timeAdjustments");
            if (timeAdjs != null) {
                for (int i = 0; i < timeAdjs.length(); i++) {
                    JSONObject adj = timeAdjs.optJSONObject(i);
                    if (adj != null && adj.has("eventId") && adj.has("effectiveAt")) {
                        ContentValues adjCv = new ContentValues();
                        adjCv.put("effective_at", adj.optLong("effectiveAt"));
                        adjCv.put("time_flag", adj.optString("timeFlag", "adjusted"));
                        db.update("local_activity_events", adjCv, "account_id = ? AND event_id = ?",
                                new String[]{accountId, adj.optString("eventId")});
                    }
                }
            }

            ContentValues syncUpd = new ContentValues();
            syncUpd.put("stream_epoch", streamEpoch);
            syncUpd.put("analysis_epoch", analysisEpoch);
            syncUpd.put("accepted_through", acceptedThrough);
            syncUpd.put("exported_through", exportedThrough);
            syncUpd.put("processed_through", processedThrough);
            syncUpd.put("last_sync_at", now);
            if (ackPayload.has("serverTime")) syncUpd.put("last_server_time", ackPayload.optLong("serverTime"));
            syncUpd.putNull("last_error_code");
            syncUpd.putNull("retry_at");
            syncUpd.putNull("in_flight_request_id");
            syncUpd.putNull("in_flight_first_seq");
            syncUpd.putNull("in_flight_last_seq");
            db.update("local_sync_state", syncUpd, "account_id = ?", new String[]{accountId});

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return readCloudSyncState(accountId);
    }

    public synchronized JSONObject recordOutboxError(String accountId, String errorCode, Long retryAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ensureAccountV3State(db, accountId, System.currentTimeMillis());
        ContentValues cv = new ContentValues();
        if (errorCode != null) cv.put("last_error_code", errorCode);
        else cv.putNull("last_error_code");
        if (retryAt != null) cv.put("retry_at", retryAt);
        else cv.putNull("retry_at");
        db.update("local_sync_state", cv, "account_id = ?", new String[]{accountId});
        return readCloudSyncState(accountId);
    }

    public synchronized JSONObject resetCloudAnalysisLocalState(String accountId, long newAnalysisEpoch) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            ensureAccountV3State(db, accountId, now);
            convertPendingOutboxToDiscard(db, accountId, null);

            ContentValues outUpd = new ContentValues();
            outUpd.put("analysis_epoch", newAnalysisEpoch);
            outUpd.put("updated_at", now);
            db.update("event_outbox", outUpd, "account_id = ? AND acknowledged = 0", new String[]{accountId});

            ContentValues accUpd = new ContentValues();
            accUpd.put("analysis_epoch", newAnalysisEpoch);
            accUpd.put("updated_at", now);
            db.update("cloud_account_state", accUpd, "account_id = ?", new String[]{accountId});

            ContentValues syncUpd = new ContentValues();
            syncUpd.put("analysis_epoch", newAnalysisEpoch);
            syncUpd.put("processed_through", 0);
            db.update("local_sync_state", syncUpd, "account_id = ?", new String[]{accountId});

            db.delete("cloud_collection_sync", "account_id = ?", new String[]{accountId});
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return readCloudSyncState(accountId);
    }

    public synchronized JSONObject readCollectionForCloudSync(String accountId, String collectionKind) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        try {
            String localKind = "stars".equals(collectionKind) ? "stars" : "repos";
            String activeGen = null;
            boolean activeComplete = false;
            long lastCompletedAt = System.currentTimeMillis();

            try (Cursor s = db.rawQuery("SELECT active_generation, active_complete, last_completed_at FROM sync_state WHERE account_id = ? AND kind = ?", new String[]{accountId, localKind})) {
                if (s.moveToFirst()) {
                    activeGen = s.getString(0);
                    activeComplete = s.getInt(1) == 1;
                    if (!s.isNull(2)) lastCompletedAt = s.getLong(2);
                }
            }

            long syncedRevision = 0;
            boolean syncedComplete = false;
            String syncedHash = null;
            try (Cursor cc = db.rawQuery("SELECT synced_revision, synced_complete, synced_hash FROM cloud_collection_sync WHERE account_id = ? AND collection_kind = ?", new String[]{accountId, collectionKind})) {
                if (cc.moveToFirst()) {
                    syncedRevision = cc.getLong(0);
                    syncedComplete = cc.getInt(1) == 1;
                    syncedHash = cc.isNull(2) ? null : cc.getString(2);
                }
            }

            long analysisEpoch = 1;
            try (Cursor ca = db.rawQuery("SELECT analysis_epoch FROM cloud_account_state WHERE account_id = ?", new String[]{accountId})) {
                if (ca.moveToFirst()) analysisEpoch = ca.getLong(0);
            }

            if (activeGen == null || !activeComplete) {
                res.put("shouldUpload", false);
                res.put("reason", syncedComplete ? "LOCAL_INCOMPLETE_PROTECT_COMPLETE_CLOUD" : "LOCAL_COLLECTION_NOT_COMPLETE");
                res.put("collectionKind", collectionKind);
                res.put("complete", false);
                return res;
            }

            TreeSet<String> repoIdSet = new TreeSet<>();
            try (Cursor rc = db.rawQuery("SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id = ?",
                    new String[]{accountId, localKind, activeGen})) {
                while (rc.moveToNext()) {
                    try {
                        JSONObject repo = new JSONObject(rc.getString(0));
                        if (!"private".equals(repo.optString("visibility", "public")) && !repo.optBoolean("private", false)) {
                            String rid = repo.optString("repoId", "").trim();
                            if (!rid.isEmpty()) repoIdSet.add(rid);
                        }
                    } catch (Exception ignored) {}
                }
            }

            JSONArray repoIds = new JSONArray();
            for (String rid : repoIdSet) repoIds.put(rid);

            JSONObject hashPayload = new JSONObject();
            hashPayload.put("analysisEpoch", analysisEpoch);
            hashPayload.put("collectionKind", collectionKind);
            hashPayload.put("complete", true);
            hashPayload.put("repoIds", repoIds);
            String snapshotHash = sha256Hex(hashPayload.toString());

            if (syncedComplete && snapshotHash.equals(syncedHash)) {
                res.put("shouldUpload", false);
                res.put("reason", "UNCHANGED");
                res.put("collectionKind", collectionKind);
                res.put("complete", true);
                res.put("syncedRevision", syncedRevision);
                return res;
            }

            String operationId = "coll_" + collectionKind + "_" + accountId + "_r" + (syncedRevision + 1) + "_" + snapshotHash.substring(0, 12);
            res.put("shouldUpload", true);
            res.put("operationId", operationId);
            res.put("expectedRevision", syncedRevision);
            res.put("analysisEpoch", analysisEpoch);
            res.put("collectionKind", collectionKind);
            res.put("complete", true);
            res.put("observedAt", lastCompletedAt);
            res.put("repoIds", repoIds);
            res.put("snapshotHash", snapshotHash);
            return res;
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
    }

    public synchronized JSONObject markCollectionCloudSynced(String accountId, String collectionKind, long revision, boolean complete, String snapshotHash, String operationId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        long now = System.currentTimeMillis();
        ContentValues cv = new ContentValues();
        cv.put("account_id", accountId);
        cv.put("collection_kind", collectionKind);
        cv.put("synced_revision", revision);
        cv.put("synced_complete", complete ? 1 : 0);
        if (snapshotHash != null) cv.put("synced_hash", snapshotHash);
        cv.put("last_synced_at", now);
        if (operationId != null) cv.put("last_operation_id", operationId);
        db.insertWithOnConflict("cloud_collection_sync", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
        return readCloudSyncState(accountId);
    }

    public synchronized void forgetAccount(String accountId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.delete("accounts", "account_id = ?", new String[]{accountId});
    }

    public synchronized String readSetting(String key) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        Cursor c = db.rawQuery("SELECT value_json FROM app_settings WHERE setting_key = ?", new String[]{key});
        String val = null;
        if (c.moveToFirst()) val = c.getString(0);
        c.close();
        return val;
    }

    public synchronized void saveSetting(String key, String valueJson) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("setting_key", key);
        cv.put("value_json", valueJson);
        db.insertWithOnConflict("app_settings", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized JSONObject readFeed(String key) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        Cursor c = db.rawQuery("SELECT payload_json, fetched_at FROM feed_cache WHERE cache_key = ?", new String[]{key});
        JSONObject res = null;
        try {
            if (c.moveToFirst()) {
                res = new JSONObject();
                res.put("items", new JSONArray(c.getString(0)));
                res.put("fetchedAt", c.getLong(1));
                res.put("source", "cache");
            }
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            c.close();
        }
        return res;
    }

    public synchronized void saveFeed(String key, JSONArray items, long fetchedAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("cache_key", key);
        cv.put("payload_json", items.toString());
        cv.put("fetched_at", fetchedAt);
        db.insertWithOnConflict("feed_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized JSONObject createSnapshot(String accountId, String purpose, String reason) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            long now = System.currentTimeMillis();
            JSONObject revisions = getAccountRevisions(accountId);
            String inputId = "snap_" + now + "_" + UUID.randomUUID().toString().substring(0, 6);
            String safePurpose = (purpose != null && !purpose.isEmpty()) ? purpose : "ranking";

            try (Cursor actC = db.rawQuery("SELECT 1 FROM accounts WHERE account_id = ?", new String[]{accountId})) {
                if (actC.moveToFirst()) {
                    ContentValues snapCv = new ContentValues();
                    snapCv.put("input_id", inputId);
                    snapCv.put("account_id", accountId);
                    snapCv.put("purpose", safePurpose);
                    snapCv.put("input_versions_json", revisions.toString());
                    snapCv.put("created_at", now);
                    snapCv.put("consumed", 0);
                    db.insertWithOnConflict("recommendation_snapshots", null, snapCv, SQLiteDatabase.CONFLICT_REPLACE);
                }
            }

            JSONArray starred = new JSONArray();
            Cursor starSync = db.rawQuery("SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'stars'", new String[]{accountId});
            if (starSync.moveToFirst()) {
                String gen = starSync.getString(0);
                if (gen != null && !gen.isEmpty()) {
                    Cursor c = db.rawQuery("SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ?", new String[]{accountId, gen});
                    while (c.moveToNext()) starred.put(new JSONObject(c.getString(0)));
                    c.close();
                }
            }
            starSync.close();

            JSONArray owned = new JSONArray();
            Cursor repoSync = db.rawQuery("SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'repos'", new String[]{accountId});
            if (repoSync.moveToFirst()) {
                String gen = repoSync.getString(0);
                if (gen != null && !gen.isEmpty()) {
                    Cursor c = db.rawQuery("SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = 'repos' AND generation_id = ?", new String[]{accountId, gen});
                    while (c.moveToNext()) owned.put(new JSONObject(c.getString(0)));
                    c.close();
                }
            }
            repoSync.close();

            Cursor prefC = db.rawQuery("SELECT history_enabled, manual_tags_json FROM account_preferences WHERE account_id = ?", new String[]{accountId});
            boolean historyEnabled = true;
            JSONArray manualTags = new JSONArray();
            if (prefC.moveToFirst()) {
                historyEnabled = prefC.getInt(0) == 1;
                manualTags = new JSONArray(prefC.getString(1));
            }
            prefC.close();

            JSONArray history = new JSONArray();
            if (historyEnabled) {
                Cursor histC = db.rawQuery("SELECT * FROM browse_history WHERE account_id = ? ORDER BY last_viewed_at DESC LIMIT 5000", new String[]{accountId});
                while (histC.moveToNext()) {
                    JSONObject h = new JSONObject();
                    h.put("accountId", histC.getString(histC.getColumnIndexOrThrow("account_id")));
                    h.put("repoId", histC.getString(histC.getColumnIndexOrThrow("repo_id")));
                    h.put("repository", new JSONObject(histC.getString(histC.getColumnIndexOrThrow("repository_json"))));
                    h.put("visitCount", histC.getInt(histC.getColumnIndexOrThrow("visit_count")));
                    h.put("lastViewedAt", histC.getLong(histC.getColumnIndexOrThrow("last_viewed_at")));
                    h.put("lastSource", histC.getString(histC.getColumnIndexOrThrow("last_source")));
                    history.put(h);
                }
                histC.close();
            }

            JSONArray hiddenRepoIds = new JSONArray();
            Cursor hidC = db.rawQuery("SELECT repo_id FROM recommendation_feedback WHERE account_id = ? AND hidden = 1", new String[]{accountId});
            while (hidC.moveToNext()) hiddenRepoIds.put(hidC.getString(0));
            hidC.close();

            JSONArray candidates = new JSONArray();
            Map<String, JSONObject> candidateMap = new HashMap<>();
            Cursor discC = db.rawQuery("SELECT result_json FROM discovery_cache WHERE account_id = ? AND expires_at > ?", new String[]{accountId, String.valueOf(now)});
            while (discC.moveToNext()) {
                try {
                    JSONArray arr = new JSONArray(discC.getString(0));
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject it = arr.getJSONObject(i);
                        String k = it.optString("repoId", it.optString("canonicalKey", ""));
                        if (!k.isEmpty() && !candidateMap.containsKey(k)) {
                            candidateMap.put(k, it);
                            candidates.put(it);
                        }
                    }
                } catch (Exception ignored) {}
            }
            discC.close();

            res.put("inputId", inputId);
            res.put("inputVersions", revisions);
            res.put("accountId", accountId);
            res.put("purpose", safePurpose);
            res.put("reason", reason);
            res.put("starred", starred);
            res.put("owned", owned);
            res.put("history", history);
            res.put("manualTags", manualTags);
            res.put("hiddenRepoIds", hiddenRepoIds);
            res.put("historyEnabled", historyEnabled);
            res.put("candidates", candidates);

            db.setTransactionSuccessful();
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            db.endTransaction();
        }
        return res;
    }

    public synchronized JSONObject commitRecommendation(String accountId, String inputId, JSONObject inputVersions, String purpose, JSONObject profile, JSONObject batch) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            if (accountId == null || accountId.isEmpty() || inputId == null || inputId.isEmpty() || purpose == null || purpose.isEmpty()) {
                res.put("ok", false);
                res.put("error", "INPUT_CHANGED");
                db.setTransactionSuccessful();
                return res;
            }

            JSONObject currentRevisions = getAccountRevisions(accountId);
            JSONObject savedVersions = null;
            boolean snapFound = false;

            try (Cursor snapC = db.rawQuery("SELECT account_id, purpose, input_versions_json, consumed FROM recommendation_snapshots WHERE input_id = ?", new String[]{inputId})) {
                if (snapC.moveToFirst()) {
                    snapFound = true;
                    String snapAcc = snapC.getString(0);
                    String snapPurpose = snapC.getString(1);
                    String snapVerJson = snapC.getString(2);
                    int consumed = snapC.getInt(3);
                    if (!accountId.equals(snapAcc) || !purpose.equals(snapPurpose) || consumed == 1) {
                        res.put("ok", false);
                        res.put("error", "INPUT_CHANGED");
                        db.setTransactionSuccessful();
                        return res;
                    }
                    savedVersions = new JSONObject(snapVerJson);
                }
            }

            if (!snapFound) {
                try (Cursor anyC = db.rawQuery("SELECT 1 FROM recommendation_snapshots WHERE account_id = ? LIMIT 1", new String[]{accountId})) {
                    if (anyC.moveToFirst()) {
                        res.put("ok", false);
                        res.put("error", "INPUT_CHANGED");
                        db.setTransactionSuccessful();
                        return res;
                    }
                }
            }

            JSONObject baselineVersions = savedVersions != null ? savedVersions : inputVersions;
            if (baselineVersions == null || baselineVersions.length() == 0) {
                res.put("ok", false);
                res.put("error", "INPUT_CHANGED");
                db.setTransactionSuccessful();
                return res;
            }

            Iterator<String> curKeys = currentRevisions.keys();
            while (curKeys.hasNext()) {
                String k = curKeys.next();
                int curVal = currentRevisions.getInt(k);
                if (baselineVersions.has(k) && baselineVersions.getInt(k) != curVal) {
                    res.put("ok", false);
                    res.put("error", "INPUT_CHANGED");
                    db.setTransactionSuccessful();
                    return res;
                }
                if (inputVersions != null && inputVersions.has(k) && inputVersions.getInt(k) != curVal) {
                    res.put("ok", false);
                    res.put("error", "INPUT_CHANGED");
                    db.setTransactionSuccessful();
                    return res;
                }
            }

            long now = System.currentTimeMillis();
            if ("profile".equals(purpose) && profile != null) {
                ContentValues cv = new ContentValues();
                cv.put("account_id", accountId);
                cv.put("model_version", "content-v1");
                cv.put("input_versions_json", baselineVersions.toString());
                cv.put("profile_json", profile.toString());
                cv.put("generated_at", now);
                db.insertWithOnConflict("interest_profiles", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            } else if ("ranking".equals(purpose) && batch != null) {
                db.delete("recommendation_batches", "account_id = ?", new String[]{accountId});

                ContentValues bCv = new ContentValues();
                String batchId = batch.getString("batchId");
                bCv.put("batch_id", batchId);
                bCv.put("account_id", accountId);
                bCv.put("model_version", "content-v1");
                bCv.put("input_versions_json", baselineVersions.toString());
                bCv.put("created_at", batch.optLong("createdAt", now));
                bCv.put("expires_at", batch.optLong("expiresAt", now + 86400000L));
                db.insertOrThrow("recommendation_batches", null, bCv);

                JSONArray items = batch.optJSONArray("items");
                if (items != null) {
                    for (int i = 0; i < items.length(); i++) {
                        JSONObject it = items.getJSONObject(i);
                        JSONObject repoObj = it.optJSONObject("repository");
                        if (repoObj == null) continue;
                        String repoKey = it.optString("repoId", repoObj.optString("repoId", repoObj.optString("canonicalKey", "")));
                        if (repoKey.isEmpty()) continue;

                        ContentValues itCv = new ContentValues();
                        itCv.put("batch_id", batchId);
                        itCv.put("position", it.getInt("position"));
                        itCv.put("repo_id", repoKey);
                        itCv.put("score", it.getDouble("score"));
                        itCv.put("reasons_json", it.optJSONArray("reasons") != null ? it.optJSONArray("reasons").toString() : "[]");
                        itCv.put("repository_json", repoObj.toString());
                        db.insertWithOnConflict("recommendation_items", null, itCv, SQLiteDatabase.CONFLICT_REPLACE);
                    }
                }
            } else {
                res.put("ok", false);
                res.put("error", "INVALID_COMMIT_PAYLOAD");
                db.setTransactionSuccessful();
                return res;
            }

            if (snapFound) {
                ContentValues consumedCv = new ContentValues();
                consumedCv.put("consumed", 1);
                db.update("recommendation_snapshots", consumedCv, "input_id = ?", new String[]{inputId});
            }

            db.setTransactionSuccessful();
            res.put("ok", true);
            res.put("committed", true);
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        } finally {
            db.endTransaction();
        }
        return res;
    }

    public synchronized JSONObject listRecommendation(String accountId, String batchId, int offset, int limit) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        try {
            String activeBatchId = batchId;
            if (activeBatchId == null || activeBatchId.isEmpty()) {
                Cursor c = db.rawQuery("SELECT batch_id FROM recommendation_batches WHERE account_id = ? ORDER BY created_at DESC LIMIT 1", new String[]{accountId});
                if (c.moveToFirst()) activeBatchId = c.getString(0);
                c.close();
            }

            if (activeBatchId == null || activeBatchId.isEmpty()) {
                res.put("items", new JSONArray());
                res.put("total", 0);
                res.put("nextOffset", JSONObject.NULL);
                res.put("batchId", JSONObject.NULL);
                return res;
            }

            Cursor cntC = db.rawQuery("SELECT COUNT(*) FROM recommendation_items WHERE batch_id = ?", new String[]{activeBatchId});
            int total = 0;
            if (cntC.moveToFirst()) total = cntC.getInt(0);
            cntC.close();

            Cursor c = db.rawQuery("SELECT position, repo_id, score, reasons_json, repository_json FROM recommendation_items WHERE batch_id = ? ORDER BY position ASC LIMIT ? OFFSET ?",
                    new String[]{activeBatchId, String.valueOf(limit), String.valueOf(offset)});
            JSONArray items = new JSONArray();
            while (c.moveToNext()) {
                JSONObject it = new JSONObject();
                it.put("position", c.getInt(0));
                it.put("repoId", c.getString(1));
                it.put("score", c.getDouble(2));
                it.put("reasons", new JSONArray(c.getString(3)));
                it.put("repository", new JSONObject(c.getString(4)));
                items.put(it);
            }
            c.close();

            res.put("items", items);
            res.put("total", total);
            res.put("nextOffset", offset + items.length() < total ? (offset + items.length()) : JSONObject.NULL);
            res.put("batchId", activeBatchId);
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    public synchronized void recordRecommendationFeedback(String accountId, String repoId, String kind, String eventId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues cv = new ContentValues();
            cv.put("account_id", accountId);
            cv.put("repo_id", repoId);
            cv.put("hidden", "hide".equals(kind) ? 1 : 0);
            cv.put("event_id", eventId);
            cv.put("updated_at", System.currentTimeMillis());
            db.insertWithOnConflict("recommendation_feedback", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            bumpRevision(db, accountId, "feedback_revision");
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized void saveDiscoveryCache(String accountId, String queryKey, String queryJson, String resultJson, long fetchedAt, long expiresAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            ContentValues cv = new ContentValues();
            cv.put("account_id", accountId);
            cv.put("query_key", queryKey);
            cv.put("query_json", queryJson);
            cv.put("result_json", resultJson);
            cv.put("fetched_at", fetchedAt);
            cv.put("expires_at", expiresAt);
            db.insertWithOnConflict("discovery_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            bumpRevision(db, accountId, "discovery_revision");
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized JSONObject readDiscoveryCache(String accountId, String queryKey) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = null;
        try {
            Cursor c = db.rawQuery("SELECT result_json, fetched_at FROM discovery_cache WHERE account_id = ? AND query_key = ? AND expires_at > ?",
                    new String[]{accountId, queryKey, String.valueOf(System.currentTimeMillis())});
            if (c.moveToFirst()) {
                res = new JSONObject();
                res.put("items", new JSONArray(c.getString(0)));
                res.put("fetchedAt", c.getLong(1));
            }
            c.close();
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    public synchronized void saveWebsiteOperation(JSONObject op) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("operation_id", op.optString("operationId"));
        cv.put("account_id", op.optString("accountId"));
        cv.put("repo_id", op.optString("repoId"));
        cv.put("intent_id", op.optString("intentId"));
        cv.put("desired_starred", op.optBoolean("desiredStarred") ? 1 : 0);
        cv.put("state", op.optString("state"));
        if (op.has("attemptedAt") && !op.isNull("attemptedAt")) cv.put("attempted_at", op.optLong("attemptedAt"));
        if (op.has("confirmedAt") && !op.isNull("confirmedAt")) cv.put("confirmed_at", op.optLong("confirmedAt"));
        if (op.has("errorCode") && !op.isNull("errorCode")) cv.put("error_code", op.optString("errorCode"));
        db.insertWithOnConflict("website_operations", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public synchronized JSONObject getWebsiteOperation(String accountId, String intentId) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = null;
        try {
            Cursor c = db.rawQuery("SELECT * FROM website_operations WHERE account_id = ? AND intent_id = ?", new String[]{accountId, intentId});
            if (c.moveToFirst()) {
                res = new JSONObject();
                res.put("operationId", c.getString(c.getColumnIndexOrThrow("operation_id")));
                res.put("accountId", c.getString(c.getColumnIndexOrThrow("account_id")));
                res.put("repoId", c.getString(c.getColumnIndexOrThrow("repo_id")));
                res.put("intentId", c.getString(c.getColumnIndexOrThrow("intent_id")));
                res.put("desiredStarred", c.getInt(c.getColumnIndexOrThrow("desired_starred")) == 1);
                res.put("state", c.getString(c.getColumnIndexOrThrow("state")));
                res.put("attemptedAt", c.isNull(c.getColumnIndexOrThrow("attempted_at")) ? JSONObject.NULL : c.getLong(c.getColumnIndexOrThrow("attempted_at")));
                res.put("confirmedAt", c.isNull(c.getColumnIndexOrThrow("confirmed_at")) ? JSONObject.NULL : c.getLong(c.getColumnIndexOrThrow("confirmed_at")));
                res.put("errorCode", c.isNull(c.getColumnIndexOrThrow("error_code")) ? JSONObject.NULL : c.getString(c.getColumnIndexOrThrow("error_code")));
            }
            c.close();
        } catch (Exception e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        return res;
    }

    public synchronized void updateWebsiteOperation(String operationId, String state, Long attemptedAt, Long confirmedAt, String errorCode) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("state", state);
        if (attemptedAt != null) cv.put("attempted_at", attemptedAt);
        if (confirmedAt != null) cv.put("confirmed_at", confirmedAt);
        if (errorCode != null) cv.put("error_code", errorCode);
        db.update("website_operations", cv, "operation_id = ?", new String[]{operationId});
    }
}
