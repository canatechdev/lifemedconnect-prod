const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

function formatIstDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    }).format(date).replace(',', '') + ' IST';
}

function titleCase(value) {
    return String(value || '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function historyLabel(row) {
    const changeType = row.change_type || row.action || '';
    const labels = {
        schedule_confirm: 'Schedule Confirmed',
        schedule_reschedule: 'Rescheduled',
        push_back: 'Pushed Back',
        restore_appointment: 'Restored',
        medical_status_update: `Medical ${titleCase(row.new_medical_status || 'Updated')}`,
        qc_submit: 'Submitted for QC',
        qc_partial_save: 'QC Saved',
        qc_complete: 'QC Completed',
        qc_push_back: 'QC Pushed Back',
        submitted_for_qc: 'Submitted for QC',
        partial_save: 'QC Saved',
        completed: 'QC Completed',
        pushed_back: 'QC Pushed Back'
    };

    return labels[changeType] || titleCase(changeType || 'Updated');
}

function addRemarkEntry(map, appointmentId, timestamp, label, remarks) {
    const cleanRemark = String(remarks || '').trim();
    if (!cleanRemark) return;

    if (!map.has(appointmentId)) {
        map.set(appointmentId, []);
    }

    map.get(appointmentId).push({
        timestamp,
        text: `${label} @ ${formatIstDateTime(timestamp)}: ${cleanRemark}`
    });
}

async function getExportRemarksByAppointmentIds(appointmentIds = []) {
    const ids = [...new Set(appointmentIds.map((id) => Number(id)).filter(Boolean))];
    const remarksMap = new Map();
    if (ids.length === 0) return remarksMap;

    const placeholders = ids.map(() => '?').join(',');

    try {
        const appointmentRows = await db.query(
            `SELECT id, remarks, medical_remarks, reschedule_remark, center_reschedule_remark, home_reschedule_remark,
                    pushback_remarks, center_pushback_remarks, home_pushback_remarks, created_at, updated_at, pushed_back_at
             FROM appointments
             WHERE id IN (${placeholders})`,
            ids
        );

        appointmentRows.forEach((row) => {
            addRemarkEntry(remarksMap, row.id, row.created_at, 'Appointment Remarks', row.remarks);
            addRemarkEntry(remarksMap, row.id, row.updated_at, 'Medical Remarks', row.medical_remarks);
            addRemarkEntry(remarksMap, row.id, row.updated_at, 'Reschedule Remarks', row.reschedule_remark);
            addRemarkEntry(remarksMap, row.id, row.updated_at, 'Center Reschedule Remarks', row.center_reschedule_remark);
            addRemarkEntry(remarksMap, row.id, row.updated_at, 'Home Reschedule Remarks', row.home_reschedule_remark);
            addRemarkEntry(remarksMap, row.id, row.pushed_back_at || row.updated_at, 'Pushback Remarks', row.pushback_remarks);
            addRemarkEntry(remarksMap, row.id, row.updated_at, 'Center Pushback Remarks', row.center_pushback_remarks);
            addRemarkEntry(remarksMap, row.id, row.updated_at, 'Home Pushback Remarks', row.home_pushback_remarks);
        });

        const historyRows = await db.query(
            `SELECT appointment_id, change_type, old_status, new_status, old_medical_status, new_medical_status,
                    remarks, created_at
             FROM appointment_status_history
             WHERE appointment_id IN (${placeholders})
               AND remarks IS NOT NULL
               AND TRIM(remarks) <> ''
             ORDER BY created_at ASC`,
            ids
        );

        historyRows.forEach((row) => {
            addRemarkEntry(remarksMap, row.appointment_id, row.created_at, historyLabel(row), row.remarks);
        });

        const qcRows = await db.query(
            `SELECT appointment_id, action, remarks, created_at
             FROM appointment_qc_history
             WHERE appointment_id IN (${placeholders})
               AND remarks IS NOT NULL
               AND TRIM(remarks) <> ''
             ORDER BY created_at ASC`,
            ids
        );

        qcRows.forEach((row) => {
            addRemarkEntry(remarksMap, row.appointment_id, row.created_at, historyLabel(row), row.remarks);
        });

        remarksMap.forEach((entries, appointmentId) => {
            const seen = new Set();
            const deduped = entries
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
                .filter((entry) => {
                    if (seen.has(entry.text)) return false;
                    seen.add(entry.text);
                    return true;
                })
                .map((entry) => entry.text);

            remarksMap.set(appointmentId, deduped.join(' ; '));
        });

        return remarksMap;
    } catch (error) {
        logger.error('Error building appointment export remarks', { error: error.message });
        throw error;
    }
}

module.exports = {
    getExportRemarksByAppointmentIds
};
