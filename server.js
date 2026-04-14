const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ──────────────────────────────────────────
// PATHS
// ──────────────────────────────────────────
const CAMPAIGNS_FILE = path.join(__dirname, 'data', 'campaigns.json');
const CONFIG_FILE    = path.join(__dirname, 'data', 'meta-config.json');

// ──────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
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

function datePreset(period) {
  const map = { '1': 'today', '7': 'last_7d', '14': 'last_14d', '30': 'last_30d', 'this_month': 'this_month' };
  return map[String(period)] || 'last_7d';
}

async function metaGet(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err = new Error(data.error.message || 'Meta API error');
    err.code = data.error.code;
    err.type = data.error.type;
    throw err;
  }
  return data;
}

function extractInsights(insights) {
  if (!insights?.data?.length) {
    return { investimento: 0, impressoes: 0, cliques: 0, ctr: 0, cpc: 0, pedidos: 0, compras: 0, custo_por_resultado: 0, alcance: 0 };
  }
  const d = insights.data[0];
  const actions      = d.actions || [];
  const costPerAction = d.cost_per_action_type || [];

  const purchases = actions?.filter(a =>
    a.action_type === 'purchase' ||
    a.action_type === 'omni_purchase' ||
    a.action_type === 'offsite_conversion.fb_pixel_purchase'
  ).reduce((sum, a) => sum + parseFloat(a.value || 0), 0) || 0;

  const addToCart = actions?.filter(a =>
    a.action_type === 'add_to_cart' ||
    a.action_type === 'omni_add_to_cart' ||
    a.action_type === 'offsite_conversion.fb_pixel_add_to_cart'
  ).reduce((sum, a) => sum + parseFloat(a.value || 0), 0) || 0;

  const costPerPurchase = parseFloat(costPerAction?.find(a =>
    a.action_type === 'purchase' ||
    a.action_type === 'omni_purchase' ||
    a.action_type === 'offsite_conversion.fb_pixel_purchase'
  )?.value || 0);

  return {
    investimento:        parseFloat(d.spend) || 0,
    impressoes:          parseInt(d.impressions) || 0,
    cliques:             parseInt(d.clicks) || 0,
    ctr:                 parseFloat(d.ctr) || 0,
    cpc:                 parseFloat(d.cpc) || 0,
    pedidos:             addToCart,
    compras:             purchases,
    custo_por_resultado: costPerPurchase,
    alcance:             parseInt(d.reach) || 0,
  };
}

// ──────────────────────────────────────────
// SERVE CAMPAIGN DATA
// ──────────────────────────────────────────
app.get('/api/campaigns', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
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
  cfg.access_token = access_token;
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
    has_token: !!getToken(),
    account_id: getAdAccountId(),
  });
});

// ──────────────────────────────────────────
// META: STATUS
// ──────────────────────────────────────────
app.get('/api/meta/status', (req, res) => {
  const cfg = readConfig();
  res.json({
    connected: !!getToken(),
    last_sync: cfg.last_sync || null,
    account_id: getAdAccountId(),
  });
});

// ──────────────────────────────────────────
// META: SYNC
// ──────────────────────────────────────────
app.get('/api/meta/sync', async (req, res) => {
  const token = getToken();
  if (!token) {
    return res.status(401).json({ error: 'no_token', message: 'Nenhum token configurado. Conecte a Meta API primeiro.' });
  }

  const period  = req.query.period || '7';
  const preset  = datePreset(period);
  const acctId  = getAdAccountId();
  const BASE    = 'https://graph.facebook.com/v19.0';
  const insightFields = 'spend,impressions,clicks,ctr,cpc,reach,actions,cost_per_action_type';

  try {
    // 1 ── Campaigns
    const campsData = await metaGet(
      `${BASE}/${acctId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget&limit=50&access_token=${token}`
    );

    const campaigns = [];

    for (const camp of campsData.data || []) {
      // Campaign insights
      let campInsights = {};
      try {
        const ci = await metaGet(`${BASE}/${camp.id}/insights?fields=${insightFields}&date_preset=${preset}&access_token=${token}`);
        campInsights = extractInsights(ci);
      } catch { /* no data for this period */ }

      const budget_total = parseFloat(camp.lifetime_budget || camp.daily_budget || 0) / 100;

      // 2 ── Adsets
      const adsetsData = await metaGet(
        `${BASE}/${camp.id}/adsets?fields=id,name,status,daily_budget,targeting&limit=50&access_token=${token}`
      );

      const adsets = [];

      for (const adset of adsetsData.data || []) {
        // Adset insights
        let adsetInsights = {};
        try {
          const ai = await metaGet(`${BASE}/${adset.id}/insights?fields=${insightFields}&date_preset=${preset}&access_token=${token}`);
          adsetInsights = extractInsights(ai);
        } catch { adsetInsights = extractInsights(null); }

        const targetingStr = buildTargetingString(adset.targeting);

        // 3 ── Ads
        const adsData = await metaGet(
          `${BASE}/${adset.id}/ads?fields=id,name,status,creative&limit=50&access_token=${token}`
        );

        const ads = [];

        for (const ad of adsData.data || []) {
          // Ad insights
          let adInsights = {};
          try {
            const adI = await metaGet(`${BASE}/${ad.id}/insights?fields=${insightFields}&date_preset=${preset}&access_token=${token}`);
            adInsights = extractInsights(adI);
          } catch { adInsights = extractInsights(null); }

          ads.push({
            id: ad.id,
            name: ad.name,
            format: detectFormat(ad.creative),
            status: normalizeStatus(ad.status),
            thumbnail: null,
            metrics: adInsights,
          });
        }

        adsets.push({
          id: adset.id,
          name: adset.name,
          status: normalizeStatus(adset.status),
          targeting: targetingStr,
          budget_daily: parseFloat(adset.daily_budget || 0) / 100,
          metrics: adsetInsights,
          ads,
        });
      }

      // Detect countries from adsets targeting
      const countries = extractCountries(adsetsData.data || []);

      campaigns.push({
        id: camp.id,
        name: camp.name,
        status: normalizeStatus(camp.status),
        objective: camp.objective || 'CONVERSIONS',
        budget_total,
        countries: countries.length ? countries : ['EU'],
        adsets,
      });
    }

    // Save to disk
    const result = { campaigns };
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(result, null, 2));

    // Update config with last_sync
    const cfg = readConfig();
    cfg.last_sync = new Date().toISOString();
    writeConfig(cfg);

    console.log(`[Meta Sync] ✓ ${campaigns.length} campanhas sincronizadas — ${preset}`);
    res.json({ success: true, updated_at: cfg.last_sync, campaigns_count: campaigns.length });

  } catch (err) {
    console.error('[Meta Sync] Error:', err.message);

    if (err.message?.toLowerCase().includes('token') || err.code === 190) {
      return res.status(401).json({ error: 'token_expired', message: 'Token expirado ou inválido. Reconecte a Meta API.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// HELPERS — META DATA NORMALIZATION
// ──────────────────────────────────────────
function normalizeStatus(status) {
  const map = { ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', ARCHIVED: 'PAUSED', DELETED: 'PAUSED' };
  return map[status] || status || 'ACTIVE';
}

function detectFormat(creative) {
  if (!creative) return 'IMAGE';
  const type = creative.effective_object_story_spec?.video_data ? 'VIDEO'
    : creative.object_type === 'VIDEO' ? 'VIDEO'
    : creative.object_type === 'SHARE' ? 'CAROUSEL'
    : 'IMAGE';
  return type;
}

function buildTargetingString(targeting) {
  if (!targeting) return 'Broad';
  const parts = [];
  if (targeting.age_min || targeting.age_max) {
    parts.push(`${targeting.age_min || '18'}-${targeting.age_max || '65'} anos`);
  }
  if (targeting.geo_locations?.countries?.length) {
    parts.push(targeting.geo_locations.countries.join(', '));
  }
  if (targeting.lookalike_specs?.length) {
    parts.push(`LAL ${(targeting.lookalike_specs[0].ratio * 100).toFixed(0)}%`);
  }
  if (targeting.custom_audiences?.length) {
    parts.push('Audiência customizada');
  }
  return parts.length ? parts.join(' — ') : 'Broad';
}

function extractCountries(adsets) {
  const countries = new Set();
  adsets.forEach(as => {
    const locs = as.targeting?.geo_locations?.countries || [];
    locs.forEach(c => countries.add(c));
  });
  return [...countries];
}

// ──────────────────────────────────────────
// GEMINI PROXY
// ──────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { prompt, campaignData } = req.body;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'GEMINI_API_KEY not set. Start server with: GEMINI_API_KEY=your_key node server.js' });
  }

  const systemPrompt = 'Você é estrategista de elite de Meta Ads para o mercado europeu. Analise os dados fornecidos e responda de forma direta, técnica e acionável. Use formatação markdown com bullets e negrito onde fizer sentido. Português brasileiro.';
  const fullPrompt = `${systemPrompt}\n\nDados das campanhas:\n${JSON.stringify(campaignData, null, 2)}\n\n${prompt}`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: fullPrompt }] }] })
      }
    );

    if (!response.ok) {
      const errData = await response.json();
      return res.status(response.status).json({ error: errData.error?.message || 'Gemini API error' });
    }

    const data = await response.json();
    res.json({ text: data.candidates?.[0]?.content?.parts?.[0]?.text || 'Erro na análise.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
// AUTO-SYNC (every 30 min if token present)
// ──────────────────────────────────────────
function scheduleAutoSync() {
  setInterval(async () => {
    if (!getToken()) return;
    try {
      const res = await fetch(`http://localhost:${PORT}/api/meta/sync`);
      const data = await res.json();
      if (data.success) {
        console.log(`[Auto-Sync] ✓ ${new Date().toLocaleTimeString('pt-BR')} — ${data.campaigns_count} campanhas`);
      } else {
        console.warn('[Auto-Sync] ✗', data.message || data.error);
      }
    } catch (err) {
      console.warn('[Auto-Sync] Falhou:', err.message);
    }
  }, 30 * 60 * 1000); // 30 minutes
}

// ──────────────────────────────────────────
// START
// ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  META COMMAND CENTER`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Rodando em http://localhost:${PORT}`);
  console.log(`  GEMINI_API_KEY:      ${process.env.GEMINI_API_KEY     ? '✓ configurada' : '✗ não configurada'}`);
  console.log(`  META_ACCESS_TOKEN:   ${process.env.META_ACCESS_TOKEN  ? '✓ configurada' : '✗ não configurada'}`);
  console.log(`  META_AD_ACCOUNT_ID:  ${getAdAccountId()}`);
  console.log(`  ─────────────────────────────\n`);
  scheduleAutoSync();
});
