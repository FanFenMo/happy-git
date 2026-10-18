package com.happygit.app.nativebridge;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

public class HappyGitDbHelper extends SQLiteOpenHelper {

    private static final String DATABASE_NAME = "happygit.db";
    private static final int DATABASE_VERSION = 1;

    public HappyGitDbHelper(Context context) {
        super(context, DATABASE_NAME, null, DATABASE_VERSION);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS accounts (" +
                "account_id TEXT PRIMARY KEY NOT NULL, " +
                "login TEXT NOT NULL, " +
                "profile_json TEXT NOT NULL, " +
                "profile_synced_at INTEGER NOT NULL);");

        db.execSQL("CREATE TABLE IF NOT EXISTS account_preferences (" +
                "account_id TEXT PRIMARY KEY NOT NULL, " +
                "history_enabled INTEGER NOT NULL DEFAULT 1, " +
                "manual_tags_json TEXT NOT NULL DEFAULT '[]', " +
                "updated_at INTEGER NOT NULL, " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS browse_history (" +
                "account_id TEXT NOT NULL, " +
                "repo_id TEXT NOT NULL, " +
                "full_name TEXT NOT NULL, " +
                "description TEXT, " +
                "repository_json TEXT NOT NULL, " +
                "first_viewed_at INTEGER NOT NULL, " +
                "last_viewed_at INTEGER NOT NULL, " +
                "last_counted_at INTEGER NOT NULL, " +
                "visit_count INTEGER NOT NULL DEFAULT 1, " +
                "last_source TEXT NOT NULL, " +
                "PRIMARY KEY (account_id, repo_id), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE INDEX IF NOT EXISTS idx_history_account_time " +
                "ON browse_history(account_id, last_viewed_at DESC, repo_id DESC);");

        db.execSQL("CREATE TABLE IF NOT EXISTS repository_cache (" +
                "account_id TEXT NOT NULL, " +
                "kind TEXT NOT NULL, " +
                "generation_id TEXT NOT NULL, " +
                "repo_id TEXT NOT NULL, " +
                "sort_time INTEGER NOT NULL, " +
                "repository_json TEXT NOT NULL, " +
                "PRIMARY KEY (account_id, kind, generation_id, repo_id), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE INDEX IF NOT EXISTS idx_repository_collection " +
                "ON repository_cache(account_id, kind, generation_id, sort_time DESC, repo_id DESC);");

        db.execSQL("CREATE TABLE IF NOT EXISTS sync_state (" +
                "account_id TEXT NOT NULL, " +
                "kind TEXT NOT NULL, " +
                "active_generation TEXT, " +
                "active_complete INTEGER NOT NULL DEFAULT 0, " +
                "active_count INTEGER NOT NULL DEFAULT 0, " +
                "staging_generation TEXT, " +
                "staging_next_page INTEGER, " +
                "staging_count INTEGER NOT NULL DEFAULT 0, " +
                "last_completed_at INTEGER, " +
                "last_error_code TEXT, " +
                "retry_at INTEGER, " +
                "PRIMARY KEY (account_id, kind), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS app_settings (" +
                "setting_key TEXT PRIMARY KEY NOT NULL, " +
                "value_json TEXT NOT NULL);");

        db.execSQL("CREATE TABLE IF NOT EXISTS feed_cache (" +
                "cache_key TEXT PRIMARY KEY NOT NULL, " +
                "payload_json TEXT NOT NULL, " +
                "fetched_at INTEGER NOT NULL);");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // 初始版本为 1，未来增量迁移在此逐版本实现
    }
}
