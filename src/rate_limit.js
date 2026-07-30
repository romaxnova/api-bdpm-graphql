'use strict';

/**
 * Small dependency-free rate limiter for the GraphQL endpoint.
 *
 * Keyed by client IP (resolved through the Cloudflare/Render proxy chain).
 * A trusted caller — our own backend — is exempted by presenting a shared
 * secret in a header, which is robust to the caller's IP changing (Render
 * egress IPs are not stable, so an IP allowlist cannot be relied on).
 */

const crypto = require('crypto');

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    // timingSafeEqual requires equal-length buffers; length itself is not secret.
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

/**
 * Resolve the originating client IP. Behind Cloudflare + Render the socket
 * address is a proxy, so prefer the forwarded headers.
 */
function clientIp(req) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return cf;
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * @param {object} options
 * @param {number} [options.windowMs=60000]      Window length in ms.
 * @param {number} [options.max=300]             Max requests per window per key.
 * @param {string} [options.allowlistHeader]     Header carrying the shared secret.
 * @param {string} [options.allowlistSecret]     Expected shared-secret value.
 * @param {boolean}[options.enabled=true]        Master on/off switch.
 */
function createRateLimiter(options = {}) {
    const windowMs = options.windowMs != null ? options.windowMs : 60 * 1000;
    const max = options.max != null ? options.max : 300;
    const headerName = (options.allowlistHeader || 'x-internal-key').toLowerCase();
    const secret = options.allowlistSecret || '';
    const enabled = options.enabled !== false && max > 0 && windowMs > 0;

    // key -> { count, resetAt }
    const hits = new Map();

    // Periodically drop expired entries so the map cannot grow unbounded.
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [k, v] of hits) {
            if (v.resetAt <= now) hits.delete(k);
        }
    }, windowMs);
    if (sweep.unref) sweep.unref();

    function isAllowlisted(req) {
        if (!secret) return false;
        return safeEqual(req.headers[headerName] || '', secret);
    }

    return function rateLimit(req, res, next) {
        if (!enabled) return next();

        // Trusted callers (our own backend) bypass the limiter entirely.
        if (isAllowlisted(req)) {
            res.setHeader('X-RateLimit-Bypass', 'allowlist');
            return next();
        }

        const key = clientIp(req);
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;

        const resetSeconds = Math.max(0, Math.ceil((entry.resetAt - now) / 1000));
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
        res.setHeader('RateLimit-Reset', String(resetSeconds));

        if (entry.count > max) {
            res.setHeader('Retry-After', String(resetSeconds));
            res.status(429).json({
                errors: [{ message: `Rate limit exceeded. Retry in ${resetSeconds}s.` }],
            });
            return;
        }

        return next();
    };
}

module.exports = { createRateLimiter, clientIp };
