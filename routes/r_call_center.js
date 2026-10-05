const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../lib/auth');
const { requirePermission } = require('../lib/permissions');
const ApiResponse = require('../lib/response');
const logger = require('../lib/logger');
const { asyncHandler } = require('../middleware/errorHandler');
const validateRequest = require('../middleware/validateRequest');
const service = require('../services/callCenter/CallCenterService');
const pincodeService = require('../services/callCenter/CallCenterPincodeService');
const { excelUpload } = require('../lib/multer');
const { uploadLimiter } = require('../middleware/security');

const router = express.Router();

const locationFields = {
    address: Joi.string().trim().max(500).allow('', null).optional(),
    landmark: Joi.string().trim().max(255).allow('', null).optional(),
    pincode: Joi.string().trim().max(12).allow('', null).optional(),
    latitude: Joi.number().min(-90).max(90).optional(),
    longitude: Joi.number().min(-180).max(180).optional(),
};

const searchSchema = Joi.object({
    ...locationFields,
    search_mode: Joi.string().valid('saved_pincode', 'live_location').allow('', null).optional(),
    appointment_date: Joi.date().iso().allow('', null).optional(),
    gender: Joi.string().valid('Male', 'Female', 'Other').allow('', null).optional(),
}).or('address', 'landmark', 'pincode', 'latitude').and('latitude', 'longitude');

const pincodeMappingSchema = Joi.object({
    pincode: Joi.string().trim().max(12).required(),
    city: Joi.string().trim().max(120).required(),
    charge_type: Joi.string().valid('free', 'paid', 'Free', 'Paid').required(),
    average_one_way_distance_km: Joi.number().min(0).allow(null, '').optional(),
    average_additional_cost: Joi.number().min(0).allow(null, '').optional(),
    formatted_address: Joi.string().trim().max(2000).allow('', null).optional(),
    latitude: Joi.number().min(-90).max(90).allow(null).optional(),
    longitude: Joi.number().min(-180).max(180).allow(null).optional(),
    center_ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
});

router.get('/summary', verifyToken, requirePermission('call_center.view'), asyncHandler(async (req, res) => {
    const data = await service.getSummary(req.query.date);
    return ApiResponse.success(res, data, 'Call Center summary retrieved successfully');
}));

router.post('/search', verifyToken, requirePermission('call_center.view'), validateRequest(searchSchema), asyncHandler(async (req, res) => {
    const data = await service.searchPlanner(req.body);
    logger.info('Call Center planner search completed', {
        userId: req.user.id,
        appointmentDate: req.body.appointment_date,
        centersReturned: data.centers.length,
    });
    return ApiResponse.success(res, data, 'Call Center planning results retrieved successfully');
}));

router.get('/pincodes', verifyToken, requirePermission('call_center.manage'), asyncHandler(async (req, res) => {
    const result = await pincodeService.list(req.query);
    return ApiResponse.paginated(res, result.data, result.pagination, 'Call Center pincode mappings retrieved successfully');
}));

router.get('/pincodes/centers', verifyToken, requirePermission('call_center.manage'), asyncHandler(async (req, res) => {
    const centers = await pincodeService.getCenters();
    return ApiResponse.success(res, centers, 'Diagnostic centers retrieved successfully');
}));

router.get('/pincodes/template', verifyToken, requirePermission('call_center.manage'), asyncHandler((req, res) => pincodeService.downloadTemplate(req, res)));

router.post('/pincodes/import', verifyToken, requirePermission('call_center.manage'), uploadLimiter, excelUpload.single('excelFile'), asyncHandler((req, res) => pincodeService.importExcel(req, res)));

router.post('/pincodes', verifyToken, requirePermission('call_center.manage'), validateRequest(pincodeMappingSchema), asyncHandler(async (req, res) => {
    const data = await pincodeService.create(req.body, req.user?.id);
    return ApiResponse.success(res, data, 'Call Center pincode mapping created successfully');
}));

router.put('/pincodes/:id', verifyToken, requirePermission('call_center.manage'), validateRequest(pincodeMappingSchema), asyncHandler(async (req, res) => {
    const data = await pincodeService.update(req.params.id, req.body, req.user?.id);
    return ApiResponse.success(res, data, 'Call Center pincode mapping updated successfully');
}));

router.delete('/pincodes/:id', verifyToken, requirePermission('call_center.manage'), asyncHandler(async (req, res) => {
    await pincodeService.remove(req.params.id, req.user?.id);
    return ApiResponse.success(res, null, 'Call Center pincode mapping deleted successfully');
}));

module.exports = router;
