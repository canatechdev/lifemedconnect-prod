const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { createZipFile, normalizeZipName } = require('../../lib/simpleZip');
const appointmentExcel = require('./AppointmentExcel');
const { getExportRemarksByAppointmentIds } = require('./AppointmentExportRemarks');

const APP_ROOT = path.resolve(__dirname, '../../');
const EXPORT_ROOT = path.join(APP_ROOT, 'storage_backups', 'appointment_exports');
const EXPORT_RETENTION_HOURS = 24;
const EXPORT_CHUNK_SIZE = 5000;
const EXPORT_MAX_ROWS_PER_FILE = 1000000;
const TERMINAL_STATUSES = new Set(['ready', 'completed', 'failed', 'expired', 'cancelled', 'manual_deleted']);
const SUPER_ADMIN_ROLE_ID = Number(process.env.SUPER_ADMIN_ROLE_ID || 5);

const HEADERS = [
    'Case Number', 'Application Number', 'Client', 'Center', 'Other Center', 'Insurer',
    'Customer First Name', 'Customer Last Name', 'Gender', 'Mobile', 'Alt Mobile', 'Service No',
    'Email', 'Address', 'State', 'City', 'Pincode', 'Country', 'Landmark', 'Visit Type',
    'Customer Category', 'Medical Type', 'Appointment Date', 'Confirmed Date', 'Appointment Time',
    'Confirmed Time', 'Status', 'Medical Status', 'QC Status', 'Cost Type', 'UTR Number', 'Amount',
    'Test Count', 'Categories', 'Tests', 'Assigned Technicians', 'Remarks', 'Medical Remarks',
    'All Remarks', 'Created At'
];

const COLUMN_WIDTHS = [
    38, 30, 46, 27, 21, 49, 21, 21, 21, 21, 21, 21, 33, 50, 21, 21, 21, 21, 41, 21,
    21, 21, 21, 21, 21, 21, 29, 21, 21, 28, 21, 21, 15, 40, 80, 25, 50, 50, 60, 25
];

function safeJson(value, fallback = {}) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function toDateText(value) {
    return value ? new Date(value).toLocaleDateString('en-IN') : '';
}

function toDateTimeText(value) {
    return value ? new Date(value).toLocaleString('en-IN') : '';
}

function toExportRow(appointment, remarks) {
    return [
        appointment.case_number,
        appointment.application_number,
        appointment.client_name || '',
        appointment.center_name || '',
        appointment.other_center_name || '',
        appointment.insurer_name || '',
        appointment.customer_first_name,
        appointment.customer_last_name,
        appointment.gender,
        appointment.customer_mobile,
        appointment.customer_alt_mobile,
        appointment.customer_service_no,
        appointment.customer_email,
        appointment.customer_address,
        appointment.state,
        appointment.city,
        appointment.pincode,
        appointment.country,
        appointment.customer_landmark,
        appointment.visit_type,
        appointment.customer_category,
        appointment.medical_type === 'non_fasting' ? 'Non-Fasting' : appointment.medical_type === 'fasting' ? 'Fasting' : '',
        toDateText(appointment.appointment_date),
        toDateText(appointment.confirmed_date),
        appointment.appointment_time || '',
        appointment.confirmed_time || '',
        appointment.status,
        appointment.medical_status,
        appointment.qc_status,
        appointment.cost_type,
        appointment.utr_number || '',
        appointment.amount,
        appointment.test_count || 0,
        appointment.categories_info || '',
        appointment.tests_info || '',
        appointment.technicians_info || '',
        appointment.remarks,
        appointment.medical_remarks,
        remarks || '',
        toDateTimeText(appointment.created_at)
    ];
}

function safeExportPath(filePath) {
    const absolute = path.resolve(APP_ROOT, filePath || '');
    const root = EXPORT_ROOT.endsWith(path.sep) ? EXPORT_ROOT : `${EXPORT_ROOT}${path.sep}`;
    return absolute === EXPORT_ROOT || absolute.startsWith(root) ? absolute : null;
}

function formatJob(row) {
    const metadata = safeJson(row.metadata_json, {});
    return {
        id: Number(row.id),
        status: row.status,
        job_type: row.job_type,
        file_name: row.file_name || null,
        file_path: row.file_path || null,
        total_files: Number(row.total_files || 0),
        total_size: Number(row.total_size || 0),
        created_at: row.created_at,
        expires_at: row.expires_at,
        downloaded_at: row.downloaded_at || null,
        error_message: row.error_message || metadata.error_message || null,
        progress_percent: Number(metadata.progress_percent || 0),
        progress_message: metadata.progress_message || null,
        progress_current: Number(metadata.progress_current || 0),
        progress_total: Number(metadata.progress_total || 0),
        row_count: Number(metadata.row_count || 0),
        download_url: row.status === 'ready' ? `/api/appointments/export/jobs/${row.id}/download` : null,
    };
}

async function updateJob(id, updates) {
    const fields = Object.keys(updates);
    if (!fields.length) return;
    await db.query(
        `UPDATE storage_backup_activity SET ${fields.map(field => `${field} = ?`).join(', ')} WHERE id = ?`,
        [...fields.map(field => updates[field]), id]
    );
}

async function getJob(id) {
    const rows = await db.query(
        `SELECT * FROM storage_backup_activity WHERE id = ? AND job_type = 'appointment_export' LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

function scopeFromUser(user = {}) {
    return {
        diagnostic_center_id: user.diagnostic_center_id || user.center_id || null,
        insurer_id: user.insurer_id || null,
        client_id: user.client_id || null,
        technician_id: user.technician_id || user.assigned_technician_id || null,
    };
}

async function createExportJob(req, filters) {
    const scope = scopeFromUser(req.user);
    const requestKey = crypto.createHash('sha256')
        .update(JSON.stringify({ filters: filters || {}, scope }))
        .digest('hex');
    const existing = await db.query(
        `SELECT * FROM storage_backup_activity
         WHERE job_type = 'appointment_export'
           AND performed_by = ?
           AND status IN ('queued', 'processing', 'ready')
           AND (status <> 'ready' OR expires_at IS NULL OR expires_at > NOW())
           AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.request_key')) = ?
         ORDER BY id DESC LIMIT 1`,
        [req.user.id, requestKey]
    );
    if (existing[0]) {
        const existingPath = safeExportPath(existing[0].file_path);
        if (existing[0].status !== 'ready' || (existingPath && fs.existsSync(existingPath))) {
            return formatJob(existing[0]);
        }
        await db.query(
            `UPDATE storage_backup_activity
             SET status = 'expired', deleted_at = NOW(), error_message = 'Retained export file is no longer available'
             WHERE id = ? AND status = 'ready'`,
            [existing[0].id]
        );
    }

    const metadata = {
        filters: filters || {},
        scope,
        request_key: requestKey,
        progress_percent: 0,
        progress_message: 'Queued',
        progress_current: 0,
        progress_total: 0,
        row_count: 0,
    };
    const result = await db.query(
        `INSERT INTO storage_backup_activity
         (action, job_type, status, appointment_ids_json, file_paths_json, metadata_json, performed_by, ip_address, user_agent)
         VALUES ('appointment_export_requested', 'appointment_export', 'queued', '[]', '[]', ?, ?, ?, ?)`,
        [JSON.stringify(metadata), req.user.id, req.ip || null, String(req.headers['user-agent'] || '').slice(0, 500)]
    );
    const job = await getJob(result.insertId);
    return formatJob(job);
}

function getPeriodLabel(filters = {}) {
    const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (filters.month) return `Period: ${monthNames[Number(filters.month)] || filters.month} ${filters.year || ''}`.trim();
    if (filters.year) return `Year: ${filters.year}`;
    if (filters.fromDate || filters.toDate) return `Period: ${filters.fromDate || ''} to ${filters.toDate || ''}`;
    return 'Period: All matching appointments';
}

async function writeHeader(workbook, worksheet, filters, totalRows) {
    const titleRow = worksheet.getRow(1);
    titleRow.values = ['APPOINTMENTS EXPORT'];
    worksheet.mergeCells('A1:AM1');
    titleRow.font = { bold: true, size: 16 };
    titleRow.alignment = { horizontal: 'center' };
    titleRow.commit();

    if (filters.month || filters.year) {
        const periodRow = worksheet.addRow([getPeriodLabel(filters)]);
        periodRow.font = { italic: true };
        periodRow.commit();
    }

    const exportDateRow = worksheet.addRow([`Export Date: ${new Date().toLocaleString('en-IN')}`]);
    exportDateRow.font = { italic: true };
    exportDateRow.commit();

    const totalRow = worksheet.addRow([`Total Records: ${Number(totalRows || 0)}`]);
    totalRow.font = { italic: true, bold: true };
    totalRow.commit();

    worksheet.addRow([]).commit();

    const headerRow = worksheet.addRow(HEADERS);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF366092' } };
    headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
    headerRow.height = 25;
    applyBorders(headerRow);
    headerRow.commit();
    await new Promise(resolve => setImmediate(resolve));
}

function applyBorders(row) {
    row.eachCell((cell) => {
        cell.border = {
            top: { style: 'thin' }, left: { style: 'thin' },
            bottom: { style: 'thin' }, right: { style: 'thin' },
        };
    });
}

async function createPart(filePath, filters, totalRows) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: true });
    const worksheet = workbook.addWorksheet('Appointments Export');
    COLUMN_WIDTHS.forEach((width, index) => { worksheet.getColumn(index + 1).width = width; });
    await writeHeader(workbook, worksheet, filters, totalRows);
    return { workbook, worksheet, rows: 0 };
}

async function processExportJob(jobId) {
    const job = await getJob(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;

    const claimed = await db.query(
        `UPDATE storage_backup_activity SET status = 'processing', error_message = NULL
         WHERE id = ? AND job_type = 'appointment_export' AND status = 'queued'`,
        [jobId]
    );
    if (!claimed.affectedRows) return;

    const metadata = safeJson(job.metadata_json, {});
    const filters = metadata.filters || {};
    const scope = metadata.scope || {};
    const jobDir = path.join(EXPORT_ROOT, `job_${jobId}`);
    const partFiles = [];
    let workbookPart = null;
    let afterId = 0;
    let snapshotMaxId = Number(metadata.snapshot_max_id || 0);
    let rowCount = 0;
    let totalRows = Number(metadata.total_rows || 0);

    try {
        await fsp.rm(jobDir, { recursive: true, force: true });
        await fsp.mkdir(jobDir, { recursive: true });
        if (!snapshotMaxId) {
            const maxRows = await db.query('SELECT COALESCE(MAX(id), 0) AS max_id FROM appointments');
            snapshotMaxId = Number(maxRows[0]?.max_id || 0);
        }
        if (!totalRows) {
            const countRows = await appointmentExcel.getAppointmentsForExport(
                filters,
                scope,
                { maxId: snapshotMaxId, countOnly: true }
            );
            totalRows = Number(countRows[0]?.total || 0);
        }

        const updateProgress = async (message, current = rowCount) => {
            const progress = totalRows > 0 ? Math.min(99, Math.round((current / totalRows) * 99)) : 0;
            const nextMetadata = {
                ...metadata,
                snapshot_max_id: snapshotMaxId,
                total_rows: totalRows,
                progress_percent: progress,
                progress_message: message,
                progress_current: current,
                progress_total: null,
                row_count: rowCount,
            };
            await updateJob(jobId, { metadata_json: JSON.stringify(nextMetadata) });
        };

        while (true) {
            const rows = await appointmentExcel.getAppointmentsForExport(
                filters,
                scope,
                { afterId, maxId: snapshotMaxId, limit: EXPORT_CHUNK_SIZE }
            );
            if (!rows.length) break;

            if (!workbookPart || workbookPart.rows + rows.length > EXPORT_MAX_ROWS_PER_FILE) {
                if (workbookPart) await workbookPart.workbook.commit();
                const partNumber = partFiles.length + 1;
                const fileName = `appointments_export_${jobId}_part_${String(partNumber).padStart(3, '0')}.xlsx`;
                const filePath = path.join(jobDir, fileName);
                workbookPart = await createPart(filePath, filters, totalRows);
                partFiles.push({ fileName, filePath });
            }

            const remarks = await getExportRemarksByAppointmentIds(rows.map(row => row.id));
            for (const row of rows) {
                const exportRow = workbookPart.worksheet.addRow(toExportRow(row, remarks.get(Number(row.id)) || ''));
                applyBorders(exportRow);
                exportRow.commit();
                workbookPart.rows += 1;
                rowCount += 1;
            }
            afterId = Number(rows[rows.length - 1].id);
            await updateProgress(`Processed ${rowCount.toLocaleString()} appointments`);
            await new Promise(resolve => setImmediate(resolve));
        }

        if (workbookPart) await workbookPart.workbook.commit();
        if (!partFiles.length) {
            const fileName = `appointments_export_${jobId}_part_001.xlsx`;
            const filePath = path.join(jobDir, fileName);
            const emptyPart = await createPart(filePath, filters, totalRows);
            await emptyPart.workbook.commit();
            partFiles.push({ fileName, filePath });
        }

        let finalPath = partFiles[0].filePath;
        let finalName = partFiles[0].fileName;
        if (partFiles.length > 1) {
            finalName = `appointments_export_${jobId}.zip`;
            finalPath = path.join(jobDir, finalName);
            await createZipFile(finalPath, partFiles.map(part => ({
                absolutePath: part.filePath,
                name: normalizeZipName(part.fileName),
            })));
            await Promise.all(partFiles.map(part => fsp.unlink(part.filePath).catch(() => undefined)));
        }

        const stat = await fsp.stat(finalPath);
        const finalMetadata = {
            ...metadata,
            snapshot_max_id: snapshotMaxId,
            progress_percent: 100,
            progress_message: 'Ready to download',
            progress_current: rowCount,
            progress_total: rowCount,
            row_count: rowCount,
            total_rows: totalRows,
            part_count: partFiles.length,
            finished_at: new Date().toISOString(),
        };
        await updateJob(jobId, {
            action: 'appointment_export_generated',
            status: 'ready',
            file_name: finalName,
            file_path: path.relative(APP_ROOT, finalPath).replace(/\\/g, '/'),
            total_files: partFiles.length,
            total_size: stat.size,
            metadata_json: JSON.stringify(finalMetadata),
            expires_at: new Date(Date.now() + EXPORT_RETENTION_HOURS * 60 * 60 * 1000),
            error_message: null,
        });
        logger.info('Appointment export job completed', { jobId, rowCount, partCount: partFiles.length, bytes: stat.size });
    } catch (error) {
        if (workbookPart) await workbookPart.workbook.commit().catch(() => undefined);
        await updateJob(jobId, {
            status: 'failed',
            error_message: error.message,
            metadata_json: JSON.stringify({ ...metadata, progress_message: 'Failed', row_count: rowCount, failed_at: new Date().toISOString() }),
        }).catch(() => undefined);
        logger.error('Appointment export job failed', { jobId, rowCount, error: error.message });
        await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

async function cleanupExpiredExports() {
    const rows = await db.query(
        `SELECT id, file_path FROM storage_backup_activity
         WHERE job_type = 'appointment_export' AND status = 'ready'
           AND expires_at IS NOT NULL AND expires_at <= NOW()
         LIMIT 50`
    );
    for (const row of rows) {
        const absolute = safeExportPath(row.file_path);
        if (absolute) await fsp.rm(path.dirname(absolute), { recursive: true, force: true }).catch(() => undefined);
        await db.query(`UPDATE storage_backup_activity SET status = 'expired', deleted_at = NOW() WHERE id = ?`, [row.id]);
    }
}

async function getExportJob(jobId, req = null) {
    const job = await getJob(jobId);
    if (req) assertJobAccess(req, job);
    return job ? formatJob(job) : null;
}

function assertJobAccess(req, job) {
    if (!job || (Number(job.performed_by) !== Number(req.user?.id) && Number(req.user?.role_id) !== SUPER_ADMIN_ROLE_ID)) {
        const error = new Error('Export job not found');
        error.statusCode = 404;
        throw error;
    }
}

async function downloadExport(req, res, jobId) {
    const job = await getJob(jobId);
    assertJobAccess(req, job);
    if (!job || job.status !== 'ready' || (job.expires_at && new Date(job.expires_at) <= new Date())) {
        const error = new Error('Export not found or expired');
        error.statusCode = 404;
        throw error;
    }
    const absolute = safeExportPath(job.file_path);
    if (!absolute || !fs.existsSync(absolute)) {
        const error = new Error('Export file is no longer available');
        error.statusCode = 404;
        throw error;
    }
    await db.query('UPDATE storage_backup_activity SET downloaded_at = NOW() WHERE id = ?', [jobId]);
    const contentType = job.file_name?.endsWith('.zip') ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${job.file_name}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(absolute);
}

let recoveredStaleJobs = false;

async function runWorkerOnce() {
    if (!recoveredStaleJobs) {
        recoveredStaleJobs = true;
        await db.query(
            `UPDATE storage_backup_activity
             SET status = 'queued', error_message = NULL
             WHERE job_type = 'appointment_export' AND status = 'processing'`
        );
    }
    await cleanupExpiredExports();
    const rows = await db.query(
        `SELECT id FROM storage_backup_activity
         WHERE job_type = 'appointment_export' AND status = 'queued'
         ORDER BY id ASC LIMIT 1`
    );
    if (rows[0]) await processExportJob(rows[0].id);
}

module.exports = {
    createExportJob,
    getExportJob,
    downloadExport,
    processExportJob,
    runWorkerOnce,
    cleanupExpiredExports,
    EXPORT_RETENTION_HOURS,
};
