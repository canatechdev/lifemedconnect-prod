const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../lib/auth');
const { requirePermission } = require('../lib/permissions');
const ApiResponse = require('../lib/response');
const logger = require('../lib/logger');
const { asyncHandler } = require('../middleware/errorHandler');
const validateRequest = require('../middleware/validateRequest');
const service = require('../services/callCenter/CallCenterService');

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
    appointment_date: Joi.date().iso().allow('', null).optional(),
    gender: Joi.string().valid('Male', 'Female', 'Other').allow('', null).optional(),
}).or('address', 'landmark', 'pincode', 'latitude').and('latitude', 'longitude');

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

module.exports = router;
