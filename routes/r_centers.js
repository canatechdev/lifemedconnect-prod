const express = require('express');
const router = express.Router();
const { verifyToken } = require('../lib/auth');
const { requirePermission } = require('../lib/permissions');
const  validateRequest  = require('../middleware/validateRequest');
const { asyncHandler } = require('../middleware/errorHandler');
const ApiResponse = require('../lib/response');
const logger = require('../lib/logger');
const service = require('../services/s_centers');
const { createWithApproval, updateWithApproval, deleteWithApproval, formatApprovalResponse } = require('../lib/approvalHelper');
const { toMySqlDate } = require('../lib/normalizers');
const db = require('../lib/dbconnection');
const { processSingleFile, processMultipleFiles } = require('../lib/fileUpload');
const { mixedUpload } = require('../lib/multer');
const centerSchemas = require('../validation/v_center');
const { parsePaginationParams } = require('../lib/helpers');

//  NEW: Import security middleware
const { uploadLimiter } = require('../middleware/security');
// File upload configuration
const uploadFields = mixedUpload.fields([
  { name: 'dc_photos', maxCount: 10 },
  { name: 'letterhead_path', maxCount: 1 },
  { name: 'footer_path', maxCount: 1 }
]);

// Helper: Look up center_code for file organization
async function getCenterCode(centerId) {
    try {
        const rows = await db.query('SELECT center_code FROM diagnostic_centers WHERE id = ?', [centerId]);
        return rows?.[0]?.center_code || '';
    } catch { return ''; }
}

async function extractFilePaths(files, existingPhotos = '[]', centerCode = '') {
  if (!files) {
    return { dc_photos: existingPhotos };
  }

  const result = { dc_photos: existingPhotos };

  // Handle dc_photos as an array of stored PATHS (JSON string), matching legacy behavior
  if (files.dc_photos && Array.isArray(files.dc_photos) && files.dc_photos.length > 0) {
    // New uploaded files -> store their relative paths
    const newPaths = await processMultipleFiles(files.dc_photos, 'centers', centerCode);

    // Merge with existing paths (JSON string of paths)
    let existing = [];
    try {
      const parsed = JSON.parse(existingPhotos || '[]');
      if (Array.isArray(parsed)) {
        existing = parsed.map(p => (typeof p === 'string' ? p.replace(/\\/g, '/') : p));
      }
    } catch (e) {
      // ignore parse errors, treat as no existing photos
    }

    const all = [...existing, ...newPaths];
    result.dc_photos = all.length > 0 ? JSON.stringify(all) : null;
  }

  // Handle single letterhead as a single PATH string
  if (files.letterhead_path && Array.isArray(files.letterhead_path) && files.letterhead_path.length > 0) {
    const savedPath = await processSingleFile(files.letterhead_path[0], 'centers', centerCode);
    result.letterhead_path = savedPath || null;
  }

  // Handle single footer as a single PATH string
  if (files.footer_path && Array.isArray(files.footer_path) && files.footer_path.length > 0) {
    const savedPath = await processSingleFile(files.footer_path[0], 'centers', centerCode);
    result.footer_path = savedPath || null;
  }

  return result;
}

router.get('/centers', verifyToken, asyncHandler(async (req, res) => {
  const { page, limit, search, sortBy, sortOrder } = parsePaginationParams(req.query);

  const result = await service.listCenters({
    page,
    limit,
    search: search || '',
    sortBy,
    sortOrder
  });
  return ApiResponse.paginated(res, result.data, result.pagination);
}));

router.get('/centers/:id', verifyToken, asyncHandler(async (req, res) => {
  const row = await service.getCenter(req.params.id);
  if (!row) {
    return ApiResponse.notFound(res, 'Center not found');
  }
  return ApiResponse.success(res, row);
}));


// CREATE - Updated to handle new fields
router.post(
  '/centers',
  verifyToken,
  requirePermission('centers.create'),
  uploadLimiter,
  uploadFields,
  validateRequest(centerSchemas.create),
  asyncHandler(async (req, res) => {
    const filePaths = await extractFilePaths(req.files, '[]', req.body.center_code || '');
    const isActive = req.body.is_active === 'true' || req.body.is_active === true ? 1 : 0;

    const centerData = {
      ...req.body,
      ...filePaths,
      is_active: isActive,
      created_by: req.user.id
    };

    ['gps_latitude', 'gps_longitude', 'service_radius_km', 'extra_charge_per_km'].forEach((field) => {
      if (centerData[field] === '') centerData[field] = null;
    });

    // Convert empty doctor IDs to null
    ['associate_doctor_1_id', 'associate_doctor_2_id', 'associate_doctor_3_id', 'associate_doctor_4_id', 'user_id'].forEach(f => {
      if (centerData[f] === '') centerData[f] = null;
    });

    const result = await createWithApproval({
      entity_type: 'center',
      createFunction: async (data) => await service.createCenter(data),
      data: centerData,
      user: req.user,
      notes: req.body.approval_notes || '',
      priority: req.body.priority || 'medium'
    });

    const response = formatApprovalResponse(result);
    logger.info('Center creation request', { 
      centerId: response.id, 
      needsApproval: response.approval_required,
      userId: req.user.id 
    });

    return ApiResponse.success(res, response, response.message, 201);
  })
);



// UPDATE - Updated to handle new fields
router.put(
  '/centers/:id',
  verifyToken,
  requirePermission('centers.update'),
  uploadLimiter,
  uploadFields,
  validateRequest(centerSchemas.update),
  asyncHandler(async (req, res) => {
    // Log entire req.body to debug
    logger.info(' [CENTER-UPDATE] Full req.body contents:', {
      bodyContents: req.body,
      bodyKeys: Object.keys(req.body),
      bodyEntries: Object.entries(req.body).map(([key, value]) => ({ key, value, type: typeof value }))
    });
    
    logger.info(' [CENTER-UPDATE] Starting update request', {
      centerId: req.params.id,
      userId: req.user.id,
      hasFiles: !!req.files,
      fileFields: req.files ? Object.keys(req.files) : [],
      bodyKeys: Object.keys(req.body),
      existing_dc_photos: req.body.existing_dc_photos,
      existing_dc_photos_type: typeof req.body.existing_dc_photos,
      letterhead_path_in_body: req.body.letterhead_path,
      dc_photos_in_body: req.body.dc_photos,
      dc_photos_remove: req.body.dc_photos_remove,
      letterhead_remove: req.body.letterhead_remove
    });

    // Parse existing_dc_photos if it's a string
    let existingPhotos = req.body.existing_dc_photos || '[]';
    if (typeof existingPhotos === 'string') {
      try {
        // If it's already a JSON string, parse and re-stringify to ensure consistency
        const parsed = JSON.parse(existingPhotos);
        existingPhotos = JSON.stringify(parsed);
      } catch (e) {
        // If parsing fails, treat as empty array
        existingPhotos = '[]';
      }
    } else if (Array.isArray(existingPhotos)) {
      // If it's an array, stringify it
      existingPhotos = JSON.stringify(existingPhotos);
    }
    
    const centerCode = await getCenterCode(req.params.id);
    const filePaths = await extractFilePaths(req.files, existingPhotos, centerCode);

    logger.info(' [CENTER-UPDATE] File paths extracted', {
      filePaths,
      existingPhotos,
      existingPhotosType: typeof req.body.existing_dc_photos,
      existingPhotosRaw: req.body.existing_dc_photos
    });

    let isActive = req.body.is_active;
    if (isActive !== undefined) {
      isActive = isActive === 'true' || isActive === true || isActive === '1' ? 1 : 0;
    }

    // File fields to check
    const fileFields = ['letterhead_path', 'footer_path', 'dc_photos'];
    
    // Build updates object, excluding file fields initially
    const updateData = {
      is_active: isActive,
      updated_by: req.user.id
    };
    
    // Add non-file fields from req.body
    // Exclude file fields, existing_dc_photos, and removal markers (they're not database columns)
    const excludeFields = [...fileFields, 'existing_dc_photos', 'dc_photos_remove', 'letterhead_remove', 'footer_remove'];
    Object.keys(req.body).forEach(key => {
      if (!excludeFields.includes(key)) {
        updateData[key] = req.body[key];
      }
    });

    ['gps_latitude', 'gps_longitude', 'service_radius_km', 'extra_charge_per_km'].forEach((field) => {
      if (updateData[field] === '') updateData[field] = null;
    });
    
    // Now handle file fields - only include if explicitly changed
    fileFields.forEach(field => {
      // Check if user explicitly sent this field (either as file upload or removal)
      const hasNewFile = req.files && req.files[field];
      const hasRemovalFlag = field in req.body && req.body[field] === ''; // Empty string means removal
      const hasExistingData = field === 'dc_photos' && req.body.existing_dc_photos;
      
      // Check for explicit removal markers
      // Frontend sends: letterhead_remove, dc_photos_remove
      const removalMarkerField = field.replace('_path', '') + '_remove';
      const hasRemovalMarker = req.body[removalMarkerField] === 'true' || req.body[removalMarkerField] === true;
      
      logger.info(` [CENTER-UPDATE] Checking field: ${field}`, {
        hasNewFile: !!hasNewFile,
        hasRemovalFlag,
        hasExistingData,
        hasRemovalMarker,
        fieldInBody: field in req.body,
        bodyValue: req.body[field],
        removalMarkerField,
        removalMarkerValue: req.body[removalMarkerField],
        filePathValue: filePaths[field],
        filePathType: typeof filePaths[field]
      });
      
      if (hasRemovalMarker) {
        // Explicit removal - set to null or empty array for dc_photos
        if (field === 'dc_photos') {
          updateData[field] = '[]'; // Empty JSON array for dc_photos
        } else {
          updateData[field] = null;
        }
        logger.info(` [CENTER-UPDATE] Including ${field} in updates (REMOVAL):`, updateData[field]);
      } else if (hasNewFile || hasRemovalFlag || hasExistingData) {
        // User made a change to this field - include it in updates
        // For dc_photos, always use the value from filePaths (which includes existing_dc_photos)
        updateData[field] = filePaths[field];
        logger.info(` [CENTER-UPDATE] Including ${field} in updates:`, {
          value: filePaths[field],
          length: filePaths[field]?.length,
          reason: hasNewFile ? 'new_file' : hasRemovalFlag ? 'removal_flag' : 'existing_data'
        });
      } else {
        logger.info(` [CENTER-UPDATE] Skipping ${field} - no changes detected`);
      }
      // If none of the above, don't include the field (no change)
    });

    // Clean integer fields
    ['associate_doctor_1_id', 'associate_doctor_2_id', 'associate_doctor_3_id', 'associate_doctor_4_id', 'user_id'].forEach(f => {
      if (updateData[f] === '') updateData[f] = null;
    });

    logger.info(' [CENTER-UPDATE] Final update data', {
      updateDataKeys: Object.keys(updateData),
      letterhead_path: updateData.letterhead_path,
      dc_photos: updateData.dc_photos
    });

    const result = await updateWithApproval({
      entity_type: 'center',
      entity_id: parseInt(req.params.id),
      getFunction: async (id) => await service.getCenter(id),
      updateFunction: async (id, data) => await service.updateCenter(id, data),
      new_data: updateData,
      user: req.user,
      notes: req.body.approval_notes || '',
      priority: req.body.priority || 'medium'
    });

    const response = formatApprovalResponse(result);
    logger.info('Center update request', { 
      centerId: req.params.id, 
      needsApproval: response.approval_required,
      userId: req.user.id 
    });

    return ApiResponse.success(res, response, response.message);
  })
);



// POST /centers/delete - Soft delete centers
router.post(
  '/centers/delete',
  verifyToken,
  requirePermission('centers.delete'),
  validateRequest(centerSchemas.delete),
  asyncHandler(async (req, res) => {
    const results = [];

    for (const id of req.body.ids) {
      try {
        const result = await deleteWithApproval({
          entity_type: 'center',
          entity_id: id,
          getFunction: async (ids) => {
            // Handle both single ID and array of IDs
            if (Array.isArray(ids)) {
              return await service.getCentersByIds(ids);
            }
            return await service.getCenter(ids);
          },
          deleteFunction: async (id) => await service.softDeleteCenters([id], req.user.id),
          user: req.user,
          notes: req.body.approval_notes || '',
          priority: req.body.priority || 'high'
        });
        results.push({ id, ...formatApprovalResponse(result) });
      } catch (error) {
        results.push({ id, error: error.message });
      }
    }

    const needsApproval = results.some(r => r.approval_required);
    const message = needsApproval 
      ? 'Delete requests submitted for Super Admin approval'
      : 'Centers deleted successfully';

    logger.info('Centers deletion request', { 
      count: results.length, 
      needsApproval,
      userId: req.user.id 
    });

    return ApiResponse.success(res, { results }, message);
  })
);





router.delete('/centers/:id', verifyToken, requirePermission('centers.delete'), asyncHandler(async (req, res) => {
  const affected = await service.deleteCenter(req.params.id);
  if (!affected) {
    return ApiResponse.notFound(res, 'Center not found');
  }

  logger.info('Center deleted', { centerId: req.params.id, deletedBy: req.user.id });
  return ApiResponse.success(res, { deleted: affected }, 'Center deleted successfully');
}));






module.exports = router;


