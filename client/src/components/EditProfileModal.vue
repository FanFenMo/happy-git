<template>
  <AppDialog :is-open="isOpen" label="技术兴趣设置" class="interest-dialog" @close="$emit('close')">
    <div class="p-6 sm:p-7">
      <header class="flex items-center justify-between gap-4 pb-5 border-b border-[var(--color-border)] mb-5">
        <h2 class="dialog-title flex items-center gap-2">
          <Tags :size="22" aria-hidden="true" />
          技术兴趣
        </h2>
        <button type="button" aria-label="关闭技术兴趣设置" class="icon-button shrink-0" @click="$emit('close')">
          <X :size="20" aria-hidden="true" />
        </button>
      </header>

      <div class="p-4 rounded-2xl card-raised mb-5 flex flex-wrap items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[0.875rem] font-semibold text-[var(--color-text)] break-words">
            {{ userStore.profile?.displayName || userStore.profile?.login || 'GitHub 用户' }}
          </p>
          <p class="text-[0.8125rem] text-[var(--color-text-muted)] mt-1 leading-relaxed">昵称与简介由 GitHub 管理。</p>
        </div>
        <button type="button" class="btn-secondary px-4 gap-2" @click="openGitHubSettings">
          在 GitHub 编辑
          <ExternalLink :size="16" aria-hidden="true" />
        </button>
      </div>

      <div>
        <label for="manual-interest-tags" class="block text-[0.875rem] font-semibold text-[var(--color-text)] mb-2">手选技术兴趣标签</label>
        <textarea
          id="manual-interest-tags"
          v-model="tagsInput"
          aria-describedby="manual-interest-help"
          autofocus
          rows="3"
          class="w-full min-h-[8rem] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl px-4 py-3 text-[1rem] leading-relaxed text-[var(--color-text)] focus:border-[var(--color-primary)] transition resize-y selectable"
          placeholder="例如：Vue.js, Spring Boot, Android"
        ></textarea>
        <p id="manual-interest-help" class="text-[0.8125rem] text-[var(--color-text-muted)] mt-2 leading-relaxed">
          用中英文逗号分隔，最多 8 项，每项不超过 24 字符。手选标签优先展示，空余位置会根据公开仓库与 Star 自动补齐。
        </p>
      </div>

      <div v-if="previewTags.length > 0" class="mt-5">
        <p class="text-[0.8125rem] text-[var(--color-text-muted)] mb-2">标签预览 · {{ previewTags.length }}/8</p>
        <div class="flex flex-wrap gap-2">
          <span v-for="t in previewTags" :key="t" class="px-3 py-1 rounded-lg text-[0.8125rem] leading-relaxed card-raised text-[var(--color-text)] break-words">
            {{ t }}
          </span>
        </div>
      </div>

      <footer class="flex flex-wrap items-center justify-end gap-3 mt-6 pt-5 border-t border-[var(--color-border)]">
        <button type="button" class="btn-secondary px-5" @click="$emit('close')">取消</button>
        <button type="button" class="btn-primary px-5" @click="handleSave">保存兴趣</button>
      </footer>
    </div>
  </AppDialog>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { ExternalLink, Tags, X } from 'lucide-vue-next'
import AppDialog from './AppDialog.vue'
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
  await userStore.saveManualTags(previewTags.value)
  emit('close')
}
</script>
