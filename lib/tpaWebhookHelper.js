/**
 * TPA Webhook Helper
 * Builds event-specific payloads and sends status webhooks to TPA systems.
 * Each event type sends only the metadata relevant to that action.
 */

const { TPAWebhookService } = require('../services/tpa');
const logger = require('./logger');
const db = require('./dbconnection');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get appointment data for webhook (full row needed to build any event)
 */
async function getAppointmentData(appointmentId) {
    const appointments = await db.query(`
        SELECT 
            a.id, a.case_number, a.application_number, a.client_id,
            a.customer_first_name, a.customer_last_name, a.gender, a.customer_mobile, a.customer_alt_mobile, 
            a.customer_service_no, a.customer_email, a.customer_address, a.state, a.city, a.pincode, a.country,
            a.customer_gps_latitude, a.customer_gps_longitude, a.customer_landmark,
            a.appointment_date, a.appointment_time, a.visit_type, a.customer_category,
            a.status, a.medical_status, a.qc_status,
            a.center_id, a.other_center_id,
            a.center_medical_status, a.home_medical_status,
            a.remarks, a.medical_remarks, a.cancellation_reason,
            a.pushback_remarks, a.reschedule_remark,
            a.home_reschedule_remark, a.center_reschedule_remark,
            a.confirmed_date, a.confirmed_time, a.updated_at,
            a.aadhaar_number, a.pan_number,
            c.client_name, i.insurer_name, dc.center_name
        FROM appointments a
        LEFT JOIN clients c ON a.client_id = c.id
        LEFT JOIN insurers i ON a.insurer_id = i.id
        LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
        WHERE a.id = ? AND a.is_deleted = 0
    `, [appointmentId]);

    return appointments?.[0] || null;
}

/**
 * Convert raw image/document rows into full URLs
 */
function buildMediaUrls(additionalData = {}) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    const images = (additionalData.customer_images || []).map(img => ({
        image_label: img.image_label,
        image_url: `${baseUrl}/${img.file_path}`
    }));

    const documents = (additionalData.documents || []).map(doc => ({
        doc_type: doc.doc_type,
        doc_number: doc.doc_number,
        file_url: `${baseUrl}/${doc.file_path}`
    }));

    return { images, documents };
}

/**
 * Fetch customer images and documents for patient arrival
 */
async function fetchArrivalData(appointmentId) {
    try {
        logger.info('Fetching arrival data for webhook', { appointmentId });

        // Fetch customer images
        const images = await db.query(`
            SELECT image_label, file_path 
            FROM appointment_customer_images 
            WHERE appointment_id = ? AND is_deleted = 0
            ORDER BY uploaded_at DESC
        `, [appointmentId]);

        // Fetch documents
        const documents = await db.query(`
            SELECT doc_type, doc_number, file_path 
            FROM appointment_documents 
            WHERE appointment_id = ? AND is_deleted = 0
            ORDER BY uploaded_at DESC
        `, [appointmentId]);

        const result = {
            customer_images: images,
            documents: documents
        };

        logger.info('Arrival data fetched successfully', {
            appointmentId,
            imagesCount: images.length,
            documentsCount: documents.length,
            imageLabels: images.map(img => img.image_label),
            documentTypes: documents.map(doc => doc.doc_type)
        });

        return result;
    } catch (error) {
        logger.error('Failed to fetch arrival data', { appointmentId, error: error.message });
        return { customer_images: [], documents: [] };
    }
}

/**
 * Common fields included in every webhook event
 */
function basePayload(appointment) {
    return {
        patient_first_name: appointment.customer_first_name,
        patient_last_name: appointment.customer_last_name || '',
        visit_type: appointment.visit_type,
        status: appointment.status,
        medical_status: appointment.medical_status,
        event_occurred_at: new Date().toISOString()
    };
}

// ─── Event-specific metadata builders ───────────────────────────────────────

function buildConfirmedMeta(appointment) {
    // Format confirmed_date to avoid timezone issues
    const formatConfirmedDate = (dateValue) => {
        if (!dateValue) return appointment.appointment_date;
        
        // If it's already a date string, extract just the date part
        if (typeof dateValue === 'string') {
            const datePart = dateValue.split('T')[0]; // Extract YYYY-MM-DD from ISO string
            if (datePart && datePart.match(/^\d{4}-\d{2}-\d{2}$/)) {
                return datePart + 'T18:30:00.000Z'; // Add standard time for consistency
            }
        }
        
        // Fallback to appointment_date
        return appointment.appointment_date;
    };

    return {
        ...basePayload(appointment),
        appointment_date: appointment.appointment_date,
        appointment_time: appointment.appointment_time,
        confirmed_date: formatConfirmedDate(appointment.confirmed_date),
        confirmed_time: appointment.confirmed_time || appointment.appointment_time
    };
}

function buildRescheduledMeta(appointment) {
    // Handle remarks based on visit type
    let remark = '';
    if (appointment.visit_type === 'Center') {
        remark = appointment.center_reschedule_remark || appointment.reschedule_remark || '';
    } else if (appointment.visit_type === 'Home_Visit') {
        remark = appointment.home_reschedule_remark || appointment.reschedule_remark || '';
    } else if (appointment.visit_type === 'Both') {
        remark = appointment.home_reschedule_remark || appointment.center_reschedule_remark || appointment.reschedule_remark || '';
    }
    
    return {
        ...basePayload(appointment),
        rescheduled_date: appointment.appointment_date,
        rescheduled_time: appointment.appointment_time,
        reschedule_remark: remark
    };
}

function buildCancelledMeta(appointment) {
    // Handle both cancellation and push-back scenarios
    const reason = appointment.pushback_remarks || appointment.cancellation_reason || '';
    return {
        ...basePayload(appointment),
        cancellation_reason: reason,
        appointment_date: appointment.appointment_date
    };
}

function buildArrivedMeta(appointment, additionalData, actorContext) {
    const { images, documents } = buildMediaUrls(additionalData);
    return {
        ...basePayload(appointment),
        // appointment_date not needed for arrival event
        customer_images: images,
        documents: documents,
        actor_context: actorContext || {
            type: appointment.visit_type === 'Home_Visit' ? 'home' : 'center',
            centerId: appointment.center_id
        }
    };
}

function buildMedicalProgressMeta(appointment, actorContext) {
    return {
        ...basePayload(appointment),
        appointment_date: appointment.appointment_date,
        medical_remarks: appointment.medical_remarks || '',
        ...(appointment.visit_type === 'Both' ? {
            center_medical_status: appointment.center_medical_status,
            home_medical_status: appointment.home_medical_status
        } : {}),
        ...(actorContext ? { actor_context: actorContext } : {})
    };
}

function buildMedicalCompletedMeta(appointment, additionalData, actorContext) {
    return {
        ...basePayload(appointment),
        appointment_date: appointment.appointment_date,
        medical_remarks: appointment.medical_remarks || '',
        ...(appointment.visit_type === 'Both' ? {
            center_medical_status: appointment.center_medical_status,
            home_medical_status: appointment.home_medical_status
        } : {}),
        ...(actorContext ? { actor_context: actorContext } : {})
    };
}

function buildQCCompletedMeta(appointment, additionalData) {
    const { images, documents } = buildMediaUrls(additionalData);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    return {
        ...basePayload(appointment),
        appointment_date: appointment.appointment_date,
        qc_status: appointment.qc_status,
        customer_images: images,
        documents: documents,
        tpa_pdf_url: additionalData.tpa_pdf_url || null
    };
}

// ─── Core trigger ───────────────────────────────────────────────────────────

/**
 * Generic webhook trigger - fetches appointment, builds event-specific metadata, sends
 */
async function triggerWebhook(appointmentId, eventType, additionalData = {}, actorContext = null) {
    let numericAppointmentId;
    try {
        if (process.env.TPA_INTEGRATION_ENABLED !== 'true') {
            return;
        }

        numericAppointmentId = parseInt(appointmentId, 10);
        if (!appointmentId || isNaN(numericAppointmentId) || numericAppointmentId <= 0) {
            logger.error('[TPA-WH] Invalid appointmentId', { appointmentId });
            return;
        }

        if (!eventType || typeof eventType !== 'string' || eventType.trim().length === 0) {
            logger.error('[TPA-WH] Invalid eventType', { eventType });
            return;
        }

        logger.info('[TPA-WH] Trigger start', { appointmentId: numericAppointmentId, eventType });

        const appointment = await getAppointmentData(numericAppointmentId);
        if (!appointment) {
            logger.warn('[TPA-WH] Appointment not found', { appointmentId: numericAppointmentId });
            return;
        }

        if (!appointment.client_id) {
            logger.error('[TPA-WH] Appointment missing client_id', { appointmentId: numericAppointmentId, caseNumber: appointment.case_number });
            return;
        }

        // Build event-specific metadata
        let meta = {};
        switch (eventType) {
            case 'appointment_confirmed':
                meta = buildConfirmedMeta(appointment);
                break;
            case 'appointment_rescheduled':
                meta = buildRescheduledMeta(appointment);
                break;
            case 'appointment_cancelled':
                meta = buildCancelledMeta(appointment);
                break;
            case 'patient_arrived':
                meta = buildArrivedMeta(appointment, additionalData, actorContext);
                break;
            case 'medical_in_progress':
            case 'medical_partially_completed':
                meta = buildMedicalProgressMeta(appointment, actorContext);
                break;
            case 'medical_completed':
                meta = buildMedicalCompletedMeta(appointment, additionalData, actorContext);
                break;
            case 'qc_completed':
                meta = buildQCCompletedMeta(appointment, additionalData);
                break;
            default:
                meta = basePayload(appointment);
                break;
        }

        // Build the event data that TPAWebhookService expects
        const eventData = {
            case_number: appointment.case_number,
            application_number: appointment.application_number || '',
            data: meta
        };

        logger.info('[TPA-WH] Payload built', {
            appointmentId: numericAppointmentId,
            eventType,
            caseNumber: appointment.case_number,
            clientId: appointment.client_id,
            metaKeys: Object.keys(meta)
        });

        await TPAWebhookService.sendEvent(appointment.client_id, eventType, eventData);

        logger.info('[TPA-WH] Trigger complete', {
            appointmentId: numericAppointmentId,
            eventType,
            caseNumber: appointment.case_number
        });

    } catch (error) {
        logger.error('[TPA-WH] Error triggering webhook', {
            appointmentId: numericAppointmentId,
            eventType,
            error: error.message,
            stack: error.stack
        });
    }
}

// ─── Named triggers (called from routes) ────────────────────────────────────

async function triggerAppointmentConfirmed(appointmentId) {
    await triggerWebhook(appointmentId, 'appointment_confirmed');
}

async function triggerAppointmentRescheduled(appointmentId) {
    await triggerWebhook(appointmentId, 'appointment_rescheduled');
}

async function triggerAppointmentCancelled(appointmentId) {
    await triggerWebhook(appointmentId, 'appointment_cancelled');
}

// Store pending enhanced webhooks
const pendingEnhancedWebhooks = new Map(); // appointmentId -> { timeoutId, eventType, actorContext }

function mapMedicalStatusToEvent(medicalStatus) {
    const normalizedStatus = String(medicalStatus || '').trim().toLowerCase();

    switch (normalizedStatus) {
        case 'arrived':
            return 'patient_arrived';
        case 'in_process':
        case 'in_progress':
        case 'medical_started':
        case 'started':
            return 'medical_in_progress';
        case 'partially_completed':
            return 'medical_partially_completed';
        case 'completed':
            return 'medical_completed';
        default:
            return null;
    }
}

async function triggerMedicalStatusUpdate(appointmentId, medicalStatus, actorContext = null, additionalData = {}) {
    const eventType = mapMedicalStatusToEvent(medicalStatus);

    if (!eventType) {
        logger.warn('[TPA-WH] Unknown medical status for webhook', { appointmentId, medicalStatus });
        return false;
    }

    // For arrival, use smart delayed webhook
    if (eventType === 'patient_arrived') {
        await triggerSmartDelayedWebhook(appointmentId, eventType, additionalData, actorContext);
        return true;
    }

    await triggerWebhook(appointmentId, eventType, additionalData, actorContext);
    return true;
}

/**
 * Smart delayed webhook for patient_arrived
 * Sends immediate webhook, then enhanced webhook after uploads complete or timeout
 */
async function triggerSmartDelayedWebhook(appointmentId, eventType, additionalData = {}, actorContext = null) {
    const appointmentIdStr = String(appointmentId);
    
    // Clear any existing pending webhook for this appointment
    if (pendingEnhancedWebhooks.has(appointmentIdStr)) {
        const pendingEntry = pendingEnhancedWebhooks.get(appointmentIdStr);
        clearTimeout(pendingEntry.timeoutId);
        pendingEnhancedWebhooks.delete(appointmentIdStr);
    }
    
    logger.info('[TPA-WH] Smart delayed webhook started', { appointmentId, eventType });
    
    // Step 1: Send immediate webhook with current data
    await triggerWebhook(appointmentId, eventType, additionalData, actorContext);
    
    // Step 2: Schedule enhanced webhook after delay
    const timeoutId = setTimeout(async () => {
        try {
            logger.info('[TPA-WH] Sending enhanced webhook', { appointmentId, eventType });
            
            // Fetch fresh arrival data with images/documents
            const enhancedData = await fetchArrivalData(appointmentId);
            
            // Send enhanced webhook
            await triggerWebhook(appointmentId, eventType, enhancedData, actorContext);
            
            logger.info('[TPA-WH] Enhanced webhook sent successfully', { appointmentId });
        } catch (error) {
            logger.error('[TPA-WH] Enhanced webhook failed', { appointmentId, error: error.message });
        } finally {
            // Clean up
            pendingEnhancedWebhooks.delete(appointmentIdStr);
        }
    }, 5000); // 5 second delay to allow uploads
    
    pendingEnhancedWebhooks.set(appointmentIdStr, {
        timeoutId,
        eventType,
        actorContext
    });
}

/**
 * Call this when images/documents are uploaded to send enhanced webhook immediately
 */
function triggerEnhancedWebhookNow(appointmentId) {
    const appointmentIdStr = String(appointmentId);
    
    if (pendingEnhancedWebhooks.has(appointmentIdStr)) {
        const pendingEntry = pendingEnhancedWebhooks.get(appointmentIdStr);

        logger.info('[TPA-WH] Triggering enhanced webhook immediately', { appointmentId });
        
        // Clear the timeout and trigger immediately
        clearTimeout(pendingEntry.timeoutId);
        pendingEnhancedWebhooks.delete(appointmentIdStr);
        
        // Trigger enhanced webhook immediately
        setTimeout(async () => {
            try {
                const enhancedData = await fetchArrivalData(appointmentId);
                await triggerWebhook(
                    appointmentId,
                    pendingEntry.eventType || 'patient_arrived',
                    enhancedData,
                    pendingEntry.actorContext || null
                );
                logger.info('[TPA-WH] Immediate enhanced webhook sent', { appointmentId });
            } catch (error) {
                logger.error('[TPA-WH] Immediate enhanced webhook failed', { appointmentId, error: error.message });
            }
        }, 500); // Small delay to ensure database is updated
    }
}

async function triggerQCCompleted(appointmentId, additionalData) {
    await triggerWebhook(appointmentId, 'qc_completed', additionalData);
}

module.exports = {
    triggerAppointmentConfirmed,
    triggerAppointmentRescheduled,
    triggerAppointmentCancelled,
    triggerMedicalStatusUpdate,
    triggerQCCompleted,
    triggerWebhook,
    triggerEnhancedWebhookNow
};
