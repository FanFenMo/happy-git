<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
    <div class="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl relative">
      <!-- Header -->
      <div class="flex items-center justify-between pb-4 border-b border-zinc-800 mb-5">
        <h3 class="text-lg font-bold text-white flex items-center gap-2">
          <span>⚙️</span> 系统设置
        </h3>
        <button @click="$emit('close')" class="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Settings List -->
      <div class="space-y-4">
        <!-- Backend & Hadoop Status -->
        <div class="p-4 rounded-2xl bg-zinc-950/70 border border-zinc-800/80">
          <div class="text-xs font-semibold text-zinc-400 mb-2">计算引擎与集群状态</div>
          <div class="flex items-center justify-between text-sm py-1 border-b border-zinc-800/50">
            <span class="text-zinc-300">Hadoop MapReduce 节点</span>
            <span class="text-emerald-400 font-mono text-xs flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              离线计算集群已就绪
            </span>
          </div>
          <div class="flex items-center justify-between text-sm py-1 pt-2">
            <span class="text-zinc-300">HDFS 存储快照</span>
            <span class="text-zinc-400 font-mono text-xs">/happygit/features/v1</span>
          </div>
        </div>

        <!-- History & Cache -->
        <div class="p-4 rounded-2xl bg-zinc-950/70 border border-zinc-800/80 space-y-3">
          <div class="text-xs font-semibold text-zinc-400 mb-1">隐私与数据存储</div>
          <div class="flex items-center justify-between">
            <div>
              <div class="text-sm text-zinc-200">清空浏览历史</div>
              <div class="text-xs text-zinc-500">清除本地与推荐画像的近期浏览快照</div>
            </div>
            <button
              @click="$emit('clear-history')"
              class="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30 border border-transparent transition"
            >
              清空
            </button>
          </div>
        </div>

        <!-- About App -->
        <div class="p-4 rounded-2xl bg-zinc-950/70 border border-zinc-800/80">
          <div class="flex items-center justify-between text-sm">
            <span class="text-zinc-300">应用版本</span>
            <span class="text-zinc-500 text-xs font-mono">v1.0.0-alpha (双端适配版)</span>
          </div>
          <div class="flex items-center justify-between text-sm mt-2">
            <span class="text-zinc-300">平台支持</span>
            <span class="text-zinc-400 text-xs">Android / iOS / Win / Mac / Linux</span>
          </div>
        </div>
      </div>

      <!-- Footer Buttons -->
      <div class="flex items-center justify-between mt-6 pt-4 border-t border-zinc-800">
        <button
          @click="$emit('logout')"
          class="px-4 py-2 rounded-xl text-xs font-medium text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 transition"
        >
          退出 GitHub 登录
        </button>
        <button
          @click="$emit('close')"
          class="px-5 py-2 rounded-xl text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-white transition"
        >
          完成
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  isOpen: Boolean
})

defineEmits(['close', 'logout', 'clear-history'])
</script>
