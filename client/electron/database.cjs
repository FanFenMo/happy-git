/**
 * database.cjs
 * 运行在 Electron 主进程中，负责调度 database-worker.cjs
 */
const { Worker } = require('node:worker_threads')
const path = require('node:path')

let worker = null
let nextRequestId = 1
const pendingRequests = new Map()

function startDatabaseWorker(dbPath) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'database-worker.cjs')
    worker = new Worker(workerPath)

    worker.on('message', (msg) => {
      const { id, ok, data, error } = msg
      const req = pendingRequests.get(id)
      if (req) {
        pendingRequests.delete(id)
        if (ok) {
          req.resolve(data)
        } else {
          req.reject(new Error(error?.message || 'Database worker error'))
        }
      }
    })

    worker.on('error', (err) => {
      console.error('[database.cjs] Worker error:', err)
      for (const [id, req] of pendingRequests.entries()) {
        req.reject(err)
      }
      pendingRequests.clear()
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[database.cjs] Worker stopped with exit code ${code}`)
      }
    })

    callDatabase('openDatabase', { dbPath })
      .then(() => resolve())
      .catch((err) => reject(err))
  })
}

function callDatabase(operation, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      return reject(new Error('DATABASE_NOT_INITIALIZED'))
    }
    const id = nextRequestId++
    pendingRequests.set(id, { resolve, reject })
    worker.postMessage({ id, operation, payload })
  })
}

async function closeDatabaseWorker() {
  if (!worker) return
  try {
    await worker.terminate()
  } finally {
    worker = null
    pendingRequests.clear()
  }
}

module.exports = {
  startDatabaseWorker,
  callDatabase,
  closeDatabaseWorker
}
