'use strict';

/**
 * In-memory TTL cache for POST /graphql responses.
 *
 * The underlying BDPM data set is loaded once at startup and is immutable for
 * the lifetime of the process, and the schema is read-only (no mutations), so
 * identical query+variables always produce the same response and can be cached
 * safely. This also collapses the "concurrent identical query" pattern: the
 * first request fills the cache and the rest are served from it instead of each
 * re-running the (synchronous, event-loop-blocking) resolver.
 */

// Deterministic serialisation so key order in `variables` never affects the key.
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    return (
        '{' +
        Object.keys(value)
            .sort()
            .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]))
            .join(',') +
        '}'
    );
}

/**
 * @param {object} options
 * @param {number} [options.ttlSeconds=300]  Entry lifetime.
 * @param {number} [options.maxEntries=500]  LRU cap on distinct queries kept.
 * @param {boolean}[options.enabled=true]
 */
function createResponseCache(options = {}) {
    const ttlMs = (options.ttlSeconds != null ? options.ttlSeconds : 300) * 1000;
    const maxEntries = options.maxEntries != null ? options.maxEntries : 500;
    const enabled = options.enabled !== false && ttlMs > 0 && maxEntries > 0;
    const maxAge = Math.ceil(ttlMs / 1000);

    // Insertion-ordered Map used as a small LRU.
    const store = new Map(); // key -> { body: Buffer, expiresAt: number }

    function get(key) {
        const hit = store.get(key);
        if (!hit) return null;
        if (hit.expiresAt <= Date.now()) {
            store.delete(key);
            return null;
        }
        // Mark as most-recently-used.
        store.delete(key);
        store.set(key, hit);
        return hit.body;
    }

    function set(key, body) {
        store.set(key, { body, expiresAt: Date.now() + ttlMs });
        while (store.size > maxEntries) {
            store.delete(store.keys().next().value);
        }
    }

    return function responseCache(req, res, next) {
        if (!enabled || req.method !== 'POST') return next();

        const body = req.body;
        if (!body || typeof body.query !== 'string') return next();

        const key = stableStringify({
            q: body.query,
            v: body.variables != null ? body.variables : null,
            o: body.operationName != null ? body.operationName : null,
        });

        const cached = get(key);
        if (cached) {
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Content-Length', String(Buffer.byteLength(cached)));
                res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
                res.setHeader('X-Cache', 'HIT');
            }
            res.end(cached);
            return;
        }

        // Cache miss: buffer the outgoing body so a successful response can be stored.
        res.setHeader('X-Cache', 'MISS');
        const chunks = [];
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);

        res.write = function (chunk, ...rest) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return origWrite(chunk, ...rest);
        };

        res.end = function (chunk, ...rest) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            try {
                if (res.statusCode === 200 && chunks.length) {
                    const buf = Buffer.concat(chunks);
                    // Only cache well-formed GraphQL responses with no top-level errors.
                    const parsed = JSON.parse(buf.toString('utf8'));
                    if (parsed && !parsed.errors) {
                        set(key, buf);
                        if (!res.headersSent) {
                            res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
                        }
                    }
                }
            } catch (_) {
                /* unparseable body -> don't cache */
            }
            return origEnd(chunk, ...rest);
        };

        return next();
    };
}

module.exports = { createResponseCache };
