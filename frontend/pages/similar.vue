<!-- pages/similar.vue -->
<script setup lang="ts">
import { ref } from 'vue'
const { searchArtistsExact, searchArtistsPrefix, similarArtists } = useApi()

type ArtistLite = { artist_id: string; name: string }

const q = ref('')
const mode = ref<'prefix' | 'exact'>('prefix')
const limitSearch = ref(20)
const results = ref<ArtistLite[]>([])
const loadingSearch = ref(false)
const errorSearch = ref<string | null>(null)

// selection + recs
const picked = ref<ArtistLite | null>(null)
const loadingRecs = ref(false)
const errorRecs = ref<string | null>(null)
const recs = ref<any[] | null>(null)
const recsMeta = ref<{ cached?: boolean; scored_at?: string } | null>(null)
const limitSimilar = ref(6) // how many similar artists to fetch

async function runSearch() {
  errorSearch.value = null
  results.value = []
  const term = q.value.trim()
  if (!term) return
  loadingSearch.value = true
  try {
    results.value = mode.value === 'exact'
      ? await searchArtistsExact(term)
      : await searchArtistsPrefix(term, limitSearch.value)
  } catch (e: any) {
    errorSearch.value = e?.data?.error || e?.message || 'Search failed'
  } finally {
    loadingSearch.value = false
  }
}

function resetPicked() {
  picked.value = null
  recs.value = null
  errorRecs.value = null
  recsMeta.value = null
}

async function pickArtist(a: ArtistLite) {
  picked.value = a
  recs.value = null
  errorRecs.value = null
  recsMeta.value = null
  loadingRecs.value = true
  try {
    const r: { base: any; items: any[]; cached?: boolean; scored_at?: string } =
      await similarArtists(a.artist_id, limitSimilar.value)
    recs.value = r.items || []
    recsMeta.value = { cached: r.cached, scored_at: r.scored_at }
  } catch (e: any) {
    errorRecs.value = e?.data?.error || e?.message || 'Failed to load similar artists'
  } finally {
    loadingRecs.value = false
  }
}
</script>

<template>
  <div class="p-6 max-w-5xl mx-auto space-y-6">
    <h1 class="text-2xl font-semibold">Similar artists</h1>

    <!-- Search Controls -->
    <div class="flex flex-wrap gap-2 items-center">
      <input
        v-model="q"
        type="text"
        class="flex-1 min-w-[240px] border rounded px-3 py-2"
        placeholder="Search artist (e.g., andre hazes) — prefix: an / and"
        @keyup.enter="runSearch"
      />
      <select v-model="mode" class="border rounded px-3 py-2">
        <option value="prefix">Prefix</option>
        <option value="exact">Exact</option>
      </select>
      <input
        v-if="mode==='prefix'"
        v-model.number="limitSearch"
        type="number" min="1" max="100"
        class="w-24 border rounded px-3 py-2"
        title="Limit"
      />
      <button class="px-4 py-2 rounded bg-black text-white" @click="runSearch">
        Search
      </button>
    </div>

    <p v-if="errorSearch" class="text-red-600">{{ errorSearch }}</p>
    <p v-if="loadingSearch">Searching…</p>

    <!-- Search Results -->
    <div v-if="!loadingSearch && results.length" class="border rounded bg-white">
      <div class="px-4 py-2 border-b font-medium">Results</div>
      <ul class="divide-y">
        <li v-for="a in results" :key="a.artist_id" class="py-2 px-4 flex justify-between items-center">
          <span class="truncate">{{ a.name }}</span>
          <div class="flex gap-3">
            <NuxtLink :to="`/artists/${a.artist_id}`" class="text-blue-600 underline">View</NuxtLink>
            <button
              class="px-3 py-1.5 rounded border hover:bg-gray-50"
              @click="pickArtist(a)"
            >
              Select
            </button>
          </div>
        </li>
      </ul>
    </div>

    <!-- Picked + Similar -->
    <section v-if="picked" class="space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">
          You picked: <span class="text-pumpkin">{{ picked.name }}</span>
        </h2>
        <div class="flex items-center gap-2">
          <label class="text-sm text-gray-700">Similar limit</label>
          <input
            v-model.number="limitSimilar"
            type="number" min="1" max="24"
            class="w-20 border rounded px-2 py-1"
          />
          <button
            class="px-3 py-1.5 rounded border hover:bg-gray-50"
            @click="pickArtist(picked!)"
            title="Refresh recommendations"
          >
            Refresh
          </button>
          <button
            class="px-3 py-1.5 rounded border hover:bg-gray-50"
            @click="resetPicked"
          >
            Clear
          </button>
        </div>
      </div>

      <div class="text-xs text-gray-600" v-if="recsMeta">
        <span v-if="recsMeta.cached" class="px-2 py-0.5 rounded bg-gray-100 border">cached</span>
        <span v-if="recsMeta.scored_at" class="ml-2">scored: {{ new Date(recsMeta.scored_at).toLocaleString() }}</span>
      </div>

      <div v-if="loadingRecs" class="text-gray-500">Loading similar artists…</div>
      <div v-else-if="errorRecs" class="text-red-600">{{ errorRecs }}</div>

      <div v-else-if="recs?.length" class="grid gap-4 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
        <NuxtLink
          v-for="r in recs"
          :key="r.artist_id"
          :to="`/artists/${r.artist_id}`"
          class="group rounded-lg border bg-white p-3 hover:shadow transition flex flex-col"
        >
          <img
            v-if="r.image_url"
            :src="r.image_url"
            alt=""
            class="w-full aspect-square object-cover rounded mb-2"
          />
          <div class="flex-1">
            <div class="font-medium line-clamp-1 group-hover:underline">{{ r.name }}</div>
          </div>
          <div class="text-xs text-gray-600 mt-1">Match: {{ (r.score_percent ?? (r.score*100)).toFixed(1) }}%</div>
        </NuxtLink>
      </div>

      <div v-else class="text-gray-500 text-sm">No similar artists found.</div>
    </section>

    <!-- Empty help -->
    <p v-if="!picked && !results.length && !loadingSearch && !errorSearch" class="text-gray-600">
      Search for an artist, hit <span class="font-medium">Select</span>, and I’ll fetch look-alikes. 🎯
    </p>
  </div>
</template>
