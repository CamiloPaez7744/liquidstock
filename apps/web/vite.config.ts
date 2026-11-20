import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "LiquiStock POS",
        short_name: "LiquiStock",
        description: "POS Offline-First de Inventario, Barriles y Caja para Bares",
        theme_color: "#151929",
        background_color: "#151929",
        display: "standalone",
        orientation: "any",
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        runtimeCaching: [
          {
            // Cache uploaded product images so tablets show menus 100% offline
            urlPattern: /\/uploads\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "liquistock-product-images",
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 30,
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5174,
    host: true,
  },
});

