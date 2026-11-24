const crypto = require('crypto');
const logger = require('./logger');

// TEMP DIAGNOSTIC LOGS: remove this helper and its marked call sites after the observation window.
// Keep this deliberately small and structured; do not use it for normal application events.

function operationId(prefix = 'op') {
    return `${prefix}-${crypto.randomUUID()}`;
}

function diagnosticLog(message, metadata = {}) {
    logger.info(`[DIAGNOSTIC] ${message}`, metadata);
}

function diagnosticError(message, metadata = {}) {
    logger.error(`[DIAGNOSTIC] ${message}`, metadata);
}

module.exports = {
    operationId,
    diagnosticLog,
    diagnosticError
};
