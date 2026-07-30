const fs = require('fs')
const path = require('path')
const os = require('os')
const cluster = require('cluster')
const express = require('express');
const { graphqlHTTP } = require('express-graphql');
const { buildSchema, GraphQLEnumType } = require('graphql');
const { types } = require('./graphql/types.js');
const { applyDateFilters, applyStringFilters } = require('./graphql/filters.js');
const { removeLeadingZeros } = require('./utils.js');
const { buildGraph } = require('./index_builder.js');
const { createRateLimiter } = require('./rate_limit.js');
const { createResponseCache } = require('./response_cache.js');

function getValuesBySortedKey(object) {
    return Object.keys(object)
        .sort()
        .map(k => object[k]);
}

function slice(array, from, limit) {
    if (!from) from = 0;
    if (from >= array.length) return [];
    return array.slice(from, limit ? from + limit : limit);
}

function getQueryArgs(schema, query) {
    return Object.values(schema['_queryType']['_fields'][query]['args']);
}

function findArgsOfType(schema, query, type) {
    return getQueryArgs(schema, query)
        .filter(a => a['type']['name'] === type)
        .map(a => a['name']);
}

function findEnumArgs(schema, query) {
    return getQueryArgs(schema, query)
        .filter(a => a['type'] instanceof GraphQLEnumType)
        .map(a => a['name']);
}

function resolve(schema, query, args, {
    ids,
    indexes,
    all,
} = {}) {
    const [dateFilters, stringFilters] = ['DateFilter', 'StringFilter'].map(name => findArgsOfType(schema, query, name));
    const enumFilters = findEnumArgs(schema, query);
    let results = ids
        ? ids.map(id => (indexes.find(index => id in index) || {})[id]).filter(o => o)
        // `all` is the pre-sorted list of every value, computed once at startup;
        // fall back to sorting on demand only when it was not supplied.
        : (all || getValuesBySortedKey(indexes[0]));
    if (dateFilters) results = applyDateFilters(results, dateFilters.map(a => args[a]), dateFilters);
    if (stringFilters) results = applyStringFilters(results, stringFilters.map(a => args[a]), stringFilters);
    if (enumFilters) results = results.filter(r => !enumFilters.find(e => args[e] && args[e] !== r[e]));
    return slice(results, args.from, args.limit);
}

async function startServer() {

    // Build a schema, using GraphQL schema language
    const schema = buildSchema(fs.readFileSync(path.resolve(__dirname, '..', 'schema.graphql'), 'utf-8'));
    Object.keys(types).forEach(t => Object.assign(schema._typeMap[t], types[t]));

    const graph = await buildGraph();
    const medicaments = graph['medicaments'];
    const presentations = Object.values(graph['presentations']);
    const substances = graph['substances'];
    const groupesGeneriques = graph['groupes_generiques'];

    // Pre-sort each collection once. Previously every unfiltered query re-sorted
    // ~15k keys and rebuilt the values array on the single event loop, which is
    // what serialised concurrent requests into ~200ms steps.
    const allMedicaments = getValuesBySortedKey(medicaments);
    const allPresentations = getValuesBySortedKey(presentations[0]);
    const allSubstances = getValuesBySortedKey(substances);
    const allGroupesGeneriques = getValuesBySortedKey(groupesGeneriques);

    // The root provides the top-level API endpoints
    const root = {
        medicaments: (args) => resolve(schema, 'medicaments', args, {
            ids: args.CIS ? args.CIS.map(c => removeLeadingZeros(c)) : null,
            indexes: [medicaments],
            all: allMedicaments,
        }),
        presentations: (args) => resolve(schema, 'presentations', args, {
            ids: args.CIP,
            indexes: presentations,
            all: allPresentations,
        }),
        substances: (args) => resolve(schema, 'substances', args, {
            ids: args.codes_substances ? args.codes_substances.map(c => removeLeadingZeros(c)) : null,
            indexes: [substances],
            all: allSubstances,
        }),
        groupes_generiques: (args) => resolve(schema, 'groupes_generiques', args, {
            ids: args.ids,
            indexes: [groupesGeneriques],
            all: allGroupesGeneriques,
        }),
    }

    const app = express();
    const port = process.env.PORT || 4000;

    // Behind Cloudflare + Render: trust the proxy chain so forwarded client
    // information is available.
    app.set('trust proxy', true);
    app.use(express.json({ limit: '1mb' }));

    // Rate limiter: keyed by client IP, with our own backend exempted via a
    // shared-secret header (see rate_limit.js). Configurable via env.
    const rateLimiter = createRateLimiter({
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000,
        max: process.env.RATE_LIMIT_MAX != null ? parseInt(process.env.RATE_LIMIT_MAX, 10) : 300,
        allowlistHeader: process.env.INTERNAL_API_KEY_HEADER || 'x-internal-key',
        allowlistSecret: process.env.INTERNAL_API_KEY || '',
        enabled: process.env.RATE_LIMIT_DISABLED !== 'true',
    });

    // Response cache: identical read queries are served from memory.
    const responseCache = createResponseCache({
        ttlSeconds: process.env.CACHE_TTL_SECONDS != null ? parseInt(process.env.CACHE_TTL_SECONDS, 10) : 300,
        maxEntries: parseInt(process.env.CACHE_MAX_ENTRIES, 10) || 500,
        enabled: process.env.CACHE_DISABLED !== 'true',
    });

    app.use('/graphql', rateLimiter, responseCache, graphqlHTTP({
        schema: schema,
        rootValue: root,
        graphiql: true,
    }));

    const server = app.listen(port);
    // Keep upstream (Cloudflare/Render proxy) connections open long enough to be
    // reused, so callers don't pay a TCP+TLS handshake on every request.
    server.keepAliveTimeout = 65 * 1000;
    server.headersTimeout = 66 * 1000;
    console.log(`Running a GraphQL API server at http://localhost:${port}/graphql (pid ${process.pid})`);
}

// Number of worker processes. Render exposes CPU count via WEB_CONCURRENCY;
// fall back to the machine's CPU count, capped so we don't hold N copies of the
// in-memory graph on large hosts.
function workerCount() {
    const env = parseInt(process.env.WEB_CONCURRENCY, 10);
    if (Number.isInteger(env) && env > 0) return env;
    const cpus = (os.cpus() || []).length || 1;
    return Math.max(1, Math.min(cpus, 4));
}

function main() {
    const workers = workerCount();
    // Node is single-threaded, and the resolvers are CPU-bound synchronous work,
    // so a lone process handles requests strictly one at a time. Forking a worker
    // per core lets concurrent reads run in parallel on multi-core hosts.
    if (cluster.isPrimary && workers > 1) {
        console.log(`Primary ${process.pid} launching ${workers} workers`);
        for (let i = 0; i < workers; i++) cluster.fork();
        cluster.on('exit', (worker, code, signal) => {
            console.log(`Worker ${worker.process.pid} exited (${signal || code}); restarting`);
            cluster.fork();
        });
    } else {
        startServer();
    }
}

main();
