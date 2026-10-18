<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in no-select">
    <div class="w-full max-w-md modal-surface p-6 shadow-2xl relative">
      <!-- Header -->
      <div class="flex items-center justify-between pb-4 border-b border-[var(--color-border)] mb-4">
        <h3 class="text-base font-bold text-[var(--color-text)] flex items-center gap-2">
          <span>🏷️</span> 技术兴趣设置
        </h3>
        <button
          @click="$emit('close')"
          class="p-1 rounded-full text-[var(--color-text-subtle)] hover:text-white hover:bg-[var(--color-surface-raised)] transition cursor-pointer"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- GitHub Profile Read-only Notice -->
      <div class="p-3 rounded-xl card-raised border border-[var(--color-border)] mb-4 text-xs text-[var(--color-text-muted)] flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="font-bold text-[var(--color-text)] truncate">
            {{ userStore.profile?.displayName || userStore.profile?.login || 'GitHub 用户' }}
          </div>
          <div class="text-[11px] text-[var(--color-text-subtle)] truncate">
            GitHub 资料（昵称、简介等）为只读展示
          </div>
        </div>
        <button
          @click="openGitHubSettings"
          class="px-2.5 py-1 rounded-lg card-surface border border-[var(--color-border)] hover:border-[var(--color-primary)] text-[var(--color-primary)] text-[11px] font-medium transition cursor-pointer shrink-0"
        >
          在 GitHub 编辑 ↗
        </button>
      </div>

      <!-- Manual Tags Editor -->
      <div class="space-y-3">
        <div>
          <label class="block text-xs font-semibold text-[var(--color-text)] mb-1.5">
            手选技术兴趣标签
          </label>
          <textarea
            v-model="tagsInput"
            rows="3"
            class="w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl px-3.5 py-2.5 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-primary)] transition resize-none selectable"
            placeholder="例如: Vue.js, Spring Boot, SQLite, Android, Docker (中英文逗号切分)"
          ></textarea>
          <p class="text-[11px] text-[var(--color-text-subtle)] mt-1.5 leading-normal">
            手选标签优先展示（最多 8 项，每项不超过 24 字符）；空余位置将由系统根据公开仓库与 Star 自动补齐。
          </p>
        </div>

        <!-- Tag Preview -->
        <div v-if="previewTags.length > 0" class="pt-1">
          <span class="text-[11px] text-[var(--color-text-subtle)] block mb-1.5">预览标签 ({{ previewTags.length }}/8):</span>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="t in previewTags"
              :key="t"
              class="px-2 py-0.5 rounded-md text-[11px] card-raised border border-[var(--color-border)] text-[var(--color-text)]"
            >
              # {{ t }}
            </span>
          </div>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-end gap-3 mt-5 pt-4 border-t border-[var(--color-border)]">
        <button
          @click="$emit('close')"
          class="btn-secondary px-4 py-2 text-xs cursor-pointer !min-h-0"
        >
          取消
        </button>
        <button
          @click="handleSave"
          class="btn-primary px-5 py-2 text-xs cursor-pointer !min-h-0"
        >
          保存兴趣
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useUserStore } from '../stores/user'
import { nativeBridge } from '../platform'

const props = defineProps({
  isOpen: Boolean
})

const emit = defineEmits(['close'])
const userStore = useUserStore()

const tagsInput = ref('')

watch(
  () => props.isOpen,
  (open) => {
    if (open) {
      const currentManual = userStore.preferences?.manualTags || []
      tagsInput.value = currentManual.join(', ')
    }
  },
  { immediate: true }
)

const previewTags = computed(() => {
  const seen = new Set()
  const result = []
  const rawList = tagsInput.value.split(/[,，]/)
  for (const item of rawList) {
    const clean = item.trim().slice(0, 24)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(clean)
      if (result.length >= 8) break
    }
  }
  return result
})

const openGitHubSettings = async () => {
  await nativeBridge.invoke('external.open', { url: 'https://github.com/settings/profile' })
}

const handleSave = async () => {
  await userStore.saveManualTags(tagsInput.value)
  emit('close')
}
</script>
