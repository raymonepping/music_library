<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
const { albumsAll } = useApi()

const albums = ref<any[]>([])
const loading = ref(true)
const error = ref("")

const pageSize = 18
const currentPage = ref(1)

const totalPages = computed(() =>
  Math.max(1, Math.ceil(albums.value.length / pageSize))
)

const pagedAlbums = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return albums.value.slice(start, start + pageSize)
})

// same ellipsis logic you used for playlists
const paginationRange = computed(() => {
  const pages: (number | string)[] = []
  const tp = totalPages.value
  const cp = currentPage.value
  const delta = 1

  if (tp <= 9) {
    for (let i = 1; i <= tp; i++) pages.push(i)
    return pages
  }

  pages.push(1, 2)
  if (cp - delta > 3) pages.push('…')

  const start = Math.max(3, cp - delta)
  const end = Math.min(tp - 2, cp + delta)
  for (let i = start; i <= end; i++) pages.push(i)

  if (cp + delta < tp - 2) pages.push('…')
  pages.push(tp - 1, tp)

  // de-dupe any accidental repeats
  return pages.filter((v, i, a) => v !== a[i - 1])
})

function goPage(p: number) {
  if (p < 1 || p > totalPages.value) return
  currentPage.value = p
  if (process.client) window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function load() {
  loading.value = true
  try {
    albums.value = await albumsAll() // returns [{ album_id, name, release_date, image_url }]
  } catch (e: any) {
    error.value = e?.message || "Failed to load albums"
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto space-y-4">
    <h1 class="text-2xl font-semibold">All Albums</h1>

    <div v-if="loading" class="text-gray-500">Loading…</div>
    <div v-else-if="error" class="text-red-600">{{ error }}</div>

    <div v-else class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
      <NuxtLink
        v-for="al in pagedAlbums"
        :key="al.album_id"
        :to="`/albums/${al.album_id}`"
        class="p-3 border rounded bg-white hover:shadow transition"
      >
        <NuxtImg v-if="al.image_url" :src="al.image_url" width="160" height="160" class="w-full aspect-square object-cover rounded mb-2" />
        <div v-else class="w-full aspect-square rounded bg-gray-100 mb-2"></div>
        <div class="font-medium line-clamp-2">{{ al.name }}</div>
        <div class="text-xs text-gray-600">{{ al.release_date }}</div>
      </NuxtLink>
    </div>

    <div v-if="totalPages > 1" class="mt-6 flex items-center justify-center gap-2 flex-wrap">
    <button
        class="px-3 py-1 border rounded disabled:opacity-50"
        :disabled="currentPage === 1"
        @click="goPage(currentPage - 1)"
    >
        Prev
    </button>

    <template v-for="p in paginationRange" :key="`p-${p}`">
        <span v-if="p === '…'" class="px-2 select-none">…</span>
        <button
        v-else
        class="px-3 py-1 border rounded"
        :class="p === currentPage ? 'bg-black text-white' : ''"
        @click="goPage(p as number)"
        >
        {{ p }}
        </button>
    </template>

    <button
        class="px-3 py-1 border rounded disabled:opacity-50"
        :disabled="currentPage === totalPages"
        @click="goPage(currentPage + 1)"
    >
        Next
    </button>
    </div>

  </div>
</template>
