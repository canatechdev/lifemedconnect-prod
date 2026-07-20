/**
 * Appointment QC (Quality Control) Workflow Management
 * Handles QC verification, push back, and completion
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { formatTimeAMPM, formatDateDDMMYYYY } = require('../approvals/utils/normalizers');
const { applyAdvancedFilters, getStatusConditions } = require('./AppointmentFilterHelper');

/**
 * List appointments pending QC
 * WHERE qc_status = 'pending' OR qc_status = 'in_process'
 */
async function listQCPendingAppointments({ page = 1, limit = 10, search = '', sortBy = 'id', sortOrder = 'DESC', customerCategory = '',
    month = '', year = '', visitType = '', status = '', medicalStatus = '', qcStatus = '',
    dateField = 'created_at', rangeType = '', fromDate = '', toDate = '', centerIds = [], emailSent = '' }) {
    const allowedSortColumns = [
        'id', 'case_number', 'customer_first_name', 'customer_last_name',
        'confirmed_date', 'qc_status'
    ];
    const validSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'id';
    const validSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const searchParams = [];
    // Use centralized status conditions for QC pending (medically completed) appointments
    const conditions = getStatusConditions('qc_pending', 'a');
    conditions.push(`a.is_deleted = 0`);

    if (search) {
        conditions.push(`(
            a.case_number LIKE ? OR
            a.application_number LIKE ? OR
            a.customer_first_name LIKE ? OR
            a.customer_last_name LIKE ? OR
            a.customer_mobile LIKE ? OR
            a.customer_email LIKE ? OR
            dc.center_name LIKE ? OR
            dc2.center_name LIKE ?
        )`);
        const like = `%${search}%`;
        searchParams.push(like, like, like, like, like, like, like, like);
    }

    // customerCategory is applied by applyAdvancedFilters() below (single source of truth)

    // Email sent filter
    if (emailSent === 'pending') {
        conditions.push(`NOT EXISTS (SELECT 1 FROM tpa_email_log tel WHERE tel.appointment_id = a.id)`);
    } else if (emailSent === 'sent') {
        conditions.push(`EXISTS (SELECT 1 FROM tpa_email_log tel WHERE tel.appointment_id = a.id)`);
    }

    // Apply advanced filters using helper
    // medicalStatus is protected (hardcoded to medical completed)
    // qcStatus filter is allowed to filter within all qc statuses
    const advancedFilters = { 
        customerCategory, month, year, visitType, status,
        medicalStatus: '',  // protected: QC page only shows medical completed
        qcStatus,           // allowed: filters within all qc statuses
        dateField, rangeType, fromDate, toDate, centerIds 
    };
    const { conditions: advancedConditions, params: advancedParams } = applyAdvancedFilters(conditions, searchParams, advancedFilters, 'a');

    const whereClause = `WHERE ${advancedConditions.join(' AND ')}`;

    const countSql = `
        SELECT COUNT(*) as total
        FROM appointments a
        LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
        LEFT JOIN diagnostic_centers dc2 ON a.other_center_id = dc2.id
        ${whereClause}
    `;

    const dataSql = `
        SELECT 
            a.*,
            dc.center_name as home_center_name,
            dc2.center_name as other_center_name,
            COALESCE(
                (SELECT 
                    JSON_ARRAYAGG(
                        JSON_OBJECT(
                            'id', at.id,
                            'test_id', at.test_id,
                            'category_id', at.category_id,
                            'rate_type', at.rate_type,
                            'item_name', at.item_name,
                            'rate', at.rate,
                            'assigned_center_id', at.assigned_center_id
                        )
                    )
                FROM appointment_tests at 
                WHERE at.appointment_id = a.id
                GROUP BY at.appointment_id),
                JSON_ARRAY()
            ) as tests,
            (SELECT 
                JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'id', tel.id,
                        'client_id', tel.client_id,
                        'client_name', c.client_name,
                        'client_code', c.client_code,
                        'client_email', c.email_id,
                        'client_email_2', c.email_id_2,
                        'email_recipients', tel.email_recipients,
                        'sent_at', tel.sent_at,
                        'status', tel.status,
                        'sent_by_name', u.full_name
                    )
                )
                FROM tpa_email_log tel
                LEFT JOIN users u ON tel.sent_by = u.id
                LEFT JOIN clients c ON tel.client_id = c.id
                WHERE tel.appointment_id = a.id AND tel.is_deleted = 0
                ORDER BY tel.sent_at DESC
            ) as tpa_emails
        FROM appointments a
        LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
        LEFT JOIN diagnostic_centers dc2 ON a.other_center_id = dc2.id
        ${whereClause}
        ORDER BY a.${validSortBy} ${validSortOrder}
    `;

    const countRows = await db.query(countSql, advancedParams);
    const total = countRows[0]?.total || 0;

    const numericLimit = Number(limit);
    const numericPage = Number(page);
    const offset = numericLimit > 0 ? (numericPage - 1) * numericLimit : 0;

    let finalSql = dataSql;
    if (numericLimit > 0) {
        finalSql += ` LIMIT ${numericLimit} OFFSET ${offset}`;
    }

    let rows = await db.query(finalSql, advancedParams);

    // Parse tests and tpa_emails data
    rows = rows.map(row => {
        try {
            row.tests = row.tests ? (typeof row.tests === 'string' ? JSON.parse(row.tests) : row.tests) : [];
        } catch (e) {
            row.tests = [];
        }
        try {
            row.tpa_emails = row.tpa_emails ? (typeof row.tpa_emails === 'string' ? JSON.parse(row.tpa_emails) : row.tpa_emails) : [];
            // Parse email_recipients for each TPA email
            row.tpa_emails = row.tpa_emails.map(tpa => ({
                ...tpa,
                email_recipients: tpa.email_recipients ? (typeof tpa.email_recipients === 'string' ? JSON.parse(tpa.email_recipients) : tpa.email_recipients) : []
            }));
        } catch (e) {
            row.tpa_emails = [];
        }
        return row;
    });

    return {
        data: rows,
        pagination: {
            total,
            page: numericPage,
            limit: numericLimit,
            pages: numericLimit > 0 ? Math.ceil(total / numericLimit) : 1,
        },
    };
}

/**
 * Get QC appointment details (appointment + categorized reports)
 * @param {number} appointmentId 
 * @param {number|null} centerId - Optional: filter by center for Both appointments
 * @param {number|null} userId - Optional: filter reports by uploader for DC users
 * @param {string|null} userRole - Optional: user role to determine filtering behavior
 */
async function getQCAppointmentDetails(appointmentId, centerId = null, userId = null, userRole = null) {
    // Get appointment
    const appointmentSql = 'SELECT * FROM appointments WHERE id = ?';
    const appointmentRows = await db.query(appointmentSql, [appointmentId]);

    if (!appointmentRows || appointmentRows.length === 0) {
        return null;
    }

    const appointment = appointmentRows[0];

    // Get categorized reports (grouped by type), filtered by centerId if provided
    const { getCategorizedReports } = require('./AppointmentReports');
    const reports = await getCategorizedReports(appointmentId, centerId, userId, userRole);

    // Get ALL QC history (limit 50 for safety)
    const qcHistorySql = `
        SELECT 
            qch.*,
            u.full_name,
            r.role_name
        FROM appointment_qc_history qch
        LEFT JOIN users u ON qch.qc_by = u.id
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE qch.appointment_id = ?
        ORDER BY qch.created_at DESC
        LIMIT 50
    `;
    const qcHistoryRows = await db.query(qcHistorySql, [appointmentId]);
    const latestQCHistory = qcHistoryRows.length > 0 ? qcHistoryRows[0] : null;

    // Get appointment tests with test + category info, filtered by centerId if provided
    let testsSql = `
        SELECT 
        at.*,
        t.test_name, t.description AS test_description, t.report_type AS test_report_type,
        tc.category_name, tc.description AS category_description, tc.report_type AS category_report_type
        FROM appointment_tests at
        LEFT JOIN tests t 
               ON at.test_id = t.id AND at.rate_type = 'test'
        LEFT JOIN test_categories tc 
               ON at.category_id = tc.id AND at.rate_type = 'category'
        WHERE at.appointment_id = ?
    `;
    
    const testsParams = [appointmentId];
    
    // If centerId provided, filter tests by assigned_center_id
    if (centerId) {
        testsSql += ` AND at.assigned_center_id = ?`;
        testsParams.push(centerId);
    }
    
    const appointmentTests = await db.query(testsSql, testsParams);

    return {
        ...appointment,
        categorized_reports: reports,
        latest_qc_history: latestQCHistory,
        qc_history: qcHistoryRows, // Return full history
        appointment_tests: appointmentTests
    };
}

/**
 * Push back to reports
 * Sets qc_status = 'pushed_back', status = 'pushed_back'
 * @param {number} appointmentId 
 * @param {string} remarks 
 * @param {number} userId 
 * @param {number|null} centerId - Optional: for center-specific pushback in "Both" visit type
 */
async function pushBackToReports(appointmentId, remarks, userId, centerId = null) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        // Get current appointment status and visit type
        const [current] = await connection.query(
            'SELECT status, medical_status, qc_status, visit_type FROM appointments WHERE id = ?',
            [appointmentId]
        );

        if (!current || current.length === 0) {
            throw new Error('Appointment not found');
        }

        const currentRow = Array.isArray(current) ? current[0] : current;
        const visitType = currentRow.visit_type;

        // Fetch the latest QC history to preserve current checkbox states.
        const [latestHistory] = await connection.query(`
            SELECT * FROM appointment_qc_history 
            WHERE appointment_id = ? 
            ORDER BY created_at DESC 
            LIMIT 1
        `, [appointmentId]);

        const previousCheckboxes = latestHistory && latestHistory.length > 0 ? latestHistory[0] : {};

        // For "Both" visit type with centerId, implement center-specific pushback
        if (visitType === 'Both' && centerId) {
            // Delete only reports from this specific center
            await connection.query(`
                UPDATE appointment_categorized_reports 
                SET is_deleted = 1 
                WHERE appointment_id = ? 
                AND uploaded_by IN (
                    SELECT u.id FROM users u 
                    WHERE u.diagnostic_center_id = ?
                )
            `, [appointmentId, centerId]);

            // Add center-specific QC history entry
            await connection.query(`
                INSERT INTO appointment_qc_history 
                (appointment_id, action, remarks, qc_by, created_at, 
                 pathology_checked, cardiology_checked, radiology_checked, mer_checked, mtrf_checked, other_checked)
                VALUES (?, 'pushed_back', ?, ?, NOW(), ?, ?, ?, ?, ?, ?)
            `, [
                appointmentId,
                `Center-specific pushback: ${remarks}`,
                userId,
                // Preserve checkbox states from previous QC
                previousCheckboxes.pathology_checked || 0,
                previousCheckboxes.cardiology_checked || 0,
                previousCheckboxes.radiology_checked || 0,
                previousCheckboxes.mer_checked || 0,
                previousCheckboxes.mtrf_checked || 0,
                previousCheckboxes.other_checked || 0
            ]);

            await connection.commit();
            logger.info('Center-specific QC pushback completed', { appointmentId, centerId, userId });
            return { success: true, message: 'Center-specific reports pushed back successfully' };
        }

        // Update appointment: qc_status = 'pushed_back', status = 'pushed_back', pushed_back = 1
        await connection.query(`
            UPDATE appointments 
            SET 
                qc_status = 'pushed_back',
                status = 'qc_pushed_back',
                updated_at = NOW(),
                updated_by = ?
            WHERE id = ?
        `, [userId, appointmentId]);

        // Log QC history - PRESERVING CHECKBOXES
        await connection.query(`
            INSERT INTO appointment_qc_history 
            (appointment_id, action, remarks, qc_by, created_at, 
             pathology_checked, cardiology_checked, radiology_checked, mer_checked, mtrf_checked, other_checked)
            VALUES (?, 'pushed_back', ?, ?, NOW(), ?, ?, ?, ?, ?, ?)
        `, [
            appointmentId,
            remarks,
            userId,
            previousCheckboxes.pathology_checked || 0,
            previousCheckboxes.cardiology_checked || 0,
            previousCheckboxes.radiology_checked || 0,
            previousCheckboxes.mer_checked || 0,
            previousCheckboxes.mtrf_checked || 0,
            previousCheckboxes.other_checked || 0
        ]);

        // Log status history
        const { logStatusHistory } = require('./AppointmentFlow');
        await logStatusHistory(appointmentId, {
            old_status: currentRow.status || null,
            new_status: 'pushed_back',
            old_medical_status: currentRow.medical_status || null,
            new_medical_status: currentRow.medical_status || null,
            changed_by: userId,
            change_type: 'qc_push_back',
            remarks: remarks,
            metadata: { qc_status: 'pushed_back', previous_qc_status: currentRow.qc_status }
        }, connection);

        await connection.commit();
        logger.info('QC pushed back to reports', { appointmentId, userId });
        return { success: true, message: 'Appointment pushed back to reports successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error pushing back to reports:', error);
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Save QC verification (partial or complete)
 * @param {number} appointmentId 
 * @param {Object} checkboxes - { pathology, cardiology, sonography, mer, mtrf }
 * @param {string} remarks 
 * @param {boolean} isComplete - If true, sets qc_status = 'completed', status = 'completed'
 * @param {number} userId 
 */
async function saveQCVerification(appointmentId, checkboxes, remarks, isComplete, userId) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        // Get current appointment status
        const [current] = await connection.query(
            'SELECT status, medical_status, qc_status FROM appointments WHERE id = ?',
            [appointmentId]
        );

        if (!current || current.length === 0) {
            throw new Error('Appointment not found');
        }

        const currentRow = Array.isArray(current) ? current[0] : current;

        let newQCStatus, newStatus, action;

        if (isComplete) {
            // All checkboxes marked + final checkbox checked
            newQCStatus = 'completed';
            newStatus = 'completed';
            action = 'completed';
        } else {
            // Partial save
            newQCStatus = 'in_process';
            newStatus = 'qc_pending';
            action = 'partial_save';
        }

        // Update appointment
        await connection.query(`
            UPDATE appointments 
            SET 
                qc_status = ?,
                status = ?,
                updated_at = NOW(),
                updated_by = ?
            WHERE id = ?
        `, [newQCStatus, newStatus, userId, appointmentId]);

        // Log QC history
        await connection.query(`
            INSERT INTO appointment_qc_history 
            (appointment_id, action, pathology_checked, cardiology_checked, 
             radiology_checked, mer_checked, mtrf_checked, other_checked, remarks, qc_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
            appointmentId,
            action,
            checkboxes.pathology ? 1 : 0,
            checkboxes.cardiology ? 1 : 0,
            checkboxes.radiology ? 1 : 0,
            checkboxes.mer ? 1 : 0,
            checkboxes.mtrf ? 1 : 0,
            checkboxes.other ? 1 : 0,
            remarks || null,
            userId
        ]);

        // Log status history
        const { logStatusHistory } = require('./AppointmentFlow');
        await logStatusHistory(appointmentId, {
            old_status: currentRow.status || null,
            new_status: newStatus,
            old_medical_status: currentRow.medical_status || null,
            new_medical_status: currentRow.medical_status || null,
            changed_by: userId,
            change_type: isComplete ? 'qc_complete' : 'qc_partial_save',
            remarks: remarks || null,
            metadata: {
                qc_status: newQCStatus,
                checkboxes: checkboxes
            }
        }, connection);

        await connection.commit();
        logger.info('QC verification saved', { appointmentId, isComplete, userId });
        return {
            success: true,
            message: isComplete ? 'QC completed successfully' : 'QC progress saved successfully'
        };
    } catch (error) {
        await connection.rollback();
        logger.error('Error saving QC verification:', error);
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Get QC history for an appointment
 * @param {number} appointmentId 
 */
async function getQCHistory(appointmentId) {
    const sql = `
        SELECT 
            qch.*,
            u.full_name,
            r.role_name
        FROM appointment_qc_history qch
        LEFT JOIN users u ON qch.qc_by = u.id
        LEFT JOIN roles r ON u.role_id = r.id
        WHERE qch.appointment_id = ?
        ORDER BY qch.created_at DESC
    `;

    const rows = await db.query(sql, [appointmentId]);
    return rows;
}

/**
 * QC all Appointment history
 */

async function getAllQcHistory({
    page = 1,
    limit = 10,
    search = '',
    sortBy = 'created_at',
    sortOrder = 'DESC'
}) {
    const allowedSortColumns = [
        'id', 'appointment_id', 'action', 'qc_by', 'created_at'
    ];
    const validSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const validSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const conditions = [];
    const params = [];

    // Search (on remarks OR action OR user name)
    if (search) {
        conditions.push(`
            (
                h.remarks LIKE ? OR 
                h.action LIKE ? OR
                u.full_name LIKE ?
            )
        `);
        const like = `%${search}%`;
        params.push(like, like, like);
    }

    const whereClause = conditions.length > 0
        ? `WHERE ${conditions.join(" AND ")}`
        : '';

    // Count total rows
    const countSql = `
        SELECT COUNT(*) AS total
        FROM appointment_qc_history h
        LEFT JOIN users u ON h.qc_by = u.id
        LEFT JOIN appointments a ON h.appointment_id = a.id
        ${whereClause}
    `;
    const countRows = await db.query(countSql, params);
    const total = countRows[0]?.total || 0;

    // Pagination
    const numericLimit = Number(limit);
    const numericPage = Number(page);
    const offset = numericLimit > 0 ? (numericPage - 1) * numericLimit : 0;

    // Main data query
    const dataSql = `
        SELECT 
            h.*,
            u.full_name AS qc_by_name,
            r.role_name,
            a.application_number,
            a.case_number
        FROM appointment_qc_history h
        LEFT JOIN users u ON h.qc_by = u.id
        LEFT JOIN roles r ON u.role_id = r.id
        LEFT JOIN appointments a ON h.appointment_id = a.id
        ${whereClause}
        ORDER BY h.${validSortBy} ${validSortOrder}
        LIMIT ${numericLimit} OFFSET ${offset}
    `;

    const rows = await db.query(dataSql, params);

    const formattedRows = rows.map(r => ({
        ...r,
        formatted_date: formatDateDDMMYYYY(r.created_at),
        formatted_time: formatTimeAMPM(r.created_at)
    }));

    return {
        data: formattedRows,
        pagination: {
            total,
            page: numericPage,
            limit: numericLimit,
            pages: numericLimit > 0 ? Math.ceil(total / numericLimit) : 1,
        }
    };
}



module.exports = {
    listQCPendingAppointments,
    getQCAppointmentDetails,
    pushBackToReports,
    saveQCVerification,
    getQCHistory,
    getAllQcHistory
};
