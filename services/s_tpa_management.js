/**
 * TPA Management Service
 * Handles CRUD operations for TPA API keys and configurations
 */

const db = require('../lib/dbconnection');
const logger = require('../lib/logger');
const crypto = require('crypto');

class TPAManagementService {
    /**
     * Get all TPA configurations
     */
    static async getAllTPAs(filters = {}) {
        try {
            let query = `
                SELECT 
                    t.id,
                    t.client_id,
                    c.client_name,
                    c.client_code,
                    t.api_key,
                    t.webhook_url,
                    t.webhook_auth_method,
                    t.is_active,
                    t.rate_limit_per_minute,
                    t.created_at,
                    t.updated_at,
                    u.username as created_by_name
                FROM tpa_api_keys t
                LEFT JOIN clients c ON t.client_id = c.id
                LEFT JOIN users u ON t.created_by = u.id
                WHERE t.deleted_at IS NULL
            `;

            const params = [];

            if (filters.is_active !== undefined) {
                query += ' AND t.is_active = ?';
                params.push(filters.is_active);
            }

            if (filters.client_id) {
                query += ' AND t.client_id = ?';
                params.push(filters.client_id);
            }

            query += ' ORDER BY t.created_at DESC';

            const tpas = await db.query(query, params);

            // Mask API keys for security (show only last 8 characters)
            return tpas.map(tpa => ({
                ...tpa,
                api_key_masked: this.maskApiKey(tpa.api_key),
                webhook_auth_credentials: tpa.webhook_auth_method === 'none' ? null : '***masked***'
            }));

        } catch (error) {
            logger.error('Error getting TPAs', { error: error.message });
            throw error;
        }
    }

    /**
     * Get single TPA by ID
     */
    static async getTPAById(id) {
        try {
            const tpas = await db.query(`
                SELECT 
                    t.*,
                    c.client_name,
                    c.client_code,
                    u.username as created_by_name
                FROM tpa_api_keys t
                LEFT JOIN clients c ON t.client_id = c.id
                LEFT JOIN users u ON t.created_by = u.id
                WHERE t.id = ? AND t.deleted_at IS NULL
            `, [id]);

            if (tpas.length === 0) {
                throw new Error('TPA configuration not found');
            }

            return tpas[0];

        } catch (error) {
            logger.error('Error getting TPA by ID', { id, error: error.message });
            throw error;
        }
    }

    /**
     * Create new TPA configuration
     */
    static async createTPA(data, userId) {
        try {
            // Generate API key if not provided
            const apiKey = data.api_key || this.generateApiKey(data.client_name);

            // Validate client exists
            const clients = await db.query('SELECT id, client_name FROM clients WHERE id = ?', [data.client_id]);
            if (clients.length === 0) {
                throw new Error('Client not found');
            }

            // Check if API key already exists
            const existing = await db.query('SELECT id FROM tpa_api_keys WHERE api_key = ?', [apiKey]);
            if (existing.length > 0) {
                throw new Error('API key already exists');
            }

            const result = await db.query(`
                INSERT INTO tpa_api_keys (
                    client_id,
                    api_key,
                    webhook_url,
                    webhook_auth_method,
                    webhook_auth_credentials,
                    is_active,
                    rate_limit_per_minute,
                    created_by,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            `, [
                data.client_id,
                apiKey,
                data.webhook_url || null,
                data.webhook_auth_method === 'api_key' || data.webhook_auth_method === 'basic_auth' ? data.webhook_auth_method : 'none',
                data.webhook_auth_credentials || null,
                data.is_active !== undefined ? data.is_active : 1,
                data.rate_limit_per_minute || 100,
                userId
            ]);

            logger.info('TPA configuration created', {
                id: result.insertId,
                clientId: data.client_id,
                userId
            });

            return {
                id: result.insertId,
                api_key: apiKey,
                ...data
            };

        } catch (error) {
            logger.error('Error creating TPA', { error: error.message, data });
            throw error;
        }
    }

    /**
     * Update TPA configuration
     */
    static async updateTPA(id, data, userId) {
        try {
            // Check if TPA exists
            const existing = await this.getTPAById(id);

            const updates = [];
            const values = [];

            if (data.webhook_url !== undefined) {
                updates.push('webhook_url = ?');
                values.push(data.webhook_url);
            }

            if (data.webhook_auth_method !== undefined) {
                updates.push('webhook_auth_method = ?');
                values.push(data.webhook_auth_method);
            }

            if (data.webhook_auth_credentials !== undefined) {
                updates.push('webhook_auth_credentials = ?');
                values.push(data.webhook_auth_credentials);
            }

            if (data.is_active !== undefined) {
                updates.push('is_active = ?');
                values.push(data.is_active);
            }

            if (data.rate_limit_per_minute !== undefined) {
                updates.push('rate_limit_per_minute = ?');
                values.push(data.rate_limit_per_minute);
            }

            if (updates.length === 0) {
                throw new Error('No fields to update');
            }

            updates.push('updated_at = NOW()');
            values.push(id);

            await db.query(`
                UPDATE tpa_api_keys 
                SET ${updates.join(', ')}
                WHERE id = ?
            `, values);

            logger.info('TPA configuration updated', { id, userId, updates: Object.keys(data) });

            return await this.getTPAById(id);

        } catch (error) {
            logger.error('Error updating TPA', { id, error: error.message, data });
            throw error;
        }
    }

    /**
     * Delete TPA configuration
     */
    static async deleteTPA(id, userId) {
        try {
            // Check if TPA exists
            await this.getTPAById(id);

            await db.query('UPDATE tpa_api_keys SET deleted_at = NOW(), updated_at = NOW() WHERE id = ?', [id]);

            logger.info('TPA configuration deleted', { id, userId });

            return { success: true, message: 'TPA configuration deleted successfully' };

        } catch (error) {
            logger.error('Error deleting TPA', { id, error: error.message });
            throw error;
        }
    }
    
    /**
     * Toggle TPA active status
     */
    static async toggleTPAStatus(id, userId) {
        try {
            const tpa = await this.getTPAById(id);

            await db.query(`
                UPDATE tpa_api_keys 
                SET is_active = ?, updated_at = NOW()
                WHERE id = ?
            `, [tpa.is_active ? 0 : 1, id]);

            logger.info('TPA status toggled', { id, userId, newStatus: !tpa.is_active });

            return await this.getTPAById(id);

        } catch (error) {
            logger.error('Error toggling TPA status', { id, error: error.message });
            throw error;
        }
    }

    /**
     * Regenerate API key
     */
    static async regenerateApiKey(id, userId) {
        try {
            const tpa = await this.getTPAById(id);
            const newApiKey = this.generateApiKey(tpa.client_name);

            await db.query(`
                UPDATE tpa_api_keys 
                SET api_key = ?, updated_at = NOW()
                WHERE id = ?
            `, [newApiKey, id]);

            logger.info('TPA API key regenerated', { id, userId });

            return {
                id,
                api_key: newApiKey
            };

        } catch (error) {
            logger.error('Error regenerating API key', { id, error: error.message });
            throw error;
        }
    }

    /**
     * Get available clients for TPA mapping
     */
    static async getAvailableClients() {
        try {
            const clients = await db.query(`
                SELECT 
                    c.id,
                    c.client_name,
                    c.client_code,
                    c.short_code,
                    CASE WHEN t.id IS NOT NULL THEN 1 ELSE 0 END as has_tpa
                FROM clients c
                LEFT JOIN tpa_api_keys t ON c.id = t.client_id AND t.deleted_at IS NULL
                WHERE c.is_active = 1 AND c.is_deleted = 0
                ORDER BY c.client_name
            `);

            return clients;

        } catch (error) {
            logger.error('Error getting available clients', { error: error.message });
            throw error;
        }
    }

    /**
     * Generate API key
     */
    static generateApiKey(clientName = 'tpa') {
        const prefix = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 10);
        const random = crypto.randomBytes(16).toString('hex');
        return `${prefix}-${random}`;
    }

    /**
     * Mask API key for display
     */
    static maskApiKey(apiKey) {
        if (!apiKey || apiKey.length < 12) return '***masked***';
        return '...' + apiKey.slice(-8);
    }
}

module.exports = TPAManagementService;
