/**
 * TPA Appointment Service
 * Handles appointment creation from TPA integrations
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const TPAMappingService = require('./TPAMapping');
const { createAppointment } = require('../appointments/AppointmentCRUD');

class TPAAppointmentService {
    /**
     * Create single appointment from TPA
     */
    static async createAppointment(appointmentData, clientId) {
        try {
            logger.info('[TPA APPOINTMENT] Creating appointment', { 
                applicationNumber: appointmentData.application_number,
                testsCount: appointmentData.tests?.length || 0,
                categoriesCount: appointmentData.categories?.length || 0
            });
            
            // Map TPA data to internal format
            const mappedData = await TPAMappingService.mapAppointmentData(appointmentData, clientId);
            
            // Add created_by for audit trail
            mappedData.created_by = null; // TPA system creates these

            // Use standard appointment creation function
            const result = await createAppointment(mappedData);

            logger.info('TPA appointment created', {
                appointmentId: result,
                caseNumber: mappedData.case_number,
                clientId,
                selectedItemsCount: mappedData.selected_items?.length || 0
            });

            return {
                success: true,
                appointment_id: result,
                case_number: mappedData.case_number,
                application_number: mappedData.application_number
            };
        } catch (error) {
            logger.error('Error creating TPA appointment', {
                error: error.message,
                appointmentData
            });
            throw error;
        }
    }

    /**
     * Create bulk appointments with enhanced safety
     */
    static async createBulkAppointments(appointments, tpaContext) {
        const results = {
            success: [],
            failed: []
        };

        // First, validate all appointments before creating any
        const validationResults = [];
        for (let i = 0; i < appointments.length; i++) {
            const appointmentData = appointments[i];
            const appointmentNumber = appointmentData.application_number || appointmentData.applicantion_number || `APP-${i + 1}`;
            
            try {
                // Map the appointment data
                const mappedData = await TPAMappingService.mapAppointmentData(appointmentData, tpaContext.client_id);
                
                // Validate the mapped data
                const validationErrors = await this.validateAppointmentDataAsync(mappedData, tpaContext.client_id);
                
                if (validationErrors.length > 0) {
                    validationResults.push({
                        index: i,
                        appointment_number: appointmentNumber,
                        success: false,
                        errors: validationErrors
                    });
                } else {
                    validationResults.push({
                        index: i,
                        appointment_number: appointmentNumber,
                        success: true,
                        mappedData: mappedData
                    });
                }
            } catch (error) {
                validationResults.push({
                    index: i,
                    appointment_number: appointmentNumber,
                    success: false,
                    errors: [`Mapping error: ${error.message}`]
                });
            }
        }

        // If any validation failed, return all errors without creating any appointments
        const failedValidations = validationResults.filter(r => !r.success);
        if (failedValidations.length > 0) {
            return {
                success: [],
                failed: failedValidations.map(r => ({
                    appointment_number: r.appointment_number,
                    error: 'Validation failed',
                    validation_errors: r.errors
                }))
            };
        }

        // All validations passed, now create all appointments
        for (const validation of validationResults) {
            try {
                validation.mappedData.created_by = null;
                const result = await createAppointment(validation.mappedData);
                results.success.push({
                    success: true,
                    appointment_id: result,
                    case_number: validation.mappedData.case_number,
                    application_number: validation.mappedData.application_number,
                    appointment_number: validation.appointment_number
                });
            } catch (error) {
                results.failed.push({
                    appointment_number: validation.appointment_number,
                    error: 'Database insertion failed',
                    details: error.message
                });
            }
        }

        logger.info('TPA bulk appointments processed', {
            total: appointments.length,
            success: results.success.length,
            failed: results.failed.length,
            clientId: tpaContext.client_id
        });

        return results;
    }

    /**
     * Get test categories for TPA
     */
    static async getTestCategories(clientId, insurerId = null, centerId = null) {
        try {
            if (!clientId || isNaN(clientId)) {
                throw new Error('Valid client ID is required');
            }

            if (insurerId) {
                const insurerClientMapping = await db.query(
                    'SELECT insurer_id FROM client_insurers WHERE client_id = ? AND insurer_id = ? LIMIT 1',
                    [clientId, insurerId]
                );

                if (insurerClientMapping.length === 0) {
                    throw new Error('Insurer is not mapped to this TPA client');
                }
            }

            // First get categories
            let categoryQuery = `
                SELECT 
                    tc.id as category_id,
                    tc.category_name,
                    tc.description
                FROM test_categories tc
                WHERE tc.is_active = 1 AND tc.is_deleted = 0
            `;
            
            const categoryParams = [];
            
            if (insurerId) {
                categoryQuery += ` AND EXISTS (
                    SELECT 1 FROM bulk_test_rates btr 
                    WHERE btr.category_id = tc.id AND btr.client_id = ? AND btr.insurer_id = ? AND btr.item_type = 'category'
                )`;
                categoryParams.push(clientId, insurerId);
            }
            
            categoryQuery += ' ORDER BY tc.category_name';
            
            const categoryRows = await db.query(categoryQuery, categoryParams);
            
            // Build categories object
            const categories = {};
            categoryRows.forEach(row => {
                categories[row.category_id] = {
                    category_id: row.category_id,
                    category_name: row.category_name,
                    description: row.description,
                    tests: []
                };
            });
            
            // Now try to get tests for these categories (if possible)
            try {
                if (Object.keys(categories).length > 0) {
                    const testQuery = `
                        SELECT 
                            t.id as test_id,
                            t.test_name,
                            t.test_code,
                            t.description as test_description,
                            t.test_category_id
                        FROM tests t
                        WHERE t.test_category_id IN (${Object.keys(categories).join(',')})
                        AND t.is_active = 1 AND t.is_deleted = 0
                        ORDER BY t.test_name
                    `;
                    
                    const testRows = await db.query(testQuery);
                    
                    testRows.forEach(row => {
                        if (categories[row.test_category_id]) {
                            categories[row.test_category_id].tests.push({
                                test_id: row.test_id,
                                test_name: row.test_name,
                                test_code: row.test_code,
                                description: row.test_description
                            });
                        }
                    });
                }
            } catch (testError) {
                // If tests query fails, just return categories without tests
                logger.warn('Could not fetch tests, returning categories only', { error: testError.message });
            }
            
            return Object.values(categories);
        } catch (error) {
            logger.error('Error getting test categories', { error: error.message });
            throw error;
        }
    }

    /**
     * Validate appointment data (synchronous version)
     */
    static validateAppointmentData(data) {
        const errors = [];

        // Basic field validations
        const requiredFields = [
            'customer_first_name',
            'customer_last_name', 
            'customer_mobile',
            'appointment_date',
            'appointment_time'
        ];

        requiredFields.forEach(field => {
            if (!data[field] || data[field].toString().trim() === '') {
                errors.push(`${field} is required`);
            }
        });

        // Validate mobile number format
        if (data.customer_mobile && !/^[6-9]\d{9}$/.test(data.customer_mobile)) {
            errors.push('customer_mobile must be a valid 10-digit mobile number starting with 6-9');
        }

        // Validate email format if provided
        if (data.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.customer_email)) {
            errors.push('customer_email must be a valid email address');
        }

        // Validate date format
        if (data.appointment_date && !/^\d{4}-\d{2}-\d{2}$/.test(data.appointment_date)) {
            errors.push('appointment_date must be in YYYY-MM-DD format');
        }

        // Validate time format
        if (data.appointment_time && !/^\d{2}:\d{2}:\d{2}$/.test(data.appointment_time)) {
            errors.push('appointment_time must be in HH:mm:ss format');
        }

        // Validate gender if provided
        const validGenders = ['Male', 'Female', 'Other'];
        if (data.customer_gender && !validGenders.includes(data.customer_gender)) {
            errors.push('customer_gender must be one of: Male, Female, Other');
        }

        return errors;
    }

    /**
     * Validate appointment data with enhanced safety (async)
     */
    static async validateAppointmentDataAsync(data, clientId) {
        const errors = [];

        // Basic field validations
        const requiredFields = [
            'customer_first_name',
            'customer_last_name', 
            'customer_mobile',
            'appointment_date',
            'appointment_time'
        ];

        requiredFields.forEach(field => {
            if (!data[field] || data[field].toString().trim() === '') {
                errors.push(`${field} is required`);
            }
        });

        // Validate mobile number format
        if (data.customer_mobile && !/^[6-9]\d{9}$/.test(data.customer_mobile)) {
            errors.push('customer_mobile must be a valid 10-digit mobile number starting with 6-9');
        }

        // Validate email format if provided
        if (data.customer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.customer_email)) {
            errors.push('customer_email must be a valid email address');
        }

        // Validate date format
        if (data.appointment_date && !/^\d{4}-\d{2}-\d{2}$/.test(data.appointment_date)) {
            errors.push('appointment_date must be in YYYY-MM-DD format');
        }

        // Validate time format
        if (data.appointment_time && !/^\d{2}:\d{2}:\d{2}$/.test(data.appointment_time)) {
            errors.push('appointment_time must be in HH:mm:ss format');
        }

        // Validate gender if provided
        const validGenders = ['Male', 'Female', 'Other'];
        if (data.customer_gender && !validGenders.includes(data.customer_gender)) {
            errors.push('customer_gender must be one of: Male, Female, Other');
        }

        // Validate insurer identification (either name or ID, not both)
        if (data.insurer_name && data.insurer_id) {
            errors.push('Provide either insurer_name OR insurer_id, not both');
        } else if (!data.insurer_name && !data.insurer_id) {
            errors.push('Either insurer_name or insurer_id is required');
        }

        // Validate tests and categories if provided (async validation)
        if (data.tests || data.categories) {
            const testValidation = await this.validateTestsAndCategories(data.tests, data.categories);
            if (testValidation.errors.length > 0) {
                errors.push(...testValidation.errors);
            }
        }

        return errors;
    }

    /**
     * Validate tests and categories with safety checks
     */
    static async validateTestsAndCategories(tests, categories) {
        const errors = [];
        const validatedItems = [];

        try {
            // Validate tests if provided
            if (tests && Array.isArray(tests)) {
                for (let i = 0; i < tests.length; i++) {
                    const test = tests[i];
                    
                    if (!test.test_id || isNaN(test.test_id)) {
                        errors.push(`tests[${i}].test_id must be a valid number`);
                        continue;
                    }

                    // Verify test exists and is active
                    const testCheck = await db.query(
                        'SELECT id, test_name FROM tests WHERE id = ? AND is_active = TRUE AND is_deleted = 0',
                        [test.test_id]
                    );

                    if (testCheck.length === 0) {
                        errors.push(`tests[${i}].test_id ${test.test_id} - Test not found or inactive`);
                        continue;
                    }

                    // Validate optional center_id
                    if (test.center_id !== undefined && test.center_id !== null && test.center_id !== '') {
                        if (isNaN(test.center_id) || test.center_id <= 0) {
                            errors.push(`tests[${i}].center_id must be a valid positive number`);
                        }
                    }

                    // Validate optional center_name
                    if (test.center_name !== undefined && test.center_name !== null && typeof test.center_name !== 'string') {
                        errors.push(`tests[${i}].center_name must be a string`);
                    }

                    // Validate optional visit_subtype
                    if (test.visit_subtype !== undefined && test.visit_subtype !== null) {
                        if (!['center', 'home'].includes(test.visit_subtype)) {
                            errors.push(`tests[${i}].visit_subtype must be either 'center' or 'home'`);
                        }
                    }

                    validatedItems.push({
                        type: 'test',
                        id: test.test_id,
                        name: testCheck[0].test_name
                    });
                }
            }

            // Validate categories if provided
            if (categories && Array.isArray(categories)) {
                for (let i = 0; i < categories.length; i++) {
                    const category = categories[i];
                    
                    if (!category.category_id || isNaN(category.category_id)) {
                        errors.push(`categories[${i}].category_id must be a valid number`);
                        continue;
                    }

                    // Verify category exists and is active
                    const categoryCheck = await db.query(
                        'SELECT id, category_name FROM test_categories WHERE id = ? AND is_active = TRUE AND is_deleted = 0',
                        [category.category_id]
                    );

                    if (categoryCheck.length === 0) {
                        errors.push(`categories[${i}].category_id ${category.category_id} - Category not found or inactive`);
                        continue;
                    }

                    // Validate optional center_id
                    if (category.center_id !== undefined && category.center_id !== null && category.center_id !== '') {
                        if (isNaN(category.center_id) || category.center_id <= 0) {
                            errors.push(`categories[${i}].center_id must be a valid positive number`);
                        }
                    }

                    // Validate optional center_name
                    if (category.center_name !== undefined && category.center_name !== null && typeof category.center_name !== 'string') {
                        errors.push(`categories[${i}].center_name must be a string`);
                    }

                    // Validate optional visit_subtype
                    if (category.visit_subtype !== undefined && category.visit_subtype !== null) {
                        if (!['center', 'home'].includes(category.visit_subtype)) {
                            errors.push(`categories[${i}].visit_subtype must be either 'center' or 'home'`);
                        }
                    }

                    validatedItems.push({
                        type: 'category',
                        id: category.category_id,
                        name: categoryCheck[0].category_name
                    });
                }
            }

        } catch (error) {
            errors.push('Error validating tests and categories: ' + error.message);
        }

        return { errors, validatedItems };
    }

    /**
     * Get all tests and categories (not filtered by insurer)
     */
    static async getAllTestsAndCategories() {
        try {
            // Get all active categories
            const categories = await db.query(`
                SELECT 
                    tc.id,
                    tc.category_name,
                    tc.description
                FROM test_categories tc
                WHERE tc.is_active = 1 AND tc.is_deleted = 0
                ORDER BY tc.category_name
            `);

            // Get all active tests
            const tests = await db.query(`
                SELECT 
                    t.id,
                    t.test_name,
                    t.test_code,
                    t.description as test_description
                FROM tests t
                WHERE t.is_active = 1 AND t.is_deleted = 0
                ORDER BY t.test_name
            `);

            // Format categories array
            const formattedCategories = categories.map(category => ({
                id: category.id,
                name: category.category_name,
                type: 'category'
                // No rate for categories
            }));

            // Format tests array
            const formattedTests = tests.map(test => ({
                id: test.id,
                name: test.test_name,
                type: 'test'
                // No rate for tests
            }));

            // Create combined array
            const combined = [
                ...formattedTests,
                ...formattedCategories
            ];

            return {
                tests: formattedTests,
                categories: formattedCategories,
                combined: combined
            };
        } catch (error) {
            logger.error('Error getting all tests and categories', { error: error.message });
            throw error;
        }
    }

    /**
     * Get TPA's mapped insurers
     */
    static async getTPAInsurers(clientId) {
        try {
            if (!clientId || isNaN(clientId)) {
                throw new Error('Valid client ID is required');
            }

            const insurers = await db.query(`
                SELECT i.id, i.insurer_name
                FROM client_insurers ci
                JOIN insurers i ON i.id = ci.insurer_id
                WHERE ci.client_id = ?
                AND i.is_active = TRUE AND i.is_deleted = 0
                GROUP BY i.id, i.insurer_name
                ORDER BY i.insurer_name
            `, [clientId]);

            return insurers;
        } catch (error) {
            logger.error('Error getting TPA insurers', { error: error.message, clientId });
            throw error;
        }
    }

    /**
     * Get tests and categories by insurer ID for a specific TPA client
     */
    static async getTestsAndCategoriesByInsurer(clientId, insurerId) {
        try {
            if (!clientId || isNaN(clientId)) {
                throw new Error('Valid client ID is required');
            }

            // Validate insurerId
            if (!insurerId || isNaN(insurerId)) {
                throw new Error('Valid insurer ID is required');
            }

            const insurerIdNumber = Number(insurerId);

            // Check if insurer exists and is active
            const insurerCheck = await db.query(
                'SELECT id FROM insurers WHERE id = ? AND is_active = TRUE AND is_deleted = 0',
                [insurerIdNumber]
            );

            if (insurerCheck.length === 0) {
                throw new Error('Insurer not found');
            }

            // Ensure insurer is mapped to this TPA client
            const insurerClientMapping = await db.query(
                'SELECT insurer_id FROM client_insurers WHERE client_id = ? AND insurer_id = ? LIMIT 1',
                [clientId, insurerIdNumber]
            );

            if (insurerClientMapping.length === 0) {
                throw new Error('Insurer is not mapped to this TPA client');
            }

            // Use bulk_test_rates table to get mapped tests for this client/insurer
            let tests = await db.query(`
                SELECT DISTINCT
                    t.id,
                    t.test_name AS name,
                    'test' AS type,
                    COALESCE(btr.rate, 0) AS rate
                FROM tests t
                LEFT JOIN bulk_test_rates btr
                    ON btr.client_id = ?
                    AND btr.insurer_id = ?
                    AND btr.item_type = 'test'
                    AND btr.test_id = t.id
                    AND btr.is_active = 1
                WHERE t.is_active = TRUE
                  AND t.is_deleted = 0
                  AND btr.test_id IS NOT NULL
                ORDER BY t.test_name
            `, [clientId, insurerIdNumber]);

            let categories = await db.query(`
                SELECT DISTINCT
                    tc.id,
                    tc.category_name AS name,
                    'category' AS type,
                    COALESCE(btr.rate, 0) AS rate
                FROM test_categories tc
                LEFT JOIN bulk_test_rates btr
                    ON btr.client_id = ?
                    AND btr.insurer_id = ?
                    AND btr.item_type = 'category'
                    AND btr.category_id = tc.id
                    AND btr.is_active = 1
                WHERE tc.is_active = TRUE
                  AND tc.is_deleted = 0
                  AND btr.category_id IS NOT NULL
                ORDER BY tc.category_name
            `, [clientId, insurerIdNumber]);

            // Fallback: return all active tests/categories if no specific mappings found
            if (tests.length === 0 && categories.length === 0) {
                tests = await db.query(`
                    SELECT DISTINCT
                        t.id,
                        t.test_name AS name,
                        'test' AS type,
                        0 AS rate
                    FROM tests t
                    WHERE t.is_active = TRUE
                      AND t.is_deleted = 0
                    ORDER BY t.test_name
                `);

                categories = await db.query(`
                    SELECT DISTINCT
                        tc.id,
                        tc.category_name AS name,
                        'category' AS type,
                        0 AS rate
                    FROM test_categories tc
                    WHERE tc.is_active = TRUE
                      AND tc.is_deleted = 0
                    ORDER BY tc.category_name
                `);
            }

            return {
                tests,
                categories
            };

        } catch (error) {
            logger.error('Error getting tests by insurer', {
                error: error.message,
                clientId,
                insurerId
            });
            throw error;
        }
    }

    /**
     * Get all active insurers (not limited to TPA mapping)
     */
    static async getAllActiveInsurers() {
        try {
            const rows = await db.query(`
                SELECT id, insurer_name, insurer_code, short_code
                FROM insurers
                WHERE is_active = 1
                  AND is_deleted = 0
                ORDER BY insurer_name
            `);

            return rows;
        } catch (error) {
            logger.error('Error getting all active insurers', { error: error.message });
            throw error;
        }
    }

    /**
     * Get insurer by ID (not limited to TPA mapping)
     */
    static async getInsurerById(insurerId) {
        try {
            const rows = await db.query(`
                SELECT id, insurer_name, insurer_code, short_code
                FROM insurers
                WHERE id = ?
                  AND is_active = 1
                  AND is_deleted = 0
            `, [insurerId]);

            return rows.length > 0 ? rows[0] : null;
        } catch (error) {
            logger.error('Error getting insurer by ID', { error: error.message, insurerId });
            throw error;
        }
    }
}

module.exports = TPAAppointmentService;
