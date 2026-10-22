'use strict';

const MAX_SEARCH_TERMS = 32;

function normalizeSearchQuery(value) {
    if (typeof value !== 'string' || value.length > 256) {
        throw Object.assign(new Error('INVALID_SEARCH_QUERY'), { code: 'INVALID_SEARCH_QUERY' });
    }
    const terms = [...new Set((value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))];
    if (!terms.length || terms.length > MAX_SEARCH_TERMS) {
        throw Object.assign(new Error(terms.length ? 'SEARCH_TOO_COMPLEX' : 'INVALID_SEARCH_QUERY'), {
            code: terms.length ? 'SEARCH_TOO_COMPLEX' : 'INVALID_SEARCH_QUERY'
        });
    }
    // Build a literal AND expression. User input never reaches FTS5's query grammar.
    return { terms, match: terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ') };
}

module.exports = { normalizeSearchQuery, MAX_SEARCH_TERMS };
