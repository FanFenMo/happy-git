import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const child = spawn(require('electron'), [fileURLToPath(new URL('../tests/regression.cjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => {
  if (code !== 0) { process.exitCode = code ?? 1; return }
  const configTests = spawn(process.execPath, ['--test', fileURLToPath(new URL('../tests/public-config.test.mjs', import.meta.url))], { stdio: 'inherit' })
  configTests.on('error', error => { console.error(error.message); process.exitCode = 1 })
  configTests.on('exit', result => { process.exitCode = result ?? 1 })
})
