const express = require('express');
const router = express.Router();
const { verifyToken } = require('../lib/auth');
const { hasPermission, requirePermission } = require('../lib/permissions');
const service = require('../services/s_technicians');
const Joi = require('joi');
const { asyncHandler } = require('../middleware/errorHandler');
const validateRequest = require('../middleware/validateRequest');
const ApiResponse = require('../lib/response');
const logger = require('../lib/logger');
const { parsePaginationParams } = require('../lib/helpers');
const { mixedUpload } = require('../lib/multer');
const { processSingleFile } = require('../lib/fileUpload');
const db = require('../lib/dbconnection');
const unavailabilityAlerts = require('../services/TechnicianUnavailabilityAlertService');

// Helper: Look up technician_code for file organization
async function getTechnicianCode(technicianId) {
    try {
        const rows = await db.query('SELECT technician_code FROM technicians WHERE id = ?', [technicianId]);
        return rows?.[0]?.technician_code || '';
    } catch { return ''; }
}

// Helper: Get center city for city-based technician sharing
async function getCenterCity(centerId) {
    try {
        const rows = await db.query('SELECT city FROM diagnostic_centers WHERE id = ? AND is_deleted = 0', [centerId]);
        return rows?.[0]?.city || null;
    } catch { return null; }
}

const technicianSchema = Joi.object({
  user_id: Joi.number().integer().optional().allow(null),
  center_id: Joi.number().integer().required(),
  technician_code: Joi.string().max(50).optional().allow('', null),
  technician_type: Joi.string().valid('On-Call', 'In-House').default('In-House'),
  rate_per_appointment: Joi.number().precision(2).default(0.00),
  profile_pic: Joi.string().max(255).optional().allow(null, ''),
  full_name: Joi.string().max(255).required(),
  mobile: Joi.string().max(20).required(),
  email: Joi.string().email().max(255).optional().allow(null, ''),
  home_gps_latitude: Joi.number().precision(8).optional().allow(null),
  home_gps_longitude: Joi.number().precision(8).optional().allow(null),
  home_address: Joi.string().optional().allow(null, ''),
  qualification: Joi.string().max(255).optional().allow(null, ''),
  experience_years: Joi.number().integer().min(0).optional().allow(null),
  call_center_priority: Joi.number().integer().min(1).max(9999).optional().allow(null, ''),
  male_daily_capacity: Joi.number().integer().min(0).max(1000).optional().allow(null, ''),
  female_daily_capacity: Joi.number().integer().min(0).max(1000).optional().allow(null, ''),
  other_daily_capacity: Joi.number().integer().min(0).max(1000).optional().allow(null, ''),
  service_pincodes: Joi.string().max(1000).optional().allow(null, ''),
  is_active: Joi.number().optional(),
  profile_pic_remove: Joi.string().valid('true', 'false').optional()
});

const technicianUpdateSchema = technicianSchema.fork(Object.keys(technicianSchema.describe().keys), field => field.optional());

const deleteTechniciansSchema = Joi.object({
  ids: Joi.array().items(Joi.number().integer().positive()).min(1).required()
});

const technicianUnavailabilitySchema = Joi.object({
  unavailable_from: Joi.date().iso().required(),
  unavailable_to: Joi.date().iso().min(Joi.ref('unavailable_from')).required(),
  reason: Joi.string().trim().max(500).allow('', null).optional(),
});

const callCenterPlanningFields = [
  'call_center_priority',
  'male_daily_capacity',
  'female_daily_capacity',
  'other_daily_capacity',
  'service_pincodes',
];

function normalizeServicePincodes(value) {
  if (value === null || value === undefined || value === '') return null;
  const pincodes = String(value)
    .split(/[\s,;|]+/)
    .map((pincode) => pincode.replace(/\D/g, ''))
    .filter((pincode) => /^\d{6}$/.test(pincode));
  return Array.from(new Set(pincodes)).join(',') || null;
}

function hasCallCenterPlanningFields(data) {
  return callCenterPlanningFields.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function canManageTechnicianPlanning(req) {
  const permissions = req.user?.permissions || [];
  return hasPermission(permissions, 'technicians.update') || hasPermission(permissions, 'technicians.create');
}



router.get('/technicians', verifyToken, asyncHandler(async (req, res) => {
  const { page, limit, search, sortBy, sortOrder } = parsePaginationParams(req.query);
  const { center_id, include_city_technicians } = req.query;

  // Get user's center city if they're a center user and city sharing is requested
  let user_center_city = null;
  if (center_id && include_city_technicians === 'true' && req.user.diagnostic_center_id) {
    user_center_city = await getCenterCity(req.user.diagnostic_center_id);
  }

  // For dropdown usage, remove pagination limits unless explicitly requested
  const effectiveLimit = limit || 0;

  const result = await service.listTechnicians({
    page,
    limit: effectiveLimit,
    search,
    sortBy,
    sortOrder,
    center_id: center_id ? parseInt(center_id) : null,
    include_city_technicians: include_city_technicians === 'true',
    user_center_city
  });
  return ApiResponse.paginated(res, result.data, result.pagination);
}));








router.get('/technicians/:id', verifyToken, asyncHandler(async (req, res) => {
  const row = await service.getTechnician(req.params.id);
  if (!row) {
    return ApiResponse.notFound(res, 'Technician not found');
  }
  return ApiResponse.success(res, row);
}));
router.post('/technicians', verifyToken, requirePermission('technicians.create'), mixedUpload.single('profile_pic_file'), validateRequest(technicianSchema), asyncHandler(async (req, res) => {
  if (hasCallCenterPlanningFields(req.body) && !canManageTechnicianPlanning(req)) {
    return ApiResponse.forbidden(res, 'You do not have permission to manage technician planning settings');
  }
  const profilePicPath = req.file ? await processSingleFile(req.file, 'technicians') : null;
  const technicianData = {
    ...req.body,
    profile_pic: profilePicPath || req.body.profile_pic
  };

  if (req.body.profile_pic_remove === 'true') {
    technicianData.profile_pic = null;
  }
  ['call_center_priority', 'male_daily_capacity', 'female_daily_capacity', 'other_daily_capacity'].forEach((field) => {
    if (technicianData[field] === '') technicianData[field] = null;
  });
  if (Object.prototype.hasOwnProperty.call(technicianData, 'service_pincodes')) {
    technicianData.service_pincodes = normalizeServicePincodes(technicianData.service_pincodes);
  }
  delete technicianData.profile_pic_remove;

  const id = await service.createTechnician(technicianData);
  logger.info('Technician created', { technicianId: id, createdBy: req.user.id });

  return ApiResponse.success(res, { id }, 'Technician created successfully', 201);
}));



router.put('/technicians/:id', verifyToken, requirePermission('technicians.update'), mixedUpload.single('profile_pic_file'), validateRequest(technicianUpdateSchema), asyncHandler(async (req, res) => {
  if (hasCallCenterPlanningFields(req.body) && !canManageTechnicianPlanning(req)) {
    return ApiResponse.forbidden(res, 'You do not have permission to manage technician planning settings');
  }
  const techCode = await getTechnicianCode(req.params.id);
  let profilePicPath = null;
  if (req.file) {
    profilePicPath = await processSingleFile(req.file, 'technicians', techCode);
  }

  const updates = { ...req.body };
  if (profilePicPath) {
    updates.profile_pic = profilePicPath;
  } else if (req.body.profile_pic_remove === 'true') {
    updates.profile_pic = null;
  }

  // Remove the removal flag from updates if present
  delete updates.profile_pic_remove;
  ['call_center_priority', 'male_daily_capacity', 'female_daily_capacity', 'other_daily_capacity'].forEach((field) => {
    if (updates[field] === '') updates[field] = null;
  });
  if (Object.prototype.hasOwnProperty.call(updates, 'service_pincodes')) {
    updates.service_pincodes = normalizeServicePincodes(updates.service_pincodes);
  }

  const affected = await service.updateTechnician(req.params.id, updates);
  if (!affected) {
    return ApiResponse.notFound(res, 'Technician not found or no changes made');
  }

  logger.info('Technician updated', { technicianId: req.params.id, updatedBy: req.user.id });
  return ApiResponse.success(res, { updated: affected }, 'Technician updated successfully');
}));

router.get('/technicians/:id/unavailability', verifyToken, requirePermission('technicians.update'), asyncHandler(async (req, res) => {
  return ApiResponse.success(res, await service.getTechnicianUnavailability(Number(req.params.id)));
}));

router.post('/technicians/:id/unavailability/impact', verifyToken, requirePermission('technicians.update'), validateRequest(technicianUnavailabilitySchema), asyncHandler(async (req, res) => {
  const appointments = await unavailabilityAlerts.getAffectedAppointments(
    Number(req.params.id), req.body.unavailable_from, req.body.unavailable_to,
  );
  return ApiResponse.success(res, appointments, 'Affected appointments retrieved successfully');
}));

router.get('/technicians/:id/unavailability/:periodId/affected-appointments', verifyToken, requirePermission('technicians.update'), asyncHandler(async (req, res) => {
  const periods = await service.getTechnicianUnavailability(Number(req.params.id));
  const period = periods.find((item) => Number(item.id) === Number(req.params.periodId));
  if (!period) return ApiResponse.notFound(res, 'Unavailable period not found');
  const appointments = await unavailabilityAlerts.getAffectedAppointments(
    Number(req.params.id), period.unavailable_from, period.unavailable_to,
  );
  return ApiResponse.success(res, appointments, 'Affected appointments retrieved successfully');
}));

router.post('/technicians/:id/unavailability', verifyToken, requirePermission('technicians.update'), validateRequest(technicianUnavailabilitySchema), asyncHandler(async (req, res) => {
  const id = await service.addTechnicianUnavailability(Number(req.params.id), req.body, req.user.id);
  let appointments = [];
  let notification = { sent: false, reason: 'not_required' };
  try {
    appointments = await unavailabilityAlerts.getAffectedAppointments(
      Number(req.params.id), req.body.unavailable_from, req.body.unavailable_to,
    );
    notification = await unavailabilityAlerts.sendInitialDcNotice(id, appointments);
  } catch (error) {
    logger.error('Technician unavailable period saved but DC notification could not be processed', {
      technicianId: req.params.id,
      periodId: id,
      message: error.message,
    });
    notification = { sent: false, reason: 'notification_processing_failed' };
  }
  return ApiResponse.success(res, { id, affected_appointments: appointments, notification }, 'Technician unavailable period added successfully', 201);
}));

router.delete('/technicians/:id/unavailability/:periodId', verifyToken, requirePermission('technicians.update'), asyncHandler(async (req, res) => {
  const updated = await service.removeTechnicianUnavailability(Number(req.params.id), Number(req.params.periodId), req.user.id);
  if (!updated) return ApiResponse.notFound(res, 'Unavailable period not found');
  return ApiResponse.success(res, { updated }, 'Technician unavailable period removed successfully');
}));


router.post('/technicians/delete', verifyToken, requirePermission('technicians.delete'), validateRequest(deleteTechniciansSchema), asyncHandler(async (req, res) => {
  const affected = await service.softDeleteTechnician(req.body.ids);
  if (!affected) {
    return ApiResponse.notFound(res, 'No technicians were found or already deleted');
  }

  logger.info('Technicians soft deleted', { count: affected, deletedBy: req.user.id });
  return ApiResponse.success(res, { updated: affected }, 'Technicians deleted successfully');
}));



router.delete('/technicians/:id', verifyToken, requirePermission('technicians.delete'), asyncHandler(async (req, res) => {
  const affected = await service.deleteTechnician(req.params.id);
  if (!affected) {
    return ApiResponse.notFound(res, 'Technician not found');
  }

  logger.info('Technician deleted', { technicianId: req.params.id, deletedBy: req.user.id });
  return ApiResponse.success(res, { deleted: affected }, 'Technician deleted successfully');
}));

module.exports = router;


