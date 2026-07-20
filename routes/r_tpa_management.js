/**
 * TPA Management Routes
 * Admin routes for managing TPA configurations
 */

const express = require('express');
const router = express.Router();
const TPAManagementService = require('../services/s_tpa_management');
const { verifyToken } = require('../lib/auth');
const { requirePermission } = require('../lib/permissions');
const logger = require('../lib/logger');

// Validation schemas (for future use if validator middleware is available)
const { createTPASchema, updateTPASchema } = require('../validation/v_tpa_management');

/**
 * Get all TPA configurations
 */
router.get('/', verifyToken, requirePermission('tpa_management.view'), async (req, res) => {
    try {
        const filters = {
            is_active: req.query.is_active,
            client_id: req.query.client_id
        };

        const tpas = await TPAManagementService.getAllTPAs(filters);

        res.json({
            success: true,
            message: 'TPAs retrieved successfully',
            data: tpas
        });

    } catch (error) {
        logger.error('Error getting TPAs', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve TPAs',
            message: error.message
        });
    }
});

/**
 * Get single TPA by ID
 */
router.get('/:id', verifyToken, requirePermission('tpa_management.view'), async (req, res) => {
    try {
        const tpa = await TPAManagementService.getTPAById(req.params.id);

        res.json({
            success: true,
            message: 'TPA retrieved successfully',
            data: tpa
        });

    } catch (error) {
        logger.error('Error getting TPA', { id: req.params.id, error: error.message });
        res.status(error.message.includes('not found') ? 404 : 500).json({
            success: false,
            error: 'Failed to retrieve TPA',
            message: error.message
        });
    }
});

/**
 * Get available clients for TPA mapping
 */
router.get('/clients/available', verifyToken, async (req, res) => {
    try {
        const clients = await TPAManagementService.getAvailableClients();

        res.json({
            success: true,
            message: 'Clients retrieved successfully',
            data: clients
        });

    } catch (error) {
        logger.error('Error getting available clients', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to retrieve clients',
            message: error.message
        });
    }
});

/**
 * Create new TPA configuration
 */
router.post('/', verifyToken, requirePermission('tpa_management.create'), async (req, res) => {
    try {
        const tpa = await TPAManagementService.createTPA(req.body, req.user.id);

        res.status(201).json({
            success: true,
            message: 'TPA configuration created successfully',
            data: tpa
        });

    } catch (error) {
        logger.error('Error creating TPA', { error: error.message, userId: req.user.id });
        res.status(error.message.includes('already exists') ? 409 : 500).json({
            success: false,
            error: 'Failed to create TPA',
            message: error.message
        });
    }
});

/**
 * Update TPA configuration
 */
router.put('/:id', verifyToken, requirePermission('tpa_management.update'), async (req, res) => {
    try {
        const tpa = await TPAManagementService.updateTPA(req.params.id, req.body, req.user.id);

        res.json({
            success: true,
            message: 'TPA configuration updated successfully',
            data: tpa
        });

    } catch (error) {
        logger.error('Error updating TPA', { id: req.params.id, error: error.message });
        res.status(error.message.includes('not found') ? 404 : 500).json({
            success: false,
            error: 'Failed to update TPA',
            message: error.message
        });
    }
});

/**
 * Delete TPA configuration
 */
router.delete('/:id', verifyToken, requirePermission('tpa_management.delete'), async (req, res) => {
    try {
        const result = await TPAManagementService.deleteTPA(req.params.id, req.user.id);

        res.json({
            success: true,
            message: 'TPA configuration deleted successfully',
            data: result
        });

    } catch (error) {
        logger.error('Error deleting TPA', { id: req.params.id, error: error.message });
        res.status(error.message.includes('not found') ? 404 : 500).json({
            success: false,
            error: 'Failed to delete TPA',
            message: error.message
        });
    }
});

/**
 * Toggle TPA active status
 */
router.patch('/:id/toggle-status', verifyToken, requirePermission('tpa_management.toggle_status'), async (req, res) => {
    try {
        const tpa = await TPAManagementService.toggleTPAStatus(req.params.id, req.user.id);

        res.json({
            success: true,
            message: 'TPA status toggled successfully',
            data: tpa
        });

    } catch (error) {
        logger.error('Error toggling TPA status', { id: req.params.id, error: error.message });
        res.status(error.message.includes('not found') ? 404 : 500).json({
            success: false,
            error: 'Failed to toggle TPA status',
            message: error.message
        });
    }
});

/**
 * Regenerate API key
 */
router.post('/:id/regenerate-key', verifyToken, requirePermission('tpa_management.regenerate_key'), async (req, res) => {
    try {
        const result = await TPAManagementService.regenerateApiKey(req.params.id, req.user.id);

        res.json({
            success: true,
            message: 'API key regenerated successfully',
            data: result
        });

    } catch (error) {
        logger.error('Error regenerating API key', { id: req.params.id, error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to regenerate API key',
            message: error.message
        });
    }
});

module.exports = router;
