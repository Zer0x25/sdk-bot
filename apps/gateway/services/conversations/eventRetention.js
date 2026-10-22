'use strict';

const MAX_RETAINED_EVENTS = 50_000n;

/** Return the cutoff so the current transaction retains exactly the newest window. */
function retentionCutoff(sequence) {
    const current = BigInt(sequence);
    if (current <= MAX_RETAINED_EVENTS) return null;
    return String(current - MAX_RETAINED_EVENTS);
}

module.exports = { MAX_RETAINED_EVENTS, retentionCutoff };
