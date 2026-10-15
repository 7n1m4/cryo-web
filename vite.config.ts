import { defineConfig } from 'vite'

export default defineConfig({
  // The game ships flat, so keep asset URLs relative: the built index.html
  // then opens from a server and from disk.
  base: './',
})
