const express = require('express');
const { verifyToken } = require('../lib/auth');
const ApiResponse = require('../lib/response');
const storageBackupService = require('../services/s_storage_backup');
const logger = require('../lib/logger');

const router = express.Router();

function handleRouteError(res, error, message = 'Storage backup request failed') {
    const statusCode = error.statusCode || error.status || 500;
    return ApiResponse.error(res, error.message || message, statusCode, error.details || null);
}

router.get('/storage-backup/summary', verifyToken, async (req, res) => {
    try {
        const summary = await storageBackupService.getSummary(req);
        return ApiResponse.success(res, summary, 'Storage summary fetched successfully');
    } catch (error) {
        logger.error('Storage backup summary failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.get('/storage-backup/appointments', verifyToken, async (req, res) => {
    try {
        const result = await storageBackupService.listAppointments(req, req.query);
        return ApiResponse.paginated(res, result.data, result.pagination, 'Appointments fetched successfully');
    } catch (error) {
        logger.error('Storage backup appointments failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.post('/storage-backup/appointments/preview', verifyToken, async (req, res) => {
    try {
        const preview = await storageBackupService.previewAppointments(req, req.body.appointment_ids);
        return ApiResponse.success(res, preview, 'Storage backup preview fetched successfully');
    } catch (error) {
        logger.error('Storage backup preview failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.post('/storage-backup/backup-zip', verifyToken, async (req, res) => {
    try {
        const job = await storageBackupService.generateBackupZip(
            req,
            req.body.appointment_ids,
            req.body.remark
        );
        return ApiResponse.success(res, job, 'Backup ZIP queued successfully', 202);
    } catch (error) {
        logger.error('Storage backup ZIP failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.post('/storage-backup/tpa-pdf-zip', verifyToken, async (req, res) => {
    try {
        const job = await storageBackupService.generateTpaPdfZip(
            req,
            req.body.appointment_ids,
            req.body.remark
        );
        return ApiResponse.success(res, job, 'TPA PDF ZIP queued successfully', 202);
    } catch (error) {
        logger.error('Storage TPA PDF ZIP failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.get('/storage-backup/zips/:id/download', verifyToken, async (req, res) => {
    try {
        return await storageBackupService.downloadZip(req, res, req.params.id);
    } catch (error) {
        logger.error('Storage ZIP download failed', { error: error.message, jobId: req.params.id, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.delete('/storage-backup/zips/:id', verifyToken, async (req, res) => {
    try {
        const result = await storageBackupService.deleteZip(req, req.params.id, req.body.remark);
        return ApiResponse.success(res, result, 'ZIP deleted successfully');
    } catch (error) {
        logger.error('Storage ZIP delete failed', { error: error.message, jobId: req.params.id, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.patch('/storage-backup/jobs/:id/cancel', verifyToken, async (req, res) => {
    try {
        const result = await storageBackupService.cancelJob(req, req.params.id, req.body.remark);
        return ApiResponse.success(res, result, 'Storage job cancelled successfully');
    } catch (error) {
        logger.error('Storage job cancel failed', { error: error.message, jobId: req.params.id, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.get('/storage-backup/orphans', verifyToken, async (req, res) => {
    try {
        const result = await storageBackupService.scanOrphanFiles(req, req.query);
        return ApiResponse.success(res, result, 'Orphan files scanned successfully');
    } catch (error) {
        logger.error('Storage orphan scan failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.delete('/storage-backup/appointments/files', verifyToken, async (req, res) => {
    try {
        const result = await storageBackupService.deleteAppointmentFiles(
            req,
            req.body.appointment_ids,
            req.body.remark
        );
        return ApiResponse.success(res, result, 'Appointment file cleanup queued successfully', 202);
    } catch (error) {
        logger.error('Storage appointment cleanup failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

router.delete('/storage-backup/orphans', verifyToken, async (req, res) => {
    try {
        const result = await storageBackupService.deleteOrphanFiles(
            req,
            req.body.file_paths,
            req.body.remark
        );
        return ApiResponse.success(res, result, 'Orphan cleanup queued successfully', 202);
    } catch (error) {
        logger.error('Storage orphan cleanup failed', { error: error.message, userId: req.user?.id });
        return handleRouteError(res, error);
    }
});

module.exports = router;
