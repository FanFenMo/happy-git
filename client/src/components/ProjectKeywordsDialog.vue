<template>
  <dialog ref="dialog" class="keyword-dialog" :aria-labelledby="`${id}-title`"
    @cancel.prevent="emit('close')" @close="syncNativeClose" @click.self="emit('close')">
    <div v-if="repository" class="keyword-sheet">
      <header class="keyword-heading">
        <div>
          <h2 :id="`${id}-title`">项目关键词</h2>
          <p>{{ repository.fullName || repository.name }}</p>
        </div>
        <button type="button" class="keyword-close" aria-label="关闭项目关键词" autofocus @click="emit('close')">
          <X :size="20" aria-hidden="true" />
        </button>
      </header>

      <template v-if="items.length">
        <p class="keyword-hint">气泡越大，关键词权重越高。点破气泡查看占比。</p>
        <ul class="keyword-cloud" aria-label="关键词气泡">
          <li v-for="(item, index) in items" :key="item.canonical" class="keyword-slot" :style="bubbleStyle(item, index)">
            <button type="button" class="keyword-bubble" :class="{ 'is-popped': popped.has(item.canonical) }"
              :title="item.term" :aria-label="item.term" :aria-expanded="popped.has(item.canonical)"
              :aria-controls="`${id}-share-${index}`" @click="pop(item)">
              <span class="keyword-rim" aria-hidden="true" />
              <span v-if="popped.has(item.canonical)" class="keyword-spray" aria-hidden="true">
                <i v-for="angle in sprayAngles" :key="angle" :style="{ '--angle': `${angle}deg` }" />
              </span>
              <span class="keyword-term">{{ item.term }}</span>
            </button>
            <div :id="`${id}-share-${index}`" class="keyword-share">
              <span v-if="popped.has(item.canonical)">{{ formatShare(item.sharePercent) }}</span>
            </div>
          </li>
        </ul>
        <p class="keyword-note">来源：{{ method }}。占比按本窗展示词的总权重计算，不是推荐分数。</p>
        <p class="sr-only" role="status" aria-atomic="true">{{ announcement }}</p>
      </template>
      <p v-else class="keyword-empty">公开项目信息较少，暂未提取到关键词。可到 GitHub 查看项目 README。</p>
    </div>
  </dialog>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { formatShare, keywordBubbleScale, projectKeywordMethods, projectKeywords } from '../models/interest-display.js'

const props = defineProps({ repository: { type: Object, default: null } })
const emit = defineEmits(['close'])
const dialog = ref(null)
const id = useId()
const popped = ref(new Set())
const announcement = ref('')
const detail = computed(() => props.repository ? projectKeywords(props.repository) : null)
const items = computed(() => detail.value?.items || [])
const method = computed(() => projectKeywordMethods[detail.value?.sourceMode] || '公开项目资料')
const sprayAngles = [-165, -122, -76, -31, 18, 69, 112, 154]
const offsets = [3, -6, 5, -2, 7, -4]

function bubbleStyle(item, index) {
  // 同一个词在不同项目里使用同一种边缘颜色；颜色不代表权重。
  let hash = 0
  for (const char of item.canonical) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0
  const delay = 85 + Math.min(8, items.value.length - index - 1) * 43 + hash % 34
  return {
    '--bubble-scale': keywordBubbleScale(item.weight),
    '--tone': `var(--tone-${hash % 6})`,
    '--offset': `${offsets[index % offsets.length]}px`,
    '--rise-delay': `${delay}ms`,
    '--float-time': `${2.2 + (hash % 13) / 10}s`,
    '--rim-turn': `${hash % 100 - 50}deg`
  }
}

function pop(item) {
  if (popped.value.has(item.canonical)) return
  popped.value.add(item.canonical)
  announcement.value = `${item.term}，关键词权重占比 ${formatShare(item.sharePercent)}`
}

watch(() => props.repository, (repo) => {
  if (repo) {
    popped.value = new Set()
    announcement.value = ''
    if (!dialog.value.open) dialog.value.showModal()
  } else if (dialog.value.open) {
    dialog.value.close()
  }
}, { flush: 'post' })

function syncNativeClose() {
  if (props.repository && !dialog.value?.open) emit('close')
}

onBeforeUnmount(() => dialog.value?.close())
</script>

<style scoped>
.keyword-dialog {
  position: fixed;
  inset: 0;
  z-index: 50;
  width: min(31rem, calc(100% - 1.5rem - env(safe-area-inset-left) - env(safe-area-inset-right)));
  max-height: calc(100dvh - 2.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  margin: auto;
  padding: 0;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--color-border);
  border-radius: 1rem;
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: 0 22px 62px rgb(24 40 62 / .24);
}
.keyword-dialog[open] { animation: keyword-sheet-in .36s cubic-bezier(.22, .75, .24, 1) both; }
.keyword-dialog::backdrop { background: rgb(24 40 62 / .36); animation: keyword-dim .3s ease both; }
:global(body:has(.keyword-dialog[open])) { overflow: hidden; }
.keyword-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: .75rem;
  padding: .9rem 1.05rem .65rem;
  border-bottom: 1px solid var(--color-border);
}
.keyword-heading h2 { font-size: 1.17rem; font-weight: 700; line-height: 1.35; }
.keyword-heading p { margin-top: .22rem; color: var(--color-text-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.keyword-close {
  width: 2.75rem;
  height: 2.75rem;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--color-text-muted);
  cursor: pointer;
}
.keyword-close:hover { background: var(--color-surface-raised); color: var(--color-text); }
.keyword-hint, .keyword-note, .keyword-empty {
  padding: .65rem 1.05rem;
  color: var(--color-text-muted);
  font-size: .8125rem;
  line-height: 1.6;
}
.keyword-note { font-size: .75rem; border-top: 1px solid var(--color-border); padding-bottom: .85rem; }
.keyword-empty { padding-block: 1.1rem; }

.keyword-cloud {
  --tone-0: #2c77a8;
  --tone-1: #785bb8;
  --tone-2: #b64d78;
  --tone-3: #187e71;
  --tone-4: #a56538;
  --tone-5: #485db1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: .35rem .65rem;
  padding: .75rem .7rem .35rem;
  /* 旋转描边和炸开的水滴不应撑出窄屏横向滚动条。 */
  overflow-x: clip;
  background: linear-gradient(to bottom, var(--color-surface), #f2f8fc);
}
.keyword-slot {
  --diameter: calc(clamp(4.75rem, 24vw, 6.85rem) * var(--bubble-scale));
  display: grid;
  justify-items: center;
  align-content: center;
  width: var(--diameter);
  min-width: 0;
  animation: keyword-rise .62s cubic-bezier(.19, .69, .28, 1) var(--rise-delay) both;
}
.keyword-bubble {
  position: relative;
  width: var(--diameter);
  height: var(--diameter);
  border-radius: 50%;
  display: grid;
  place-items: center;
  cursor: pointer;
  isolation: isolate;
  background: transparent;
  animation: keyword-float var(--float-time) ease-in-out calc(var(--rise-delay) + 620ms) infinite alternate;
}
.keyword-bubble:is(:focus, .is-popped) { animation-play-state: paused; }
@media (hover: hover) { .keyword-bubble:hover { animation-play-state: paused; } }
.keyword-bubble.is-popped { cursor: default; }
.keyword-rim, .keyword-rim::after, .keyword-spray { position: absolute; pointer-events: none; border-radius: 50%; }
.keyword-rim {
  inset: 0;
  border: 1.8px solid var(--tone);
  border-block-start-color: color-mix(in srgb, var(--tone) 72%, white);
  transform: rotate(var(--rim-turn));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--tone) 12%, transparent);
}
.keyword-rim::after {
  content: '';
  inset: 4px;
  border: 1px solid transparent;
  border-top-color: color-mix(in srgb, var(--tone) 42%, white);
  transform: rotate(-32deg);
}
.keyword-bubble:not(.is-popped):hover .keyword-rim { box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 14%, transparent); }
.keyword-term {
  max-width: 88%;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow-wrap: anywhere;
  text-align: center;
  text-wrap: balance;
  font-size: clamp(.66rem, calc(var(--diameter) * .142), .8125rem);
  line-height: 1.22;
  font-weight: 650;
}
.keyword-bubble.is-popped .keyword-term { max-width: 100%; -webkit-line-clamp: 4; }
.keyword-bubble.is-popped:focus-visible { outline: none; }
.keyword-bubble.is-popped:focus-visible .keyword-term {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
  border-radius: 2px;
}
.keyword-bubble.is-popped .keyword-rim { animation: keyword-rim-burst .42s cubic-bezier(.18, .63, .28, 1) forwards; }
.keyword-spray { inset: 0; }
.keyword-spray i {
  --flight: .68;
  position: absolute;
  top: calc(50% - 2px);
  left: calc(50% - 2px);
  width: 4px;
  height: 4px;
  border: 1px solid var(--tone);
  border-radius: 50%;
  opacity: 0;
  animation: keyword-droplet .48s cubic-bezier(.18, .65, .3, 1) .02s both;
}
.keyword-spray i:nth-child(even) { --flight: .76; width: 3px; height: 3px; }
.keyword-share {
  display: grid;
  place-items: start center;
  min-height: 1.6rem;
  padding-top: .1rem;
  font-size: .8125rem;
  line-height: 1.35;
  color: var(--color-text);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.keyword-share span { animation: keyword-reveal .3s ease .14s both; }

@keyframes keyword-sheet-in { from { opacity: 0; transform: translateY(1.7rem); } to { opacity: 1; transform: translateY(0); } }
@keyframes keyword-dim { from { opacity: 0; } to { opacity: 1; } }
@keyframes keyword-rise {
  from { opacity: 0; transform: translateY(calc(var(--offset) + 2.25rem)) scale(.84); }
  to { opacity: 1; transform: translateY(var(--offset)) scale(1); }
}
@keyframes keyword-float { from { transform: translateY(0); } to { transform: translateY(-6px); } }
@keyframes keyword-rim-burst {
  from { opacity: 1; transform: rotate(var(--rim-turn)); }
  30% { opacity: .72; }
  to { opacity: 0; transform: rotate(var(--rim-turn)) scale(1.27); }
}
@keyframes keyword-droplet {
  from { opacity: 0; transform: rotate(var(--angle)) translateX(calc(var(--diameter) * .44)) scale(.6); }
  18% { opacity: 1; }
  to { opacity: 0; transform: rotate(var(--angle)) translateX(calc(var(--diameter) * var(--flight))) scale(.13); }
}
@keyframes keyword-reveal { from { opacity: 0; transform: translateY(.3rem); } to { opacity: 1; transform: translateY(0); } }

@media (prefers-reduced-motion: reduce) {
  .keyword-dialog[open], .keyword-dialog::backdrop, .keyword-slot, .keyword-bubble, .keyword-rim, .keyword-share span { animation: none !important; }
  .keyword-bubble.is-popped .keyword-rim, .keyword-spray { display: none; }
}
@media (forced-colors: active) {
  .keyword-rim { border-color: ButtonText; }
  .keyword-rim::after { display: none; }
  .keyword-close { border: 1px solid ButtonText; }
}
</style>
