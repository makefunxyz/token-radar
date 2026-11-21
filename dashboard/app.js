// Token Launch Radar dashboard. Reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, filters, sorting, pagination and a per-protocol detail view.
// No network: every byte shown is in data.js. The model is recomputed here, in the page, from the
// same rows the board was built from, and the methodology section says whether it matches.
(function () {
  'use strict';
  var D = window.RADAR;
  var rows = D.rows;
  var DAY = 86400000;

  // ---- model, recomputed in the page from the raw rows -------------------------------
  function ageDays(listedAt) {
    if (!listedAt) return null;
    var a = Date.parse(D.as_of + 'T00:00:00Z'), b = Date.parse(listedAt + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.max(0, Math.floor((a - b) / DAY));
  }
  // Token presence is judged from the board row's status, which the builder derived from the
  // snapshot's gecko_id / symbol fields; the odds below count rows by that same status.
  function hasToken(r) { return r.token_status !== 'pre-token'; }
  function fitComps(rs) {
    var comps = rs.filter(function (r) { return r.mcap_usd !== null && r.mcap_usd > 0 && r.tvl_usd > 0; });
    var n = comps.length, xs = [], ys = [], i, mx = 0, my = 0;
    for (i = 0; i < n; i++) { xs.push(Math.log(comps[i].tvl_usd)); ys.push(Math.log(comps[i].mcap_usd)); mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0;
    for (i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    var b = sxy / sxx, a = my - b * mx, ssRes = 0, ssTot = 0;
    for (i = 0; i < n; i++) { var p = a + b * xs[i]; ssRes += (ys[i] - p) * (ys[i] - p); ssTot += (ys[i] - my) * (ys[i] - my); }
    var loo = 0;
    for (i = 0; i < n; i++) {
      var sx = 0, sy = 0, j;
      for (j = 0; j < n; j++) { if (j !== i) { sx += xs[j]; sy += ys[j]; } }
      var mx2 = sx / (n - 1), my2 = sy / (n - 1), sxy2 = 0, sxx2 = 0;
      for (j = 0; j < n; j++) { if (j !== i) { sxy2 += (xs[j] - mx2) * (ys[j] - my2); sxx2 += (xs[j] - mx2) * (xs[j] - mx2); } }
      var b2 = sxy2 / sxx2, a2 = my2 - b2 * mx2;
      loo += Math.abs(ys[i] - (a2 + b2 * xs[i]));
    }
    return { n: n, a: a, b: b, r2: 1 - ssRes / ssTot, looMae: loo / n };
  }
  var AGE_BANDS = [[0, 365], [365, 730], [730, 1095], [1095, Infinity]];
  var TVL_BANDS = [[5000000, 100000000], [100000000, 1000000000], [1000000000, Infinity]];
  function oddsTable(rs) {
    var global = rs.filter(hasToken).length / rs.length, cells = [], ai, ti, n, k, r;
    for (ai = 0; ai < AGE_BANDS.length; ai++) {
      for (ti = 0; ti < TVL_BANDS.length; ti++) {
        n = 0; k = 0;
        rs.forEach(function (row) {
          var age = ageDays(row.listed_at);
          if (age === null) return;
          if (age >= AGE_BANDS[ai][0] && age < AGE_BANDS[ai][1] && row.tvl_usd >= TVL_BANDS[ti][0] && row.tvl_usd < TVL_BANDS[ti][1]) {
            n++; if (hasToken(row)) k++;
          }
        });
        cells.push({ ageLo: AGE_BANDS[ai][0], ageHi: AGE_BANDS[ai][1], tvlLo: TVL_BANDS[ti][0], tvlHi: TVL_BANDS[ti][1], n: n, k: k, rate: Math.min(0.95, Math.max(0.05, (k + 2 * global) / (n + 2))) });
      }
    }
    return { global: global, cells: cells };
  }
  function oddsCellLabel(cell) {
    var a = cell.ageHi === Infinity ? cell.ageLo + 'd+' : cell.ageLo + '–' + cell.ageHi + 'd';
    var t = cell.tvlHi === Infinity ? '$' + Math.round(cell.tvlLo / 1e9) + 'B+' : '$' + Math.round(cell.tvlLo / 1e6) + 'M–$' + Math.round(cell.tvlHi / 1e6) + 'M';
    return a + ' × ' + t;
  }
  function oddsFor(r, table) {
    var age = r.age_days;
    if (age === null) {
      var pooled = table.cells.filter(function (c) { return r.tvl_usd >= c.tvlLo && r.tvl_usd < c.tvlHi; });
      var n = 0, k = 0;
      pooled.forEach(function (c) { n += c.n; k += c.k; });
      return { odds: Math.min(0.95, Math.max(0.05, (k + 2 * table.global) / (n + 2))), cell: 'age unknown — TVL band only' };
    }
    var cell = null;
    table.cells.forEach(function (c) { if (age >= c.ageLo && age < c.ageHi && r.tvl_usd >= c.tvlLo && r.tvl_usd < c.tvlHi) cell = c; });
    if (!cell) return { odds: table.global, cell: 'no cell' };
    return { odds: cell.rate, cell: oddsCellLabel(cell) + ' (n=' + cell.n + ', ' + cell.k + ' with token)' };
  }

  // ---- formatting --------------------------------------------------------------------
  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) { return n === null || n === undefined ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function pct(n, d) { return n === null || n === undefined ? '—' : (n * 100).toFixed(d === undefined ? 0 : d) + '%'; }
  function chg(n) {
    if (n === null || n === undefined) return '<span class="num">—</span>';
    var c = n >= 0 ? 'pos' : 'neg';
    return '<span class="' + c + '">' + (n >= 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  }

  // ---- state --------------------------------------------------------------------------
  var preRank = {};
  rows.filter(function (r) { return r.token_status === 'pre-token'; }).forEach(function (r, i) { preRank[r.slug] = i + 1; });
  var state = { q: '', chain: '', cat: '', status: 'pre-token', verdict: '', sort: 'rank', dir: 1, page: 0 };
  var PER_PAGE = 25;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  var $ = function (id) { return document.getElementById(id); };
  var chainSel = $('chain'), catSel = $('cat');
  var chains = [], cats = [];
  rows.forEach(function (r) {
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
  });
  chains.sort(); cats.sort();
  chains.forEach(function (c) { var o = document.createElement('option'); o.textContent = c; chainSel.appendChild(o); });
  cats.forEach(function (c) { var o = document.createElement('option'); o.textContent = c; catSel.appendChild(o); });

  // ---- header, KPIs, methodology -------------------------------------------------------
  var fit = fitComps(rows);
  var odds = oddsTable(rows);
  var fitMatch = Math.abs(fit.a - D.comps.a) < 0.0005 && Math.abs(fit.b - D.comps.b) < 0.0005;
  var oddsMatch = odds.cells.every(function (c, i) { return Math.abs(c.rate - D.odds_cells[i].rate) < 0.0005; });
  $('top-meta').innerHTML =
    '<div>Snapshot as of <b>' + esc(D.as_of) + '</b></div>' +
    '<div>Source: <b>DefiLlama protocols snapshot</b></div>' +
    '<div>Coverage: <b>' + D.board_size + ' / ' + D.board_size + ' protocols</b> · Watchlist <b>' + D.watchlist_size + '</b></div>' +
    '<div>Model: <b>' + esc(D.model_version) + '</b></div>';
  var kpis = [
    [D.board_size, 'protocols ranked'], [D.watchlist_size, 'watchlist covered'],
    [D.pre_token_size, 'pre-token'], [D.live_size, 'live (market cap)'],
    [D.comps.r2.toFixed(2), 'comps fit R²'], [D.comps.loo_mae.toFixed(2), 'LOO MAE (log pts)'],
    [money(D.median_expected_pre), 'median expected value, pre-token']
  ];
  $('kpis').innerHTML = kpis.map(function (k) { return '<div class="kpi"><b>' + k[0] + '</b><span>' + k[1] + '</span></div>'; }).join('');
  $('modelcheck').textContent = fitMatch && oddsMatch
    ? 'Model check: recomputed in this page from the ' + rows.length + ' rows below, the fit matches the board — a = ' + fit.a.toFixed(3) + ', b = ' + fit.b.toFixed(3) + ', R² = ' + fit.r2.toFixed(3) + ', LOO MAE = ' + fit.looMae.toFixed(3) + ' log points; the odds table matches on all 12 cells.'
    : 'Model check: recomputed fit differs from the board — do not trust the values above until this is fixed.';
  $('fittext').textContent = 'log(market cap) = ' + D.comps.a + ' + ' + D.comps.b + ' × log(TVL), fitted by least squares on the ' + D.comps.n + ' protocols whose tokens trade (R² = ' + D.comps.r2 + ', residual SD = ' + D.comps.resid_sd + ', leave-one-out MAE = ' + D.comps.loo_mae + ' log points). Fitted launch value = exp(a + b × ln(TVL)). Pre-token expected value = fitted value × token odds × growth tilt.';
  var oddsHtml = '<tr><th></th><th>$5M–$100M</th><th>$100M–$1B</th><th>$1B+</th></tr>';
  ['0–1y', '1–2y', '2–3y', '3y+'].forEach(function (label, ai) {
    oddsHtml += '<tr><th>' + label + '</th>';
    for (var ti = 0; ti < 3; ti++) {
      var c = D.odds_cells[ai * 3 + ti];
      oddsHtml += '<td title="n=' + c.n + ', ' + c.k + ' record a token">' + pct(c.rate) + '</td>';
    }
    oddsHtml += '</tr>';
  });
  $('oddstable').innerHTML = oddsHtml;
  $('tilttext').textContent = 'Growth tilt = 1 + clamp(7-day TVL change, −60%, +120%) × 0.001, so growth moves value at most ±12%. The comps fit finds no reliable growth premium (its fitted coefficient is ≈ −0.04), so growth is a mild prior, not a driver.';
  $('farmtext').textContent = 'Farm verdict: a farmer is assumed to take 0.1% of the expected value — a planning assumption, not a promise. Farm cost = setup gas ($4, or $8 for $150+ positions) + $2/week over the hold + 5% APR lockup on the capital. Share ≥ 3× cost → Farm; share ≥ cost → Thin; otherwise Skip. Live rows get a position plan instead: their token already trades.';
  $('integrity').textContent = 'Data: DefiLlama protocols snapshot, as of ' + D.as_of + ', floor $50M, ' + D.board_size + ' protocols, watchlist ' + D.watchlist_size + ' — every watchlist slug is on this board. Honesty note: the snapshot records whether a protocol lists a token; a protocol that records no token may still have one its record does not carry, so this page says a protocol records no token, never that it has none. Implied values are this entry’s own model claim, not a price and not a prediction of if or when a token launches.';

  // ---- board ---------------------------------------------------------------------------
  var SORTS = {
    prerank: function (r) { return preRank[r.slug] || 9999; },
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    category: function (r) { return (r.category || '').toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    chg: function (r) { return r.change_7d === null ? -1e9 : r.change_7d; },
    fitted: function (r) { return r.fitted_value_usd; },
    odds: function (r) { return r.token_odds === null ? -1 : r.token_odds; },
    expected: function (r) { return r.implied_value_usd; },
    verdict: function (r) { return r.verdict; }
  };
  function filtered() {
    var q = state.q.toLowerCase();
    var list = rows.filter(function (r) {
      if (state.status && r.token_status !== state.status) return false;
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    var key = SORTS[state.sort];
    list.sort(function (a, b) {
      var va = key(a), vb = key(b);
      if (va < vb) return -1 * state.dir;
      if (va > vb) return 1 * state.dir;
      return a.slug < b.slug ? -1 : 1;
    });
    return list;
  }
  function render() {
    var list = filtered();
    var pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
    if (state.page >= pages) state.page = pages - 1;
    var slice = list.slice(state.page * PER_PAGE, state.page * PER_PAGE + PER_PAGE);
    $('rows').innerHTML = slice.map(function (r) {
      var pr = preRank[r.slug];
      return '<tr data-slug="' + esc(r.slug) + '"' + (detailSlug === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="num">' + (pr ? pr : '—') + '</td>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + '<small>' + esc(r.slug) + '</small></td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ')) + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg(r.change_7d) + '</td>' +
        '<td class="num">' + money(r.fitted_value_usd) + '</td>' +
        '<td class="num">' + (r.token_odds === null ? '—' : pct(r.token_odds)) + '</td>' +
        '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
        '<td><span class="pill ' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    }).join('') || '<tr><td colspan="11">No protocols match these filters.</td></tr>';
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols';
    $('pageinfo').textContent = 'Page ' + (state.page + 1) + ' of ' + pages;
    $('prev').disabled = state.page === 0;
    $('next').disabled = state.page >= pages - 1;
    document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
      var base = th.getAttribute('data-label') || th.textContent.replace(/ [▲▼]$/, '');
      th.setAttribute('data-label', base);
      th.textContent = base + (th.getAttribute('data-sort') === state.sort ? (state.dir === 1 ? ' ▲' : ' ▼') : '');
    });
  }

  // ---- detail --------------------------------------------------------------------------
  var detailSlug = null;
  function renderDetail(slug, scroll) {
    var r = bySlug[slug];
    var el = $('detail');
    if (!r) { el.hidden = true; detailSlug = null; return; }
    detailSlug = slug;
    var o = r.token_status === 'pre-token' ? oddsFor(r, odds) : null;
    var valueRows;
    if (r.token_status === 'pre-token') {
      valueRows =
        '<dt>Fitted launch value</dt><dd>' + moneyFull(r.fitted_value_usd) + '</dd>' +
        '<dt>Token odds</dt><dd>' + pct(r.token_odds) + ' — ' + esc(o.cell) + '</dd>' +
        '<dt>Growth tilt (7d ' + (r.change_7d === null ? 'n/a' : r.change_7d.toFixed(1) + '%') + ')</dt><dd>× ' + r.growth_multiplier.toFixed(3) + '</dd>' +
        '<dt>Expected value</dt><dd><b>' + moneyFull(r.expected_value_usd) + '</b></dd>';
    } else if (r.token_status === 'live') {
      valueRows =
        '<dt>Market cap (live)</dt><dd><b>' + moneyFull(r.implied_value_usd) + '</b></dd>' +
        '<dt>Fitted value (reference)</dt><dd>' + moneyFull(r.fitted_value_usd) + '</dd>' +
        '<dt>Token odds</dt><dd>— token already trades</dd>';
    } else {
      valueRows =
        '<dt>Fitted value (reference only)</dt><dd><b>' + moneyFull(r.fitted_value_usd) + '</b></dd>' +
        '<dt>Market cap</dt><dd>none recorded</dd>' +
        '<dt>Token odds</dt><dd>— token recorded, unpriced</dd>';
    }
    var verdictLine = r.token_status === 'pre-token'
      ? 'Verdict <b>' + r.verdict + '</b> — assumed farmer share ' + moneyFull(r.farmer_share_usd) + ' (0.1% of expected value) vs farm cost ' + moneyFull(r.farm_cost_usd) + '.'
      : 'Verdict <b>live</b> — the token already trades (or is recorded), so there is no launch to farm; the steps below are a position plan.';
    el.innerHTML =
      '<h2>' + esc(r.name) + ' <span class="pill ' + r.verdict + '">' + r.verdict + '</span></h2>' +
      '<p class="sub">Overall rank #' + r.rank + (preRank[r.slug] ? ' · pre-token rank #' + preRank[r.slug] : '') + ' · ' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.join(', ')) + ' · ' + esc(r.token_status) + '</p>' +
      '<div class="detail-grid"><div><h3>Model breakdown</h3><dl class="kv">' +
      '<dt>TVL</dt><dd>' + moneyFull(r.tvl_usd) + '</dd>' +
      '<dt>7-day change</dt><dd>' + (r.change_7d === null ? '—' : r.change_7d.toFixed(2) + '%') + '</dd>' +
      '<dt>Age (listed ' + (r.listed_at || 'unknown') + ')</dt><dd>' + (r.age_days === null ? 'unknown' : r.age_days + ' days') + '</dd>' +
      valueRows +
      '<dt>Implied value</dt><dd><b>' + moneyFull(r.implied_value_usd) + '</b></dd></dl>' +
      '<p class="sub">' + verdictLine + '</p></div>' +
      '<div><h3>' + (r.token_status === 'pre-token' ? 'Farm plan — 6 steps' : 'Position plan — 6 steps') + '</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div></div>';
    el.hidden = false;
    if (scroll) el.scrollIntoView({ block: 'start' });
    render();
  }

  // ---- events --------------------------------------------------------------------------
  document.querySelectorAll('#board th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = k === 'name' || k === 'category' || k === 'verdict' ? 1 : -1; if (k === 'rank' || k === 'prerank') state.dir = 1; }
      state.page = 0; render();
    });
  });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) { renderDetail(tr.getAttribute('data-slug'), true); }
  });
  $('q').addEventListener('input', function () { state.q = this.value; state.page = 0; render(); });
  chainSel.addEventListener('change', function () { state.chain = this.value; state.page = 0; render(); });
  catSel.addEventListener('change', function () { state.cat = this.value; state.page = 0; render(); });
  $('status').addEventListener('change', function () { state.status = this.value; state.page = 0; render(); });
  $('verdict').addEventListener('change', function () { state.verdict = this.value; state.page = 0; render(); });
  $('prev').addEventListener('click', function () { if (state.page > 0) { state.page--; render(); } });
  $('next').addEventListener('click', function () { state.page++; render(); });
  window.addEventListener('hashchange', applyHash);

  function applyHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('status') !== null) { state.status = p.get('status') || ''; $('status').value = state.status; }
    if (p.get('chain')) { state.chain = p.get('chain'); chainSel.value = state.chain; }
    if (p.get('category')) { state.cat = p.get('category'); catSel.value = state.cat; }
    if (p.get('q')) { state.q = p.get('q'); $('q').value = state.q; }
    state.page = 0; render();
    if (p.get('detail') && bySlug[p.get('detail')]) renderDetail(p.get('detail'), false);
  }

  applyHash();
  render();
})();
