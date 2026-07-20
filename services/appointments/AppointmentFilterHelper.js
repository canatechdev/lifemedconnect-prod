/**
 * Appointment Filter Helper
 * Unified advanced filtering layer that can be applied to any appointment service method
 * This preserves existing functionality while adding advanced filtering capabilities
 */

const { buildDateFilter } = require('./AppointmentCRUD');

/**
 * Extract and validate advanced filter parameters from request query
 * @param {object} reqQuery - Express request query object
 * @returns {object} Filter parameters object
 */
function extractAdvancedFilters(reqQuery) {
    return {
        // Basic filters
        customerCategory: reqQuery.customerCategory || '',
        month: reqQuery.month || '',
        year: reqQuery.year || '',
        visitType: reqQuery.visitType || '',
        status: reqQuery.status || '',
        medicalStatus: reqQuery.medicalStatus || '',
        qcStatus: reqQuery.qcStatus || '',
        
        // Enhanced date filtering
        dateField: reqQuery.dateField || 'created_at',
        rangeType: reqQuery.rangeType || '',
        fromDate: reqQuery.fromDate || '',
        toDate: reqQuery.toDate || '',
        
        // Diagnostic center filtering (support multiple centers)
        centerIds: reqQuery.centerIds ? reqQuery.centerIds.split(',').filter(id => id.trim()) : []
    };
}

/**
 * Apply advanced filters to existing query conditions
 * This can be called by any service method to add advanced filtering without changing core logic
 * @param {array} conditions - Existing WHERE conditions
 * @param {array} params - Existing query parameters
 * @param {object} filters - Advanced filter parameters
 * @param {string} tableAlias - Table alias to use in queries (default: 'appointments')
 * @returns {object} { conditions: [], params: [] }
 */
function applyAdvancedFilters(conditions = [], params = [], filters = {}, tableAlias = 'appointments') {
    const newConditions = [...conditions];
    const newParams = [...params];
    
    // Customer category filter
    if (filters.customerCategory) {
        newConditions.push(`${tableAlias}.customer_category = ?`);
        newParams.push(filters.customerCategory);
    }
    
    // Visit type filter
    if (filters.visitType) {
        newConditions.push(`${tableAlias}.visit_type = ?`);
        newParams.push(filters.visitType);
    }
    
    // Status filter
    if (filters.status) {
        newConditions.push(`${tableAlias}.status = ?`);
        newParams.push(filters.status);
    }
    
    // Medical status filter
    // Applied across medical_status, center_medical_status, home_medical_status to support
    // "Both" visit-type appointments where each side may have its own medical status.
    if (filters.medicalStatus) {
        const statuses = filters.medicalStatus.includes(',')
            ? filters.medicalStatus.split(',').map(s => s.trim()).filter(Boolean)
            : [filters.medicalStatus];
        if (statuses.length > 0) {
            const placeholders = statuses.map(() => '?').join(',');
            newConditions.push(
                `(${tableAlias}.medical_status IN (${placeholders}) ` +
                `OR ${tableAlias}.center_medical_status IN (${placeholders}) ` +
                `OR ${tableAlias}.home_medical_status IN (${placeholders}))`
            );
            newParams.push(...statuses, ...statuses, ...statuses);
        }
    }
    
    // QC status filter
    // "medical_completed" is exposed in the QC UI as a convenience label for the medical stage.
    // It maps to medical status filtering rather than qc_status filtering.
    if (filters.qcStatus && filters.qcStatus !== 'all') {
        if (filters.qcStatus === 'medical_completed') {
            newConditions.push(
                `(${tableAlias}.medical_status IN ('completed','medical_completed') ` +
                `OR ${tableAlias}.center_medical_status IN ('completed','medical_completed') ` +
                `OR ${tableAlias}.home_medical_status IN ('completed','medical_completed'))`
            );
        } else {
            newConditions.push(`${tableAlias}.qc_status = ?`);
            newParams.push(filters.qcStatus);
        }
    }
    
    // Diagnostic center filtering (multiple centers)
    if (filters.centerIds && filters.centerIds.length > 0) {
        newConditions.push(`(${tableAlias}.center_id IN (${filters.centerIds.map(() => '?').join(',')}) 
                          OR ${tableAlias}.other_center_id IN (${filters.centerIds.map(() => '?').join(',')}))`);
        newParams.push(...filters.centerIds, ...filters.centerIds);
    }
    
    // Legacy month/year filters (for backward compatibility)
    if (filters.month && filters.year) {
        newConditions.push(`MONTH(${tableAlias}.appointment_date) = ? AND YEAR(${tableAlias}.appointment_date) = ?`);
        newParams.push(filters.month, filters.year);
    } else if (filters.year) {
        newConditions.push(`YEAR(${tableAlias}.appointment_date) = ?`);
        newParams.push(filters.year);
    }
    
    // Enhanced date filtering
    if (filters.rangeType) {
        const dateFilter = buildDateFilter(
            filters.dateField,
            filters.rangeType,
            { fromDate: filters.fromDate, toDate: filters.toDate, month: filters.month, year: filters.year },
            tableAlias
        );
        newConditions.push(...dateFilter.conditions);
        newParams.push(...dateFilter.params);
    }
    
    return { conditions: newConditions, params: newParams };
}

/**
 * Merge advanced filters with existing service parameters
 * This allows service methods to accept optional advanced filters
 * @param {object} existingParams - Existing service method parameters
 * @param {object} advancedFilters - Advanced filter parameters
 * @returns {object} Merged parameters
 */
function mergeFilterParams(existingParams = {}, advancedFilters = {}) {
    return {
        ...existingParams,
        // Only add advanced filters if they have values
        ...(advancedFilters.customerCategory && { customerCategory: advancedFilters.customerCategory }),
        ...(advancedFilters.month && { month: advancedFilters.month }),
        ...(advancedFilters.year && { year: advancedFilters.year }),
        ...(advancedFilters.visitType && { visitType: advancedFilters.visitType }),
        ...(advancedFilters.status && { status: advancedFilters.status }),
        ...(advancedFilters.medicalStatus && { medicalStatus: advancedFilters.medicalStatus }),
        ...(advancedFilters.qcStatus && advancedFilters.qcStatus !== 'all' && { qcStatus: advancedFilters.qcStatus }),
        ...(advancedFilters.dateField && { dateField: advancedFilters.dateField }),
        ...(advancedFilters.rangeType && { rangeType: advancedFilters.rangeType }),
        ...(advancedFilters.fromDate && { fromDate: advancedFilters.fromDate }),
        ...(advancedFilters.toDate && { toDate: advancedFilters.toDate }),
        ...(advancedFilters.centerIds && advancedFilters.centerIds.length > 0 && { centerIds: advancedFilters.centerIds })
    };
}

function medicalStatusCondition(tableAlias, statuses) {
    const statusList = Array.isArray(statuses) ? statuses.map(s => String(s).trim()).filter(Boolean) : [];
    if (statusList.length === 0) {
        return { conditions: [], params: [] };
    }

    const placeholders = statusList.map(() => '?').join(',');
    return {
        conditions: [
            `(${tableAlias}.medical_status IN (${placeholders}) ` +
            `OR ${tableAlias}.center_medical_status IN (${placeholders}) ` +
            `OR ${tableAlias}.home_medical_status IN (${placeholders}))`
        ],
        params: [...statusList, ...statusList, ...statusList]
    };
}

function getAppointmentListDefinition(listType, tableAlias = 'appointments') {
    switch (listType) {
        case 'confirmed-scheduled':
            return medicalStatusCondition(tableAlias, ['confirmed', 'scheduled']);

        case 'report-upload':
            return {
                conditions: [
                    `(${tableAlias}.medical_status IN (?, ?) OR ${tableAlias}.center_medical_status = ? OR ${tableAlias}.home_medical_status = ?)`,
                    `(${tableAlias}.qc_status IS NULL OR ${tableAlias}.qc_status != ?)`
                ],
                params: ['completed', 'medical_completed', 'completed', 'completed', 'completed']
            };

        default:
            return { conditions: [], params: [] };
    }
}

/**
 * Get hardcoded status conditions for a specific list type
 * This centralizes status rules across all appointment list APIs
 * @param {string} listType - Type of list: 'unconfirmed', 'confirmed', 'completed', 'pending', 'qc_pending'
 * @param {string} tableAlias - Table alias to use in queries (default: 'a')
 * @returns {array} Array of SQL condition strings
 */
function getStatusConditions(listType, tableAlias = 'a') {
    const conditions = [];

    switch (listType) {
        case 'unconfirmed':
            // Unconfirmed: no confirmed_date/time set, not pushed back
            conditions.push(`(${tableAlias}.confirmed_date IS NULL OR ${tableAlias}.confirmed_time IS NULL)`);
            conditions.push(`${tableAlias}.pushed_back = 0`);
            break;

        case 'confirmed':
            // Confirmed: has confirmation timestamps, not pushed back (except qc_pushed_back), not medically completed
            conditions.push(`(
                (${tableAlias}.visit_type != 'Both' AND ${tableAlias}.confirmed_date IS NOT NULL AND ${tableAlias}.confirmed_time IS NOT NULL) OR
                (${tableAlias}.visit_type = 'Both' AND ${tableAlias}.center_confirmed_at IS NOT NULL AND ${tableAlias}.home_confirmed_at IS NOT NULL)
            )`);
            conditions.push(`(${tableAlias}.pushed_back = 0 OR ${tableAlias}.status = 'qc_pushed_back')`);
            conditions.push(`${tableAlias}.medical_status NOT IN ('completed','medical_completed')`);
            break;

        case 'completed':
            // Completed: medical status completed, QC not done yet
            conditions.push(`${tableAlias}.medical_status IN ('completed','medical_completed')`);
            conditions.push(`(${tableAlias}.qc_status != 'completed' OR ${tableAlias}.qc_status IS NULL)`);
            break;

        case 'pending':
            // Pending (pushback): pushed_back flag set
            conditions.push(`${tableAlias}.pushed_back = 1`);
            conditions.push(`${tableAlias}.is_deleted = 0`);
            break;

        case 'qc_pending':
            // QC pending: medical completed, qc_status not null
            conditions.push(`${tableAlias}.medical_status IN ('completed','medical_completed')`);
            conditions.push(`${tableAlias}.qc_status IS NOT NULL`);
            break;

        default:
            // No specific conditions for unknown list types
            break;
    }

    return conditions;
}

module.exports = {
    extractAdvancedFilters,
    applyAdvancedFilters,
    mergeFilterParams,
    getAppointmentListDefinition,
    getStatusConditions
};
