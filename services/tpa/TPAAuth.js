/**
 * TPA Authentication Service
 * Handles API key validation and TPA context management
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

// In-memory rate limiting store
const rateLimitStore = {};

class TPAAuthService {
    /**
     * Validate API key and get TPA context
     */
    static async validateApiKey(apiKey) {
        try {
            logger.info('Validating TPA API key', { apiKey: apiKey.substring(0, 10) + '...' });
            
            const rows = await db.query(
                `SELECT tak.*, c.client_name, c.client_code, c.short_code
                 FROM tpa_api_keys tak
                 JOIN clients c ON tak.client_id = c.id
                 WHERE tak.api_key = ? AND tak.is_active = TRUE`,
                [apiKey]
            );

            logger.info('TPA API key query result', { count: rows.length });

            if (rows.length === 0) {
                logger.warn('No TPA API key found', { apiKey: apiKey.substring(0, 10) + '...' });
                return null;
            }

            logger.info('TPA API key validated successfully', { 
                clientId: rows[0].client_id, 
                clientName: rows[0].client_name 
            });

            return rows[0];
        } catch (error) {
            logger.error('Error validating TPA API key', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Check rate limit for TPA
     */
    static checkRateLimit(tpaKeyId, rateLimit) {
        const now = Date.now();
        const key = `rate_limit_${tpaKeyId}`;

        if (!rateLimitStore[key]) {
            rateLimitStore[key] = [];
        }

        // Clean old requests (older than 1 minute)
        rateLimitStore[key] = rateLimitStore[key].filter(time => now - time < 60000);

        if (rateLimitStore[key].length >= rateLimit) {
            return false;
        }

        rateLimitStore[key].push(now);
        return true;
    }

    /**
     * Clean rate limit store periodically
     */
    static cleanRateLimitStore() {
        const now = Date.now();
        Object.keys(rateLimitStore).forEach(key => {
            rateLimitStore[key] = rateLimitStore[key].filter(time => now - time < 60000);
            if (rateLimitStore[key].length === 0) {
                delete rateLimitStore[key];
            }
        });
    }
}

// Clean rate limit store every 5 minutes
setInterval(() => {
    TPAAuthService.cleanRateLimitStore();
}, 5 * 60 * 1000);

module.exports = TPAAuthService;
