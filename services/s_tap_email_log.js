const db = require('../lib/dbconnection');
const logger = require('../lib/logger');

/**
 * Log TPA email sent
 * @param {number} appointmentId - Appointment ID
 * @param {number} clientId - TPA/Client ID who received the email
 * @param {Array} emailRecipients - Array of email addresses that received this email
 * @param {number} sentBy - User ID who sent the email
 * @param {string} status - Email status ('sent' or 'failed')
 * @param {string} errorMessage - Error message if failed
 * @returns {Promise<Object>} Log result
 */
async function logTpaEmail(appointmentId, clientId, emailRecipients, sentBy, status = 'sent', errorMessage = null) {
    try {
        const [result] = await db.query(`
            INSERT INTO tpa_email_log (appointment_id, client_id, email_recipients, sent_by, status, error_message)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [appointmentId, clientId, JSON.stringify(emailRecipients), sentBy, status, errorMessage]);

        logger.info('TPA email logged', {
            logId: result.insertId,
            appointmentId,
            clientId,
            emailRecipients,
            status,
            sentBy
        });

        return {
            success: true,
            logId: result.insertId
        };

    } catch (error) {
        logger.error('Error logging TPA email', {
            error: error.message,
            appointmentId,
            clientId,
            emailRecipients,
            sentBy
        });
        throw new Error('Failed to log TPA email');
    }
}

/**
 * Get TPA email statistics for QC page
 * @returns {Promise<Object>} Statistics
 */
async function getTpaEmailStats() {
    try {
        const [stats] = await db.query(`
            SELECT 
                COUNT(*) as total_sent,
                COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
                COUNT(DISTINCT appointment_id) as unique_appointments,
                COUNT(DISTINCT client_id) as unique_tpas,
                DATE(MAX(sent_at)) as last_sent_date,
                TIME(MAX(sent_at)) as last_sent_time
            FROM tpa_email_log 
            WHERE is_deleted = 0
        `);

        return stats[0] || {
            total_sent: 0,
            successful: 0,
            failed: 0,
            unique_appointments: 0,
            unique_tpas: 0,
            last_sent_date: null,
            last_sent_time: null
        };

    } catch (error) {
        logger.error('Error fetching TPA email stats', { error: error.message });
        throw new Error('Failed to fetch TPA email statistics');
    }
}

/**
 * Get TPA email logs for an appointment
 * @param {number} appointmentId - Appointment ID
 * @returns {Promise<Array>} Email logs
 */
async function getTpaEmailLogs(appointmentId) {
    try {
        const rows = await db.query(`
            SELECT 
                tel.*,
                u.full_name as sent_by_name,
                c.client_name,
                c.client_code,
                c.email_id as client_email,
                c.email_id_2 as client_email_2,
                c.email_id_3 as client_email_3
            FROM tpa_email_log tel
            JOIN users u ON tel.sent_by = u.id
            LEFT JOIN clients c ON tel.client_id = c.id
            WHERE tel.appointment_id = ? AND tel.is_deleted = 0
            ORDER BY tel.sent_at DESC
        `, [appointmentId]);

        // Parse email recipients
        return rows.map(row => ({
            ...row,
            email_recipients: row.email_recipients ? JSON.parse(row.email_recipients) : []
        }));

    } catch (error) {
        logger.error('Error fetching TPA email logs', {
            error: error.message,
            appointmentId
        });
        throw new Error('Failed to fetch TPA email logs');
    }
}

module.exports = {
    logTpaEmail,
    getTpaEmailStats,
    getTpaEmailLogs
};
