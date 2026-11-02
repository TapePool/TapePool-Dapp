/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mainnet` (default). The fork address book arrives with the e2e setup (B4). */
  readonly VITE_NETWORK?: string;
  /** Base URL of the keeper's read-only routes. Unset: the app does not call a keeper. */
  readonly VITE_KEEPER_URL?: string;
  /** A deployed TapeLens. Unset: the app places TapeLens's runtime code at a dummy address (SPEC-PHASE5-APP O-1). */
  readonly VITE_TAPELENS_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
