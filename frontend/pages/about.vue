<!-- pages/about.vue -->
<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 md:px-8 py-12">
    <!-- Header -->
    <h1 class="text-3xl font-extrabold text-gunmetal mb-6 border-b pb-2">
      About <span class="text-pumpkin">My Playlist Library</span>
    </h1>

    <!-- Intro -->
    <div class="bg-white p-6 rounded-lg shadow-sm mb-8">
      <p class="text-gray-700 leading-relaxed">
        <strong>My Playlist Library</strong> lets you organize, search, and explore your Spotify data.  
        It syncs your profile, playlists, artists, and albums into a Cassandra backend,  
        then displays everything through a Nuxt frontend.
      </p>
    </div>

    <!-- Tech Stack -->
    <div class="mb-8">
      <h2 class="text-2xl font-semibold text-gunmetal mb-3">Tech Stack</h2>
      <ul class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <li class="p-4 bg-white rounded shadow-sm">
          <span class="font-medium">Nuxt 3 + Tailwind CSS</span>
          <p class="text-sm text-gray-600">Frontend UI and styling</p>
        </li>
        <li class="p-4 bg-white rounded shadow-sm">
          <span class="font-medium">Express.js</span>
          <p class="text-sm text-gray-600">Backend API server</p>
        </li>
        <li class="p-4 bg-white rounded shadow-sm">
          <span class="font-medium">DataStax Astra (Cassandra)</span>
          <p class="text-sm text-gray-600">Database & indexing</p>
        </li>
        <li class="p-4 bg-white rounded shadow-sm">
          <span class="font-medium">Spotify Web API</span>
          <p class="text-sm text-gray-600">Music metadata enrichment</p>
        </li>
      </ul>
    </div>

    <!-- Credits -->
    <div>
      <h2 class="text-2xl font-semibold text-gunmetal mb-3">Credits</h2>
      <p class="text-gray-700 leading-relaxed">
        Built with <span class="text-pumpkin">☕ + 🎧</span> by <strong>Ray</strong>.  
        Powered by <span class="font-medium">Terraform</span>, <span class="font-medium">Vault</span>,  
        <span class="font-medium">DataStax</span>, <span class="font-medium">Nuxt</span>,  
        and <span class="font-medium">Tailwind CSS</span>.
      </p>
    </div>
  </div>
</template>
