const pino = require('pino');
const path = require('path');
const fs = require('fs');

const LOG_DIR = path.join(__dirname, '..', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const transport = pino.transport({
    targets: [
        {
            target: 'pino-roll',
            options: {
                file: path.join(LOG_DIR, 'gateway.log'),
                size: '5m',
                limit: { count: 3 },
                mkdir: true
            }
        },
        {
            target: 'pino/file',
            options: { destination: 1 }
        }
    ]
});

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: undefined
}, transport);

function cat(category) {
    return logger.child({ cat: category });
}

module.exports = { logger, cat };
