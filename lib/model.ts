// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// Board: ALL 758 protocols in the snapshot, ranked by implied_value_usd descending, ranks 1..758.
// A protocol's status comes only from what its record carries:
//   pre-token      records no token at all (mcap, gecko_id and symbol all null) — 342 in this snapshot
//   live           mcap_usd > 0 — the market's own value, never a model number — 128
//   live-unpriced  records a token but no usable market cap (mcap null, or 0 / -1 in 16 records) — 288
//   not-a-launch   records no token BUT is structurally not a launch: a centralised exchange, a bridge,
//     a liquid-staking / restaking product, a wrapped or staked product, an exchange-branded product,
//     or a versioned pool name — the snapshot's own watchlist rule, applied here so the top of the
//     pre-token board is not Robinhood, Bybit, WBTC and Binance staked ETH. 144 of the 342 record-no-
//     token rows fall here; 198 genuine pre-token launches remain. Not-a-launch rows stay on the board
//     (758/758 coverage) at their fitted value for reference only, with verdict Skip, and never enter
//     the pre-token ranking.
//
// Implied value, fitted at runtime from the snapshot itself — no protocol name is ever special-cased:
//
//   comps fit (OLS, on the 128 live protocols with mcap > 0 and tvl > 0):
//     log(mcap_usd) = a + b * log(tvl_usd)
//     fitted launch value = exp(a + b * ln(tvl_usd))
//   token odds: empirical table, age band x TVL band, share of protocols in the cell that record a
//     token, Laplace-smoothed toward the global rate: rate = (k + 2*0.55) / (n + 2), clamped [0.05, 0.95].
//     Age unknown (listed_at null, 113 protocols): the TVL band's pooled rate across all ages.
//   growth tilt: mult = 1 + clamp(change_7d, -60, 120) * 0.001  (range 0.94-1.12, a mild prior)
//   pre-token:  implied = round(fitted * odds * tilt)   (expected value of a launch)
//   live:       implied = mcap_usd
//   live-unpriced: implied = round(fitted) — a model value, for reference only, flagged in the UI
//
// Farm verdict (documented planning assumption: a farmer's share is assumed to be 0.1% of the
// expected value — a planning assumption, stated as such, never a promise):
//   farm_cost_usd = setup gas ($4, or $8 for capital >= $150) + $2/week x hold weeks
//                   + capital locked at 5% APR over the hold days
//   farmer_share_usd = 0.001 * expected_value (pre-token only; live rows get verdict "live", no share)
//   share >= 3x cost -> "Farm"; share >= cost -> "Thin"; else "Skip".
//
// Farm steps: six steps per row, templated by the protocol's own category, chains, TVL band and age,
// each step an action with a cost and a time. Live rows get a position plan in the same format.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-2-fitted';

/** Age bands (days) and TVL bands (USD) of the token-odds table. */
export const AGE_BANDS: Array<[number, number]> = [[0, 365], [365, 730], [730, 1095], [1095, Infinity]];
export const TVL_BANDS: Array<[number, number]> = [[5_000_000, 100_000_000], [100_000_000, 1_000_000_000], [1_000_000_000, Infinity]];
export const GLOBAL_RATE_PRIOR = 0.55;
export const PRIOR_WEIGHT = 2;
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 120;
export const GROWTH_PER_POINT = 0.001;
export const FARMER_SHARE = 0.001;
export const LOCKUP_APR = 0.05;
export const GAS_PER_WEEK = 2;

/** One cell of the token-odds table. */
export interface OddsCell {
  age_lo: number;
  age_hi: number | null; // null = no upper bound
  tvl_lo: number;
  tvl_hi: number | null; // null = no upper bound
  n: number;
  k: number;
  rate: number;
}

/** The fitted comps model and its honest diagnostics. */
export interface CompsFit {
  n: number;
  a: number;
  b: number;
  r2: number;
  loo_mae: number;
  resid_sd: number;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export type TokenStatus = 'pre-token' | 'live' | 'live-unpriced' | 'not-a-launch';

/** Categories that are structurally not a token launch (the snapshot's own watchlist rule). */
export const NON_LAUNCH_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAMES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

/** Why a protocol that records no token is still not a launch candidate, or null. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && NON_LAUNCH_CATEGORIES.has(p.category)) {
    if (p.category === 'CEX') return 'centralised exchange';
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') return 'bridge product';
    return 'liquid staking / restaking product';
  }
  if (VERSIONED.test(p.name)) return 'versioned pool name (a version of another protocol)';
  if (WRAPPED_OR_STAKED.test(p.name)) return 'wrapped or staked product of a token that already trades';
  if (EXCHANGE_NAMES.some((e) => p.name.toLowerCase().startsWith(e))) return 'exchange-branded product';
  return null;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  token_status: TokenStatus;
  exclusion_reason: string | null;
  fitted_value_usd: number;
  token_odds: number | null;
  growth_multiplier: number;
  expected_value_usd: number | null;
  implied_value_usd: number;
  verdict: 'Farm' | 'Thin' | 'Skip' | 'live';
  farm_cost_usd: number;
  farmer_share_usd: number | null;
  farm_steps: string[];
}

/** The dashboard's view of one row (identical to the board row: the page recomputes the model from these fields). */
export type RadarRow = BoardRow & { mcap_usd: number | null; listed_at: string | null };

/** Everything the dashboard needs: the board, the fitted model, and the odds table. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  pre_token_size: number;
  live_size: number;
  live_unpriced_size: number;
  not_a_launch_size: number;
  comps: CompsFit;
  odds_global: number;
  odds_cells: OddsCell[];
  odds_tvl_pooled: Array<{ tvl_lo: number; tvl_hi: number | null; n: number; k: number; rate: number }>;
  median_expected_pre: number;
  rows: RadarRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol records a token (gecko id or symbol), even without a market cap. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

export function tokenStatus(p: SnapshotProtocol): TokenStatus {
  if (isPreToken(p)) return exclusionReason(p) === null ? 'pre-token' : 'not-a-launch';
  if (typeof p.mcap_usd === 'number' && p.mcap_usd > 0) return 'live';
  return 'live-unpriced';
}

/** OLS log(mcap) = a + b*log(tvl) on the live comps, with R2, residual SD and leave-one-out MAE. */
export function fitComps(protocols: SnapshotProtocol[]): CompsFit {
  const comps = protocols.filter((p) => typeof p.mcap_usd === 'number' && p.mcap_usd > 0 && p.tvl_usd > 0);
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd!));
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = a + b * xs[i]!;
    ssRes += (ys[i]! - pred) * (ys[i]! - pred);
    ssTot += (ys[i]! - my) * (ys[i]! - my);
  }
  const r2 = 1 - ssRes / ssTot;
  const residSd = Math.sqrt(ssRes / (n - 2));
  // Leave-one-out MAE: refit without each comp in turn (n = 128, trivial cost, exact).
  let looSum = 0;
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      sx += xs[j]!;
      sy += ys[j]!;
    }
    const mx2 = sx / (n - 1);
    const my2 = sy / (n - 1);
    let sxy2 = 0;
    let sxx2 = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      sxy2 += (xs[j]! - mx2) * (ys[j]! - my2);
      sxx2 += (xs[j]! - mx2) * (xs[j]! - mx2);
    }
    const b2 = sxy2 / sxx2;
    const a2 = my2 - b2 * mx2;
    looSum += Math.abs(ys[i]! - (a2 + b2 * xs[i]!));
  }
  return { n, a: round4(a), b: round4(b), r2: round4(r2), loo_mae: round4(looSum / n), resid_sd: round4(residSd) };
}

/** The fitted launch value for a TVL under the comps fit. */
export function fittedValue(tvlUsd: number, fit: CompsFit): number {
  return Math.exp(fit.a + fit.b * Math.log(Math.max(1, tvlUsd)));
}

/** The global share of protocols that record a token. */
export function globalTokenRate(protocols: SnapshotProtocol[]): number {
  const k = protocols.filter(recordsToken).length;
  return k / protocols.length;
}

function smoothRate(k: number, n: number, prior: number): number {
  const r = (k + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT);
  return Math.min(0.95, Math.max(0.05, r));
}

function inBand(v: number, lo: number, hi: number): boolean {
  return v >= lo && v < hi;
}

/** The empirical token-odds table: age band x TVL band, Laplace-smoothed toward the global rate. */
export function oddsTable(protocols: SnapshotProtocol[], asOf: string): { global: number; cells: OddsCell[]; tvlPooled: RadarData['odds_tvl_pooled'] } {
  const global = globalTokenRate(protocols);
  const cells: OddsCell[] = [];
  for (const [ageLo, ageHi] of AGE_BANDS) {
    for (const [tvlLo, tvlHi] of TVL_BANDS) {
      let n = 0;
      let k = 0;
      for (const p of protocols) {
        const age = ageDays(asOf, p.listed_at);
        if (age === null) continue;
        if (inBand(age, ageLo, ageHi) && inBand(p.tvl_usd, tvlLo, tvlHi)) {
          n++;
          if (recordsToken(p)) k++;
        }
      }
      cells.push({
        age_lo: ageLo,
        age_hi: ageHi === Infinity ? null : ageHi,
        tvl_lo: tvlLo,
        tvl_hi: tvlHi === Infinity ? null : tvlHi,
        n,
        k,
        rate: round4(smoothRate(k, n, global)),
      });
    }
  }
  // Pooled by TVL band across all ages: the fallback for protocols whose age is unknown.
  const tvlPooled = TVL_BANDS.map(([tvlLo, tvlHi]) => {
    let n = 0;
    let k = 0;
    for (const p of protocols) {
      if (inBand(p.tvl_usd, tvlLo, tvlHi)) {
        n++;
        if (recordsToken(p)) k++;
      }
    }
    return { tvl_lo: tvlLo, tvl_hi: tvlHi === Infinity ? null : tvlHi, n, k, rate: round4(smoothRate(k, n, global)) };
  });
  return { global: round4(global), cells, tvlPooled };
}

/** A protocol's token odds from the table (TVL-pooled rate when its age is unknown). */
export function tokenOdds(p: SnapshotProtocol, asOf: string, table: { cells: OddsCell[]; tvlPooled: RadarData['odds_tvl_pooled'] }): { odds: number; cell: string } {
  const age = ageDays(asOf, p.listed_at);
  if (age === null) {
    const pooled = table.tvlPooled.find((c) => inBand(p.tvl_usd, c.tvl_lo, c.tvl_hi ?? Infinity));
    return { odds: pooled?.rate ?? 0.55, cell: 'age unknown — TVL band only' };
  }
  const cell = table.cells.find(
    (c) => inBand(age, c.age_lo, c.age_hi ?? Infinity) && inBand(p.tvl_usd, c.tvl_lo, c.tvl_hi ?? Infinity),
  );
  if (!cell) return { odds: 0.55, cell: 'no cell' };
  const ageLabel = cell.age_hi === null ? `${cell.age_lo}d+` : `${cell.age_lo}–${cell.age_hi}d`;
  const tvlLabel = cell.tvl_hi === null ? `$${Math.round(cell.tvl_lo / 1e9)}B+` : `$${Math.round(cell.tvl_lo / 1e6)}M–$${Math.round(cell.tvl_hi / 1e6)}M`;
  return { odds: cell.rate, cell: `${ageLabel} × ${tvlLabel} (n=${cell.n}, ${cell.k} with token)` };
}

/** The growth tilt: a mild prior, at most ±12%. */
export function growthMultiplier(change7d: number | null): number {
  const g = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(change7d, 0)));
  return round4(1 + g * GROWTH_PER_POINT);
}

/** How much capital one farm position needs, from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The full farm cost: setup gas + $2/week over the hold + 5% APR lockup on the capital. */
export function farmCostUsd(p: SnapshotProtocol, age: number | null): { cost: number; capital: number; hold: number } {
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const setupGas = capital >= 150 ? 8 : 4;
  const weeklyGas = GAS_PER_WEEK * (hold / 7);
  const lockup = capital * LOCKUP_APR * (hold / 365);
  return { cost: Math.max(1, Math.round(setupGas + weeklyGas + lockup)), capital, hold };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

/** The category's primary action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${money(capital)} of USDC to ${name} on ${chain} as a lender and keep the deposit open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Provide ${money(capital)} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge ${money(capital)} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake ${money(capital)} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('synthetic')) return `Deposit ${money(capital)} of USDC as margin on ${name} on ${chain} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund ${money(capital)} and place one market position on ${name} on ${chain}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit ${money(capital)} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('stable') || c.includes('algo-stable')) return `Mint or deposit ${money(capital)} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa')) return `Mint ${money(capital)} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy ${money(capital)} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('launchpad')) return `Join ${name}'s sale or staking pool on ${chain} with ${money(capital)} and complete its entry steps.`;
  if (c.includes('payment') || c.includes('card')) return `Load ${money(capital)} and make one payment through ${name} on ${chain}.`;
  return `Deposit ${money(capital)} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The category's second qualifying action, different from the first. */
function action2For(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow a small amount against the deposit on ${name} — for example $20 of USDC — and repay it the same week.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Swap $25 of USDC for the pool's other token on ${name} on ${chain} and add it to the same position.`;
  if (c.includes('bridge')) return `Bridge $25 back the other way through ${name} so the wallet shows activity in both directions.`;
  if (c.includes('staking') || c.includes('restak')) return `Restake or delegate a further $25 through ${name} on ${chain} and confirm the new receipt.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options') || c.includes('synthetic')) return `Close the first trade on ${name}, then open a second small one so the wallet shows repeat use.`;
  if (c.includes('prediction')) return `Settle or close the first position on ${name}, then place a second $25 market position.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit a further $25 into the same ${name} vault on ${chain} and check the shares update.`;
  if (c.includes('stable') || c.includes('algo-stable')) return `Swap $25 of the stable asset for USDC on ${name} on ${chain} and swap it back.`;
  if (c.includes('rwa')) return `Check the accrued yield on the ${name} position on ${chain} and reinvest $25 of it.`;
  if (c.includes('insurance')) return `File a test quote for a second cover amount on ${name} so the wallet shows repeat use.`;
  if (c.includes('launchpad')) return `Vote or complete one community task on ${name} on ${chain} with the same wallet.`;
  return `Make a second $25 deposit or swap on ${name} on ${chain} so the wallet shows repeat use.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. Derived from the
 * protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 * Live rows get a position plan — how to use the protocol now — in the same format.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, status: TokenStatus): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const setupGas = capital >= 150 ? 8 : 4;
  if (status === 'not-a-launch') {
    const reason = exclusionReason(p) ?? 'not a launch candidate';
    return [
      {
        text: `Do not farm ${p.name} as a token launch: it is a ${reason}, so there is no launch of its own to wait for.`,
        cost: 'nothing — the step is to skip it',
        time: '2 minutes to read this',
      },
      {
        text: `If you still want exposure, use ${p.name} on ${chain} for what it is — for example a trade or a transfer — with money you can afford to lose.`,
        cost: `${money(capital)} of capital and about ${money(setupGas)} of gas`,
        time: '15 minutes to set up',
      },
      {
        text: `Check the protocol's own announcements page for any token program; only a program it publishes itself counts.`,
        cost: 'no fee to check',
        time: '10 minutes',
      },
      {
        text: `Hold any position for at least ${hold} days and keep a record of every transaction.`,
        cost: `the ${money(capital)} stays in the position`,
        time: `${hold} days`,
      },
      {
        text: `Never pay to claim anything from ${p.name}, and never follow a claim link from a message or post.`,
        cost: 'no fee to check, and never pay to claim',
        time: '5 minutes',
      },
      {
        text: `Write the wallet, the dates and every transaction in a farm log so you can unwind the position.`,
        cost: 'nothing but the log',
        time: '5 minutes',
      },
    ];
  }
  const action = actionFor(p, capital, chain);
  const action2 = action2For(p, capital, chain);
  const liveNote =
    status === 'live'
      ? ` Its token already trades, so there is no launch to farm — this is a position plan, not an airdrop plan.`
      : status === 'live-unpriced'
        ? ` Its token is recorded but has no market cap here, so farm only if the protocol itself announces a program.`
        : '';
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.${liveNote}`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `${money(capital)} of capital and about ${money(setupGas)} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `${action2} Do this once a week while the position is open.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the ${money(capital)} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes — never from a link in a message or post.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The protocols the board ranks: every protocol in the snapshot, strongest first, ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const fit = fitComps(snapshot.protocols);
  const table = oddsTable(snapshot.protocols, snapshot.as_of);
  const scored = snapshot.protocols.map((p) => {
    const status = tokenStatus(p);
    const age = ageDays(snapshot.as_of, p.listed_at);
    const fitted = fittedValue(p.tvl_usd, fit);
    const tilt = growthMultiplier(p.change_7d);
    const { cost } = farmCostUsd(p, age);
    if (status === 'pre-token') {
      const { odds } = tokenOdds(p, snapshot.as_of, table);
      const expected = Math.max(1, Math.round(fitted * odds * tilt));
      const share = Math.max(1, Math.round(FARMER_SHARE * expected));
      const verdict: BoardRow['verdict'] = share >= 3 * cost ? 'Farm' : share >= cost ? 'Thin' : 'Skip';
      return {
        p, status, age, fitted, tilt, odds, expected, implied: expected, verdict, cost, share,
      };
    }
    if (status === 'live') {
      return {
        p, status, age, fitted, tilt, odds: null, expected: null, implied: Math.max(1, Math.round(p.mcap_usd!)), verdict: 'live' as const, cost, share: null,
      };
    }
    if (status === 'not-a-launch') {
      // Reference only: never enters the pre-token ranking, verdict Skip.
      return {
        p, status, age, fitted, tilt, odds: null, expected: null, implied: Math.max(1, Math.round(fitted)), verdict: 'Skip' as const, cost, share: null,
      };
    }
    // live-unpriced: the fitted value, for reference only.
    return {
      p, status, age, fitted, tilt, odds: null, expected: null, implied: Math.max(1, Math.round(fitted)), verdict: 'live' as const, cost, share: null,
    };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.age,
    token_status: s.status,
    exclusion_reason: s.status === 'not-a-launch' ? exclusionReason(s.p) : null,
    fitted_value_usd: Math.max(1, Math.round(s.fitted)),
    token_odds: s.odds,
    growth_multiplier: s.tilt,
    expected_value_usd: s.expected,
    implied_value_usd: s.implied,
    verdict: s.verdict,
    farm_cost_usd: s.cost,
    farmer_share_usd: s.share,
    farm_steps: farmSteps(s.p, s.age, s.status).map(stepText),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const fit = fitComps(snapshot.protocols);
  const table = oddsTable(snapshot.protocols, snapshot.as_of);
  const preExpected = board
    .filter((r) => r.token_status === 'pre-token')
    .map((r) => r.expected_value_usd!)
    .sort((a, b) => a - b);
  const median = preExpected.length % 2 === 1
    ? preExpected[(preExpected.length - 1) / 2]!
    : Math.round((preExpected[preExpected.length / 2 - 1]! + preExpected[preExpected.length / 2]!) / 2);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    pre_token_size: board.filter((r) => r.token_status === 'pre-token').length,
    live_size: board.filter((r) => r.token_status === 'live').length,
    live_unpriced_size: board.filter((r) => r.token_status === 'live-unpriced').length,
    not_a_launch_size: board.filter((r) => r.token_status === 'not-a-launch').length,
    comps: fit,
    odds_global: table.global,
    odds_cells: table.cells,
    odds_tvl_pooled: table.tvlPooled,
    median_expected_pre: median,
    rows: board.map((r) => {
      const p = bySlug.get(r.slug)!;
      return { ...r, mcap_usd: p.mcap_usd, listed_at: p.listed_at };
    }),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (typeof r.name !== 'string' || r.name.trim().length === 0) return `${r.slug} has no name`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
