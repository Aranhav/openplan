import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const BACKEND = "http://localhost:8080"

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: BACKEND,
        ws: true,
        // The server only opens a live socket for a page of its own origin, and the page is on
        // Vite's, so the proxy says the socket comes from the backend's.
        configure: (proxy) => {
          proxy.on("proxyReqWs", (request) => request.setHeader("origin", BACKEND))
        },
      },
    },
  },
})
