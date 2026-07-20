/**
 * Appointment Categorized Reports Management
 * Handles 5 report types: pathology, cardiology, sonography, mer, mtrf
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

/**
 * Upload categorized report files
 * @param {number} appointmentId 
 * @param {string} reportType - pathology, cardiology, sonography, mer, mtrf
 * @param {Array} filesMeta - Array of file metadata objects
 * @param {number} userId 
 */
async function uploadCategorizedReports(appointmentId, reportType, filesMeta, userId) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        // Validate report type
        const validTypes = ['pathology', 'cardiology', 'radiology', 'mer', 'mtrf', 'other'];
        if (!validTypes.includes(reportType)) {
            throw new Error(`Invalid report type: ${reportType}`);
        }

        // Insert new reports
        if (filesMeta && filesMeta.length > 0) {
            const insertSql = `
                INSERT INTO appointment_categorized_reports 
                (appointment_id, report_type, file_path, file_name, file_size, uploaded_by, uploaded_at)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
            `;

            for (const file of filesMeta) {
                const filePath = typeof file === 'string' ? file : file.file_path;
                const fileName = typeof file === 'string'
                    ? (filePath ? filePath.split('/').pop() : null)
                    : (file.file_name || (filePath ? filePath.split('/').pop() : null));
                const fileSize = typeof file === 'string'
                    ? null
                    : (file.file_size !== undefined ? file.file_size : null);

                await connection.query(insertSql, [
                    appointmentId,
                    reportType,
                    filePath,
                    fileName,
                    fileSize,
                    userId
                ]);
            }
        }

        // Log QC history for uploads (summary)
        // if (filesMeta && filesMeta.length > 0) {
        //     const remarks = `Uploaded ${filesMeta.length} ${reportType} report(s)`;
        //     await connection.query(`
        //         INSERT INTO appointment_qc_history 
        //         (appointment_id, action, remarks, qc_by, created_at)
        //         VALUES (?, 'report_uploaded', ?, ?, NOW())
        //     `, [appointmentId, remarks, userId]);
        // }

        await connection.commit();
        logger.info('Categorized reports uploaded', { appointmentId, reportType, count: filesMeta.length });
        return { success: true, message: 'Reports uploaded successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error uploading categorized reports:', error);
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Get all categorized reports for an appointment (grouped by type)
 * @param {number} appointmentId 
 * @param {number|null} centerId - Optional: filter reports by center for Both appointments
 * @param {number|null} userId - Optional: filter reports by uploader for DC users
 * @param {string|null} userRole - Optional: user role to determine filtering behavior
 */
async function getCategorizedReports(appointmentId, centerId = null, userId = null, userRole = null) {
    // Get appointment details to check visit type
    const appointmentSql = 'SELECT visit_type FROM appointments WHERE id = ?';
    const appointmentRows = await db.query(appointmentSql, [appointmentId]);
    
    const visitType = appointmentRows && appointmentRows.length > 0 ? appointmentRows[0].visit_type : null;
    
    // For Both appointments with centerId, filter reports by assigned_center_id
    let sqlReports = `
        SELECT 
            acr.id,
            acr.appointment_id,
            acr.report_type,
            acr.file_path,
            acr.file_name,
            acr.file_size,
            acr.uploaded_by,
            acr.uploaded_at,
            u.full_name as uploaded_by_name
        FROM appointment_categorized_reports acr
        LEFT JOIN users u ON acr.uploaded_by = u.id
        WHERE acr.appointment_id = ? AND acr.is_deleted = 0
    `;

    const params = [appointmentId];

    const shouldFilter = visitType === 'Both' && userId && userRole && userRole !== 'Admin' && userRole !== 'Super Admin' && userRole !== 'TPA';
    
    if (shouldFilter) {
        sqlReports += ` AND acr.uploaded_by = ?`;
        params.push(userId);
    }

    // If centerId is provided, join with appointment_tests to filter by assigned_center_id
    if (centerId) {
        sqlReports = `
            SELECT DISTINCT
                acr.id,
                acr.appointment_id,
                acr.report_type,
                acr.file_path,
                acr.file_name,
                acr.file_size,
                acr.uploaded_by,
                acr.uploaded_at,
                u.full_name as uploaded_by_name
            FROM appointment_categorized_reports acr
            INNER JOIN appointment_tests at ON acr.appointment_id = at.appointment_id
            LEFT JOIN tests t ON at.test_id = t.id
            LEFT JOIN test_categories tc ON at.category_id = tc.id
            LEFT JOIN users u ON acr.uploaded_by = u.id
            WHERE acr.appointment_id = ? 
                AND acr.is_deleted = 0
                AND at.assigned_center_id = ?
                AND (
                    (t.report_type = acr.report_type) OR 
                    (tc.report_type = acr.report_type) OR
                    (t.report_type IS NULL AND tc.report_type IS NULL)
                )
        `;

        params.length = 0;
        params.push(appointmentId, centerId);
        
        // Add userId filtering for DC users in the second query too (only for "Both" visit type)
        if (visitType === 'Both' && userId && userRole && userRole !== 'Admin' && userRole !== 'Super Admin' && userRole !== 'TPA') {
            sqlReports += ` AND acr.uploaded_by = ?`;
            params.push(userId);
        }
    }

    sqlReports += ` ORDER BY acr.report_type, acr.uploaded_at DESC`;

    const rows = await db.query(sqlReports, params);

    // Query latest remarks from QC history
    const sqlRemarks = `
        SELECT remarks
        FROM appointment_qc_history
        WHERE appointment_id = ?
        ORDER BY created_at DESC
        LIMIT 1
    `;

    const remarkRow = await db.query(sqlRemarks, [appointmentId]);
    const latestRemarks = remarkRow.length ? remarkRow[0].remarks : null;

    // Group reports by type
    const grouped = {
        pathology: [],
        cardiology: [],
        radiology: [],
        mer: [],
        mtrf: [],
        other: [],
        remarks: latestRemarks
    };

    rows.forEach(row => {
        if (grouped[row.report_type]) {
            grouped[row.report_type].push(row);
        }
    });

    return grouped;
}


/**
 * Submit reports for QC
 * Sets qc_status = 'pending' and status = 'qc_pending'
 * @param {number} appointmentId 
 * @param {number} userId 
 */
async function submitReportsForQC(appointmentId, userId) {
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

        // Get the LATEST checkbox values from QC history
        const [latestQC] = await connection.query(`
            SELECT 
                pathology_checked, 
                cardiology_checked, 
                radiology_checked, 
                mer_checked, 
                mtrf_checked,
                other_checked
            FROM appointment_qc_history 
            WHERE appointment_id = ? 
            ORDER BY created_at DESC 
            LIMIT 1
        `, [appointmentId]);

        // Use previous values or default to 0 if no history exists
        const prev = latestQC && latestQC.length > 0 ? latestQC[0] : {};
        const pathology = prev.pathology_checked !== undefined ? prev.pathology_checked : 0;
        const cardiology = prev.cardiology_checked !== undefined ? prev.cardiology_checked : 0;
        const radiology = prev.radiology_checked !== undefined ? prev.radiology_checked : 0;
        const mer = prev.mer_checked !== undefined ? prev.mer_checked : 0;
        const mtrf = prev.mtrf_checked !== undefined ? prev.mtrf_checked : 0;
        const other = prev.other_checked !== undefined ? prev.other_checked : 0;


        // Update appointment: qc_status = 'pending', status = 'qc_pending'
        await connection.query(`
            UPDATE appointments 
            SET 
                qc_status = 'pending',
                status = 'qc_pending',
                updated_at = NOW(),
                updated_by = ?
            WHERE id = ?
        `, [userId, appointmentId]);

        // Log status history
        const { logStatusHistory } = require('./AppointmentFlow');
        await logStatusHistory(appointmentId, {
            old_status: currentRow.status || null,
            new_status: 'qc_pending',
            old_medical_status: currentRow.medical_status || null,
            new_medical_status: currentRow.medical_status || null,
            changed_by: userId,
            change_type: 'qc_submit',
            remarks: 'Reports submitted for QC',
            metadata: {
                qc_status: 'pending',
                preserved_checkboxes: {
                    pathology, cardiology, radiology, mer, mtrf, other
                }
            }
        }, connection);

        // Log QC history for submission
        await connection.query(`
            INSERT INTO appointment_qc_history 
            (appointment_id, action, remarks, qc_by, created_at,
             pathology_checked, cardiology_checked, radiology_checked, 
             mer_checked, mtrf_checked, other_checked)
            VALUES (?, 'submitted_for_qc', 'Reports submitted for QC', ?, NOW(),
                    ?, ?, ?, ?, ?, ?)
        `, [appointmentId, userId, pathology, cardiology, radiology, mer, mtrf, other]);

        await connection.commit();
        logger.info('Reports submitted for QC', {
            appointmentId,
            userId,
            preserved_checkboxes: { pathology, cardiology, radiology, mer, mtrf, other }
        });
        return { success: true, message: 'Reports submitted for QC successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error submitting reports for QC:', error);
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Delete a specific categorized report (soft delete)
 * @param {number} reportId 
 * @param {number} userId 
 */
async function deleteCategorizedReport(reportId, userId) {
    const sql = `
        UPDATE appointment_categorized_reports 
        SET is_deleted = 1 
        WHERE id = ?
    `;

    const result = await db.query(sql, [reportId]);

    if (result.affectedRows > 0) {
        logger.info('Categorized report deleted', { reportId, userId });
        return { success: true, message: 'Report deleted successfully' };
    } else {
        throw new Error('Report not found');
    }
}


/**
 * Get report counts by type for an appointment
 * @param {number} appointmentId 
 */
async function getReportCounts(appointmentId) {
    const sql = `
        SELECT 
            report_type,
            COUNT(*) as count
        FROM appointment_categorized_reports
        WHERE appointment_id = ? AND is_deleted = 0
        GROUP BY report_type
    `;

    const rows = await db.query(sql, [appointmentId]);

    const counts = {
        pathology: 0,
        cardiology: 0,
        radiology: 0,
        mer: 0,
        mtrf: 0,
        other: 0
    };

    rows.forEach(row => {
        counts[row.report_type] = row.count;
    });

    return counts;
}

module.exports = {
    uploadCategorizedReports,
    deleteCategorizedReport,
    getCategorizedReports,
    submitReportsForQC,
    getReportCounts
};
