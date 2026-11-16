/**
 * database-worker.cjs
 * 运行在 Node worker_threads 中，持有唯一 DatabaseSync 连接
 * 执行 SQLite 建表、v2/v3 增量迁移与领域操作 (依据 project.md 第八节、第九节及阶段二云端协同契约)
 */
const { parentPort } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const crypto = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')

let db = null

function computeOpenPayloadHash(eventId, streamEpoch, deviceSeq, analysisEpoch, repoId, occurredAt, source = 'browse') {
  const tuple = [
    '1.0.0',
    String(eventId),
    Number(streamEpoch),
    Number(deviceSeq),
    Number(analysisEpoch),
    String(repoId),
    Number(occurredAt),
    String(source)
  ]
  return crypto.createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')
}

function computeDiscardPayloadHash(eventId, streamEpoch, deviceSeq, analysisEpoch) {
  const tuple = [
    '1.0.0',
    String(eventId),
    Number(streamEpoch),
    Number(deviceSeq),
    Number(analysisEpoch),
    'discard'
  ]
  return crypto.createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')
}

function openDatabase(dbPath) {
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = FULL;')
  db.exec('PRAGMA busy_timeout = 5000;')

  initOrMigrateDatabase()

  db.exec(`DELETE FROM repository_cache WHERE NOT EXISTS (
    SELECT 1 FROM sync_state s WHERE s.account_id = repository_cache.account_id
    AND s.kind = repository_cache.kind AND s.active_generation = repository_cache.generation_id);
    UPDATE sync_state SET staging_generation = NULL, staging_next_page = NULL, staging_next_url = NULL, staging_page_seq = 0, staging_count = 0;`)
  for (const row of db.prepare('SELECT account_id FROM accounts').all()) pruneHistory(row.account_id)
}

function initOrMigrateDatabase() {
  const verRow = db.prepare('PRAGMA user_version;').get()
  let userVersion = verRow ? Object.values(verRow)[0] : 0

  if (userVersion === 0) {
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts';").get()
    if (tableCheck) {
      userVersion = 1
    }
  }

  if (userVersion === 0) {
    initTablesV1()
    initTablesV2()
    initTablesV3()
    db.exec('PRAGMA user_version = 3;')
  } else if (userVersion === 1) {
    migrateV1ToV2()
    migrateV2ToV3()
    db.exec('PRAGMA user_version = 3;')
  } else if (userVersion === 2) {
    initTablesV2()
    migrateV2ToV3()
    db.exec('PRAGMA user_version = 3;')
  } else {
    initTablesV2()
    initTablesV3()
  }
}

function initTablesV1() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY NOT NULL,
      login TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      profile_synced_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_preferences (
      account_id TEXT PRIMARY KEY NOT NULL,
      history_enabled INTEGER NOT NULL DEFAULT 1,
      manual_tags_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS browse_history (
      account_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      description TEXT,
      repository_json TEXT NOT NULL,
      first_viewed_at INTEGER NOT NULL,
      last_viewed_at INTEGER NOT NULL,
      last_counted_at INTEGER NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 1,
      last_source TEXT NOT NULL,
      PRIMARY KEY (account_id, repo_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_history_account_time
      ON browse_history(account_id, last_viewed_at DESC, repo_id DESC);

    CREATE TABLE IF NOT EXISTS repository_cache (
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      sort_time INTEGER NOT NULL,
      repository_json TEXT NOT NULL,
      PRIMARY KEY (account_id, kind, generation_id, repo_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_repository_collection
      ON repository_cache(account_id, kind, generation_id, sort_time DESC, repo_id DESC);

    CREATE TABLE IF NOT EXISTS sync_state (
      account_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      active_generation TEXT,
      active_complete INTEGER NOT NULL DEFAULT 0,
      active_count INTEGER NOT NULL DEFAULT 0,
      staging_generation TEXT,
      staging_next_page INTEGER,
      staging_count INTEGER NOT NULL DEFAULT 0,
      last_completed_at INTEGER,
      last_error_code TEXT,
      retry_at INTEGER,
      staging_next_url TEXT,
      staging_page_seq INTEGER NOT NULL DEFAULT 0,
      staging_star_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, kind),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY NOT NULL,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feed_cache (
      cache_key TEXT PRIMARY KEY NOT NULL,
      payload_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `)
}

function initTablesV2() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_revisions (
      account_id TEXT PRIMARY KEY NOT NULL,
      profile_revision INTEGER NOT NULL DEFAULT 0,
      collection_revision INTEGER NOT NULL DEFAULT 0,
      history_revision INTEGER NOT NULL DEFAULT 0,
      preference_revision INTEGER NOT NULL DEFAULT 0,
      feedback_revision INTEGER NOT NULL DEFAULT 0,
      discovery_revision INTEGER NOT NULL DEFAULT 0,
      star_mutation_revision INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repository_catalog (
      repo_id TEXT PRIMARY KEY NOT NULL,
      canonical_key TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      repository_json TEXT NOT NULL,
      feature_json TEXT,
      feature_version TEXT,
      fetched_at INTEGER NOT NULL,
      previous_star_count INTEGER,
      previous_observed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS repository_aliases (
      canonical_key TEXT PRIMARY KEY NOT NULL,
      repo_id TEXT NOT NULL,
      FOREIGN KEY (repo_id) REFERENCES repository_catalog(repo_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS star_state (
      account_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      starred INTEGER NOT NULL CHECK (starred IN (0, 1)),
      observed_at INTEGER NOT NULL,
      mutation_revision INTEGER NOT NULL,
      PRIMARY KEY (account_id, repo_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS website_operations (
      operation_id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      desired_starred INTEGER NOT NULL CHECK (desired_starred IN (0, 1)),
      state TEXT NOT NULL,
      attempted_at INTEGER,
      confirmed_at INTEGER,
      error_code TEXT,
      UNIQUE (account_id, intent_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS interest_profiles (
      account_id TEXT PRIMARY KEY NOT NULL,
      model_version TEXT NOT NULL,
      input_versions_json TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      account_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      event_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, repo_id),
      UNIQUE (account_id, event_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS discovery_cache (
      account_id TEXT NOT NULL,
      query_key TEXT NOT NULL,
      query_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, query_key),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recommendation_batches (
      batch_id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      input_versions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recommendation_items (
      batch_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      repo_id TEXT NOT NULL,
      score REAL NOT NULL,
      reasons_json TEXT NOT NULL,
      repository_json TEXT NOT NULL,
      PRIMARY KEY (batch_id, position),
      UNIQUE (batch_id, repo_id),
      FOREIGN KEY (batch_id) REFERENCES recommendation_batches(batch_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS recommendation_snapshots (
      input_id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      input_versions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_website_operations_account_state
      ON website_operations(account_id, state);
    CREATE INDEX IF NOT EXISTS idx_recommendation_batches_account_time
      ON recommendation_batches(account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_account
      ON recommendation_snapshots(account_id, created_at DESC);
  `)
}

function initTablesV3() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cloud_account_state (
      account_id TEXT PRIMARY KEY NOT NULL,
      subject_id TEXT,
      device_id TEXT,
      installation_id TEXT NOT NULL,
      stream_epoch INTEGER NOT NULL DEFAULT 1,
      analysis_epoch INTEGER NOT NULL DEFAULT 1,
      analysis_enabled INTEGER NOT NULL DEFAULT 1,
      cloud_bound INTEGER NOT NULL DEFAULT 0,
      cloud_account_id TEXT,
      session_expires_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS local_activity_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      record_kind TEXT NOT NULL DEFAULT 'open' CHECK (record_kind IN ('open', 'discard')),
      source TEXT NOT NULL DEFAULT 'browse',
      entry_source TEXT NOT NULL DEFAULT 'unknown',
      occurred_at INTEGER NOT NULL,
      effective_at INTEGER NOT NULL,
      time_flag TEXT NOT NULL DEFAULT 'normal',
      analysis_epoch INTEGER NOT NULL DEFAULT 1,
      repository_json TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_local_activity_account_time
      ON local_activity_events(account_id, occurred_at DESC, event_id DESC);
    CREATE INDEX IF NOT EXISTS idx_local_activity_account_repo
      ON local_activity_events(account_id, repo_id, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS event_outbox (
      account_id TEXT NOT NULL,
      stream_epoch INTEGER NOT NULL,
      device_seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      analysis_epoch INTEGER NOT NULL,
      record_kind TEXT NOT NULL CHECK (record_kind IN ('open', 'discard')),
      repo_id TEXT,
      source TEXT,
      entry_source TEXT,
      occurred_at INTEGER,
      payload_hash TEXT NOT NULL,
      payload_json TEXT,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, stream_epoch, device_seq),
      UNIQUE (account_id, event_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_event_outbox_pending
      ON event_outbox(account_id, stream_epoch, acknowledged, device_seq ASC);

    CREATE TABLE IF NOT EXISTS local_sync_state (
      account_id TEXT PRIMARY KEY NOT NULL,
      stream_epoch INTEGER NOT NULL DEFAULT 1,
      analysis_epoch INTEGER NOT NULL DEFAULT 1,
      next_device_seq INTEGER NOT NULL DEFAULT 1,
      accepted_through INTEGER NOT NULL DEFAULT 0,
      exported_through INTEGER NOT NULL DEFAULT 0,
      processed_through INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER,
      last_server_time INTEGER,
      last_error_code TEXT,
      retry_at INTEGER,
      in_flight_request_id TEXT,
      in_flight_first_seq INTEGER,
      in_flight_last_seq INTEGER,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cloud_collection_sync (
      account_id TEXT NOT NULL,
      collection_kind TEXT NOT NULL CHECK (collection_kind IN ('stars', 'owned')),
      synced_revision INTEGER NOT NULL DEFAULT 0,
      synced_complete INTEGER NOT NULL DEFAULT 0,
      synced_hash TEXT,
      last_synced_at INTEGER,
      last_operation_id TEXT,
      PRIMARY KEY (account_id, collection_kind),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS client_mutation_outbox (
      operation_id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      mutation_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error_code TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
  `)
}

function migrateV1ToV2() {
  const syncCols = db.prepare('PRAGMA table_info(sync_state);').all().map(c => c.name)
  if (!syncCols.includes('staging_next_url')) {
    db.exec('ALTER TABLE sync_state ADD COLUMN staging_next_url TEXT;')
  }
  if (!syncCols.includes('staging_page_seq')) {
    db.exec('ALTER TABLE sync_state ADD COLUMN staging_page_seq INTEGER NOT NULL DEFAULT 0;')
  }
  if (!syncCols.includes('staging_star_revision')) {
    db.exec('ALTER TABLE sync_state ADD COLUMN staging_star_revision INTEGER NOT NULL DEFAULT 0;')
  }

  initTablesV2()

  db.exec('INSERT OR IGNORE INTO account_revisions (account_id) SELECT account_id FROM accounts;')
}

function getOrCreateInstallationId() {
  const row = db.prepare(`SELECT value_json FROM app_settings WHERE setting_key = 'installation_id';`).get()
  if (row && row.value_json) {
    try {
      const parsed = JSON.parse(row.value_json)
      if (typeof parsed === 'string' && parsed.length >= 8) return parsed
    } catch (_) {}
  }
  const newId = 'inst_' + crypto.randomUUID().replace(/-/g, '')
  db.prepare(`
    INSERT INTO app_settings (setting_key, value_json)
    VALUES ('installation_id', ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json;
  `).run(JSON.stringify(newId))
  return newId
}

function ensureAccountV3State(accountId, now = Date.now()) {
  const installationId = getOrCreateInstallationId()
  db.prepare(`
    INSERT OR IGNORE INTO cloud_account_state (
      account_id, installation_id, stream_epoch, analysis_epoch, analysis_enabled, cloud_bound, updated_at
    ) VALUES (?, ?, 1, 1, 1, 0, ?);
  `).run(accountId, installationId, now)

  db.prepare(`
    INSERT OR IGNORE INTO local_sync_state (
      account_id, stream_epoch, analysis_epoch, next_device_seq, accepted_through, exported_through, processed_through
    ) VALUES (?, 1, 1, 1, 0, 0, 0);
  `).run(accountId)
}

function migrateV2ToV3() {
  initTablesV3()
  const now = Date.now()
  for (const row of db.prepare('SELECT account_id FROM accounts;').all()) {
    ensureAccountV3State(row.account_id, now)
  }
}

let txDepth = 0
function withTransaction(work) {
  if (txDepth > 0) {
    return work()
  }
  txDepth += 1
  db.exec('BEGIN IMMEDIATE;')
  try {
    const result = work()
    db.exec('COMMIT;')
    txDepth -= 1
    return result
  } catch (err) {
    txDepth -= 1
    try {
      db.exec('ROLLBACK;')
    } catch (_) {}
    throw err
  }
}

function getAccountRevisions(accountId) {
  const row = db.prepare('SELECT * FROM account_revisions WHERE account_id = ?;').get(accountId)
  if (!row) {
    const act = db.prepare('SELECT 1 FROM accounts WHERE account_id = ?;').get(accountId)
    if (act) {
      db.prepare('INSERT OR IGNORE INTO account_revisions (account_id) VALUES (?);').run(accountId)
    }
    return {
      profileRevision: 0,
      collectionRevision: 0,
      historyRevision: 0,
      preferenceRevision: 0,
      feedbackRevision: 0,
      discoveryRevision: 0,
      starMutationRevision: 0
    }
  }
  return {
    profileRevision: row.profile_revision || 0,
    collectionRevision: row.collection_revision || 0,
    historyRevision: row.history_revision || 0,
    preferenceRevision: row.preference_revision || 0,
    feedbackRevision: row.feedback_revision || 0,
    discoveryRevision: row.discovery_revision || 0,
    starMutationRevision: row.star_mutation_revision || 0
  }
}

function bumpRevision(accountId, column) {
  db.prepare(`
    INSERT INTO account_revisions (account_id, ${column})
    VALUES (?, 1)
    ON CONFLICT(account_id) DO UPDATE SET ${column} = ${column} + 1;
  `).run(accountId)
}

function saveProfile(accountId, profile) {
  const profileJson = JSON.stringify(profile)
  const now = Date.now()
  withTransaction(() => {
    const checkStmt = db.prepare('SELECT account_id FROM accounts WHERE account_id = ?;')
    const existing = checkStmt.get(accountId)
    if (!existing) {
      const insStmt = db.prepare(`
        INSERT INTO accounts (account_id, login, profile_json, profile_synced_at)
        VALUES (?, ?, ?, ?);
      `)
      insStmt.run(accountId, profile.login, profileJson, now)

      const prefStmt = db.prepare(`
        INSERT OR IGNORE INTO account_preferences (account_id, history_enabled, manual_tags_json, updated_at)
        VALUES (?, 1, '[]', ?);
      `)
      prefStmt.run(accountId, now)

      db.prepare('INSERT OR IGNORE INTO account_revisions (account_id) VALUES (?);').run(accountId)
    } else {
      const updStmt = db.prepare(`
        UPDATE accounts
        SET login = ?, profile_json = ?, profile_synced_at = ?
        WHERE account_id = ?;
      `)
      updStmt.run(profile.login, profileJson, now, accountId)
    }

    ensureAccountV3State(accountId, now)
    bumpRevision(accountId, 'profile_revision')
  })
}

function readCloudSyncState(accountId) {
  if (!accountId) return null
  const act = db.prepare('SELECT 1 FROM accounts WHERE account_id = ?;').get(accountId)
  if (!act) return null
  ensureAccountV3State(accountId)

  const cloudAcc = db.prepare('SELECT * FROM cloud_account_state WHERE account_id = ?;').get(accountId)
  const syncRow = db.prepare('SELECT * FROM local_sync_state WHERE account_id = ?;').get(accountId)
  const pendingRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM event_outbox
    WHERE account_id = ? AND stream_epoch = ? AND acknowledged = 0;
  `).get(accountId, syncRow ? syncRow.stream_epoch : 1)

  const collRows = db.prepare('SELECT * FROM cloud_collection_sync WHERE account_id = ?;').all(accountId)
  const collections = {}
  for (const r of collRows) {
    collections[r.collection_kind] = {
      syncedRevision: r.synced_revision || 0,
      syncedComplete: Boolean(r.synced_complete),
      lastSyncedAt: r.last_synced_at || null
    }
  }

  const accountMatched = Boolean(
    cloudAcc?.cloud_bound &&
    cloudAcc?.cloud_account_id &&
    String(cloudAcc.cloud_account_id) === String(accountId)
  )

  return {
    accountId,
    subjectId: cloudAcc?.subject_id || null,
    deviceId: cloudAcc?.device_id || null,
    installationId: cloudAcc?.installation_id || getOrCreateInstallationId(),
    cloudBound: Boolean(cloudAcc?.cloud_bound),
    cloudAccountId: cloudAcc?.cloud_account_id || null,
    accountMatched,
    analysisEnabled: cloudAcc ? Boolean(cloudAcc.analysis_enabled) : true,
    sessionExpiresAt: cloudAcc?.session_expires_at || null,
    streamEpoch: syncRow ? syncRow.stream_epoch : 1,
    analysisEpoch: syncRow ? syncRow.analysis_epoch : 1,
    nextDeviceSeq: syncRow ? syncRow.next_device_seq : 1,
    acceptedThrough: syncRow ? syncRow.accepted_through : 0,
    exportedThrough: syncRow ? syncRow.exported_through : 0,
    processedThrough: syncRow ? syncRow.processed_through : 0,
    pendingCount: pendingRow ? pendingRow.cnt : 0,
    lastSyncAt: syncRow?.last_sync_at || null,
    lastServerTime: syncRow?.last_server_time || null,
    lastErrorCode: syncRow?.last_error_code || null,
    retryAt: syncRow?.retry_at || null,
    collections
  }
}

function readAccountSnapshot(accountId) {
  const actStmt = db.prepare('SELECT profile_json FROM accounts WHERE account_id = ?;')
  const act = actStmt.get(accountId)
  const profile = act ? JSON.parse(act.profile_json) : null

  const prefStmt = db.prepare('SELECT history_enabled, manual_tags_json FROM account_preferences WHERE account_id = ?;')
  const pref = prefStmt.get(accountId)
  const cloudState = act ? readCloudSyncState(accountId) : null
  const preferences = pref
    ? {
        historyEnabled: Boolean(pref.history_enabled),
        analysisEnabled: cloudState ? cloudState.analysisEnabled : true,
        manualTags: JSON.parse(pref.manual_tags_json || '[]')
      }
    : {
        historyEnabled: true,
        analysisEnabled: cloudState ? cloudState.analysisEnabled : true,
        manualTags: []
      }

  const syncStmt = db.prepare('SELECT * FROM sync_state WHERE account_id = ?;')
  const syncRows = syncStmt.all(accountId)

  const findSync = (k) => {
    const row = syncRows.find((r) => r.kind === k)
    if (!row) {
      return { status: 'idle', loadedCount: 0, complete: false, lastSyncedAt: null, errorCode: null, retryAt: null }
    }
    const hasStaging = Boolean(row.staging_generation)
    return {
      status: hasStaging ? 'loading' : (row.active_complete ? 'ready' : (row.last_error_code ? 'error' : 'idle')),
      loadedCount: hasStaging ? row.staging_count : row.active_count,
      complete: Boolean(row.active_complete),
      lastSyncedAt: row.last_completed_at || null,
      errorCode: row.last_error_code || null,
      retryAt: row.retry_at || null
    }
  }

  return {
    profile,
    preferences,
    repoSync: findSync('repos'),
    starSync: findSync('stars'),
    revisions: getAccountRevisions(accountId),
    cloudSync: cloudState
  }
}

function savePreferences(accountId, preferences) {
  const manualJson = JSON.stringify(preferences.manualTags || [])
  const historyVal = preferences.historyEnabled !== false ? 1 : 0
  const now = Date.now()
  withTransaction(() => {
    const stmt = db.prepare(`
      INSERT INTO account_preferences (account_id, history_enabled, manual_tags_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        history_enabled = excluded.history_enabled,
        manual_tags_json = excluded.manual_tags_json,
        updated_at = excluded.updated_at;
    `)
    stmt.run(accountId, historyVal, manualJson, now)

    if (typeof preferences.analysisEnabled === 'boolean') {
      ensureAccountV3State(accountId, now)
      db.prepare(`
        UPDATE cloud_account_state
        SET analysis_enabled = ?, updated_at = ?
        WHERE account_id = ?;
      `).run(preferences.analysisEnabled ? 1 : 0, now, accountId)
    }

    bumpRevision(accountId, 'preference_revision')
  })
}

function beginSync(accountId, kind) {
  const generationId = 'gen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  withTransaction(() => {
    const delStmt = db.prepare(`DELETE FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id != COALESCE((SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = ?), '');`)
    delStmt.run(accountId, kind, accountId, kind)

    const syncStmt = db.prepare(`
      INSERT INTO sync_state (account_id, kind, staging_generation, staging_next_page, staging_count, staging_next_url, staging_page_seq)
      VALUES (?, ?, ?, 1, 0, NULL, 0)
      ON CONFLICT(account_id, kind) DO UPDATE SET
        staging_generation = excluded.staging_generation,
        staging_next_page = 1,
        staging_next_url = NULL,
        staging_page_seq = 0,
        staging_count = 0;
    `)
    syncStmt.run(accountId, kind, generationId)
  })
  return { generationId }
}

function writeSyncPage(accountId, kind, generationId, pageOrSeq, items, nextUrlOrPage) {
  return withTransaction(() => {
    const stateStmt = db.prepare('SELECT staging_generation, staging_next_page, staging_page_seq FROM sync_state WHERE account_id = ? AND kind = ?;')
    const state = stateStmt.get(accountId, kind)
    if (!state || state.staging_generation !== generationId) {
      throw new Error('SYNC_GENERATION_MISMATCH')
    }

    if (state.staging_next_page != null && typeof pageOrSeq === 'number' && pageOrSeq !== state.staging_next_page) {
      throw new Error('PAGE_OUT_OF_ORDER')
    }

    const insStmt = db.prepare(`
      INSERT OR REPLACE INTO repository_cache (account_id, kind, generation_id, repo_id, sort_time, repository_json)
      VALUES (?, ?, ?, ?, ?, ?);
    `)

    for (const item of items) {
      const sortTime = item.starredAt || item.updatedAt || item.createdAt || Date.now()
      const repoKey = item.repoId || item.canonicalKey
      insStmt.run(accountId, kind, generationId, repoKey, sortTime, JSON.stringify(item))
    }

    const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id = ?;')
    const countRow = countStmt.get(accountId, kind, generationId)
    const stagingCount = countRow ? countRow.cnt : 0

    const nextUrl = typeof nextUrlOrPage === 'string' ? nextUrlOrPage : null
    const nextPage = typeof nextUrlOrPage === 'number' ? nextUrlOrPage : null
    const pageSeq = typeof pageOrSeq === 'number' ? pageOrSeq : 1

    const updStmt = db.prepare(`
      UPDATE sync_state
      SET staging_count = ?, staging_next_page = ?, staging_next_url = ?, staging_page_seq = ?
      WHERE account_id = ? AND kind = ?;
    `)
    updStmt.run(stagingCount, nextPage, nextUrl, pageSeq, accountId, kind)

    return {
      kind,
      loadedCount: stagingCount,
      nextUrl,
      nextPage
    }
  })
}

function finishSync(accountId, kind, generationId) {
  return withTransaction(() => {
    const stateStmt = db.prepare('SELECT staging_generation, staging_count, staging_next_url, staging_next_page FROM sync_state WHERE account_id = ? AND kind = ?;')
    const state = stateStmt.get(accountId, kind)
    if (!state || state.staging_generation !== generationId) {
      throw new Error('SYNC_GENERATION_MISMATCH')
    }

    if (state.staging_next_page != null || state.staging_next_url != null) {
      throw new Error('SYNC_UNFINISHED')
    }

    const delStmt = db.prepare('DELETE FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id != ?;')
    delStmt.run(accountId, kind, generationId)

    const now = Date.now()
    const updStmt = db.prepare(`
      UPDATE sync_state
      SET active_generation = staging_generation,
          active_complete = 1,
          active_count = staging_count,
          staging_generation = NULL,
          staging_next_page = NULL,
          staging_next_url = NULL,
          staging_page_seq = 0,
          staging_count = 0,
          last_completed_at = ?,
          last_error_code = NULL,
          retry_at = NULL
      WHERE account_id = ? AND kind = ?;
    `)
    updStmt.run(now, accountId, kind)

    bumpRevision(accountId, 'collection_revision')

    return {
      kind,
      activeCount: state.staging_count,
      complete: true,
      lastSyncedAt: now
    }
  })
}

function abortSync(accountId, kind, generationId, errorCode = null, retryAt = null) {
  withTransaction(() => {
    const state = db.prepare('SELECT staging_generation FROM sync_state WHERE account_id = ? AND kind = ?').get(accountId, kind)
    if (state?.staging_generation !== generationId) return
    const delStmt = db.prepare('DELETE FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id = ?;')
    delStmt.run(accountId, kind, generationId)

    const updStmt = db.prepare(`
      UPDATE sync_state
      SET staging_generation = NULL,
          staging_next_page = NULL,
          staging_next_url = NULL,
          staging_page_seq = 0,
          staging_count = 0,
          last_error_code = ?,
          retry_at = ?
      WHERE account_id = ? AND kind = ? AND staging_generation = ?;
    `)
    updStmt.run(errorCode, retryAt, accountId, kind, generationId)
  })
}

function listRepositories(accountId, kind, offset = 0, limit = 30) {
  const syncStmt = db.prepare('SELECT active_generation, active_complete, active_count FROM sync_state WHERE account_id = ? AND kind = ?;')
  const syncState = syncStmt.get(accountId, kind)

  const activeGen = syncState?.active_generation
  if (!activeGen) {
    return { items: [], total: null, loadedCount: 0, complete: false, nextOffset: null }
  }

  const queryStmt = db.prepare(`
    SELECT repository_json FROM repository_cache
    WHERE account_id = ? AND kind = ? AND generation_id = ?
    ORDER BY sort_time DESC, repo_id DESC
    LIMIT ? OFFSET ?;
  `)
  const rows = queryStmt.all(accountId, kind, activeGen, limit, offset)
  const items = rows.map((r) => JSON.parse(r.repository_json))
  const nextOffset = offset + items.length < syncState.active_count ? offset + items.length : null

  return {
    items,
    total: syncState.active_complete ? syncState.active_count : null,
    loadedCount: syncState.active_count,
    complete: Boolean(syncState.active_complete),
    nextOffset
  }
}

function applyConfirmedStar(accountId, repository, starred) {
  withTransaction(() => {
    const syncStmt = db.prepare(`SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'stars';`)
    const syncState = syncStmt.get(accountId)
    let activeGen = syncState?.active_generation
    if (!activeGen) {
      activeGen = 'active_stars_local'
      const initStmt = db.prepare(`
        INSERT OR IGNORE INTO sync_state (account_id, kind, active_generation, active_complete, active_count)
        VALUES (?, 'stars', ?, 0, 0);
      `)
      initStmt.run(accountId, activeGen)
      db.prepare(`UPDATE sync_state SET active_generation = ? WHERE account_id = ? AND kind = 'stars' AND active_generation IS NULL`).run(activeGen, accountId)
    }

    const repoKey = repository.repoId || repository.canonicalKey
    const now = Date.now()

    if (starred) {
      const insStmt = db.prepare(`
        INSERT OR REPLACE INTO repository_cache (account_id, kind, generation_id, repo_id, sort_time, repository_json)
        VALUES (?, 'stars', ?, ?, ?, ?);
      `)
      insStmt.run(accountId, activeGen, repoKey, now, JSON.stringify(repository))
    } else {
      const delStmt = db.prepare(`DELETE FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ? AND repo_id = ?;`)
      delStmt.run(accountId, activeGen, repoKey)
    }

    const countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ?;`)
    const countRow = countStmt.get(accountId, activeGen)
    const newCount = countRow ? countRow.cnt : 0

    const updStmt = db.prepare(`UPDATE sync_state SET active_count = ? WHERE account_id = ? AND kind = 'stars';`)
    updStmt.run(newCount, accountId)

    if (repository.repoId) {
      const starStateStmt = db.prepare(`
        INSERT INTO star_state (account_id, repo_id, starred, observed_at, mutation_revision)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(account_id, repo_id) DO UPDATE SET
          starred = excluded.starred,
          observed_at = excluded.observed_at,
          mutation_revision = star_state.mutation_revision + 1;
      `)
      starStateStmt.run(accountId, repository.repoId, starred ? 1 : 0, now)
    }

    bumpRevision(accountId, 'star_mutation_revision')
    bumpRevision(accountId, 'collection_revision')
  })
}

function readStarState(accountId, repoId, fullName) {
  if (repoId) {
    const starRow = db.prepare('SELECT starred, observed_at FROM star_state WHERE account_id = ? AND repo_id = ?;').get(accountId, repoId)
    if (starRow) {
      return { state: starRow.starred === 1 ? 'starred' : 'unstarred', observedAt: starRow.observed_at }
    }
  }

  const isStarred = isRepositoryStarred(accountId, repoId || fullName.toLowerCase())
  if (isStarred.known) {
    return { state: isStarred.starred ? 'starred' : 'unstarred', observedAt: Date.now() }
  }
  return { state: 'unknown', observedAt: null }
}

function isRepositoryStarred(accountId, repoId) {
  const syncStmt = db.prepare(`SELECT active_generation, active_complete FROM sync_state WHERE account_id = ? AND kind = 'stars';`)
  const syncState = syncStmt.get(accountId)
  if (!syncState || !syncState.active_generation) {
    return { known: false, starred: false }
  }
  const checkStmt = db.prepare(`SELECT 1 FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ? AND repo_id = ?;`)
  const row = checkStmt.get(accountId, syncState.active_generation, repoId)
  if (row) {
    return { known: true, starred: true }
  }
  if (syncState.active_complete) {
    return { known: true, starred: false }
  }
  return { known: false, starred: false }
}

function recordBrowse(accountId, repository, source = 'trending', viewedAt = Date.now()) {
  return withTransaction(() => {
    const prefRow = db.prepare('SELECT history_enabled FROM account_preferences WHERE account_id = ?;').get(accountId)
    if (prefRow && prefRow.history_enabled === 0) {
      return {
        skipped: true,
        reason: 'HISTORY_DISABLED',
        accountId,
        repoId: repository.repoId || repository.canonicalKey
      }
    }

    const repoKey = String(repository.repoId || repository.canonicalKey)
    const selStmt = db.prepare('SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?;')
    const old = selStmt.get(accountId, repoKey)

    let shouldCount = true
    if (!old) {
      const insStmt = db.prepare(`
        INSERT INTO browse_history (
          account_id, repo_id, full_name, description, repository_json,
          first_viewed_at, last_viewed_at, last_counted_at, visit_count, last_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?);
      `)
      insStmt.run(
        accountId, repoKey, repository.fullName, repository.description || null,
        JSON.stringify(repository), viewedAt, viewedAt, viewedAt, source
      )
    } else {
      const nextViewedAt = Math.max(old.last_viewed_at, viewedAt)
      shouldCount = (viewedAt - old.last_counted_at) >= 30000
      const nextCount = shouldCount ? (old.visit_count + 1) : old.visit_count
      const nextCountedAt = shouldCount ? viewedAt : old.last_counted_at

      const updStmt = db.prepare(`
        UPDATE browse_history
        SET full_name = ?, description = ?, repository_json = ?,
            last_viewed_at = ?, last_counted_at = ?, visit_count = ?, last_source = ?
        WHERE account_id = ? AND repo_id = ?;
      `)
      updStmt.run(
        repository.fullName, repository.description || null, JSON.stringify(repository),
        nextViewedAt, nextCountedAt, nextCount, source, accountId, repoKey
      )
    }

    let createdEventId = null
    let enqueuedSeq = null

    if (shouldCount) {
      ensureAccountV3State(accountId, viewedAt)
      const cloudAcc = db.prepare('SELECT * FROM cloud_account_state WHERE account_id = ?;').get(accountId)
      const syncState = db.prepare('SELECT * FROM local_sync_state WHERE account_id = ?;').get(accountId)
      const analysisEpoch = syncState ? syncState.analysis_epoch : 1
      const streamEpoch = syncState ? syncState.stream_epoch : 1
      const randSuffix = crypto.randomBytes(4).toString('hex')
      const safeAccount = String(accountId).replace(/[^A-Za-z0-9_.-]/g, '_')
      createdEventId = `evt_${safeAccount}_${viewedAt}_${randSuffix}`

      db.prepare(`
        INSERT INTO local_activity_events (
          event_id, account_id, repo_id, full_name, record_kind,
          source, entry_source, occurred_at, effective_at, time_flag,
          analysis_epoch, repository_json
        ) VALUES (?, ?, ?, ?, 'open', 'browse', ?, ?, ?, 'normal', ?, ?);
      `).run(
        createdEventId,
        accountId,
        repoKey,
        repository.fullName || repoKey,
        source || 'browse',
        viewedAt,
        viewedAt,
        analysisEpoch,
        JSON.stringify(repository)
      )

      // 仅当云端兴趣分析开启且具有有效 repoId 时写入待上传队列 event_outbox
      const analysisEnabled = cloudAcc ? Boolean(cloudAcc.analysis_enabled) : true
      const canonicalRepoId = String(repository.repoId || repoKey).trim()
      if (analysisEnabled && canonicalRepoId) {
        const deviceSeq = syncState ? syncState.next_device_seq : 1
        enqueuedSeq = deviceSeq
        const payloadHash = computeOpenPayloadHash(
          createdEventId,
          streamEpoch,
          deviceSeq,
          analysisEpoch,
          canonicalRepoId,
          viewedAt,
          'browse'
        )
        const eventPayload = {
          schemaVersion: '1.0.0',
          eventId: createdEventId,
          streamEpoch,
          deviceSeq,
          analysisEpoch,
          recordKind: 'open',
          repoId: canonicalRepoId,
          source: 'browse',
          entrySource: source || 'browse',
          occurredAt: viewedAt,
          payloadHash
        }

        db.prepare(`
          INSERT INTO event_outbox (
            account_id, stream_epoch, device_seq, event_id, analysis_epoch,
            record_kind, repo_id, source, entry_source, occurred_at,
            payload_hash, payload_json, acknowledged, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, 'browse', ?, ?, ?, ?, 0, ?, ?);
        `).run(
          accountId,
          streamEpoch,
          deviceSeq,
          createdEventId,
          analysisEpoch,
          canonicalRepoId,
          source || 'browse',
          viewedAt,
          payloadHash,
          JSON.stringify(eventPayload),
          viewedAt,
          viewedAt
        )

        db.prepare(`
          UPDATE local_sync_state
          SET next_device_seq = ?
          WHERE account_id = ?;
        `).run(deviceSeq + 1, accountId)
      }
    }

    pruneHistory(accountId, viewedAt)
    bumpRevision(accountId, 'history_revision')

    const finalStmt = db.prepare('SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?;')
    const finalRow = finalStmt.get(accountId, repoKey)
    return {
      accountId: finalRow.account_id,
      repoId: finalRow.repo_id,
      repository: JSON.parse(finalRow.repository_json),
      firstViewedAt: finalRow.first_viewed_at,
      lastViewedAt: finalRow.last_viewed_at,
      lastCountedAt: finalRow.last_counted_at,
      visitCount: finalRow.visit_count,
      lastSource: finalRow.last_source,
      countedVisit: shouldCount,
      eventId: createdEventId,
      deviceSeq: enqueuedSeq
    }
  })
}

function pruneHistory(accountId, now = Date.now()) {
  const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000)
  const delOldStmt = db.prepare('DELETE FROM browse_history WHERE account_id = ? AND last_viewed_at < ?;')
  delOldStmt.run(accountId, ninetyDaysAgo)
  db.prepare('DELETE FROM local_activity_events WHERE account_id = ? AND occurred_at < ?;').run(accountId, ninetyDaysAgo)

  const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM browse_history WHERE account_id = ?;')
  const countRow = countStmt.get(accountId)
  if (countRow && countRow.cnt > 5000) {
    const pruneStmt = db.prepare(`
      DELETE FROM browse_history
      WHERE account_id = ? AND repo_id NOT IN (
        SELECT repo_id FROM browse_history
        WHERE account_id = ?
        ORDER BY last_viewed_at DESC, repo_id DESC
        LIMIT 5000
      );
    `)
    pruneStmt.run(accountId, accountId)
  }
}

function listHistory(accountId, cursor = null, limit = 30, keyword = '') {
  limit = Math.max(1, Math.min(100, limit))
  let querySql = `
    SELECT * FROM browse_history
    WHERE account_id = ?
  `
  const params = [accountId]

  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    querySql += ` AND (full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`
    params.push(kw, kw)
  }

  if (cursor && cursor.lastViewedAt != null) {
    querySql += ` AND (last_viewed_at < ? OR (last_viewed_at = ? AND repo_id < ?))`
    params.push(cursor.lastViewedAt, cursor.lastViewedAt, cursor.repoId)
  }

  querySql += ` ORDER BY last_viewed_at DESC, repo_id DESC LIMIT ?;`
  params.push(Math.min(limit, 100))

  const rows = db.prepare(querySql).all(...params)

  const items = rows.map((r) => ({
    accountId: r.account_id,
    repoId: r.repo_id,
    repository: JSON.parse(r.repository_json),
    firstViewedAt: r.first_viewed_at,
    lastViewedAt: r.last_viewed_at,
    lastCountedAt: r.last_counted_at,
    visitCount: r.visit_count,
    lastSource: r.last_source
  }))

  const nextCursor = items.length === limit
    ? { lastViewedAt: items[items.length - 1].lastViewedAt, repoId: items[items.length - 1].repoId }
    : null

  let countSql = 'SELECT COUNT(*) as total FROM browse_history WHERE account_id = ?'
  const countParams = [accountId]
  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
    countSql += ` AND (full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`
    countParams.push(kw, kw)
  }
  const countRow = db.prepare(countSql).get(...countParams)

  return {
    items,
    nextCursor,
    total: countRow ? countRow.total : 0
  }
}

function convertPendingOutboxToDiscard(accountId, repoId = null) {
  const now = Date.now()
  const rows = repoId
    ? db.prepare(`
        SELECT * FROM event_outbox
        WHERE account_id = ? AND repo_id = ? AND acknowledged = 0 AND record_kind = 'open';
      `).all(accountId, String(repoId))
    : db.prepare(`
        SELECT * FROM event_outbox
        WHERE account_id = ? AND acknowledged = 0 AND record_kind = 'open';
      `).all(accountId)

  const updStmt = db.prepare(`
    UPDATE event_outbox
    SET record_kind = 'discard',
        repo_id = NULL,
        source = NULL,
        entry_source = NULL,
        occurred_at = NULL,
        payload_hash = ?,
        payload_json = NULL,
        updated_at = ?
    WHERE account_id = ? AND stream_epoch = ? AND device_seq = ?;
  `)

  for (const r of rows) {
    const discardHash = computeDiscardPayloadHash(r.event_id, r.stream_epoch, r.device_seq, r.analysis_epoch)
    updStmt.run(discardHash, now, accountId, r.stream_epoch, r.device_seq)
  }

  // 清除飞行中的批次绑定以便重新组装含 discard 的批次
  db.prepare(`
    UPDATE local_sync_state
    SET in_flight_request_id = NULL, in_flight_first_seq = NULL, in_flight_last_seq = NULL
    WHERE account_id = ?;
  `).run(accountId)
}

function deleteHistory(accountId, repoId) {
  withTransaction(() => {
    const stmt = db.prepare('DELETE FROM browse_history WHERE account_id = ? AND repo_id = ?;')
    stmt.run(accountId, repoId)
    db.prepare('DELETE FROM local_activity_events WHERE account_id = ? AND repo_id = ?;').run(accountId, String(repoId))
    convertPendingOutboxToDiscard(accountId, repoId)
    bumpRevision(accountId, 'history_revision')
    db.prepare('DELETE FROM interest_profiles WHERE account_id = ?;').run(accountId)
    db.prepare('DELETE FROM recommendation_batches WHERE account_id = ?;').run(accountId)
  })
}

function clearHistory(accountId) {
  withTransaction(() => {
    const stmt = db.prepare('DELETE FROM browse_history WHERE account_id = ?;')
    stmt.run(accountId)
    db.prepare('DELETE FROM local_activity_events WHERE account_id = ?;').run(accountId)
    convertPendingOutboxToDiscard(accountId, null)
    bumpRevision(accountId, 'history_revision')
    db.prepare('DELETE FROM interest_profiles WHERE account_id = ?;').run(accountId)
    db.prepare('DELETE FROM discovery_cache WHERE account_id = ?;').run(accountId)
    db.prepare('DELETE FROM recommendation_batches WHERE account_id = ?;').run(accountId)
  })
}

function countHistory(accountId) {
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM browse_history WHERE account_id = ?;')
  const row = stmt.get(accountId)
  return row ? row.cnt : 0
}

function listLocalActivityEvents(accountId, limit = 100) {
  const rows = db.prepare(`
    SELECT * FROM local_activity_events
    WHERE account_id = ?
    ORDER BY occurred_at DESC, event_id DESC
    LIMIT ?;
  `).all(accountId, Math.max(1, Math.min(500, limit)))
  return rows.map((r) => ({
    eventId: r.event_id,
    accountId: r.account_id,
    repoId: r.repo_id,
    fullName: r.full_name,
    recordKind: r.record_kind,
    source: r.source,
    entrySource: r.entry_source,
    occurredAt: r.occurred_at,
    effectiveAt: r.effective_at,
    timeFlag: r.time_flag,
    analysisEpoch: r.analysis_epoch
  }))
}

function saveCloudAccountState(accountId, patch = {}) {
  return withTransaction(() => {
    ensureAccountV3State(accountId)
    const curr = db.prepare('SELECT * FROM cloud_account_state WHERE account_id = ?;').get(accountId)
    const now = Date.now()
    const nextSubjectId = patch.subjectId !== undefined ? patch.subjectId : curr.subject_id
    const nextDeviceId = patch.deviceId !== undefined ? patch.deviceId : curr.device_id
    const nextStreamEpoch = patch.streamEpoch !== undefined ? Number(patch.streamEpoch) : curr.stream_epoch
    const nextAnalysisEpoch = patch.analysisEpoch !== undefined ? Number(patch.analysisEpoch) : curr.analysis_epoch
    const nextAnalysisEnabled = patch.analysisEnabled !== undefined ? (patch.analysisEnabled ? 1 : 0) : curr.analysis_enabled
    const nextCloudBound = patch.cloudBound !== undefined ? (patch.cloudBound ? 1 : 0) : curr.cloud_bound
    const nextCloudAccountId = patch.cloudAccountId !== undefined ? patch.cloudAccountId : curr.cloud_account_id
    const nextExpiresAt = patch.sessionExpiresAt !== undefined ? patch.sessionExpiresAt : curr.session_expires_at

    db.prepare(`
      UPDATE cloud_account_state
      SET subject_id = ?,
          device_id = ?,
          stream_epoch = ?,
          analysis_epoch = ?,
          analysis_enabled = ?,
          cloud_bound = ?,
          cloud_account_id = ?,
          session_expires_at = ?,
          updated_at = ?
      WHERE account_id = ?;
    `).run(
      nextSubjectId,
      nextDeviceId,
      nextStreamEpoch,
      nextAnalysisEpoch,
      nextAnalysisEnabled,
      nextCloudBound,
      nextCloudAccountId,
      nextExpiresAt,
      now,
      accountId
    )
    return readCloudSyncState(accountId)
  })
}

function syncCloudStreamState(accountId, serverState = {}) {
  return withTransaction(() => {
    ensureAccountV3State(accountId)
    const syncRow = db.prepare('SELECT * FROM local_sync_state WHERE account_id = ?;').get(accountId)
    const oldStreamEpoch = syncRow.stream_epoch
    const oldAnalysisEpoch = syncRow.analysis_epoch

    const newStreamEpoch = Number(serverState.streamEpoch || oldStreamEpoch || 1)
    const newAnalysisEpoch = Number(serverState.analysisEpoch || oldAnalysisEpoch || 1)
    const acceptedThrough = Number(serverState.acceptedThrough ?? syncRow.accepted_through ?? 0)
    const exportedThrough = Number(serverState.exportedThrough ?? syncRow.exported_through ?? 0)
    // 注意：processedThrough 绝不等于 acceptedThrough，必须独立记录服务端已完成画像消费的真实水位
    const processedThrough = Number(serverState.processedThrough ?? syncRow.processed_through ?? 0)
    const now = Date.now()

    if (serverState.deviceId || serverState.preferences) {
      const analysisEnabledPatch = serverState.preferences?.analysisEnabled
      saveCloudAccountState(accountId, {
        deviceId: serverState.deviceId,
        streamEpoch: newStreamEpoch,
        analysisEpoch: newAnalysisEpoch,
        ...(typeof analysisEnabledPatch === 'boolean' ? { analysisEnabled: analysisEnabledPatch } : {})
      })
    }

    // 确认 <= acceptedThrough 的旧队列项
    if (oldStreamEpoch === newStreamEpoch && acceptedThrough > 0) {
      db.prepare(`
        UPDATE event_outbox
        SET acknowledged = 1, payload_json = NULL, updated_at = ?
        WHERE account_id = ? AND stream_epoch = ? AND device_seq <= ?;
      `).run(now, accountId, newStreamEpoch, acceptedThrough)
    }

    // 若 streamEpoch 或 analysisEpoch 发生变化，将尚未确认的本地事件迁移到最新 epoch 并从 acceptedThrough + 1 连续编排
    const pendingRows = db.prepare(`
      SELECT * FROM event_outbox
      WHERE account_id = ? AND acknowledged = 0
      ORDER BY stream_epoch ASC, device_seq ASC;
    `).all(accountId)

    let nextSeq = Math.max(acceptedThrough + 1, syncRow.next_device_seq)
    if (oldStreamEpoch !== newStreamEpoch || oldAnalysisEpoch !== newAnalysisEpoch || (pendingRows.length > 0 && pendingRows[0].device_seq !== acceptedThrough + 1)) {
      db.prepare('DELETE FROM event_outbox WHERE account_id = ? AND acknowledged = 0;').run(accountId)
      let seqCursor = acceptedThrough + 1
      const insStmt = db.prepare(`
        INSERT INTO event_outbox (
          account_id, stream_epoch, device_seq, event_id, analysis_epoch,
          record_kind, repo_id, source, entry_source, occurred_at,
          payload_hash, payload_json, acknowledged, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?);
      `)

      for (const row of pendingRows) {
        if (oldStreamEpoch === newStreamEpoch && row.device_seq <= acceptedThrough) continue
        const seq = seqCursor++
        if (row.record_kind === 'open' && row.repo_id && row.occurred_at) {
          const hash = computeOpenPayloadHash(
            row.event_id,
            newStreamEpoch,
            seq,
            newAnalysisEpoch,
            row.repo_id,
            row.occurred_at,
            row.source || 'browse'
          )
          const payloadObj = {
            schemaVersion: '1.0.0',
            eventId: row.event_id,
            streamEpoch: newStreamEpoch,
            deviceSeq: seq,
            analysisEpoch: newAnalysisEpoch,
            recordKind: 'open',
            repoId: row.repo_id,
            source: row.source || 'browse',
            entrySource: row.entry_source || 'browse',
            occurredAt: row.occurred_at,
            payloadHash: hash
          }
          insStmt.run(
            accountId,
            newStreamEpoch,
            seq,
            row.event_id,
            newAnalysisEpoch,
            'open',
            row.repo_id,
            row.source || 'browse',
            row.entry_source || 'browse',
            row.occurred_at,
            hash,
            JSON.stringify(payloadObj),
            row.created_at,
            now
          )
        } else {
          const hash = computeDiscardPayloadHash(row.event_id, newStreamEpoch, seq, newAnalysisEpoch)
          insStmt.run(
            accountId,
            newStreamEpoch,
            seq,
            row.event_id,
            newAnalysisEpoch,
            'discard',
            null,
            null,
            null,
            null,
            hash,
            null,
            row.created_at,
            now
          )
        }
      }
      nextSeq = seqCursor
    }

    db.prepare(`
      UPDATE local_sync_state
      SET stream_epoch = ?,
          analysis_epoch = ?,
          next_device_seq = ?,
          accepted_through = ?,
          exported_through = ?,
          processed_through = ?,
          last_server_time = COALESCE(?, last_server_time),
          last_error_code = NULL,
          retry_at = NULL,
          in_flight_request_id = NULL,
          in_flight_first_seq = NULL,
          in_flight_last_seq = NULL
      WHERE account_id = ?;
    `).run(
      newStreamEpoch,
      newAnalysisEpoch,
      nextSeq,
      acceptedThrough,
      exportedThrough,
      processedThrough,
      serverState.serverTime || null,
      accountId
    )

    return readCloudSyncState(accountId)
  })
}

function readOutboxBatch(accountId, maxItems = 500, maxBytes = 1048576) {
  return withTransaction(() => {
    ensureAccountV3State(accountId)
    const syncRow = db.prepare('SELECT * FROM local_sync_state WHERE account_id = ?;').get(accountId)
    const streamEpoch = syncRow.stream_epoch
    const analysisEpoch = syncRow.analysis_epoch
    const expectedFirstSeq = (syncRow.accepted_through || 0) + 1

    const rows = db.prepare(`
      SELECT * FROM event_outbox
      WHERE account_id = ? AND stream_epoch = ? AND acknowledged = 0 AND device_seq >= ?
      ORDER BY device_seq ASC
      LIMIT ?;
    `).all(accountId, streamEpoch, expectedFirstSeq, Math.min(500, Math.max(1, maxItems)))

    if (!rows.length) {
      return { hasBatch: false, events: [] }
    }

    const events = []
    let expectedSeq = rows[0].device_seq
    let accumulatedBytes = 128

    for (const r of rows) {
      if (r.device_seq !== expectedSeq) {
        break
      }
      const ev = r.record_kind === 'discard'
        ? {
            eventId: r.event_id,
            deviceSeq: r.device_seq,
            recordKind: 'discard',
            payloadHash: r.payload_hash
          }
        : {
            eventId: r.event_id,
            deviceSeq: r.device_seq,
            recordKind: 'open',
            repoId: r.repo_id,
            occurredAt: r.occurred_at,
            source: r.source || 'browse',
            entrySource: r.entry_source || 'browse',
            payloadHash: r.payload_hash
          }
      const itemBytes = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 2
      if (events.length > 0 && (accumulatedBytes + itemBytes > maxBytes)) {
        break
      }
      events.push(ev)
      accumulatedBytes += itemBytes
      expectedSeq += 1
    }

    const firstSeq = events[0].deviceSeq
    const lastSeq = events[events.length - 1].deviceSeq
    let requestId = syncRow.in_flight_request_id
    if (!requestId || syncRow.in_flight_first_seq !== firstSeq || syncRow.in_flight_last_seq !== lastSeq) {
      requestId = 'req_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
      db.prepare(`
        UPDATE local_sync_state
        SET in_flight_request_id = ?, in_flight_first_seq = ?, in_flight_last_seq = ?
        WHERE account_id = ?;
      `).run(requestId, firstSeq, lastSeq, accountId)
    }

    return {
      hasBatch: true,
      requestId,
      streamEpoch,
      analysisEpoch,
      firstSeq,
      lastSeq,
      events
    }
  })
}

function applyOutboxAck(accountId, ackPayload = {}) {
  return withTransaction(() => {
    ensureAccountV3State(accountId)
    const syncRow = db.prepare('SELECT * FROM local_sync_state WHERE account_id = ?;').get(accountId)
    const streamEpoch = Number(ackPayload.streamEpoch || syncRow.stream_epoch)
    const analysisEpoch = Number(ackPayload.analysisEpoch || syncRow.analysis_epoch)
    const acceptedThrough = Math.max(syncRow.accepted_through || 0, Number(ackPayload.acceptedThrough || 0))
    const exportedThrough = Math.max(syncRow.exported_through || 0, Number(ackPayload.exportedThrough || 0))
    // 严格区分 acceptedThrough 与 processedThrough，绝不将上传 ACK 等同于已被离线画像消费
    const processedThrough = ackPayload.processedThrough !== undefined
      ? Math.max(syncRow.processed_through || 0, Number(ackPayload.processedThrough || 0))
      : (syncRow.processed_through || 0)
    const now = Date.now()

    db.prepare(`
      UPDATE event_outbox
      SET acknowledged = 1, payload_json = NULL, updated_at = ?
      WHERE account_id = ? AND stream_epoch = ? AND device_seq <= ?;
    `).run(now, accountId, streamEpoch, acceptedThrough)

    if (Array.isArray(ackPayload.timeAdjustments)) {
      const adjStmt = db.prepare(`
        UPDATE local_activity_events
        SET effective_at = ?, time_flag = ?
        WHERE account_id = ? AND event_id = ?;
      `)
      for (const adj of ackPayload.timeAdjustments) {
        if (adj && adj.eventId && adj.effectiveAt != null) {
          adjStmt.run(Number(adj.effectiveAt), String(adj.timeFlag || 'adjusted'), accountId, String(adj.eventId))
        }
      }
    }

    db.prepare(`
      UPDATE local_sync_state
      SET stream_epoch = ?,
          analysis_epoch = ?,
          accepted_through = ?,
          exported_through = ?,
          processed_through = ?,
          last_sync_at = ?,
          last_server_time = COALESCE(?, last_server_time),
          last_error_code = NULL,
          retry_at = NULL,
          in_flight_request_id = NULL,
          in_flight_first_seq = NULL,
          in_flight_last_seq = NULL
      WHERE account_id = ?;
    `).run(
      streamEpoch,
      analysisEpoch,
      acceptedThrough,
      exportedThrough,
      processedThrough,
      now,
      ackPayload.serverTime || null,
      accountId
    )

    return readCloudSyncState(accountId)
  })
}

function recordOutboxError(accountId, errorCode, retryAt = null) {
  ensureAccountV3State(accountId)
  db.prepare(`
    UPDATE local_sync_state
    SET last_error_code = ?, retry_at = ?
    WHERE account_id = ?;
  `).run(errorCode || null, retryAt || null, accountId)
  return readCloudSyncState(accountId)
}

function resetCloudAnalysisLocalState(accountId, newAnalysisEpoch) {
  return withTransaction(() => {
    ensureAccountV3State(accountId)
    const syncRow = db.prepare('SELECT * FROM local_sync_state WHERE account_id = ?;').get(accountId)
    const nextEpoch = Number(newAnalysisEpoch || ((syncRow?.analysis_epoch || 1) + 1))
    const now = Date.now()

    // 将旧 analysisEpoch 下尚未确认的上传项转为 discard 墓碑，保持 deviceSeq 连续且不泄漏旧周期数据
    convertPendingOutboxToDiscard(accountId, null)
    db.prepare(`
      UPDATE event_outbox
      SET analysis_epoch = ?, updated_at = ?
      WHERE account_id = ? AND acknowledged = 0;
    `).run(nextEpoch, now, accountId)

    db.prepare(`
      UPDATE cloud_account_state
      SET analysis_epoch = ?, updated_at = ?
      WHERE account_id = ?;
    `).run(nextEpoch, now, accountId)

    db.prepare(`
      UPDATE local_sync_state
      SET analysis_epoch = ?, processed_through = 0
      WHERE account_id = ?;
    `).run(nextEpoch, accountId)

    db.prepare('DELETE FROM cloud_collection_sync WHERE account_id = ?;').run(accountId)
    return readCloudSyncState(accountId)
  })
}

function readCollectionForCloudSync(accountId, collectionKind) {
  ensureAccountV3State(accountId)
  const localKind = collectionKind === 'stars' ? 'stars' : 'repos'
  const syncRow = db.prepare('SELECT * FROM sync_state WHERE account_id = ? AND kind = ?;').get(accountId, localKind)
  const cloudColl = db.prepare('SELECT * FROM cloud_collection_sync WHERE account_id = ? AND collection_kind = ?;').get(accountId, collectionKind)
  const cloudAcc = db.prepare('SELECT * FROM cloud_account_state WHERE account_id = ?;').get(accountId)

  const syncedRevision = cloudColl ? cloudColl.synced_revision : 0
  const syncedComplete = cloudColl ? Boolean(cloudColl.synced_complete) : false
  const syncedHash = cloudColl ? cloudColl.synced_hash : null
  const analysisEpoch = cloudAcc ? cloudAcc.analysis_epoch : 1

  if (!syncRow || !syncRow.active_generation || !syncRow.active_complete) {
    if (syncedComplete) {
      return {
        shouldUpload: false,
        reason: 'LOCAL_INCOMPLETE_PROTECT_COMPLETE_CLOUD',
        collectionKind,
        complete: false
      }
    }
    return {
      shouldUpload: false,
      reason: 'LOCAL_COLLECTION_NOT_COMPLETE',
      collectionKind,
      complete: false
    }
  }

  const cacheRows = db.prepare(`
    SELECT repository_json FROM repository_cache
    WHERE account_id = ? AND kind = ? AND generation_id = ?;
  `).all(accountId, localKind, syncRow.active_generation)

  const repoIdSet = new Set()
  for (const r of cacheRows) {
    try {
      const repo = JSON.parse(r.repository_json)
      if (repo && repo.visibility !== 'private' && !repo.private && repo.repoId) {
        repoIdSet.add(String(repo.repoId))
      }
    } catch (_) {}
  }

  const repoIds = Array.from(repoIdSet).sort()
  const snapshotHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ analysisEpoch, collectionKind, complete: true, repoIds }), 'utf8')
    .digest('hex')

  if (syncedComplete && syncedHash === snapshotHash) {
    return {
      shouldUpload: false,
      reason: 'UNCHANGED',
      collectionKind,
      complete: true,
      syncedRevision
    }
  }

  const operationId = `coll_${collectionKind}_${accountId}_r${syncedRevision + 1}_${snapshotHash.slice(0, 12)}`
  return {
    shouldUpload: true,
    operationId,
    expectedRevision: syncedRevision,
    analysisEpoch,
    collectionKind,
    complete: true,
    observedAt: syncRow.last_completed_at || Date.now(),
    repoIds,
    snapshotHash
  }
}

function markCollectionCloudSynced(accountId, collectionKind, result = {}) {
  return withTransaction(() => {
    const now = Date.now()
    const nextRevision = Number(result.revision ?? 0)
    const complete = result.complete !== false ? 1 : 0
    const snapshotHash = result.snapshotHash || null
    const operationId = result.operationId || null

    db.prepare(`
      INSERT INTO cloud_collection_sync (
        account_id, collection_kind, synced_revision, synced_complete, synced_hash, last_synced_at, last_operation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, collection_kind) DO UPDATE SET
        synced_revision = excluded.synced_revision,
        synced_complete = excluded.synced_complete,
        synced_hash = COALESCE(excluded.synced_hash, cloud_collection_sync.synced_hash),
        last_synced_at = excluded.last_synced_at,
        last_operation_id = COALESCE(excluded.last_operation_id, cloud_collection_sync.last_operation_id);
    `).run(accountId, collectionKind, nextRevision, complete, snapshotHash, now, operationId)

    return readCloudSyncState(accountId)
  })
}

function forgetAccount(accountId) {
  try {
    withTransaction(() => {
      const stmt = db.prepare('DELETE FROM accounts WHERE account_id = ?;')
      stmt.run(accountId)
    })
  } catch (err) {
    console.error('forgetAccount failed for accountId:', accountId, 'error:', err.message)
    const violations = db.prepare('PRAGMA foreign_key_check;').all()
    console.error('FK violations:', violations)
    throw err
  }
}

function readSetting(key) {
  const stmt = db.prepare('SELECT value_json FROM app_settings WHERE setting_key = ?;')
  const row = stmt.get(key)
  return row ? JSON.parse(row.value_json) : null
}

function saveSetting(key, value) {
  const json = JSON.stringify(value)
  const stmt = db.prepare(`
    INSERT INTO app_settings (setting_key, value_json)
    VALUES (?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json;
  `)
  stmt.run(key, json)
}

function readFeed(key) {
  const stmt = db.prepare('SELECT payload_json, fetched_at FROM feed_cache WHERE cache_key = ?;')
  const row = stmt.get(key)
  if (!row) return null
  return {
    items: JSON.parse(row.payload_json),
    fetchedAt: row.fetched_at,
    source: 'cache'
  }
}

function saveFeed(key, items, fetchedAt = Date.now()) {
  const json = JSON.stringify(items)
  const stmt = db.prepare(`
    INSERT INTO feed_cache (cache_key, payload_json, fetched_at)
    VALUES (?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at;
  `)
  stmt.run(key, json, fetchedAt)
}

// v2 领域操作: createSnapshot, commitRecommendation, listRecommendation, feedback, discovery, operations
function createSnapshot(accountId, purpose = 'ranking', reason = 'user_request') {
  return withTransaction(() => {
    const revisions = getAccountRevisions(accountId)
    const now = Date.now()
    const inputId = 'snap_' + now + '_' + Math.random().toString(36).slice(2, 8)

    const actExists = db.prepare('SELECT 1 FROM accounts WHERE account_id = ?;').get(accountId)
    if (actExists) {
      db.prepare(`
        INSERT OR REPLACE INTO recommendation_snapshots (
          input_id, account_id, purpose, input_versions_json, created_at, consumed
        ) VALUES (?, ?, ?, ?, ?, 0);
      `).run(inputId, accountId, purpose || 'ranking', JSON.stringify(revisions), now)
    }

    const starSync = db.prepare(`SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'stars';`).get(accountId)
    let starred = []
    if (starSync?.active_generation) {
      const rows = db.prepare(`SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ?;`).all(accountId, starSync.active_generation)
      starred = rows.map(r => JSON.parse(r.repository_json))
    }

    const repoSync = db.prepare(`SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'repos';`).get(accountId)
    let owned = []
    if (repoSync?.active_generation) {
      const rows = db.prepare(`SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = 'repos' AND generation_id = ?;`).all(accountId, repoSync.active_generation)
      owned = rows.map(r => JSON.parse(r.repository_json))
    }

    const prefRow = db.prepare('SELECT history_enabled, manual_tags_json FROM account_preferences WHERE account_id = ?;').get(accountId)
    const historyEnabled = prefRow ? Boolean(prefRow.history_enabled) : true
    const manualTags = prefRow ? JSON.parse(prefRow.manual_tags_json || '[]') : []

    let history = []
    if (historyEnabled) {
      const histRows = db.prepare(`SELECT * FROM browse_history WHERE account_id = ? ORDER BY last_viewed_at DESC LIMIT 5000;`).all(accountId)
      history = histRows.map(r => ({
        accountId: r.account_id,
        repoId: r.repo_id,
        repository: JSON.parse(r.repository_json),
        visitCount: r.visit_count,
        lastViewedAt: r.last_viewed_at,
        lastSource: r.last_source
      }))
    }

    const hiddenRows = db.prepare(`SELECT repo_id FROM recommendation_feedback WHERE account_id = ? AND hidden = 1;`).all(accountId)
    const hiddenRepoIds = hiddenRows.map(r => r.repo_id)

    const discRows = db.prepare(`SELECT result_json FROM discovery_cache WHERE account_id = ? AND expires_at > ?;`).all(accountId, now)
    const candidateMap = new Map()
    for (const d of discRows) {
      try {
        const items = JSON.parse(d.result_json)
        if (Array.isArray(items)) {
          for (const it of items) {
            const key = it.repoId || it.canonicalKey
            if (key && !candidateMap.has(key)) {
              candidateMap.set(key, it)
            }
          }
        }
      } catch (_) {}
    }
    const candidates = Array.from(candidateMap.values())

    return {
      inputId,
      inputVersions: revisions,
      accountId,
      purpose,
      reason,
      starred,
      owned,
      history,
      manualTags,
      hiddenRepoIds,
      historyEnabled,
      candidates
    }
  })
}

function commitRecommendation(accountId, inputId, inputVersions, purpose, profile, batch) {
  return withTransaction(() => {
    if (!accountId || !inputId || !purpose) {
      return { ok: false, error: 'INPUT_CHANGED' }
    }

    const currentRevisions = getAccountRevisions(accountId)
    const snapRow = db.prepare('SELECT * FROM recommendation_snapshots WHERE input_id = ?;').get(inputId)
    if (snapRow) {
      if (snapRow.account_id !== accountId || snapRow.purpose !== purpose || snapRow.consumed === 1) {
        return { ok: false, error: 'INPUT_CHANGED' }
      }
    } else {
      const hasAnySnap = db.prepare('SELECT 1 FROM recommendation_snapshots WHERE account_id = ? LIMIT 1;').get(accountId)
      if (hasAnySnap) {
        return { ok: false, error: 'INPUT_CHANGED' }
      }
    }

    const savedVersions = snapRow ? JSON.parse(snapRow.input_versions_json || '{}') : null
    const clientVersions = (inputVersions && typeof inputVersions === 'object') ? inputVersions : null
    if (!savedVersions && (!clientVersions || Object.keys(clientVersions).length === 0)) {
      return { ok: false, error: 'INPUT_CHANGED' }
    }

    const baselineVersions = savedVersions || clientVersions
    for (const [k, currentVal] of Object.entries(currentRevisions)) {
      if (baselineVersions[k] !== undefined && baselineVersions[k] !== currentVal) {
        return { ok: false, error: 'INPUT_CHANGED' }
      }
      if (clientVersions && clientVersions[k] !== undefined && clientVersions[k] !== currentVal) {
        return { ok: false, error: 'INPUT_CHANGED' }
      }
    }

    const now = Date.now()
    const effectiveVersionsJson = JSON.stringify(baselineVersions)

    if (purpose === 'profile') {
      if (!profile || typeof profile !== 'object') {
        return { ok: false, error: 'INVALID_PROFILE' }
      }
      const stmt = db.prepare(`
        INSERT INTO interest_profiles (account_id, model_version, input_versions_json, profile_json, generated_at)
        VALUES (?, 'content-v1', ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          model_version = excluded.model_version,
          input_versions_json = excluded.input_versions_json,
          profile_json = excluded.profile_json,
          generated_at = excluded.generated_at;
      `)
      stmt.run(accountId, effectiveVersionsJson, JSON.stringify(profile), now)
    } else if (purpose === 'ranking') {
      if (!batch || !batch.batchId || !Array.isArray(batch.items)) {
        return { ok: false, error: 'INVALID_BATCH' }
      }
      db.prepare(`DELETE FROM recommendation_batches WHERE account_id = ?;`).run(accountId)

      const insBatch = db.prepare(`
        INSERT INTO recommendation_batches (batch_id, account_id, model_version, input_versions_json, created_at, expires_at)
        VALUES (?, ?, 'content-v1', ?, ?, ?);
      `)
      insBatch.run(batch.batchId, accountId, effectiveVersionsJson, batch.createdAt || now, batch.expiresAt || (now + 86400000))

      const insItem = db.prepare(`
        INSERT OR REPLACE INTO recommendation_items (batch_id, position, repo_id, score, reasons_json, repository_json)
        VALUES (?, ?, ?, ?, ?, ?);
      `)
      for (const item of (batch.items || [])) {
        if (!item || !item.repository) continue
        const repoKey = item.repoId || item.repository.repoId || item.repository.canonicalKey
        if (!repoKey) continue
        insItem.run(
          batch.batchId,
          item.position,
          String(repoKey),
          item.score,
          JSON.stringify(item.reasons || []),
          JSON.stringify(item.repository)
        )
      }
    } else {
      return { ok: false, error: 'INVALID_PURPOSE' }
    }

    if (snapRow) {
      db.prepare('UPDATE recommendation_snapshots SET consumed = 1 WHERE input_id = ?;').run(inputId)
    }

    return { ok: true, committed: true }
  })
}

function listRecommendation(accountId, batchId = null, offset = 0, limit = 20) {
  let activeBatchId = batchId
  if (!activeBatchId) {
    const latest = db.prepare(`SELECT batch_id FROM recommendation_batches WHERE account_id = ? ORDER BY created_at DESC LIMIT 1;`).get(accountId)
    activeBatchId = latest?.batch_id || null
  }

  if (!activeBatchId) {
    return { items: [], total: 0, nextOffset: null, batchId: null }
  }

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM recommendation_items WHERE batch_id = ?;`).get(activeBatchId)
  const total = countRow ? countRow.total : 0

  const rows = db.prepare(`
    SELECT position, repo_id, score, reasons_json, repository_json
    FROM recommendation_items
    WHERE batch_id = ?
    ORDER BY position ASC
    LIMIT ? OFFSET ?;
  `).all(activeBatchId, limit, offset)

  const items = rows.map(r => ({
    position: r.position,
    repoId: r.repo_id,
    score: r.score,
    reasons: JSON.parse(r.reasons_json || '[]'),
    repository: JSON.parse(r.repository_json)
  }))

  const nextOffset = (offset + items.length < total) ? offset + items.length : null

  return {
    items,
    total,
    nextOffset,
    batchId: activeBatchId
  }
}

function recordRecommendationFeedback(accountId, repoId, kind, eventId) {
  withTransaction(() => {
    const now = Date.now()
    const hidden = kind === 'hide' ? 1 : 0
    const stmt = db.prepare(`
      INSERT INTO recommendation_feedback (account_id, repo_id, hidden, event_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, repo_id) DO UPDATE SET
        hidden = excluded.hidden,
        event_id = excluded.event_id,
        updated_at = excluded.updated_at;
    `)
    stmt.run(accountId, repoId, hidden, eventId, now)
    bumpRevision(accountId, 'feedback_revision')
  })
}

function saveDiscoveryCache(accountId, queryKey, queryJson, resultJson, fetchedAt, expiresAt) {
  withTransaction(() => {
    const stmt = db.prepare(`
      INSERT INTO discovery_cache (account_id, query_key, query_json, result_json, fetched_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, query_key) DO UPDATE SET
        query_json = excluded.query_json,
        result_json = excluded.result_json,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at;
    `)
    stmt.run(accountId, queryKey, queryJson, resultJson, fetchedAt, expiresAt)
    bumpRevision(accountId, 'discovery_revision')
  })
}

function readDiscoveryCache(accountId, queryKey) {
  const row = db.prepare(`SELECT result_json, fetched_at FROM discovery_cache WHERE account_id = ? AND query_key = ? AND expires_at > ?;`).get(accountId, queryKey, Date.now())
  if (!row) return null
  return {
    items: JSON.parse(row.result_json),
    fetchedAt: row.fetched_at
  }
}

function saveWebsiteOperation(op) {
  const stmt = db.prepare(`
    INSERT INTO website_operations (operation_id, account_id, repo_id, intent_id, desired_starred, state, attempted_at, confirmed_at, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, intent_id) DO UPDATE SET
      state = excluded.state,
      attempted_at = excluded.attempted_at,
      confirmed_at = excluded.confirmed_at,
      error_code = excluded.error_code;
  `)
  stmt.run(
    op.operationId,
    op.accountId,
    op.repoId,
    op.intentId,
    op.desiredStarred ? 1 : 0,
    op.state,
    op.attemptedAt || null,
    op.confirmedAt || null,
    op.errorCode || null
  )
}

function getWebsiteOperation(accountId, intentId) {
  return db.prepare('SELECT * FROM website_operations WHERE account_id = ? AND intent_id = ?;').get(accountId, intentId) || null
}

function updateWebsiteOperation(operationId, state, attemptedAt, confirmedAt, errorCode) {
  const stmt = db.prepare(`
    UPDATE website_operations
    SET state = ?, attempted_at = COALESCE(?, attempted_at), confirmed_at = COALESCE(?, confirmed_at), error_code = ?
    WHERE operation_id = ?;
  `)
  stmt.run(state, attemptedAt || null, confirmedAt || null, errorCode || null, operationId)
}

// 监听主进程消息分发
parentPort.on('message', (msg) => {
  const { id, operation, payload } = msg
  try {
    let result = null
    switch (operation) {
      case 'closeDatabase':
        db.close()
        parentPort.postMessage({ id, ok: true, data: null })
        parentPort.close()
        return
      case 'openDatabase':
        openDatabase(payload.dbPath)
        result = { ready: true }
        break
      case 'saveProfile':
        saveProfile(payload.accountId, payload.profile)
        break
      case 'readAccountSnapshot':
        result = readAccountSnapshot(payload.accountId)
        break
      case 'savePreferences':
        savePreferences(payload.accountId, payload.preferences)
        break
      case 'beginSync':
        result = beginSync(payload.accountId, payload.kind)
        break
      case 'writeSyncPage':
        result = writeSyncPage(payload.accountId, payload.kind, payload.generationId, payload.page ?? payload.pageSeq, payload.items, payload.nextPage ?? payload.nextUrl)
        break
      case 'finishSync':
        result = finishSync(payload.accountId, payload.kind, payload.generationId)
        break
      case 'abortSync':
        abortSync(payload.accountId, payload.kind, payload.generationId, payload.errorCode, payload.retryAt)
        break
      case 'listRepositories':
        result = listRepositories(payload.accountId, payload.kind, payload.offset, payload.limit)
        break
      case 'isRepositoryStarred':
        result = isRepositoryStarred(payload.accountId, payload.repoId)
        break
      case 'readStarState':
        result = readStarState(payload.accountId, payload.repoId, payload.fullName)
        break
      case 'applyConfirmedStar':
        applyConfirmedStar(payload.accountId, payload.repository, payload.starred)
        break
      case 'recordBrowse':
        result = recordBrowse(payload.accountId, payload.repository, payload.source, payload.viewedAt)
        break
      case 'listHistory':
        result = listHistory(payload.accountId, payload.cursor, payload.limit, payload.keyword)
        break
      case 'deleteHistory':
        deleteHistory(payload.accountId, payload.repoId)
        break
      case 'clearHistory':
        clearHistory(payload.accountId)
        break
      case 'countHistory':
        result = countHistory(payload.accountId)
        break
      case 'listLocalActivityEvents':
        result = listLocalActivityEvents(payload.accountId, payload.limit)
        break
      case 'readCloudSyncState':
        result = readCloudSyncState(payload.accountId)
        break
      case 'saveCloudAccountState':
        result = saveCloudAccountState(payload.accountId, payload.patch)
        break
      case 'syncCloudStreamState':
        result = syncCloudStreamState(payload.accountId, payload.serverState)
        break
      case 'readOutboxBatch':
        result = readOutboxBatch(payload.accountId, payload.maxItems, payload.maxBytes)
        break
      case 'applyOutboxAck':
        result = applyOutboxAck(payload.accountId, payload.ackPayload)
        break
      case 'recordOutboxError':
        result = recordOutboxError(payload.accountId, payload.errorCode, payload.retryAt)
        break
      case 'resetCloudAnalysisLocalState':
        result = resetCloudAnalysisLocalState(payload.accountId, payload.newAnalysisEpoch)
        break
      case 'readCollectionForCloudSync':
        result = readCollectionForCloudSync(payload.accountId, payload.collectionKind)
        break
      case 'markCollectionCloudSynced':
        result = markCollectionCloudSynced(payload.accountId, payload.collectionKind, payload.result)
        break
      case 'forgetAccount':
        forgetAccount(payload.accountId)
        break
      case 'readSetting':
        result = readSetting(payload.key)
        break
      case 'saveSetting':
        saveSetting(payload.key, payload.value)
        break
      case 'readFeed':
        result = readFeed(payload.key)
        break
      case 'saveFeed':
        saveFeed(payload.key, payload.items, payload.fetchedAt)
        break
      case 'createSnapshot':
        result = createSnapshot(payload.accountId, payload.purpose, payload.reason)
        break
      case 'commitRecommendation':
        result = commitRecommendation(payload.accountId, payload.inputId, payload.inputVersions, payload.purpose, payload.profile, payload.batch)
        break
      case 'listRecommendation':
        result = listRecommendation(payload.accountId, payload.batchId, payload.offset, payload.limit)
        break
      case 'recordRecommendationFeedback':
        recordRecommendationFeedback(payload.accountId, payload.repoId, payload.kind, payload.eventId)
        break
      case 'saveDiscoveryCache':
        saveDiscoveryCache(payload.accountId, payload.queryKey, payload.queryJson, payload.resultJson, payload.fetchedAt, payload.expiresAt)
        break
      case 'readDiscoveryCache':
        result = readDiscoveryCache(payload.accountId, payload.queryKey)
        break
      case 'saveWebsiteOperation':
        saveWebsiteOperation(payload.operation)
        break
      case 'getWebsiteOperation':
        result = getWebsiteOperation(payload.accountId, payload.intentId)
        break
      case 'updateWebsiteOperation':
        updateWebsiteOperation(payload.operationId, payload.state, payload.attemptedAt, payload.confirmedAt, payload.errorCode)
        break
      default:
        throw new Error(`UNKNOWN_DB_OPERATION: ${operation}`)
    }
    parentPort.postMessage({ id, ok: true, data: result })
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { message: `[${operation}] ${err.message}`, stack: err.stack } })
  }
})
