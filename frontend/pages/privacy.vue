<template>
  <div class="max-w-4xl mx-auto px-4 sm:px-6 md:px-8 py-12">
    <h1 class="text-3xl font-extrabold text-gunmetal mb-6 border-b pb-2">
      Privacy <span class="text-pumpkin">Policy</span>
    </h1>

    <div class="bg-white p-6 rounded-lg shadow-sm space-y-6">
      <section>
        <h2 class="text-xl font-semibold mb-2">Overview</h2>
        <p class="text-gray-700 leading-relaxed">
          My Playlist Library connects to your Spotify account to read your profile,
          playlists, artists, and albums. That data is displayed in the app and can be
          stored in a private database (DataStax Astra) for search and recommendations.
        </p>
      </section>

      <section>
        <h2 class="text-xl font-semibold mb-2">What we collect</h2>
        <ul class="list-disc pl-5 text-gray-700 space-y-1">
          <li>Spotify profile basics (id, display name).</li>
          <li>Your playlists, artists, albums, and tracks metadata.</li>
          <li>Derived embeddings for “similar artists” recommendations.</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-semibold mb-2">What we do <span class="italic">not</span> collect</h2>
        <ul class="list-disc pl-5 text-gray-700 space-y-1">
          <li>No passwords or payment details.</li>
          <li>No emails sent to third parties for marketing.</li>
        </ul>
      </section>

      <section>
        <h2 class="text-xl font-semibold mb-2">Data retention & control</h2>
        <p class="text-gray-700 leading-relaxed">
          You can remove your session by logging out. If you want your stored data deleted
          (Astra rows, embeddings), open an issue on the
          <a class="text-blue-600 underline"
             href="https://github.com/raymonepping/music_library"
             target="_blank" rel="noopener noreferrer">GitHub repo</a>
          and reference your Spotify user id; I’ll purge it.
        </p>
      </section>

      <section>
        <h2 class="text-xl font-semibold mb-2">Third-party services</h2>
        <ul class="list-disc pl-5 text-gray-700 space-y-1">
          <li>Spotify Web API (data source).</li>
          <li>DataStax Astra (database).</li>
          <li>Hugging Face Inference API (embeddings).</li>
        </ul>
      </section>

      <p class="text-sm text-gray-500">
        This project is for personal/educational purposes. Policies may evolve as the app grows.
      </p>
    </div>
  </div>
</template>
