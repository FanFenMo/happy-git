<template>
  <dialog
    ref="dialog"
    :aria-label="label"
    :class="['application-dialog', 'modal-surface', { 'application-sheet': sheet }]"
    @cancel.prevent="emit('close')"
    @close="handleClosed"
    @keydown.tab="trapFocus"
  >
    <slot />
  </dialog>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  isOpen: Boolean,
  label: { type: String, required: true },
  sheet: Boolean
})
const emit = defineEmits(['close'])
const dialog = ref(null)

function syncScrollLock() {
  document.body.classList.toggle('dialog-open', Boolean(document.querySelector('dialog[open]')))
}

function handleClosed() {
  syncScrollLock()
  if (props.isOpen && !dialog.value?.open) emit('close')
}

function trapFocus(event) {
  const controls = [...dialog.value.querySelectorAll(
    'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )].filter(element => element.tabIndex >= 0 && element.getClientRects().length)
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (!first) {
    event.preventDefault()
    dialog.value.focus()
  } else if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.isOpen, async (open) => {
  await nextTick()
  const element = dialog.value
  if (!element) return
  if (open && !element.open) element.showModal()
  else if (!open && element.open) element.close()
  syncScrollLock()
}, { immediate: true, flush: 'post' })

onBeforeUnmount(() => {
  dialog.value?.close()
  syncScrollLock()
})
</script>
