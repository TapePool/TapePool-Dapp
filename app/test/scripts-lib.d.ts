// The build tooling in scripts/lib is plain JavaScript (it runs under node with no build step). The tests and vite.config.ts
// import it, so it is declared here as untyped.
declare module '*/scripts/lib/csp.mjs';
declare module '*/scripts/lib/dist.mjs';
declare module '*/scripts/lib/single.mjs';
declare module '*/scripts/lib/deweb.mjs';
