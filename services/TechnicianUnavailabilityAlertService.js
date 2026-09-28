const db = require('../lib/dbconnection');
const emailService = require('../lib/emailService');
const logger = require('../lib/logger');

const ESCALATION_HOURS = Math.max(1, Number(process.env.TECHNICIAN_UNAVAILABILITY_ESCALATION_HOURS) || 3);
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
let monitorTimer = null;
let monitorRunning = false;

function normalizeSqlDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    const text = String(value || '').trim();
    const match = text.match(/^\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : text;
}

const scheduleDateSql = `
    CASE
        WHEN LOWER(COALESCE(a.visit_type, '')) = 'both'
             AND LOWER(COALESCE(at.visit_subtype, '')) = 'center'
            THEN DATE(COALESCE(a.center_confirmed_at, a.confirmed_date, a.appointment_date))
        WHEN LOWER(COALESCE(a.visit_type, '')) = 'both'
             AND LOWER(COALESCE(at.visit_subtype, '')) = 'home'
            THEN DATE(COALESCE(a.home_confirmed_at, a.confirmed_date, a.appointment_date))
        ELSE DATE(COALESCE(a.confirmed_date, a.appointment_date))
    END`;

const scheduleTimeSql = `
    CASE
        WHEN LOWER(COALESCE(a.visit_type, '')) = 'both'
             AND LOWER(COALESCE(at.visit_subtype, '')) = 'center'
            THEN COALESCE(TIME(a.center_confirmed_at), a.confirmed_time, a.appointment_time)
        WHEN LOWER(COALESCE(a.visit_type, '')) = 'both'
             AND LOWER(COALESCE(at.visit_subtype, '')) = 'home'
            THEN COALESCE(TIME(a.home_confirmed_at), a.confirmed_time, a.appointment_time)
        ELSE COALESCE(a.confirmed_time, a.appointment_time)
    END`;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
    }[character]));
}

function emailList(value) {
    return Array.from(new Set(String(value || '')
        .split(/[;,\s]+/)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))));
}

function affectedAppointmentWhere() {
    return `
        (at.assigned_technician_id IS NOT NULL OR a.assigned_technician_id = ?)
        AND a.is_deleted = 0
        AND COALESCE(a.is_active, 1) = 1
        AND COALESCE(at.is_completed, 0) = 0
        AND LOWER(COALESCE(at.status, 'pending')) NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'pushed_back')
        AND LOWER(COALESCE(a.status, 'pending')) NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'pushed_back')
        AND LOWER(COALESCE(a.medical_status, 'pending')) NOT IN ('completed', 'medical_completed', 'complete', 'pushed_back')
        AND ${scheduleDateSql} BETWEEN ? AND ?`;
}

async function getAffectedAppointments(technicianId, fromDate, toDate) {
    const normalizedFromDate = normalizeSqlDate(fromDate);
    const normalizedToDate = normalizeSqlDate(toDate);
    return db.query(`
        SELECT DISTINCT
            a.id AS appointment_id,
            a.case_number,
            a.application_number,
            CONCAT_WS(' ', a.customer_first_name, a.customer_last_name) AS customer_name,
            ${scheduleDateSql} AS scheduled_date,
            ${scheduleTimeSql} AS scheduled_time,
            CASE
                WHEN LOWER(COALESCE(a.medical_status, '')) = 'rescheduled'
                  OR a.confirmed_date IS NOT NULL
                  OR a.center_confirmed_at IS NOT NULL
                  OR a.home_confirmed_at IS NOT NULL
                THEN 'Confirmed / Rescheduled'
                ELSE 'Appointment date'
            END AS schedule_source,
            COALESCE(assigned_dc.id, primary_dc.id) AS assigned_center_id,
            COALESCE(assigned_dc.center_name, primary_dc.center_name) AS assigned_center_name,
            COALESCE(assigned_dc.email, primary_dc.email) AS assigned_center_email
        FROM appointments a
        LEFT JOIN appointment_tests at
            ON at.appointment_id = a.id
           AND at.assigned_technician_id = ?
        INNER JOIN technicians t ON t.id = ?
        LEFT JOIN diagnostic_centers assigned_dc ON assigned_dc.id = at.assigned_center_id
        LEFT JOIN diagnostic_centers primary_dc ON primary_dc.id = t.center_id
        WHERE ${affectedAppointmentWhere()}
        ORDER BY scheduled_date ASC, scheduled_time ASC, a.case_number ASC
    `, [technicianId, technicianId, technicianId, normalizedFromDate, normalizedToDate]);
}

async function getPeriod(periodId) {
    const rows = await db.query(`
        SELECT tu.id, tu.technician_id, tu.unavailable_from, tu.unavailable_to, tu.reason,
               t.full_name AS technician_name,
               primary_dc.id AS primary_center_id,
               primary_dc.center_name AS primary_center_name,
               primary_dc.email AS primary_center_email,
               tu.initial_dc_notified_at, tu.escalation_notified_at
        FROM technician_unavailability tu
        INNER JOIN technicians t ON t.id = tu.technician_id
        LEFT JOIN diagnostic_centers primary_dc ON primary_dc.id = t.center_id
        WHERE tu.id = ? AND tu.is_deleted = 0
        LIMIT 1
    `, [periodId]);
    return rows[0] || null;
}

function buildEmail({ title, period, appointments, actionText }) {
    const rows = appointments.map((appointment) => `
        <tr>
            <td>${escapeHtml(appointment.case_number)}</td>
            <td>${escapeHtml(appointment.application_number || '-')}</td>
            <td>${escapeHtml(appointment.customer_name || '-')}</td>
            <td>${escapeHtml(appointment.scheduled_date || '-')} ${escapeHtml(appointment.scheduled_time || '')}</td>
            <td>${escapeHtml(appointment.assigned_center_name || '-')}</td>
            <td>${escapeHtml(appointment.schedule_source)}</td>
        </tr>`).join('');
    const textRows = appointments.map((appointment) => (
        `${appointment.case_number} | ${appointment.application_number || '-'} | ${appointment.customer_name || '-'} | ${appointment.scheduled_date} ${appointment.scheduled_time || ''} | ${appointment.assigned_center_name || '-'} | ${appointment.schedule_source}`
    )).join('\n');
    const text = `${title}\n\nTechnician: ${period.technician_name}\nUnavailable: ${period.unavailable_from} to ${period.unavailable_to}\nReason: ${period.reason || 'No reason provided'}\n\n${actionText}\n\n${textRows}`;
    const html = `
        <div style="font-family:Arial,sans-serif;color:#1f2937">
            <h2>${escapeHtml(title)}</h2>
            <p><strong>Technician:</strong> ${escapeHtml(period.technician_name)}<br>
            <strong>Unavailable:</strong> ${escapeHtml(period.unavailable_from)} to ${escapeHtml(period.unavailable_to)}<br>
            <strong>Reason:</strong> ${escapeHtml(period.reason || 'No reason provided')}</p>
            <p>${escapeHtml(actionText)}</p>
            <table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#d1d5db;font-size:13px">
                <thead><tr><th>Case</th><th>Application</th><th>Customer</th><th>Scheduled</th><th>DC</th><th>Schedule</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    return { text, html };
}

async function sendInitialDcNotice(periodId, appointments) {
    const period = await getPeriod(periodId);
    logger.info('Technician unavailable DC notice evaluated', {
        periodId,
        appointmentCount: appointments.length,
        alreadySent: Boolean(period?.initial_dc_notified_at),
    });
    if (!period || period.initial_dc_notified_at || !appointments.length) return { sent: false, reason: 'not_required' };

    const recipients = emailList([
        period.primary_center_email,
        ...appointments.map((appointment) => appointment.assigned_center_email),
    ].filter(Boolean).join(','));
    if (!recipients.length) {
        logger.warn('Technician unavailable notice skipped: no relevant DC email', {
            periodId,
            primaryCenterId: period.primary_center_id,
            assignedCenterIds: Array.from(new Set(appointments.map((appointment) => appointment.assigned_center_id).filter(Boolean))),
        });
        return { sent: false, reason: 'no_recipients' };
    }

    logger.info('Sending technician unavailable DC notice', {
        periodId,
        appointmentCount: appointments.length,
        recipientCount: recipients.length,
    });

    const message = buildEmail({
        title: `Action required: technician unavailable - ${period.technician_name}`,
        period,
        appointments,
        actionText: 'Please review and reassign the listed active appointments during this unavailable period.',
    });
    const sent = await emailService.sendEmail({
        to: recipients.join(', '),
        subject: `Action required: ${period.technician_name} unavailable (${period.unavailable_from} to ${period.unavailable_to})`,
        ...message,
    });
    if (sent.success) {
        await db.query(`UPDATE technician_unavailability SET initial_dc_notified_at = NOW() WHERE id = ? AND initial_dc_notified_at IS NULL`, [periodId]);
    }
    return { sent: Boolean(sent.success), recipients, reason: sent.success ? null : sent.message };
}

async function runEscalationCheck() {
    if (monitorRunning) return;
    monitorRunning = true;
    try {
        const duePeriods = await db.query(`
            SELECT id, technician_id, unavailable_from, unavailable_to,
                   initial_dc_notified_at, escalation_notified_at
            FROM technician_unavailability
            WHERE is_deleted = 0
              AND initial_dc_notified_at IS NOT NULL
              AND escalation_notified_at IS NULL
              AND initial_dc_notified_at <= DATE_SUB(NOW(), INTERVAL ${ESCALATION_HOURS} HOUR)
            ORDER BY initial_dc_notified_at ASC
            LIMIT 50
        `);
        const recipients = emailList(process.env.TECHNICIAN_UNAVAILABILITY_ESCALATION_EMAILS);
        if (duePeriods.length && !recipients.length) {
            logger.warn('Technician unavailable escalation skipped: TECHNICIAN_UNAVAILABILITY_ESCALATION_EMAILS is not configured');
            return;
        }

        for (const duePeriod of duePeriods) {
            const appointments = await getAffectedAppointments(
                duePeriod.technician_id,
                duePeriod.unavailable_from,
                duePeriod.unavailable_to,
            );
            if (!appointments.length) continue;
            const period = await getPeriod(duePeriod.id);
            if (!period || period.escalation_notified_at) continue;
            const message = buildEmail({
                title: `Escalation: appointments remain assigned to unavailable technician`,
                period,
                appointments,
                actionText: `The relevant DCs were notified more than ${ESCALATION_HOURS} hours ago. These appointments are still active and need reassignment.`,
            });
            const sent = await emailService.sendEmail({
                to: recipients.join(', '),
                subject: `Escalation: ${appointments.length} appointment(s) need reassignment`,
                ...message,
            });
            if (sent.success) {
                await db.query(`UPDATE technician_unavailability SET escalation_notified_at = NOW() WHERE id = ? AND escalation_notified_at IS NULL`, [period.id]);
            }
        }
    } catch (error) {
        logger.error('Technician unavailable escalation check failed', { message: error.message, stack: error.stack });
    } finally {
        monitorRunning = false;
    }
}

function startTechnicianUnavailabilityEscalationMonitor() {
    if (monitorTimer) return;
    monitorTimer = setInterval(runEscalationCheck, CHECK_INTERVAL_MS);
    monitorTimer.unref?.();
    runEscalationCheck();
    logger.info('Technician unavailable escalation monitor started', { escalationHours: ESCALATION_HOURS, intervalMinutes: CHECK_INTERVAL_MS / 60000 });
}

module.exports = {
    getAffectedAppointments,
    sendInitialDcNotice,
    runEscalationCheck,
    startTechnicianUnavailabilityEscalationMonitor,
};
