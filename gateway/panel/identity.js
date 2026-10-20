// @ts-check
const { assertValid } = require('@sdk-bot/contracts');
const { actorId } = require('../lib/panelContext');
const { BoundaryError } = require('../lib/httpBoundary');

function resolveActor(session, { oauthEnabled, nodeEnv, devActor, authRequired = false, grants = '{}' }) {
    let subject;
    let displayName;
    if (oauthEnabled && session?.sub && session?.verified === true) {
        subject = `google:${session.sub}`;
        displayName = session.name || 'Operador';
    } else if (!oauthEnabled && !authRequired && nodeEnv === 'development' && devActor === 'true') {
        subject = 'dev:local';
        displayName = 'Operador local de desarrollo';
    } else {
        throw new BoundaryError(401, 'UNAUTHENTICATED', 'Inicia sesión para acceder a conversaciones.');
    }
    try {
        const registry = JSON.parse(grants);
        if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error();
        const capabilities = Object.hasOwn(registry, subject) ? registry[subject] : ['conversations:read'];
        return assertValid('Actor', { id: actorId(subject), displayName, capabilities });
    } catch {
        throw new BoundaryError(503, 'SERVICE_UNAVAILABLE', 'Permisos del panel sin configurar correctamente.');
    }
}

module.exports = { resolveActor };
