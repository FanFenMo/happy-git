<template>
  <div class="flex-1 flex flex-col h-full bg-zinc-950 text-white overflow-hidden relative">
    <!-- Top Header bar -->
    <header class="h-14 px-4 flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur z-20">
      <div class="flex items-center gap-2">
        <span class="text-xl font-black bg-gradient-to-r from-red-500 via-rose-500 to-amber-500 bg-clip-text text-transparent">
          HappyGit
        </span>
        <span class="text-xs px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20 font-medium">
          Hot 🔥
        </span>
      </div>
      <div class="flex items-center gap-3">
        <button class="p-2 rounded-full hover:bg-zinc-800 text-zinc-400 hover:text-white transition">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
          </svg>
        </button>
      </div>
    </header>

    <!-- Main Content: Placeholder & Future Vision of Douyin-style Card Stream -->
    <div class="flex-1 flex flex-col items-center justify-center p-6 text-center overflow-y-auto">
      <!-- Simulated Card Frame -->
      <div class="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-2xl backdrop-blur relative overflow-hidden group">
        <!-- Background Glow -->
        <div class="absolute -top-20 -right-20 w-44 h-44 bg-rose-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div class="absolute -bottom-20 -left-20 w-44 h-44 bg-amber-500/10 rounded-full blur-3xl pointer-events-none"></div>

        <div class="relative z-10 flex flex-col items-center">
          <div class="w-16 h-16 rounded-2xl bg-gradient-to-tr from-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-500/20 mb-4 animate-pulse">
            <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>

          <h3 class="text-xl font-bold text-white mb-2">🔥 热门项目卡片流</h3>
          <p class="text-sm text-zinc-400 mb-5 leading-relaxed">
            【当前功能占位中】<br />
            下一阶段将接入 <span class="text-rose-400 font-medium">Hadoop MapReduce</span> 离线计算与实时热度混合推荐算法，为您呈现类抖音式沉浸上下滑动的开源项目卡片！
          </p>

          <!-- Mock Spec Features -->
          <div class="w-full space-y-2.5 text-left mb-6">
            <div class="p-3 rounded-xl bg-zinc-800/50 border border-zinc-800 flex items-center gap-3">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span class="text-xs text-zinc-300">一句话核心痛点与功能速览</span>
            </div>
            <div class="p-3 rounded-xl bg-zinc-800/50 border border-zinc-800 flex items-center gap-3">
              <span class="w-2 h-2 rounded-full bg-sky-400"></span>
              <span class="text-xs text-zinc-300">动效演示 GIF / 架构轻量解析</span>
            </div>
            <div class="p-3 rounded-xl bg-zinc-800/50 border border-zinc-800 flex items-center gap-3">
              <span class="w-2 h-2 rounded-full bg-amber-400"></span>
              <span class="text-xs text-zinc-300">个性化推荐理由与技术栈匹配度</span>
            </div>
          </div>

          <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-800 text-xs text-zinc-400">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping"></span>
            推荐引擎与数据集就绪后开放全量推荐
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// Placeholder view for Trending / Hot Projects
</script>
