<script setup lang="ts">
import { ref } from 'vue'
const { searchArtistsExact, searchArtistsPrefix } = useApi()

type ArtistLite = { artist_id: string; name: string }

const q = ref('')
const mode = ref<'prefix' | 'exact'>('prefix')
const limit = ref(20)
const loading = ref(false)
const errorMsg = ref<string | null>(null)
const results = ref<ArtistLite[]>([])

async function runSearch() {
  errorMsg.value = null
  results.value = []
  const term = q.value.trim()
  if (!term) return
  loading.value = true
  try {
    results.value = mode.value === 'exact'
      ? await searchArtistsExact(term)
      : await searchArtistsPrefix(term, limit.value)
  } catch (e: any) {
    errorMsg.value = e?.data?.error || e?.message || 'Search failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="p-6 max-w-3xl mx-auto space-y-4">
    <h1 class="text-2xl font-semibold">Search artists</h1>

    <div class="flex gap-2 items-center">
      <input
        v-model="q"
        type="text"
        class="flex-1 border rounded px-3 py-2"
        placeholder="try: andre hazes  |  prefix: an / and"
        @keyup.enter="runSearch"
      />
      <select v-model="mode" class="border rounded px-3 py-2">
        <option value="prefix">Prefix</option>
        <option value="exact">Exact</option>
      </select>
      <input
        v-if="mode==='prefix'"
        v-model.number="limit"
        type="number" min="1" max="100"
        class="w-24 border rounded px-3 py-2"
        title="Limit"
      />
      <button class="px-4 py-2 rounded bg-black text-white" @click="runSearch">
        Search
      </button>
    </div>

    <p v-if="errorMsg" class="text-red-600">{{ errorMsg }}</p>
    <p v-if="loading">Searching…</p>

    <ul v-if="!loading && results.length" class="divide-y">
      <li v-for="a in results" :key="a.artist_id" class="py-2 flex justify-between items-center">
        <span>{{ a.name }}</span>
        <NuxtLink :to="`/artists/${a.artist_id}`" class="text-blue-600 underline">View</NuxtLink>
      </li>
    </ul>

    <p v-if="!loading && !results.length && !errorMsg" class="text-gray-600">
      Start typing to search artists by exact name or prefix.
    </p>
  </div>
</template>
