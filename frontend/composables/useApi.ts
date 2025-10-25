// composables/useApi.ts

export type FetchOpts = Parameters<typeof useFetch>[1]

// Old behavior: useApi('/path', opts) -> returns useFetch result
export function useApiFetch<T = any>(path: string, opts: FetchOpts = {}) {
  const config = useRuntimeConfig()
  const url = computed(() => `${config.public.apiBase}${path}`)
  return useFetch<T>(url, {
    key: url.value,
    credentials: 'include', // send session cookie
    ...opts
  })
}

// New behavior: const api = useApi(); api.get('/path')
export function useApi() {
  const { public: cfg } = useRuntimeConfig()
  const base = cfg.apiBase
  const backendBase = cfg.backendBase
  const useDb = cfg.dataSource === 'db'
  const common = { credentials: 'include' as const }

  return {
  // ----- Auth / Live Spotify -----
  login: () => window.location.assign(`${backendBase}/auth/login`),
  meLive: () => $fetch(`${base}/me`, { ...common }),
  playlistsLive: () => $fetch(`${base}/playlists`, { ...common }),
  playlistTracksLive: (id: string) =>
    $fetch(`${base}/playlists/${id}/tracks`, { ...common }),

  // ----- DB-backed -----
  meDb: () => $fetch(`${base}/db/me`, { ...common }),
  playlistsDb: () => $fetch(`${base}/db/playlists`, { ...common }),

  // ----- Unified convenience -----
  me: () => (useDb ? $fetch(`${base}/db/me`, { ...common }) : $fetch(`${base}/me`, { ...common })),
  playlists: () => (useDb ? $fetch(`${base}/db/playlists`, { ...common }) : $fetch(`${base}/playlists`, { ...common })),

  // ----- Sync -----
  sync: () => $fetch(`${base}/sync/spotify`, { ...common, method: 'POST' }),

  // ----- Catalog (backendBase, non-/api routes) -----
  artist: (id: string) => $fetch(`${backendBase}/artists/${id}`, { ...common }),
  artistAlbums: (id: string, params?: { limit?: number; page_state?: string | null }) =>
    $fetch(`${backendBase}/artists/${id}/albums`, { ...common, query: params }),
  album: (id: string) => $fetch(`${backendBase}/albums/${id}`, { ...common }),

  // List (server-paged)
  artistsList: (params?: { limit?: number; page_state?: string | null }) =>
    $fetch(`${backendBase}/artists`, { ...common, query: params }),
  albumsList: (params?: { limit?: number; page_state?: string | null }) =>
    $fetch(`${backendBase}/albums`, { ...common, query: params }),

  // Auto-paginate to fetch ALL for client-side pagination (36-per-page grid)
  artistsAll: async () => {
    const pageSize = 200
    const all: any[] = []
    let page_state: string | undefined = undefined
    for (;;) {
      const r: { items: any[]; next_page_state: string | null } = await $fetch(
        `${backendBase}/artists`,
        { ...common, query: { limit: pageSize, page_state } }
      )
      all.push(...r.items)
      page_state = r.next_page_state || undefined
      if (!page_state) break
    }
    return all
  },

  albumsAll: async () => {
    const pageSize = 200
    const all: any[] = []
    let page_state: string | undefined = undefined
    for (;;) {
      const r: { items: any[]; next_page_state: string | null } = await $fetch(
        `${backendBase}/albums`,
        { ...common, query: { limit: pageSize, page_state } }
      )
      all.push(...r.items)
      page_state = r.next_page_state || undefined
      if (!page_state) break
    }
    return all
  },

  similarArtists: (id: string, limit = 5) =>
    $fetch(`${backendBase}/vectors/artists/${id}/similar`, {
      credentials: 'include',
      query: { limit }
    }),

  // Stats
  stats: () => $fetch(`${base}/stats`, { credentials: 'include' }),

  // ----- Search -----
searchArtistsExact: (q: string) =>
  $fetch(`${backendBase}/search/artists/exact`, {
    ...common,
    query: { q: q.trim() }
  }),

searchArtistsPrefix: (q: string, limit = 25) =>
  $fetch(`${backendBase}/search/artists/prefix-sai`, {
    ...common,
    query: { q: q.trim(), limit }
  }),


    // ----- Iterate / Alterations -----
    iterateColumns: () =>
      $fetch(`${backendBase}/iterate/columns`, { ...common }),

    iterateBuild: (by: 'popularity' | 'followers' | 'name', buckets?: number, opts?: { rebuild?: boolean }) =>
      $fetch(`${backendBase}/iterate/build`, {
        ...common,
        method: 'POST',
        query: opts?.rebuild ? { mode: 'rebuild' } : undefined,
        body: { by, ...(buckets ? { buckets } : {}) }
      }),

    iterateStatus: (jobId: string) =>
      $fetch(`${backendBase}/iterate/status/${jobId}`, { ...common }),

    iterateTop: (by: 'popularity' | 'followers' | 'name', limit = 5) =>
      $fetch(`${backendBase}/iterate/top`, {
        ...common,
        query: { by, limit }
      }),



}

}
