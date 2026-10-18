package com.happygit.app.nativebridge;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class LocalRepository {

    private final HappyGitDbHelper dbHelper;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    public LocalRepository(Context context) {
        this.dbHelper = new HappyGitDbHelper(context);
    }

    public <T> Future<T> executeAsync(Callable<T> task) {
        return executor.submit(task);
    }

    public void saveProfile(String accountId, JSONObject profile) {
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
            db.insertWithOnConflict("accounts", null, cv, SQLiteDatabase.CONFLICT_REPLACE);

            ContentValues prefCv = new ContentValues();
            prefCv.put("account_id", accountId);
            prefCv.put("history_enabled", 1);
            prefCv.put("manual_tags_json", "[]");
            prefCv.put("updated_at", now);
            db.insertWithOnConflict("account_preferences", null, prefCv, SQLiteDatabase.CONFLICT_IGNORE);

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public JSONObject readAccountSnapshot(String accountId) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject result = new JSONObject();
        try {
            // Profile
            Cursor cProfile = db.rawQuery("SELECT profile_json FROM accounts WHERE account_id = ?", new String[]{accountId});
            if (cProfile.moveToFirst()) {
                result.put("profile", new JSONObject(cProfile.getString(0)));
            } else {
                result.put("profile", JSONObject.NULL);
            }
            cProfile.close();

            // Preferences
            Cursor cPref = db.rawQuery("SELECT history_enabled, manual_tags_json FROM account_preferences WHERE account_id = ?", new String[]{accountId});
            JSONObject prefObj = new JSONObject();
            if (cPref.moveToFirst()) {
                prefObj.put("historyEnabled", cPref.getInt(0) == 1);
                prefObj.put("manualTags", new JSONArray(cPref.getString(1)));
            } else {
                prefObj.put("historyEnabled", true);
                prefObj.put("manualTags", new JSONArray());
            }
            cPref.close();
            result.put("preferences", prefObj);

            // Sync states
            result.put("repoSync", getSyncState(db, accountId, "repos"));
            result.put("starSync", getSyncState(db, accountId, "stars"));
        } catch (Exception e) {
            e.printStackTrace();
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
            e.printStackTrace();
        }
        return obj;
    }

    public void savePreferences(String accountId, JSONObject preferences) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("account_id", accountId);
        cv.put("history_enabled", preferences.optBoolean("historyEnabled", true) ? 1 : 0);
        cv.put("manual_tags_json", preferences.optJSONArray("manualTags") != null ? preferences.optJSONArray("manualTags").toString() : "[]");
        cv.put("updated_at", System.currentTimeMillis());
        db.insertWithOnConflict("account_preferences", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public String beginSync(String accountId, String kind) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        String generationId = "gen_" + System.currentTimeMillis() + "_" + UUID.randomUUID().toString().substring(0, 6);
        db.beginTransaction();
        try {
            db.delete("repository_cache", "account_id = ? AND kind = ? AND generation_id LIKE 'gen_%'", new String[]{accountId, kind});

            ContentValues cv = new ContentValues();
            cv.put("account_id", accountId);
            cv.put("kind", kind);
            cv.put("staging_generation", generationId);
            cv.put("staging_next_page", 1);
            cv.put("staging_count", 0);
            db.insertWithOnConflict("sync_state", null, cv, SQLiteDatabase.CONFLICT_REPLACE);

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return generationId;
    }

    public JSONObject writeSyncPage(String accountId, String kind, String generationId, int page, JSONArray items, Integer nextPage) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.getJSONObject(i);
                String repoId = item.getString("repoId");
                long sortTime = item.optLong("starredAt", item.optLong("updatedAt", item.optLong("createdAt", System.currentTimeMillis())));

                ContentValues cv = new ContentValues();
                cv.put("account_id", accountId);
                cv.put("kind", kind);
                cv.put("generation_id", generationId);
                cv.put("repo_id", repoId);
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
            if (nextPage != null) upd.put("staging_next_page", nextPage);
            else upd.putNull("staging_next_page");
            db.update("sync_state", upd, "account_id = ? AND kind = ?", new String[]{accountId, kind});

            db.setTransactionSuccessful();

            res.put("kind", kind);
            res.put("loadedCount", count);
            res.put("nextPage", nextPage != null ? nextPage : JSONObject.NULL);
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            db.endTransaction();
        }
        return res;
    }

    public JSONObject finishSync(String accountId, String kind, String generationId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
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
            upd.put("staging_count", 0);
            upd.put("last_completed_at", now);
            upd.putNull("last_error_code");
            upd.putNull("retry_at");
            db.update("sync_state", upd, "account_id = ? AND kind = ?", new String[]{accountId, kind});

            db.setTransactionSuccessful();

            res.put("kind", kind);
            res.put("count", count);
            res.put("complete", true);
            res.put("syncedAt", now);
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            db.endTransaction();
        }
        return res;
    }

    public void abortSync(String accountId, String kind, String generationId, String errorCode, Long retryAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            db.delete("repository_cache", "account_id = ? AND kind = ? AND generation_id = ?", new String[]{accountId, kind, generationId});

            ContentValues upd = new ContentValues();
            upd.putNull("staging_generation");
            upd.putNull("staging_next_page");
            upd.put("staging_count", 0);
            if (errorCode != null) upd.put("last_error_code", errorCode);
            if (retryAt != null) upd.put("retry_at", retryAt);
            db.update("sync_state", upd, "account_id = ? AND kind = ?", new String[]{accountId, kind});

            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public JSONObject listRepositories(String accountId, String kind, int offset, int limit) {
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
            res.put("nextOffset", items.length() == limit ? (offset + limit) : JSONObject.NULL);
        } catch (Exception e) {
            e.printStackTrace();
        }
        return res;
    }

    public void applyConfirmedStar(String accountId, JSONObject repository, boolean starred) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.beginTransaction();
        try {
            String repoId = repository.getString("repoId");
            Cursor c = db.rawQuery("SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'stars'", new String[]{accountId});
            String activeGen = "active_stars_local";
            if (c.moveToFirst()) {
                String existing = c.getString(0);
                if (existing != null && !existing.isEmpty()) activeGen = existing;
            }
            c.close();

            if (starred) {
                ContentValues cv = new ContentValues();
                cv.put("account_id", accountId);
                cv.put("kind", "stars");
                cv.put("generation_id", activeGen);
                cv.put("repo_id", repoId);
                cv.put("sort_time", System.currentTimeMillis());
                cv.put("repository_json", repository.toString());
                db.insertWithOnConflict("repository_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            } else {
                db.delete("repository_cache", "account_id = ? AND kind = 'stars' AND generation_id = ? AND repo_id = ?",
                        new String[]{accountId, activeGen, repoId});
            }

            Cursor cntC = db.rawQuery("SELECT COUNT(*) FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ?",
                    new String[]{accountId, activeGen});
            int cnt = 0;
            if (cntC.moveToFirst()) cnt = cntC.getInt(0);
            cntC.close();

            ContentValues upd = new ContentValues();
            upd.put("active_count", cnt);
            db.update("sync_state", upd, "account_id = ? AND kind = 'stars'", new String[]{accountId});

            db.setTransactionSuccessful();
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            db.endTransaction();
        }
    }

    public JSONObject isRepositoryStarred(String accountId, String repoId) {
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
            e.printStackTrace();
        }
        return res;
    }

    public JSONObject recordBrowse(String accountId, JSONObject repository, String source, long viewedAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        JSONObject res = new JSONObject();
        db.beginTransaction();
        try {
            String repoId = repository.getString("repoId");
            String fullName = repository.getString("fullName");
            String desc = repository.optString("description", null);

            Cursor c = db.rawQuery("SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?", new String[]{accountId, repoId});
            if (!c.moveToFirst()) {
                ContentValues cv = new ContentValues();
                cv.put("account_id", accountId);
                cv.put("repo_id", repoId);
                cv.put("full_name", fullName);
                cv.put("description", desc);
                cv.put("repository_json", repository.toString());
                cv.put("first_viewed_at", viewedAt);
                cv.put("last_viewed_at", viewedAt);
                cv.put("last_counted_at", viewedAt);
                cv.put("visit_count", 1);
                cv.put("last_source", source);
                db.insert("browse_history", null, cv);
            } else {
                long lastViewed = c.getLong(c.getColumnIndexOrThrow("last_viewed_at"));
                long lastCounted = c.getLong(c.getColumnIndexOrThrow("last_counted_at"));
                int visitCount = c.getInt(c.getColumnIndexOrThrow("visit_count"));

                long nextViewedAt = Math.max(lastViewed, viewedAt);
                boolean shouldCount = (viewedAt - lastCounted) >= 30000;
                int nextCount = shouldCount ? (visitCount + 1) : visitCount;
                long nextCountedAt = shouldCount ? viewedAt : lastCounted;

                ContentValues cv = new ContentValues();
                cv.put("full_name", fullName);
                cv.put("description", desc);
                cv.put("repository_json", repository.toString());
                cv.put("last_viewed_at", nextViewedAt);
                cv.put("last_counted_at", nextCountedAt);
                cv.put("visit_count", nextCount);
                cv.put("last_source", source);
                db.update("browse_history", cv, "account_id = ? AND repo_id = ?", new String[]{accountId, repoId});
            }
            c.close();

            pruneHistory(db, accountId, viewedAt);

            Cursor finalC = db.rawQuery("SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?", new String[]{accountId, repoId});
            if (finalC.moveToFirst()) {
                res.put("accountId", finalC.getString(finalC.getColumnIndexOrThrow("account_id")));
                res.put("repoId", finalC.getString(finalC.getColumnIndexOrThrow("repo_id")));
                res.put("repository", new JSONObject(finalC.getString(finalC.getColumnIndexOrThrow("repository_json"))));
                res.put("firstViewedAt", finalC.getLong(finalC.getColumnIndexOrThrow("first_viewed_at")));
                res.put("lastViewedAt", finalC.getLong(finalC.getColumnIndexOrThrow("last_viewed_at")));
                res.put("lastCountedAt", finalC.getLong(finalC.getColumnIndexOrThrow("last_counted_at")));
                res.put("visitCount", finalC.getInt(finalC.getColumnIndexOrThrow("visit_count")));
                res.put("lastSource", finalC.getString(finalC.getColumnIndexOrThrow("last_source")));
            }
            finalC.close();

            db.setTransactionSuccessful();
        } catch (Exception e) {
            e.printStackTrace();
        } finally {
            db.endTransaction();
        }
        return res;
    }

    private void pruneHistory(SQLiteDatabase db, String accountId, long now) {
        long ninetyDays = now - (90L * 24 * 60 * 60 * 1000);
        db.delete("browse_history", "account_id = ? AND last_viewed_at < ?", new String[]{accountId, String.valueOf(ninetyDays)});

        Cursor c = db.rawQuery("SELECT COUNT(*) FROM browse_history WHERE account_id = ?", new String[]{accountId});
        int total = 0;
        if (c.moveToFirst()) total = c.getInt(0);
        c.close();

        if (total > 5000) {
            db.execSQL(
                    "DELETE FROM browse_history WHERE account_id = '" + accountId + "' AND repo_id NOT IN (" +
                            "SELECT repo_id FROM browse_history WHERE account_id = '" + accountId + "' " +
                            "ORDER BY last_viewed_at DESC, repo_id DESC LIMIT 5000);"
            );
        }
    }

    public JSONObject listHistory(String accountId, JSONObject cursor, int limit, String keyword) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        JSONObject res = new JSONObject();
        try {
            StringBuilder query = new StringBuilder("SELECT * FROM browse_history WHERE account_id = ?");
            List<String> params = new ArrayList<>();
            params.add(accountId);

            if (keyword != null && !keyword.trim().isEmpty()) {
                query.append(" AND (full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
                String kw = "%" + keyword.trim().replace("%", "\\%").replace("_", "\\_") + "%";
                params.add(kw);
                params.add(kw);
            }

            if (cursor != null && cursor.has("lastViewedAt") && !cursor.isNull("lastViewedAt")) {
                query.append(" AND (last_viewed_at < ? OR (last_viewed_at = ? AND repo_id < ?))");
                params.add(String.valueOf(cursor.getLong("lastViewedAt")));
                params.add(String.valueOf(cursor.getLong("lastViewedAt")));
                params.add(cursor.getString("repoId"));
            }

            query.append(" ORDER BY last_viewed_at DESC, repo_id DESC LIMIT ?");
            params.add(String.valueOf(Math.min(limit, 100)));

            Cursor c = db.rawQuery(query.toString(), params.toArray(new String[0]));
            JSONArray items = new JSONArray();
            while (c.moveToNext()) {
                JSONObject entry = new JSONObject();
                entry.put("accountId", c.getString(c.getColumnIndexOrThrow("account_id")));
                entry.put("repoId", c.getString(c.getColumnIndexOrThrow("repo_id")));
                entry.put("repository", new JSONObject(c.getString(c.getColumnIndexOrThrow("repository_json"))));
                entry.put("firstViewedAt", c.getLong(c.getColumnIndexOrThrow("first_viewed_at")));
                entry.put("lastViewedAt", c.getLong(c.getColumnIndexOrThrow("last_viewed_at")));
                entry.put("lastCountedAt", c.getLong(c.getColumnIndexOrThrow("last_counted_at")));
                entry.put("visitCount", c.getInt(c.getColumnIndexOrThrow("visit_count")));
                entry.put("lastSource", c.getString(c.getColumnIndexOrThrow("last_source")));
                items.put(entry);
            }
            c.close();

            JSONObject nextCursor = null;
            if (items.length() == limit) {
                JSONObject last = items.getJSONObject(items.length() - 1);
                nextCursor = new JSONObject();
                nextCursor.put("lastViewedAt", last.getLong("lastViewedAt"));
                nextCursor.put("repoId", last.getString("repoId"));
            }

            // count total
            StringBuilder countSql = new StringBuilder("SELECT COUNT(*) FROM browse_history WHERE account_id = ?");
            List<String> countParams = new ArrayList<>();
            countParams.add(accountId);
            if (keyword != null && !keyword.trim().isEmpty()) {
                countSql.append(" AND (full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
                String kw = "%" + keyword.trim().replace("%", "\\%").replace("_", "\\_") + "%";
                countParams.add(kw);
                countParams.add(kw);
            }
            Cursor cntC = db.rawQuery(countSql.toString(), countParams.toArray(new String[0]));
            int total = 0;
            if (cntC.moveToFirst()) total = cntC.getInt(0);
            cntC.close();

            res.put("items", items);
            res.put("nextCursor", nextCursor != null ? nextCursor : JSONObject.NULL);
            res.put("total", total);
        } catch (Exception e) {
            e.printStackTrace();
        }
        return res;
    }

    public void deleteHistory(String accountId, String repoId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.delete("browse_history", "account_id = ? AND repo_id = ?", new String[]{accountId, repoId});
    }

    public void clearHistory(String accountId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.delete("browse_history", "account_id = ?", new String[]{accountId});
    }

    public int countHistory(String accountId) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        Cursor c = db.rawQuery("SELECT COUNT(*) FROM browse_history WHERE account_id = ?", new String[]{accountId});
        int count = 0;
        if (c.moveToFirst()) count = c.getInt(0);
        c.close();
        return count;
    }

    public void forgetAccount(String accountId) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        db.delete("accounts", "account_id = ?", new String[]{accountId});
    }

    public String readSetting(String key) {
        SQLiteDatabase db = dbHelper.getReadableDatabase();
        Cursor c = db.rawQuery("SELECT value_json FROM app_settings WHERE setting_key = ?", new String[]{key});
        String val = null;
        if (c.moveToFirst()) val = c.getString(0);
        c.close();
        return val;
    }

    public void saveSetting(String key, String valueJson) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("setting_key", key);
        cv.put("value_json", valueJson);
        db.insertWithOnConflict("app_settings", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public JSONObject readFeed(String key) {
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
            e.printStackTrace();
        } finally {
            c.close();
        }
        return res;
    }

    public void saveFeed(String key, JSONArray items, long fetchedAt) {
        SQLiteDatabase db = dbHelper.getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("cache_key", key);
        cv.put("payload_json", items.toString());
        cv.put("fetched_at", fetchedAt);
        db.insertWithOnConflict("feed_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }
}
