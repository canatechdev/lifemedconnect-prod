const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { getTechnicianIdByUser } = require('./s_app_appointments');

/**
 * Dashboard counts for technician (mobile app)
 * total, today, assigned (active), rejected (upcoming - label stays same for frontend)
 */
async function getTechnicianDashboardCounts(userId) {
    try {
        const { resolveAppScope } = require('./s_app_appointments');
        const scope = await resolveAppScope(userId);
        if (!scope) {
            return { total_appointments: 0, todays_appointments: 0, pending_appointments: 0, rejected_appointments: 0 };
        }

        const isCenter = scope.type === 'center';
        const cid = isCenter ? scope.centerId : null;

        // For Both visits: center may be center_id (center side) or other_center_id (home side)
        const confirmDateExpr = isCenter
            ? `CASE
                 WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN a.center_confirmed_at
                 WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN a.home_confirmed_at
                 ELSE a.confirmed_date
               END`
            : `CASE WHEN LOWER(a.visit_type) = 'both' THEN a.home_confirmed_at ELSE a.confirmed_date END`;

        const medStatusExpr = isCenter
            ? `CASE
                 WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN a.center_medical_status
                 WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN a.home_medical_status
                 ELSE a.medical_status
               END`
            : `CASE WHEN LOWER(a.visit_type) = 'both' THEN a.home_medical_status ELSE a.medical_status END`;

        const pushedBackExpr = isCenter
            ? `CASE
                 WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN (a.center_pushed_back = 0 OR a.center_pushed_back IS NULL)
                 WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN (a.home_pushed_back = 0 OR a.home_pushed_back IS NULL)
                 ELSE (a.center_pushed_back = 0 OR a.center_pushed_back IS NULL)
               END`
            : `(a.pushed_back = 0 OR a.pushed_back IS NULL) AND a.status != 'pushed_back'`;

        const scopeJoin = isCenter
            ? `FROM appointments a`
            : `FROM appointments a JOIN appointment_tests at ON a.id = at.appointment_id`;

        const scopeCondition = isCenter
            ? `(a.center_id = ? OR a.other_center_id = ?)`
            : `at.assigned_technician_id = ?`;

        // Center needs two params (centerId twice for OR), technician needs one
        const scopeParams = isCenter ? [scope.centerId, scope.centerId] : [scope.technicianId];

        const baseConditions = `
            ${scopeJoin}
            WHERE ${scopeCondition}
              AND a.is_deleted = 0
              AND ${confirmDateExpr} IS NOT NULL
              AND ${pushedBackExpr}
        `;

        const [totalRows, todayRows, pendingRows, rejectedRows] = await Promise.all([
            db.query(`SELECT COUNT(DISTINCT a.id) AS count ${baseConditions}`, scopeParams),
            db.query(`
                SELECT COUNT(DISTINCT a.id) AS count ${baseConditions}
                AND DATE(CONVERT_TZ(${confirmDateExpr}, '+00:00', '+05:30')) = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
                AND (${medStatusExpr} NOT IN ('completed', 'medical_completed') OR ${medStatusExpr} IS NULL)
                AND a.status NOT IN ('completed', 'medical_completed')
            `, scopeParams),
            db.query(`
                SELECT COUNT(DISTINCT a.id) AS count ${baseConditions}
                AND ${confirmDateExpr} IS NOT NULL
                AND a.status NOT IN ('cancelled', 'completed', 'medical_completed')
                AND (${medStatusExpr} NOT IN ('completed', 'medical_completed') OR ${medStatusExpr} IS NULL)
            `, scopeParams),
            db.query(`
                SELECT COUNT(DISTINCT a.id) AS count ${baseConditions}
                AND DATE(CONVERT_TZ(${confirmDateExpr}, '+00:00', '+05:30')) > DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))
                AND (${medStatusExpr} NOT IN ('completed', 'medical_completed') OR ${medStatusExpr} IS NULL)
                AND a.status NOT IN ('completed', 'medical_completed', 'cancelled')
            `, scopeParams)
        ]);

        return {
            total_appointments: totalRows[0]?.count || 0,
            todays_appointments: todayRows[0]?.count || 0,
            pending_appointments: pendingRows[0]?.count || 0,
            rejected_appointments: rejectedRows[0]?.count || 0,
        };
    } catch (error) {
        logger.error('Error fetching dashboard counts', { error: error.message, userId });
        throw new Error('Failed to fetch dashboard counts');
    }
}

async function getTechnicianStats(userId) {
    try {
        const { resolveAppScope } = require('./s_app_appointments');
        const scope = await resolveAppScope(userId);

        if (!scope || scope.type === 'center') {
            // Centers don't have a per-appointment rate — return completed count only
            if (scope?.type === 'center') {
                const countResult = await db.query(
                    `SELECT COUNT(DISTINCT a.id) as count
                     FROM appointments a
                     WHERE (a.center_id = ? OR a.other_center_id = ?) AND a.is_deleted = 0
                       AND (
                         (a.center_id = ? AND a.center_medical_status IN ('completed', 'medical_completed')) OR
                         (a.other_center_id = ? AND a.home_medical_status IN ('completed', 'medical_completed')) OR
                         a.medical_status IN ('completed', 'medical_completed')
                       )`,
                    [scope.centerId, scope.centerId, scope.centerId, scope.centerId]
                );
                return {
                    rate_per_appointment: 0,
                    completed_count: countResult[0]?.count || 0,
                    total_earnings: 0
                };
            }
            return { rate_per_appointment: 0, completed_count: 0, total_earnings: 0 };
        }

        const rows = await db.query(
            'SELECT id, rate_per_appointment FROM technicians WHERE id = ? AND is_deleted = 0 LIMIT 1',
            [scope.technicianId]
        );
        const technician = rows[0];
        if (!technician) {
            return { rate_per_appointment: 0, completed_count: 0, total_earnings: 0 };
        }

        const rate = technician.rate_per_appointment ? Number(technician.rate_per_appointment) : 0;

        const countResult = await db.query(
            `SELECT COUNT(DISTINCT a.id) as count
             FROM appointments a
             JOIN appointment_tests at ON a.id = at.appointment_id
             WHERE at.assigned_technician_id = ?
               AND a.is_deleted = 0
               AND (
                   a.medical_status IN ('completed', 'medical_completed') OR
                   a.home_medical_status IN ('completed', 'medical_completed')
               )`,
            [technician.id]
        );
        const completedCount = countResult[0]?.count || 0;

        return {
            rate_per_appointment: rate,
            completed_count: completedCount,
            total_earnings: completedCount * rate
        };
    } catch (error) {
        logger.error('Error fetching stats', { error: error.message, userId });
        throw new Error('Failed to fetch stats');
    }
}

module.exports = {
    getTechnicianDashboardCounts,
    getTechnicianStats,
};
