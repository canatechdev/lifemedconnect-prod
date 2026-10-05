const express = require('express');
const router = express.Router();
const service = require('../services/s_test_bulk');
const testMasterBulkService = require('../services/s_test_master_bulk');
const { excelUpload } = require('../lib/multer');
const { verifyToken } = require('../lib/auth');
const { requirePermission } = require('../lib/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../lib/logger');
const ApiResponse = require('../lib/response');

// NEW: Import security middleware
const { uploadLimiter } = require('../middleware/security');

// ===================================
// DOWNLOAD RATES TEMPLATE
// ===================================
router.get('/test-bulk/download-rates-template', asyncHandler(service.downloadRatesTemplate));

// ===================================
// DOWNLOAD COLORED LOG FILE
// ===================================
router.get('/test-bulk/download-log/:logId', asyncHandler(service.downloadColoredLog));

// ===================================
// DOWNLOAD ALL MY RATES (Editable)
// ===================================
router.get('/test-bulk/download-my-rates', asyncHandler(service.downloadMyRates));

// ===================================
// UPLOAD RATES – WITH TOKEN VERIFICATION
// ===================================
// NEW: Apply upload rate limiter (30 uploads per 15 minutes)
router.post('/test-bulk/upload', verifyToken, uploadLimiter, excelUpload.single('excelFile'), asyncHandler(service.uploadRates));

// ===================================
// TEST MASTER ADD / UPDATE IMPORT
// The service validates duplicates before any database write. No DB unique constraint is required.
// ===================================
router.get(
  '/test-bulk/download-test-master-template',
  verifyToken,
  requirePermission('tests.import'),
  asyncHandler(testMasterBulkService.downloadTemplate)
);
router.post(
  '/test-bulk/master-upload',
  verifyToken,
  requirePermission('tests.import'),
  uploadLimiter,
  excelUpload.single('excelFile'),
  asyncHandler(testMasterBulkService.uploadTestMaster)
);

// ===================================
// Get Test Category Rates Excel Logs 
// ===================================
router.get('/test-bulk/TestRateLogs', asyncHandler(service.getTestRatesUploadLogs));



module.exports = router;


