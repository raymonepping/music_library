<script setup lang="ts">
const props = defineProps<{
  currentPage: number
  knownPages: number
  hasPrev: boolean
  hasNext: boolean
}>()

const emit = defineEmits<{
  (e: 'prev'): void
  (e: 'next'): void
  (e: 'goto', page: number): void
}>()

// Build a compact window like: 1 2 3 ... 12 13 [14] 15 16 ... 98 99
function pageWindow(current: number, total: number) {
  const pages: (number | '…')[] = []
  const push = (p: number | '…') => pages.push(p)
  const addRange = (a: number, b: number) => { for (let i = a; i <= b; i++) push(i) }

  const left = Math.max(1, current - 2)
  const right = Math.min(total, current + 2)

  if (left > 1) {
    addRange(1, Math.min(3, total))
    if (left > 4) push('…')
    else if (left > 3) push(4)
  }

  addRange(left, right)

  if (right < total) {
    if (right < total - 3) push('…')
    else if (right < total - 2) push(total - 3)
    addRange(Math.max(total - 2, right + 1), total)
  }
  return pages
}
const pages = computed(() => pageWindow(props.currentPage, props.knownPages))
</script>

<template>
  <nav class="mt-6 flex items-center justify-center gap-2 text-sm">
    <button
      class="px-3 py-1 rounded border"
      :disabled="!hasPrev"
      @click="$emit('prev')"
    >
      Prev
    </button>

    <button
      v-for="p in pages"
      :key="String(p)"
      class="px-3 py-1 rounded border"
      :class="[
        p === currentPage ? 'bg-gray-200 font-semibold' : '',
        p === '…' ? 'opacity-60 pointer-events-none' : ''
      ]"
      @click="typeof p === 'number' && $emit('goto', p)"
    >
      {{ p }}
    </button>

    <button
      class="px-3 py-1 rounded border"
      :disabled="!hasNext"
      @click="$emit('next')"
    >
      Next
    </button>
  </nav>
</template>
