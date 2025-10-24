<script setup lang="ts">
const route = useRoute()
const { artist, artistAlbums } = useApi()
const id = route.params.id as string

type Image = { url: string; height: number; width: number }
type Artist = {
  artist_id: string; name: string; genres: string[]; followers: number;
  popularity: number; images: Image[]; updated_at: string
}
type AlbumLite = { album_id: string; name: string; release_date: string }
type AlbumsResp = { items: AlbumLite[]; limit: number; next_page_state: string | null; has_more: boolean }

const data = ref<Artist | null>(null)
const albums = ref<AlbumLite[]>([])
const nextPage = ref<string | null>(null)
const limit = 12
const loading = ref(true)
const loadingMore = ref(false)
const errorMsg = ref<string | null>(null)

async function load() {
  loading.value = true
  errorMsg.value = null
  try {
    data.value = await artist(id)
    const r = await artistAlbums(id, { limit })
    albums.value = r.items
    nextPage.value = r.next_page_state
  } catch (e: any) {
    errorMsg.value = e?.data?.error || e?.message || 'Failed to load artist'
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextPage.value) return
  loadingMore.value = true
  try {
    const r = await artistAlbums(id, { limit, page_state: nextPage.value })
    albums.value = albums.value.concat(r.items)
    nextPage.value = r.next_page_state
  } finally {
    loadingMore.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="p-6 max-w-6xl mx-auto space-y-6">
    <NuxtLink to="/artists" class="text-blue-600 underline">&larr; All Artists</NuxtLink>

    <div v-if="loading">Loading…</div>
    <p v-else-if="errorMsg" class="text-red-600">{{ errorMsg }}</p>

    <div v-else-if="data" class="flex gap-6 items-start">
      <NuxtImg v-if="data.images?.[0]?.url" :src="data.images[0].url" width="200" height="200" class="w-40 h-40 rounded object-cover" />
      <div class="space-y-2">
        <h1 class="text-3xl font-semibold">{{ data.name }}</h1>
        <p class="text-sm text-gray-600">Followers {{ data.followers }} · Popularity {{ data.popularity }}</p>
        <div class="flex flex-wrap gap-2">
          <span v-for="g in data.genres" :key="g" class="px-2 py-1 bg-gray-100 rounded text-xs">{{ g }}</span>
        </div>
      </div>
    </div>

    <section v-if="!loading">
      <h2 class="text-xl font-semibold mb-3">Albums</h2>
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <NuxtLink v-for="al in albums" :key="al.album_id" :to="`/albums/${al.album_id}`" class="border rounded p-3 hover:shadow-sm">
          <div class="font-medium line-clamp-2">{{ al.name }}</div>
          <div class="text-xs text-gray-600">{{ al.release_date }}</div>
        </NuxtLink>
      </div>
      <div class="mt-4">
        <button v-if="nextPage" class="px-4 py-2 rounded bg-black text-white" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </div>
    </section>
  </div>
</template>
