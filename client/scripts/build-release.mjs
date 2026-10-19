import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

execSync('npm run build', {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: { ...process.env, HAPPYGIT_RELEASE: '1' },
  stdio: 'inherit'
})
