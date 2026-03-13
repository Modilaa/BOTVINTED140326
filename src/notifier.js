async function sendTelegramMessage(telegramConfig, message) {
  if (!telegramConfig.token || !telegramConfig.chatId) {
    return { skipped: true, reason: 'telegram_not_configured' };
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
    lines.push(opportunity.url);
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

module.exports = {
  buildTelegramMessage,
  sendTelegramMessage
};
