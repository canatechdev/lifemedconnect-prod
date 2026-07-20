/**
 * App (Technician) Appointment Routes
 * Simple GET APIs for assigned and upcoming appointments
 * Uses JWT token to derive technician user id
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { verifyToken } = require('../../lib/auth');
const ApiResponse = require('../../lib/response');
const logger = require('../../lib/logger');
const db = require('../../lib/dbconnection');
const { updateWithApproval, formatApprovalResponse } = require('../../lib/approvalHelper');
const appointmentService = require('../../services/app/s_app_appointments');
const caseTrackerService = require('../../services/app/s_app_case_tracker');
const coreAppointments = require('../../services/appointments');
const { uploadLimiter } = require('../../middleware/security');
const { mixedUpload } = require('../../lib/multer');
const { processSingleFile, processMultipleFiles } = require('../../lib/fileUpload');

function getAppointmentIdParam(req) {
    const appointmentId = parseInt(req.params.id, 10);
    return Number.isNaN(appointmentId) ? null : appointmentId;
}

function setPdfHeaders(res, filename, length = null) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    if (length !== null) {
        res.setHeader('Content-Length', length);
    }
}

// GET /api/app/appointments
// List all appointments for the logged-in technician or center
router.get('/appointments', verifyToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const search = req.query.q || '';
        const fromDate = req.query.fromDate || '';
        const toDate = req.query.toDate || '';
        const visitType = req.query.visitType || '';

        const result = await appointmentService.listAppointments({
            userId: req.user.id,
            page,
            limit,
            search,
            fromDate,
            toDate,
            visitType,
            upcomingOnly: false
        });

        return ApiResponse.paginated(res, result.data, result.pagination);
    } catch (error) {
        logger.error('App list appointments (technician) failed', { error: error.message, userId: req.user?.id });
        return ApiResponse.appError(res, 'Failed to fetch appointments', 500);
    }
});

// GET /api/app/appointments/status/:group
// group: pending|completed
router.get('/appointments/status/:group', verifyToken, async (req, res) => {
    try {
        const group = (req.params.group || '').toLowerCase();
        const allowed = ['pending', 'completed'];
        if (!allowed.includes(group)) {
            return ApiResponse.appError(res, 'Invalid status group', 400);
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const search = req.query.q || '';
        const fromDate = req.query.fromDate || '';
        const toDate = req.query.toDate || '';
        const visitType = req.query.visitType || '';

        const result = await appointmentService.listAppointments({
            userId: req.user.id,
            page,
            limit,
            search,
            statusGroup: group,
            fromDate,
            toDate,
            visitType
        });

        return ApiResponse.paginated(res, result.data, result.pagination);
    } catch (error) {
        logger.error('App status-filter appointments (technician) failed', { error: error.message, userId: req.user?.id });
        return ApiResponse.appError(res, 'Failed to fetch appointments', 500);
    }
});

// GET /api/app/appointments/upcoming
// List upcoming appointments (confirmed_date tomorrow onwards)
router.get('/appointments/upcoming', verifyToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const search = req.query.q || '';
        const fromDate = req.query.fromDate || '';
        const toDate = req.query.toDate || '';
        const visitType = req.query.visitType || '';

        const result = await appointmentService.listAppointments({
            userId: req.user.id,
            page,
            limit,
            search,
            upcomingOnly: true,
            fromDate,
            toDate,
            visitType
        });

        return ApiResponse.paginated(res, result.data, result.pagination);
    } catch (error) {
        logger.error('App upcoming appointments (technician) failed', { error: error.message, userId: req.user?.id });
        return ApiResponse.appError(res, 'Failed to fetch upcoming appointments', 500);
    }
});

// GET /api/app/appointments/today
// List today's appointments
router.get('/appointments/today', verifyToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const search = req.query.q || '';
        const visitType = req.query.visitType || '';

        const result = await appointmentService.listAppointments({
            userId: req.user.id,
            page,
            limit,
            search,
            todayOnly: true,
            visitType
        });

        return ApiResponse.paginated(res, result.data, result.pagination);
    } catch (error) {
        logger.error('App today appointments (technician) failed', { error: error.message, userId: req.user?.id });
        return ApiResponse.appError(res, 'Failed to fetch today appointments', 500);
    }
});

// GET /api/app/appointments/tracker/search?q=CASE/26/05/0014
// Compact case tracker payload for the mobile app.
router.get('/appointments/tracker/search', verifyToken, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) {
            return ApiResponse.appError(res, 'Search term is required', 400);
        }

        const baseUrl = global.BASE_URL || `http://localhost:${process.env.PORT || 5050}`;
        const tracker = await caseTrackerService.getCaseTracker({
            user: req.user,
            searchTerm: q,
            baseUrl
        });

        if (!tracker) {
            return ApiResponse.appError(res, 'Appointment not found', 404);
        }

        return ApiResponse.appSuccess(res, 'Case tracker fetched successfully', tracker);
    } catch (error) {
        const statusCode = error.statusCode || 500;
        logger.error('App case tracker failed', {
            error: error.message,
            userId: req.user?.id,
            searchTerm: req.query?.q
        });
        return ApiResponse.appError(
            res,
            statusCode === 403 ? error.message : 'Failed to fetch case tracker',
            statusCode
        );
    }
});

// GET /api/app/appointments/tracker/public/:id/proforma-invoice
// Public direct PDF link for the mobile case tracker response. Web PDF routes remain authenticated.
router.get('/appointments/tracker/public/:id/proforma-invoice', async (req, res) => {
    try {
        const appointmentId = getAppointmentIdParam(req);
        if (!appointmentId) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }

        const result = await coreAppointments.generateProformaInvoicePdf(appointmentId);
        if (!result || !result.pdfBuffer) {
            return ApiResponse.notFound(res, 'Proforma invoice data not found');
        }

        setPdfHeaders(res, `proforma-invoice-${appointmentId}.pdf`, result.pdfBuffer.length);
        return res.end(result.pdfBuffer);
    } catch (error) {
        logger.error('App tracker public proforma invoice failed', {
            appointmentId: req.params.id,
            error: error.message
        });
        return ApiResponse.appError(res, 'Failed to download proforma invoice', 500);
    }
});

// GET /api/app/appointments/tracker/public/:id/tpa-pdf
// Public direct PDF link for the mobile case tracker response. Web PDF routes remain authenticated.
router.get('/appointments/tracker/public/:id/tpa-pdf', async (req, res) => {
    try {
        const appointmentId = getAppointmentIdParam(req);
        if (!appointmentId) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }

        const result = await coreAppointments.generateTPAPDF(appointmentId);
        if (!result || !result.pdfPath) {
            return ApiResponse.notFound(res, 'TPA PDF not found');
        }

        const absolutePath = path.resolve(result.pdfPath);
        if (!fs.existsSync(absolutePath)) {
            return ApiResponse.notFound(res, 'TPA PDF file not found');
        }

        setPdfHeaders(res, `TPA_${appointmentId}.pdf`);
        return res.sendFile(absolutePath);
    } catch (error) {
        logger.error('App tracker public TPA PDF failed', {
            appointmentId: req.params.id,
            error: error.message
        });
        return ApiResponse.appError(res, 'Failed to download TPA PDF', 500);
    }
});


// GET /api/app/appointments/:id
// Detailed appointment view for the logged-in technician or center
router.get('/appointments/:id', verifyToken, async (req, res) => {
    try {
        const appointmentId = parseInt(req.params.id, 10);
        if (Number.isNaN(appointmentId)) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }

        const details = await appointmentService.getAppointmentDetails({
            userId: req.user.id,
            appointmentId
        });

        if (!details) {
            return ApiResponse.appError(res, 'Appointment not found or not authorized', 404);
        }

        return ApiResponse.appSuccess(res, 'Appointment details fetched', details);
    } catch (error) {
        logger.error('App get appointment details failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
        return ApiResponse.appError(res, 'Failed to fetch appointment details', 500);
    }
});

// POST /api/app/appointments/:id/push-back
// Push-back for technician or center
router.post('/appointments/:id/push-back', verifyToken, async (req, res) => {
    try {
        const appointmentId = parseInt(req.params.id, 10);
        const remarks = (req.body?.remarks || '').toString().trim();
        if (Number.isNaN(appointmentId)) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }
        if (!remarks) {
            return ApiResponse.appError(res, 'remarks is required', 400);
        }

        const { owns, actorContext } = await appointmentService.getAppScopeForAppointment(appointmentId, req.user.id);
        if (!owns) {
            return ApiResponse.appError(res, 'Not authorized for this appointment', 403);
        }

        const result = await coreAppointments.pushBackAppointment(appointmentId, remarks, req.user.id, actorContext);
        return ApiResponse.appSuccess(res, 'Appointment pushed back', result);
    } catch (error) {
        logger.error('App push-back failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
        return ApiResponse.appError(res, 'Failed to push back appointment', 500);
    }
});

// POST /api/app/appointments/:id/reschedule
// Technician reschedule request on own appointment/tests (goes to approval flow unless user can auto-approve)
router.post('/appointments/:id/reschedule', verifyToken, async (req, res) => {
    try {
        const appointmentId = parseInt(req.params.id, 10);
        const { confirmed_date, confirmed_time, remarks } = req.body || {};

        if (Number.isNaN(appointmentId)) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }
        if (!confirmed_date || !confirmed_time) {
            return ApiResponse.appError(res, 'confirmed_date and confirmed_time are required', 400);
        }

        const { owns, actorContext } = await appointmentService.getAppScopeForAppointment(appointmentId, req.user.id);
        if (!owns) {
            return ApiResponse.appError(res, 'Not authorized for this appointment', 403);
        }

        const normalizedDate = confirmed_date; // app already sends yyyy-mm-dd
        const normalizedTime = confirmed_time; // app already sends hh:mm

        // Direct reschedule without approval for both technicians and centers
        const result = await coreAppointments.rescheduleAppointment(
            appointmentId,
            normalizedDate,
            normalizedTime,
            remarks || null,
            req.user.id,
            actorContext
        );

        // Direct success response for technician reschedule
        return ApiResponse.appSuccess(res, 'Appointment rescheduled successfully', {
            appointmentId: appointmentId,
            confirmed_date: normalizedDate,
            confirmed_time: normalizedTime,
            rescheduled_by: req.user.id
        });
    } catch (error) {
        logger.error('App reschedule failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
        return ApiResponse.appError(res, 'Failed to reschedule appointment', 500);
    }
});

// POST /api/app/appointments/:id/confirm-schedule
// Technician confirm schedule request on own appointment/tests (goes to approval flow unless user can auto-approve)
router.post('/appointments/:id/confirm-schedule', verifyToken, async (req, res) => {
    try {
        const appointmentId = parseInt(req.params.id, 10);
        const { confirmed_date, confirmed_time } = req.body || {};

        if (Number.isNaN(appointmentId)) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }
        if (!confirmed_date || !confirmed_time) {
            return ApiResponse.appError(res, 'confirmed_date and confirmed_time are required', 400);
        }

        const { owns, actorContext } = await appointmentService.getAppScopeForAppointment(appointmentId, req.user.id);
        if (!owns) {
            return ApiResponse.appError(res, 'Not authorized for this appointment', 403);
        }

        const normalizedDate = confirmed_date; // app already sends yyyy-mm-dd
        const normalizedTime = confirmed_time; // app already sends hh:mm

        // Centers: direct confirm, no approval. Technicians: approval flow.
        if (actorContext.type === 'center') {
            await coreAppointments.confirmSchedule(
                appointmentId,
                normalizedDate,
                normalizedTime,
                req.user.id,
                actorContext
            );
            return ApiResponse.appSuccess(res, 'Schedule confirmed successfully', {
                needsApproval: false,
                appointmentId,
                confirmed_date: normalizedDate,
                confirmed_time: normalizedTime
            });
        }

        const result = await updateWithApproval({
            entity_type: 'appointment',
            entity_id: appointmentId,
            getFunction: async (id) => await coreAppointments.getAppointment(id),
            updateFunction: async (id) => await coreAppointments.confirmSchedule(
                id,
                normalizedDate,
                normalizedTime,
                req.user.id,
                actorContext
            ),
            new_data: {
                confirmed_date: normalizedDate,
                confirmed_time: normalizedTime,
                medical_status: 'scheduled',
                _actorContext: actorContext  // Store actorContext for approval processing
            },
            user: req.user,
            notes: 'Technician confirmed schedule'
        });

        const response = formatApprovalResponse(result);
        // Align app response style; include needsApproval flag if present
        return ApiResponse.appSuccess(res, response.message || 'Schedule confirmation submitted', {
            needsApproval: !!response.needsApproval,
            approvalId: response.approvalId || null,
            ...response
        });
    } catch (error) {
        logger.error('App confirm schedule failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
        return ApiResponse.appError(res, 'Failed to confirm schedule', 500);
    }
});

// GET /api/app/appointments/:id/update-medical-status
// Get appointment details for medical status update (similar to PATCH but as GET with query params)
// additional used this get api to mark arrival in app while the img upload for this is done via post upload docs api 

router.get('/appointments/:id/update-medical-status', verifyToken, async (req, res) => {
    try {
        const appointmentId = parseInt(req.params.id, 10);
        const { medical_status } = req.query;

        if (Number.isNaN(appointmentId)) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }

        if (!medical_status) {
            return ApiResponse.appError(res, 'medical_status is required', 400);
        }

        const { owns, actorContext } = await appointmentService.getAppScopeForAppointment(appointmentId, req.user.id);
        if (!owns) {
            return ApiResponse.appError(res, 'Not authorized for this appointment', 403);
        }

        // For technician, enrich actorContext with center_id
        if (actorContext.type === 'technician') {
            const [techData] = await db.query(
                'SELECT center_id FROM technicians WHERE id = ?',
                [actorContext.technicianId]
            );
            actorContext.centerId = techData[0]?.center_id || null;
        }

        // Update medical status
        const result = await coreAppointments.updateMedicalStatus(
            appointmentId,
            medical_status,
            {},
            req.user.id,
            actorContext
        );

        return ApiResponse.appSuccess(res, 'Medical status updated successfully', result);
    } catch (error) {
        logger.error('App update medical status failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
        return ApiResponse.appError(res, 'Failed to update medical status', 500);
    }
});

// POST /api/app/appointments/:id/medical-status
// Unified status update for app (supports JSON or multipart with docs/images)
router.post('/appointments/:id/medical-status',
    verifyToken,
    uploadLimiter,
    mixedUpload.any(),
    async (req, res) => {
        try {
            const appointmentId = parseInt(req.params.id, 10);
            const { medical_status, medical_remarks, aadhaar_number, pan_number, pending_report_types } = req.body || {};

            if (Number.isNaN(appointmentId)) {
                return ApiResponse.appError(res, 'Invalid appointment id', 400);
            }

            if (!medical_status) {
                return ApiResponse.appError(res, 'medical_status is required', 400);
            }

            const allowed = ['arrived', 'in_process', 'partially_completed', 'completed'];
            if (!allowed.includes(medical_status)) {
                return ApiResponse.appError(res, `medical_status must be one of: ${allowed.join(', ')}`, 400);
            }

            if (medical_status === 'partially_completed' && !pending_report_types) {
                return ApiResponse.appError(res, 'pending_report_types is required for partially_completed', 400);
            }

            
            const { owns, actorContext } = await appointmentService.getAppScopeForAppointment(appointmentId, req.user.id);
            if (!owns) {
                return ApiResponse.appError(res, 'Not authorized for this appointment', 403);
            }

            // For technician, enrich actorContext with center_id
            if (actorContext.type === 'technician') {
                const [techData] = await db.query(
                    'SELECT center_id FROM technicians WHERE id = ?',
                    [actorContext.technicianId]
                );
                actorContext.centerId = techData[0]?.center_id || null;
            }

            let pendingTypesArray = [];
            if (pending_report_types) {
                if (Array.isArray(pending_report_types)) {
                    pendingTypesArray = pending_report_types;
                } else if (typeof pending_report_types === 'string') {
                    pendingTypesArray = pending_report_types.split(',').map(s => s.trim()).filter(Boolean);
                }
            }

            // COMPLETED path -> direct completion without approval for all users
            if (medical_status === 'completed') {
                let filesMeta = [];
                if (req.files && req.files.length > 0) {
                    filesMeta = await processMultipleFiles(req.files, 'appointment_medical');
                }

                // APPROVAL REMOVED: Medical completion no longer requires approval for any user
                // Direct update for all users - no approval flow needed
                const result = await coreAppointments.updateMedicalStatus(
                    appointmentId,
                    medical_status,
                    {
                        aadhaar_number: aadhaar_number || null,
                        pan_number: pan_number || null,
                        medical_remarks: medical_remarks || null,
                        pending_report_types: pendingTypesArray
                    },
                    req.user.id,
                    actorContext
                );

                // Fetch and return completion status for 'Both' appointments
                const completionStatus = await coreAppointments.getAppointmentCompletionStatus(appointmentId);

                if (!result?.noChange && filesMeta.length > 0) {
                    await coreAppointments.saveAppointmentMedicalFiles(
                        appointmentId,
                        filesMeta,
                        req.user.id
                    );
                }

                if (!result?.noChange && req.files && req.files.length > 0) {
                    for (const file of req.files) {
                        if (file.fieldname.startsWith('doc_')) {
                            const suffix = file.fieldname.replace('doc_', '');
                            const docType = req.body[`docType_${suffix}`] || req.body.docType || '';
                            const docNumber = req.body[`docNumber_${suffix}`] || req.body.docNumber || '';

                            const filePath = await processSingleFile(file, 'appointment_documents');
                            await coreAppointments.addDocument(
                                appointmentId,
                                docType,
                                docNumber,
                                filePath,
                                file.originalname,
                                req.user.id
                            );
                            continue;
                        }

                        if (file.fieldname.startsWith('customer_')) {
                            const suffix = file.fieldname.replace('customer_', '');
                            const imageLabel = req.body[`imageLabel_${suffix}`] || req.body.imageLabel || '';

                            const filePath = await processSingleFile(file, 'appointment_customer_images');
                            await coreAppointments.addCustomerImage(
                                appointmentId,
                                imageLabel,
                                filePath,
                                file.originalname,
                                req.user.id
                            );
                        }
                    }
                }

                return ApiResponse.appSuccess(res, {
                    ...result,
                    completion_status: completionStatus
                });
            }
           
            // Normal path for arrived / in_process / partially_completed
            const result = await coreAppointments.updateMedicalStatus(
                appointmentId,
                medical_status,
                {
                    medical_remarks: medical_remarks || null,
                    aadhaar_number: aadhaar_number || null,
                    pan_number: pan_number || null,
                    pending_report_types: pendingTypesArray
                },
                req.user.id,
                actorContext
            );

            // Fetch and return completion status
            const completionStatus = await coreAppointments.getAppointmentCompletionStatus(appointmentId);

            if (!result?.noChange && req.files && req.files.length > 0) {
                for (const file of req.files) {
                    if (file.fieldname.startsWith('doc_')) {
                        const suffix = file.fieldname.replace('doc_', '');
                        const docType = req.body[`docType_${suffix}`] || req.body.docType || '';
                        const docNumber = req.body[`docNumber_${suffix}`] || req.body.docNumber || '';

                        const filePath = await processSingleFile(file, 'appointment_documents');
                        await coreAppointments.addDocument(
                            appointmentId,
                            docType,
                            docNumber,
                            filePath,
                            file.originalname,
                            req.user.id
                        );
                        continue;
                    }

                    if (file.fieldname.startsWith('customer_')) {
                        const suffix = file.fieldname.replace('customer_', '');
                        const imageLabel = req.body[`imageLabel_${suffix}`] || req.body.imageLabel || '';

                        const filePath = await processSingleFile(file, 'appointment_customer_images');
                        await coreAppointments.addCustomerImage(
                            appointmentId,
                            imageLabel,
                            filePath,
                            file.originalname,
                            req.user.id
                        );
                    }
                }
            }

            const messages = {
                arrived: 'Arrival marked successfully',
                in_process: 'Medical process started successfully',
                partially_completed: 'Medical marked as partially completed',
                completed: 'Medical completed successfully'
            };

            return ApiResponse.appSuccess(res, messages[medical_status] || 'Medical status updated successfully', {
                ...result,
                completion_status: completionStatus
            });
        } catch (error) {
            logger.error('App medical status update (POST) failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
            return ApiResponse.appError(res, 'Failed to update medical status', 500);
        }
    });

// POST /api/app/appointments/:id/upload-docs-images
// Combined upload for documents and customer images (form-data, no JSON arrays)
router.post('/appointments/:id/upload-docs-images',
    verifyToken,
    uploadLimiter,
    mixedUpload.any(),
    async (req, res) => {
        try {
            const appointmentId = parseInt(req.params.id, 10);

            if (Number.isNaN(appointmentId)) {
                return ApiResponse.appError(res, 'Invalid appointment id', 400);
            }

            const { owns } = await appointmentService.getAppScopeForAppointment(appointmentId, req.user.id);
            if (!owns) {
                return ApiResponse.appError(res, 'Not authorized for this appointment', 403);
            }

            if (!req.files || req.files.length === 0) {
                return ApiResponse.appError(res, 'No files uploaded', 400);
            }

            const documents = [];
            const images = [];

            for (const file of req.files) {
                // Documents: file fields like doc_1, doc_2 ... with accompanying text fields docType_1, docNumber_1
                if (file.fieldname.startsWith('doc_')) {
                    const suffix = file.fieldname.replace('doc_', '');
                    const docType = req.body[`docType_${suffix}`] || req.body.docType || '';
                    const docNumber = req.body[`docNumber_${suffix}`] || req.body.docNumber || '';

                    const filePath = await processSingleFile(file, 'appointment_documents');
                    const result = await coreAppointments.addDocument(
                        appointmentId,
                        docType,
                        docNumber,
                        filePath,
                        file.originalname,
                        req.user.id
                    );
                    documents.push({ ...result, docType, docNumber });
                    continue;
                }

                // Customer images: file fields like customer_1, customer_2 ... with accompanying text fields imageLabel_1
                if (file.fieldname.startsWith('customer_')) {
                    const suffix = file.fieldname.replace('customer_', '');
                    const imageLabel =
                        req.body[`imageLabel_${suffix}`] ||
                        req.body.imageLabel ||
                        // Fallbacks for mobile clients sending arrays or snake_case
                        (Array.isArray(req.body.image_labels) ? req.body.image_labels[Number(suffix) - 1] : '') ||
                        req.body.image_labels ||
                        '';

                    const filePath = await processSingleFile(file, 'appointment_customer_images');
                    const result = await coreAppointments.addCustomerImage(
                        appointmentId,
                        imageLabel,
                        filePath,
                        file.originalname,
                        req.user.id
                    );
                    images.push({ ...result, imageLabel });
                    continue;
                }
            }

            if (documents.length === 0 && images.length === 0) {
                return ApiResponse.appError(res, 'No valid doc_ or customer_ files found', 400);
            }

            return ApiResponse.appSuccess(res, 'Files uploaded successfully', {
                documents,
                images,
                totalUploaded: documents.length + images.length
            });
        } catch (error) {
            logger.error('App upload docs/images failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
            return ApiResponse.appError(res, 'Failed to upload files', 500);
        }
    });

// GET /api/app/appointments/:id/docs-images
// Get all documents and images with full URLs
router.get('/appointments/:id/docs-images', verifyToken, async (req, res) => {
    try {
        const appointmentId = parseInt(req.params.id, 10);
        
        if (Number.isNaN(appointmentId)) {
            return ApiResponse.appError(res, 'Invalid appointment id', 400);
        }

        const { owns } = await appointmentService.getAppScopeForAppointment(appointmentId, req.user.id);
        if (!owns) {
            return ApiResponse.appError(res, 'Not authorized for this appointment', 403);
        }

        // Get documents and images
        const documents = await coreAppointments.getDocuments(appointmentId);
        const images = await coreAppointments.getCustomerImages(appointmentId);

        // Get base URL
        const baseUrl = global.BASE_URL || `http://localhost:${process.env.PORT || 5050}`;

        // Add full URLs to documents
        const documentsWithUrls = documents.map(doc => ({
            ...doc,
            file_url: `${baseUrl}/${doc.file_path}`
        }));

        // Add full URLs to images
        const imagesWithUrls = images.map(img => ({
            ...img,
            file_url: `${baseUrl}/${img.file_path}`
        }));

        return ApiResponse.appSuccess(res, 'Documents and images fetched successfully', {
            documents: documentsWithUrls,
            images: imagesWithUrls
        });
    } catch (error) {
        logger.error('App get docs/images failed', { error: error.message, userId: req.user?.id, appointmentId: req.params?.id });
        return ApiResponse.appError(res, 'Failed to fetch documents and images', 500);
    }
});

module.exports = router;
