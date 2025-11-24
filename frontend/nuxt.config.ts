// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: "2024-04-03",
  devtools: { enabled: true },

  // Use env for host/port so it works with both local .env and Docker env
  devServer: {
    port: Number(process.env.NUXT_PORT || process.env.PORT || "8075"),
    host: process.env.NUXT_HOST || process.env.HOST || "0.0.0.0",
  },

  ssr: false,

  modules: ["@nuxtjs/tailwindcss", "@nuxt/image"],

  image: {
    domains: ["localhost", "i.scdn.co"],
  },

  tailwindcss: {
    exposeConfig: true,
    viewer: true,
  },

  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },

  css: ["~/assets/css/tailwind.css"],

  runtimeConfig: {
    public: {
      // In Docker: NUXT_PUBLIC_* from compose
      // Local: API_BASE or BACKEND_BASE or defaults
      apiBase:
        process.env.NUXT_PUBLIC_API_BASE ||
        process.env.API_BASE ||
        "http://localhost:3002/api",

      backendBase:
        process.env.NUXT_PUBLIC_BACKEND_BASE ||
        process.env.BACKEND_BASE ||
        "http://localhost:3002",

      dataSource: "db",
    },
  },

  nitro: {
    // Nitro dev port follows the same env logic
    devPort: Number(process.env.NITRO_PORT || process.env.NUXT_PORT || "8075"),
  },
});
