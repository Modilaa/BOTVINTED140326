// ─── Rate limiter for per-opportunity alerts ──────────────────────────────
// Telegram API limit: max 1 message per 3 seconds
let _nextAlertSendTime = 0;
const ALERT_MIN_INTERVAL_MS = 3000;

/**
 * Sends a Telegram alert when a good arbitrage opportunity is detected.
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from environment.
 * Silently skips if tokens are missing or confidence is too low.
 *
 * @param {object} opportunity - Row object from index.js scan loop
 */
async function sendOpportunityAlert(opportunity) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // silently skip — not configured

  const minConfidence = parseInt(process.env.TELEGRAM_MIN_CONFIDENCE || '50', 10);
  const confidence = opportunity.confidence ?? 0;
  if (confidence < minConfidence) return;

  // Rate limit: max 1 message per 3 seconds
  const now = Date.now();
  const waitMs = Math.max(0, _nextAlertSendTime - now);
  _nextAlertSendTime = now + waitMs + ALERT_MIN_INTERVAL_MS;
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }

  const profit = opportunity.profit || {};
  const liquidity = opportunity.liquidity || {};
  const liquidityScore = (typeof liquidity === 'object')
    ? (liquidity.score ?? liquidity.summary?.score ?? '—')
    : liquidity;
  const classification = liquidity.classification || liquidity.summary?.label || '—';

  // Escape Markdown special chars in dynamic content
  const escMd = (s) => String(s || '').replace(/[*_[\]]/g, (c) => `\\${c}`);

  const category = escMd(opportunity.search || '—');
  const title = escMd(opportunity.title || '—');
  const source = escMd(opportunity.pricingSource || '—');
  const vintedPrice = (opportunity.vintedBuyerPrice || 0).toFixed(2);
  const marketPrice = (profit.averageSoldPrice || 0).toFixed(2);
  const profitVal = (profit.profit || 0).toFixed(2);
  const profitPct = (profit.profitPercent || 0).toFixed(1);

  const ebaySearchUrl = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(opportunity.sourceQuery || opportunity.title || '')}`;

  const messageLines = [
    '🔥 OPPORTUNITÉ',
    '',
    `📦 ${category}`,
    `🏷 ${title}`,
    '',
    `💰 Vinted: ${vintedPrice}€`,
    `📈 Marché: ${marketPrice}€ (${source})`,
    `💵 Profit: +${profitVal}€ (+${profitPct}%)`,
    '',
    `📊 Confiance: ${confidence}/100`,
    `🏷 Liquidité: ${liquidityScore} (${classification})`,
  ];
  if (opportunity.visionVerified && opportunity.visionResult && opportunity.visionResult.sameCard) {
    messageLines.push(`✅ Vision IA: Confirmé (${opportunity.visionResult.confidence}%)`);
  }
  messageLines.push('');
  messageLines.push(`🔗 Vinted: ${escMd(opportunity.url || '')}`);
  messageLines.push(`🔗 eBay: ${escMd(ebaySearchUrl)}`);

  const message = messageLines.join('\n');

  // Inline keyboard for Telegram actions (requires opportunity ID from URL)
  const opportunityId = (opportunity.url || '').match(/\/items\/(\d+)/)?.[1] || null;
  const replyMarkup = opportunityId ? JSON.stringify({
    inline_keyboard: [
      [
        { text: '💰 Acheter', callback_data: `buy_${opportunityId}` },
        { text: '❌ Ignorer', callback_data: `ignore_${opportunityId}` },
        { text: '🔍 Détails', callback_data: `verify_${opportunityId}` }
      ]
    ]
  }) : undefined;

  // Try sendPhoto with the Vinted image; fall back to sendMessage
  const vintedImageUrl = opportunity.imageUrl || null;

  try {
    let sent = false;

    if (vintedImageUrl) {
      try {
        const photoEndpoint = `https://api.telegram.org/bot${token}/sendPhoto`;
        const photoBody = {
          chat_id: chatId,
          photo: vintedImageUrl,
          caption: message,
          parse_mode: 'Markdown'
        };
        if (replyMarkup) photoBody.reply_markup = replyMarkup;
        const photoResponse = await fetch(photoEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(photoBody)
        });
        if (photoResponse.ok) {
          sent = true;
        } else {
          const body = await photoResponse.text();
          console.warn(`[Telegram] sendPhoto failed (${photoResponse.status}), falling back to sendMessage: ${body}`);
        }
      } catch (photoErr) {
        console.warn(`[Telegram] sendPhoto error, falling back: ${photoErr.message}`);
      }
    }

    if (!sent) {
      const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
      const msgBody = {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      };
      if (replyMarkup) msgBody.reply_markup = replyMarkup;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msgBody)
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[Telegram] sendOpportunityAlert error ${response.status}: ${body}`);
      }
    }
  } catch (err) {
    console.error(`[Telegram] sendOpportunityAlert failed: ${err.message}`);
  }
}

async function sendTelegramMessage(telegramConfig, message) {
  if (!telegramConfig.token || !telegramConfig.chatId) {
    return { skipped: true, reason: 'telegram_not_configured' };
  }

  // SAFETY FILTER 2026-03-22: block Discovery spam messages
  if (message && message.includes('DISCOVERY MULTI-CATEGORIES')) {
    console.log('[Telegram] BLOCKED: message "DISCOVERY MULTI-CATEGORIES" filtré');
    return { skipped: true, reason: 'discovery_blocked' };
  }

  const endpoint = `https://api.telegram.org/bot${telegramConfig.token}/sendMessage`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: telegramConfig.chatId,
      text: message,
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram error ${response.status}: ${body}`);
  }

  return { skipped: false };
}

function formatSoldDate(value) {
  if (!value) {
    return 'date inconnue';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
}

function buildTelegramMessage(scanResult) {
  const lines = [];
  lines.push(`Scan termine: ${scanResult.opportunities.length} opportunite(s)`);

  // Underpriced alerts
  const alerts = scanResult.underpricedAlerts || [];
  if (alerts.length > 0) {
    lines.push(`+ ${alerts.length} carte(s) sous-evaluee(s)`);
  }
  lines.push('');

  // eBay arbitrage opportunities
  for (const [index, opportunity] of scanResult.opportunities.slice(0, 5).entries()) {
    const soldDetails = opportunity.matchedSales
      .map((sale) => {
        const imageConfidence = sale.imageMatch?.confidence ? ` | image ${sale.imageMatch.confidence}` : '';
        return `${formatSoldDate(sale.soldAt)} -> ${sale.totalPrice.toFixed(2)} EUR${imageConfidence}`;
      })
      .join(' / ');

    lines.push(`${index + 1}. ${opportunity.title}`);
    lines.push(`Vinted: ${opportunity.vintedBuyerPrice.toFixed(2)} EUR hors port`);
    lines.push(`eBay sold x2: ${soldDetails}`);
    lines.push(`Profit estime: ${opportunity.profit.profit.toFixed(2)} EUR (${opportunity.profit.profitPercent.toFixed(1)}%)`);

    // Liquidité (si disponible via le pipeline)
    if (opportunity.liquidity && opportunity.liquidity.summary) {
      const ls = opportunity.liquidity.summary;
      lines.push(`${ls.speedEmoji} Liquidite: ${ls.speedLabel} (score ${ls.score}/100) | Marge ajustee: ${ls.adjustedMarginPercent}%`);
    }

    lines.push(opportunity.url);

    // Liens sources de prix (PokemonTCG.io, YGOPRODeck, Cardmarket, eBay...)
    const sourceUrls = opportunity.sourceUrls || [];
    if (sourceUrls.length > 0) {
      const platformLabels = {
        pokemontcg: 'PokemonTCG.io',
        tcgplayer: 'TCGPlayer',
        ygoprodeck: 'YGOPRODeck',
        cardmarket: 'Cardmarket',
        ebay: 'eBay'
      };
      for (const src of sourceUrls.slice(0, 4)) {
        const label = platformLabels[src.platform] || src.platform;
        const priceStr = src.price > 0 ? ` (${src.price.toFixed(2)} EUR)` : '';
        lines.push(`\uD83D\uDCCA Source prix ${label}${priceStr}: ${src.url}`);
      }
    } else {
      // Fallback: liens eBay classiques si pas de sourceUrls
      const ebayLinks = (opportunity.matchedSales || [])
        .filter((sale) => sale.url)
        .slice(0, 3);
      if (ebayLinks.length > 0) {
        for (const sale of ebayLinks) {
          lines.push(`\uD83D\uDCCE Source eBay: ${sale.url}`);
        }
      }
    }

    lines.push('');
  }

  // Underpriced Vinted alerts
  if (alerts.length > 0) {
    lines.push('--- SOUS-EVALUES VINTED ---');
    for (const alert of alerts.slice(0, 5)) {
      lines.push(`${alert.listing.title.slice(0, 50)}`);
      lines.push(`${alert.listing.buyerPrice} EUR vs median ${alert.medianPrice} EUR (-${alert.discount}%) [${alert.compCount} comparables]`);
      lines.push(alert.listing.url);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

/**
 * Axe 8: Digest quotidien — résumé de la journée envoyé une fois le soir.
 * Inclut: top opportunités, stats globales, tendances, suggestions.
 */
async function sendDailyDigest(scanResult) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const opportunities = scanResult.opportunities || [];
  const allListings = scanResult.searchedListings || [];

  // Stats du jour
  const activeOpps = opportunities.filter(o => !o.stale && !o.archived);
  const totalProfit = activeOpps.reduce((sum, o) => sum + (o.profit ? o.profit.profit : 0), 0);
  const confirmedByGpt = activeOpps.filter(o => o.visionVerified && o.visionResult && o.visionResult.sameCard);

  // Top 3 par profit
  const top3 = [...activeOpps]
    .sort((a, b) => (b.profit?.profit || 0) - (a.profit?.profit || 0))
    .slice(0, 3);

  // Categories actives
  const categories = new Map();
  for (const opp of activeOpps) {
    const cat = opp.search || 'Autre';
    categories.set(cat, (categories.get(cat) || 0) + 1);
  }

  const lines = [
    '📋 DIGEST QUOTIDIEN',
    '',
    `📊 ${activeOpps.length} opportunités actives`,
    `💰 Profit estimé total: ${totalProfit.toFixed(2)}€`,
    `✅ Confirmées GPT: ${confirmedByGpt.length}`,
    `🔍 Annonces scannées: ${allListings.length}`,
    ''
  ];

  if (top3.length > 0) {
    lines.push('🏆 TOP 3 OPPORTUNITÉS:');
    for (const [i, opp] of top3.entries()) {
      const profit = opp.profit ? opp.profit.profit.toFixed(2) : '?';
      const conf = opp.confidence || 0;
      const gptBadge = (opp.visionVerified && opp.visionResult?.sameCard) ? ' ✅' : '';
      lines.push(`${i + 1}. ${(opp.title || '').slice(0, 40)} → +${profit}€ (${conf}/100)${gptBadge}`);
    }
    lines.push('');
  }

  if (categories.size > 0) {
    lines.push('📂 PAR CATÉGORIE:');
    for (const [cat, count] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${cat}: ${count} opportunité(s)`);
    }
  }

  const message = lines.join('\n');

  try {
    const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      })
    });
  } catch (err) {
    console.error(`[Telegram] Digest error: ${err.message}`);
  }
}

module.exports = {
  buildTelegramMessage,
  sendTelegramMessage,
  sendOpportunityAlert,
  sendDailyDigest
};
