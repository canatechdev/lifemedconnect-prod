/**
 * Appointment Validation Schemas
 */

const Joi = require('joi');

// Base appointment schema for create
const appointmentCreateSchema = Joi.object({
    case_number: Joi.string().allow(null, '').optional(),
    application_number: Joi.string().required(),
    client_id: Joi.number().allow(null).optional(),
    center_id: Joi.number().allow(null).optional(),
    other_center_id: Joi.number().allow(null).optional(),
    insurer_id: Joi.number().allow(null).optional(),
    customer_first_name: Joi.string().allow(null, '').optional(),
    customer_last_name: Joi.string().allow(null, '').optional(),
    gender: Joi.string().valid('Male', 'Female', 'Other').allow(null, '').optional(),
    customer_mobile: Joi.string().allow(null, '').optional(),
    customer_alt_mobile: Joi.string().allow(null, '').optional(),
    customer_service_no: Joi.string().allow(null, '').optional(),
    customer_email: Joi.string().email().allow(null, '').optional(),
    customer_address: Joi.string().allow(null, '').optional(),
    state: Joi.string().allow(null, '').optional(),
    city: Joi.string().allow(null, '').optional(),
    pincode: Joi.string().allow(null, '').optional(),
    country: Joi.string().allow(null, '').optional(),
    customer_gps_latitude: Joi.number().allow(null).optional(),
    customer_gps_longitude: Joi.number().allow(null).optional(),
    customer_landmark: Joi.string().allow(null, '').optional(),
    visit_type: Joi.string().valid('Home_Visit', 'Center_Visit', 'Both').allow(null, '').optional(),
    customer_category: Joi.string().valid('Non_HNI', 'SUPER_HNI', 'HNI').allow(null, '').optional(),
    appointment_date: Joi.date().required(),
    appointment_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).allow(null, '').optional(),
    confirmed_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).allow(null, '').optional(),
    status: Joi.string().allow(null, '').optional(),
    assigned_technician_id: Joi.number().allow(null).optional(),
    remarks: Joi.string().allow(null, '').optional(),
    cancellation_reason: Joi.string().allow(null, '').optional(),
    cost_type: Joi.string().allow(null, '').optional(),
    amount: Joi.number().allow(null).optional(),
    amount_upload: Joi.string().allow(null, '').optional(),
    case_severity: Joi.number().allow(null).optional(),
    selected_items: Joi.alternatives()
        .try(
            Joi.array().items(
                Joi.object({
                    id: Joi.number().required(),
                    name: Joi.string().required(),
                    type: Joi.string().valid('test', 'category').required(),
                    rate: Joi.number().required(),
                    assigned_center_id: Joi.number().allow(null).optional(),
                    assigned_technician_id: Joi.number().allow(null).optional(),
                    visit_subtype: Joi.string().valid('center', 'home').allow(null).optional(),
                    assigned_to: Joi.string().valid('center1', 'center2').allow(null).optional()
                })
            ),
            Joi.string().custom((value, helpers) => {
                try {
                    const parsed = JSON.parse(value);
                    if (!Array.isArray(parsed)) {
                        return helpers.error('any.invalid', { message: '"selected_items" must be a valid JSON array' });
                    }
                    for (const item of parsed) {
                        const { error } = Joi.object({
                            id: Joi.number().required(),
                            name: Joi.string().required(),
                            type: Joi.string().valid('test', 'category').required(),
                            rate: Joi.number().required(),
                            assigned_center_id: Joi.number().allow(null).optional(),
                            assigned_technician_id: Joi.number().allow(null).optional(),
                            visit_subtype: Joi.string().valid('center', 'home').allow(null).optional(),
                            assigned_to: Joi.string().valid('center1', 'center2').allow(null).optional()
                        }).validate(item);
                        if (error) {
                            return helpers.error('any.invalid', { message: error.message });
                        }
                    }
                    return parsed;
                } catch (err) {
                    return helpers.error('any.invalid', { message: '"selected_items" must be a valid JSON array' });
                }
            })
        )
        .allow(null)
        .optional(),
    total_amount: Joi.number().allow(null).optional(),
});

// Update schema (all fields optional)
const appointmentUpdateSchema = Joi.object({
    case_number: Joi.string().allow(null, '').optional(),
    application_number: Joi.string().optional(),
    client_id: Joi.number().allow(null).optional(),
    center_id: Joi.number().allow(null).optional(),
    other_center_id: Joi.number().allow(null).optional(),
    insurer_id: Joi.number().allow(null).optional(),
    customer_first_name: Joi.string().allow(null, '').optional(),
    customer_last_name: Joi.string().allow(null, '').optional(),
    gender: Joi.string().valid('Male', 'Female', 'Other').allow(null, '').optional(),
    customer_mobile: Joi.string().allow(null, '').optional(),
    customer_alt_mobile: Joi.string().allow(null, '').optional(),
    customer_service_no: Joi.string().allow(null, '').optional(),  
    customer_email: Joi.string().email().allow(null, '').optional(),
    customer_address: Joi.string().allow(null, '').optional(),
    state: Joi.string().allow(null, '').optional(),
    city: Joi.string().allow(null, '').optional(),
    pincode: Joi.string().allow(null, '').optional(),
    country: Joi.string().allow(null, '').optional(),
    customer_gps_latitude: Joi.number().allow(null).optional(),
    customer_gps_longitude: Joi.number().allow(null).optional(),
    customer_landmark: Joi.string().allow(null, '').optional(),
    visit_type: Joi.string().valid('Home_Visit', 'Center_Visit', 'Both').allow(null, '').optional(),
    customer_category: Joi.string().valid('Non_HNI', 'SUPER_HNI', 'HNI').allow(null, '').optional(),
    appointment_date: Joi.date().optional(),
    appointment_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).allow(null, '').optional(),
    confirmed_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).allow(null, '').optional(),
    status: Joi.string().allow(null, '').optional(),
    assigned_technician_id: Joi.number().allow(null).optional(),
    remarks: Joi.string().allow(null, '').optional(),
    cancellation_reason: Joi.string().allow(null, '').optional(),
    cost_type: Joi.string().allow(null, '').optional(),
    amount: Joi.number().allow(null).optional(),
    amount_upload: Joi.string().allow(null, '').optional(),
    case_severity: Joi.number().allow(null).optional(),
    selected_items: Joi.alternatives()
        .try(
            Joi.array().items(
                Joi.object({
                    id: Joi.number().required(),
                    name: Joi.string().required(),
                    type: Joi.string().valid('test', 'category').required(),
                    rate: Joi.number().required(),
                    assigned_center_id: Joi.number().allow(null).optional(),
                    assigned_technician_id: Joi.number().allow(null).optional(),
                    visit_subtype: Joi.string().valid('center', 'home').allow(null).optional(),
                    assigned_to: Joi.string().valid('center1', 'center2').allow(null).optional()
                })
            ),
            Joi.string().custom((value, helpers) => {
                try {
                    const parsed = JSON.parse(value);
                    if (!Array.isArray(parsed)) {
                        return helpers.error('any.invalid', { message: '"selected_items" must be a valid JSON array' });
                    }
                    for (const item of parsed) {
                        const { error } = Joi.object({
                            id: Joi.number().required(),
                            name: Joi.string().required(),
                            type: Joi.string().valid('test', 'category').required(),
                            rate: Joi.number().required(),
                            assigned_center_id: Joi.number().allow(null).optional(),
                            assigned_technician_id: Joi.number().allow(null).optional(),
                            visit_subtype: Joi.string().valid('center', 'home').allow(null).optional(),
                            assigned_to: Joi.string().valid('center1', 'center2').allow(null).optional()
                        }).validate(item);
                        if (error) {
                            return helpers.error('any.invalid', { message: error.message });
                        }
                    }
                    return parsed;
                } catch (err) {
                    return helpers.error('any.invalid', { message: '"selected_items" must be a valid JSON array' });
                }
            })
        )
        .allow(null)
        .optional(),
    total_amount: Joi.number().allow(null).optional(),
});

// Delete schema
const appointmentDeleteSchema = Joi.object({
    ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
});

// Bulk update schema
const appointmentBulkUpdateSchema = Joi.object({
    ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
    center_id: Joi.number().integer().positive().optional().allow(null),
    assigned_technician_id: Joi.number().integer().positive().optional(),
    cost_type: Joi.string().optional().allow(null),
    amount: Joi.number().optional().allow(null),
    status: Joi.string().optional()
});

// Confirm schedule schema
const confirmScheduleSchema = Joi.object({
    confirmed_date: Joi.date().required(),
    confirmed_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).required(),
    actor_context: Joi.object({
        centerId: Joi.number().required(),
        type: Joi.string().valid('center', 'technician').optional()
    }).optional()
});

// Reschedule schema
const rescheduleSchema = Joi.object({
    confirmed_date: Joi.date().required(),
    confirmed_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/).required(),
    reschedule_reason: Joi.string().required().min(10).max(500),
    actor_context: Joi.object({
        centerId: Joi.number().required(),
        type: Joi.string().valid('center', 'technician').optional()
    }).optional(),
});

// Push back schema
const pushBackSchema = Joi.object({
    pushback_remarks: Joi.string().required().min(10).max(500),
    actor_context: Joi.object({
        centerId: Joi.number().required(),
        type: Joi.string().valid('center', 'technician').optional()
    }).optional()
});

// Medical status schema
// const medicalStatusSchema = Joi.object({
//     medical_status: Joi.string().valid('arrived', 'in_process', 'completed', 'partially_completed').required(),
//     aadhaar_number: Joi.string().pattern(/^[0-9]{12}$/).allow('', null).optional(),
//     pan_number: Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).allow('', null).optional(),
//     medical_remarks: Joi.string().allow('', null).optional()
// });
// Medical status schema
const medicalStatusSchema = Joi.object({
    medical_status: Joi.string().valid('arrived', 'in_process', 'completed', 'partially_completed').required(),
    aadhaar_number: Joi.string().pattern(/^[0-9]{12}$/).allow('', null).optional(),
    pan_number: Joi.string().pattern(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).allow('', null).optional(),
    medical_remarks: Joi.string().allow('', null).optional(),
    pending_report_types: Joi.alternatives()   // NEW
        .try(
            Joi.array().items(
                Joi.string().valid('pathology', 'cardiology', 'radiology', 'mer', 'mtrf', 'other')
            ),
            Joi.string().allow('', null)
        )
        .optional(),
    actor_context: Joi.object({
        centerId: Joi.number().required(),
        type: Joi.string().valid('center', 'technician').optional()
    }).optional(),
});

// Test update schema
const testUpdateSchema = Joi.object({
    testUpdates: Joi.array().items(
        Joi.object({
            testId: Joi.number().required(), // This is appointment_test_id from appointment_tests table
            assigned_center_id: Joi.number().allow(null).optional(),
            assigned_technician_id: Joi.number().allow(null).optional(),
            visit_subtype: Joi.string().valid('center', 'home').optional()
        })
    ).required()
});

module.exports = {
    appointmentCreateSchema,
    appointmentUpdateSchema,
    appointmentDeleteSchema,
    appointmentBulkUpdateSchema,
    confirmScheduleSchema,
    rescheduleSchema,
    pushBackSchema,
    medicalStatusSchema,
    testUpdateSchema
};
