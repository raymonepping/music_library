<script setup lang="ts">
const route = useRoute()
const { album } = useApi()
const id = route.params.id as string

type Image = { url: string; height: number; width: number }
type Credit = { id: string; name: string }
type Album = {
  album_id: string; name: string; album_type: string; release_date: string;
  total_tracks: number; images: Image[]; artists: Credit[]; updated_at: string
}

const data = ref<Album | null>(null)
const errorMsg = ref<string | null>(null)
const loading = ref(true)

onMounted(async () => {
  loading.value = true
  errorMsg.value = null
  try {
    data.value = await album(id)
  } catch (e: any) {
    errorMsg.value = e?.data?.error || e?.message || 'Failed to load album'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="p-6 max-w-4xl mx-auto space-y-4">
    <NuxtLink to="/albums" class="text-blue-600 underline">&larr; All Albums</NuxtLink>

    <div v-if="loading">Loading…</div>
    <p v-else-if="errorMsg" class="text-red-600">{{ errorMsg }}</p>

    <div v-else-if="data" class="space-y-3">
      <NuxtImg v-if="data.images?.[0]?.url" :src="data.images[0].url" width="320" height="320" class="w-64 h-64 rounded object-cover" />
      <h1 class="text-3xl font-semibold">{{ data.name }}</h1>
      <p class="text-sm text-gray-600">
        {{ data.album_type }} · {{ data.release_date }} · {{ data.total_tracks }} tracks
      </p>
      <div class="flex flex-wrap gap-2">
        <NuxtLink v-for="a in data.artists" :key="a.id" :to="`/artists/${a.id}`" class="px-2 py-1 bg-gray-100 rounded text-xs hover:bg-gray-200">
          {{ a.name }}
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
