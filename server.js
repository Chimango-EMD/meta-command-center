const express = require('express');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ──────────────────────────────────────────
// PATHS
// ──────────────────────────────────────────
const CAMPAIGNS_FILE = path.join(__dirname, 'data', 'campaigns.json');
const CONFIG_FILE    = path.join(__dirname, 'data', 'meta-config.json');

// ──────────────────────────────────────────
// HELPERS — CONFIG
// ──────────────────────────────────────────
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}
function writeConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}
function getToken() {
  return process.env.META_ACCESS_TOKEN || readConfig().access_token || null;
}
function getAdAccountId() {
  return process.env.META_AD_ACCOUNT_ID || 'act_203214402870133';
}

// ──────────────────────────────────────────
// HELPERS — DATE
// ──────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function buildTimeRange(since, until) {
  const s = since || todayStr();
  const u = until || todayStr();
  return encodeURIComponent(JSON.stringify({ since: s, until: u }));
}

// ──────────────────────────────────────────
// HELPERS — META API
// ──────────────────────────────────────────
async function metaGet(url) {
  const res  = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err  = new Error(data.error.message || 'Meta API error');
    err.code   = data.error.code;
    err.type   = data.error.type;
    throw err;
  }
  return data;
}

// ──────────────────────────────────────────
// HELPERS — INSIGHTS EXTRACTION
// ──────────────────────────────────────────
function sumActions(actions, ...types) {
  return (actions || [])
    .filter(a => types.includes(a.action_type))
    .reduce((s, a) => s + parseFloat(a.value || 0), 0);
}

function findCost(costPerAction, ...types) {
  const found = (costPerAction || []).find(a => types.includes(a.action_type));
  return parseFloat(found?.value || 0);
}

function extractInsights(insights) {
  const zero = {
    investimento: 0, impressoes: 0, cliques: 0, cliques_unicos: 0,
    ctr: 0, ctr_unico: 0, cpc: 0, cpc_unico: 0, cpp: 0,
    alcance: 0, frequencia: 0,
    pedidos: 0, compras: 0, custo_por_resultado: 0,
    // funnel
    landing_page_views: 0, checkout_iniciado: 0,
    // video
    video_plays: 0, video_p25: 0, video_p50: 0, video_p75: 0, video_p100: 0,
  };
  if (!insights?.data?.length) return zero;

  const d             = insights.data[0];
  const actions       = d.actions              || [];
  const costPerAction = d.cost_per_action_type || [];

  const purchases    = sumActions(actions, 'purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase');
  const addToCart    = sumActions(actions, 'add_to_cart', 'omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart');
  const lpViews      = sumActions(actions, 'landing_page_view', 'omni_landing_page_view');
  const checkouts    = sumActions(actions, 'initiate_checkout', 'omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout');
  const cpr          = findCost(costPerAction, 'purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase');

  // video
  const videoPlays = (d.video_play_actions   || [])[0]?.value || 0;
  const videoP25   = (d.video_p25_watched_actions  || [])[0]?.value || 0;
  const videoP50   = (d.video_p50_watched_actions  || [])[0]?.value || 0;
  const videoP75   = (d.video_p75_watched_actions  || [])[0]?.value || 0;
  const videoP100  = (d.video_p100_watched_actions || [])[0]?.value || 0;

  const impressoes = parseInt(d.impressions) || 0;
  const alcance    = parseInt(d.reach) || 0;
  const freq       = alcance > 0 ? impressoes / alcance : 0;

  return {
    investimento:        parseFloat(d.spend) || 0,
    impressoes,
    cliques:             parseInt(d.clicks) || 0,
    cliques_unicos:      parseInt(d.unique_clicks) || 0,
    ctr:                 parseFloat(d.ctr) || 0,
    ctr_unico:           parseFloat(d.unique_ctr) || 0,
    cpc:                 parseFloat(d.cpc) || 0,
    cpc_unico:           parseFloat(d.cost_per_unique_click) || 0,
    cpp:                 parseFloat(d.cpp) || 0,
    alcance,
    frequencia:          parseFloat(freq.toFixed(2)),
    pedidos:             addToCart,
    compras:             purchases,
    custo_por_resultado: cpr,
    landing_page_views:  lpViews,
    checkout_iniciado:   checkouts,
    video_plays:         parseFloat(videoPlays),
    video_p25:           parseFloat(videoP25),
    video_p50:           parseFloat(videoP50),
    video_p75:           parseFloat(videoP75),
    video_p100:          parseFloat(videoP100),
  };
}

// ──────────────────────────────────────────
// PERFORMANCE SCORE
// ──────────────────────────────────────────
function calcPerformanceScore(metrics) {
  let score = 0;

  // CTR (30pts) — benchmarks Europa
  if      (metrics.ctr >= 3)   score += 30;
  else if (metrics.ctr >= 2)   score += 24;
  else if (metrics.ctr >= 1.5) score += 18;
  else if (metrics.ctr >= 1)   score += 10;

  // CPC (25pts)
  if      (metrics.cpc <= 0.40) score += 25;
  else if (metrics.cpc <= 0.70) score += 20;
  else if (metrics.cpc <= 1.00) score += 14;
  else if (metrics.cpc <= 1.50) score += 7;

  // CPR (30pts)
  if (metrics.custo_por_resultado > 0) {
    if      (metrics.custo_por_resultado <= 10) score += 30;
    else if (metrics.custo_por_resultado <= 20) score += 24;
    else if (metrics.custo_por_resultado <= 30) score += 15;
    else if (metrics.custo_por_resultado <= 45) score += 7;
  }

  // Frequência (15pts)
  if      (metrics.frequencia <= 2.0) score += 15;
  else if (metrics.frequencia <= 3.0) score += 8;

  return score;
}

function getScoreLabel(score) {
  if (score >= 85) return { label: 'EXCELENTE', color: '#1D9E75', bg: 'rgba(29,158,117,0.12)' };
  if (score >= 70) return { label: 'ÓTIMO',     color: '#5DCAA5', bg: 'rgba(93,202,165,0.12)' };
  if (score >= 55) return { label: 'BOM',        color: '#EF9F27', bg: 'rgba(239,159,39,0.12)' };
  if (score >= 35) return { label: 'REGULAR',    color: '#E87B3A', bg: 'rgba(232,123,58,0.12)' };
  if (score >= 15) return { label: 'RUIM',       color: '#E24B4A', bg: 'rgba(226,75,74,0.12)' };
  return              { label: 'CRÍTICO',    color: '#ff2222', bg: 'rgba(255,34,34,0.12)' };
}

// ──────────────────────────────────────────
// SERVE CAMPAIGN DATA
// ──────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
    if (!data.last_sync) {
      const cfg = readConfig();
      data.last_sync      = cfg.last_sync      || null;
      data.last_since     = cfg.last_since     || null;
      data.last_until     = cfg.last_until     || null;
      data.last_purchases = cfg.last_purchases ?? null;
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load campaign data' });
  }
});

// ──────────────────────────────────────────
// META: SAVE TOKEN
// ──────────────────────────────────────────
app.post('/api/meta/save-token', (req, res) => {
  const { access_token } = req.body;
  if (!access_token || !access_token.startsWith('EAA')) {
    return res.status(400).json({ error: 'Token inválido. Deve começar com "EAA".' });
  }
  const cfg = readConfig();
  cfg.access_token   = access_token;
  cfg.token_saved_at = new Date().toISOString();
  writeConfig(cfg);
  res.json({ success: true });
});

// ──────────────────────────────────────────
// META: TOKEN INFO
// ──────────────────────────────────────────
app.get('/api/meta/token-info', (req, res) => {
  const appId     = process.env.META_APP_ID || '<META_APP_ID>';
  const appSecret = process.env.META_APP_SECRET ? '****' : '<META_APP_SECRET>';
  res.json({
    long_lived_token_url: `https://graph.facebook.com/v1.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=SHORT_LIVED_TOKEN`,
    instructions: [
      '1. Acesse developers.facebook.com → seu App → Tools → Graph API Explorer',
      '2. Selecione seu App e gere um User Token com permissões: ads_read, ads_management',
      '3. Clique em "i" ao lado do token → Open in Access Token Tool → Extend Token',
      '4. Cole o token de longa duração (60 dias) no campo abaixo',
    ],
    has_token:   !!getToken(),
    account_id:  getAdAccountId(),
  });
});

// ──────────────────────────────────────────
// META: STATUS
// ──────────────────────────────────────────
app.get('/api/meta/status', (req, res) => {
  const cfg = readConfig();
  res.json({
    connected:  !!getToken(),
    last_sync:  cfg.last_sync  || null,
    last_since: cfg.last_since || null,
    last_until: cfg.last_until || null,
    account_id: getAdAccountId(),
  });
});

// ──────────────────────────────────────────
// META: DEBUG
// ──────────────────────────────────────────
app.get('/api/meta/debug', async (req, res) => {
  const token = getToken();
  if (!token) return res.status(401).json({ error: 'no_token', message: 'Nenhum token configurado.' });

  const BASE   = 'https://graph.facebook.com/v19.0';
  const acctId = getAdAccountId();
  const since  = req.query.since || todayStr();
  const until  = req.query.until || todayStr();
  const tr     = buildTimeRange(since, until);

  const result = {
    account_id: acctId, timestamp: new Date().toISOString(), since, until,
    campaigns_raw: null, first_campaign: null, insights_raw: null,
    actions_raw: null, cost_per_action_raw: null, campaigns_json: null, errors: [],
  };

  try {
    result.campaigns_raw = await metaGet(`${BASE}/${acctId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget&limit=20&access_token=${token}`);
  } catch (err) { result.errors.push({ step: 'campaigns', message: err.message }); }

  const firstCamp = result.campaigns_raw?.data?.[0];
  if (firstCamp) {
    result.first_campaign = { id: firstCamp.id, name: firstCamp.name, status: firstCamp.status };
    try {
      result.insights_raw = await metaGet(`${BASE}/${firstCamp.id}/insights?fields=spend,impressions,clicks,ctr,cpc,reach,actions,cost_per_action_type&time_range=${tr}&access_token=${token}`);
      const d = result.insights_raw?.data?.[0];
      result.actions_raw         = d?.actions               || [];
      result.cost_per_action_raw = d?.cost_per_action_type  || [];
      if (!d) result.errors.push({ step: 'insights', message: 'Sem dados no período.' });
    } catch (err) { result.errors.push({ step: 'insights', message: err.message }); }
  }

  try { result.campaigns_json = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8')); }
  catch (err) { result.errors.push({ step: 'campaigns_json', message: err.message }); }

  res.json(result);
});

// ──────────────────────────────────────────
// META: SYNC
// ──────────────────────────────────────────
const AD_INSIGHT_FIELDS = [
  'spend', 'impressions', 'clicks', 'unique_clicks', 'ctr', 'unique_ctr',
  'cpc', 'cost_per_unique_click', 'cpp', 'reach', 'frequency',
  'actions', 'cost_per_action_type', 'action_values',
  'video_play_actions',
  'video_p25_watched_actions', 'video_p50_watched_actions',
  'video_p75_watched_actions', 'video_p100_watched_actions',
].join(',');

app.get('/api/meta/sync', async (req, res) => {
  const token = getToken();
  if (!token) return res.status(401).json({ error: 'no_token', message: 'Nenhum token configurado. Conecte a Meta API primeiro.' });

  const since  = req.query.since || todayStr();
  const until  = req.query.until || todayStr();
  const tr     = buildTimeRange(since, until);
  const acctId = getAdAccountId();
  const BASE   = 'https://graph.facebook.com/v19.0';

  console.log(`[Meta Sync] Iniciando — ${since} → ${until}`);

  try {
    // ── 1. Campaigns ──
    const campsData = await metaGet(
      `${BASE}/${acctId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget&limit=50&access_token=${token}`
    );

    const campaigns = [];

    for (const camp of campsData.data || []) {
      const budget_total = parseFloat(camp.lifetime_budget || camp.daily_budget || 0) / 100;

      // ── 2. Adsets ──
      const adsetsData = await metaGet(
        `${BASE}/${camp.id}/adsets?fields=id,name,status,daily_budget,targeting&limit=50&access_token=${token}`
      );

      const adsets = [];

      for (const adset of adsetsData.data || []) {
        let adsetInsights = extractInsights(null);
        try {
          const ai = await metaGet(`${BASE}/${adset.id}/insights?fields=${AD_INSIGHT_FIELDS}&time_range=${tr}&access_token=${token}`);
          adsetInsights = extractInsights(ai);
        } catch { /* no data */ }

        // ── 3. Ads ──
        const adsData = await metaGet(
          `${BASE}/${adset.id}/ads?fields=id,name,status,creative&limit=50&access_token=${token}`
        );

        const ads = [];

        for (const ad of adsData.data || []) {
          let adInsights = extractInsights(null);
          try {
            const adI = await metaGet(`${BASE}/${ad.id}/insights?fields=${AD_INSIGHT_FIELDS}&time_range=${tr}&access_token=${token}`);
            adInsights = extractInsights(adI);
          } catch { /* no data */ }

          const score      = calcPerformanceScore(adInsights);
          const scoreLabel = getScoreLabel(score);

          ads.push({
            id:     ad.id,
            name:   ad.name,
            format: detectFormat(ad.creative),
            status: normalizeStatus(ad.status),
            thumbnail: null,
            score,
            score_label: scoreLabel.label,
            score_color: scoreLabel.color,
            score_bg:    scoreLabel.bg,
            metrics:     adInsights,
          });
        }

        // Aggregate adset metrics from ads if adset insights empty
        let finalAdsetMetrics = adsetInsights;
        if (adsetInsights.investimento === 0 && ads.length > 0) {
          finalAdsetMetrics = aggregateMetrics(ads.map(a => a.metrics));
        }

        adsets.push({
          id:          adset.id,
          name:        adset.name,
          status:      normalizeStatus(adset.status),
          targeting:   buildTargetingString(adset.targeting),
          budget_daily: parseFloat(adset.daily_budget || 0) / 100,
          metrics:     finalAdsetMetrics,
          ads,
        });
      }

      const countries = extractCountries(adsetsData.data || []);

      campaigns.push({
        id:           camp.id,
        name:         camp.name,
        status:       normalizeStatus(camp.status),
        objective:    camp.objective || 'CONVERSIONS',
        budget_total,
        countries:    countries.length ? countries : ['EU'],
        adsets,
      });
    }

    // ── Totals ──
    let totalPurchases = 0, totalSpend = 0;
    let funnelTotals   = { alcance: 0, impressoes: 0, cliques: 0, landing_page_views: 0, checkout_iniciado: 0, compras: 0 };
    campaigns.forEach(c => c.adsets.forEach(as => as.ads.forEach(a => {
      totalPurchases          += a.metrics.compras       || 0;
      totalSpend              += a.metrics.investimento  || 0;
      funnelTotals.alcance    += a.metrics.alcance       || 0;
      funnelTotals.impressoes += a.metrics.impressoes    || 0;
      funnelTotals.cliques    += a.metrics.cliques       || 0;
      funnelTotals.landing_page_views  += a.metrics.landing_page_views  || 0;
      funnelTotals.checkout_iniciado   += a.metrics.checkout_iniciado   || 0;
      funnelTotals.compras             += a.metrics.compras             || 0;
    })));

    // ── Save ──
    const syncedAt = new Date().toISOString();
    const payload  = { campaigns, last_sync: syncedAt, since, until, funnel: funnelTotals };

    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'w' });
    const verify = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
    if (verify.campaigns.length !== campaigns.length) {
      throw new Error(`Verificação falhou: escrito ${campaigns.length}, lido ${verify.campaigns.length}`);
    }

    const cfg = readConfig();
    Object.assign(cfg, { last_sync: syncedAt, last_since: since, last_until: until, last_camp_count: campaigns.length, last_purchases: totalPurchases });
    writeConfig(cfg);

    console.log(`[Meta Sync] ✓ ${campaigns.length} camps — spend R$${totalSpend.toFixed(2)} — purchases: ${totalPurchases}`);
    res.json({ success: true, updated_at: syncedAt, since, until, campaigns_count: campaigns.length, total_purchases: totalPurchases, total_spend: totalSpend, has_purchases: totalPurchases > 0 });

  } catch (err) {
    console.error('[Meta Sync] Error:', err.message);
    if (err.code === 190 || err.message?.toLowerCase().includes('token')) {
      return res.status(401).json({ error: 'token_expired', message: 'Token expirado ou inválido. Reconecte a Meta API.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// HELPERS — NORMALIZATION
// ──────────────────────────────────────────
function normalizeStatus(status) {
  const map = { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', ARCHIVED: 'PAUSED', DELETED: 'PAUSED' };
  return map[status] || status || 'ACTIVE';
}

function detectFormat(creative) {
  if (!creative) return 'IMAGE';
  if (creative.effective_object_story_spec?.video_data) return 'VIDEO';
  if (creative.object_type === 'VIDEO')  return 'VIDEO';
  if (creative.object_type === 'SHARE')  return 'CAROUSEL';
  return 'IMAGE';
}

function buildTargetingString(targeting) {
  if (!targeting) return 'Broad';
  const parts = [];
  if (targeting.age_min || targeting.age_max) parts.push(`${targeting.age_min || '18'}-${targeting.age_max || '65'} anos`);
  if (targeting.geo_locations?.countries?.length) parts.push(targeting.geo_locations.countries.join(', '));
  if (targeting.lookalike_specs?.length) parts.push(`LAL ${(targeting.lookalike_specs[0].ratio * 100).toFixed(0)}%`);
  if (targeting.custom_audiences?.length) parts.push('Audiência customizada');
  return parts.length ? parts.join(' — ') : 'Broad';
}

function extractCountries(adsets) {
  const set = new Set();
  adsets.forEach(as => (as.targeting?.geo_locations?.countries || []).forEach(c => set.add(c)));
  return [...set];
}

function aggregateMetrics(metricsArr) {
  const sum = (key) => metricsArr.reduce((s, m) => s + (m[key] || 0), 0);
  const inv = sum('investimento');
  const clk = sum('cliques');
  const imp = sum('impressoes');
  const alc = sum('alcance');
  return {
    investimento:        inv,
    impressoes:          imp,
    cliques:             clk,
    cliques_unicos:      sum('cliques_unicos'),
    ctr:                 imp > 0 ? (clk / imp * 100) : 0,
    ctr_unico:           0,
    cpc:                 clk > 0 ? (inv / clk) : 0,
    cpc_unico:           0,
    cpp:                 0,
    alcance:             alc,
    frequencia:          alc > 0 ? parseFloat((imp / alc).toFixed(2)) : 0,
    pedidos:             sum('pedidos'),
    compras:             sum('compras'),
    custo_por_resultado: sum('compras') > 0 ? (inv / sum('compras')) : 0,
    landing_page_views:  sum('landing_page_views'),
    checkout_iniciado:   sum('checkout_iniciado'),
    video_plays:         sum('video_plays'),
    video_p25:           sum('video_p25'),
    video_p50:           sum('video_p50'),
    video_p75:           sum('video_p75'),
    video_p100:          sum('video_p100'),
  };
}

// ──────────────────────────────────────────
// GEMINI PROXY
// ──────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { prompt, campaignData } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'GEMINI_API_KEY not set.' });

  const system = 'Você é estrategista de elite de Meta Ads para o mercado europeu. Analise os dados fornecidos e responda de forma direta, técnica e acionável. Use formatação markdown com bullets e negrito. Português brasileiro.';
  const fullPrompt = `${system}\n\nDados:\n${JSON.stringify(campaignData, null, 2)}\n\n${prompt}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }] }) }
    );
    if (!response.ok) {
      const e = await response.json();
      return res.status(response.status).json({ error: e.error?.message || 'Gemini error' });
    }
    const data = await response.json();
    res.json({ text: data.candidates?.[0]?.content?.parts?.[0]?.text || 'Erro.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ──────────────────────────────────────────
// AUTO-SYNC (30 min)
// ──────────────────────────────────────────
function scheduleAutoSync() {
  setInterval(async () => {
    if (!getToken()) return;
    const cfg   = readConfig();
    const since = cfg.last_since || todayStr();
    const until = cfg.last_until || todayStr();
    try {
      const r = await fetch(`http://localhost:${PORT}/api/meta/sync?since=${since}&until=${until}`);
      const d = await r.json();
      if (d.success) console.log(`[Auto-Sync] ✓ ${new Date().toLocaleTimeString('pt-BR')} — ${d.campaigns_count} campanhas`);
      else console.warn('[Auto-Sync] ✗', d.message || d.error);
    } catch (err) { console.warn('[Auto-Sync] Falhou:', err.message); }
  }, 30 * 60 * 1000);
}

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  META COMMAND CENTER`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Rodando em http://localhost:${PORT}`);
  console.log(`  GEMINI_API_KEY:     ${process.env.GEMINI_API_KEY    ? '✓' : '✗ não configurada'}`);
  console.log(`  META_ACCESS_TOKEN:  ${process.env.META_ACCESS_TOKEN ? '✓' : '✗ não configurada'}`);
  console.log(`  META_AD_ACCOUNT_ID: ${getAdAccountId()}`);
  console.log(`  ─────────────────────────────\n`);
  scheduleAutoSync();
});
