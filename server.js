const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Serve campaign data
app.get('/api/campaigns', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'campaigns.json'), 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load campaign data' });
  }
});

// Proxy para Anthropic API
app.post('/api/analyze', async (req, res) => {
  const { prompt, campaignData } = req.body;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ error: 'ANTHROPIC_API_KEY not set. Start server with: ANTHROPIC_API_KEY=your_key node server.js' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: 'Você é estrategista de elite de Meta Ads para o mercado europeu. Analise os dados fornecidos e responda de forma direta, técnica e acionável. Use formatação markdown com bullets e negrito onde fizer sentido. Português brasileiro.',
        messages: [{
          role: 'user',
          content: `Dados das campanhas:\n${JSON.stringify(campaignData, null, 2)}\n\n${prompt}`
        }]
      })
    });

    if (!response.ok) {
      const errData = await response.json();
      return res.status(response.status).json({ error: errData.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    res.json({ text: data.content?.[0]?.text || 'Erro na análise.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  META COMMAND CENTER`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Rodando em http://localhost:${PORT}`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ configurada' : '✗ não configurada'}`);
  console.log(`  ─────────────────────────────\n`);
});
