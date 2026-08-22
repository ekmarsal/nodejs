// ============================================================
// Security helpers: constant-time comparison, auth middleware,
// rate limiting, and request identifiers.
// ============================================================
const crypto = require('node:crypto');

/**
 * Constant-time string comparison that does not leak length via an
 * exception. Both inputs are hashed to a fixed width first, so
 * timingSafeEqual always sees equal-length buffers.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Fixed-window in-memory rate limiter. Enough for a single-instance
 * webhook receiver; move to Redis if this service is ever scaled out.
 */
function rateLimit({ windowMs, max, name }) {
  const hits = new Map();

  // Drop expired buckets so the map cannot grow without bound.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, bucket] of hits) {
      if (bucket.start < cutoff) hits.delete(key);
    }
  }, windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  return function rateLimitMiddleware(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let bucket = hits.get(key);

    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
      console.warn(`[rate-limit] ${name}: blocked ${key} (${bucket.count} reqs in window)`);
      return res.status(429).json({ error: 'Too many requests' });
    }
    return next();
  };
}

/**
 * Bearer-token auth for operational and privacy endpoints.
 * Fails closed: with no token configured, the route is unreachable.
 */
function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_API_TOKEN;

  if (!expected) {
    console.error('[auth] ADMIN_API_TOKEN is not set - refusing access to protected route');
    return res.status(503).json({ error: 'Endpoint disabled: no admin token configured' });
  }
  if (expected.length < 32) {
    console.error('[auth] ADMIN_API_TOKEN is shorter than 32 characters - refusing access');
    return res.status(503).json({ error: 'Endpoint disabled: admin token too weak' });
  }

  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!presented || !safeEqual(presented, expected)) {
    console.warn(`[auth] rejected request to ${req.path} from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/** Baseline response headers. Equivalent to the helmet defaults we need. */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/**
 * CORS restricted to an explicit allowlist. This service is called
 * server-to-server by FareHarbor, so the default is no CORS at all.
 */
function corsAllowlist(req, res, next) {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

/** Short correlation id so logs can be tied to a response without PII. */
function requestId(req, res, next) {
  req.id = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { safeEqual, rateLimit, requireAdminToken, securityHeaders, corsAllowlist, requestId };
