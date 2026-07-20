/**
 * TPA Management Validation Schemas
 */

const Joi = require('joi');

// Create TPA schema
const createTPASchema = Joi.object({
    client_id: Joi.number().integer().required(),
    api_key: Joi.string().optional().allow(''),
    webhook_url: Joi.string().pattern(/^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/).optional().allow('', null),
    webhook_auth_method: Joi.string().valid('none', 'api_key', 'basic_auth').default('none'),
    webhook_auth_credentials: Joi.string().optional().allow('', null),
    webhook_custom_headers: Joi.string().optional().allow('', null),
    is_active: Joi.boolean().default(true),
    rate_limit_per_minute: Joi.number().integer().min(1).max(1000).default(100)
});

// Update TPA schema
const updateTPASchema = Joi.object({
    webhook_url: Joi.string().pattern(/^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/).optional().allow('', null),
    webhook_auth_method: Joi.string().valid('none', 'api_key', 'basic_auth').optional(),
    webhook_auth_credentials: Joi.string().optional().allow('', null),
    webhook_custom_headers: Joi.string().optional().allow('', null),
    is_active: Joi.boolean().optional(),
    rate_limit_per_minute: Joi.number().integer().min(1).max(1000).optional()
}).min(1);

module.exports = {
    createTPASchema,
    updateTPASchema
};
