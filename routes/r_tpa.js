/**
 * TPA Integration Routes
 * API endpoints for third-party administrator integrations
 */

const express = require('express');
const router = express.Router();
const logger = require('../lib/logger');
const authenticateTPA = require('../middleware/tpaAuth');
const { TPAAuthService, TPAMappingService, TPAAppointmentService } = require('../services/tpa');


/**
 * Health check endpoint
 */
router.get('/health', authenticateTPA, (req, res) => {
    res.json({
        success: true,
        message: 'TPA API is healthy',
        tpa: req.tpaContext.client_name,
        timestamp: new Date().toISOString()
    });
});

/**
 * Get TPA's mapped insurers
 */
router.get('/insurers', authenticateTPA, async (req, res) => {
    try {
        const { tpaContext } = req;
        const insurers = await TPAAppointmentService.getTPAInsurers(tpaContext.client_id);

        res.json({
            success: true,
            message: 'Insurers retrieved successfully',
            data: insurers
        });

    } catch (error) {
        logger.error('Error getting TPA insurers', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to get insurers'
        });
    }
});

/**
 * Get all active insurers (not limited to TPA mapping)
 */
router.get('/insurers/all', authenticateTPA, async (req, res) => {
    try {
        const insurers = await TPAAppointmentService.getAllActiveInsurers();

        res.json({
            success: true,
            message: 'All active insurers retrieved successfully',
            data: insurers
        });

    } catch (error) {
        logger.error('Error getting all active insurers', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to get insurers'
        });
    }
});

/**
 * Get insurer by ID (not limited to TPA mapping)
 */
router.get('/insurers/:id', authenticateTPA, async (req, res) => {
    try {
        const { id } = req.params;
        const insurer = await TPAAppointmentService.getInsurerById(id);

        if (!insurer) {
            return res.status(404).json({
                success: false,
                error: 'Insurer not found'
            });
        }

        res.json({
            success: true,
            message: 'Insurer retrieved successfully',
            data: insurer
        });

    } catch (error) {
        logger.error('Error getting insurer by ID', { error: error.message, insurerId: req.params.id });
        res.status(500).json({
            success: false,
            error: 'Failed to get insurer'
        });
    }
});

/**
 * Get diagnostic centers for TPA integrations
 * Supports simple search and pincode filtering without pagination
 */
router.get('/centers', authenticateTPA, async (req, res) => {
    try {
        const search = (req.query.search || req.query.q || '').trim();
        const pincode = (req.query.pincode || '').trim();

        const centers = await TPAMappingService.getDiagnosticCenters({ search, pincode });

        res.json({
            success: true,
            message: 'Diagnostic centers retrieved successfully',
            data: centers.map((center) => ({
                id: center.id,
                center_name: center.center_name,
                address: center.address,
                owner_name: center.owner_name,
                city: center.city,
                state: center.state,
                pincode: center.pincode,
                country: center.country
            }))
        });
    } catch (error) {
        logger.error('Error getting diagnostic centers', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to get diagnostic centers'
        });
    }
});

/**
 * Get tests and categories by insurer ID (TPA auto-detected)
 */
router.get('/tests-categories/:insurerId', authenticateTPA, async (req, res) => {
    try {
        const { tpaContext } = req;
        const { insurerId } = req.params;

        const data = await TPAAppointmentService.getTestsAndCategoriesByInsurer(
            tpaContext.client_id,
            insurerId
        );

        // Remove rates from response
        const testsWithoutRate = data.tests.map(test => {
            const { rate, ...testWithoutRate } = test;
            return testWithoutRate;
        });

        const categoriesWithoutRate = data.categories.map(category => {
            const { rate, ...categoryWithoutRate } = category;
            return categoryWithoutRate;
        });

        // Create combined array - type field differentiates test vs category
        const combined = [
            ...testsWithoutRate,
            ...categoriesWithoutRate
        ].sort((a, b) => a.name.localeCompare(b.name));

        res.json({
            success: true,
            message: 'Success',
            data: {
                tests: testsWithoutRate,
                categories: categoriesWithoutRate,
                combined: combined
            }
        });

    } catch (error) {
        logger.error('Error getting tests by insurer', { error: error.message });
        
        if (error.message.includes('Valid insurer ID is required')) {
            return res.status(400).json({
                success: false,
                error: error.message
            });
        }
        
        if (error.message.includes('Insurer not found')) {
            return res.status(404).json({
                success: false,
                error: error.message
            });
        }

        if (error.message.includes('Insurer is not mapped to this TPA client')) {
            return res.status(403).json({
                success: false,
                error: error.message
            });
        }
        
        res.status(500).json({
            success: false,
            error: 'Failed to get tests and categories'
        });
    }
});

/**
 * Get test categories (with optional insurer and center filtering)
 * If no insurer_name is provided, returns ALL tests and categories
 */
router.get('/tests-categories', authenticateTPA, async (req, res) => {
    try {
        const { tpaContext } = req;
        const { insurer_name, center_name } = req.query;

        // If no insurer filter, return all tests and categories
        if (!insurer_name && !center_name) {
            const allData = await TPAAppointmentService.getAllTestsAndCategories();
            
            // Remove rates from response
            const testsWithoutRate = allData.tests.map(test => {
                const { rate, ...testWithoutRate } = test;
                return testWithoutRate;
            });

            const categoriesWithoutRate = allData.categories.map(category => {
                const { rate, ...categoryWithoutRate } = category;
                return categoryWithoutRate;
            });

            const allDataWithoutRates = {
                tests: testsWithoutRate,
                categories: categoriesWithoutRate,
                combined: [...testsWithoutRate, ...categoriesWithoutRate]
            };
            
            res.json({
                success: true,
                message: 'Success',
                data: allDataWithoutRates
            });
            return;
        }

        // Otherwise, apply filters
        let insurerId = null;
        let centerId = null;

        if (insurer_name) {
            try {
                const insurer = await TPAMappingService.findInsurer(insurer_name);
                if (insurer) {
                    insurerId = insurer.id;
                }
            } catch (error) {
                logger.warn('Insurer lookup failed', { insurer_name, error: error.message });
            }
        }

        if (center_name) {
            try {
                const center = await TPAMappingService.findDiagnosticCenter(center_name);
                if (center) {
                    centerId = center.id;
                }
            } catch (error) {
                logger.warn('Center lookup failed', { center_name, error: error.message });
            }
        }

        const categories = await TPAAppointmentService.getTestCategories(
            tpaContext.client_id,
            insurerId,
            centerId
        );

        res.json({
            success: true,
            message: insurerId ? 'Tests and categories retrieved for insurer' : 'Tests and categories retrieved',
            data: categories
        });

    } catch (error) {
        logger.error('Error getting test categories', { error: error.message });
        res.status(500).json({
            success: false,
            error: 'Failed to get test categories'
        });
    }
});

/**
 * Create appointment(s) - handles both single and bulk
 */
router.post('/appointments', authenticateTPA, async (req, res) => {
    try {
        logger.info('[TPA ROUTE] Creating appointment', { 
            applicationNumber: req.body.application_number,
            testsCount: req.body.tests?.length || 0,
            categoriesCount: req.body.categories?.length || 0
        });
        
        const { tpaContext } = req;
        const body = req.body;

        // Check if bulk or single
        const isBulk = Array.isArray(body.appointments);
        const appointments = isBulk ? body.appointments : [body];

        // Validate appointments
        const validationErrors = [];
        appointments.forEach((apt, index) => {
            const errors = TPAAppointmentService.validateAppointmentData(apt);
            if (errors.length > 0) {
                validationErrors.push({
                    index,
                    case_number: apt.case_number,
                    errors
                });
            }
        });

        if (validationErrors.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'Validation failed',
                validation_errors: validationErrors
            });
        }

        // Process appointments
        let result;
        if (isBulk) {
            result = await TPAAppointmentService.createBulkAppointments(
                appointments,
                tpaContext
            );
        } else {
            const singleResult = await TPAAppointmentService.createAppointment(
                appointments[0],
                tpaContext.client_id
            );
            result = {
                success: [singleResult],
                failed: []
            };
        }

        logger.info('TPA appointments created', {
            clientId: tpaContext.client_id,
            total: appointments.length,
            success: result.success.length,
            failed: result.failed.length
        });

        res.status(201).json({
            success: true,
            message: isBulk ? 'Bulk appointments processed' : 'Appointment created',
            data: result
        });

    } catch (error) {
        const statusCode = error.statusCode && Number.isInteger(error.statusCode)
            ? error.statusCode
            : 500;

        logger.error('Error creating TPA appointments', {
            error: error.message,
            clientId: req.tpaContext?.client_id
        });
        res.status(statusCode).json({
            success: false,
            error: 'Failed to create appointments',
            message: error.message
        });
    }
});

/**
 * Log call activity
 */
router.post('/calls', authenticateTPA, async (req, res) => {
    try {
        const { tpaContext } = req;
        const {
            case_number,
            appointment_number,
            call_type,
            call_status,
            timestamp,
            duration,
            outcome,
            device_type,
            notes
        } = req.body;

        // Validate required fields
        if (!case_number) {
            return res.status(400).json({
                success: false,
                error: 'case_number is required'
            });
        }

        // Log call activity (you can extend this to store in database if needed)
        logger.info('TPA call activity logged', {
            clientId: tpaContext.client_id,
            caseNumber: case_number,
            appointmentNumber: appointment_number,
            callType: call_type,
            callStatus: call_status,
            timestamp,
            duration,
            outcome
        });

        res.json({
            success: true,
            message: 'Call activity logged successfully',
            data: {
                case_number,
                timestamp: timestamp || new Date().toISOString()
            }
        });

    } catch (error) {
        logger.error('Error logging call activity', {
            error: error.message,
            clientId: req.tpaContext?.client_id
        });
        res.status(500).json({
            success: false,
            error: 'Failed to log call activity',
            message: error.message
        });
    }
});

/**
 * Configure webhook URL
 */
router.post('/webhooks/configure', authenticateTPA, async (req, res) => {
    try {
        const { tpaContext } = req;
        const { webhook_url, auth_method, auth_credentials } = req.body;

        if (!webhook_url) {
            return res.status(400).json({
                success: false,
                error: 'webhook_url is required'
            });
        }

        // Update webhook configuration
        const db = require('../lib/dbconnection');
        await db.query(
            `UPDATE tpa_api_keys 
             SET webhook_url = ?, webhook_auth_method = ?, webhook_auth_credentials = ?
             WHERE id = ?`,
            [
                webhook_url,
                auth_method || 'none',
                auth_credentials || null,
                tpaContext.id
            ]
        );

        logger.info('Webhook configured', {
            clientId: tpaContext.client_id,
            webhookUrl: webhook_url
        });

        res.json({
            success: true,
            message: 'Webhook configured successfully',
            data: {
                webhook_url,
                auth_method: auth_method || 'none'
            }
        });

    } catch (error) {
        logger.error('Error configuring webhook', {
            error: error.message,
            clientId: req.tpaContext?.client_id
        });
        res.status(500).json({
            success: false,
            error: 'Failed to configure webhook',
            message: error.message
        });
    }
});



module.exports = router;
