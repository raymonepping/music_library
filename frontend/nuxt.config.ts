// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: true },
  devServer: {
    port: 8075,
    host: '0.0.0.0',
  },  

  ssr: false,

  modules: ['@nuxtjs/tailwindcss', '@nuxt/image'],

  image: { domains: ['localhost', 'i.scdn.co'] },

  // Tailwind module
  tailwindcss: {
    exposeConfig: true,
    viewer: true,
  },

  // Configure PostCSS here (Nuxt way)
  postcss: {
    plugins: {
      tailwindcss: {},
      autoprefixer: {},
    },
  },

  // Also load your CSS globally (ok to keep; the module also injects it)
  css: ['~/assets/css/tailwind.css'],

  runtimeConfig: {
    public: {
      apiBase: process.env.API_BASE         || 'http://localhost:3002/api',
      backendBase: process.env.BACKEND_BASE || 'http://localhost:3002',
      dataSource: 'db'
    }    
  },  

  // (Optional) force a dev port
  nitro: { devPort: 8075 },

})