import type { WalletOption } from '../model';

/**
 * What the wallet picker needs, without a DOM and without a provider object: cleaning what a wallet announces about itself
 * (all of it is untrusted), and sorting the wallets into "Installed" and "Recommended".
 */

/** The `rdns` and `uuid` the plain `window.ethereum` gets when no wallet announced itself over EIP-6963. */
export const FALLBACK_ID = 'window.ethereum';

export const MAX_NAME = 32;
export const MAX_ICON = 200_000;

/** The only icons shown: a base64 raster or SVG data URI. An `<img>` never runs a script, and the policy allows `data:` images. */
const ICON = /^data:image\/(?:png|svg\+xml|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The icon a wallet announced, if (and only if) it is a base64 image data URI of reasonable size. */
export function safeIcon(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_ICON && ICON.test(v) ? v : null;
}

/** Controls, zero-width characters and the bidirectional overrides that can make one name read as another. */
const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];
const HIDDEN = new RegExp(`[${HIDDEN_RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');

/** A wallet's name for the screen: no control or direction characters, one line, at most `MAX_NAME` characters. */
export function cleanName(v: unknown): string {
  const text = (typeof v === 'string' ? v : '').replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  if (chars.length === 0) return 'Wallet';
  return chars.length > MAX_NAME ? `${chars.slice(0, MAX_NAME - 1).join('')}…` : text;
}

/** An id that is safe in an attribute: the announced `uuid` if it is plain, else the position. */
export function optionId(uuid: unknown, index: number): string {
  return typeof uuid === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(uuid) ? uuid : `w${index}`;
}

export interface RawWallet {
  uuid: unknown;
  name: unknown;
  icon: unknown;
  rdns: unknown;
}

/**
 * Clean what the wallets announced. One entry per `rdns` (a wallet that announces twice is listed once), and ids are unique.
 * `item` is whatever the caller needs to find the wallet again (the provider), carried along untouched.
 */
export function buildOptions<T>(items: readonly T[], read: (item: T) => RawWallet): { option: WalletOption; item: T }[] {
  const out: { option: WalletOption; item: T }[] = [];
  const rdnsSeen = new Set<string>();
  const idsSeen = new Set<string>();
  items.forEach((item, i) => {
    const raw = read(item);
    const rdns = typeof raw.rdns === 'string' ? raw.rdns.slice(0, 100) : '';
    if (rdns !== '' && rdnsSeen.has(rdns)) return;
    rdnsSeen.add(rdns);
    let id = optionId(raw.uuid, i);
    while (idsSeen.has(id)) id = `${id}_${i}`;
    idsSeen.add(id);
    const fallback = rdns === FALLBACK_ID && raw.uuid === FALLBACK_ID;
    out.push({ option: { id, name: cleanName(raw.name), icon: fallback ? null : safeIcon(raw.icon), rdns, fallback }, item });
  });
  return out;
}

/* ───────── the recommended list ───────── */

export type RecommendedKey = 'okx' | 'metamask' | 'rabby' | 'binance' | 'trust' | 'phantom';

export interface Recommended {
  key: RecommendedKey;
  name: string;
  /** The page to install it from. Opened in a new tab. */
  url: string;
  /** What the wallet announces as `rdns` when it is installed. */
  rdns: readonly string[];
  /** The name it announces, for a wallet that announces an unexpected `rdns`. */
  named: RegExp;
}

/**
 * The order the app prefers installed wallets in (OKX Wallet first): `groupWallets` ranks the "Installed" group by it.
 * Phantom is here only to be known by its logo when installed; it is not in `RECOMMENDED_ORDER`, so it is never recommended.
 */
export const RECOMMENDED: readonly Recommended[] = [
  { key: 'okx', name: 'OKX Wallet', url: 'https://web3.okx.com/download', rdns: ['com.okex.wallet'], named: /^okx/i },
  { key: 'metamask', name: 'MetaMask', url: 'https://metamask.io/download/', rdns: ['io.metamask'], named: /metamask/i },
  { key: 'rabby', name: 'Rabby Wallet', url: 'https://rabby.io/', rdns: ['io.rabby'], named: /rabby/i },
  { key: 'binance', name: 'Binance Wallet', url: 'https://www.binance.com/en/web3wallet', rdns: ['com.binance.w3w', 'com.binance.wallet'], named: /binance/i },
  { key: 'trust', name: 'Trust Wallet', url: 'https://trustwallet.com/download', rdns: ['com.trustwallet.app'], named: /trust\s*wallet/i },
  // never linked (not recommended), so no download page: the build allows no host it does not need
  { key: 'phantom', name: 'Phantom', url: '', rdns: ['app.phantom'], named: /^phantom/i },
];

/** The order the "Recommended" group and the "Get a Wallet" view list the wallets in. It is not the ranking above. */
export const RECOMMENDED_ORDER: readonly RecommendedKey[] = ['binance', 'trust', 'rabby', 'metamask', 'okx'];

/** The recommended wallet with this key, or null (the key comes from markup, so it is never trusted). */
export function recommendedByKey(key: unknown): Recommended | null {
  return RECOMMENDED_ORDER.includes(key as RecommendedKey) ? (RECOMMENDED.find((r) => r.key === key) ?? null) : null;
}

/** The recommended wallets in display order. */
export const RECOMMENDED_SHOWN: readonly Recommended[] = RECOMMENDED_ORDER.map((k) => recommendedByKey(k)).filter((r): r is Recommended => r !== null);

const isRecommended = (r: Recommended, o: WalletOption): boolean => r.rdns.includes(o.rdns) || r.named.test(o.name);

/**
 * The recommended wallet an installed wallet announced itself as, by its `rdns` only (the name is free text and could be anything),
 * for the logo to show when the wallet's own icon was not usable.
 */
export function knownWallet(o: WalletOption): Recommended | null {
  return o.fallback || o.rdns === '' ? null : (RECOMMENDED.find((r) => r.rdns.includes(o.rdns)) ?? null);
}

export interface InstalledRow {
  option: WalletOption;
  /** This is the wallet that connected last. */
  recent: boolean;
}

export interface WalletGroups {
  installed: InstalledRow[];
  /** The recommended wallets that are not installed, in display order. */
  recommended: Recommended[];
}

/**
 * "Installed" is every wallet found, the one used last first, then OKX Wallet, MetaMask and Rabby in the order the app prefers them,
 * then the others as they announced themselves. "Recommended" is the shown list minus what is installed.
 */
export function groupWallets(options: readonly WalletOption[], recentRdns: string | null): WalletGroups {
  const rank = (o: WalletOption): number => {
    const i = RECOMMENDED.findIndex((r) => isRecommended(r, o));
    return i < 0 ? RECOMMENDED.length : i;
  };
  const installed = options
    .map((option, i) => ({ option, i, recent: recentRdns !== null && recentRdns !== '' && option.rdns === recentRdns }))
    .sort((a, b) => Number(b.recent) - Number(a.recent) || rank(a.option) - rank(b.option) || a.i - b.i)
    .map(({ option, recent }) => ({ option, recent }));
  return { installed, recommended: RECOMMENDED_SHOWN.filter((r) => !options.some((o) => isRecommended(r, o))) };
}
