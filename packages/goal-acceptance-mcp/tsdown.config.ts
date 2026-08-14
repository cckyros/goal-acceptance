import { defineConfig } from 'tsdown'

/** Build the package root and the stdio MCP server entry. */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: ['lib/types/mcp-server.js'],
    outDir: 'bin',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outExtensions: () => ({ js: '.mjs' }),
    dts: false,
    clean: false,
  },
])
