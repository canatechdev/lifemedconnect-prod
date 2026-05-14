/**
 * Appointment Routes - Clean Version
 * Uses validation schemas, approval helpers, and service functions
 */

const express = require('express');
const router = express.Router();
const { verifyToken } = require('../lib/auth');
const { requirePermission, requireAnyPermission } = require('../lib/permissions');
const { asyncHandler } = require('../middleware/errorHandler');
const validateRequest = require('../middleware/validateRequest');
const ApiResponse = require('../lib/response');
const logger = require('../lib/logger');
const { deleteWithApproval, updateWithApproval, formatApprovalResponse, createWithApproval } = require('../lib/approvalHelper');
const { toMySqlDate, toMySqlTime, toFloat } = require('../lib/normalizers');
const { pdfUpload, imageUpload, excelUpload, mixedUpload } = require('../lib/multer');
const { processSingleFile, processMultipleFiles, handleSingleFileFromAny, handleExcelFile } = require('../lib/fileUpload');
const fs = require('fs');
const path = require('path');
const db = require('../lib/dbconnection');

//  NEW: Import security middleware
const { uploadLimiter } = require('../middleware/security');

// Import service
const service = require('../services/appointments');

// Helper: Look up case_number for file organization
async function getCaseNumber(appointmentId) {
    try {
        const rows = await db.query('SELECT case_number FROM appointments WHERE id = ?', [appointmentId]);
        return rows?.[0]?.case_number || '';
    } catch { return ''; }
}

// Import validation schemas
const {
    appointmentCreateSchema,
    appointmentUpdateSchema,
    appointmentDeleteSchema,
    appointmentBulkUpdateSchema,
    confirmScheduleSchema,
    rescheduleSchema,
    pushBackSchema,
    medicalStatusSchema,
    testUpdateSchema
} = require('../validation/v_appointments');

// Import new validation schemas
const {
    uploadCategorizedReportsSchema,
    deleteCategorizedReportSchema,
    submitForQCSchema
} = require('../validation/v_appointment_reports');

const {
    pushBackToReportsSchema,
    saveQCVerificationSchema
} = require('../validation/v_appointment_qc');

const {
    addDocumentSchema,
    deleteDocumentSchema,
    addCustomerImageSchema,
    deleteCustomerImageSchema,
    updateImageLabelSchema
} = require('../validation/v_appointment_documents');

// ============================================================================
// Excel Operations
// ============================================================================

// Download Excel Template
router.get('/appointments/sample-template',
    verifyToken,
    requirePermission('appointments.export'),
    asyncHandler(async (req, res) => {
    const workbook = await service.generateTemplate();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=appointments_template.xlsx');

    await workbook.xlsx.write(res);
    res.end();
}));

// Export Appointments with Filters
router.get('/appointments/export',
    verifyToken,
    requirePermission('appointments.export'),
    asyncHandler(async (req, res) => {
        const filters = {
            month: req.query.month,
            year: req.query.year,
            customerCategory: req.query.customerCategory,
            visitType: req.query.visitType,
            status: req.query.status,
            medicalStatus: req.query.medicalStatus,
            qcStatus: req.query.qcStatus,
            search: req.query.q,
            // Enhanced date filtering parameters
            dateField: req.query.dateField || 'created_at',
            rangeType: req.query.rangeType || '',
            fromDate: req.query.fromDate || '',
            toDate: req.query.toDate || '',
            // Diagnostic center filtering (multiple centers)
            centerIds: req.query.centerIds ? req.query.centerIds.split(',').filter(id => id.trim()) : []
        };

        logger.info('Exporting appointments', {
            userId: req.user.id,
            filters
        });

        // Fetch all appointments matching filters
        const appointments = await service.getAppointmentsForExport(filters);

        // Generate Excel workbook
        const workbook = await service.generateExportExcel(appointments, filters);

        // Generate descriptive filename
        const now = new Date();
        const downloadDate = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
        const downloadTime = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
        
        let filterPart = '';
        if (filters.month && filters.year) {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            filterPart = `_${monthNames[parseInt(filters.month) - 1]}_${filters.year}`;
        } else if (filters.year) {
            filterPart = `_${filters.year}`;
        }
        
        if (filters.status) {
            filterPart += `_${filters.status}`;
        }
        
        const filename = `Appointments${filterPart}_Export_${downloadDate}_${downloadTime}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

        await workbook.xlsx.write(res);
        res.end();

        logger.info('Export completed', {
            userId: req.user.id,
            recordCount: appointments.length,
            filename
        });
    })
);

// Upload Excel File
//  NEW: Apply upload rate limiter (30 uploads per 15 minutes)
router.post('/appointments/upload',
    verifyToken,
    requirePermission('appointments.import'),
    uploadLimiter,
    mixedUpload.single('file'),
    asyncHandler(async (req, res) => {
        // Validate user object
        if (!req.user || !req.user.id || !req.user.role_id) {
            logger.error('Excel upload failed: User not authenticated', {
                hasUser: !!req.user,
                userId: req.user?.id,
                roleId: req.user?.role_id
            });
            return ApiResponse.unauthorized(res, 'User authentication required');
        }

        logger.info('Excel upload started', {
            userId: req.user.id,
            roleId: req.user.role_id,
            filename: req.file?.originalname
        });

        // Validate file
        if (!req.file) {
            return ApiResponse.error(res, 'No file uploaded', 400);
        }

        // Save Excel file (no compression)
        const filePath = await handleExcelFile(req.file, 'appointments_excel');

        if (!filePath) {
            return ApiResponse.error(res, 'Failed to save uploaded file', 500);
        }

        try {
            // Process the Excel file
            const result = await service.processUploadedFile(filePath, req.user);

            // Clean up uploaded file after processing
            fs.unlink(filePath, (err) => {
                if (err) logger.warn('Failed to delete temp Excel file:', err.message);
            });

            logger.info('Excel upload completed', {
                userId: req.user.id,
                recordsProcessed: result.success?.length || 0
            });

            return ApiResponse.success(res, result, 'Excel file processed successfully', 201);

        } catch (error) {
            logger.error('Excel upload error:', {
                userId: req.user.id,
                error: error.message,
                stack: error.stack
            });

            // Clean up uploaded file on error
            fs.unlink(filePath, (err) => {
                if (err) logger.warn('Failed to delete temp Excel file:', err.message);
            });

            return ApiResponse.error(res, `Failed to process Excel file: ${error.message}`, 500);
        }
    })
);

// ============================================================================
// CRUD Operations (with Approval System)
// ============================================================================

// CREATE Appointment
router.post('/appointments',
    verifyToken,
    requirePermission('appointments.create'),
    uploadLimiter,
    mixedUpload.any(),
    validateRequest(appointmentCreateSchema),
    asyncHandler(async (req, res) => {
        logger.info('Creating appointment', { userId: req.user.id, hasFiles: !!req.files });

        // Handle file upload for amount_upload
        const uploadedFile = await handleSingleFileFromAny(req.files, 'amount_upload', 'appointment_amount');
        if (uploadedFile) {
            req.body.amount_upload = uploadedFile;
        } else if (req.body.amount_upload === '') {
            req.body.amount_upload = null;
        }

        // Normalize dates and times
        if (req.body.appointment_date) {
            req.body.appointment_date = toMySqlDate(req.body.appointment_date);
        }
        if (req.body.appointment_time) {
            req.body.appointment_time = toMySqlTime(req.body.appointment_time);
        }
        if (req.body.confirmed_time) {
            req.body.confirmed_time = toMySqlTime(req.body.confirmed_time);
        }

        const result = await createWithApproval({
            entity_type: 'appointment',
            data: req.body,
            user: req.user,
            createFunction: service.createAppointment
        });

        const response = formatApprovalResponse(result);
        logger.info('Appointment creation request', {
            appointmentId: response.id,
            needsApproval: response.approval_required,
            userId: req.user.id
        });
        return ApiResponse.success(res, response, response.message, 201);
    })
);

// LIST Appointments
router.get('/appointments', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.q || '';
    const sortBy = req.query.sortBy || 'id';
    const sortOrder = req.query.sortOrder || 'DESC';
    const customerCategory = req.query.customerCategory || '';
    const month = req.query.month || '';
    const year = req.query.year || '';
    const visitType = req.query.visitType || '';
    const status = req.query.status || '';
    const medicalStatus = req.query.medicalStatus || '';
    const qcStatus = req.query.qcStatus || '';
    
    // Enhanced date filtering parameters
    const dateField = req.query.dateField || 'created_at';
    const rangeType = req.query.rangeType || '';
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';
    
    // Diagnostic center filtering (support multiple centers)
    const centerIds = req.query.centerIds ? req.query.centerIds.split(',').filter(id => id.trim()) : [];

    // If requester is a diagnostic center user, restrict to their appointments only
    const centerIdFromToken = req.user?.diagnostic_center_id || req.user?.center_id;   
    if (centerIdFromToken) {
        // Use main listAppointments method with center filtering for consistent date filtering
        const result = await service.listAppointments({ 
            page, 
            limit, 
            search, 
            sortBy, 
            sortOrder, 
            customerCategory,
            month,
            year,
            visitType,
            status,
            medicalStatus,
            qcStatus,
            userId: req.user?.id,
            userRole: req.user?.role_id,
            dateField,
            rangeType,
            fromDate,
            toDate,
            centerIds: [centerIdFromToken] // Pass center ID as array for consistent filtering
        });
        return ApiResponse.paginated(res, result.data, result.pagination);
    }

    // Pass user information for TPA filtering
    const result = await service.listAppointments({ 
        page, 
        limit, 
        search, 
        sortBy, 
        sortOrder, 
        customerCategory,
        month,
        year,
        visitType,
        status,
        medicalStatus,
        qcStatus,
        userId: req.user?.id,
        userRole: req.user?.role_id,
        dateField,
        rangeType,
        fromDate,
        toDate,
        centerIds
    });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// Admin - List pending appointments (pushed back)
router.get('/appointments/admin/pending', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.q || '';
    const sortBy = req.query.sortBy || 'id';
    const sortOrder = req.query.sortOrder || 'DESC';
    const customerCategory = req.query.customerCategory || '';

    // Use listPendingAppointments for pushed back appointments
    const result = await service.listPendingAppointments({ 
        page, 
        limit, 
        search,
        customerCategory
    });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// Admin - List all confirmed appointments
router.get('/appointments/confirmed', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const sortBy = req.query.sortBy || 'confirmed_date';
    const sortOrder = req.query.sortOrder || 'DESC';
    const customerCategory = req.query.customerCategory || '';

    const result = await service.listAllConfirmedAppointments({ page, limit, search, sortBy, sortOrder, customerCategory });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// Admin - List all appointments for report
router.get('/appointments/report', verifyToken, requirePermission('appointments.reports'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const sortBy = req.query.sortBy || 'confirmed_date';
    const sortOrder = req.query.sortOrder || 'DESC';
    const type = 'completed';
    const customerCategory = req.query.customerCategory || '';

    const result = await service.listAllConfirmedAppointments({ page, limit, search, listType: type, sortBy, sortOrder, customerCategory });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// List Appointments by Center (Generic)
router.get('/appointments/DiagnosticCenter', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const centerIdRaw = req.query.centerId;
    const centerId = centerIdRaw !== undefined ? parseInt(centerIdRaw) : undefined;
    const listType = req.query.listType || 'all';
    const customerCategory = req.query.customerCategory || '';

    const result = await service.listAppointmentsbyDiagnosticCenters({ page, limit, search, centerId, listType, customerCategory });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// List Appointments by Technician
router.get('/appointments/Technician', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const technicianId = parseInt(req.query.technicianId);
    const customerCategory = req.query.customerCategory || '';

    const result = await service.listAppointmentsByTechnician({ page, limit, search, technicianId, customerCategory });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));


// QC - Check access permissions for safe navigation
router.get('/appointments/qc/check', verifyToken, requirePermission('appointments.qc'), asyncHandler(async (req, res) => {
    return ApiResponse.success(res, { hasAccess: true }, 'QC access verified');
}));

// QC - List pending QC appointments
router.get('/appointments/qc/pending', verifyToken, requirePermission('appointments.qc'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.q || '';
    const sortBy = req.query.sortBy || 'id';
    const sortOrder = req.query.sortOrder || 'DESC';
    const customerCategory = req.query.customerCategory || '';

    const result = await service.listQcPendingAppointments({ page, limit, search, sortBy, sortOrder, customerCategory });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// Get all QC history (paginated)
router.get('/appointments/qc-history', verifyToken, requirePermission('appointments.qc_history'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.q || '';
    const sortBy = req.query.sortBy || 'created_at';
    const sortOrder = req.query.sortOrder || 'DESC';

    const result = await service.getAllQcHistory({ page, limit, search, sortBy, sortOrder });
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// Get QC details for appointment
router.get('/appointments/:id/qc-details', verifyToken, requirePermission('appointments.qc_details'), asyncHandler(async (req, res) => {
    const appointmentId = parseInt(req.params.id);
    const centerId = req.user.center_id || null;
    const userId = req.user.id;
    
    // Fetch role name from database using role_id
    let userRole = null;
    if (req.user.role_id) {
        const roleSql = 'SELECT role_name FROM roles WHERE id = ?';
        const roleRows = await db.query(roleSql, [req.user.role_id]);
        if (roleRows && roleRows.length > 0) {
            userRole = roleRows[0].role_name;
        }
    }
    
    const qcDetails = await service.getQcDetails(appointmentId, centerId, userId, userRole);
    
    if (!qcDetails) {
        return ApiResponse.notFound(res, 'QC details not found');
    }
    
    return ApiResponse.success(res, qcDetails);
}));

// GET Single Appointment
router.get('/appointments/:id', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const row = await service.getAppointment(req.params.id);
    if (!row) {
        return ApiResponse.notFound(res, 'Appointment not found');
    }
    return ApiResponse.success(res, row);
}));

// UPDATE Appointment
router.put('/appointments/:id',
    verifyToken,
    requirePermission('appointments.update'),
    uploadLimiter,
    mixedUpload.any(),
    validateRequest(appointmentUpdateSchema),
    asyncHandler(async (req, res) => {
        logger.info('Updating appointment', { appointmentId: req.params.id, userId: req.user.id, hasFiles: !!req.files });

        // Handle file upload for amount_upload
        const uploadedFile = await handleSingleFileFromAny(req.files, 'amount_upload', 'appointment_amount');
        if (uploadedFile) {
            req.body.amount_upload = uploadedFile;
        } else if (req.body.amount_upload === '') {
            req.body.amount_upload = null;
        }

        // Normalize dates and times
        if (req.body.appointment_date) {
            req.body.appointment_date = toMySqlDate(req.body.appointment_date);
        }
        if (req.body.appointment_time) {
            req.body.appointment_time = toMySqlTime(req.body.appointment_time);
        }
        if (req.body.confirmed_time) {
            req.body.confirmed_time = toMySqlTime(req.body.confirmed_time);
        }

        // If optional contact numbers are omitted, explicitly null them to allow clearing
        ['customer_alt_mobile', 'customer_service_no'].forEach(field => {
            if (!Object.prototype.hasOwnProperty.call(req.body, field)) {
                req.body[field] = null;
            }
        });

        // Normalize selected_items if sent as string (e.g., from form-data)
        if (typeof req.body.selected_items === 'string') {
            try {
                const parsed = JSON.parse(req.body.selected_items);
                req.body.selected_items = Array.isArray(parsed) ? parsed : req.body.selected_items;
            } catch (e) {
                // leave as-is if parsing fails; validation will handle
            }
        }

        logger.info('Appointment update payload (selected_items debug)', {
            appointmentId: req.params.id,
            selectedItemsType: typeof req.body.selected_items,
            selectedItemsCount: Array.isArray(req.body.selected_items) ? req.body.selected_items.length : null,
            selectedItemsPreview: Array.isArray(req.body.selected_items) ? req.body.selected_items.slice(0, 2) : req.body.selected_items
        });

        req.body.updated_by = req.user.id;

        const result = await updateWithApproval({
            entity_type: 'appointment',
            action_type: 'update',
            entity_id: req.params.id,
            new_data: req.body,
            created_by: req.user.id,
            role_id: req.user.role_id,
            getFunction: async (id) => {
                // Use getAppointmentWithTests to include selected_items in old_data
                const appointment = await service.getAppointmentWithTests(id);
                return appointment;
            },
            updateFunction: service.updateAppointment,
            user: req.user
        });

        const response = formatApprovalResponse(result);
        return ApiResponse.success(res, response, response.message);
    })
);

// DELETE Appointments (Bulk)
router.delete('/appointments',
    verifyToken,
    requirePermission('appointments.delete'),
    validateRequest(appointmentDeleteSchema),
    asyncHandler(async (req, res) => {
        const ids = req.body.ids;
        const result = await deleteWithApproval({
            entity_type: 'appointment',
            action_type: 'delete',
            entity_ids: ids,
            ids: ids,
            getFunction: async () => ids.length > 1
                ? await service.getAppointmentsByIds(ids)
                : await service.getAppointment(ids[0]),
            deleteFunction: service.softDeleteAppointments
        });

        const response = formatApprovalResponse(result);
        return ApiResponse.success(res, response, response.message);
    })
);

// Legacy alias for delete via POST (maintain permission check)
router.post('/appointments/delete',
    verifyToken,
    requirePermission('appointments.delete'),
    validateRequest(appointmentDeleteSchema),
    asyncHandler(async (req, res) => {
        const ids = req.body.ids;
        const result = await deleteWithApproval({
            entity_type: 'appointment',
            action_type: 'delete',
            entity_ids: ids,
            ids: ids,
            getFunction: async () => ids.length > 1
                ? await service.getAppointmentsByIds(ids)
                : await service.getAppointment(ids[0]),
            deleteFunction: service.softDeleteAppointments,
            user: req.user
        });

        const response = formatApprovalResponse(result);
        return ApiResponse.success(res, response, response.message);
    })
);

// BULK UPDATE Appointments this applies chnages imediately without permission 
router.patch('/appointments/bulk-update',
    verifyToken,
    validateRequest(appointmentBulkUpdateSchema),
    asyncHandler(async (req, res) => {
        const userPerms = req.user.permissions || [];
        const hasBulk = userPerms.includes('appointments.bulk_operations');
        const hasAssign = userPerms.includes('appointments.assign_center');

        // Must have either bulk_operations or assign_center to enter
        if (!hasBulk && !hasAssign) {
            return ApiResponse.error(res, 'Permission denied: appointments.bulk_operations or appointments.assign_center required', 403);
        }

        const { ids, ...updates } = req.body;
        updates.updated_by = req.user.id;

        // Cost/amount only if bulk permission
        if ((updates.cost_type !== undefined || updates.amount !== undefined) && !hasBulk) {
            return ApiResponse.error(res, 'Permission denied: appointments.bulk_operations required for cost updates', 403);
        }

        // Center/technician assignment requires assign_center
        if ((updates.center_id !== undefined || updates.assigned_technician_id !== undefined) && !hasAssign) {
            return ApiResponse.error(res, 'Permission denied: appointments.assign_center required for assignment changes', 403);
        }

        const result = await service.bulkUpdateAppointments(ids, updates);
        return ApiResponse.success(res, { affectedRows: result }, 'Appointments updated successfully');
    })
);

// BULK UPDATE with Approval (UpdateIds)
router.post('/appointments/UpdateIds', verifyToken, validateRequest(appointmentBulkUpdateSchema), asyncHandler(async (req, res) => {
    const userPerms = req.user.permissions || [];
    const hasBulk = userPerms.includes('appointments.bulk_operations');
    const hasAssign = userPerms.includes('appointments.assign_center');

    // Must have either bulk_operations or assign_center to enter
    if (!hasBulk && !hasAssign) {
        return ApiResponse.error(res, 'Permission denied: appointments.bulk_operations or appointments.assign_center required', 403);
    }

    const value = req.body;

    // Cost/amount only if bulk permission
    if ((value.cost_type !== undefined || value.amount !== undefined) && !hasBulk) {
        return ApiResponse.error(res, 'Permission denied: appointments.bulk_operations required for cost updates', 403);
    }

    // Guard center/technician assignment behind assign_center permission
    if ((value.center_id !== undefined || value.assigned_technician_id !== undefined) && !hasAssign) {
        return ApiResponse.error(res, 'Permission denied: appointments.assign_center required for assignment changes', 403);
    }

    const result = await updateWithApproval({
        entity_type: 'appointment',
        entity_ids: value.ids,
        getFunction: async (ids) => {
            // Fetch old data snapshot (list of all affected appointments)
            return await service.getAppointmentsByIds(ids);
        },
        updateFunction: async (ids, data) => {
            // Apply actual bulk update when Super Admin approves
            return await service.UpdateAppointmentsTechnicianDiagnosticCenters(ids, data);
        },
        new_data: {
            center_id: value.center_id,
            assigned_technician_id: value.assigned_technician_id,
            cost_type: value.cost_type,
            amount: value.amount,
            updated_by: req.user.id,
            updated_at: new Date(),
        },
        user: req.user,
        notes: req.body.approval_notes || '',
        priority: req.body.priority || 'medium'
    });

    const response = formatApprovalResponse(result);
    return ApiResponse.success(res, response, response.message);
}));

// ============================================================================
// Center-Specific Operations
// ============================================================================


// Center - Get pending (pushed back) appointments
router.get('/appointments/center/pending', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const customerCategory = req.query.customerCategory || '';
    console.log("Decoded USER ->", req.user);


    // centerId comes from token (req.user)
    const centerId = req.user.diagnostic_center_id;

    if (!centerId) {
        return ApiResponse.error(res, "Center ID missing in token", 400);
    }

    const result = await service.listCenterPendingAppointments({
        page,
        limit,
        search,
        centerId,
        customerCategory
    });

    return ApiResponse.paginated(res, result.data, result.pagination);
}));


// Center - Get unconfirmed appointments (to be scheduled)
router.get('/appointments/center/unconfirmed', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const centerId = req.user.center_id || req.user.diagnostic_center_id || parseInt(req.query.centerId);
    const sortBy = req.query.sortBy || 'id';
    const sortOrder = req.query.sortOrder || 'DESC';
    const customerCategory = req.query.customerCategory || '';
    
    // Enhanced date filtering parameters
    const dateField = req.query.dateField || 'created_at';
    const rangeType = req.query.rangeType || '';
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';

    if (!centerId) {
        return ApiResponse.error(res, 'Center ID is required', 400);
    }

    // Use main listAppointments method with center filtering for consistent date filtering
    const result = await service.listAppointments({ 
        page, 
        limit, 
        search, 
        sortBy, 
        sortOrder, 
        customerCategory,
        month: '', // Legacy - not used in new filtering
        year: '',  // Legacy - not used in new filtering
        visitType: '',
        status: 'unconfirmed', // Apply unconfirmed status filtering
        medicalStatus: '',
        qcStatus: '',
        userId: req.user?.id,
        userRole: req.user?.role_id,
        dateField,
        rangeType,
        fromDate,
        toDate,
        centerIds: [centerId] // Pass center ID as array for consistent filtering
    });
    
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// Center - Get confirmed appointments (scheduled with medical workflow)
router.get('/appointments/center/confirmed', verifyToken, requirePermission('appointments.view'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const centerId = req.user.center_id || req.user.diagnostic_center_id || parseInt(req.query.centerId);
    const sortBy = req.query.sortBy || 'id';
    const sortOrder = req.query.sortOrder || 'DESC';
    const customerCategory = req.query.customerCategory || '';
    
    // Enhanced date filtering parameters
    const dateField = req.query.dateField || 'created_at';
    const rangeType = req.query.rangeType || '';
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';

    if (!centerId) {
        return ApiResponse.error(res, 'Center ID is required', 400);
    }

    // Use main listAppointments method with center filtering for consistent date filtering
    const result = await service.listAppointments({ 
        page, 
        limit, 
        search, 
        sortBy, 
        sortOrder, 
        customerCategory,
        month: '', // Legacy - not used in new filtering
        year: '',  // Legacy - not used in new filtering
        visitType: '',
        status: '', // Don't use simple status filter for confirmed
        medicalStatus: 'confirmed,scheduled', // Use medical_status filter to match dashboard
        qcStatus: '',
        userId: req.user?.id,
        userRole: req.user?.role_id,
        dateField,
        rangeType,
        fromDate,
        toDate,
        centerIds: [centerId] // Pass center ID as array for consistent filtering
    });
    
    return ApiResponse.paginated(res, result.data, result.pagination);
}));

// Center - Get completed appointments for report upload
router.get('/appointments/center/report', verifyToken, requirePermission('appointments.upload_docs'), asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 0;
    const search = req.query.q || '';
    const sortBy = req.query.sortBy || 'id';
    const sortOrder = req.query.sortOrder || 'DESC';
    const customerCategory = req.query.customerCategory || '';
    
    // Enhanced date filtering parameters
    const dateField = req.query.dateField || 'created_at';
    const rangeType = req.query.rangeType || '';
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';

    // Check if user is admin (no center_id or role_id indicates admin)
    const userCenterId = req.user?.center_id || req.user?.diagnostic_center_id;
    const isCenterUser = !!userCenterId;
    const isAdmin = !isCenterUser; // Admin users don't have center_id

    if (isAdmin) {
        // Admin/Super Admin: fetch all completed appointments without center filtering
        const result = await service.listAppointments({ 
            page, 
            limit, 
            search, 
            sortBy, 
            sortOrder, 
            customerCategory,
            month: '', // Legacy - not used in new filtering
            year: '',  // Legacy - not used in new filtering
            visitType: '',
            status: '', // Apply completed status filtering
            medicalStatus: 'completed', // Apply medical completed status filtering
            qcStatus: '',
            userId: req.user?.id,
            userRole: req.user?.role_id,
            dateField,
            rangeType,
            fromDate,
            toDate,
            centerIds: [] // No center filtering for admin
        });
        return ApiResponse.paginated(res, result.data, result.pagination);
    }

    // Center users: apply center filtering
    const centerIdFromQuery = req.query.centerId !== undefined ? parseInt(req.query.centerId) : undefined;
    const centerId = userCenterId || centerIdFromQuery;

    if (centerId) {
        // Use main listAppointments method with center filtering for consistent date filtering
        const result = await service.listAppointments({ 
            page, 
            limit, 
            search, 
            sortBy, 
            sortOrder, 
            customerCategory,
            month: '', // Legacy - not used in new filtering
            year: '',  // Legacy - not used in new filtering
            visitType: '',
            status: '', // Apply completed status filtering
            medicalStatus: 'completed', // Apply medical completed status filtering
            qcStatus: '',
            userId: req.user?.id,
            userRole: req.user?.role_id,
            dateField,
            rangeType,
            fromDate,
            toDate,
            centerIds: [centerId] // Pass center ID as array for consistent filtering
        });
        return ApiResponse.paginated(res, result.data, result.pagination);
    }

    return ApiResponse.error(res, 'Center ID is required for center users', 400);
}));

// Confirm Schedule
router.patch('/appointments/:id/confirm-schedule',
    verifyToken,
    requirePermission('appointments.assign_center'),
    validateRequest(confirmScheduleSchema),
    asyncHandler(async (req, res) => {
        const { confirmed_date, confirmed_time, actor_context } = req.body;
        const centerId = req.user.center_id || null;
        const technicianId = req.user.technician_id || null;
        
        // Build actor context - support both old flow (from user) and new flow (from request body)
        let actorContext = null;
        
        // NEW FLOW: Check if actor_context is provided in request body
        if (actor_context && (actor_context.centerId || actor_context.technicianId)) {
            actorContext = {
                centerId: actor_context.centerId || null,
                technicianId: actor_context.technicianId || null,
                type: actor_context.type || (actor_context.centerId ? 'center' : 'technician')
            };
        }
        // OLD FLOW: Fall back to user's center/technician ID
        else if (centerId) {
            actorContext = { centerId, type: 'center' };
        } else if (technicianId) {
            actorContext = { technicianId, type: 'technician' };
        }

        const result = await service.confirmSchedule(
            req.params.id,
            toMySqlDate(confirmed_date),
            toMySqlTime(confirmed_time),
            req.user.id,
            actorContext
        );
        return ApiResponse.success(res, result);
    })
);

// Reschedule Appointment (now goes through approval flow)
router.patch('/appointments/:id/reschedule',
    verifyToken,
    requirePermission('appointments.update'),
    validateRequest(rescheduleSchema),
    asyncHandler(async (req, res) => {
        const { confirmed_date, confirmed_time, reschedule_reason, actor_context } = req.body;
        const centerId = req.user.center_id || null;
        const technicianId = req.user.technician_id || null;
        
        const normalizedDate = toMySqlDate(confirmed_date);
        const normalizedTime = toMySqlTime(confirmed_time);
        const appointmentId = parseInt(req.params.id, 10);

        
        // Build actor context - support both old flow (from user) and new flow (from request body)
        let actorContext = null;
        
        // NEW FLOW: Check if actor_context is provided in request body
        if (actor_context && (actor_context.centerId || actor_context.technicianId)) {
            actorContext = {
                centerId: actor_context.centerId || null,
                technicianId: actor_context.technicianId || null,
                type: actor_context.type || (actor_context.centerId ? 'center' : 'technician')
            };
        }
        // OLD FLOW: Fall back to user's center/technician ID
        else if (centerId) {
            actorContext = { centerId, type: 'center' };
        }
        else if (technicianId) {
            actorContext = { technicianId, type: 'technician' };
        }

        // For reschedule, don't require explicit center context for Both appointments
        // The service layer will handle the context appropriately

        // APPROVAL REMOVED: Reschedule no longer requires approval for any user
        // Direct update for all users - no approval flow needed
        const result = await service.rescheduleAppointment(
            appointmentId,
            normalizedDate,
            normalizedTime,
            reschedule_reason,
            req.user.id,
            actorContext
        );

        return ApiResponse.success(res, result, 'Appointment rescheduled successfully');
    })
);

// Update Medical Status
router.patch('/appointments/:id/medical-status',
    verifyToken,
    requirePermission('appointments.update'),
    uploadLimiter,
    mixedUpload.any(),
    validateRequest(medicalStatusSchema),
    asyncHandler(async (req, res) => {
        const { medical_status, aadhaar_number, pan_number, medical_remarks, pending_report_types, actor_context } = req.body;
        const centerId = req.user.center_id || null;
        const numericUserId = req.user.id;
        const appointmentId = parseInt(req.params.id, 10);

        
        // Normalize pending_report_types into array
        let pendingTypesArray = [];
        if (pending_report_types) {
            if (Array.isArray(pending_report_types)) {
                pendingTypesArray = pending_report_types;
            } else if (typeof pending_report_types === 'string') {
                pendingTypesArray = pending_report_types
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }

        // Build actor context - support both old flow (from user) and new flow (from request body)
        let actorContext = null;
        
        // NEW FLOW: Check if actor_context is provided in request body (for Super Admin, Technicians, etc.)
        if (actor_context && actor_context.centerId) {
            actorContext = {
                centerId: actor_context.centerId,
                type: actor_context.type || 'center' // Default to 'center' if not specified
            };
                    }
        // OLD FLOW: Fall back to user's center_id (for regular center users)
        else if (centerId) {
            actorContext = {
                centerId: centerId,
                type: 'center'
            };
        }
        
        // For Both appointments, require explicit context
        if (!actorContext) {
            const appt = await service.getAppointment(appointmentId);
            if (appt?.visit_type === 'Both') {
                throw new Error('Both appointments require explicit center context. Please ensure centerId is provided.');
            }
        }
        

        // Path for COMPLETED status
        if (medical_status === 'completed') {
            const caseNo = await getCaseNumber(appointmentId);
            let filesMeta = [];
            
            // Process files if any
            if (req.files && req.files.length > 0) {
                filesMeta = await processMultipleFiles(req.files, 'appointment_medical', caseNo);

                if (filesMeta.length > 0) {
                    await service.saveAppointmentMedicalFiles(
                        appointmentId,
                        filesMeta,
                        numericUserId
                    );
                }
            }

            // APPROVAL REMOVED: Medical completion no longer requires approval for any user
            // Direct update for all users - no approval flow needed
            const result = await service.updateMedicalStatus(
                appointmentId,
                medical_status,
                {
                    aadhaar_number,
                    pan_number,
                    medical_remarks,
                    pending_report_types: pendingTypesArray,
                },
                numericUserId,
                actorContext
            );

            // Fetch and return completion status for 'Both' appointments
            const completionStatus = await service.getAppointmentCompletionStatus(appointmentId);

            return ApiResponse.success(res, {
                ...result,
                completion_status: completionStatus
            });
        }

        // Normal path for other statuses (arrived / in_process / partially_completed)
        const result = await service.updateMedicalStatus(
            appointmentId,
            medical_status,
            {
                aadhaar_number,
                pan_number,
                medical_remarks,
                pending_report_types: pendingTypesArray,
            },
            numericUserId,
            actorContext
        );

        // Fetch and return completion status for 'Both' appointments
        const completionStatus = await service.getAppointmentCompletionStatus(appointmentId);

        return ApiResponse.success(res, {
            ...result,
            completion_status: completionStatus
        });
    })
);

// Mark Appointment as Completed
router.patch('/appointments/:id/complete',
    verifyToken,
    requirePermission('appointments.update'),
    asyncHandler(async (req, res) => {
        const result = await service.completeAppointment(req.params.id, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Push Back Appointment
router.post('/appointments/:id/push-back',
    verifyToken,
    requirePermission('appointments.update'),
    validateRequest(pushBackSchema),
    asyncHandler(async (req, res) => {
        const { actor_context } = req.body;
        const centerId = req.user.center_id || null;
        const technicianId = req.user.technician_id || null;
        
        // Build actor context - support both old flow (from user) and new flow (from request body)
        let actorContext = null;
        
        // NEW FLOW: Check if actor_context is provided in request body
        if (actor_context && actor_context.centerId) {
            actorContext = {
                centerId: actor_context.centerId,
                type: actor_context.type || 'center'
            };
        }
        // OLD FLOW: Fall back to user's center/technician ID
        else if (centerId) {
            actorContext = { centerId, type: 'center' };
        } else if (technicianId) {
            actorContext = { technicianId, type: 'technician' };
        }

        // Allow both field names for remarks
        const remarks = req.body.push_back_reason || req.body.pushback_remarks || null;

        // Fallback inference for Both appointments when actorContext missing
        if (!actorContext) {
            try {
                const appt = await service.getAppointment(req.params.id);
                if (appt?.visit_type === 'Both') {
                    // If user center matches a side
                    if (centerId && appt.center_id === centerId) {
                        actorContext = { centerId, type: 'center' };
                    } else if (centerId && appt.other_center_id === centerId) {
                        actorContext = { centerId, type: 'technician' };
                    } else {
                        // Choose side not yet pushed back
                        if (!appt.center_pushed_back) {
                            actorContext = { centerId: appt.center_id, type: 'center' };
                        } else if (!appt.home_pushed_back) {
                            actorContext = { centerId: appt.other_center_id, type: 'technician' };
                        }
                    }
                }
            } catch (e) {
                // leave actorContext null if lookup fails
            }
        }

        const result = await service.pushBackAppointment(
            req.params.id,
            remarks,
            req.user.id,
            actorContext
        );
        return ApiResponse.success(res, result);
    })
);

// Restore Pushed Back Appointment
router.post('/appointments/:id/restore',
    verifyToken,
    requirePermission('appointments.update'),
    asyncHandler(async (req, res) => {
        const result = await service.restoreAppointment(req.params.id, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Get Tests by Client and Insurer (URL params - for frontend compatibility)
router.get('/appointments/tests/:clientId/:insurerId',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const clientId = parseInt(req.params.clientId);
        const insurerId = parseInt(req.params.insurerId);

        if (!clientId || !insurerId) {
            return ApiResponse.error(res, 'clientId and insurerId are required', 400);
        }

        const tests = await service.getTestsByClientAndInsurer(clientId, insurerId);
        return ApiResponse.success(res, tests);
    })
);

// Get Tests and Categories by Client and Insurer (with rates)
router.get('/appointments/tests-categories/by-client-insurer/:clientId/:insurerId',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const clientId = parseInt(req.params.clientId);
        const insurerId = parseInt(req.params.insurerId);
        const search = req.query.search ? String(req.query.search) : '';

        if (Number.isNaN(clientId) || Number.isNaN(insurerId)) {
            return ApiResponse.error(res, 'Valid clientId and insurerId are required', 400);
        }

        const result = await service.getTestsAndCategoriesByClientAndInsurer(
            clientId,
            insurerId,
            search
        );
        return ApiResponse.success(res, result);
    })
);

// Get Appointment with Tests
router.get('/appointments/:id/with-tests',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const row = await service.getAppointmentWithTests(req.params.id);
        if (!row) {
            return ApiResponse.notFound(res, 'Appointment not found');
        }
        return ApiResponse.success(res, row);
    })
);

// Get Appointment with Tests filtered by Center
router.get('/appointments/:id/with-tests/center/:centerId',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const row = await service.getAppointmentWithTestsByCenter(req.params.id, req.params.centerId);
        if (!row) {
            return ApiResponse.notFound(res, 'Appointment not found');
        }
        return ApiResponse.success(res, row);
    })
);

// Get Appointment with Tests (Center-filtered) - alternative route
router.get('/appointments/:id/center/:centerId',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointment = await service.getAppointmentWithTestsByCenter(req.params.id, req.params.centerId);
        if (!appointment) {
            return ApiResponse.notFound(res, 'Appointment not found');
        }
        return ApiResponse.success(res, appointment);
    })
);

// Download Proforma Invoice PDF
router.get('/appointments/:id/proforma-invoice',
    verifyToken,
    requireAnyPermission(['appointments.view', 'appointments.lifecycle']),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const result = await service.generateProformaInvoicePdf(appointmentId);

        if (!result) {
            return ApiResponse.notFound(res, 'Proforma invoice data not found');
        }

        const { pdfBuffer } = result;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="proforma-invoice-${appointmentId}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.end(pdfBuffer);
    })
);

// Get Appointment with Tests filtered by Center (for DC role)
router.get('/appointments/:id/with-tests/center/:centerId',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const row = await service.getAppointmentWithTestsByCenter(req.params.id, req.params.centerId);
        if (!row) {
            return ApiResponse.notFound(res, 'Appointment not found');
        }
        return ApiResponse.success(res, row);
    })
);

// Update Test Assignments
router.patch('/appointments/:id/test-assignments',
    verifyToken,
    requirePermission('appointments.assign_tests'),
    validateRequest(testUpdateSchema),
    asyncHandler(async (req, res) => {
        const { testUpdates } = req.body;
        const result = await service.updateAppointmentTestAssignments(
            req.params.id,
            testUpdates,
            req.user.id
        );
        return ApiResponse.success(res, result);
    })
);

// Split Tests - Assign tests to different centers/technicians
router.post('/appointments/:id/split-tests',
    verifyToken,
    requirePermission('appointments.assign_tests'),
    asyncHandler(async (req, res) => {
        const { tests } = req.body;
        const appointmentId = req.params.id;

        const connection = await db.pool.getConnection();
        try {
            await connection.beginTransaction();

            for (const t of tests) {
                await connection.query(`
                    UPDATE appointment_tests 
                    SET assigned_center_id = ?, assigned_technician_id = ?, visit_subtype = ?, updated_by = ?
                    WHERE id = ? AND appointment_id = ?
                `, [t.assigned_center_id, t.assigned_technician_id, t.visit_subtype, req.user.id, t.id, appointmentId]);
            }

            await connection.commit();
            return ApiResponse.success(res, { appointment_id: appointmentId }, 'Tests split successfully');
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    })
);

// Bulk Mark Tests as Completed
router.post('/appointments/:id/tests/bulk-complete',
    verifyToken,
    requirePermission('appointments.update'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const { testIds, remarks } = req.body;

        if (!testIds || !Array.isArray(testIds) || testIds.length === 0) {
            return ApiResponse.error(res, 'Test IDs array is required', 400);
        }

        const result = await service.bulkMarkTestsCompleted(
            appointmentId,
            testIds,
            req.user.id,
            remarks || ''
        );

        return ApiResponse.success(res, result, `${result.updatedCount} tests marked as completed`);
    })
);

// Delete document
router.delete('/appointments/:id/documents/:documentId',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    validateRequest(deleteDocumentSchema),
    asyncHandler(async (req, res) => {
        const documentId = parseInt(req.params.documentId);
        const result = await service.deleteDocument(documentId, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Alternative delete document route (without appointment ID)
router.delete('/appointments/documents/:documentId',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    asyncHandler(async (req, res) => {
        const documentId = parseInt(req.params.documentId);
        const result = await service.deleteDocument(documentId, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Add Document to Appointment
router.post('/appointments/:id/documents',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    uploadLimiter,
    pdfUpload.single('document'),
    validateRequest(addDocumentSchema),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const { docType, docNumber } = req.body;

        if (!req.file) {
            return ApiResponse.error(res, 'Document file is required', 400);
        }

        const docSubfolder = path.join('appointment_documents', `appointment_${appointmentId}`, `user_${req.user.id}`);
        // const filePath = await processSingleFile(req.file, docSubfolder);
        const filePath = await processSingleFile(req.file, docSubfolder, '', true);
        const fileName = req.file.originalname;

        const result = await service.addDocument(
            appointmentId,
            docType,
            docNumber,
            filePath,
            fileName,
            req.user.id
        );

        return ApiResponse.success(res, result);
    })
);

// Add Customer Image to Appointment
router.post('/appointments/:id/customer-images',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    uploadLimiter,
    imageUpload.single('image'),
    validateRequest(addCustomerImageSchema),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const { imageLabel } = req.body;

        if (!req.file) {
            return ApiResponse.error(res, 'Image file is required', 400);
        }

        const caseNo = await getCaseNumber(appointmentId);
        const imageSubfolder = caseNo
            ? path.join('appointment_customer_images', caseNo)
            : path.join('appointment_customer_images', `appointment_${appointmentId}`);
        // const filePath = await processSingleFile(req.file, imageSubfolder);
        const filePath = await processSingleFile(req.file, imageSubfolder, '', true);
        const fileName = req.file.originalname;

        const result = await service.addCustomerImage(
            appointmentId,
            imageLabel,
            filePath,
            fileName,
            req.user.id
        );

        return ApiResponse.success(res, result);
    })
);

// Delete customer image
router.delete('/appointments/:id/customer-images/:imageId',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    validateRequest(deleteCustomerImageSchema),
    asyncHandler(async (req, res) => {
        const imageId = parseInt(req.params.imageId);
        const result = await service.deleteCustomerImage(imageId, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Alternative delete customer image route (without appointment ID)
router.delete('/appointments/customer-images/:imageId',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    asyncHandler(async (req, res) => {
        const imageId = parseInt(req.params.imageId);
        const result = await service.deleteCustomerImage(imageId, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Push back to reports
router.patch('/appointments/:id/push-back-to-reports',
    verifyToken,
    requirePermission('appointments.qc_pushback'),
    validateRequest(pushBackToReportsSchema),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const { remarks } = req.body;
        const centerId = req.user.diagnostic_center_id || null;
        const result = await service.pushBackToReports(appointmentId, remarks, req.user.id, centerId);
        return ApiResponse.success(res, result);
    })
);

// Push back to reports (alternative route)
router.post('/appointments/:id/qc/push-back',
    verifyToken,
    requirePermission('appointments.qc_pushback'),
    validateRequest(pushBackToReportsSchema),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const { remarks } = req.body;
        const centerId = req.user.diagnostic_center_id || null;
        const result = await service.pushBackToReports(appointmentId, remarks, req.user.id, centerId);
        return ApiResponse.success(res, result);
    })
);

// Save QC verification (alternative route)
router.post('/appointments/:id/qc/save',
    verifyToken,
    requirePermission('appointments.qc'),
    validateRequest(saveQCVerificationSchema),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const { checkboxes, remarks, isComplete } = req.body;
        const result = await service.saveQCVerification(
            appointmentId,
            checkboxes,
            remarks,
            isComplete,
            req.user.id
        );
        return ApiResponse.success(res, result);
    })
);

// Get QC history for specific appointment
router.get('/appointments/:id/qc-history',
    verifyToken,
    requirePermission('appointments.qc'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const history = await service.getQCHistory(appointmentId);
        return ApiResponse.success(res, history);
    })
);

// Alternative update image label route (without appointment ID)
router.patch('/appointments/customer-images/:imageId/label',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    validateRequest(updateImageLabelSchema),
    asyncHandler(async (req, res) => {
        const imageId = parseInt(req.params.imageId);
        const { imageLabel } = req.body;
        const result = await service.updateImageLabel(imageId, imageLabel, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// ============================================================================
// GET Operations for Documents, Images, and Reports
// ============================================================================

// Get all documents for an appointment
router.get('/appointments/:id/documents',
    verifyToken,
    requireAnyPermission(['appointments.view', 'appointments.lifecycle']),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const documents = await service.getDocuments(appointmentId);
        return ApiResponse.success(res, documents);
    })
);

// Get all customer images for an appointment
router.get('/appointments/:id/customer-images',
    verifyToken,
    requireAnyPermission(['appointments.view', 'appointments.lifecycle']),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const images = await service.getCustomerImages(appointmentId);
        return ApiResponse.success(res, images);
    })
);

// Get all categorized reports for an appointment
router.get('/appointments/:id/categorized-reports',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const centerId = req.user.center_id || null;
        const userId = req.user.id;
        
        // Fetch role name from database using role_id
        let userRole = null;
        if (req.user.role_id) {
            const roleSql = 'SELECT role_name FROM roles WHERE id = ?';
            const roleRows = await db.query(roleSql, [req.user.role_id]);
            if (roleRows && roleRows.length > 0) {
                userRole = roleRows[0].role_name;
            }
        }
        
        // DEBUG: Log user object to understand structure
        console.log('User Object Debug:', JSON.stringify(req.user, null, 2));
        console.log('Extracted Values:', { centerId, userId, userRole });
        
        const reports = await service.getCategorizedReports(appointmentId, centerId, userId, userRole);
        console.log('Reports returned:', JSON.stringify(reports, null, 2));
        return ApiResponse.success(res, reports);
    })
);

// Upload categorized reports for an appointment
router.post('/appointments/:id/categorized-reports',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    uploadLimiter,
    mixedUpload.any(),
    validateRequest(uploadCategorizedReportsSchema),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const { reportType } = req.body;

        // Persist files from memory storage to disk and build metadata
        const caseNo = await getCaseNumber(appointmentId);
        const savedPaths = await processMultipleFiles(req.files, 'appointment_reports', caseNo);
        const filesMeta = savedPaths.map((filePath, idx) => ({
            file_path: filePath,
            file_name: req.files?.[idx]?.originalname || null,
            file_size: req.files?.[idx]?.size ?? null
        }));

        const result = await service.uploadCategorizedReports(
            appointmentId,
            reportType,
            filesMeta,
            req.user.id
        );
        return ApiResponse.success(res, result);
    })
);

// Delete a specific categorized report (without appointment ID)
router.delete('/appointments/categorized-reports/:reportId',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    asyncHandler(async (req, res) => {
        const reportId = parseInt(req.params.reportId);
        const result = await service.deleteCategorizedReport(reportId, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Get Reports for Appointment (old format)
router.get('/appointments/:id/reports',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const reports = await service.listAppointmentReports(appointmentId);
        return ApiResponse.success(res, reports);
    })
);

// Upload/Delete Reports (old format)
router.post('/appointments/:id/reports',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    uploadLimiter,
    mixedUpload.any(),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        let rawDeleteIds = req.body.deleteIds ?? req.body.delete_ids ?? [];

        let deleteIds = [];
        if (Array.isArray(rawDeleteIds)) {
            deleteIds = rawDeleteIds.map(id => Number(id)).filter(id => !isNaN(id));
        } else if (typeof rawDeleteIds === 'string' && rawDeleteIds.trim() !== '') {
            try {
                const parsed = JSON.parse(rawDeleteIds);
                if (Array.isArray(parsed)) {
                    deleteIds = parsed.map(id => Number(id)).filter(id => !isNaN(id));
                }
            } catch (e) {
                deleteIds = [];
            }
        }

        const caseNo = await getCaseNumber(appointmentId);
        let filesMeta = [];
        if (req.files && req.files.length > 0) {
            filesMeta = await processMultipleFiles(req.files, 'appointment_reports', caseNo);
        }

        const result = await service.saveAppointmentReports(
            appointmentId,
            filesMeta,
            deleteIds,
            req.user.id
        );

        return ApiResponse.success(res, result);
    })
);

// Submit reports for QC
router.post('/appointments/:id/submit-for-qc',
    verifyToken,
    requirePermission('appointments.submit_qc'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const result = await service.submitReportsForQC(appointmentId, req.user.id);
        return ApiResponse.success(res, result);
    })
);

// Get report counts by type
router.get('/appointments/:id/report-counts',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const counts = await service.getReportCounts(appointmentId);
        return ApiResponse.success(res, counts);
    })
);

// ============================================
// PATHOLOGY DATA ROUTES
// ============================================

// Fetch pathology data from external API and generate PDF
router.post('/appointments/:id/pathology/fetch',
    verifyToken,
    requirePermission('appointments.upload_docs'),
    asyncHandler(async (req, res) => {
        try {
            const appointmentId = parseInt(req.params.id);
            const result = await service.fetchAndSavePathologyData(appointmentId, req.user.id);
            return ApiResponse.success(res, result);
        } catch (error) {
            // Handle "No pathology data found" as a success response (not an error)
            if (error.message === 'No pathology data found for this case number') {
                return ApiResponse.success(res, { 
                    message: 'No pathology data found for this case number',
                    found: false 
                });
            }
            return ApiResponse.error(res, error.message, 400);
        }
    })
);

// Get pathology data for appointment
router.get('/appointments/:id/pathology',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const data = await service.getPathologyData(appointmentId);
        
        if (!data) {
            return ApiResponse.error(res, 'No pathology data found for this appointment', 404);
        }
        
        return ApiResponse.success(res, data);
    })
);

// Check if pathology data exists
router.get('/appointments/:id/pathology/exists',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const exists = await service.hasPathologyData(appointmentId);
        return ApiResponse.success(res, { exists });
    })
);

// ============================================
// PDF GENERATION
// ============================================

// Generate TPA PDF for completed appointment (MTRF > Photos > MER > Patho > Cardio > Radio > Other)
router.get('/appointments/:id/tpa-pdf',
    verifyToken,
    requireAnyPermission(['appointments.view', 'appointments.lifecycle']),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const result = await service.generateTPAPDF(appointmentId);
        
        if (!result || !result.pdfPath) {
            return ApiResponse.notFound(res, 'TPA PDF not found');
        }

        // Send the actual PDF file
        const fs = require('fs');
        const path = require('path');
        
        // Get absolute path
        const absolutePath = path.resolve(result.pdfPath);
        
        if (!fs.existsSync(absolutePath)) {
            return ApiResponse.notFound(res, 'TPA PDF file not found');
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="TPA_${appointmentId}.pdf"`);
        return res.sendFile(absolutePath);
    })
);

// Generate comprehensive master PDF for completed appointment
router.get('/appointments/:id/master-pdf',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const result = await service.generateMasterPDF(appointmentId);
        return ApiResponse.success(res, result);
    })
);

// Generate and serve appointment summary PDF
router.get('/appointments/:id/summary-pdf',
    verifyToken,
    requireAnyPermission(['appointments.view', 'appointments.lifecycle']),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const pdfBuffer = await service.generateAppointmentSummaryPDF(appointmentId);
        
        if (!pdfBuffer) {
            return ApiResponse.error(res, 'Failed to generate appointment summary PDF', 500);
        }

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Appointment_Summary_${appointmentId}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        
        return res.send(pdfBuffer);
    })
);

// Send appointment PDF via email to client
router.post('/appointments/:id/send-email',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const appointmentId = parseInt(req.params.id);
        const result = await service.sendAppointmentEmailToClient(appointmentId, req.user.id);
        
        if (!result.success) {
            return ApiResponse.error(res, result.message, result.statusCode || 500);
        }
        
        return ApiResponse.success(res, result);
    })
);

// Get TPA email statistics for QC page
router.get('/appointments/qc/tpa-email-stats',
    verifyToken,
    requirePermission('appointments.view'),
    asyncHandler(async (req, res) => {
        const { getTpaEmailStats } = require('../services/s_tap_email_log');
        const stats = await getTpaEmailStats();
        return ApiResponse.success(res, 'TPA email statistics retrieved', stats);
    })
);

module.exports = router;
