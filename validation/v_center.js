const Joi = require('joi');

const centerSchemas = {
  /**
   * Schema for creating a new center
   */
  create: Joi.object({
    center_code: Joi.string().max(50).optional().allow(null, ''),
    user_id: Joi.number().integer().optional().allow(null, ''),
    center_name: Joi.string().max(255).required().messages({
      'string.empty': 'Center name is required',
      'any.required': 'Center name is required'
    }),
    center_type: Joi.string().max(55).required().messages({
      'string.empty': 'Center type is required',
      'any.required': 'Center type is required'
    }),
    address: Joi.string().required().messages({
      'string.empty': 'Address is required',
      'any.required': 'Address is required'
    }),
    owner_name: Joi.string().optional().allow(null, ''),
    contact_number: Joi.string().max(20).optional().allow(null, ''),
    email: Joi.string().email().optional().allow(null, ''),
    city: Joi.string().max(100).optional().allow(null, ''),
    city_type: Joi.string().max(45).optional().allow(null, ''),
    state: Joi.string().max(100).optional().allow(null, ''),
    pincode: Joi.string().optional().allow(null, ''),
    country: Joi.string().max(45).optional().allow(null, ''),
    gps_latitude: Joi.number().precision(8).optional().allow(null, ''),
    gps_longitude: Joi.number().precision(8).optional().allow(null, ''),
    service_radius_km: Joi.number().min(0).precision(2).optional().allow(null, ''),
    extra_charge_per_km: Joi.number().min(0).precision(2).optional().allow(null, ''),
    is_active: Joi.optional().default(1),
    letterhead_path: Joi.string().max(500).optional().allow(null, ''),
    associate_doctor_1_id: Joi.number().integer().optional().allow(null, ''),
    associate_doctor_2_id: Joi.number().integer().optional().allow(null, ''),
    associate_doctor_3_id: Joi.number().integer().optional().allow(null, ''),
    associate_doctor_4_id: Joi.number().integer().optional().allow(null, ''),
    acc_name: Joi.string().max(105).optional().allow(null, ''),
    acc_no: Joi.string().max(50).optional().allow(null, ''),
    ifsc_code: Joi.string().max(20).optional().allow(null, ''),
    receivers_name: Joi.string().max(105).optional().allow(null, ''),
    branch_name: Joi.string().max(105).optional().allow(null, ''),
    accredation: Joi.string().max(255).optional().allow(null, ''),
    approval_notes: Joi.string().optional().allow(null, ''),
    priority: Joi.string().valid('low', 'medium', 'high').optional().default('medium')
  }),

  /**
   * Schema for updating an existing center
   */
  update: Joi.object({
    center_code: Joi.string().max(50).optional().allow(null, ''),
    user_id: Joi.number().integer().optional().allow(null, ''),
    center_name: Joi.string().max(255).optional().messages({
      'string.max': 'Center name cannot exceed 255 characters'
    }),
    center_type: Joi.string().max(55).optional(),
    address: Joi.string().optional(),
    owner_name: Joi.string().optional().allow(null, ''),
    contact_number: Joi.string().max(20).optional().allow(null, ''),
    email: Joi.string().email().optional().allow(null, ''),
    city: Joi.string().max(100).optional().allow(null, ''),
    city_type: Joi.string().max(45).optional().allow(null, ''),
    state: Joi.string().max(100).optional().allow(null, ''),
    pincode: Joi.string().optional().allow(null, ''),
    country: Joi.string().max(45).optional().allow(null, ''),
    gps_latitude: Joi.number().precision(8).optional().allow(null, ''),
    gps_longitude: Joi.number().precision(8).optional().allow(null, ''),
    service_radius_km: Joi.number().min(0).precision(2).optional().allow(null, ''),
    extra_charge_per_km: Joi.number().min(0).precision(2).optional().allow(null, ''),
    is_active: Joi.optional(),
    letterhead_path: Joi.string().max(500).optional().allow(null, ''),
    dc_photos: Joi.any().optional(), // For file uploads
    existing_dc_photos: Joi.string().optional(), // For existing files tracking
    dc_photos_remove: Joi.string().optional(), // For removal marker
    letterhead_remove: Joi.string().optional(), // For removal marker
    associate_doctor_1_id: Joi.number().integer().optional().allow(null, ''),
    associate_doctor_2_id: Joi.number().integer().optional().allow(null, ''),
    associate_doctor_3_id: Joi.number().integer().optional().allow(null, ''),
    associate_doctor_4_id: Joi.number().integer().optional().allow(null, ''),
    acc_name: Joi.string().max(105).optional().allow(null, ''),
    acc_no: Joi.string().max(50).optional().allow(null, ''),
    ifsc_code: Joi.string().max(20).optional().allow(null, ''),
    receivers_name: Joi.string().max(105).optional().allow(null, ''),
    branch_name: Joi.string().max(105).optional().allow(null, ''),
    accredation: Joi.string().max(255).optional().allow(null, ''),
    approval_notes: Joi.string().optional().allow(null, ''),
    priority: Joi.string().valid('low', 'medium', 'high').optional()
  }),

  /**
   * Schema for deleting multiple centers
   */
  delete: Joi.object({
    ids: Joi.array()
      .items(Joi.number().integer().positive())
      .min(1)
      .required()
      .messages({
        'array.base': 'IDs must be an array',
        'array.min': 'At least one ID is required for deletion',
        'number.integer': 'Each ID must be an integer',
        'number.positive': 'Each ID must be a positive number',
        'any.required': 'IDs are required for deletion'
      }),
    approval_notes: Joi.string().optional().allow(null, ''),
    priority: Joi.string().valid('low', 'medium', 'high').optional().default('medium')
  })
};

module.exports = centerSchemas;
