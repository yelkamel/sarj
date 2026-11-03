/**
 * Unit tests — the deterministic code, without a model.
 * fetch to Ollama is mocked in every test: `npm test` must pass with no Ollama running.
 * Behaviour end to end, with a real model, stays in `npm run eval`.
 */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  // Sources import "./x.js" (NodeNext); point Jest at the .ts file.
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: { "^.+\\.ts$": ["ts-jest", { useESM: true }] },
  collectCoverageFrom: ["src/**/*.ts", "!src/cli.ts", "!src/server.ts"],
  coverageThreshold: {
    "./src/harness.ts": { lines: 80, branches: 80 },
    "./src/rag.ts": { lines: 80, branches: 80 },
  },
};
