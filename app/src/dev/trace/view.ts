import './trace.css';
import { t } from '../../i18n';
import { Engine, earliest, money, payout, ROW, STEP, TICKS, WINDOW, type Quote, type Ticket } from './engine';
import type { PriceFeed } from './feed';
import { CELL, PLACEMENT_MS, RESULT_MS, Presentation, projectX, projectY, sampleAt, targetBounds, type Projection } from './presentation';
export { OkxFeed } from './feed';

/** One game across mounts: the engine, its presentation and the live price feed. */
interface Session { game: Engine; visual: Presentation; feed: PriceFeed; loading: boolean }
/** Opens a game on the live feed. The opening line is the feed's last 120 s, loaded once; the game waits until then. */
function open(feed: PriceFeed): Session {
  const s: Session = { game: new Engine(), visual: new Presentation(), feed, loading: true };
  void feed.history().then((prices) => { s.game.load(prices); if (prices.length) s.visual.camera = s.game.price; }, () => undefined)
    .finally(() => { s.loading = false; });
  return s;
}

/** Tape runs on real prices only: `live` makes the feed when the game first opens. */
export function createTraceSession(live: () => PriceFeed): { mount(host: HTMLElement): { unmount(): void; translate(): void }; dispose(): void } {
  let session: Session | undefined;
  return {
    mount: (host) => mountTrace(host, session ??= open(live())),
    dispose: () => { session?.feed.stop(); session = undefined; },
  };
}
const COLS = 32, ROWS = 22;
// Hidden rows and columns rendered past each edge, so a camera move never uncovers an empty band.
const OVERSCAN = 1;
const price = (ticks: number): string => `$${(ticks / TICKS).toFixed(2)}`;
const time = (ms: number): string => { const n = Math.abs(Math.floor(ms / 1000)); return `${ms < 0 ? '−' : ''}${Math.floor(n / 60).toString().padStart(2, '0')}:${(n % 60).toString().padStart(2, '0')}`; };
const seconds = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));
const times = (multiplier: number): string => `${(multiplier / 100).toFixed(2)}×`;
const signed = (value: bigint): string => `${value < 0n ? '−' : '+'}${money(value < 0n ? -value : value)}`;
function mountTrace(host: HTMLElement, s: Session): { unmount(): void; translate(): void } {
  const { game, visual } = s;
  host.innerHTML = `<section class="trace">
    <div class="trace-board">
      <div class="trace-plot-scroll"><div class="trace-plot"><div class="trace-circuit" aria-hidden="true"></div><canvas aria-hidden="true"></canvas><div class="trace-window"><div class="trace-scroll"><div class="trace-grid" role="grid" aria-label="Future targets"></div></div></div></div></div>
      <div class="trace-market">
        <div class="trace-market-row"><strong>OKB / USD</strong><span class="trace-source"></span></div>
        <div class="trace-market-value"><b class="trace-price"></b><small class="trace-info"></small></div>
      </div>
      <div class="trace-result" role="status" aria-live="polite" hidden><span class="trace-result-icon" aria-hidden="true"></span><div><b class="trace-result-title"></b><span class="trace-result-return"></span><span class="trace-result-loss"></span></div></div>
      <div class="trace-feed" role="status" hidden></div>
      <div class="trace-quote" aria-live="off"></div>
      <div class="trace-stake">
        <div class="trace-balance-row"><span class="trace-balance-label"></span><strong class="trace-balance"></strong></div>
        <label for="trace-stake"></label><div class="trace-input"><input id="trace-stake" inputmode="decimal" autocomplete="off"><span>BEM</span></div>
        <div class="trace-presets"></div>
        <div class="trace-stake-foot"><small class="trace-explain"></small><details class="trace-help"><summary></summary><p></p></details></div>
      </div>
      <div class="trace-status" role="status" aria-live="polite"></div>
    </div>
    <section class="trace-drawer">
      <div class="trace-drawerbar">
        <div class="trace-tabs"><button type="button" data-action="open"></button><button type="button" data-action="history"></button></div>
        <div class="trace-summary"></div>
        <button type="button" class="trace-toggle" data-action="drawer" aria-expanded="false" aria-controls="trace-list"></button>
      </div>
      <div class="trace-list" id="trace-list" hidden></div>
    </section>
  </section>`;
  const find = <T extends Element>(selector: string): T => host.querySelector<T>(selector)!;
  const board = find<HTMLElement>('.trace-board'), plot = find<HTMLElement>('.trace-plot'), canvas = find<HTMLCanvasElement>('canvas'), grid = find<HTMLElement>('.trace-grid'), circuit = find<HTMLElement>('.trace-circuit'), input = find<HTMLInputElement>('input'), list = find<HTMLElement>('.trace-list'), summary = find<HTMLElement>('.trace-summary'), status = find<HTMLElement>('.trace-status');
  const abort = new AbortController();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let expanded = false, tab: 'open' | 'history' = 'open', frame: number | undefined, lastFrame: number | undefined;
  let listKey = '', shownVersion = -1;
  // When the last live sample was taken, on the animation frame clock.
  let sampledAt: number | undefined;
  let resultKey = '';
  let modelDirty = true, layoutKey = '', rows = 1, cols = 1, firstRow = 0, lastRow = 0, lastCol = 0;
  let width = 1000, height = 500, backingWidth = 0, backingHeight = 0;
  const ctx = canvas.getContext('2d');
  let capture: { quote: Quote; button: HTMLButtonElement; x: number; y: number; moved: boolean } | undefined;
  let focusedQuote: Quote | undefined;
  let hovered: HTMLButtonElement | undefined;
  // The drawer row under the pointer, outlined on the board.
  let marked: { low: number; start: number } | undefined;
  const buttons: HTMLButtonElement[] = [];
  const quotes = new Map<HTMLButtonElement, Quote>();
  input.value = game.stake;
  for (const preset of ['0.05', '0.10', '0.25', '0.50', '1', '2']) { const button = document.createElement('button'); button.type = 'button'; button.textContent = preset; button.dataset.preset = preset; find('.trace-presets').append(button); }
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) { const button = document.createElement('button'); button.type = 'button'; button.className = 'trace-cell'; button.setAttribute('role', 'gridcell'); button.tabIndex = row === 0 && col === 0 ? 0 : -1; grid.append(button); buttons.push(button); }
  function quoteText(q: Quote): string { return `${price(q.low)}–${price(q.high)} · ${time(q.start)}–${time(q.end)} · ${times(q.multiplier)} · ${money(q.stake)} BEM → ${money(payout(q.stake, q.multiplier))} BEM`; }
  function announce(message: string): void { status.textContent = message; }
  function syncFeedback(): void {
    const notice = visual.notice, result = find<HTMLElement>('.trace-result');
    const key = notice ? `${notice.born}:${notice.wins}:${notice.losses}:${notice.returned}:${notice.lost}:${t('Won', '获胜')}` : '';
    if (key !== resultKey) {
      resultKey = key; result.hidden = !notice;
      if (notice) {
        const mixed = notice.wins > 0 && notice.losses > 0;
        result.dataset.outcome = mixed ? 'mixed' : notice.wins ? 'won' : 'lost';
        find('.trace-result-icon').textContent = mixed ? '±' : notice.wins ? '✓' : '×';
        find('.trace-result-title').textContent = mixed
          ? t(`${notice.wins} won · ${notice.losses} lost`, `${notice.wins} 笔获胜 · ${notice.losses} 笔未中`)
          : notice.wins ? t(notice.wins === 1 ? 'Won' : `${notice.wins} bets won`, notice.wins === 1 ? '获胜' : `${notice.wins} 笔投注获胜`)
          : t(notice.losses === 1 ? 'Lost' : `${notice.losses} bets lost`, notice.losses === 1 ? '未中' : `${notice.losses} 笔投注未中`);
        find('.trace-result-return').textContent = notice.wins ? t(`+${money(notice.returned)} BEM returned`, `返还 +${money(notice.returned)} BEM`) : '';
        find('.trace-result-loss').textContent = notice.losses ? t(`${money(notice.lost)} BEM stake lost`, `损失 ${money(notice.lost)} BEM 投注额`) : '';
      }
    }
    const age = notice ? visual.time - notice.born : RESULT_MS;
    const returning = !!notice?.wins && age < RESULT_MS;
    const glow = returning ? reduceMotion.matches ? .12 : .06 + .16 * Math.pow(Math.sin(Math.PI * age / RESULT_MS), 2) : 0;
    const balance = find<HTMLElement>('.trace-balance-row');
    balance.dataset.returning = String(returning); balance.style.setProperty('--return-glow', String(glow));
  }
  function geometry(): Projection { return { width, height: Math.max(1, height - 28), now: visual.time, camera: visual.camera, cell: CELL }; }
  function measure(): void {
    const rect = plot.getBoundingClientRect(); width = rect.width || 1000; height = rect.height || 500;
    const dpr = window.devicePixelRatio || 1, w = Math.round(width * dpr), h = Math.round(height * dpr);
    if (backingWidth !== w || backingHeight !== h) { canvas.width = w; canvas.height = h; backingWidth = w; backingHeight = h; }
    modelDirty = true;
  }
  function draw(p: Projection, displayed: number): void {
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    if (!game.history.length) return; // no price yet: the waiting notice says why
    const firstTime = Math.floor((p.now - p.width * .35 / CELL * WINDOW) / WINDOW) * WINDOW;
    const top = p.camera + p.height / 2 / CELL * ROW;
    // Price labels only; the circuit background behind the canvas draws every grid line.
    ctx.lineWidth = 1; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.fillStyle = '#8A9AB2';
    for (let level = Math.floor(top / (ROW * 2)) * ROW * 2; projectY(p, level) <= p.height; level -= ROW * 2) ctx.fillText(price(level), p.width - 48, projectY(p, level) + 3);
    ctx.fillStyle = '#8A9AB2'; ctx.font = '10px JetBrains Mono, monospace';
    for (let stamp = Math.ceil(firstTime / 10000) * 10000; projectX(p, stamp) < p.width - 50; stamp += 10000) ctx.fillText(time(stamp), projectX(p, stamp) + 3, p.height + 16);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, p.width - 50, p.height); ctx.clip();
    const points = game.history.filter(point => point.time <= visual.time && projectX(p, point.time) >= -CELL);
    ctx.beginPath(); points.forEach((point, i) => i ? ctx.lineTo(projectX(p, point.time), projectY(p, point.price)) : ctx.moveTo(projectX(p, point.time), projectY(p, point.price)));
    const xhead = projectX(p, visual.time), cy = projectY(p, displayed); if (points.length) ctx.lineTo(xhead, cy);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 2; ctx.strokeStyle = '#2E9BDA'; ctx.stroke();
    if (points.length) {
      ctx.lineTo(xhead, p.height); ctx.lineTo(projectX(p, points[0]!.time), p.height); ctx.closePath();
      const fill = ctx.createLinearGradient(0, 0, 0, p.height); fill.addColorStop(0, 'rgba(46,155,218,.10)'); fill.addColorStop(1, 'rgba(46,155,218,.01)');
      ctx.fillStyle = fill; ctx.fill();
    }
    const targets = new Map<string, { low: number; start: number; count: number; stake: bigint }>();
    for (const ticket of [...game.open, ...visual.pending.map(item => item.ticket)]) {
      const key = `${ticket.low}:${ticket.start}`, target = targets.get(key);
      if (target) { target.count++; target.stake += ticket.stake; }
      else targets.set(key, { low: ticket.low, start: ticket.start, count: 1, stake: ticket.stake });
    }
    for (const target of targets.values()) {
      const box = targetBounds(p, target.low, target.start);
      ctx.fillStyle = 'rgba(46,155,218,.16)'; ctx.strokeStyle = 'rgba(111,195,236,.8)'; ctx.lineWidth = 1;
      ctx.fillRect(box.x, box.y, box.width, box.height); ctx.strokeRect(box.x + .5, box.y + .5, box.width - 1, box.height - 1);
      ctx.fillStyle = '#6FC3EC'; ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillText(t(`${target.count} ${target.count === 1 ? 'bet' : 'bets'}`, `${target.count} 笔投注`), box.x + 8, box.y + 17);
      ctx.fillStyle = '#B6C8DF'; ctx.fillText(money(target.stake), box.x + 8, box.y + box.height - 9);
    }
    drawEffects(p);
    if (marked) {
      const box = targetBounds(p, marked.low, marked.start);
      ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.strokeRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4); ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#6FC3EC'; ctx.lineWidth = 1.5; ctx.lineCap = 'butt'; ctx.fillStyle = '#0E1D3D'; ctx.fillRect(xhead - 7, cy - 7, 14, 14); ctx.strokeRect(xhead - 7, cy - 7, 14, 14);
    for (let i = -4; i <= 4; i += 4) { ctx.beginPath(); ctx.moveTo(xhead - 11, cy + i); ctx.lineTo(xhead - 7, cy + i); ctx.moveTo(xhead + 7, cy + i); ctx.lineTo(xhead + 11, cy + i); ctx.moveTo(xhead + i, cy - 11); ctx.lineTo(xhead + i, cy - 7); ctx.moveTo(xhead + i, cy + 7); ctx.lineTo(xhead + i, cy + 11); ctx.stroke(); }
    ctx.restore();
  }
  function drawEffects(p: Projection): void {
    if (!ctx) return;
    for (const effect of visual.effects) {
      const box = targetBounds(p, effect.low, effect.start);
      // Settled cells stay marked and fade over the last two cells before the left edge.
      const edge = Math.min(1, Math.max(0, (box.x + box.width) / (CELL * 2)));
      if (!edge) continue;
      const duration = effect.kind === 'placed' ? PLACEMENT_MS : RESULT_MS;
      const progress = Math.min(1, Math.max(0, (visual.time - effect.born) / duration));
      const staticEffect = reduceMotion.matches;
      ctx.save();
      if (effect.kind === 'placed') {
        ctx.globalAlpha = staticEffect ? 1 : Math.min(1, (1 - progress) * 3);
        const spread = staticEffect ? 0 : 5 * Math.sin(progress * Math.PI);
        ctx.strokeStyle = '#6FC3EC'; ctx.lineWidth = 2;
        ctx.strokeRect(box.x - spread + 1, box.y - spread + 1, box.width + spread * 2 - 2, box.height + spread * 2 - 2);
        ctx.fillStyle = 'rgba(111,195,236,.09)'; ctx.fillRect(box.x, box.y, box.width, box.height);
      } else {
        const won = effect.kind === 'won', flash = staticEffect ? 0 : 1 - progress;
        ctx.globalAlpha = edge;
        ctx.fillStyle = won ? `rgba(47,194,138,${.13 + .14 * flash})` : `rgba(240,86,107,${.07 + .1 * flash})`;
        ctx.fillRect(box.x, box.y, box.width, box.height);
        ctx.strokeStyle = won ? '#2FC28A' : 'rgba(240,86,107,.7)'; ctx.lineWidth = won ? 1.5 : 1;
        if (!won) ctx.setLineDash([6, 4]);
        const spread = staticEffect ? 0 : 4 * Math.sin(progress * Math.PI);
        ctx.strokeRect(box.x - spread + .75, box.y - spread + .75, box.width + spread * 2 - 1.5, box.height + spread * 2 - 1.5);
        ctx.setLineDash([]);
        ctx.textAlign = 'center'; ctx.fillStyle = won ? '#2FC28A' : '#F58A9A'; ctx.font = '600 13px Sora, sans-serif';
        ctx.fillText(won ? t('Won', '获胜') : t('Lost', '未中'), box.x + CELL / 2, box.y + 38, CELL - 12);
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillText(won ? `+${money(effect.amount)}` : `−${money(effect.amount)}`, box.x + CELL / 2, box.y + 55, CELL - 12);
        ctx.textAlign = 'left'; ctx.font = '10px JetBrains Mono, monospace';
        if (effect.count > 1) ctx.fillText(`×${effect.count}`, box.x + 7, box.y + 15);
        ctx.textAlign = 'right'; ctx.font = '12px Sora, sans-serif'; ctx.fillText(won ? '✓' : '×', box.x + CELL - 7, box.y + 16);
        if (won && progress < 1) {
          const x = projectX(p, effect.sampleTime), y = projectY(p, effect.samplePrice);
          ctx.globalAlpha = edge * (staticEffect ? 1 : 1 - progress);
          ctx.strokeStyle = '#6FC3EC'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, staticEffect ? 10 : 8 + progress * 25, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = '#2FC28A'; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
    }
  }
  function reachable(row: number, col: number): boolean { return row >= firstRow && row <= lastRow && col >= 0 && col <= lastCol; }
  function updateGrid(p: Projection): void {
    const start = earliest(game.now);
    // Rows run from one hidden row above the row cut by the top edge to one hidden row below the bottom edge, and columns
    // one past the price gutter; the plot window clips them, so partly visible cells are drawn and slide in smoothly.
    const high = (Math.floor((p.camera + p.height / 2 / CELL * ROW) / ROW) + 1 + OVERSCAN) * ROW;
    const top = projectY(p, high), left = projectX(p, start), room = p.width - 50 - left;
    rows = Math.max(0, Math.min(ROWS, Math.ceil((p.height - top) / CELL) + OVERSCAN));
    cols = Math.max(0, Math.min(COLS, Math.ceil(room / CELL) + OVERSCAN));
    // The keyboard reaches cells that are at least half visible.
    firstRow = Math.round(-top / CELL); lastRow = Math.min(rows - 1, Math.round((p.height - top) / CELL) - 1); lastCol = Math.min(cols - 1, Math.round(room / CELL) - 1);
    const key = `${high}:${start}:${rows}:${cols}:${firstRow}:${lastRow}:${lastCol}`;
    // Whole device pixels keep the 1px circuit lines crisp while the grid pans.
    const dpr = window.devicePixelRatio || 1, snap = (value: number): number => Math.round(value * dpr) / dpr;
    const scroll = find<HTMLElement>('.trace-scroll'); scroll.style.transform = `translate(${snap(left)}px, ${snap(top)}px)`;
    // The background shares the cells' snapped origin, so its 80px lines are exactly the cell edges across the whole plot.
    const lattice = (value: number): number => (snap(value) % CELL + CELL) % CELL;
    circuit.style.backgroundPosition = `${lattice(left)}px ${lattice(top)}px`;
    grid.style.width = `${cols * CELL}px`; grid.style.height = `${rows * CELL}px`;
    if (key === layoutKey && !modelDirty) return;
    layoutKey = key;
    const active = document.activeElement as HTMLButtonElement | null; const previous = active && buttons.includes(active) ? focusedQuote : undefined;
    let focusIndex = -1, focusMoved = false;
    if (previous) { const row = (high - ROW - previous.low) / ROW, col = (previous.start - start) / WINDOW; focusMoved = !reachable(row, col); if (lastRow >= firstRow && lastCol >= 0) focusIndex = Math.max(firstRow, Math.min(lastRow, row)) * COLS + Math.max(0, Math.min(lastCol, col)); }
    buttons.forEach((button, i) => {
      const row = Math.floor(i / COLS), col = i % COLS; const low = high - ROW * (row + 1), targetStart = start + col * WINDOW;
      if (capture?.button === button && (capture.quote.low !== low || capture.quote.start !== targetStart || row >= rows || col >= cols)) capture = undefined;
      const q = row < rows && col < cols ? (capture?.button === button ? capture.quote : game.quote(low, targetStart)) : null;
      if (!q) { button.disabled = true; button.style.visibility = 'hidden'; button.tabIndex = -1; quotes.delete(button); return; }
      button.disabled = false; button.style.visibility = 'visible'; quotes.set(button, q);
      const count = game.open.filter(x => x.low === q.low && x.start === q.start).length;
      button.textContent = times(q.multiplier); button.classList.toggle('placed', count > 0); button.setAttribute('aria-label', quoteText(q));
    });
    if (focusIndex >= 0) { const next = buttons[focusIndex]!; if (active !== next) { if (active) active.tabIndex = -1; next.tabIndex = 0; next.focus(); } focusedQuote = quotes.get(next); if (focusedQuote) find('.trace-quote').textContent = quoteText(focusedQuote); if (focusMoved) announce(t('Focus moved to an available target.', '焦点已移至可投注目标。')); }
    else if (!active || !buttons.includes(active)) {
      // Keep the single tab stop on a cell the keyboard can reach.
      const stop = buttons.findIndex(b => b.tabIndex === 0);
      if (stop < 0 || !reachable(Math.floor(stop / COLS), stop % COLS)) { if (stop >= 0) buttons[stop]!.tabIndex = -1; if (lastRow >= firstRow && lastCol >= 0) buttons[firstRow * COLS]!.tabIndex = 0; }
    }
    if (hovered && !capture && focusIndex < 0) { const q = quotes.get(hovered); if (q) find('.trace-quote').textContent = quoteText(q); }
    modelDirty = false;
  }
  function tabLabel(button: HTMLElement, label: string, count: number): void {
    const key = `${label}:${count}`; if (button.dataset.label === key) return; button.dataset.label = key;
    const badge = document.createElement('span'); badge.className = 'trace-count'; badge.textContent = String(count); button.replaceChildren(label, badge);
  }
  /** One drawer row: status text and tone, and the payout cell (potential while open, gross once settled). */
  function describe(ticket: Ticket): { status: string; tone: string; amount: string } {
    if (ticket.status === 'won') return { status: t('Won', '获胜'), tone: 'won', amount: `+${money(ticket.payout)}` };
    if (ticket.status === 'lost') return { status: t('Lost', '未中'), tone: 'lost', amount: '0.00' };
    const wait = seconds(ticket.start - game.now), left = seconds(ticket.end - game.now), amount = money(payout(ticket.stake, ticket.multiplier));
    return wait > 0
      ? { status: t(`Starts in ${wait}s`, `${wait} 秒后开始`), tone: 'wait', amount }
      : { status: t(`Live · ${left}s left`, `进行中 · 剩余 ${left} 秒`), tone: 'live', amount };
  }
  function stat(label: string, value: string, tone = ''): HTMLElement {
    const item = document.createElement('span'), name = document.createElement('small'), figure = document.createElement('b');
    item.className = 'trace-stat'; name.textContent = label; figure.textContent = value; if (tone) figure.dataset.tone = tone; item.append(name, figure); return item;
  }
  function renderSummary(tickets: Ticket[]): void {
    const stake = tickets.reduce((sum, x) => sum + x.stake, 0n);
    if (tab === 'open') {
      const most = tickets.reduce((sum, x) => sum + payout(x.stake, x.multiplier), 0n);
      summary.replaceChildren(...tickets.length ? [stat(t('At stake', '投注中'), `${money(stake)} BEM`), stat(t('Max payout', '最高返还'), `${money(most)} BEM`)] : []);
      return;
    }
    const wins = tickets.filter(x => x.status === 'won'), returned = wins.reduce((sum, x) => sum + x.payout, 0n), net = returned - stake;
    summary.replaceChildren(...tickets.length ? [
      stat(t('Won', '获胜'), String(wins.length), 'won'), stat(t('Lost', '未中'), String(tickets.length - wins.length), 'lost'),
      stat(t('Staked', '投注'), money(stake)), stat(t('Returned', '返还'), money(returned)),
      stat(t('Net', '净额'), `${signed(net)} BEM`, net > 0n ? 'won' : net < 0n ? 'lost' : ''),
    ] : []);
  }
  function renderList(tickets: Ticket[]): void {
    const rows = tickets.map(ticket => ({ ticket, ...describe(ticket) }));
    const heads = [t('Bet', '编号'), t('Target', '目标区间'), t('Window', '时间窗口'), tab === 'open' ? t('Status', '状态') : t('Result', '结果'), t('Stake', '投注额'), t('Multiplier', '倍数'), tab === 'open' ? t('Payout if won', '获胜返还') : t('Payout', '返还')];
    const empty = tab === 'open' ? t('No open bets. Click a target on the grid to place one.', '暂无进行中的投注。点击网格中的目标即可投注。') : t('No settled bets yet.', '暂无已结算的投注。');
    const key = `${tab}:${heads.join('|')}:${empty}:${rows.map(r => `${r.ticket.id}:${r.status}:${r.amount}`).join('|')}`;
    if (key === listKey) return;
    listKey = key; renderSummary(tickets);
    if (!rows.length) { const note = document.createElement('p'); note.className = 'trace-empty'; note.textContent = empty; list.replaceChildren(note); return; }
    // One number of decimals for the money columns keeps the decimal points aligned.
    const places = Math.max(2, ...rows.flatMap(r => [money(r.ticket.stake), r.amount]).map(value => value.split('.')[1]?.length ?? 0));
    const align = (value: string): string => { const [whole, fraction = ''] = value.split('.'); return `${whole}.${fraction.padEnd(places, '0')}`; };
    const table = document.createElement('table'), head = table.createTHead().insertRow(), body = table.createTBody();
    heads.forEach((label, i) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; if (i >= 4) th.className = 'num'; head.append(th); });
    for (const { ticket, status: text, tone, amount } of rows) {
      const row = body.insertRow(); row.dataset.low = String(ticket.low); row.dataset.start = String(ticket.start);
      const add = (value: string, className = ''): HTMLTableCellElement => { const td = row.insertCell(); td.textContent = value; if (className) td.className = className; return td; };
      add(`#${ticket.id}`, 'id'); add(`${price(ticket.low)}–${price(ticket.high)}`); add(`${time(ticket.start)}–${time(ticket.end)}`);
      const badge = document.createElement('span'); badge.className = 'trace-badge'; badge.dataset.tone = tone; badge.textContent = text; row.insertCell().append(badge);
      add(align(money(ticket.stake)), 'num'); add(times(ticket.multiplier), 'num'); add(align(amount), `num pay-${tone}`);
    }
    list.replaceChildren(table);
  }
  function refresh(): void {
    syncFeedback(); shownVersion = game.version; frozen(performance.now());
    find('.trace-price').textContent = game.history.length ? price(game.price) : '—';
    wait(performance.now()); find('.trace-balance-label').textContent = t('Demo balance', '模拟余额'); find('.trace-balance').textContent = `${money(game.balance)} BEM`;
    host.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === game.stake)));
    const openTab = find<HTMLElement>('[data-action="open"]'), historyTab = find<HTMLElement>('[data-action="history"]');
    tabLabel(openTab, t('Open', '进行中'), game.open.length + visual.pending.length);
    tabLabel(historyTab, t('History', '历史'), game.settled.length - visual.pending.length);
    openTab.classList.toggle('active', tab === 'open'); historyTab.classList.toggle('active', tab === 'history');
    openTab.setAttribute('aria-pressed', String(tab === 'open')); historyTab.setAttribute('aria-pressed', String(tab === 'history'));
    const pendingIds = new Set(visual.pending.map(item => item.ticket.id));
    const tickets = tab === 'open'
      ? [...game.open, ...visual.pending.map(item => ({ ...item.ticket, status: 'open' as const, payout: 0n }))].sort((a, b) => a.start - b.start || a.id - b.id)
      : game.settled.filter(ticket => !pendingIds.has(ticket.id));
    renderList(tickets);
    modelDirty = true; updateGrid(geometry()); draw(geometry(), sampleAt(game.history, visual.time));
  }
  function translate(): void {
    find('.trace-info').textContent = t('OKX index price', 'OKX 指数价格');
    find('.trace-explain').textContent = t('Virtual BEM only', '仅模拟 BEM');
    find('.trace-help summary').textContent = t('Rules', '规则');
    find('.trace-help p').textContent = t('Choose a stake, then a target. A sampled price inside its time and price range wins; payout includes the stake. Prices are the OKX OKB-USD index; the game waits whenever it stops updating. Multipliers follow recent volatility with a 5% demo margin. No real funds are used.', '选择投注额和目标。采样价格在指定时间和价格区间内即获胜，返还包含本金。价格为 OKX 的 OKB-USD 指数，指数停止更新时游戏会等待。倍数根据近期波动计算，含 5% 演示差价。不使用真实资金。');
    find('label').textContent = t('Stake', '投注额');
    find('[data-action="drawer"]').textContent = expanded ? t('Hide bets', '收起投注') : t('Show bets', '展开投注'); refresh();
  }
  /** Why the live game cannot sample right now, or '' when it can. Waiting stops game time, so no deadline passes unseen. */
  function waiting(now: number): string {
    if (s.loading) return t('Loading the OKX price…', '正在加载 OKX 价格…');
    const state = s.feed.state(now);
    return state === 'connecting' ? t('Connecting to OKX…', '正在连接 OKX…')
      : state === 'stale' ? t('The OKX price stopped updating. The game waits and resumes on its own; open bets keep their time.', 'OKX 价格已暂停更新。游戏会等待并自动继续，进行中的投注时间不受影响。') : '';
  }
  function wait(now: number): string {
    const reason = waiting(now), notice = find<HTMLElement>('.trace-feed'), badge = find<HTMLElement>('.trace-source');
    if (notice.textContent !== reason) notice.textContent = reason;
    notice.hidden = !reason;
    const state = reason ? 'wait' : 'live', label = reason ? t('WAITING', '等待中') : t('LIVE · OKX', '实时 · OKX');
    if (badge.dataset.state !== state || badge.textContent !== label) { badge.dataset.state = state; badge.textContent = label; }
    return reason;
  }
  /** One live sample: the newest index price, held between pushes. A failed history load starts the line here. */
  function sampleLive(now: number): Ticket[] {
    const latest = s.feed.latest()!.price;
    if (!game.history.length) { game.load([latest]); visual.camera = latest; }
    // Game time stood still (hidden tab, waiting, remount) while the market moved: quotes from then are void.
    if (!placeable(now)) game.version++;
    sampledAt = now;
    return game.sample(latest);
  }
  /**
   * Bets are taken only while live samples are flowing. Game time stops on a hidden tab and while waiting but the real
   * market does not, so a quote priced at a frozen price could be placed on a move the player has already seen.
   */
  function placeable(now: number): boolean { return sampledAt !== undefined && now - sampledAt <= 3 * STEP; }
  function frozen(now: number): void { grid.classList.toggle('frozen', !placeable(now)); }
  function tick(now: number): void {
    const dpr = window.devicePixelRatio || 1;
    if (backingWidth !== Math.round(width * dpr) || backingHeight !== Math.round(height * dpr)) measure();
    if (wait(now)) {
      // While waiting no sample refreshes the page, so pick up a newly loaded opening history here.
      if (game.version !== shownVersion) refresh();
      frozen(now); lastFrame = now; const p = geometry(); updateGrid(p); draw(p, sampleAt(game.history, visual.time)); frame = requestAnimationFrame(tick); return;
    }
    if (lastFrame === undefined) lastFrame = now;
    const elapsed = Math.min(STEP, Math.max(0, now - lastFrame)); lastFrame = now;
    visual.phase += elapsed;
    if (visual.phase >= STEP) { visual.phase -= STEP; const done = sampleLive(now); visual.queue(done, game.now, game.price); refresh(); }
    frozen(now);
    const displayed = sampleAt(game.history, visual.time); visual.advance(elapsed, game.now, displayed);
    const released = visual.release(); if (released.length) { announce(''); refresh(); }
    syncFeedback(); const p = geometry(); updateGrid(p); draw(p, sampleAt(game.history, visual.time)); frame = requestAnimationFrame(tick);
  }
  function loop(): void { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; lastFrame = undefined; if (document.visibilityState !== 'hidden') frame = requestAnimationFrame(tick); }
  function show(open: boolean): void { expanded = open; list.hidden = !open; find('[data-action="drawer"]').setAttribute('aria-expanded', String(open)); }

  function click(e: MouseEvent): void {
    const target = (e.target as Element).closest<HTMLButtonElement>('button'); if (!target || !host.contains(target)) return;
    if (target.classList.contains('trace-cell')) {
      if (!placeable(performance.now())) { capture = undefined; frozen(performance.now()); announce(t('Bets open while the live price is updating.', '实时价格更新时才可投注。')); return; }
      const q = e.detail === 0 ? focusedQuote ?? quotes.get(target) : capture?.button === target && !capture.moved ? capture.quote : undefined; capture = undefined;
      const ticket = q ? game.place(q) : null;
      if (!ticket) { focusedQuote = undefined; announce(t('Quote changed or unavailable. Please try again.', '报价已变更或不可用，请重试。')); }
      else { visual.placed(ticket); announce(t('Bet placed.', '投注成功。')); } refresh(); return;
    }
    if (target.dataset.preset) { game.setStake(target.dataset.preset); input.value = game.stake; focusedQuote = undefined; }
    switch (target.dataset.action) {
      case 'drawer': show(!expanded); break;
      case 'open': tab = 'open'; show(true); break;
      case 'history': tab = 'history'; show(true); break;
    } translate();
  }
  function down(e: PointerEvent): void { const b = (e.target as Element).closest<HTMLButtonElement>('.trace-cell'); const q = b && quotes.get(b); if (b && q) { capture = { button: b, quote: q, x: e.clientX, y: e.clientY, moved: false }; find('.trace-quote').textContent = quoteText(q); if (document.activeElement === b) focusedQuote = q; } }
  function move(e: PointerEvent): void { if (capture && Math.hypot(e.clientX - capture.x, e.clientY - capture.y) > 8) capture.moved = true; }
  function focus(e: FocusEvent): void { const b = (e.target as Element).closest<HTMLButtonElement>('.trace-cell'); if (b) { focusedQuote = quotes.get(b); if (focusedQuote) find('.trace-quote').textContent = quoteText(focusedQuote); } }
  function blur(e: FocusEvent): void { if ((e.target as Element).classList.contains('trace-cell')) focusedQuote = undefined; }
  function hover(e: MouseEvent): void { const b = (e.target as Element).closest<HTMLButtonElement>('.trace-cell'); const q = b && quotes.get(b); hovered = b ?? undefined; if (q) find('.trace-quote').textContent = quoteText(q); }
  function mark(next: { low: number; start: number } | undefined): void { if (next?.low === marked?.low && next?.start === marked?.start) return; marked = next; draw(geometry(), sampleAt(game.history, visual.time)); }
  function point(e: MouseEvent): void { const row = (e.target as Element).closest<HTMLElement>('tr[data-low]'); mark(row ? { low: Number(row.dataset.low), start: Number(row.dataset.start) } : undefined); }
  function key(e: KeyboardEvent): void { const b = (e.target as Element).closest<HTMLButtonElement>('.trace-cell'); if (!b) return; const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? COLS : e.key === 'ArrowUp' ? -COLS : 0; if (!delta) return; e.preventDefault(); const idx = buttons.indexOf(b); const row = Math.floor(idx / COLS), col = idx % COLS; const nextRow = Math.max(firstRow, Math.min(lastRow, row + (delta === COLS ? 1 : delta === -COLS ? -1 : 0))); const nextCol = Math.max(0, Math.min(lastCol, col + (delta === 1 ? 1 : delta === -1 ? -1 : 0))); if (!reachable(nextRow, nextCol)) return; const next = buttons[nextRow * COLS + nextCol]!; b.tabIndex = -1; next.tabIndex = 0; next.focus(); }
  function change(): void { game.setStake(input.value); focusedQuote = undefined; refresh(); }
  function visibility(): void { loop(); }
  const options = { signal: abort.signal };
  reduceMotion.addEventListener('change', () => { syncFeedback(); draw(geometry(), sampleAt(game.history, visual.time)); }, options);
  host.addEventListener('click', click, options); host.addEventListener('pointerdown', down, options); host.addEventListener('pointermove', move, options); host.addEventListener('pointercancel', () => { capture = undefined; }, options); host.addEventListener('focusin', focus, options); host.addEventListener('focusout', blur, options); host.addEventListener('mouseover', hover, options); host.addEventListener('keydown', key, options); input.addEventListener('input', change, options); document.addEventListener('visibilitychange', visibility, options);
  list.addEventListener('mouseover', point, options); list.addEventListener('mouseleave', () => mark(undefined), options);
  const observer = new ResizeObserver(() => { measure(); refresh(); }); observer.observe(board); measure();
  s.feed.start();
  translate();
  if (board.getBoundingClientRect().width < 700) find<HTMLElement>('.trace-plot-scroll').scrollLeft = 300;
  loop();
  // Leaving Tape closes the socket; coming back reconnects, and the game waits until a fresh price arrives.
  return { translate, unmount() { if (frame !== undefined) cancelAnimationFrame(frame); lastFrame = undefined; s.feed.stop(); observer.disconnect(); abort.abort(); host.replaceChildren(); } };
}
