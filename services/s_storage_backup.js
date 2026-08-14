const fs = require('fs');
const path = require('path');
const db = require('../lib/dbconnection');
const logger = require('../lib/logger');
const { createZipFile, normalizeZipName } = require('../lib/simpleZip');
const appointmentsService = require('./appointments');

const APP_ROOT = path.resolve(__dirname, '..');
const UPLOADS_ROOT = path.join(APP_ROOT, 'uploads');
const BACKUP_ROOT = path.join(APP_ROOT, 'storage_backups');
const SUPER_ADMIN_ROLE_ID = Number(process.env.SUPER_ADMIN_ROLE_ID || 5);
const WARNING_GB = Number(process.env.UPLOAD_STORAGE_WARNING_GB || 80);
const DANGER_GB = Number(process.env.UPLOAD_STORAGE_DANGER_GB || 95);
const ZIP_RETENTION_HOURS = Number(process.env.STORAGE_ZIP_RETENTION_HOURS || 24);
const MAX_SIMPLE_ZIP_BYTES = Math.min(
    Number(process.env.STORAGE_MAX_ZIP_GB || 3.8) * 1024 * 1024 * 1024,
    0xffffffff - 1024 * 1024
);
const STORAGE_JOB_CONCURRENCY = Math.max(1, Number(process.env.STORAGE_JOB_CONCURRENCY || 1));
const STORAGE_JOB_SCAN_LIMIT = Math.max(10, Number(process.env.STORAGE_JOB_SCAN_LIMIT || 15));

const TERMINAL_JOB_STATUSES = new Set(['ready', 'completed', 'failed', 'expired', 'manual_deleted', 'cancelled']);

const storageJobQueue = [];
let runningStorageJobs = 0;
let storageJobsRecovered = false;

function assertSuperAdmin(user) {
    if (!user || Number(user.role_id) !== SUPER_ADMIN_ROLE_ID) {
        const error = new Error('Only Super Admin can access storage backup tools');
        error.statusCode = 403;
        throw error;
    }
}

function bytesToGb(bytes) {
    return Number((Number(bytes || 0) / (1024 * 1024 * 1024)).toFixed(2));
}

function safeJsonParse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function delayImmediate() {
    return new Promise((resolve) => setImmediate(resolve));
}

function toArray(value) {
    if (!Array.isArray(value)) return [];
    return value.map(v => Number(v)).filter(Number.isFinite);
}

function safeFolderPart(value, fallback = 'UNKNOWN') {
    const normalized = String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, '_');
    return normalized || fallback;
}

function getAppointmentBackupFolder(appointment) {
    const parts = [];
    if (appointment?.application_number) {
        parts.push(safeFolderPart(appointment.application_number));
    }
    if (appointment?.case_number) {
        parts.push(safeFolderPart(appointment.case_number));
    }
    if (!parts.length) {
        parts.push(`appointment_${safeFolderPart(appointment?.id, 'unknown')}`);
    }
    return parts.join('__');
}

function normalizeDbPath(filePath) {
    if (!filePath) return '';
    return String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
}

function resolveStoredPath(filePath) {
    if (!filePath) return null;
    const normalized = normalizeDbPath(filePath);
    const absolute = path.isAbsolute(normalized)
        ? path.resolve(normalized)
        : path.resolve(APP_ROOT, normalized);

    // Backup tool only handles files from this backend workspace.
    const appRootWithSep = APP_ROOT.endsWith(path.sep) ? APP_ROOT : `${APP_ROOT}${path.sep}`;
    if (absolute !== APP_ROOT && !absolute.startsWith(appRootWithSep)) {
        return null;
    }
    return absolute;
}

function resolveBackupPath(filePath) {
    if (!filePath) return null;
    const normalized = normalizeDbPath(filePath);
    const absolute = path.isAbsolute(normalized)
        ? path.resolve(normalized)
        : path.resolve(APP_ROOT, normalized);
    const backupRootWithSep = BACKUP_ROOT.endsWith(path.sep) ? BACKUP_ROOT : `${BACKUP_ROOT}${path.sep}`;
    if (absolute !== BACKUP_ROOT && !absolute.startsWith(backupRootWithSep)) {
        return null;
    }
    return absolute;
}

function resolveUploadPath(filePath) {
    if (!filePath) return null;
    const normalized = normalizeDbPath(filePath);
    const absolute = path.isAbsolute(normalized)
        ? path.resolve(normalized)
        : path.resolve(APP_ROOT, normalized);
    const uploadsRootWithSep = UPLOADS_ROOT.endsWith(path.sep) ? UPLOADS_ROOT : `${UPLOADS_ROOT}${path.sep}`;
    if (absolute !== UPLOADS_ROOT && !absolute.startsWith(uploadsRootWithSep)) {
        return null;
    }
    return absolute;
}

async function getFileInfo(filePath) {
    const normalized = normalizeDbPath(filePath);
    const absolute = resolveStoredPath(normalized);
    if (!absolute) {
        return { normalized, absolute: null, exists: false, size: 0 };
    }
    try {
        const stat = await fs.promises.stat(absolute);
        return {
            normalized,
            absolute,
            exists: stat.isFile(),
            size: stat.isFile() ? stat.size : 0,
            modified_at: stat.mtime,
        };
    } catch (_) {
        return { normalized, absolute, exists: false, size: 0 };
    }
}

async function getDirectorySize(directory) {
    let total = 0;
    async function walk(current) {
        let entries = [];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                try {
                    const stat = await fs.promises.stat(fullPath);
                    total += stat.size;
                } catch (_) {
                    // Ignore files that disappear during scan.
                }
            }
        }
    }
    await walk(directory);
    return total;
}

async function walkFiles(directory, onFile) {
    let entries = [];
    try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (_) {
        return;
    }
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(fullPath, onFile);
        } else if (entry.isFile()) {
            await onFile(fullPath);
        }
    }
}

function auditPayload(req, action, payload = {}) {
    return {
        action,
        related_job_id: payload.jobId || null,
        appointment_ids_json: JSON.stringify(payload.appointmentIds || []),
        file_paths_json: JSON.stringify(payload.filePaths || []),
        total_files: payload.totalFiles || 0,
        total_size: payload.totalSize || 0,
        remark: payload.remark || null,
        performed_by: req.user?.id || null,
        ip_address: req.ip || null,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
        metadata_json: JSON.stringify(payload.metadata || {}),
    };
}

async function logAudit(req, action, payload = {}) {
    const row = auditPayload(req, action, payload);
    await db.query(
        `INSERT INTO storage_backup_activity
         (action, related_job_id, appointment_ids_json, file_paths_json, total_files, total_size, remark, performed_by, ip_address, user_agent, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            row.action,
            row.related_job_id,
            row.appointment_ids_json,
            row.file_paths_json,
            row.total_files,
            row.total_size,
            row.remark,
            row.performed_by,
            row.ip_address,
            row.user_agent,
            row.metadata_json,
        ]
    );
}

async function logJobAudit(job, action, payload = {}) {
    await db.query(
        `INSERT INTO storage_backup_activity
         (action, related_job_id, appointment_ids_json, file_paths_json, total_files, total_size, remark, performed_by, ip_address, user_agent, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            action,
            job.id,
            JSON.stringify(payload.appointmentIds || safeJsonParse(job.appointment_ids_json, [])),
            JSON.stringify(payload.filePaths || []),
            payload.totalFiles || 0,
            payload.totalSize || 0,
            payload.remark || job.remark || null,
            job.performed_by || null,
            job.ip_address || null,
            String(job.user_agent || '').slice(0, 500),
            JSON.stringify(payload.metadata || {}),
        ]
    );
}

function formatJobRow(row) {
    const metadata = safeJsonParse(row.metadata_json, {});
    const status = row.status || null;
    const id = Number(row.id);
    return {
        id,
        action: row.action || null,
        job_type: row.job_type || null,
        status,
        file_name: row.file_name || null,
        file_path: row.file_path || null,
        total_files: Number(row.total_files || 0),
        total_size: Number(row.total_size || 0),
        created_at: row.created_at || null,
        expires_at: row.expires_at || null,
        downloaded_at: row.downloaded_at || null,
        deleted_at: row.deleted_at || null,
        error_message: row.error_message || metadata.error_message || null,
        progress_percent: Number(metadata.progress_percent || 0),
        progress_message: metadata.progress_message || null,
        progress_current: Number(metadata.progress_current || 0),
        progress_total: Number(metadata.progress_total || 0),
        download_url: status === 'ready' ? `/api/storage-backup/zips/${id}/download` : null,
        metadata,
    };
}

async function updateJobRow(jobId, updates = {}) {
    const fields = [];
    const values = [];
    Object.entries(updates).forEach(([key, value]) => {
        fields.push(`${key} = ?`);
        values.push(value);
    });
    if (!fields.length) return;
    values.push(jobId);
    await db.query(`UPDATE storage_backup_activity SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function markQueuedJobsFailedOnce() {
    if (storageJobsRecovered) return;
    storageJobsRecovered = true;
    await db.query(
        `UPDATE storage_backup_activity
         SET status = 'failed',
             error_message = COALESCE(error_message, 'Storage job interrupted before completion')
         WHERE job_type IS NOT NULL
           AND status IN ('queued', 'processing')`
    );
}

async function fetchJob(jobId) {
    const rows = await db.query(`SELECT * FROM storage_backup_activity WHERE id = ? LIMIT 1`, [jobId]);
    return rows[0] || null;
}

async function persistJobProgress(jobId, metadata = {}, extraUpdates = {}) {
    await updateJobRow(jobId, {
        metadata_json: JSON.stringify(metadata),
        ...extraUpdates,
    });
}

function enqueueStorageJob(jobId, worker) {
    storageJobQueue.push({ jobId, worker });
    setImmediate(() => {
        runStorageJobQueue().catch((error) => {
            logger.error('Storage job queue failed', { error: error.message });
        });
    });
}

async function runStorageJobQueue() {
    if (runningStorageJobs >= STORAGE_JOB_CONCURRENCY) return;
    const next = storageJobQueue.shift();
    if (!next) return;

    runningStorageJobs += 1;
    try {
        await next.worker();
    } finally {
        runningStorageJobs -= 1;
        if (storageJobQueue.length) {
            setImmediate(() => {
                runStorageJobQueue().catch((error) => {
                    logger.error('Storage job queue failed', { error: error.message });
                });
            });
        }
    }
}

async function getSummary(req) {
    assertSuperAdmin(req.user);
    await markQueuedJobsFailedOnce();
    await cleanupExpiredZips();

    const [uploadsBytes, zipBytes] = await Promise.all([
        getDirectorySize(UPLOADS_ROOT),
        getDirectorySize(BACKUP_ROOT),
    ]);

    const warningBytes = WARNING_GB * 1024 * 1024 * 1024;
    const dangerBytes = DANGER_GB * 1024 * 1024 * 1024;
    const percentOfDanger = dangerBytes > 0 ? Math.min(100, Math.round((uploadsBytes / dangerBytes) * 100)) : 0;
    const level = uploadsBytes >= dangerBytes ? 'danger' : uploadsBytes >= warningBytes ? 'warning' : 'ok';

    const activeJobs = await db.query(
        `SELECT id, action, job_type, status, file_name, file_path, total_files, total_size,
                created_at, expires_at, downloaded_at, deleted_at, error_message, metadata_json
         FROM storage_backup_activity
         WHERE job_type IS NOT NULL
           AND (
                status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')
                OR (status = 'ready' AND (expires_at IS NULL OR expires_at > NOW()))
           )
         ORDER BY created_at DESC
         LIMIT ${STORAGE_JOB_SCAN_LIMIT}`
    );

    return {
        uploads: {
            bytes: uploadsBytes,
            gb: bytesToGb(uploadsBytes),
            warning_gb: WARNING_GB,
            danger_gb: DANGER_GB,
            percent_of_danger: percentOfDanger,
            level,
        },
        zips: {
            bytes: zipBytes,
            gb: bytesToGb(zipBytes),
            retention_hours: ZIP_RETENTION_HOURS,
            active_jobs: activeJobs.map(formatJobRow),
        },
        limits: {
            max_zip_bytes: Math.floor(MAX_SIMPLE_ZIP_BYTES),
            max_zip_gb: bytesToGb(MAX_SIMPLE_ZIP_BYTES),
        },
    };
}

async function listAppointments(req, params = {}) {
    assertSuperAdmin(req.user);
    const page = Math.max(1, Number(params.page || 1));
    const limit = Math.min(500, Math.max(1, Number(params.limit || 20)));
    const offset = (page - 1) * limit;
    const q = String(params.q || '').trim();
    const qcCompletedOnly = String(params.qcCompletedOnly || '') === 'true';
    const backupStatus = String(params.backupStatus || 'all').trim();
    const fromDate = String(params.fromDate || '').trim();
    const toDate = String(params.toDate || '').trim();
    const allowedDateFields = {
        created_at: 'a.created_at',
        appointment_date: 'a.appointment_date',
    };
    const dateField = allowedDateFields[params.dateField] || allowedDateFields.created_at;

    const where = ['a.is_deleted = 0'];
    const values = [];
    if (q) {
        where.push(`(a.case_number LIKE ? OR a.application_number LIKE ? OR CONCAT_WS(' ', a.customer_first_name, a.customer_last_name) LIKE ?)`);
        const like = `%${q}%`;
        values.push(like, like, like);
    }
    if (qcCompletedOnly) {
        where.push(`(LOWER(COALESCE(a.qc_status, '')) = 'completed' OR LOWER(COALESCE(a.status, '')) = 'completed')`);
    }
    const backupExistsSql = `
        SELECT 1
        FROM storage_backup_activity sba
        WHERE sba.action = 'backup_zip_generated'
          AND sba.job_type = 'case_backup'
          AND JSON_CONTAINS(COALESCE(sba.appointment_ids_json, '[]'), CAST(a.id AS CHAR), '$')
    `;
    if (backupStatus === 'none') {
        where.push(`NOT EXISTS (${backupExistsSql})`);
    } else if (backupStatus === 'ready') {
        where.push(`EXISTS (${backupExistsSql} AND sba.downloaded_at IS NULL)`);
    } else if (backupStatus === 'downloaded') {
        where.push(`EXISTS (${backupExistsSql} AND sba.downloaded_at IS NOT NULL)`);
    } else if (backupStatus === 'backed_up') {
        where.push(`EXISTS (${backupExistsSql})`);
    }
    if (fromDate) {
        where.push(`DATE(${dateField}) >= ?`);
        values.push(fromDate);
    }
    if (toDate) {
        where.push(`DATE(${dateField}) <= ?`);
        values.push(toDate);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const rows = await db.query(
        `SELECT SQL_CALC_FOUND_ROWS
                a.id, a.case_number, a.application_number, a.appointment_date, a.confirmed_date,
                a.created_at, a.status, a.medical_status, a.qc_status,
                CONCAT_WS(' ', a.customer_first_name, a.customer_last_name) AS customer_name,
                c.client_name
         FROM appointments a
         LEFT JOIN clients c ON a.client_id = c.id
         ${whereSql}
         ORDER BY a.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        values
    );
    const totalRows = await db.query('SELECT FOUND_ROWS() AS total');

    const data = [];
    const backupCoverage = await getBackupCoverage(rows.map(row => row.id));
    for (const row of rows) {
        const files = await collectAppointmentFiles(row.id);
        const backupStatus = backupCoverage.get(Number(row.id)) || 'none';
        const backedUp = backupStatus !== 'none';
        data.push({
            ...row,
            estimated_file_size: files.total_size,
            estimated_file_count: files.total_files,
            backup_status: backupStatus,
            backup_ready: backedUp,
            backup_downloaded: backupStatus === 'downloaded',
            eligible_to_delete: isQcCompleted(row) && backedUp,
        });
    }

    return {
        data,
        pagination: {
            total: totalRows[0]?.total || 0,
            page,
            limit,
            pages: Math.ceil((totalRows[0]?.total || 0) / limit),
        },
    };
}

function isQcCompleted(appointment) {
    return ['completed'].includes(String(appointment.qc_status || '').toLowerCase())
        || String(appointment.status || '').toLowerCase() === 'completed';
}

async function queryFileRows(sql, appointmentId, category, labelBuilder) {
    try {
        const rows = await db.query(sql, [appointmentId]);
        return rows.map(row => ({
            id: row.id,
            appointment_id: appointmentId,
            category,
            label: labelBuilder(row),
            file_path: row.file_path || row.pdf_path,
            file_name: row.file_name || path.basename(row.file_path || row.pdf_path || ''),
            uploaded_at: row.uploaded_at || row.fetched_at || row.created_at || null,
        })).filter(file => file.file_path);
    } catch (error) {
        logger.warn('Storage backup file query skipped', { appointmentId, category, error: error.message });
        return [];
    }
}

async function collectAppointmentFiles(appointmentId) {
    const groups = await Promise.all([
        queryFileRows(
            `SELECT id, file_path, file_name, file_size, uploaded_at FROM appointment_reports WHERE appointment_id = ? AND is_deleted = 0`,
            appointmentId,
            'reports',
            row => `Report ${row.id}`
        ),
        queryFileRows(
            `SELECT id, report_type, file_path, file_name, file_size, uploaded_at FROM appointment_categorized_reports WHERE appointment_id = ? AND is_deleted = 0`,
            appointmentId,
            'categorized-reports',
            row => `${row.report_type || 'report'} ${row.id}`
        ),
        queryFileRows(
            `SELECT id, doc_type, doc_number, file_path, file_name, uploaded_at FROM appointment_documents WHERE appointment_id = ? AND is_deleted = 0`,
            appointmentId,
            'documents',
            row => `${row.doc_type || 'document'} ${row.doc_number || ''}`.trim()
        ),
        queryFileRows(
            `SELECT id, image_label, file_path, file_name, uploaded_at FROM appointment_customer_images WHERE appointment_id = ? AND is_deleted = 0`,
            appointmentId,
            'customer-images',
            row => row.image_label || `Customer image ${row.id}`
        ),
        queryFileRows(
            `SELECT id, file_path, file_name, file_size, uploaded_at FROM appointment_medical_files WHERE appointment_id = ? AND is_deleted = 0`,
            appointmentId,
            'medical-files',
            row => `Medical file ${row.id}`
        ),
        queryFileRows(
            `SELECT id, pdf_path, fetched_at, created_at FROM appointment_pathology_data WHERE appointment_id = ? AND pdf_path IS NOT NULL ORDER BY fetched_at DESC LIMIT 1`,
            appointmentId,
            'pathology',
            row => `Pathology PDF ${row.id}`
        ),
    ]);

    const files = [];
    for (const item of groups.flat()) {
        const info = await getFileInfo(item.file_path);
        files.push({
            ...item,
            file_path: info.normalized,
            exists: info.exists,
            size: info.size,
            size_mb: Number((info.size / (1024 * 1024)).toFixed(2)),
            absolute: info.absolute,
        });
    }

    return {
        files,
        total_files: files.filter(file => file.exists).length,
        total_size: files.reduce((sum, file) => sum + (file.exists ? file.size : 0), 0),
        missing_files: files.filter(file => !file.exists).length,
    };
}

async function getBackupCoverage(appointmentIds = []) {
    const ids = new Set(toArray(appointmentIds));
    const covered = new Map();
    if (!ids.size) return covered;

    const rows = await db.query(
        `SELECT id, appointment_ids_json, downloaded_at
         FROM storage_backup_activity
         WHERE action = 'backup_zip_generated'
           AND job_type = 'case_backup'
         ORDER BY created_at DESC
         LIMIT 2000`
    );

    for (const row of rows) {
        let backedIds = [];
        try {
            backedIds = JSON.parse(row.appointment_ids_json || '[]');
        } catch (_) {
            backedIds = [];
        }
        for (const id of backedIds) {
            const numericId = Number(id);
            if (!ids.has(numericId)) continue;
            const status = row.downloaded_at ? 'downloaded' : 'ready';
            if (covered.get(numericId) !== 'downloaded') {
                covered.set(numericId, status);
            }
        }
        if (covered.size === ids.size) break;
    }

    return covered;
}

async function previewAppointmentsInternal(appointmentIds, auditReq = null) {
    const ids = toArray(appointmentIds);
    if (!ids.length) {
        const error = new Error('Select at least one appointment');
        error.statusCode = 400;
        throw error;
    }

    const placeholders = ids.map(() => '?').join(',');
    const appointments = await db.query(
        `SELECT id, case_number, application_number, appointment_date, confirmed_date, created_at, status, medical_status, qc_status
         FROM appointments
         WHERE id IN (${placeholders}) AND is_deleted = 0`,
        ids
    );

    const byId = new Map(appointments.map(row => [Number(row.id), row]));
    const backupCoverage = await getBackupCoverage(ids);
    const items = [];
    let totalSize = 0;
    let totalFiles = 0;
    let missingFiles = 0;

    for (const id of ids) {
        const appointment = byId.get(id);
        if (!appointment) continue;
        const collected = await collectAppointmentFiles(id);
        totalSize += collected.total_size;
        totalFiles += collected.total_files;
        missingFiles += collected.missing_files;
        items.push({
            appointment,
            backup_status: backupCoverage.get(id) || 'none',
            backup_ready: backupCoverage.has(id),
            backup_downloaded: backupCoverage.get(id) === 'downloaded',
            eligible_to_delete: isQcCompleted(appointment) && backupCoverage.has(id),
            files: collected.files.map(({ absolute, ...file }) => file),
            total_size: collected.total_size,
            total_files: collected.total_files,
            missing_files: collected.missing_files,
        });
    }

    if (auditReq) {
        await logAudit(auditReq, 'preview_cases', {
            appointmentIds: ids,
            totalFiles,
            totalSize,
            metadata: { missingFiles },
        });
    }

    return {
        appointments: items,
        totals: {
            selected_cases: items.length,
            total_files: totalFiles,
            total_size: totalSize,
            total_size_gb: bytesToGb(totalSize),
            missing_files: missingFiles,
            can_build_zip: totalSize > 0 && totalSize <= MAX_SIMPLE_ZIP_BYTES,
            max_zip_bytes: Math.floor(MAX_SIMPLE_ZIP_BYTES),
            max_zip_gb: bytesToGb(MAX_SIMPLE_ZIP_BYTES),
        },
    };
}

async function previewAppointments(req, appointmentIds) {
    assertSuperAdmin(req.user);
    return previewAppointmentsInternal(appointmentIds, req);
}

async function getReferencedUploadPaths() {
    const queries = [
        `SELECT amount_upload AS file_path FROM appointments WHERE amount_upload IS NOT NULL AND is_deleted = 0`,
        `SELECT file_path FROM appointment_reports WHERE file_path IS NOT NULL AND is_deleted = 0`,
        `SELECT file_path FROM appointment_categorized_reports WHERE file_path IS NOT NULL AND is_deleted = 0`,
        `SELECT file_path FROM appointment_documents WHERE file_path IS NOT NULL AND is_deleted = 0`,
        `SELECT file_path FROM appointment_customer_images WHERE file_path IS NOT NULL AND is_deleted = 0`,
        `SELECT file_path FROM appointment_medical_files WHERE file_path IS NOT NULL AND is_deleted = 0`,
        `SELECT pdf_path AS file_path FROM appointment_pathology_data WHERE pdf_path IS NOT NULL`,
        `SELECT profile_pic AS file_path FROM technicians WHERE profile_pic IS NOT NULL AND is_deleted = 0`,
        `SELECT letterhead_path AS file_path FROM centers WHERE letterhead_path IS NOT NULL AND is_deleted = 0`,
        `SELECT footer_path AS file_path FROM centers WHERE footer_path IS NOT NULL AND is_deleted = 0`,
        `SELECT file_path FROM bulk_upload_logs WHERE file_path IS NOT NULL`,
    ];
    const referenced = new Set();
    for (const sql of queries) {
        try {
            const rows = await db.query(sql);
            for (const row of rows) {
                const normalized = normalizeDbPath(row.file_path);
                if (normalized) referenced.add(normalized);
            }
        } catch (error) {
            logger.warn('Storage referenced file query skipped', { error: error.message });
        }
    }
    try {
        const centerPhotoRows = await db.query(`SELECT dc_photos FROM centers WHERE dc_photos IS NOT NULL AND is_deleted = 0`);
        for (const row of centerPhotoRows) {
            let photos = [];
            try {
                photos = JSON.parse(row.dc_photos || '[]');
            } catch (_) {
                photos = [];
            }
            if (!Array.isArray(photos)) continue;
            for (const photo of photos) {
                const normalized = normalizeDbPath(typeof photo === 'string' ? photo : photo?.path || photo?.file_path);
                if (normalized) referenced.add(normalized);
            }
        }
    } catch (error) {
        logger.warn('Storage center photo reference query skipped', { error: error.message });
    }
    return referenced;
}

async function scanOrphanFiles(req, params = {}) {
    assertSuperAdmin(req.user);
    const limit = Math.min(500, Math.max(1, Number(params.limit || 200)));
    const q = String(params.q || '').trim().toLowerCase();
    const referenced = await getReferencedUploadPaths();
    const files = [];
    let totalFiles = 0;
    let totalSize = 0;

    await walkFiles(UPLOADS_ROOT, async (absolute) => {
        const normalized = path.relative(APP_ROOT, absolute).replace(/\\/g, '/');
        if (referenced.has(normalized)) return;
        if (q && !normalized.toLowerCase().includes(q)) return;
        let stat;
        try {
            stat = await fs.promises.stat(absolute);
        } catch (_) {
            return;
        }
        totalFiles += 1;
        totalSize += stat.size;
        if (files.length < limit) {
            files.push({
                file_path: normalized,
                file_name: path.basename(normalized),
                size: stat.size,
                size_mb: Number((stat.size / (1024 * 1024)).toFixed(2)),
                modified_at: stat.mtime,
            });
        }
    });

    await logAudit(req, 'orphan_scan', {
        totalFiles,
        totalSize,
        metadata: { returned: files.length, q: q || null },
    });

    return {
        files,
        totals: {
            total_files: totalFiles,
            total_size: totalSize,
            total_size_gb: bytesToGb(totalSize),
            returned: files.length,
        },
    };
}

async function processAppointmentDeleteJob(job, updateProgress) {
    const ids = toArray(safeJsonParse(job.appointment_ids_json, []));
    const placeholders = ids.map(() => '?').join(',');
    const appointments = await db.query(
        `SELECT id, case_number, status, qc_status
         FROM appointments
         WHERE id IN (${placeholders}) AND is_deleted = 0`,
        ids
    );
    const byId = new Map(appointments.map(row => [Number(row.id), row]));
    const backupCoverage = await getBackupCoverage(ids);
    const blocked = [];

    for (const id of ids) {
        const appointment = byId.get(id);
        if (!appointment) {
            blocked.push({ appointment_id: id, reason: 'Appointment not found' });
        } else if (!isQcCompleted(appointment)) {
            blocked.push({ appointment_id: id, case_number: appointment.case_number, reason: 'QC is not completed' });
        } else if (!backupCoverage.has(id)) {
            blocked.push({ appointment_id: id, case_number: appointment.case_number, reason: 'Backup ZIP has not been generated' });
        }
    }

    if (blocked.length) {
        const error = new Error('Some selected appointments are not eligible for cleanup');
        error.details = blocked;
        throw error;
    }

    const batch = [];
    for (const id of ids) {
        const collected = await collectAppointmentFiles(id);
        for (const file of collected.files) {
            batch.push({ appointment_id: id, ...file });
        }
    }

    const deleted = [];
    const skipped = [];
    let totalSize = 0;
    const totalFiles = batch.length;
    let processedFiles = 0;

    await updateProgress({
        progress_percent: 5,
        progress_message: `Deleting appointment files 0/${totalFiles}`,
        progress_current: 0,
        progress_total: totalFiles,
    });

    for (const file of batch) {
        processedFiles += 1;
        if (!file.exists) {
            skipped.push({ file_path: file.file_path, reason: 'Missing' });
        } else {
            const absolute = resolveUploadPath(file.file_path);
            if (!absolute) {
                skipped.push({ file_path: file.file_path, reason: 'Outside uploads folder' });
            } else {
                try {
                    const stat = await fs.promises.stat(absolute);
                    await fs.promises.unlink(absolute);
                    deleted.push({
                        appointment_id: file.appointment_id,
                        file_path: file.file_path,
                        category: file.category,
                        size: stat.size,
                    });
                    totalSize += stat.size;
                } catch (error) {
                    skipped.push({ file_path: file.file_path, reason: error.message });
                }
            }
        }

        if (processedFiles === totalFiles || processedFiles % 10 === 0) {
            await updateProgress({
                progress_percent: Math.min(100, Math.round((processedFiles / Math.max(totalFiles, 1)) * 100)),
                progress_message: `Deleting appointment files ${processedFiles}/${totalFiles}`,
                progress_current: processedFiles,
                progress_total: totalFiles,
            });
            await delayImmediate();
        }
    }

    const completedMetadata = {
        ...safeJsonParse(job.metadata_json, {}),
        progress_percent: 100,
        progress_message: 'Cleanup completed',
        progress_current: processedFiles,
        progress_total: totalFiles,
        skipped,
        finished_at: new Date().toISOString(),
    };

    await updateJobRow(job.id, {
        action: 'appointment_files_deleted',
        status: 'completed',
        total_files: deleted.length,
        total_size: totalSize,
        metadata_json: JSON.stringify(completedMetadata),
        error_message: null,
    });

    await logJobAudit(job, 'appointment_files_deleted', {
        appointmentIds: ids,
        filePaths: deleted.map(file => file.file_path),
        totalFiles: deleted.length,
        totalSize,
        remark: job.remark,
        metadata: { skipped },
    });
}

async function processOrphanDeleteJob(job, updateProgress) {
    const paths = safeJsonParse(job.file_paths_json, []).map(normalizeDbPath).filter(Boolean);
    const referenced = await getReferencedUploadPaths();
    const deleted = [];
    const skipped = [];
    let totalSize = 0;
    const totalFiles = paths.length;
    let processedFiles = 0;

    await updateProgress({
        progress_percent: 5,
        progress_message: `Deleting orphan files 0/${totalFiles}`,
        progress_current: 0,
        progress_total: totalFiles,
    });

    for (const filePath of paths) {
        processedFiles += 1;
        if (referenced.has(filePath)) {
            skipped.push({ file_path: filePath, reason: 'File is linked in database' });
        } else {
            const absolute = resolveUploadPath(filePath);
            if (!absolute) {
                skipped.push({ file_path: filePath, reason: 'Outside uploads folder' });
            } else {
                try {
                    const stat = await fs.promises.stat(absolute);
                    if (!stat.isFile()) {
                        skipped.push({ file_path: filePath, reason: 'Not a file' });
                    } else {
                        await fs.promises.unlink(absolute);
                        deleted.push({ file_path: filePath, size: stat.size });
                        totalSize += stat.size;
                    }
                } catch (error) {
                    skipped.push({ file_path: filePath, reason: error.message });
                }
            }
        }

        if (processedFiles === totalFiles || processedFiles % 20 === 0) {
            await updateProgress({
                progress_percent: Math.min(100, Math.round((processedFiles / Math.max(totalFiles, 1)) * 100)),
                progress_message: `Deleting orphan files ${processedFiles}/${totalFiles}`,
                progress_current: processedFiles,
                progress_total: totalFiles,
            });
            await delayImmediate();
        }
    }

    const completedMetadata = {
        ...safeJsonParse(job.metadata_json, {}),
        progress_percent: 100,
        progress_message: 'Cleanup completed',
        progress_current: processedFiles,
        progress_total: totalFiles,
        skipped,
        finished_at: new Date().toISOString(),
    };

    await updateJobRow(job.id, {
        action: 'orphan_files_deleted',
        status: 'completed',
        total_files: deleted.length,
        total_size: totalSize,
        metadata_json: JSON.stringify(completedMetadata),
        error_message: null,
    });

    await logJobAudit(job, 'orphan_files_deleted', {
        filePaths: deleted.map(file => file.file_path),
        totalFiles: deleted.length,
        totalSize,
        remark: job.remark,
        metadata: { skipped },
    });
}

async function deleteAppointmentFiles(req, appointmentIds, remark) {
    assertSuperAdmin(req.user);
    await markQueuedJobsFailedOnce();

    if (!String(remark || '').trim()) {
        const error = new Error('Delete remark is required');
        error.statusCode = 400;
        throw error;
    }

    const ids = toArray(appointmentIds);
    if (!ids.length) {
        const error = new Error('Select at least one appointment');
        error.statusCode = 400;
        throw error;
    }

    const job = await insertStorageJob(req, 'appointment_cleanup', 'appointment_cleanup_requested', ids, remark);
    await processStorageJob(job.id, processAppointmentDeleteJob);
    return buildStorageJobResponse(job);
}

async function deleteOrphanFiles(req, filePaths, remark) {
    assertSuperAdmin(req.user);
    await markQueuedJobsFailedOnce();

    if (!String(remark || '').trim()) {
        const error = new Error('Delete remark is required');
        error.statusCode = 400;
        throw error;
    }

    const paths = Array.isArray(filePaths) ? filePaths.map(normalizeDbPath).filter(Boolean) : [];
    if (!paths.length) {
        const error = new Error('Select at least one orphan file');
        error.statusCode = 400;
        throw error;
    }

    const job = await insertStorageJob(req, 'orphan_cleanup', 'orphan_cleanup_requested', [], remark, paths);
    await processStorageJob(job.id, processOrphanDeleteJob);
    return buildStorageJobResponse(job);
}

async function writeMetadataFile(jobDir, metadata) {
    const metadataPath = path.join(jobDir, 'metadata.json');
    await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
    return metadataPath;
}

function buildZipEntries(preview, metadataPath = null) {
    const entries = [];
    for (const item of preview.appointments) {
        const caseFolder = getAppointmentBackupFolder(item.appointment);
        for (const file of item.files) {
            if (!file.exists) continue;
            const absolute = resolveStoredPath(file.file_path);
            if (!absolute) continue;
            const name = normalizeZipName(`${caseFolder}/${file.category}/${file.file_name || path.basename(file.file_path)}`);
            entries.push({ absolutePath: absolute, name });
        }
    }
    if (metadataPath) {
        entries.push({ absolutePath: metadataPath, name: 'metadata.json' });
    }
    return entries;
}

function buildStorageJobResponse(job) {
    const formatted = formatJobRow(job);
    return {
        ...formatted,
        total_size_gb: bytesToGb(formatted.total_size),
        expires_in_hours: formatted.expires_at ? ZIP_RETENTION_HOURS : null,
        download_url: formatted.status === 'ready' ? `/api/storage-backup/zips/${formatted.id}/download` : null,
    };
}

async function insertStorageJob(req, jobType, action, appointmentIds, remark, filePaths = []) {
    const ids = toArray(appointmentIds);
    const metadata = {
        progress_percent: 0,
        progress_message: 'Queued',
        progress_current: 0,
        progress_total: 0,
    };
    const insert = await db.query(
        `INSERT INTO storage_backup_activity
         (action, job_type, status, appointment_ids_json, file_paths_json, metadata_json, remark, performed_by, ip_address, user_agent)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
        [
            action,
            jobType,
            JSON.stringify(ids),
            JSON.stringify(filePaths || []),
            JSON.stringify(metadata),
            remark,
            req.user.id,
            req.ip || null,
            String(req.headers['user-agent'] || '').slice(0, 500),
        ]
    );
    return fetchJob(insert.insertId);
}

async function processStorageJob(jobId, worker) {
    enqueueStorageJob(jobId, async () => {
        const job = await fetchJob(jobId);
        if (!job || TERMINAL_JOB_STATUSES.has(job.status)) return;

        let metadata = {
            ...safeJsonParse(job.metadata_json, {}),
            progress_percent: 1,
            progress_message: 'Processing',
        };

        const updateProgress = async (patch = {}, extraUpdates = {}) => {
            metadata = { ...metadata, ...patch };
            await persistJobProgress(jobId, metadata, extraUpdates);
        };

        try {
            await updateProgress({}, { status: 'processing', error_message: null });
            await worker(job, updateProgress);
        } catch (error) {
            await updateProgress(
                {
                    progress_message: 'Failed',
                    error_message: error.message,
                    finished_at: new Date().toISOString(),
                },
                {
                    status: 'failed',
                    error_message: error.message,
                }
            );
            logger.error('Storage background job failed', { jobId, jobType: job.job_type, error: error.message });
        }
    });
}

async function cancelJob(req, jobId, remark = '') {
    assertSuperAdmin(req.user);
    const job = await fetchJob(jobId);
    if (!job || !job.job_type) {
        const error = new Error('Storage job not found');
        error.statusCode = 404;
        throw error;
    }

    if (job.status !== 'queued') {
        const error = new Error('Only queued jobs can be cancelled safely');
        error.statusCode = 409;
        throw error;
    }

    const metadata = {
        ...safeJsonParse(job.metadata_json, {}),
        progress_percent: 100,
        progress_message: 'Cancelled before processing',
        cancelled_at: new Date().toISOString(),
        cancelled_by: req.user?.id || null,
    };

    await updateJobRow(job.id, {
        status: 'cancelled',
        error_message: null,
        metadata_json: JSON.stringify(metadata),
    });

    await logAudit(req, 'storage_job_cancelled', {
        jobId: job.id,
        appointmentIds: safeJsonParse(job.appointment_ids_json, []),
        filePaths: safeJsonParse(job.file_paths_json, []),
        remark: String(remark || '').trim() || 'Cancelled before processing',
        metadata: {
            job_type: job.job_type,
        },
    });

    const updatedJob = await fetchJob(job.id);
    return buildStorageJobResponse(updatedJob);
}

async function queueZipJob(req, type, appointmentIds, remark, buildFiles) {
    assertSuperAdmin(req.user);
    await markQueuedJobsFailedOnce();

    if (!String(remark || '').trim()) {
        const error = new Error('Remark is required');
        error.statusCode = 400;
        throw error;
    }

    const ids = toArray(appointmentIds);
    if (!ids.length) {
        const error = new Error('Select at least one appointment');
        error.statusCode = 400;
        throw error;
    }

    const action = type === 'tpa_pdf_backup' ? 'tpa_pdf_zip_requested' : 'backup_zip_requested';
    const job = await insertStorageJob(req, type, action, ids, remark);

    await processStorageJob(job.id, async (jobRow, updateProgress) => {
        const preview = await previewAppointmentsInternal(ids);
        const totalSize = preview.totals.total_size;
        if (type === 'case_backup' && (!totalSize || totalSize > MAX_SIMPLE_ZIP_BYTES)) {
            throw new Error(totalSize ? 'Selected files are too large for one ZIP. Please split into smaller batches.' : 'No existing files found for selected appointments.');
        }

        const now = Date.now();
        const jobDir = path.join(BACKUP_ROOT, `job_${now}_${jobRow.performed_by || 'user'}`);
        await fs.promises.mkdir(jobDir, { recursive: true });
        const fileName = `${type}_${now}.zip`;
        const zipPath = path.join(jobDir, fileName);

        let entries = [];
        let generatedTempFiles = [];
        try {
            if (buildFiles) {
                const result = await buildFiles(preview, jobDir, updateProgress, jobRow);
                entries = result.entries || [];
                generatedTempFiles = result.generatedTempFiles || [];
            } else {
                const metadataPath = await writeMetadataFile(jobDir, {
                    generated_at: new Date().toISOString(),
                    generated_by: jobRow.performed_by,
                    type,
                    remark,
                    preview,
                });
                entries = buildZipEntries(preview, metadataPath);
            }

            if (!entries.length) {
                throw new Error('No files available to zip');
            }

            let entryTotalSize = 0;
            for (const entry of entries) {
                const stat = await fs.promises.stat(entry.absolutePath);
                entryTotalSize += stat.size;
            }

            if (entryTotalSize > MAX_SIMPLE_ZIP_BYTES) {
                throw new Error('Selected files are too large for one ZIP. Please split into smaller batches.');
            }

            await updateProgress({
                progress_percent: 10,
                progress_message: 'Creating ZIP',
                progress_current: 0,
                progress_total: entries.length,
            });

            await createZipFile(zipPath, entries, async ({ processedFiles, totalFiles, processedBytes, currentFile }) => {
                const percent = Math.min(99, Math.max(10, Math.round((processedFiles / Math.max(totalFiles, 1)) * 100)));
                await updateProgress({
                    progress_percent: percent,
                    progress_message: `Zipping ${processedFiles}/${totalFiles}`,
                    progress_current: processedFiles,
                    progress_total: totalFiles,
                    processed_bytes: processedBytes,
                    current_file: currentFile,
                });
                await delayImmediate();
            });

            const stat = await fs.promises.stat(zipPath);
            const filePath = path.relative(APP_ROOT, zipPath).replace(/\\/g, '/');
            const completedMetadata = {
                ...safeJsonParse(jobRow.metadata_json, {}),
                progress_percent: 100,
                progress_message: 'Ready to download',
                progress_current: entries.length,
                progress_total: entries.length,
                preview_totals: preview.totals,
                finished_at: new Date().toISOString(),
            };
            await updateJobRow(jobRow.id, {
                action: type === 'tpa_pdf_backup' ? 'tpa_pdf_zip_generated' : 'backup_zip_generated',
                status: 'ready',
                file_name: fileName,
                file_path: filePath,
                total_files: entries.length,
                total_size: stat.size,
                metadata_json: JSON.stringify(completedMetadata),
                expires_at: new Date(Date.now() + (ZIP_RETENTION_HOURS * 60 * 60 * 1000)),
                error_message: null,
            });

            await logJobAudit(jobRow, type === 'tpa_pdf_backup' ? 'tpa_pdf_zip_generated' : 'backup_zip_generated', {
                appointmentIds: ids,
                filePaths: entries.map(entry => entry.name),
                totalFiles: entries.length,
                totalSize: stat.size,
                remark,
                metadata: { preview_totals: preview.totals },
            });
        } finally {
            for (const temp of generatedTempFiles) {
                try {
                    await fs.promises.unlink(temp);
                } catch (_) {
                    // Best effort cleanup for generated TPA PDFs.
                }
            }
        }
    });

    return buildStorageJobResponse(job);
}

async function generateBackupZip(req, appointmentIds, remark) {
    return queueZipJob(req, 'case_backup', appointmentIds, remark);
}

async function generateTpaPdfZip(req, appointmentIds, remark) {
    return queueZipJob(req, 'tpa_pdf_backup', appointmentIds, remark, async (preview, jobDir, updateProgress) => {
        const generatedTempFiles = [];
        const metadata = {
            generated_at: new Date().toISOString(),
            type: 'tpa_pdf_backup',
            remark,
            files: [],
        };
        const entries = [];
        const totalItems = Math.max(preview.appointments.length, 1);
        let processedItems = 0;

        for (const item of preview.appointments) {
            processedItems += 1;
            await updateProgress({
                progress_percent: Math.min(45, Math.round((processedItems / totalItems) * 45)),
                progress_message: `Generating TPA PDFs ${processedItems}/${totalItems}`,
                progress_current: processedItems,
                progress_total: totalItems,
            });

            try {
                const result = await appointmentsService.generateTPAPDF(item.appointment.id);
                if (!result?.pdfPath) continue;
                const absolute = resolveStoredPath(result.pdfPath);
                if (!absolute || !fs.existsSync(absolute)) continue;
                const caseFolder = getAppointmentBackupFolder(item.appointment);
                const name = normalizeZipName(`${caseFolder}/tpa-pdf/${path.basename(result.pdfPath)}`);
                entries.push({ absolutePath: absolute, name });
                generatedTempFiles.push(absolute);
                metadata.files.push({ appointment_id: item.appointment.id, case_number: item.appointment.case_number, file: name });
            } catch (error) {
                metadata.files.push({ appointment_id: item.appointment.id, case_number: item.appointment.case_number, error: error.message });
            }

            await delayImmediate();
        }

        const metadataPath = await writeMetadataFile(jobDir, metadata);
        entries.push({ absolutePath: metadataPath, name: 'metadata.json' });
        return { entries, generatedTempFiles };
    });
}

async function downloadZip(req, res, jobId) {
    assertSuperAdmin(req.user);
    await markQueuedJobsFailedOnce();
    await cleanupExpiredZips();

    const rows = await db.query(
        `SELECT * FROM storage_backup_activity WHERE id = ? AND status = 'ready' AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
        [jobId]
    );
    if (!rows.length) {
        const error = new Error('ZIP not found or expired');
        error.statusCode = 404;
        throw error;
    }
    const job = rows[0];
    const absolute = resolveBackupPath(job.file_path);
    if (!absolute || !fs.existsSync(absolute)) {
        const error = new Error('ZIP file missing on server');
        error.statusCode = 404;
        throw error;
    }
    const stat = await fs.promises.stat(absolute);

    await db.query('UPDATE storage_backup_activity SET downloaded_at = NOW() WHERE id = ?', [jobId]);
    await logAudit(req, 'zip_downloaded', {
        jobId,
        totalFiles: job.total_files,
        totalSize: job.total_size,
        filePaths: [job.file_path],
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${job.file_name || `backup-${jobId}.zip`}"`);
    return res.sendFile(absolute);
}

async function deleteZip(req, jobId, remark = '') {
    assertSuperAdmin(req.user);
    await cleanupExpiredZips();

    const rows = await db.query(
        `SELECT * FROM storage_backup_activity WHERE id = ? AND status = 'ready' LIMIT 1`,
        [jobId]
    );
    if (!rows.length) {
        const error = new Error('ZIP not found or already removed');
        error.statusCode = 404;
        throw error;
    }

    const job = rows[0];
    const absolute = resolveBackupPath(job.file_path);
    if (absolute) {
        try {
            await fs.promises.rm(path.dirname(absolute), { recursive: true, force: true });
        } catch (error) {
            logger.warn('Failed to manually remove backup ZIP', { jobId, error: error.message });
        }
    }

    await db.query(
        `UPDATE storage_backup_activity
         SET status = 'manual_deleted', deleted_at = NOW(), error_message = NULL
         WHERE id = ?`,
        [jobId]
    );

    await logAudit(req, 'zip_deleted', {
        jobId,
        totalFiles: job.total_files,
        totalSize: job.total_size,
        filePaths: [job.file_path],
        remark: remark || 'Manual ZIP cleanup',
    });

    return {
        id: Number(jobId),
        deleted_size: job.total_size || 0,
        deleted_size_gb: bytesToGb(job.total_size || 0),
    };
}

async function cleanupExpiredZips() {
    const rows = await db.query(
        `SELECT id, file_path FROM storage_backup_activity
         WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= NOW()
         LIMIT 100`
    );
    for (const row of rows) {
        const absolute = resolveBackupPath(row.file_path);
        if (absolute) {
            try {
                await fs.promises.rm(path.dirname(absolute), { recursive: true, force: true });
            } catch (error) {
                logger.warn('Failed to remove expired backup ZIP', { jobId: row.id, error: error.message });
            }
        }
        await db.query(`UPDATE storage_backup_activity SET status = 'expired', deleted_at = NOW() WHERE id = ?`, [row.id]);
    }
}

module.exports = {
    assertSuperAdmin,
    getSummary,
    listAppointments,
    previewAppointments,
    generateBackupZip,
    generateTpaPdfZip,
    downloadZip,
    deleteZip,
    cancelJob,
    scanOrphanFiles,
    deleteAppointmentFiles,
    deleteOrphanFiles,
    cleanupExpiredZips,
};
