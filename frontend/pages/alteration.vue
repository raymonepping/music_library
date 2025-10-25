<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
const api = useApi()

type SortItem = { key: 'popularity'|'followers'|'name'; column: string; type: 'int'|'text'; order: 'ASC'|'DESC' }
type Job = {
  id: string
  by: string
  status: 'starting'|'building'|'done'|'error'|'canceled'
  inserted: number
  total: number
  startedAt?: string
  finishedAt?: string | null
  updatedAt?: string
  error?: string | null
  percent?: number
  canceled?: boolean
}

const cols = ref<SortItem[]>([])
const selectedKey = ref<SortItem['key'] | null>(null)
const buckets = ref<number>(10)
const rebuild = ref<boolean>(false)

const jobId = ref<string | null>(null)
const job = ref<Job | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const topItems = ref<Array<{ artist_id: string; name: string; value: number|string; image_url?: string | null }>>([])
const topLimit = ref<number>(6)
const topVisible = ref(false) // for fade-in

const selectedSort = computed(() => cols.value.find(c => c.key === selectedKey.value) || null)
const isIntSort = computed(() => selectedSort.value?.type === 'int')
const canStart = computed(() => !!selectedSort.value && (!isIntSort.value || buckets.value >= 1))
const isBuilding = computed(() => job.value?.status === 'building')
const lastUpdated = computed(() => job.value?.updatedAt ? new Date(job.value.updatedAt) : null)

function fmtTime(d: Date | null) {
  if (!d) return ''
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d)
}

async function loadColumns() {
  cols.value = await api.iterateColumns()
  if (!selectedKey.value && cols.value.length) selectedKey.value = cols.value[0].key
}

async function startBuild() {
  if (!selectedSort.value) return
  jobId.value = null
  job.value = null
  topItems.value = []
  topVisible.value = false

  const by = selectedSort.value.key
  const bodyBuckets = isIntSort.value ? buckets.value : undefined
  const r = await api.iterateBuild(by, bodyBuckets, { rebuild: rebuild.value })
  jobId.value = r.job_id
  startPolling()
}

async function cancelBuild() {
  if (!jobId.value) return
  await api.iterateCancel(jobId.value)
  // polling will pick up 'canceled' on next tick and stop
}

function startPolling() {
  stopPolling()
  pollOnce()
  timer = setInterval(pollOnce, 1000)
}

async function pollOnce() {
  if (!jobId.value) return
  try {
    const s = await api.iterateStatus(jobId.value)
    job.value = s
    if (s.status === 'done' || s.status === 'error' || s.status === 'canceled') {
      stopPolling()
      await loadTop()
      // fade in preview when completed (done or canceled still loads whatever exists)
      requestAnimationFrame(() => { topVisible.value = true })
    }
  } catch {
    stopPolling()
  }
}

function stopPolling() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function loadTop() {
  if (!selectedSort.value) return
  const by = selectedSort.value.key
  try {
    const r = await api.iterateTop(by, topLimit.value)
    topItems.value = r.items || []
  } catch {
    topItems.value = []
  }
}

// auto refresh preview when key or limit changes and no active build
watch([selectedKey, topLimit], async () => {
  if (!job.value || ['done','error','canceled'].includes(job.value.status) || !jobId.value) {
    topVisible.value = false
    await loadTop()
    requestAnimationFrame(() => { topVisible.value = true })
  }
})

onMounted(async () => {
  await loadColumns()
  await loadTop()
  requestAnimationFrame(() => { topVisible.value = true })
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="p-6 max-w-5xl mx-auto space-y-6">
    <h1 class="text-2xl font-semibold">Alterations: Build derived artist tables</h1>

    <!-- Step 1: Choose sort -->
    <div class="rounded-2xl border p-4 space-y-3">
      <h2 class="text-lg font-medium">1) Choose a sort key</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <label
          v-for="c in cols"
          :key="c.key"
          class="flex items-center gap-3 p-3 border rounded-xl cursor-pointer hover:bg-gray-50"
        >
          <input
            type="radio"
            name="sortkey"
            :value="c.key"
            v-model="selectedKey"
          />
          <div>
            <div class="font-semibold capitalize">{{ c.key }}</div>
            <div class="text-xs text-gray-600">
              column: {{ c.column }}, type: {{ c.type }}, order: {{ c.order }}
            </div>
          </div>
        </label>
      </div>

      <div class="flex flex-wrap items-end gap-4 pt-2">
        <div v-if="isIntSort" class="flex flex-col">
          <label class="text-sm text-gray-700">Buckets</label>
          <input
            v-model.number="buckets"
            type="number" min="1" class="w-28 border rounded px-3 py-2"
            title="Number of hash buckets for partitioning"
          />
        </div>
        <label class="flex items-center gap-2">
          <input type="checkbox" v-model="rebuild" />
          <span class="text-sm">Rebuild, truncate existing table first</span>
        </label>

        <button
          :disabled="!canStart"
          class="px-4 py-2 rounded-xl bg-black text-white disabled:opacity-40"
          @click="startBuild"
        >
          Build table
        </button>

        <button
          v-if="isBuilding"
          class="px-4 py-2 rounded-xl border"
          @click="cancelBuild"
        >
          Cancel
        </button>
      </div>
    </div>

    <!-- Step 2: Progress -->
    <div class="rounded-2xl border p-4 space-y-3">
      <h2 class="text-lg font-medium">2) Progress</h2>

      <div v-if="job" class="space-y-2">
        <div class="text-sm">
          Status:
          <span class="font-semibold capitalize">{{ job.status }}</span>
          <span v-if="job.error" class="text-red-600"> · {{ job.error }}</span>
        </div>

        <div class="text-sm">
          Inserted: {{ job.inserted?.toLocaleString?.() ?? job.inserted }} /
          {{ job.total?.toLocaleString?.() ?? job.total }}
          <span v-if="job.percent !== undefined"> · {{ job.percent }}%</span>
        </div>

        <!-- Shimmer while building -->
        <div class="w-full h-3 bg-gray-200 rounded overflow-hidden">
          <div
            class="h-3 bg-black rounded transition-[width] duration-300 ease-out"
            :class="isBuilding ? 'animate-pulse' : ''"
            :style="{ width: `${Math.min(100, job.percent ?? 0)}%` }"
          />
        </div>

        <div class="text-xs text-gray-600">
          Job ID: {{ jobId }}
          <span v-if="lastUpdated"> · Last updated: {{ fmtTime(lastUpdated) }}</span>
        </div>
      </div>

      <p v-else class="text-sm text-gray-600">No active job.</p>
    </div>

    <!-- Step 3: Top preview -->
    <div class="rounded-2xl border p-4 space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-medium">3) Top preview</h2>
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-700">Limit</span>
          <input
            v-model.number="topLimit"
            type="number" min="1" max="50"
            class="w-24 border rounded px-3 py-2"
          />
          <button class="px-3 py-2 rounded-xl border" @click="loadTop">Refresh</button>
        </div>
      </div>

      <div
        v-if="topItems.length"
        class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 transition-opacity duration-300"
        :class="topVisible ? 'opacity-100' : 'opacity-0'"
      >
        <div
          v-for="it in topItems"
          :key="it.artist_id"
          class="flex items-center gap-3 p-3 border rounded-xl"
        >
          <img
            v-if="it.image_url"
            :src="it.image_url"
            alt=""
            class="w-14 h-14 rounded object-cover"
            loading="lazy"
          />
          <div class="min-w-0">
            <div class="font-semibold truncate">{{ it.name }}</div>
            <div class="text-xs text-gray-600 truncate">
              value: {{ it.value }}
            </div>
            <NuxtLink
              :to="`/artists/${it.artist_id}`"
              class="text-sm text-blue-600 underline"
            >
              View
            </NuxtLink>
          </div>
        </div>
      </div>
      <p v-else class="text-sm text-gray-600">No preview, build or refresh to see results.</p>
    </div>
  </div>
</template>
