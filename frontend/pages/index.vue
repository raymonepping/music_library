<!-- pages/index.vue -->
<script setup lang="ts">
import { useApi } from '~/composables/useApi'

const api = useApi()

// Sync state
const syncing = ref(false)
const syncMsg = ref<string>("")

const me = ref<any>(null)
const playlists = ref<any[] | null>(null)
const loading = ref(true)
const error = ref<string>("")

// are we using DB-backed endpoints?
const { public: cfg } = useRuntimeConfig()
const usingDb = computed(() => cfg.dataSource === 'db')

// pagination
const pageSize = 9
const currentPage = ref(1)

const totalPages = computed(() => {
  if (!playlists.value) return 1
  return Math.max(1, Math.ceil(playlists.value.length / pageSize))
})

const pagedPlaylists = computed(() => {
  if (!playlists.value) return []
  const start = (currentPage.value - 1) * pageSize
  return playlists.value.slice(start, start + pageSize)
})

const paginationRange = computed(() => {
  const pages: (number | string)[] = []
  const tp = totalPages.value
  const cp = currentPage.value
  const delta = 1

  if (tp <= 7) {
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

  return pages.filter((v, i, a) => v !== a[i - 1])
})

function goPage(p: number) {
  if (p < 1 || p > totalPages.value) return
  currentPage.value = p
  if (process.client) window.scrollTo({ top: 0, behavior: 'smooth' })
}

async function load() {
  loading.value = true
  error.value = ""
  try {
    me.value = await api.me()
    playlists.value = await api.playlists()
    currentPage.value = 1
  } catch {
    // Only show "Not authenticated" if we’re using live Spotify endpoints.
    error.value = usingDb.value ? "" : "Not authenticated"
    playlists.value = []
  } finally {
    loading.value = false
  }
}

async function syncNow() {
  const { public: { backendBase } } = useRuntimeConfig()
  window.location.href = `${backendBase}/sync/spotify`
}

const route = useRoute()
onMounted(() => {
  if (route.query.synced === '1') {
    syncMsg.value = `Synced: ${route.query.pc} playlists, ${route.query.tc} tracks`
  } else if (route.query.synced === '0') {
    syncMsg.value = 'Sync failed.'
  }
})

function login() {
  api.login()
}

onMounted(load)
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 md:px-8">
    <!-- Hero -->
    <section class="mt-6">
      <h1 class="text-2xl sm:text-3xl font-extrabold text-gunmetal">
        Spotify <span class="text-pumpkin">Showcase</span>
      </h1>
      <p class="text-gray-600">Browse your profile and playlists via our Express backend.</p>
    </section>

    <!-- Login prompt (show only when NOT using DB mode) -->
    <section class="mt-6" v-if="!usingDb && error">
      <div class="p-4 border rounded bg-white">
        <p class="mb-3">You are not logged in.</p>
        <button
          class="px-4 py-2 rounded bg-black text-white hover:opacity-90"
          @click="login"
        >
          Login with Spotify
        </button>
      </div>
    </section>

    <!-- Loading -->
    <div v-if="loading" class="mt-6 text-gray-500">Loading…</div>

    <!-- Me (compact card) -->
    <section v-if="!loading && me && !error" class="mt-10">
      <h2 class="text-xl font-semibold mb-3">Me</h2>
      <div class="p-4 border rounded bg-white flex items-center gap-4">
        <img
          v-if="me.images?.[0]?.url"
          :src="me.images[0].url"
          alt="Profile"
          class="w-16 h-16 rounded-full object-cover"
        />
        <div class="flex-1">
          <div class="text-lg font-medium">{{ me.display_name }}</div>
          <div class="text-sm text-gray-600">
            Followers: {{ me.followers?.total ?? 0 }}
            ·
            <a
              class="text-blue-600 underline"
              :href="me.external_urls?.spotify"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open profile on Spotify
            </a>
          </div>
        </div>
      </div>
    </section>

    <!-- Playlists (paginated) -->
    <section v-if="!loading && !error" class="mt-10">
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-xl font-semibold">Playlists</h2>
        <div class="flex items-center gap-3">
          <button
            class="px-3 py-1.5 border rounded disabled:opacity-50"
            :disabled="syncing"
            @click="syncNow"
          >
            {{ syncing ? 'Syncing…' : 'Sync now' }}
          </button>
          <span v-if="syncMsg" class="text-sm text-gray-600">{{ syncMsg }}</span>
        </div>
      </div>       

      <div v-if="pagedPlaylists.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <article
          v-for="p in pagedPlaylists"
          :key="p.id"
          class="p-3 border rounded bg-white flex gap-3"
        >
          <img
            v-if="p.images?.[0]?.url"
            :src="p.images[0].url"
            alt=""
            class="w-16 h-16 object-cover rounded"
          />
          <div class="flex-1">
            <div class="font-medium truncate">{{ p.name }}</div>
            <div class="text-sm text-gray-600">
              {{ p.tracks?.total ?? 0 }} tracks · {{ p.public ? 'public' : 'private' }}
            </div>
            <a
              class="text-sm text-blue-600 underline"
              :href="`https://open.spotify.com/playlist/${p.id}`"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Spotify
            </a>
          </div>
        </article>
      </div>

      <div v-else class="text-gray-500 text-sm">No playlists to show.</div>

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
    </section>
  </div>
</template>
