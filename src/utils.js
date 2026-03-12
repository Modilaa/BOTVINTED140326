function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function average(values) {
  if (!values.length) {
    return null;
  }

  const sum = values.reduce((accumulator, value) => accumulator + value, 0);
  return sum / values.length;
}

function normalizeSpaces(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function toSlugTokens(value) {
  return normalizeSpaces(
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s/#-]/g, ' ')
  )
    .split(' ')
    .filter(Boolean);
}

function parseEuroAmount(value) {
  if (!value) {
    return null;
  }

  const cleaned = String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[^\d.,]/g, '');

  if (!cleaned) {
    return null;
  }

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const decimalIndex = Math.max(lastComma, lastDot);

  let normalized = cleaned;
  if (decimalIndex >= 0) {
    const fractionalPart = cleaned.slice(decimalIndex + 1);
    if (fractionalPart.length > 0 && fractionalPart.length <= 2) {
      normalized = `${cleaned.slice(0, decimalIndex).replace(/[.,]/g, '')}.${fractionalPart}`;
    } else {
      normalized = cleaned.replace(/[.,]/g, '');
    }
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMoneyValue(value) {
  if (!value) {
    return null;
  }

  const amount = parseEuroAmount(value);
  if (amount === null) {
    return null;
  }

  const text = String(value).toUpperCase();
  let currency = 'EUR';

  if (text.includes('USD') || text.includes('US $') || text.includes('$')) {
    currency = 'USD';
  } else if (text.includes('GBP') || text.includes('£')) {
    currency = 'GBP';
  } else if (text.includes('EUR') || text.includes('€')) {
    currency = 'EUR';
  }

  return {
    amount,
    currency
  };
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

module.exports = {
  average,
  decodeHtmlEntities,
  median,
  parseMoneyValue,
  normalizeSpaces,
  parseEuroAmount,
  sleep,
  toSlugTokens
};
