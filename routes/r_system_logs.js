const express = require('express');
const router = express.Router();
const { verifyToken } = require('../lib/auth');
const { requirePermission } = require('../lib/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const ApiResponse = require('../lib/response');
const { listLogFiles, readLogFile, safeLogPath } = require('../services/system/ServerLogsService');

const logsAccess = [verifyToken, requirePermission('system.logs.view')];

router.get('/system/logs', ...logsAccess, asyncHandler(async (req, res) => {
    return ApiResponse.success(res, await listLogFiles(), 'Server log files retrieved successfully');
}));

router.get('/system/logs/:fileName/download', ...logsAccess, asyncHandler(async (req, res) => {
    try {
        const filePath = safeLogPath(req.params.fileName);
        res.download(filePath, req.params.fileName);
    } catch (error) {
        if (error.code === 'ENOENT' || error.message === 'Invalid log file name' || error.message === 'Invalid log file path') {
            return ApiResponse.error(res, 'Log file not found', 404);
        }
        throw error;
    }
}));

router.get('/system/logs/:fileName', ...logsAccess, asyncHandler(async (req, res) => {
    try {
        const raw = await readLogFile(req.params.fileName);
        const lines = raw.split(/\r?\n/);
        if (lines.at(-1) === '') lines.pop();
        const data = {
            file: req.params.fileName,
            // Keep every original log line intact, but present the newest line first.
            lines: lines.reverse(),
            total_lines: lines.length,
            raw_size: Buffer.byteLength(raw, 'utf8'),
            has_more: false,
            next_before: null,
        };
        return ApiResponse.success(res, data, 'Server log content retrieved successfully');
    } catch (error) {
        if (error.code === 'ENOENT' || error.message === 'Invalid log file name' || error.message === 'Invalid log file path') {
            return ApiResponse.error(res, 'Log file not found', 404);
        }
        throw error;
    }
}));

module.exports = router;
