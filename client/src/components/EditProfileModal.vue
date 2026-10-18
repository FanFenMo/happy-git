<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
    <div class="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl relative">
      <!-- Header -->
      <div class="flex items-center justify-between pb-4 border-b border-zinc-800 mb-5">
        <h3 class="text-lg font-bold text-white flex items-center gap-2">
          <span>✏️</span> 编辑账号资料
        </h3>
        <button @click="$emit('close')" class="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Form -->
      <div class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-zinc-400 mb-1.5">昵称 / 姓名</label>
          <input
            v-model="form.name"
            type="text"
            class="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition"
            placeholder="输入昵称"
          />
        </div>

        <div>
          <label class="block text-xs font-semibold text-zinc-400 mb-1.5">个性签名 / 简介</label>
          <textarea
            v-model="form.bio"
            rows="3"
            class="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition resize-none"
            placeholder="介绍一下你的技术兴趣与开源方向..."
          ></textarea>
        </div>

        <div>
          <label class="block text-xs font-semibold text-zinc-400 mb-1.5">地区 / 组织</label>
          <input
            v-model="form.location"
            type="text"
            class="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition"
            placeholder="例如: China / OpenSource Dev"
          />
        </div>

        <div>
          <label class="block text-xs font-semibold text-zinc-400 mb-1.5">技术画像标签 (逗号分隔)</label>
          <input
            v-model="tagsInput"
            type="text"
            class="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-rose-500 transition"
            placeholder="例如: Java, Hadoop, Vue.js, Spring Boot"
          />
        </div>
      </div>

      <!-- Actions -->
      <div class="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-zinc-800">
        <button
          @click="$emit('close')"
          class="px-4 py-2 rounded-xl text-sm font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
        >
          取消
        </button>
        <button
          @click="handleSave"
          class="px-5 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-rose-500 to-amber-500 text-white shadow-lg shadow-rose-500/20 hover:opacity-90 active:scale-95 transition"
        >
          保存修改
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  isOpen: Boolean,
  user: Object
})

const emit = defineEmits(['close', 'save'])

const form = ref({
  name: '',
  bio: '',
  location: ''
})
const tagsInput = ref('')

watch(
  () => props.user,
  (newUser) => {
    if (newUser) {
      form.value = {
        name: newUser.name || '',
        bio: newUser.bio || '',
        location: newUser.location || ''
      }
      tagsInput.value = (newUser.tags || []).join(', ')
    }
  },
  { immediate: true }
)

const handleSave = () => {
  const tags = tagsInput.value
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean)

  emit('save', {
    ...form.value,
    tags
  })
  emit('close')
}
</script>
