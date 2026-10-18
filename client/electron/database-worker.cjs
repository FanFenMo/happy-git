/**
 * database-worker.cjs
 * 运行在 Node worker_threads 中，持有唯一 DatabaseSync 连接
 * 执行 SQLite 建表、迁移与领域操作
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

  initTables()
}

function initTables() {
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
    } else {
      const updStmt = db.prepare(`
        UPDATE accounts
        SET login = ?, profile_json = ?, profile_synced_at = ?
        WHERE account_id = ?;
      `)
      updStmt.run(profile.login, profileJson, now, accountId)
    }
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
    starSync: findSync('stars')
  }
}

function savePreferences(accountId, preferences) {
  const manualJson = JSON.stringify(preferences.manualTags || [])
  const historyVal = preferences.historyEnabled ? 1 : 0
  const now = Date.now()
  const stmt = db.prepare(`
    INSERT INTO account_preferences (account_id, history_enabled, manual_tags_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      history_enabled = excluded.history_enabled,
      manual_tags_json = excluded.manual_tags_json,
      updated_at = excluded.updated_at;
  `)
  stmt.run(accountId, historyVal, manualJson, now)
}

function beginSync(accountId, kind) {
  const generationId = 'gen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  withTransaction(() => {
    // 清理该账号该 kind 的旧临时数据
    const delStmt = db.prepare('DELETE FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id LIKE "gen_%";')
    delStmt.run(accountId, kind)

    const syncStmt = db.prepare(`
      INSERT INTO sync_state (account_id, kind, staging_generation, staging_next_page, staging_count)
      VALUES (?, ?, ?, 1, 0)
      ON CONFLICT(account_id, kind) DO UPDATE SET
        staging_generation = excluded.staging_generation,
        staging_next_page = 1,
        staging_count = 0;
    `)
    syncStmt.run(accountId, kind, generationId)
  })
  return { generationId }
}

function writeSyncPage(accountId, kind, generationId, page, items, nextPage) {
  return withTransaction(() => {
    const stateStmt = db.prepare('SELECT staging_generation FROM sync_state WHERE account_id = ? AND kind = ?;')
    const state = stateStmt.get(accountId, kind)
    if (!state || state.staging_generation !== generationId) {
      throw new Error('SYNC_GENERATION_MISMATCH')
    }

    const insStmt = db.prepare(`
      INSERT OR REPLACE INTO repository_cache (account_id, kind, generation_id, repo_id, sort_time, repository_json)
      VALUES (?, ?, ?, ?, ?, ?);
    `)

    for (const item of items) {
      const sortTime = item.starredAt || item.updatedAt || item.createdAt || Date.now()
      insStmt.run(accountId, kind, generationId, item.repoId, sortTime, JSON.stringify(item))
    }

    const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id = ?;')
    const countRow = countStmt.get(accountId, kind, generationId)
    const stagingCount = countRow ? countRow.cnt : 0

    const updStmt = db.prepare(`
      UPDATE sync_state
      SET staging_count = ?, staging_next_page = ?
      WHERE account_id = ? AND kind = ?;
    `)
    updStmt.run(stagingCount, nextPage || null, accountId, kind)

    return {
      kind,
      loadedCount: stagingCount,
      nextPage
    }
  })
}

function finishSync(accountId, kind, generationId) {
  return withTransaction(() => {
    const stateStmt = db.prepare('SELECT staging_generation, staging_count FROM sync_state WHERE account_id = ? AND kind = ?;')
    const state = stateStmt.get(accountId, kind)
    if (!state || state.staging_generation !== generationId) {
      throw new Error('SYNC_GENERATION_MISMATCH')
    }

    // 删除旧的 active generation 数据
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
          staging_count = 0,
          last_completed_at = ?,
          last_error_code = NULL,
          retry_at = NULL
      WHERE account_id = ? AND kind = ?;
    `)
    updStmt.run(now, accountId, kind)

    return {
      kind,
      count: state.staging_count,
      complete: true,
      syncedAt: now
    }
  })
}

function abortSync(accountId, kind, generationId, errorCode = null, retryAt = null) {
  withTransaction(() => {
    const delStmt = db.prepare('DELETE FROM repository_cache WHERE account_id = ? AND kind = ? AND generation_id = ?;')
    delStmt.run(accountId, kind, generationId)

    const updStmt = db.prepare(`
      UPDATE sync_state
      SET staging_generation = NULL,
          staging_next_page = NULL,
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
  const nextOffset = items.length === limit ? offset + limit : null

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
    const syncStmt = db.prepare('SELECT active_generation FROM sync_state WHERE account_id = ? AND kind = "stars";')
    const syncState = syncStmt.get(accountId)
    let activeGen = syncState?.active_generation
    if (!activeGen) {
      activeGen = 'active_stars_local'
      const initStmt = db.prepare(`
        INSERT OR IGNORE INTO sync_state (account_id, kind, active_generation, active_complete, active_count)
        VALUES (?, "stars", ?, 0, 0);
      `)
      initStmt.run(accountId, activeGen)
    }

    if (starred) {
      const insStmt = db.prepare(`
        INSERT OR REPLACE INTO repository_cache (account_id, kind, generation_id, repo_id, sort_time, repository_json)
        VALUES (?, "stars", ?, ?, ?, ?);
      `)
      insStmt.run(accountId, activeGen, repository.repoId, Date.now(), JSON.stringify(repository))
    } else {
      const delStmt = db.prepare('DELETE FROM repository_cache WHERE account_id = ? AND kind = "stars" AND generation_id = ? AND repo_id = ?;')
      delStmt.run(accountId, activeGen, repository.repoId)
    }

    const countStmt = db.prepare('SELECT COUNT(*) as cnt FROM repository_cache WHERE account_id = ? AND kind = "stars" AND generation_id = ?;')
    const countRow = countStmt.get(accountId, activeGen)
    const newCount = countRow ? countRow.cnt : 0

    const updStmt = db.prepare('UPDATE sync_state SET active_count = ? WHERE account_id = ? AND kind = "stars";')
    updStmt.run(newCount, accountId)
  })
}

function isRepositoryStarred(accountId, repoId) {
  const syncStmt = db.prepare('SELECT active_generation, active_complete FROM sync_state WHERE account_id = ? AND kind = "stars";')
  const syncState = syncStmt.get(accountId)
  if (!syncState || !syncState.active_generation) {
    return { known: false, starred: false }
  }
  const checkStmt = db.prepare('SELECT 1 FROM repository_cache WHERE account_id = ? AND kind = "stars" AND generation_id = ? AND repo_id = ?;')
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
    const selStmt = db.prepare('SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?;')
    const old = selStmt.get(accountId, repository.repoId)

    if (!old) {
      const insStmt = db.prepare(`
        INSERT INTO browse_history (
          account_id, repo_id, full_name, description, repository_json,
          first_viewed_at, last_viewed_at, last_counted_at, visit_count, last_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?);
      `)
      insStmt.run(
        accountId, repository.repoId, repository.fullName, repository.description || null,
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
        nextViewedAt, nextCountedAt, nextCount, source, accountId, repository.repoId
      )
    }

    pruneHistory(accountId, viewedAt)

    const finalStmt = db.prepare('SELECT * FROM browse_history WHERE account_id = ? AND repo_id = ?;')
    const finalRow = finalStmt.get(accountId, repository.repoId)
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

  // 每账号最多 5000 个不同仓库
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
  let querySql = `
    SELECT * FROM browse_history
    WHERE account_id = ?
  `
  const params = [accountId]

  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
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

  // 统计 total
  let countSql = 'SELECT COUNT(*) as total FROM browse_history WHERE account_id = ?'
  const countParams = [accountId]
  if (keyword && keyword.trim()) {
    const kw = `%${keyword.trim().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`
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
  const stmt = db.prepare('DELETE FROM browse_history WHERE account_id = ? AND repo_id = ?;')
  stmt.run(accountId, repoId)
}

function clearHistory(accountId) {
  const stmt = db.prepare('DELETE FROM browse_history WHERE account_id = ?;')
  stmt.run(accountId)
}

function countHistory(accountId) {
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM browse_history WHERE account_id = ?;')
  const row = stmt.get(accountId)
  return row ? row.cnt : 0
}

function forgetAccount(accountId) {
  withTransaction(() => {
    const stmt = db.prepare('DELETE FROM accounts WHERE account_id = ?;')
    stmt.run(accountId)
  })
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

// 监听主进程消息分发
parentPort.on('message', (msg) => {
  const { id, operation, payload } = msg
  try {
    let result = null
    switch (operation) {
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
        result = writeSyncPage(payload.accountId, payload.kind, payload.generationId, payload.page, payload.items, payload.nextPage)
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
      default:
        throw new Error(`UNKNOWN_DB_OPERATION: ${operation}`)
    }
    parentPort.postMessage({ id, ok: true, data: result })
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { message: err.message, stack: err.stack } })
  }
})
