/**
 * Read-only appointment directory for TPA integrations.
 * It exposes only the authenticated client's appointments and the identifiers
 * needed by the TPA reschedule/pushback endpoints.
 */

const db = require('../../lib/dbconnection');

function positiveInt(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function addLikeFilter(conditions, params, value) {
    if (!value) return;
    const like = `%${String(value).trim()}%`;
    conditions.push(`(
        a.case_number LIKE ? OR a.application_number LIKE ? OR
        a.customer_first_name LIKE ? OR a.customer_last_name LIKE ? OR
        a.customer_mobile LIKE ?
    )`);
    params.push(like, like, like, like, like);
}

function addDateFilter(conditions, params, field, from, to) {
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
        conditions.push(`a.${field} >= ?`);
        params.push(from);
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
        conditions.push(`a.${field} <= ?`);
        params.push(to);
    }
}

function formatReportType(value) {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) {
        const values = value.map(item => String(item).trim()).filter(Boolean);
        return values.length ? values.join(', ') : null;
    }

    const text = String(value).trim();
    if (!text) return null;

    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return formatReportType(parsed);
    } catch (_) {
        // Test report types are normally stored as plain text.
    }

    return text;
}

class TPAAppointmentDirectory {
    static async search(clientId, query = {}) {
        const page = positiveInt(query.page, 1);
        const limit = Math.min(100, positiveInt(query.limit, 25));
        const offset = (page - 1) * limit;
        const conditions = ['a.client_id = ?', 'a.is_deleted = 0'];
        const params = [clientId];

        if (query.appointment_id || query.appointmentId) {
            const appointmentId = positiveInt(query.appointment_id || query.appointmentId, 0);
            if (!appointmentId) {
                const error = new Error('appointment_id must be a positive number');
                error.statusCode = 400;
                throw error;
            }
            conditions.push('a.id = ?');
            params.push(appointmentId);
        }

        addLikeFilter(conditions, params, query.q || query.search);

        if (query.status) {
            conditions.push('a.status = ?');
            params.push(String(query.status).trim());
        }
        if (query.medical_status) {
            conditions.push('a.medical_status = ?');
            params.push(String(query.medical_status).trim());
        }

        addDateFilter(conditions, params, 'appointment_date', query.from_date, query.to_date);
        addDateFilter(conditions, params, 'created_at', query.created_from, query.created_to);

        const where = conditions.join(' AND ');
        const [countRows, appointmentRows] = await Promise.all([
            db.query(`SELECT COUNT(*) AS total FROM appointments a WHERE ${where}`, params),
            db.query(
                `SELECT
                    a.id, a.case_number, a.application_number,
                    a.customer_first_name, a.customer_last_name, a.gender,
                    a.customer_mobile, a.customer_email,
                    a.customer_address, a.city, a.state, a.pincode,
                    a.visit_type,
                    a.appointment_date, a.appointment_time,
                    a.confirmed_date, a.confirmed_time,
                    a.status, a.medical_status
                 FROM appointments a
                 WHERE ${where}
                 ORDER BY a.appointment_date DESC, a.id DESC
                 LIMIT ${limit} OFFSET ${offset}`,
                params
            )
        ]);

        const appointments = appointmentRows || [];
        const appointmentIds = appointments.map((appointment) => appointment.id);
        const itemsByAppointment = new Map(appointmentIds.map((id) => [id, []]));

        if (appointmentIds.length) {
            const placeholders = appointmentIds.map(() => '?').join(',');
            const itemRows = await db.query(
                `SELECT
                    ati.id AS appointment_test_id,
                    ati.appointment_id,
                    ati.test_id,
                    t.test_name,
                    t.report_type AS test_report_type,
                    ati.category_id,
                    tc.category_name,
                    tc.report_type AS category_report_type,
                    ati.item_name,
                    ati.rate_type,
                    ati.visit_subtype,
                    ati.status
                 FROM appointment_tests ati
                 LEFT JOIN tests t ON t.id = ati.test_id
                 LEFT JOIN test_categories tc ON tc.id = ati.category_id
                 WHERE ati.appointment_id IN (${placeholders})
                 ORDER BY ati.appointment_id, ati.id`,
                appointmentIds
            );
            (itemRows || []).forEach((item) => {
                const target = itemsByAppointment.get(item.appointment_id);
                if (!target) return;

                target.push({
                    appointment_test_id: item.appointment_test_id,
                    test_id: item.test_id,
                    test_name: item.test_name,
                    category_id: item.category_id,
                    category_name: item.category_name,
                    report_type: formatReportType(item.test_id
                        ? item.test_report_type
                        : item.category_report_type),
                    type: item.rate_type,
                    visit_subtype: item.visit_subtype,
                    status: item.status
                });
            });
        }

        const data = appointments.map((appointment) => ({
            ...appointment,
            test_items: itemsByAppointment.get(appointment.id) || []
        }));
        const total = Number(countRows?.[0]?.total || 0);

        return {
            data,
            pagination: {
                total,
                page,
                limit,
                pages: total ? Math.ceil(total / limit) : 0
            }
        };
    }
}

module.exports = TPAAppointmentDirectory;
