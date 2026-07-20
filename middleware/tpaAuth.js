/**
 * TPA Authentication Middleware
 * Validates API keys and enforces rate limiting
 */

const { TPAAuthService } = require('../services/tpa');
const logger = require('../lib/logger');

/**
 * Middleware to authenticate TPA API requests
 */
const authenticateTPA = async (req, res, next) => {
    try {
        // Check if TPA integration is enabled
        if (process.env.TPA_INTEGRATION_ENABLED !== 'true') {
            return res.status(503).json({
                success: false,
                error: 'TPA integration is currently disabled'
            });
        }

        // Get API key from header
        const apiKey = req.headers['x-api-key'];

        if (!apiKey) {
            return res.status(401).json({
                success: false,
                error: 'API key is required. Please provide X-API-Key header'
            });
        }

        // Validate API key
        const tpaContext = await TPAAuthService.validateApiKey(apiKey);

        if (!tpaContext) {
            logger.warn('Invalid API key attempt', { apiKey: apiKey.substring(0, 10) + '...' });
            return res.status(401).json({
                success: false,
                error: 'Invalid API key'
            });
        }

        // Check rate limit
        const rateLimitOk = TPAAuthService.checkRateLimit(
            tpaContext.id,
            tpaContext.rate_limit_per_minute
        );

        if (!rateLimitOk) {
            logger.warn('Rate limit exceeded', {
                clientId: tpaContext.client_id,
                clientName: tpaContext.client_name
            });
            return res.status(429).json({
                success: false,
                error: 'Rate limit exceeded. Please try again later'
            });
        }

        // Attach TPA context to request
        req.tpaContext = {
            id: tpaContext.id,
            client_id: tpaContext.client_id,
            client_name: tpaContext.client_name,
            client_code: tpaContext.client_code,
            short_code: tpaContext.short_code
        };

        logger.info('TPA authenticated', {
            clientId: tpaContext.client_id,
            clientName: tpaContext.client_name
        });

        next();
    } catch (error) {
        logger.error('TPA authentication error', { error: error.message });
        return res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
};

module.exports = authenticateTPA;
