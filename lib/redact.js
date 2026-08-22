// ============================================================
// PII / payment-data redaction for FareHarbor payloads
//
// The webhook archive (bookings.raw_data, webhook_events.raw_payload)
// is the largest personal-data surface in this system. FareHarbor
// booking payloads can carry payment instrument metadata and free-text
// custom-field answers that customers use for dietary, medical and
// accessibility notes. None of that is needed for revenue analytics,
// so it is stripped before anything is written to Postgres.
// ============================================================

const REDACTED = '[REDACTED]';

// Keys removed from the archive wherever they appear, at any depth.
const SENSITIVE_KEY_PATTERNS = [
  /card_?number/i,
  /^cc_/i,
  /cvv|cvc|security_code/i,
  /^credit_card$/i,
  /card_?token/i,
  /payment_?token/i,
  /authorization_?code/i,
  /routing_?number/i,
  /account_?number/i,
  /^ssn$/i,
  /social_?security/i,
  /passport/i,
  /drivers?_?licen[cs]e/i,
  /date_?of_?birth/i,
  /^dob$/i,
  /^password$/i,
  /^secret$/i,
  /api_?key/i,
];

// Custom-field labels whose answers are treated as special-category
// data (health, dietary, accessibility) and masked by default.
const SENSITIVE_LABEL_PATTERNS = [
  /allerg/i,
  /diet|vegan|vegetarian|kosher|halal|gluten/i,
  /medical|medication|health|condition|disabilit|mobility|wheelchair/i,
  /accessib/i,
  /pregnan/i,
  /birth ?date|date ?of ?birth|dob\b/i,
  /passport|licen[cs]e|government ?id|id ?number/i,
  /emergency ?contact/i,
];

function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERNS.some((re) => re.test(key));
}

function isSensitiveLabel(label) {
  if (typeof label !== 'string') return false;
  return SENSITIVE_LABEL_PATTERNS.some((re) => re.test(label));
}

// A FareHarbor custom-field entry looks roughly like:
//   { custom_field: { name, title, ... }, value: "...", display_value: "..." }
function redactCustomFieldEntry(entry, redactAll) {
  if (!entry || typeof entry !== 'object') return entry;

  const field = entry.custom_field || entry.field || {};
  const label = field.title || field.name || entry.name || entry.title || '';

  if (redactAll || isSensitiveLabel(label)) {
    const masked = { ...entry };
    for (const key of ['value', 'display_value', 'text', 'answer']) {
      if (key in masked) masked[key] = REDACTED;
    }
    return masked;
  }
  return entry;
}

/**
 * Deep-copy `input` with sensitive material removed.
 *
 * @param {*} input                     Parsed FareHarbor payload.
 * @param {object} [options]
 * @param {boolean} [options.redactAllCustomFields=false]
 *        Mask every custom-field answer, not just the ones whose label
 *        matches a special-category pattern.
 * @returns {*} A redacted deep copy. The input is never mutated.
 */
function redactPayload(input, options = {}) {
  const redactAll = options.redactAllCustomFields === true;
  const seen = new WeakSet();

  function walk(node, keyName) {
    if (node === null || typeof node !== 'object') return node;

    if (seen.has(node)) return undefined; // drop cycles rather than throw
    seen.add(node);

    if (Array.isArray(node)) {
      const isCustomFieldArray = /custom_field_(values|instances)|custom_fields/i.test(keyName || '');
      return node.map((item) =>
        isCustomFieldArray ? walk(redactCustomFieldEntry(item, redactAll), keyName) : walk(item, keyName)
      );
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(value, key);
    }
    return out;
  }

  return walk(input, null);
}

/**
 * Mask an email for log output: darko@example.com -> d***o@example.com
 */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return REDACTED;
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0] || ''}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

module.exports = { redactPayload, maskEmail, REDACTED };
