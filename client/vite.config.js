import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import net from 'node:net'

// 默认端口与备用端口列表 (默认: 8090，备用1: 8091，备用2: 8092)
const CANDIDATE_PORTS = [8090, 8091, 8092]

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '0.0.0.0')
  })
}

async function resolvePort() {
  for (const port of CANDIDATE_PORTS) {
    const available = await isPortAvailable(port)
    if (available) {
      return port
    }
    console.warn(`[Vite Port Switch] 端口 ${port} 已被占用，尝试切换至下一备用端口...`)
  }
  return CANDIDATE_PORTS[0]
}

// https://vite.dev/config/
export default defineConfig(async () => {
  const port = await resolvePort()

  return {
    plugins: [
      vue(),
      tailwindcss(),
    ],
    server: {
      port,
      strictPort: false, // 兜底策略：若备用端口均占用，自动顺延寻找空闲端口
      host: true
    }
  }
})
