import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// PWA manifest values are pulled from VITE_* env vars at build time so the
// installed app icon, name, and theme match whatever team the deploy is for.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const teamName = env.VITE_TEAM_NAME || 'Team XC/TF'
  const shortName = env.VITE_SHORT_NAME || teamName.split(' ')[0]
  const themeColor = env.VITE_BRAND_PRIMARY || '#002776'

  return {
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: `${teamName} Workouts`,
        short_name: shortName,
        description: `Daily workout viewer for ${teamName}`,
        theme_color: themeColor,
        background_color: '#f8fafc',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/.*/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  }
})
