import './styles/fonts.css';
import './styles/design.css';
import './styles/app.css';
import './styles/utilities.css';
import { createApp } from './app';
import { ChainActions } from './chain/actions';
import { GateStore } from './chain/gates';
import { createKeeperClient } from './chain/keeper';
import { viemReader } from './chain/reader';
import { createRpc } from './chain/rpc';
import { ChainSource } from './chain/source';
import { browserSession } from './chain/storage';
import { Wallet } from './chain/wallet';
import { readConfig } from './config';
import { initLang } from './i18n';
import { localStore } from './logic/history';

/**
 * Boot. The screens read the chain through `ChainSource` (public RPCs only) and reach the wallet through
 * `ChainActions`. Fixtures exist only in development: `?fixture=<name>` loads them through a dynamic import that the
 * production build removes with `import.meta.env.DEV`.
 */
function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

function inFrame(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true; // a cross-origin parent throws: that is a frame too
  }
}

const els = { screen: el('tp-screen'), modal: el('tp-mdl'), modalBox: el('tp-mdl-box'), toast: el('tp-toast') };
initLang(location.search);
const framed = inFrame();
const fixtureName = import.meta.env.DEV ? new URLSearchParams(location.search).get('fixture') : null;

if (import.meta.env.DEV && fixtureName !== null) {
  void import('./dev/fixture').then((m) => m.bootFixture(fixtureName, els, framed));
} else {
  const config = readConfig(import.meta.env);
  const wallet = new Wallet(window as never, localStore());
  const x = viemReader(createRpc({ url: config.rpc.xlayer }), 'xlayer');
  const b = viemReader(createRpc({ url: config.rpc.bsc }), 'bsc');
  // the harvest records (SPEC-PHASE5-PRELOAN §4.4) live in localStorage; the source and the actions share them
  const gates = new GateStore(localStore(), config.book.chainId);
  const source = new ChainSource({
    config,
    x,
    b,
    wallet,
    keeper: createKeeperClient(config.keeperUrl),
    store: localStore(),
    gates,
    session: browserSession(),
  });
  createApp({ ...els, source, actions: new ChainActions({ wallet, x, b, config, host: source, gates }), inFrame: framed, ascii: true });
  // a page shown inside another site never touches a wallet
  if (!framed) void wallet.init();
  source.start();
}
