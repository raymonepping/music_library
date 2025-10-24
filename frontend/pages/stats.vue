<script setup lang="ts">
const api = useApi()

const loading = ref(true)
const err = ref<string | null>(null)
const data = ref<null | {
  artists_total: number
  artists_with_embedding: number | null
  albums_total: number
  albums_by_artist_rows: number
  artists_by_prefix_rows: number
  tracks_total: number | null
  generated_at: string
}>(null)

async function load() {
  loading.value = true
  err.value = null
  try {
    data.value = await api.stats()
  } catch (e: any) {
    err.value = e?.data?.error || e?.message || 'Failed to load stats'
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 md:px-8 py-10">
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-3xl font-extrabold text-gunmetal">
        Library <span class="text-pumpkin">Stats</span>
      </h1>
      <button
        class="px-4 py-2 rounded bg-black text-white hover:opacity-90"
        @click="load"
      >
        Refresh
      </button>
    </div>

    <div v-if="loading" class="text-gray-600">Loading…</div>
    <div v-else-if="err" class="text-red-600">{{ err }}</div>

    <div v-else class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div class="p-5 bg-white rounded-lg shadow-sm">
        <div class="text-sm text-gray-500">Artists (total)</div>
        <div class="text-2xl font-semibold">{{ data!.artists_total.toLocaleString() }}</div>
      </div>

      <div class="p-5 bg-white rounded-lg shadow-sm">
        <div class="text-sm text-gray-500">Artists with Embeddings</div>
        <div class="text-2xl font-semibold">
          {{ (data!.artists_with_embedding ?? 0).toLocaleString() }}
        </div>
        <div v-if="data!.artists_with_embedding != null" class="text-xs text-gray-500 mt-1">
          {{ Math.round(100 * (data!.artists_with_embedding! / data!.artists_total)) }}%
        </div>
      </div>

      <div class="p-5 bg-white rounded-lg shadow-sm">
        <div class="text-sm text-gray-500">Albums (total)</div>
        <div class="text-2xl font-semibold">{{ data!.albums_total.toLocaleString() }}</div>
      </div>

      <div class="p-5 bg-white rounded-lg shadow-sm">
        <div class="text-sm text-gray-500">Albums by Artist (rows)</div>
        <div class="text-2xl font-semibold">{{ data!.albums_by_artist_rows.toLocaleString() }}</div>
      </div>

      <div class="p-5 bg-white rounded-lg shadow-sm">
        <div class="text-sm text-gray-500">Artist Prefix Rows</div>
        <div class="text-2xl font-semibold">{{ data!.artists_by_prefix_rows.toLocaleString() }}</div>
      </div>

      <div class="p-5 bg-white rounded-lg shadow-sm">
        <div class="text-sm text-gray-500">Tracks (total)</div>
        <div class="text-2xl font-semibold">
          {{ (data!.tracks_total ?? 0).toLocaleString() }}
        </div>
      </div>
    </div>

    <p v-if="data" class="mt-6 text-sm text-gray-500">
      Snapshot generated at: {{ new Date(data.generated_at).toLocaleString() }}
    </p>
  </div>
</template>
