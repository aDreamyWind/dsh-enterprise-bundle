import { defineConfig } from 'tsdown'

/** Inline only upstream source helpers; shared runtime services keep their peer identities. */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    alwaysBundle: [/^@deepseek-ai\/dsh-llm-pi-ai\/src\//],
  },
})
