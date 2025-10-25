<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

type Album = { album_id: string; name: string; image_url?: string | null; artist_name?: string }
const api = useApi()

const limit = 18
const pageIndex = ref(0)
const tokens = ref<(string | null)[]>([null])
const pages = ref<Album[][]>([])
const hasMoreFlags = ref<boolean[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

const currentItems = computed(() => pages.value[pageIndex.value] || [])
const hasPrev = computed(() => pageIndex.value > 0)
const hasNext = computed(() => hasMoreFlags.value[pageIndex.value] === true)
const currentPage = computed(() => pageIndex.value + 1)
const knownPages = computed(() => Math.max(tokens.value.length, pages.value.length))

async function fetchPage(i: number) {
  if (pages.value[i]) return
  loading.value = true
  error.value = null
  try {
    const token = tokens.value[i] ?? undefined
    const res = await api.albumsList({ limit, page_state: token })
    pages.value[i] = res.items || []
    hasMoreFlags.value[i] = !!res.next_page_state
    if (res.next_page_state && tokens.value.length === i + 1) {
      tokens.value.push(res.next_page_state)
    }
  } catch (e: any) {
    error.value = e?.message || 'Failed to load'
  } finally {
    loading.value = false
  }
}

async function goTo(i: number) {
  if (i < 0) return
  if (i > tokens.value.length - 1) return
  await fetchPage(i)
  pageIndex.value = i
  if (process.client) window.scrollTo({ top: 0, behavior: 'smooth' })
}

const pagesBar = computed<(number | string)[]>(() => {
  const total = knownPages.value
  const cur = currentPage.value
  const out: (number | string)[] = []
  const show = (n: number) => n >= 1 && n <= total && out.push(n)
  if (total <= 9) { for (let i = 1; i <= total; i++) show(i); return out }
  show(1); show(2)
  if (cur - 2 > 3) out.push('…')
  for (let i = Math.max(3, cur - 2); i <= Math.min(total - 2, cur + 2); i++) show(i)
  if (cur + 2 < total - 2) out.push('…')
  show(total - 1); show(total)
  return out
})

onMounted(() => fetchPage(0))
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto">
    <h1 class="text-2xl font-semibold mb-4">Albums</h1>

    <div v-if="error" class="mb-3 text-red-600 text-sm">{{ error }}</div>
    <div v-if="loading && !currentItems.length" class="text-gray-500">Loading…</div>

    <div v-else class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
      <div v-for="al in currentItems" :key="al.album_id" class="p-3 border rounded bg-white hover:shadow transition">
        <NuxtImg
          v-if="al.image_url"
          :src="al.image_url"
          width="160" height="160"
          class="w-full h-32 object-cover rounded mb-2"
          alt=""
          loading="lazy" decoding="async"
        />
        <div v-else class="w-full h-32 rounded bg-gray-100 mb-2" />
        <div class="font-medium truncate">{{ al.name }}</div>
        <div class="text-xs opacity-70 truncate">{{ al.artist_name }}</div>
      </div>
    </div>

    <div class="mt-6 flex items-center justify-center gap-2 flex-wrap">
      <button class="px-3 py-1 border rounded disabled:opacity-50" :disabled="!hasPrev" @click="goTo(pageIndex - 1)">Prev</button>
      <template v-for="p in pagesBar" :key="`p-${p}`">
        <span v-if="p === '…'" class="px-2 select-none">…</span>
        <button
          v-else
          class="px-3 py-1 border rounded"
          :class="p === currentPage ? 'bg-black text-white' : ''"
          @click="goTo((p as number) - 1)"
        >
          {{ p }}
        </button>
      </template>
      <button class="px-3 py-1 border rounded disabled:opacity-50" :disabled="!hasNext" @click="goTo(pageIndex + 1)">Next</button>
    </div>
  </div>
</template>
