/**
 * database-worker.cjs
 * 运行在 Node worker_threads 中，持有唯一 DatabaseSync 连接
 * 执行 SQLite 建表、v2增量迁移与领域操作 (依据 project.md 第八节与第九节)
 */
const { parentPort } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const path = require('node:path')
const fs = require('node:fs')

let db = null

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
    db.exec('PRAGMA user_version = 2;')
  } else if (userVersion === 1) {
    migrateV1ToV2()
    db.exec('PRAGMA user_version = 2;')
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

    CREATE INDEX IF NOT EXISTS idx_website_operations_account_state
      ON website_operations(account_id, state);
    CREATE INDEX IF NOT EXISTS idx_recommendation_batches_account_time
      ON recommendation_batches(account_id, created_at DESC);
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

function withTransaction(work) {
  db.exec('BEGIN IMMEDIATE;')
  try {
    const result = work()
    db.exec('COMMIT;')
    return result
  } catch (err) {
    db.exec('ROLLBACK;')
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

    bumpRevision(accountId, 'profile_revision')
  })
}

function readAccountSnapshot(accountId) {
  const actStmt = db.prepare('SELECT profile_json FROM accounts WHERE account_id = ?;')
  const act = actStmt.get(accountId)
  const profile = act ? JSON.parse(act.profile_json) : null

  const prefStmt = db.prepare('SELECT history_enabled, manual_tags_json FROM account_preferences WHERE account_id = ?;')
  const pref = prefStmt.get(accountId)
  const preferences = pref
    ? { historyEnabled: Boolean(pref.history_enabled), manualTags: JSON.parse(pref.manual_tags_json || '[]') }
    : { historyEnabled: true, manualTags: [] }

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
    revisions: getAccountRevisions(accountId)
  }
}

function savePreferences(accountId, preferences) {
  const manualJson = JSON.stringify(preferences.manualTags || [])
  const historyVal = preferences.historyEnabled ? 1 : 0
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

    // 更新 star_state 表
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

  // 检查 active stars cache
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
    const repoKey = repository.repoId || repository.canonicalKey
    const selStmt = db.prepare('SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?;')
    const old = selStmt.get(accountId, repoKey)

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
      const shouldCount = (viewedAt - old.last_counted_at) >= 30000
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
      lastSource: finalRow.last_source
    }
  })
}

function pruneHistory(accountId, now = Date.now()) {
  const ninetyDaysAgo = now - (90 * 24 * 60 * 60 * 1000)
  const delOldStmt = db.prepare('DELETE FROM browse_history WHERE account_id = ? AND last_viewed_at < ?;')
  delOldStmt.run(accountId, ninetyDaysAgo)

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

function deleteHistory(accountId, repoId) {
  withTransaction(() => {
    const stmt = db.prepare('DELETE FROM browse_history WHERE account_id = ? AND repo_id = ?;')
    stmt.run(accountId, repoId)
    bumpRevision(accountId, 'history_revision')
    db.prepare('DELETE FROM interest_profiles WHERE account_id = ?;').run(accountId)
    db.prepare('DELETE FROM recommendation_batches WHERE account_id = ?;').run(accountId)
  })
}

function clearHistory(accountId) {
  withTransaction(() => {
    const stmt = db.prepare('DELETE FROM browse_history WHERE account_id = ?;')
    stmt.run(accountId)
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
function createSnapshot(accountId, purpose, reason) {
  return withTransaction(() => {
    const revisions = getAccountRevisions(accountId)
    const inputId = 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)

    // 读取 Star 活跃集合
    const starSync = db.prepare(`SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'stars';`).get(accountId)
    let starred = []
    if (starSync?.active_generation) {
      const rows = db.prepare(`SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = 'stars' AND generation_id = ?;`).all(accountId, starSync.active_generation)
      starred = rows.map(r => JSON.parse(r.repository_json))
    }

    // 读取本人仓库活跃集合
    const repoSync = db.prepare(`SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = 'repos';`).get(accountId)
    let owned = []
    if (repoSync?.active_generation) {
      const rows = db.prepare(`SELECT repository_json FROM repository_cache WHERE account_id = ? AND kind = 'repos' AND generation_id = ?;`).all(accountId, repoSync.active_generation)
      owned = rows.map(r => JSON.parse(r.repository_json))
    }

    // 读取偏好
    const prefRow = db.prepare('SELECT history_enabled, manual_tags_json FROM account_preferences WHERE account_id = ?;').get(accountId)
    const historyEnabled = prefRow ? Boolean(prefRow.history_enabled) : true
    const manualTags = prefRow ? JSON.parse(prefRow.manual_tags_json || '[]') : []

    // 读取历史 (最多 5000)
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

    // 读取隐藏项
    const hiddenRows = db.prepare(`SELECT repo_id FROM recommendation_feedback WHERE account_id = ? AND hidden = 1;`).all(accountId)
    const hiddenRepoIds = hiddenRows.map(r => r.repo_id)

    // 读取候选 (来自 discovery_cache)
    const now = Date.now()
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
    const currentRevisions = getAccountRevisions(accountId)
    // 检查版本是否变更
    for (const [k, v] of Object.entries(inputVersions || {})) {
      if (currentRevisions[k] !== undefined && currentRevisions[k] !== v) {
        return { ok: false, error: 'INPUT_CHANGED' }
      }
    }

    const now = Date.now()
    if (purpose === 'profile' && profile) {
      const stmt = db.prepare(`
        INSERT INTO interest_profiles (account_id, model_version, input_versions_json, profile_json, generated_at)
        VALUES (?, 'content-v1', ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          model_version = excluded.model_version,
          input_versions_json = excluded.input_versions_json,
          profile_json = excluded.profile_json,
          generated_at = excluded.generated_at;
      `)
      stmt.run(accountId, JSON.stringify(inputVersions), JSON.stringify(profile), now)
    } else if (purpose === 'ranking' && batch) {
      // 删除旧批次
      db.prepare(`DELETE FROM recommendation_batches WHERE account_id = ?;`).run(accountId)

      const insBatch = db.prepare(`
        INSERT INTO recommendation_batches (batch_id, account_id, model_version, input_versions_json, created_at, expires_at)
        VALUES (?, ?, 'content-v1', ?, ?, ?);
      `)
      insBatch.run(batch.batchId, accountId, JSON.stringify(inputVersions), batch.createdAt || now, batch.expiresAt || (now + 86400000))

      const insItem = db.prepare(`
        INSERT OR REPLACE INTO recommendation_items (batch_id, position, repo_id, score, reasons_json, repository_json)
        VALUES (?, ?, ?, ?, ?, ?);
      `)
      for (const item of (batch.items || [])) {
        insItem.run(
          batch.batchId,
          item.position,
          item.repoId,
          item.score,
          JSON.stringify(item.reasons || []),
          JSON.stringify(item.repository)
        )
      }
    }

    return { ok: true }
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
