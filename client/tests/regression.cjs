const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createRequire, registerHooks } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '../..');
const electronDir = path.join(root, 'client/electron');
const executionDir = path.join(root, 'client/release', `regression-${Date.now()}`);
fs.mkdirSync(executionDir, { recursive: true });
const db = require(path.join(electronDir, 'database.cjs'));
const results = [];
async function check(name, work) {
  try { const details = await work(); results.push({ name, pass: true, details }); }
  catch (error) { results.push({ name, pass: false, error: error.message }); }
  console.log(JSON.stringify(results.at(-1)));
}
const repo = (id, extra = {}) => ({ repoId: String(id), owner: 'fixture', name: `repo-${id}`, fullName: `fixture/repo-${id}`, description: 'validation repository', htmlUrl: `https://github.com/fixture/repo-${id}`, primaryLanguage: 'Java', topics: ['storage'], starCount: 2, forkCount: 0, isPrivate: false, licenseSpdx: 'MIT', updatedAt: Date.now(), ...extra });
const profile = (id) => ({ accountId: id, login: `fixture-${id}`, displayName: `Fixture ${id}`, publicRepoCount: 1, fetchedAt: Date.now() });
const dbPath = path.join(executionDir, 'database/happygit.db');
const call = (operation, payload) => db.callDatabase(operation, payload);
const seed = (sql, ...params) => { const c = new DatabaseSync(dbPath); try { c.prepare(sql).run(...params); } finally { c.close(); } };
function loadCjs(file, substitutions, globals = {}) {
  const ownRequire = createRequire(file);
  const sandbox = { module: { exports: {} }, exports: {}, require: (name) => Object.hasOwn(substitutions, name) ? substitutions[name] : ownRequire(name), __dirname: path.dirname(file), __filename: file, console: { log() {}, warn() {}, error() {} }, Buffer, URL, URLSearchParams, AbortController, AbortSignal, process, setTimeout, clearTimeout, ...globals };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}
function authFixture(name, options = {}) {
  const dataPath = path.join(executionDir, `auth-${name}`);
  let response = options.fetch || (async () => { throw new Error('no fixture response'); });
  const auth = loadCjs(path.join(electronDir, 'auth.cjs'), {
    electron: { safeStorage: { isEncryptionAvailable: () => options.encrypted !== false, encryptString: (s) => Buffer.from(`fixture-encrypted:${s}`), decryptString: (b) => b.toString().replace(/^fixture-encrypted:/, '') } },
    './github.cjs': { requestGitHub: async () => ({ status: 200, body: { id: 101, login: 'fixture-user', public_repos: 0 } }) }
  }, { fetch: (...args) => response(...args) });
  auth.initAuth(dataPath, { apiBaseUrl: options.missing ? '' : 'https://auth.example' });
  return { auth, dataPath, setResponse: (next) => { response = next; } };
}
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const authReply = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 28800 };
const beginReply = { challengeId: 'fixture-challenge', authorizationUrl: 'https://github.com/login/oauth/authorize?client_id=fixture', intervalMs: 1500 };
async function authorize(fixture, dbCall = async () => null) {
  fixture.setResponse(async url => url.endsWith('/begin') ? json(beginReply) : json({ state: 'authenticated', tokens: authReply }));
  const challenge = await fixture.auth.beginAuthorization();
  return fixture.auth.pollAuthorization(challenge.challengeId, dbCall);
}
async function main() {
  await db.startDatabaseWorker(dbPath);
  await check('database: create and save real-shaped profile', async () => { await call('saveProfile', { accountId: 'A', profile: profile('A') }); await call('saveProfile', { accountId: 'B', profile: profile('B') }); assert.equal((await call('readAccountSnapshot', { accountId: 'A' })).profile.accountId, 'A'); });
  const now = Date.now();
  await check('history: first visit and 30-second deduplication', async () => { const a = await call('recordBrowse', { accountId: 'A', repository: repo(1), viewedAt: now, source: 'trending' }); const b = await call('recordBrowse', { accountId: 'A', repository: repo(1), viewedAt: now + 1000, source: 'history' }); const c = await call('recordBrowse', { accountId: 'A', repository: repo(1), viewedAt: now + 31000, source: 'projects' }); assert.equal(a.visitCount, 1); assert.equal(b.visitCount, 1); assert.equal(c.visitCount, 2); assert.equal(await call('countHistory', { accountId: 'A' }), 1); });
  await check('history: accounts isolated', async () => { await call('recordBrowse', { accountId: 'B', repository: repo(2), viewedAt: now, source: 'stars' }); assert.equal((await call('listHistory', { accountId: 'B' })).items[0].repoId, '2'); assert.equal((await call('listHistory', { accountId: 'A' })).items[0].repoId, '1'); });
  await check('history: pagination, keyword and delete', async () => { for (let i = 3; i <= 37; i++) await call('recordBrowse', { accountId: 'A', repository: repo(i), viewedAt: now + i * 1000 }); const p1 = await call('listHistory', { accountId: 'A', limit: 30 }); const p2 = await call('listHistory', { accountId: 'A', limit: 30, cursor: p1.nextCursor }); assert.equal(p1.items.length, 30); assert.equal(p2.items.length, 6); assert.equal(new Set([...p1.items, ...p2.items].map((x) => x.repoId)).size, 36); const q = await call('listHistory', { accountId: 'A', keyword: 'repo-37' }); assert.equal(q.total, 1); await call('deleteHistory', { accountId: 'A', repoId: '37' }); assert.equal(await call('countHistory', { accountId: 'A' }), 35); });
  await check('history: restart persistence', async () => { await db.closeDatabaseWorker(); await db.startDatabaseWorker(dbPath); assert.equal(await call('countHistory', { accountId: 'A' }), 35); });
  await check('history: pruning old records', async () => { await call('saveProfile', { accountId: 'old', profile: profile('old') }); await call('recordBrowse', { accountId: 'old', repository: repo('old'), viewedAt: now - 91 * 86400000 }); await call('recordBrowse', { accountId: 'old', repository: repo('new'), viewedAt: now }); assert.equal(await call('countHistory', { accountId: 'old' }), 1); });
  await check('history: 5000-row cap', async () => { await call('saveProfile', { accountId: 'cap', profile: profile('cap') }); const c = new DatabaseSync(dbPath); try { c.exec('BEGIN'); const s = c.prepare('INSERT INTO browse_history(account_id,repo_id,full_name,repository_json,first_viewed_at,last_viewed_at,last_counted_at,visit_count,last_source) VALUES(?,?,?,?,?,?,?,?,?)'); for (let i = 0; i < 5001; i++) s.run('cap', String(i), `fixture/${i}`, JSON.stringify(repo(i)), now, now, now, 1, 'trending'); c.exec('COMMIT'); } finally { c.close(); } await call('recordBrowse', { accountId: 'cap', repository: repo('latest'), viewedAt: now + 1 }); assert.equal(await call('countHistory', { accountId: 'cap' }), 5000); });
  await check('sync: begin on embedded SQLite', async () => { const result = await call('beginSync', { accountId: 'A', kind: 'repos' }); assert.ok(result.generationId); });
  await check('sync: unfinished pagination cannot commit complete', async () => { seed('INSERT OR REPLACE INTO sync_state(account_id,kind,staging_generation,staging_next_page,staging_count) VALUES(?,?,?,?,?)', 'A', 'guard', 'fixture-stage', 2, 0); let rejected = false; try { await call('finishSync', { accountId: 'A', kind: 'guard', generationId: 'fixture-stage' }); } catch { rejected = true; } assert.ok(rejected, 'finishSync committed while next page is 2'); });
  await check('sync: out-of-order page rejected', async () => { seed('INSERT OR REPLACE INTO sync_state(account_id,kind,staging_generation,staging_next_page,staging_count) VALUES(?,?,?,?,?)', 'A', 'order', 'fixture-order', 1, 0); let rejected = false; try { await call('writeSyncPage', { accountId: 'A', kind: 'order', generationId: 'fixture-order', page: 99, items: [repo(99)], nextPage: null }); } catch { rejected = true; } assert.ok(rejected, 'accepted page 99 when page 1 was expected'); });
  await check('stars: confirmed Star is stored and idempotent', async () => { await call('applyConfirmedStar', { accountId: 'B', repository: repo(90), starred: true }); await call('applyConfirmedStar', { accountId: 'B', repository: repo(90), starred: true }); assert.equal((await call('listRepositories', { accountId: 'B', kind: 'stars' })).loadedCount, 1); });
  await check('history: clear does not affect other account', async () => { await call('clearHistory', { accountId: 'A' }); assert.equal(await call('countHistory', { accountId: 'A' }), 0); assert.equal(await call('countHistory', { accountId: 'B' }), 1); });
  await check('account: forget cascades local records', async () => { await call('forgetAccount', { accountId: 'cap' }); assert.equal(await call('countHistory', { accountId: 'cap' }), 0); assert.equal((await call('readAccountSnapshot', { accountId: 'cap' })).profile, null); });
  await check('auth: missing authorization service fails explicitly', async () => { const f = authFixture('missing', { missing: true }); await assert.rejects(() => f.auth.beginAuthorization(''), error => error.code === 'CONFIG_MISSING'); });
  await check('auth: native response uses authenticated state', async () => { const f = authFixture('contract'); const result = await authorize(f); assert.equal(result.state, 'authenticated'); assert.equal(result.session.accountId, '101'); return { state: result.state, status: result.status ?? null }; });
  await check('auth: cancellation prevents late login', async () => {
    const f = authFixture('cancel'); let finish;
    f.setResponse(async url => url.endsWith('/begin') ? json(beginReply) : url.endsWith('/cancel') ? json({ state: 'cancelled' }) : await new Promise(resolve => { finish = () => resolve(json({ state: 'authenticated', tokens: authReply })); }));
    const ch = await f.auth.beginAuthorization(); const pending = f.auth.pollAuthorization(ch.challengeId, async () => null);
    f.auth.cancelAuthorization(ch.challengeId); finish();
    assert.notEqual((await pending).state, 'authenticated'); assert.equal(f.auth.getCurrentAccountId(), null);
  });
  await check('auth: unavailable safe storage never saves plaintext', async () => {
    const f = authFixture('plaintext', { encrypted: false });
    await assert.rejects(() => authorize(f), error => error.code === 'STORAGE_UNAVAILABLE');
    assert.equal(fs.existsSync(path.join(f.dataPath, 'auth/credentials.bin')), false);
  });
  await check('IPC: stale account context cannot write B history', async () => { let ipcHandler; let startup; let win; class FakeWindow { constructor() { win = this; this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {} }; } loadFile() { return Promise.resolve(); } static getAllWindows() { return [win]; } } const electronStub = { app: { getPath: () => __dirname, setPath() {}, requestSingleInstanceLock: () => true, setAsDefaultProtocolClient() {}, whenReady: () => ({ then: (fn) => { startup = fn(); } }), on() {}, quit() {} }, BrowserWindow: FakeWindow, Menu: { setApplicationMenu() {} }, shell: { openExternal: async () => {} }, ipcMain: { handle: (channel, fn) => { ipcHandler = fn; } } }; loadCjs(path.join(electronDir, 'main.cjs'), { electron: electronStub, './database.cjs': { startDatabaseWorker: async () => {}, callDatabase: call, closeDatabaseWorker: async () => {} }, './auth.cjs': { initAuth() {}, getCurrentAccountId: () => 'B', getContextId: () => 'context-B', assertContext: expected => { if (expected !== 'context-B') throw Object.assign(new Error('stale context'), { code: 'SESSION_CHANGED' }); }, getStatus: () => 'authenticated' }, './github.cjs': { requestGitHub: async () => null } }); await startup; const r = await ipcHandler({ senderFrame: win.webContents.mainFrame }, { operation: 'history.record', contextId: 'old-context-A', payload: { repository: repo('stale-A'), source: 'trending' } }); assert.equal(r.ok, false, 'stale context accepted; A request was written into B account'); });
  await db.closeDatabaseWorker();
  registerHooks({ resolve(specifier, context, nextResolve) { if (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(path.join(root, 'client/src')).href)) { const base = new URL(specifier, context.parentURL); const p = fileURLToPath(base); if (fs.existsSync(`${p}.js`)) return { url: pathToFileURL(`${p}.js`).href, shortCircuit: true }; if (fs.existsSync(path.join(p, 'index.js'))) return { url: pathToFileURL(path.join(p, 'index.js')).href, shortCircuit: true }; } return nextResolve(specifier, context); } });
  let bridgeHandler = async () => ({ ok: false, error: { message: 'fixture handler absent' } });
  global.window = { happyGit: { invoke: (...args) => bridgeHandler(...args) } };
  const account = await import(pathToFileURL(path.join(root, 'client/src/services/account.js')).href);
  const { nativeBridge } = await import(pathToFileURL(path.join(root, 'client/src/platform/index.js')).href);
  const models = await import(pathToFileURL(path.join(root, 'client/src/models/github.js')).href);
  await check('models: canonical cache preserves license', async () => { assert.equal(models.normalizeTrendingRepository(repo(100), 'cache').licenseSpdx, 'MIT'); });
  await check('interests: weights and manual priority', async () => { assert.deepEqual(account.deriveInterestTags([repo(1, { primaryLanguage: 'Java', topics: [] })], [repo(2, { primaryLanguage: 'Python', topics: [] })], [' Vue ', 'vue']), ['Vue', 'Java', 'Python']); });
  await check('stars: per-account state cache isolation', async () => { let accountKey = 'A'; nativeBridge.setContext('A'); bridgeHandler = async (op) => op === 'repositories.isStarred' ? { ok: true, data: { known: true, starred: accountKey === 'A' } } : { ok: false }; assert.equal(await account.getStarState(repo('shared')), true); accountKey = 'B'; nativeBridge.setContext('B'); assert.equal(await account.getStarState(repo('shared')), false, 'account B reused account A in-memory Star state'); });
  const { setActivePinia, createPinia } = await import(pathToFileURL(path.join(root, 'client/node_modules/pinia/dist/pinia.js')).href);
  const { useUserStore } = await import(pathToFileURL(path.join(root, 'client/src/stores/user.js')).href);
  await check('login store: accepts native authenticated state', async () => {
    setActivePinia(createPinia()); const store = useUserStore();
    store.applySession({ status: 'guest', accountId: null, contextId: 'before-login', profile: null });
    store.authStage = 'waiting'; store.loginChallenge = { challengeId: 'fixture-login' };
    const originalTimeout = global.setTimeout; global.setTimeout = fn => { queueMicrotask(fn); return 0; };
    bridgeHandler = async op => {
      if (op === 'auth.poll') return { ok: true, data: { state: 'authenticated', session: { status: 'authenticated', accountId: '101', contextId: 'after-login', profile: profile('101') } } };
      if (op === 'account.readSnapshot') return { ok: true, data: { profile: profile('101'), preferences: { historyEnabled: true, manualTags: [] }, repoSync: { complete: true, lastSyncedAt: Date.now() }, starSync: { complete: true, lastSyncedAt: Date.now() } } };
      return { ok: true, data: { items: [], total: 0, nextOffset: null, nextCursor: null } };
    };
    try { await store.pollLoginStatus('fixture-login', store.loginSequence, 0); assert.equal(store.session.accountId, '101'); assert.equal(nativeBridge.contextId, 'after-login'); }
    finally { global.setTimeout = originalTimeout; }
  });
  await check('sync: active cache survives failed refresh and restart', async () => {
    await db.startDatabaseWorker(dbPath);
    let gen = (await call('beginSync', { accountId: 'B', kind: 'repos' })).generationId;
    await call('writeSyncPage', { accountId: 'B', kind: 'repos', generationId: gen, page: 1, items: [repo('active')], nextPage: null });
    await call('finishSync', { accountId: 'B', kind: 'repos', generationId: gen });
    const stale = gen; gen = (await call('beginSync', { accountId: 'B', kind: 'repos' })).generationId;
    await call('abortSync', { accountId: 'B', kind: 'repos', generationId: stale });
    assert.equal((await call('listRepositories', { accountId: 'B', kind: 'repos' })).items[0].repoId, 'active');
    await db.closeDatabaseWorker(); await db.startDatabaseWorker(dbPath);
    assert.equal((await call('listRepositories', { accountId: 'B', kind: 'repos' })).items[0].repoId, 'active');
    assert.equal((await call('readAccountSnapshot', { accountId: 'B' })).repoSync.status, 'ready');
    await db.closeDatabaseWorker();
  });
  await check('stars: unknown HTTP state is never cached as false', async () => {
    nativeBridge.setContext('unknown-star');
    bridgeHandler = async op => op === 'repositories.isStarred' ? { ok: true, data: { known: false } } : { ok: true, data: { status: 403, headers: {} } };
    assert.equal(await account.getStarState(repo('unknown')), null);
  });
  await check('stars: 204 commits; cache failure reports remote success', async () => {
    nativeBridge.setContext('star-write'); let remote = false;
    bridgeHandler = async (op, payload) => {
      if (op === 'github.request') { remote = payload.resource === 'addStar'; return { ok: true, data: { status: 204 } }; }
      return { ok: false, error: { code: 'DISK_FULL', message: 'disk full' } };
    };
    const result = await account.setStar(repo('write'), true);
    assert.equal(remote, true); assert.equal(result.success, true); assert.equal(result.cacheSaved, false); assert.ok(result.warning);
  });
  await check('stars: timeout reconciles remote state without repeating PUT', async () => {
    nativeBridge.setContext('timeout-star'); const resources = [];
    bridgeHandler = async (op, payload) => {
      if (op !== 'github.request') return { ok: true, data: {} };
      resources.push(payload.resource);
      return payload.resource === 'addStar' ? { ok: false, error: { message: 'timeout' } } : { ok: true, data: { status: 204 } };
    };
    assert.equal((await account.setStar(repo('timeout'), true)).success, true);
    assert.deepEqual(resources, ['addStar', 'starState']);
  });
  await check('bridge: late account result is discarded after switching', async () => {
    nativeBridge.setContext('old'); let finish;
    bridgeHandler = () => new Promise(resolve => { finish = resolve; });
    const pending = nativeBridge.invoke('history.list'); nativeBridge.setContext('new');
    finish({ ok: true, data: { items: [repo('old')] } });
    assert.equal((await pending).error.code, 'SESSION_CHANGED');
  });
  await check('pagination: 75 stars display total and load all pages', async () => {
    setActivePinia(createPinia()); const store = useUserStore(); store.applySession({ status: 'offline', accountId: 'P', contextId: 'pagination', profile: profile('P') });
    bridgeHandler = async (op, payload) => ({ ok: true, data: { items: Array.from({ length: Math.min(payload.limit, 75 - payload.offset) }, (_, i) => repo(payload.offset + i)), total: 75, nextOffset: payload.offset + payload.limit < 75 ? payload.offset + payload.limit : null } });
    await store.loadCollection('stars'); assert.equal(store.stars.length, 30); assert.equal(store.starPage.total, 75); assert.equal(store.interestStars.length, 75);
    await store.loadCollection('stars', true); await store.loadCollection('stars', true); assert.equal(store.stars.length, 75); assert.equal(store.starPage.nextOffset, null);
  });
  await check('preferences: manual tags preserve disabled history', async () => {
    nativeBridge.setContext('preferences'); let saved;
    bridgeHandler = async (op, payload) => {
      if (op === 'account.readSnapshot') return { ok: true, data: { preferences: { historyEnabled: false } } };
      saved = payload; return { ok: true, data: {} };
    };
    assert.deepEqual(await account.saveInterestPreferences([' Vue ', 'vue', 'Java']), ['Vue', 'Java']);
    assert.equal(saved.historyEnabled, false);
  });
  await check('stars: first mutation after aborted initial sync creates visible cache', async () => {
    await db.startDatabaseWorker(dbPath);
    await call('saveProfile', { accountId: 'first-star', profile: profile('first-star') });
    const generationId = (await call('beginSync', { accountId: 'first-star', kind: 'stars' })).generationId;
    await call('abortSync', { accountId: 'first-star', kind: 'stars', generationId });
    await call('applyConfirmedStar', { accountId: 'first-star', repository: repo('first-star'), starred: true });
    assert.equal((await call('listRepositories', { accountId: 'first-star', kind: 'stars' })).items[0].repoId, 'first-star');
    await db.closeDatabaseWorker();
  });
  await check('stars: late state query cannot overwrite confirmed write', async () => {
    nativeBridge.setContext('late-query'); let answer;
    bridgeHandler = async (op, payload) => {
      if (op === 'repositories.isStarred') return { ok: true, data: { known: false } };
      if (op === 'github.request' && payload.resource === 'starState') return new Promise(resolve => { answer = resolve; });
      return { ok: true, data: { status: 204 } };
    };
    const querying = account.getStarState(repo('late'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await account.setStar(repo('late'), true)).success, true);
    answer({ ok: true, data: { status: 404 } });
    assert.equal(await querying, true);
    assert.equal(await account.getStarState(repo('late')), true);
  });
  fs.writeFileSync(path.join(executionDir, 'results.json'), JSON.stringify({  runtime: process.versions, passed: results.filter((x) => x.pass).length, failed: results.filter((x) => !x.pass).length, results }, null, 2));
  process.exitCode = results.some(x => !x.pass) ? 1 : 0;
  console.log(JSON.stringify({ executionDir, passed: results.filter((x) => x.pass).length, failed: results.filter((x) => !x.pass).length }));
}
main().catch(async (err) => { console.error(err); await db.closeDatabaseWorker(); process.exitCode = 1; });
