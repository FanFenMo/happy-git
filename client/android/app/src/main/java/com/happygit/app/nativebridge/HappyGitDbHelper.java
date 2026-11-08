package com.happygit.app.nativebridge;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.HashSet;
import java.util.Set;

public class HappyGitDbHelper extends SQLiteOpenHelper {

    private static final String DATABASE_NAME = "happygit.db";
    private static final int DATABASE_VERSION = 2;

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
        // v1 tables
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
                "staging_next_url TEXT, " +
                "staging_page_seq INTEGER NOT NULL DEFAULT 0, " +
                "staging_star_revision INTEGER NOT NULL DEFAULT 0, " +
                "PRIMARY KEY (account_id, kind), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS app_settings (" +
                "setting_key TEXT PRIMARY KEY NOT NULL, " +
                "value_json TEXT NOT NULL);");

        db.execSQL("CREATE TABLE IF NOT EXISTS feed_cache (" +
                "cache_key TEXT PRIMARY KEY NOT NULL, " +
                "payload_json TEXT NOT NULL, " +
                "fetched_at INTEGER NOT NULL);");

        // v2 tables
        createV2Tables(db);
    }

    public void createV2Tables(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS account_revisions (" +
                "account_id TEXT PRIMARY KEY NOT NULL, " +
                "profile_revision INTEGER NOT NULL DEFAULT 0, " +
                "collection_revision INTEGER NOT NULL DEFAULT 0, " +
                "history_revision INTEGER NOT NULL DEFAULT 0, " +
                "preference_revision INTEGER NOT NULL DEFAULT 0, " +
                "feedback_revision INTEGER NOT NULL DEFAULT 0, " +
                "discovery_revision INTEGER NOT NULL DEFAULT 0, " +
                "star_mutation_revision INTEGER NOT NULL DEFAULT 0, " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS repository_catalog (" +
                "repo_id TEXT PRIMARY KEY NOT NULL, " +
                "canonical_key TEXT NOT NULL UNIQUE, " +
                "full_name TEXT NOT NULL, " +
                "repository_json TEXT NOT NULL, " +
                "feature_json TEXT, " +
                "feature_version TEXT, " +
                "fetched_at INTEGER NOT NULL, " +
                "previous_star_count INTEGER, " +
                "previous_observed_at INTEGER);");

        db.execSQL("CREATE TABLE IF NOT EXISTS repository_aliases (" +
                "canonical_key TEXT PRIMARY KEY NOT NULL, " +
                "repo_id TEXT NOT NULL, " +
                "FOREIGN KEY (repo_id) REFERENCES repository_catalog(repo_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS star_state (" +
                "account_id TEXT NOT NULL, " +
                "repo_id TEXT NOT NULL, " +
                "starred INTEGER NOT NULL CHECK (starred IN (0, 1)), " +
                "observed_at INTEGER NOT NULL, " +
                "mutation_revision INTEGER NOT NULL, " +
                "PRIMARY KEY (account_id, repo_id), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS website_operations (" +
                "operation_id TEXT PRIMARY KEY NOT NULL, " +
                "account_id TEXT NOT NULL, " +
                "repo_id TEXT NOT NULL, " +
                "intent_id TEXT NOT NULL, " +
                "desired_starred INTEGER NOT NULL CHECK (desired_starred IN (0, 1)), " +
                "state TEXT NOT NULL, " +
                "attempted_at INTEGER, " +
                "confirmed_at INTEGER, " +
                "error_code TEXT, " +
                "UNIQUE (account_id, intent_id), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS interest_profiles (" +
                "account_id TEXT PRIMARY KEY NOT NULL, " +
                "model_version TEXT NOT NULL, " +
                "input_versions_json TEXT NOT NULL, " +
                "profile_json TEXT NOT NULL, " +
                "generated_at INTEGER NOT NULL, " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS recommendation_feedback (" +
                "account_id TEXT NOT NULL, " +
                "repo_id TEXT NOT NULL, " +
                "hidden INTEGER NOT NULL DEFAULT 0, " +
                "event_id TEXT NOT NULL, " +
                "updated_at INTEGER NOT NULL, " +
                "PRIMARY KEY (account_id, repo_id), " +
                "UNIQUE (account_id, event_id), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS discovery_cache (" +
                "account_id TEXT NOT NULL, " +
                "query_key TEXT NOT NULL, " +
                "query_json TEXT NOT NULL, " +
                "result_json TEXT NOT NULL, " +
                "fetched_at INTEGER NOT NULL, " +
                "expires_at INTEGER NOT NULL, " +
                "PRIMARY KEY (account_id, query_key), " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS recommendation_batches (" +
                "batch_id TEXT PRIMARY KEY NOT NULL, " +
                "account_id TEXT NOT NULL, " +
                "model_version TEXT NOT NULL, " +
                "input_versions_json TEXT NOT NULL, " +
                "created_at INTEGER NOT NULL, " +
                "expires_at INTEGER NOT NULL, " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS recommendation_items (" +
                "batch_id TEXT NOT NULL, " +
                "position INTEGER NOT NULL, " +
                "repo_id TEXT NOT NULL, " +
                "score REAL NOT NULL, " +
                "reasons_json TEXT NOT NULL, " +
                "repository_json TEXT NOT NULL, " +
                "PRIMARY KEY (batch_id, position), " +
                "UNIQUE (batch_id, repo_id), " +
                "FOREIGN KEY (batch_id) REFERENCES recommendation_batches(batch_id) ON DELETE CASCADE);");

        db.execSQL("CREATE TABLE IF NOT EXISTS recommendation_snapshots (" +
                "input_id TEXT PRIMARY KEY NOT NULL, " +
                "account_id TEXT NOT NULL, " +
                "purpose TEXT NOT NULL, " +
                "input_versions_json TEXT NOT NULL, " +
                "created_at INTEGER NOT NULL, " +
                "consumed INTEGER NOT NULL DEFAULT 0, " +
                "FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE);");

        db.execSQL("CREATE INDEX IF NOT EXISTS idx_website_operations_account_state " +
                "ON website_operations(account_id, state);");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_recommendation_batches_account_time " +
                "ON recommendation_batches(account_id, created_at DESC);");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_account " +
                "ON recommendation_snapshots(account_id, created_at DESC);");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            upgradeToVersion2(db);
        }
    }

    private void upgradeToVersion2(SQLiteDatabase db) {
        Set<String> columns = new HashSet<>();
        try (Cursor cursor = db.rawQuery("PRAGMA table_info(sync_state);", null)) {
            while (cursor.moveToNext()) {
                columns.add(cursor.getString(cursor.getColumnIndexOrThrow("name")));
            }
        }
        if (!columns.contains("staging_next_url")) {
            db.execSQL("ALTER TABLE sync_state ADD COLUMN staging_next_url TEXT;");
        }
        if (!columns.contains("staging_page_seq")) {
            db.execSQL("ALTER TABLE sync_state ADD COLUMN staging_page_seq INTEGER NOT NULL DEFAULT 0;");
        }
        if (!columns.contains("staging_star_revision")) {
            db.execSQL("ALTER TABLE sync_state ADD COLUMN staging_star_revision INTEGER NOT NULL DEFAULT 0;");
        }

        createV2Tables(db);
        db.execSQL("INSERT OR IGNORE INTO account_revisions (account_id) SELECT account_id FROM accounts;");
    }
}
