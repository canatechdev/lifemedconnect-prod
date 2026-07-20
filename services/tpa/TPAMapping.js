/**
 * TPA Mapping Service
 * Handles mapping of TPA and Insurer names to internal IDs
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { generateCustomCode } = require('../../lib/generateCode');

class TPAMappingService {
    static createValidationError(message, statusCode = 400) {
        const error = new Error(message);
        error.statusCode = statusCode;
        return error;
    }

    /**
     * Find TPA (client) by name or code
     */
    static async findTPA(tpaName) {
        try {
            const rows = await db.query(
                `SELECT id, client_name, client_code, short_code
                 FROM clients
                 WHERE (client_name = ? OR client_code = ? OR short_code = ?)
                 AND is_active = TRUE AND is_deleted = 0
                 LIMIT 1`,
                [tpaName, tpaName, tpaName]
            );

            if (rows.length === 0) {
                logger.warn('TPA not found', { tpaName });
                return null;
            }

            return rows[0];
        } catch (error) {
            logger.error('Error finding TPA', { tpaName, error: error.message });
            throw error;
        }
    }

    static async resolveInsurerId(tpaData) {
        if (tpaData.insurer_id) {
            const insurerId = Number(tpaData.insurer_id);
            if (Number.isNaN(insurerId) || insurerId <= 0) {
                throw this.createValidationError('insurer_id must be a valid positive number');
            }
            return insurerId;
        }

        if (!tpaData.insurer_name) {
            return null;
        }

        const insurer = await this.findInsurer(tpaData.insurer_name);
        if (!insurer) {
            throw this.createValidationError(`Insurer not found for insurer_name: ${tpaData.insurer_name}`);
        }

        return insurer.id;
    }

    static async ensureClientInsurerMapping(clientId, insurerId) {
        const mappingRows = await db.query(
            `SELECT insurer_id
             FROM client_insurers
             WHERE client_id = ? AND insurer_id = ?
             LIMIT 1`,
            [clientId, insurerId]
        );

        if (mappingRows.length === 0) {
            throw this.createValidationError(
                `Insurer ID ${insurerId} is not mapped to this TPA client`
            );
        }
    }

    static async fetchMappedTests(clientId, insurerId, testIds) {
        if (!testIds.length) {
            return new Map();
        }

        const placeholders = testIds.map(() => '?').join(',');
        const rows = await db.query(
            `SELECT DISTINCT
                t.id,
                t.test_name,
                CASE WHEN btr.test_id IS NOT NULL THEN 1 ELSE 0 END AS is_mapped,
                COALESCE(btr.rate, 0) AS rate
             FROM tests t
             LEFT JOIN bulk_test_rates btr
               ON btr.client_id = ?
              AND btr.insurer_id = ?
              AND btr.item_type = 'test'
              AND btr.test_id = t.id
              AND btr.is_active = 1
             WHERE t.id IN (${placeholders})
               AND t.is_active = TRUE
               AND t.is_deleted = 0`,
            [clientId, insurerId, ...testIds]
        );

        const mappedTests = new Map();
        const unmappedTests = [];
        
        for (const row of rows) {
            if (row.is_mapped) {
                mappedTests.set(Number(row.id), row);
            } else {
                unmappedTests.push(Number(row.id));
            }
        }
        
        // If there are unmapped tests, throw validation error
        if (unmappedTests.length > 0) {
            throw this.createValidationError(
                `These test IDs are not mapped for this client/insurer: ${unmappedTests.join(', ')}`
            );
        }

        return mappedTests;
    }

    static async fetchMappedCategories(clientId, insurerId, categoryIds) {
        if (!categoryIds.length) {
            return new Map();
        }

        const placeholders = categoryIds.map(() => '?').join(',');
        const rows = await db.query(
            `SELECT DISTINCT
                tc.id,
                tc.category_name,
                CASE WHEN btr.category_id IS NOT NULL THEN 1 ELSE 0 END AS is_mapped,
                COALESCE(btr.rate, 0) AS rate
             FROM test_categories tc
             LEFT JOIN bulk_test_rates btr
               ON btr.client_id = ?
              AND btr.insurer_id = ?
              AND btr.item_type = 'category'
              AND btr.category_id = tc.id
              AND btr.is_active = 1
             WHERE tc.id IN (${placeholders})
               AND tc.is_active = TRUE
               AND tc.is_deleted = 0`,
            [clientId, insurerId, ...categoryIds]
        );

        const mappedCategories = new Map();
        const unmappedCategories = [];
        
        for (const row of rows) {
            if (row.is_mapped) {
                mappedCategories.set(Number(row.id), row);
            } else {
                unmappedCategories.push(Number(row.id));
            }
        }
        
        // If there are unmapped categories, throw validation error
        if (unmappedCategories.length > 0) {
            throw this.createValidationError(
                `These category IDs are not mapped for this client/insurer: ${unmappedCategories.join(', ')}`
            );
        }

        return mappedCategories;
    }

    /**
     * Find Insurer by name or code
     */
    static async findInsurer(insurerName) {
        try {
            const rows = await db.query(
                `SELECT id, insurer_name, insurer_code, short_code
                 FROM insurers
                 WHERE (insurer_name = ? OR insurer_code = ? OR short_code = ?)
                 AND is_active = TRUE AND is_deleted = 0
                 LIMIT 1`,
                [insurerName, insurerName, insurerName]
            );

            if (rows.length === 0) {
                logger.warn('Insurer not found', { insurerName });
                return null;
            }

            return rows[0];
        } catch (error) {
            logger.error('Error finding Insurer', { insurerName, error: error.message });
            throw error;
        }
    }

    /**
     * Find Diagnostic Center by ID
     */
    static async findDiagnosticCenterById(centerId) {
        try {
            if (!centerId || Number.isNaN(Number(centerId))) {
                return null;
            }

            const rows = await db.query(
                `SELECT id, center_name, center_code
                 FROM diagnostic_centers
                 WHERE id = ?
                 AND is_active = 0 AND is_deleted = 0
                 LIMIT 1`,
                [Number(centerId)]
            );

            if (rows.length === 0) {
                logger.warn('Diagnostic Center not found by ID', { centerId });
                return null;
            }

            return rows[0];
        } catch (error) {
            logger.error('Error finding Diagnostic Center by ID', { centerId, error: error.message });
            throw error;
        }
    }

    /**
     * Find Diagnostic Center by name
     */
    static async findDiagnosticCenter(centerName) {
        try {
            const rows = await db.query(
                `SELECT id, center_name, center_code
                 FROM diagnostic_centers
                 WHERE (center_name = ? OR center_code = ?)
                 AND is_active = 0 AND is_deleted = 0
                 LIMIT 1`,
                [centerName, centerName]
            );

            if (rows.length === 0) {
                logger.warn('Diagnostic Center not found', { centerName });
                return null;
            }

            return rows[0];
        } catch (error) {
            logger.error('Error finding Diagnostic Center', { centerName, error: error.message });
            throw error;
        }
    }

    /**
     * Search diagnostic centers for TPA integrations
     */
    static async getDiagnosticCenters({ search = '', pincode = '' } = {}) {
        try {
            const conditions = ['dc.is_deleted = 0', 'dc.is_active = 0'];
            const params = [];

            if (pincode) {
                conditions.push('dc.pincode LIKE ?');
                params.push(`%${pincode}%`);
            }

            if (search) {
                conditions.push(`(
                    dc.center_name LIKE ? OR
                    dc.owner_name LIKE ? OR
                    dc.address LIKE ? OR
                    dc.city LIKE ? OR
                    dc.state LIKE ? OR
                    dc.country LIKE ? OR
                    dc.pincode LIKE ? OR
                    dc.center_code LIKE ?
                )`);
                const like = `%${search}%`;
                params.push(like, like, like, like, like, like, like, like);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            const rows = await db.query(
                `SELECT 
                    dc.id,
                    dc.center_name,
                    dc.address,
                    dc.owner_name,
                    dc.city,
                    dc.state,
                    dc.pincode,
                    dc.country
                 FROM diagnostic_centers dc
                 ${whereClause}
                 ORDER BY dc.center_name ASC`,
                params
            );

            return rows;
        } catch (error) {
            logger.error('Error getting diagnostic centers for TPA', { error: error.message, search, pincode });
            throw error;
        }
    }

    /**
     * Map appointment data from TPA format to internal format
     */
    static async mapAppointmentData(tpaData, clientId) {
        logger.info('[TPA MAPPING] Starting mapAppointmentData', { 
            testsCount: tpaData.tests?.length || 0, 
            categoriesCount: tpaData.categories?.length || 0 
        });
        try {
            // Generate case_number and application_number if not provided
            const case_number = tpaData.case_number || await this.generateCaseNumber(clientId);
            const application_number = tpaData.application_number || tpaData.applicantion_number || await this.generateApplicationNumber(clientId);
            
            const mappedData = {
                client_id: clientId,
                case_number: case_number,
                application_number: application_number,
                // Map customer fields to correct database columns
                customer_first_name: tpaData.customer_first_name || tpaData.patient_name?.split(' ')[0] || '',
                customer_last_name: tpaData.customer_last_name || tpaData.patient_name?.split(' ').slice(1).join(' ') || '',
                gender: tpaData.customer_gender || tpaData.patient_gender || '',
                customer_mobile: tpaData.customer_mobile || tpaData.patient_phone || '',
                customer_alt_mobile: tpaData.customer_alt_mobile || '',
                customer_service_no: tpaData.customer_service_no || '',
                customer_email: tpaData.customer_email || tpaData.patient_email || '',
                customer_address: tpaData.customer_address || tpaData.address || '',
                state: tpaData.state || '',
                city: tpaData.city || '',
                pincode: tpaData.pincode || '',
                country: tpaData.country || '',
                customer_gps_latitude: tpaData.customer_gps_latitude || null,
                customer_gps_longitude: tpaData.customer_gps_longitude || null,
                customer_landmark: tpaData.customer_landmark || '',
                // Remarks field
                remarks: tpaData.remarks || '',
                // Appointment details
                visit_type: tpaData.visit_type || 'Home_Visit',
                appointment_date: tpaData.appointment_date,
                appointment_time: tpaData.appointment_time,
                status: 'pending',
                medical_status: 'pending',
                qc_status: 'pending'
            };

            const insurerId = await this.resolveInsurerId(tpaData);
            if (insurerId) {
                await this.ensureClientInsurerMapping(clientId, insurerId);
                mappedData.insurer_id = insurerId;
            }

            // Map diagnostic center if provided
            if (tpaData.center_id !== undefined && tpaData.center_id !== null && tpaData.center_id !== '') {
                const center = await this.findDiagnosticCenterById(tpaData.center_id);
                if (center) {
                    mappedData.center_id = center.id;
                } else {
                    logger.warn('Diagnostic Center not found, proceeding without center_id', {
                        centerId: tpaData.center_id
                    });
                }
            } else if (tpaData.center_name) {
                const center = await this.findDiagnosticCenter(tpaData.center_name);
                if (center) {
                    mappedData.center_id = center.id;
                } else {
                    logger.warn('Diagnostic Center not found, proceeding without center_id', {
                        centerName: tpaData.center_name
                    });
                }
            }

            if (tpaData.other_center_id !== undefined && tpaData.other_center_id !== null && tpaData.other_center_id !== '') {
                const otherCenter = await this.findDiagnosticCenterById(tpaData.other_center_id);
                if (otherCenter) {
                    mappedData.other_center_id = otherCenter.id;
                } else {
                    logger.warn('Other Diagnostic Center not found, proceeding without other_center_id', {
                        otherCenterId: tpaData.other_center_id
                    });
                }
            } else if (tpaData.other_center_name) {
                const otherCenter = await this.findDiagnosticCenter(tpaData.other_center_name);
                if (otherCenter) {
                    mappedData.other_center_id = otherCenter.id;
                } else {
                    logger.warn('Other Diagnostic Center not found, proceeding without other_center_id', {
                        otherCenterName: tpaData.other_center_name
                    });
                }
            }

            if (!mappedData.insurer_id && ((tpaData.tests && tpaData.tests.length) || (tpaData.categories && tpaData.categories.length))) {
                throw this.createValidationError('insurer_name or insurer_id is required when tests or categories are provided');
            }

            // Convert tests and categories to selected_items format with proper names
            const selected_items = [];
            
            // Process tests - fetch actual names from database
            if (tpaData.tests && Array.isArray(tpaData.tests)) {
                const requestedTestIds = tpaData.tests
                    .map((test) => Number(test.test_id))
                    .filter((id) => Number.isInteger(id) && id > 0);

                const mappedTests = await this.fetchMappedTests(clientId, mappedData.insurer_id, requestedTestIds);
                const missingTests = requestedTestIds.filter((id) => !mappedTests.has(id));

                if (missingTests.length > 0) {
                    throw this.createValidationError(
                        `These test IDs are not mapped for this client/insurer: ${missingTests.join(', ')}`
                    );
                }

                for (const test of tpaData.tests) {
                    const testId = Number(test.test_id);
                    if (!Number.isInteger(testId) || testId <= 0) continue;

                    const mappedTest = mappedTests.get(testId);
                    const item = {
                        id: testId,
                        type: 'test',
                        name: mappedTest.test_name,
                        rate: Number(mappedTest.rate) || 0
                    };

                    // Handle optional per-test center assignment (by ID or name)
                    if (test.center_id !== undefined && test.center_id !== null && test.center_id !== '') {
                        // Validate that test center_id must match either appointment center_id or other_center_id
                        if (mappedData.center_id && test.center_id !== mappedData.center_id && 
                            (!mappedData.other_center_id || test.center_id !== mappedData.other_center_id)) {
                            throw this.createValidationError(
                                `Test center_id ${test.center_id} must match either appointment center_id (${mappedData.center_id}) or other_center_id (${mappedData.other_center_id})`
                            );
                        }
                        
                        const center = await this.findDiagnosticCenterById(test.center_id);
                        if (center) {
                            item.assigned_center_id = center.id;
                        } else {
                            logger.warn('Test-level Diagnostic Center not found by ID', {
                                testId,
                                centerId: test.center_id
                            });
                        }
                    } else if (test.center_name) {
                        const center = await this.findDiagnosticCenter(test.center_name);
                        if (center) {
                            // Validate that test center must match either appointment center_id or other_center_id
                            if (mappedData.center_id && center.id !== mappedData.center_id && 
                                (!mappedData.other_center_id || center.id !== mappedData.other_center_id)) {
                                throw this.createValidationError(
                                    `Test center '${test.center_name}' (ID: ${center.id}) must match either appointment center_id (${mappedData.center_id}) or other_center_id (${mappedData.other_center_id})`
                                );
                            }
                            
                            item.assigned_center_id = center.id;
                        } else {
                            logger.warn('Test-level Diagnostic Center not found by name', {
                                testId,
                                centerName: test.center_name
                            });
                        }
                    }

                    // Handle optional per-test visit subtype
                    if (test.visit_subtype && ['center', 'home'].includes(test.visit_subtype)) {
                        item.visit_subtype = test.visit_subtype;
                    }

                    selected_items.push(item);
                }
            }
            
            // Process categories - fetch actual names from database
            if (tpaData.categories && Array.isArray(tpaData.categories)) {
                const requestedCategoryIds = tpaData.categories
                    .map((category) => Number(category.category_id))
                    .filter((id) => Number.isInteger(id) && id > 0);

                const mappedCategories = await this.fetchMappedCategories(clientId, mappedData.insurer_id, requestedCategoryIds);
                const missingCategories = requestedCategoryIds.filter((id) => !mappedCategories.has(id));

                if (missingCategories.length > 0) {
                    throw this.createValidationError(
                        `These category IDs are not mapped for this client/insurer: ${missingCategories.join(', ')}`
                    );
                }

                for (const category of tpaData.categories) {
                    const categoryId = Number(category.category_id);
                    if (!Number.isInteger(categoryId) || categoryId <= 0) continue;

                    const mappedCategory = mappedCategories.get(categoryId);
                    const item = {
                        id: categoryId,
                        type: 'category',
                        name: mappedCategory.category_name,
                        rate: Number(mappedCategory.rate) || 0
                    };

                    // Handle optional per-category center assignment (by ID or name)
                    if (category.center_id !== undefined && category.center_id !== null && category.center_id !== '') {
                        // Validate that category center_id must match either appointment center_id or other_center_id
                        if (mappedData.center_id && category.center_id !== mappedData.center_id && 
                            (!mappedData.other_center_id || category.center_id !== mappedData.other_center_id)) {
                            throw this.createValidationError(
                                `Category center_id ${category.center_id} must match either appointment center_id (${mappedData.center_id}) or other_center_id (${mappedData.other_center_id})`
                            );
                        }
                        
                        const center = await this.findDiagnosticCenterById(category.center_id);
                        if (center) {
                            item.assigned_center_id = center.id;
                        } else {
                            logger.warn('Category-level Diagnostic Center not found by ID', {
                                categoryId,
                                centerId: category.center_id
                            });
                        }
                    } else if (category.center_name) {
                        const center = await this.findDiagnosticCenter(category.center_name);
                        if (center) {
                            // Validate that category center must match either appointment center_id or other_center_id
                            if (mappedData.center_id && center.id !== mappedData.center_id && 
                                (!mappedData.other_center_id || center.id !== mappedData.other_center_id)) {
                                throw this.createValidationError(
                                    `Category center '${category.center_name}' (ID: ${center.id}) must match either appointment center_id (${mappedData.center_id}) or other_center_id (${mappedData.other_center_id})`
                                );
                            }
                            
                            item.assigned_center_id = center.id;
                        } else {
                            logger.warn('Category-level Diagnostic Center not found by name', {
                                categoryId,
                                centerName: category.center_name
                            });
                        }
                    }

                    // Handle optional per-category visit subtype
                    if (category.visit_subtype && ['center', 'home'].includes(category.visit_subtype)) {
                        item.visit_subtype = category.visit_subtype;
                    }

                    selected_items.push(item);
                }
            }
            
            // Add selected_items to mapped data
            if (selected_items.length > 0) {
                mappedData.selected_items = selected_items;
                logger.info('[TPA MAPPING] Completed', { 
                    selectedItemsCount: selected_items.length,
                    firstItem: selected_items[0]
                });
            }

            return mappedData;
        } catch (error) {
            logger.error('Error mapping appointment data', { error: error.message });
            throw error;
        }
    }

    /**
     * Generate case number for TPA using standard CRM function
     */
    static async generateCaseNumber(clientId) {
        try {
            const caseNumber = await generateCustomCode({
                prefix: 'CASE',
                table: 'appointments',
                column: 'case_number'
            });
            
            logger.info('TPA case number generated', { 
                clientId, 
                caseNumber,
                method: 'generateCustomCode'
            });
            
            return caseNumber;
        } catch (error) {
            logger.error('Error generating case number', { error: error.message });
            throw error;
        }
    }

    /**
     * Generate application number for TPA
     */
    static async generateApplicationNumber(clientId) {
        try {
            const today = new Date();
            const dateStr = today.toISOString().slice(2, 10).replace(/-/g, '/');
            const client = await db.query(
                'SELECT client_code FROM clients WHERE id = ?',
                [clientId]
            );
            
            const clientCode = client[0]?.client_code || 'TPA';
            
            // Find existing application numbers for today
            const existing = await db.query(
                `SELECT COUNT(*) as count FROM appointments 
                 WHERE client_id = ? AND DATE(created_at) = CURDATE()`,
                [clientId]
            );
            
            const sequence = (existing[0]?.count || 0) + 1;
            return `APP/${String(sequence).padStart(3, '0')}`;
        } catch (error) {
            logger.error('Error generating application number', { error: error.message });
            throw error;
        }
    }
}

module.exports = TPAMappingService;
