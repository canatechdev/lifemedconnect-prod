const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

const CENTER_ROLE_ID = 3;
const TECHNICIAN_ROLE_ID = 4;

function parseTestsData(tests) {
    try {
        if (!tests) return [];
        if (Array.isArray(tests)) return tests;
        if (typeof tests === 'object') return [tests];
        if (typeof tests === 'string') {
            const trimmed = tests.trim();
            if (!trimmed) return [];
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [parsed];
        }
        return [];
    } catch (error) {
        logger.error('Error parsing tests data (app)', { error: error.message });
        return [];
    }
}

/**
 * Resolve whether a user is a technician or center, and return their scoped id.
 * Returns { type: 'technician', technicianId } or { type: 'center', centerId } or null.
 */
async function resolveAppScope(userId) {
    const rows = await db.query(
        `SELECT u.role_id, t.id AS technician_id, dc.id AS center_id
         FROM users u
         LEFT JOIN technicians t ON u.id = t.user_id AND t.is_deleted = 0
         LEFT JOIN diagnostic_centers dc ON u.id = dc.user_id AND dc.is_deleted = 0
         WHERE u.id = ? AND u.is_deleted = 0 LIMIT 1`,
        [userId]
    );
    const row = rows[0];
    if (!row) return null;
    if (Number(row.role_id) === CENTER_ROLE_ID && row.center_id) {
        return { type: 'center', centerId: row.center_id };
    }
    if (Number(row.role_id) === TECHNICIAN_ROLE_ID && row.technician_id) {
        return { type: 'technician', technicianId: row.technician_id };
    }
    return null;
}

async function getTechnicianIdByUser(userId) {
    const rows = await db.query(
        'SELECT id FROM technicians WHERE user_id = ? AND is_deleted = 0 LIMIT 1',
        [userId]
    );
    return rows[0]?.id || null;
}

/**
 * Apply optional extra filters: fromDate, toDate, visitType.
 * confirmDateExpr is the SQL expression representing the confirmed date for the scope.
 */
function applyExtraFilters(conditions, params, { fromDate, toDate, visitType }, confirmDateExpr) {
    if (visitType) {
        conditions.push(`a.visit_type = ?`);
        params.push(visitType);
    }
    if (fromDate) {
        conditions.push(`DATE(${confirmDateExpr}) >= ?`);
        params.push(fromDate);
    }
    if (toDate) {
        conditions.push(`DATE(${confirmDateExpr}) <= ?`);
        params.push(toDate);
    }
}

async function listAppointments({ userId, page = 1, limit = 10, search = '', upcomingOnly = false, todayOnly = false, statusGroup = null, fromDate = '', toDate = '', visitType = '' }) {
    const scope = await resolveAppScope(userId);
    if (!scope) {
        return { data: [], pagination: { total: 0, page, limit, pages: 0 } };
    }

    const isCenter = scope.type === 'center';

    const searchParams = [];
    const conditions = [];

    // --- Scope ownership filter ---
    if (isCenter) {
        // Center sees appointments where they are center_id (Center_Visit / Home_Visit)
        // OR other_center_id (home side of Both visit)
        conditions.push('(a.center_id = ? OR a.other_center_id = ?)');
        searchParams.push(scope.centerId, scope.centerId);
    } else {
        // Technician sees appointments where at least one test is assigned to them
        conditions.push('at.assigned_technician_id = ?');
        searchParams.push(scope.technicianId);
    }

    if (search) {
        conditions.push(`(
            a.case_number LIKE ? OR
            a.customer_first_name LIKE ? OR
            a.customer_last_name LIKE ?
        )`);
        const like = `%${search}%`;
        searchParams.push(like, like, like);
    }

    // For Both visits a center may be the center side (center_id) or home side (other_center_id).
    // These CASE expressions dynamically pick the correct column per-appointment per-center.
    const cid = isCenter ? scope.centerId : null;

    // Confirmed date expression
    const confirmDateExpr = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN a.center_confirmed_at
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN a.home_confirmed_at
             ELSE a.confirmed_date
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN a.home_confirmed_at ELSE a.confirmed_date END`;

    // Medical status expression
    const medStatusExpr = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN a.center_medical_status
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN a.home_medical_status
             ELSE a.medical_status
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN a.home_medical_status ELSE a.medical_status END`;

    // Pushed-back expression
    const pushedBackExpr = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN (a.center_pushed_back = 0 OR a.center_pushed_back IS NULL)
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN (a.home_pushed_back = 0 OR a.home_pushed_back IS NULL)
             ELSE (a.center_pushed_back = 0 OR a.center_pushed_back IS NULL)
           END`
        : null;

    if (todayOnly) {
        conditions.push(`DATE(CONVERT_TZ(${confirmDateExpr}, '+00:00', '+05:30')) = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+05:30'))`);
        conditions.push(`(${medStatusExpr} NOT IN ('medical_completed', 'completed') OR ${medStatusExpr} IS NULL)`);
        conditions.push(`a.status NOT IN ('completed', 'medical_completed')`);
    } else if (upcomingOnly) {
        conditions.push(`${confirmDateExpr} IS NOT NULL`);
        conditions.push(`${confirmDateExpr} > CURDATE()`);
        conditions.push(`(${medStatusExpr} NOT IN ('medical_completed', 'completed') OR ${medStatusExpr} IS NULL)`);
        conditions.push(`a.status NOT IN ('completed', 'medical_completed')`);
    }

    if (statusGroup === 'completed') {
        conditions.push(`(${medStatusExpr} IN ('completed', 'medical_completed'))`);
    } else if (statusGroup === 'pending') {
        conditions.push(`(${medStatusExpr} NOT IN ('completed', 'medical_completed') OR ${medStatusExpr} IS NULL)`);
        conditions.push(`a.status NOT IN ('completed', 'medical_completed')`);
    }

    conditions.push('a.is_deleted = 0');
    conditions.push(`${confirmDateExpr} IS NOT NULL`);
    // Exclude pushed back appointments
    if (isCenter) {
        conditions.push(pushedBackExpr);
    } else {
        conditions.push('(a.pushed_back = 0 OR a.pushed_back IS NULL)');
        conditions.push('a.status != "pushed_back"');
    }

    // Extra filters: fromDate, toDate, visitType
    applyExtraFilters(conditions, searchParams, { fromDate, toDate, visitType }, confirmDateExpr);

    const joinClause = isCenter
        ? `FROM appointments a LEFT JOIN appointment_tests at ON a.id = at.appointment_id`
        : `FROM appointments a JOIN appointment_tests at ON a.id = at.appointment_id`;

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countSql = `
        SELECT COUNT(DISTINCT a.id) as total
        ${joinClause}
        ${whereClause}
    `;

    // Medical status to display
    const medStatusSelect = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN a.center_medical_status
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN a.home_medical_status
             ELSE a.medical_status
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN a.home_medical_status ELSE a.medical_status END`;

    // Confirmed date/time to display
    const confirmedDateSelect = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN DATE_FORMAT(a.center_confirmed_at, '%d-%m-%Y')
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN DATE_FORMAT(a.home_confirmed_at, '%d-%m-%Y')
             ELSE DATE_FORMAT(a.confirmed_date, '%d-%m-%Y')
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN DATE_FORMAT(a.home_confirmed_at, '%d-%m-%Y') ELSE DATE_FORMAT(a.confirmed_date, '%d-%m-%Y') END`;

    const confirmedTimeSelect = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN DATE_FORMAT(a.center_confirmed_at, '%h:%i %p')
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN DATE_FORMAT(a.home_confirmed_at, '%h:%i %p')
             ELSE DATE_FORMAT(CONCAT(CURRENT_DATE(), ' ', COALESCE(a.confirmed_time, '00:00:00')), '%h:%i %p')
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN DATE_FORMAT(a.home_confirmed_at, '%h:%i %p') ELSE DATE_FORMAT(CONCAT(CURRENT_DATE(), ' ', COALESCE(a.confirmed_time, '00:00:00')), '%h:%i %p') END`;

    // Order by closest upcoming confirm date
    const orderExpr = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), a.center_confirmed_at)
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), a.home_confirmed_at)
             ELSE TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CONCAT(a.confirmed_date, ' ', COALESCE(a.confirmed_time, '00:00:00')))
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), a.home_confirmed_at) ELSE CASE WHEN a.confirmed_date IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CONCAT(a.confirmed_date, ' ', COALESCE(a.confirmed_time, '00:00:00'))) ELSE TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CONCAT(a.appointment_date, ' ', COALESCE(a.appointment_time, '00:00:00'))) END END`;

    const dataSql = `
        SELECT
            a.id,
            a.case_number,
            a.application_number,
            a.client_id,
            a.center_id,
            dc.center_name AS center_name,
            a.other_center_id,
            odc.center_name AS other_center_name,
            a.insurer_id,
            i.insurer_name,
            a.visit_type,
            DATE_FORMAT(a.appointment_date, '%d-%m-%Y') AS appointment_date,
            CASE
                WHEN a.appointment_time REGEXP '^[0-9]{2}:[0-9]{2}:[0-9]{2}$'
                THEN DATE_FORMAT(CONCAT(CURRENT_DATE(), ' ', a.appointment_time), '%h:%i %p')
                ELSE a.appointment_time
            END AS appointment_time,
            ${confirmedDateSelect} AS confirmed_date,
            ${confirmedTimeSelect} AS confirmed_time,
            ${medStatusSelect} AS medical_status,
            a.center_medical_status,
            a.home_medical_status,
            a.split_type,
            a.status AS appointment_status,
            a.reschedule_remark,
            a.center_reschedule_remark,
            a.home_reschedule_remark,
            a.customer_first_name,
            a.customer_last_name,
            a.customer_mobile,
            a.customer_address,
            a.customer_landmark,
            a.city,
            a.state,
            a.pincode,
            a.pushed_back,
            a.center_pushed_back,
            c.client_name,
            COALESCE(
                (SELECT JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'id', at2.id,
                        'test_id', at2.test_id,
                        'category_id', at2.category_id,
                        'rate_type', at2.rate_type,
                        'item_name', at2.item_name,
                        'rate', at2.rate,
                        'visit_subtype', at2.visit_subtype,
                        'assigned_center_id', at2.assigned_center_id,
                        'assigned_technician_id', at2.assigned_technician_id,
                        'status', at2.status,
                        'is_completed', at2.is_completed,
                        'description', COALESCE(t2.description, tc2.description)
                    )
                )
                FROM appointment_tests at2
                LEFT JOIN tests t2 ON at2.test_id = t2.id
                LEFT JOIN test_categories tc2 ON at2.category_id = tc2.id
                WHERE at2.appointment_id = a.id),
                JSON_ARRAY()
            ) as tests
        FROM appointments a
        LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
        LEFT JOIN diagnostic_centers odc ON a.other_center_id = odc.id
        LEFT JOIN clients c ON a.client_id = c.id
        LEFT JOIN insurers i ON a.insurer_id = i.id
        ${isCenter ? '' : 'JOIN appointment_tests at ON a.id = at.appointment_id'}
        ${whereClause}
        GROUP BY a.id
        ORDER BY ${orderExpr} ASC
    `;

    const countRows = await db.query(countSql, searchParams);
    const total = countRows[0]?.total || 0;

    const numericLimit = Number(limit);
    const numericPage = Number(page);
    const offset = numericLimit > 0 ? (numericPage - 1) * numericLimit : 0;

    let paginatedSql = dataSql;
    if (numericLimit > 0) {
        paginatedSql += ` LIMIT ${numericLimit} OFFSET ${offset}`;
    }

    let rows = await db.query(paginatedSql, searchParams);
    rows = rows.map(row => ({
        ...row,
        tests: parseTestsData(row.tests)
    }));

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

// Backward-compat alias used by dashboard
async function listTechnicianAppointments(params) {
    return listAppointments(params);
}

async function getAppointmentDetails({ userId, appointmentId }) {
    const scope = await resolveAppScope(userId);
    if (!scope) return null;

    const isCenter = scope.type === 'center';
    const cid = isCenter ? scope.centerId : null;

    // For Both visits: pick correct side columns based on which center column matches this center
    const medStatusSelect = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN a.center_medical_status
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN a.home_medical_status
             ELSE a.medical_status
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN a.home_medical_status ELSE a.medical_status END`;

    const confirmedDateSelect = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN DATE_FORMAT(a.center_confirmed_at, '%d-%m-%Y')
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN DATE_FORMAT(a.home_confirmed_at, '%d-%m-%Y')
             ELSE DATE_FORMAT(a.confirmed_date, '%d-%m-%Y')
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN DATE_FORMAT(a.home_confirmed_at, '%d-%m-%Y') ELSE DATE_FORMAT(a.confirmed_date, '%d-%m-%Y') END`;

    const confirmedTimeSelect = isCenter
        ? `CASE
             WHEN LOWER(a.visit_type) = 'both' AND a.center_id = ${cid} THEN DATE_FORMAT(a.center_confirmed_at, '%h:%i %p')
             WHEN LOWER(a.visit_type) = 'both' AND a.other_center_id = ${cid} THEN DATE_FORMAT(a.home_confirmed_at, '%h:%i %p')
             ELSE DATE_FORMAT(CONCAT(CURRENT_DATE(), ' ', COALESCE(a.confirmed_time, '00:00:00')), '%h:%i %p')
           END`
        : `CASE WHEN LOWER(a.visit_type) = 'both' THEN DATE_FORMAT(a.home_confirmed_at, '%h:%i %p') ELSE DATE_FORMAT(CONCAT(CURRENT_DATE(), ' ', COALESCE(a.confirmed_time, '00:00:00')), '%h:%i %p') END`;

    // Ownership filter for detail query: center sees center_id OR other_center_id
    const ownershipWhere = isCenter
        ? `(a.center_id = ${cid} OR a.other_center_id = ${cid})`
        : `1=1`; // already scoped by join

    const rows = await db.query(
        `SELECT
            a.id,
            a.case_number,
            a.application_number,
            a.client_id,
            c.client_name,
            a.center_id,
            dc.center_name AS center_name,
            a.other_center_id,
            odc.center_name AS other_center_name,
            a.insurer_id,
            i.insurer_name,
            a.visit_type,
            DATE_FORMAT(a.appointment_date, '%d-%m-%Y') AS appointment_date,
            CASE
                WHEN a.appointment_time REGEXP '^[0-9]{2}:[0-9]{2}:[0-9]{2}$'
                THEN DATE_FORMAT(CONCAT(CURRENT_DATE(), ' ', a.appointment_time), '%h:%i %p')
                ELSE a.appointment_time
            END AS appointment_time,
            ${confirmedDateSelect} AS confirmed_date,
            ${confirmedTimeSelect} AS confirmed_time,
            ${medStatusSelect} AS medical_status,
            a.center_medical_status,
            a.home_medical_status,
            a.split_type,
            a.status AS appointment_status,
            a.reschedule_remark,
            a.center_reschedule_remark,
            a.home_reschedule_remark,
            a.customer_first_name,
            a.customer_last_name,
            a.customer_mobile,
            a.customer_address,
            a.customer_landmark,
            a.city,
            a.state,
            a.pincode,
            a.customer_gps_latitude,
            a.customer_gps_longitude,
            a.pushed_back,
            a.center_pushed_back,
            a.pending_report_types,
            a.medical_remarks,
            COALESCE(
                (SELECT JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'id', at2.id,
                        'test_id', at2.test_id,
                        'category_id', at2.category_id,
                        'rate_type', at2.rate_type,
                        'item_name', at2.item_name,
                        'rate', at2.rate,
                        'visit_subtype', at2.visit_subtype,
                        'assigned_center_id', at2.assigned_center_id,
                        'assigned_technician_id', at2.assigned_technician_id,
                        'status', at2.status,
                        'is_completed', at2.is_completed,
                        'description', COALESCE(t2.description, tc2.description)
                    )
                )
                FROM appointment_tests at2
                LEFT JOIN tests t2 ON at2.test_id = t2.id
                LEFT JOIN test_categories tc2 ON at2.category_id = tc2.id
                WHERE at2.appointment_id = a.id),
                JSON_ARRAY()
            ) as tests
        FROM appointments a
        LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
        LEFT JOIN diagnostic_centers odc ON a.other_center_id = odc.id
        LEFT JOIN clients c ON a.client_id = c.id
        LEFT JOIN insurers i ON a.insurer_id = i.id
        WHERE a.id = ? AND a.is_deleted = 0 AND ${ownershipWhere}
        LIMIT 1`,
        [appointmentId]
    );

    if (!rows.length) return null;

    return {
        ...rows[0],
        tests: parseTestsData(rows[0].tests)
    };
}

/**
 * Scope-aware ownership check for actions (push-back, reschedule, status update).
 * Returns { scope, actorContext, owns }
 */
async function getAppScopeForAppointment(appointmentId, userId) {
    const scope = await resolveAppScope(userId);
    if (!scope) return { scope: null, actorContext: null, owns: false };

    if (scope.type === 'center') {
        const rows = await db.query(
            `SELECT center_id, other_center_id, visit_type
             FROM appointments
             WHERE id = ? AND (center_id = ? OR other_center_id = ?) AND is_deleted = 0
             LIMIT 1`,
            [appointmentId, scope.centerId, scope.centerId]
        );
        if (!rows.length) {
            return { scope, actorContext: { type: 'center', centerId: scope.centerId, side: null }, owns: false };
        }

        const row = rows[0];
        const side = row.center_id === scope.centerId ? 'center' : 'home';
        const actorContext = { type: 'center', centerId: scope.centerId, side, visitType: row.visit_type };
        return { scope, actorContext, owns: true };
    } else {
        const rows = await db.query(
            `SELECT 1
             FROM appointment_tests at
             JOIN appointments a ON a.id = at.appointment_id
             WHERE at.appointment_id = ?
               AND at.assigned_technician_id = ?
               AND a.is_deleted = 0
             LIMIT 1`,
            [appointmentId, scope.technicianId]
        );
        const actorContext = { type: 'technician', technicianId: scope.technicianId, side: 'home' };
        return { scope, actorContext, owns: rows.length > 0 };
    }
}

// Legacy alias for backward compatibility
async function getTechnicianContextForAppointment(appointmentId, userId) {
    const technicianId = await getTechnicianIdByUser(userId);
    if (!technicianId) return { technicianId: null, owns: false };
    const rows = await db.query(
        `SELECT 1 FROM appointment_tests at JOIN appointments a ON a.id = at.appointment_id
         WHERE at.appointment_id = ? AND at.assigned_technician_id = ? AND a.is_deleted = 0 LIMIT 1`,
        [appointmentId, technicianId]
    );
    return { technicianId, owns: rows.length > 0 };
}

module.exports = {
    listAppointments,
    listTechnicianAppointments,
    resolveAppScope,
    getTechnicianIdByUser,
    getAppointmentDetails,
    getAppScopeForAppointment,
    getTechnicianContextForAppointment,
    // Convenience wrapper for today
    listTechnicianTodayAppointments: (params) => listTechnicianAppointments({ ...params, todayOnly: true }),
};
