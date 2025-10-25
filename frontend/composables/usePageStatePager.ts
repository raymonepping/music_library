// composables/usePageStatePager.ts
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

type PageStateResponse<T> = {
  items: T[]
  next_page_state: string | null
  has_more: boolean
  limit: number
}

type Fetcher<T> = (token: string | null, limit: number) => Promise<PageStateResponse<T>>

export function usePageStatePager<T>(
  storageKey: string,
  fetcher: Fetcher<T>,
  limit = 50
) {
  const route = useRoute()
  const router = useRouter()

  const tokens = ref<(string | null)[]>([null])   // page 1 token is null
  const pages = ref<T[][]>([])                   // cached page data
  const hasMoreFlags = ref<boolean[]>([])        // whether each page has a next

  const pageIndex = ref<number>(Math.max(0, Number(route.query.page ?? 1) - 1))
  const loading = ref<boolean>(false)
  const error = ref<string | null>(null)

  // Restore from session storage on client
  if (process.client) {
    const cache = sessionStorage.getItem(storageKey)
    if (cache) {
      try {
        const parsed = JSON.parse(cache)
        if (Array.isArray(parsed.tokens) && parsed.tokens.length > 0) tokens.value = parsed.tokens
        if (Array.isArray(parsed.pages)) pages.value = parsed.pages
        if (Array.isArray(parsed.hasMore)) hasMoreFlags.value = parsed.hasMore
      } catch {}
    }
  }

  function persist() {
    if (!process.client) return
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        tokens: tokens.value,
        pages: pages.value,
        hasMore: hasMoreFlags.value,
      })
    )
  }

  async function loadPage(i: number) {
    if (i < 0) return
    if (i >= tokens.value.length) return
    if (pages.value[i]) return // already loaded

    loading.value = true
    error.value = null
    try {
      const token = tokens.value[i] ?? null
      const res = await fetcher(token, limit)

      pages.value[i] = res.items
      hasMoreFlags.value[i] = !!res.next_page_state

      if (res.next_page_state) {
        if (tokens.value.length === i + 1) {
          tokens.value.push(res.next_page_state)
        } else {
          tokens.value[i + 1] = res.next_page_state
        }
      }
      persist()
    } catch (e: any) {
      error.value = e?.message || 'Failed to load page'
    } finally {
      loading.value = false
    }
  }

  async function goTo(index: number) {
    if (index < 0) return
    if (index > tokens.value.length - 1) return
    await loadPage(index)
    pageIndex.value = index
    router.replace({ query: { ...route.query, page: String(index + 1) } })
  }

  async function next() {
    if (!hasMore.value) return
    await loadPage(pageIndex.value + 1)
    await goTo(pageIndex.value + 1)
  }

  async function prev() {
    if (pageIndex.value === 0) return
    await goTo(pageIndex.value - 1)
  }

  const items = computed<T[]>(() => pages.value[pageIndex.value] ?? [])
  const hasPrev = computed(() => pageIndex.value > 0)
  const hasNext = computed(() => hasMore.value)
  const hasMore = computed(() => hasMoreFlags.value[pageIndex.value] === true)
  const currentPage = computed(() => pageIndex.value + 1)
  const knownPages = computed(() => Math.max(pages.value.length, tokens.value.length))

  // Load the initial page on the client
  onMounted(() => {
    loadPage(pageIndex.value)
  })

  return {
    items,
    loading,
    error,
    currentPage,
    knownPages,
    hasPrev,
    hasNext,
    goTo,
    next,
    prev,
  }
}
