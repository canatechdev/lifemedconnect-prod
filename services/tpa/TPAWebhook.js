/**
 * TPA Webhook Service
 * Handles sending webhooks to TPA systems with retry logic
 */

const axios = require('axios');
const crypto = require('crypto');
const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

const WEBHOOK_STATUS_PATH = '/webhook/statusUpdate'; 
const DEFAULT_DC_NAME_HEADER = 'dcName';
const DEFAULT_DC_NAME_VALUE = 'lifemed';

function normalizeWebhookUrl(rawWebhookUrl) {
    const parsedUrl = new URL(String(rawWebhookUrl).trim());

    // Keep an explicitly configured path exactly as provided.
    // Only append the default status path when the config is just a base host/root URL.
    if (!parsedUrl.pathname || parsedUrl.pathname === '/') {
        parsedUrl.pathname = WEBHOOK_STATUS_PATH;
    }

    return parsedUrl.toString();
}

class TPAWebhookService {
    /**
     * Send webhook to TPA
     */
    static async sendWebhook(clientId, eventType, eventData) {
        try {
            // Check if TPA webhooks are enabled
            if (process.env.TPA_WEBHOOK_ENABLED !== 'true') {
                logger.info('TPA webhooks disabled, skipping', { eventType });
                return;
            }

            // Validate inputs
            if (!clientId || !eventType || !eventData) {
                logger.error('Invalid webhook parameters', { clientId, eventType, hasEventData: !!eventData });
                return;
            }

            // Validate clientId is a number
            if (typeof clientId !== 'number' || clientId <= 0) {
                logger.error('Invalid clientId format', { clientId, type: typeof clientId });
                return;
            }

            // Validate eventType
            if (typeof eventType !== 'string' || eventType.trim().length === 0) {
                logger.error('Invalid eventType format', { eventType, type: typeof eventType });
                return;
            }

            // Get TPA webhook configuration (must be active and not deleted)
            const tpaKeys = await db.query(
                `SELECT webhook_url, webhook_auth_method, webhook_auth_credentials, api_key
                 FROM tpa_api_keys
                 WHERE client_id = ? AND is_active = TRUE AND webhook_url IS NOT NULL AND deleted_at IS NULL`,
                [clientId]
            );

            if (tpaKeys.length === 0) {
                logger.info('No webhook configured for TPA', { clientId, eventType });
                return;
            }

            logger.info('[TPA-WH] Config found', { 
                clientId, 
                eventType, 
                configCount: tpaKeys.length
            });

            const tpaConfig = tpaKeys[0];
            
            if (!tpaConfig) {
                logger.error('[TPA-WH] Config undefined after query', { clientId, eventType });
                return;
            }

            logger.info('[TPA-WH] TPA Config', {
                clientId,
                authMethod: tpaConfig.webhook_auth_method,
                hasCredentials: !!tpaConfig.api_key,
                credentialsPreview: tpaConfig.api_key ? tpaConfig.api_key.substring(0, 12) + '...' : 'none'
            });

            if (!tpaConfig.webhook_url || typeof tpaConfig.webhook_url !== 'string') {
                logger.error('[TPA-WH] Invalid webhook URL', { clientId, webhookUrl: tpaConfig.webhook_url });
                return;
            }

            if (!tpaConfig.webhook_auth_method || !['api_key', 'basic_auth', 'none'].includes(tpaConfig.webhook_auth_method)) {
                logger.error('[TPA-WH] Invalid auth method', { clientId, authMethod: tpaConfig.webhook_auth_method });
                return;
            }

            try {
                tpaConfig.webhook_url = normalizeWebhookUrl(tpaConfig.webhook_url);
            } catch (urlError) {
                logger.error('[TPA-WH] Invalid webhook URL format', {
                    clientId,
                    webhookUrl: tpaConfig.webhook_url,
                    error: urlError.message
                });
                return;
            }

            // Use the normalized URL in config for delivery
            const deliveryConfig = { ...tpaConfig };

            const payload = this.buildWebhookPayload(eventType, eventData);

            logger.info('[TPA-WH] Sending webhook', {
                clientId,
                eventType,
                caseNumber: eventData.case_number,
                webhookUrl: deliveryConfig.webhook_url
            });

            // Send webhook
            await this.deliverWebhook(clientId, deliveryConfig, payload, eventType, eventData);

        } catch (error) {
            logger.error('[TPA-WH] Error in sendWebhook', {
                clientId,
                eventType,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Build webhook payload with HMAC signature for verification
     */
    static buildWebhookPayload(eventType, eventData) {
        const payload = {
            event_type: eventType,
            timestamp: new Date().toISOString(),
            case_number: eventData.case_number,
            application_number: eventData.application_number,
            data: eventData.data || {}
        };

        // Add HMAC signature so TPA can verify payload integrity
        const signatureBody = JSON.stringify({ event_type: payload.event_type, timestamp: payload.timestamp, case_number: payload.case_number });
        payload.signature = crypto.createHmac('sha256', process.env.TPA_WEBHOOK_SECRET || 'tpa-webhook-default-secret').update(signatureBody).digest('hex');

        return payload;
    }

    /**
     * Deliver webhook with retry logic
     */
    static async deliverWebhook(clientId, tpaConfig, payload, eventType, eventData) {
        const headers = {
            'Content-Type': 'application/json',
            [DEFAULT_DC_NAME_HEADER]: DEFAULT_DC_NAME_VALUE
        };

        // Add authentication based on method
        logger.info('[TPA-WH] Setting up auth', {
            authMethod: tpaConfig.webhook_auth_method,
            hasCredentials: !!tpaConfig.api_key
        });

        if (tpaConfig.webhook_auth_method === 'api_key' && tpaConfig.api_key) {
            headers['X-API-Key'] = tpaConfig.api_key;
            logger.info('[TPA-WH] Added X-API-Key header');
        } else if (tpaConfig.webhook_auth_method === 'basic_auth' && tpaConfig.webhook_auth_credentials) {
            headers['Authorization'] = `Basic ${tpaConfig.webhook_auth_credentials}`;
            logger.info('[TPA-WH] Added Authorization header');
        } else {
            logger.warn('[TPA-WH] No auth headers added', {
                authMethod: tpaConfig.webhook_auth_method,
                hasCredentials: !!tpaConfig.api_key
            });
        }

        logger.info('[TPA-WH] Final outbound headers', {
            headerKeys: Object.keys(headers),
            dcName: headers[DEFAULT_DC_NAME_HEADER]
        });

        let logId = null;

        try {
            // Log webhook attempt
            const logResult = await db.query(
                `INSERT INTO tpa_webhook_logs 
                 (client_id, event_type, case_number, appointment_number, webhook_url, request_payload, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                [clientId, eventType, eventData.case_number, eventData.application_number, tpaConfig.webhook_url, JSON.stringify(payload)]
            );
            logId = logResult.insertId;

            // Send webhook
            logger.info('[TPA-WH] Delivering to URL', { url: tpaConfig.webhook_url, eventType, caseNumber: eventData.case_number });

            const response = await axios.post(tpaConfig.webhook_url, payload, {
                headers,
                timeout: 10000
            });

            // Update log with success
            await db.query(
                `UPDATE tpa_webhook_logs 
                 SET status = 'success', response_status = ?, response_body = ?
                 WHERE id = ?`,
                [response.status, JSON.stringify(response.data), logId]
            );

            logger.info('[TPA-WH] Delivered successfully', {
                clientId,
                eventType,
                caseNumber: eventData.case_number,
                httpStatus: response.status
            });

        } catch (error) {
            // Update log with failure
            if (logId) {
                await db.query(
                    `UPDATE tpa_webhook_logs 
                     SET status = 'failed', response_status = ?, response_body = ?, 
                         retry_count = retry_count + 1, next_retry_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)
                     WHERE id = ?`,
                    [error.response?.status || 0, error.message, logId]
                );
            }

            logger.error('[TPA-WH] Delivery failed', {
                clientId,
                eventType,
                caseNumber: eventData.case_number,
                error: error.message,
                httpStatus: error.response?.status,
                responseData: error.response?.data
            });

            // Schedule retry if less than 3 attempts
            await this.scheduleRetry(logId, clientId, tpaConfig, payload, eventType, eventData);
        }
    }

    /**
     * Schedule webhook retry
     */
    static async scheduleRetry(logId, clientId, tpaConfig, payload, eventType, eventData) {
        try {
            const logs = await db.query(
                `SELECT retry_count FROM tpa_webhook_logs WHERE id = ?`,
                [logId]
            );

            if (logs.length > 0 && logs[0].retry_count < 3) {
                // Retry after 5 minutes
                setTimeout(() => {
                    this.deliverWebhook(clientId, tpaConfig, payload, eventType, eventData);
                }, 5 * 60 * 1000);

                logger.info('Webhook retry scheduled', {
                    logId,
                    retryCount: logs[0].retry_count,
                    nextRetryIn: '5 minutes'
                });
            } else {
                logger.warn('Webhook max retries reached', { logId });
            }
        } catch (error) {
            logger.error('Error scheduling webhook retry', { error: error.message });
        }
    }

    /**
     * Send pre-built event data to TPA webhook
     * @param {number} clientId - TPA client ID
     * @param {string} eventType - Event type (e.g. appointment_confirmed)
     * @param {object} eventData - Pre-built event data from tpaWebhookHelper { case_number, application_number, data: {...} }
     */
    static async sendEvent(clientId, eventType, eventData) {
        await this.sendWebhook(clientId, eventType, eventData);
    }
}

module.exports = TPAWebhookService;
