/**
 * Appointment Email Service
 * Handles sending appointment-related emails with PDF attachments
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const emailService = require('../../lib/emailService');
const AppointmentTPAPDF = require('./AppointmentComprehensivePDF');
const { logTpaEmail } = require('../s_tap_email_log');
const { triggerQCCompleted } = require('../../lib/tpaWebhookHelper');

/**
 * Check if TPA email feature is enabled
 * @returns {boolean}
 */
function isTpaEmailEnabled() {
    const enabled = process.env.TPA_EMAIL_ENABLED;
    return enabled === 'true' || enabled === '1';
}

function requiresAmountEvidence(costType) {
    const normalized = String(costType || '').trim().toLowerCase();
    return Boolean(normalized) && !['credit', 'client', 'client cost'].includes(normalized);
}

function validateAmountEvidence(appointment) {
    if (!requiresAmountEvidence(appointment.cost_type)) {
        return null;
    }

    const amount = Number(appointment.amount);
    const hasAmount = Number.isFinite(amount) && amount > 0;
    const hasEvidence = Boolean(String(appointment.amount_upload || '').trim());

    if (hasAmount && hasEvidence) {
        return null;
    }

    const missing = [];
    if (!hasAmount) missing.push('amount');
    if (!hasEvidence) missing.push('payment evidence');

    return {
        success: false,
        message: `Please fill ${missing.join(' and ')} before sending TPA email for ${appointment.cost_type} appointments.`,
        statusCode: 400
    };
}

class AppointmentEmailService {
    /**
     * Send appointment completion email with PDF attachment to client
     * @param {number} appointmentId - The appointment ID
     * @param {number} sentBy - User ID who is sending the email
     * @returns {Promise<Object>} Result with success status and message
     */
    async sendAppointmentEmailToClient(appointmentId, sentBy = null) {
        // Check if feature is enabled
        if (!isTpaEmailEnabled()) {
            logger.info('TPA email feature is disabled (TPA_EMAIL_ENABLED=false)');
            return {
                success: false,
                message: 'TPA email feature is disabled',
                statusCode: 403
            };
        }

        try {
            // Fetch appointment with client details and diagnostic center emails
            const appointments = await db.query(
                `SELECT a.*, 
                        c.client_name, c.client_code, c.email_id as client_email, c.email_id_2 as client_email_2, c.email_id_3 as client_email_3,
                        i.insurer_name, i.insurer_code,
                        dc.center_name, dc.email as center_email,
                        odc.center_name as other_center_name, odc.email as other_center_email,
                        t.full_name as technician_name
                 FROM appointments a
                 LEFT JOIN clients c ON a.client_id = c.id
                 LEFT JOIN insurers i ON a.insurer_id = i.id
                 LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
                 LEFT JOIN diagnostic_centers odc ON a.other_center_id = odc.id
                 LEFT JOIN technicians t ON a.assigned_technician_id = t.id
                 WHERE a.id = ?`,
                [appointmentId]
            );

            if (!appointments || appointments.length === 0) {
                return {
                    success: false,
                    message: 'Appointment not found',
                    statusCode: 404
                };
            }

            const appointment = appointments[0];

            const amountEvidenceError = validateAmountEvidence(appointment);
            if (amountEvidenceError) {
                return amountEvidenceError;
            }

            // Primary email is mandatory
            if (!appointment.client_email) {
                return {
                    success: false,
                    message: 'Client does not have a primary email address configured',
                    statusCode: 400
                };
            }

            // Build recipient list: primary required, secondary and tertiary optional
            const recipients = [appointment.client_email];
            if (appointment.client_email_2) {
                recipients.push(appointment.client_email_2);
            }
            if (appointment.client_email_3) {
                recipients.push(appointment.client_email_3);
            }

            // Build CC list with diagnostic center emails based on visit type
            const ccList = [];
            
            // Always add primary center email if available
            if (appointment.center_email) {
                ccList.push(appointment.center_email);
            }
            
            // Add other center email for "Both" visit type if available
            if (appointment.visit_type === 'Both' && appointment.other_center_email) {
                ccList.push(appointment.other_center_email);
            }

            // Generate TPA PDF first
            const pdfResult = await AppointmentTPAPDF.generateTPAPDF(appointmentId);
            if (!pdfResult.success) {
                return {
                    success: false,
                    message: 'Failed to generate PDF',
                    statusCode: 500
                };
            }

            // Log email details for tracking
            logger.info('Sending appointment completion email', {
                appointmentId,
                recipients,
                ccList: ccList.length > 0 ? ccList : null,
                visitType: appointment.visit_type,
                centerEmail: appointment.center_email,
                otherCenterEmail: appointment.other_center_email
            });

            // Send email with PDF attachment and CC to diagnostic centers
            const emailResult = await emailService.sendAppointmentCompletionEmail(
                recipients,
                appointment,
                pdfResult.pdfPath,
                ccList.length > 0 ? ccList : null
            );

            if (!emailResult.success) {
                return {
                    success: false,
                    message: emailResult.message || 'Failed to send email',
                    statusCode: 500
                };
            }

            logger.info('Appointment PDF emailed to client', {
                appointmentId,
                clientEmails: recipients,
                applicationNumber: appointment.application_number || `APT-${appointmentId}`,
                caseNumber: appointment.case_number
            });

            // Log TPA email with client relationship
            try {
                await logTpaEmail(appointmentId, appointment.client_id, recipients, sentBy, 'sent');
            } catch (logError) {
                logger.error('Failed to log TPA email', {
                    appointmentId,
                    client_id: appointment.client_id,
                    error: logError.message
                });
                // Don't fail the email sending if logging fails
            }

            // Trigger TPA webhook for QC completion with PDF and media
            if (process.env.TPA_INTEGRATION_ENABLED === 'true') {
                try {
                    const pdfUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/${pdfResult.pdfPath}`;
                    
                    // Fetch images and documents for QC completion
                    const db = require('../../lib/dbconnection');
                    
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
                    
                    const additionalData = {
                        tpa_pdf_url: pdfUrl,
                        customer_images: images,
                        documents: documents
                    };
                    
                    await triggerQCCompleted(appointmentId, additionalData);
                    
                    logger.info('Enhanced TPA webhook triggered for QC completion', { 
                        appointmentId,
                        case_number: appointment.case_number,
                        pdf_url: pdfUrl
                    });
                } catch (webhookError) {
                    logger.error('Failed to trigger enhanced TPA webhook for QC completion', { 
                        appointmentId,
                        error: webhookError.message 
                    });
                    // Don't fail the email sending if webhook fails
                }
            }

            return {
                success: true,
                message: 'Appointment completion email sent successfully',
                data: {
                    appointmentId,
                    recipients,
                    pdfPath: pdfResult.pdfPath
                }
            };
        } catch (error) {
            logger.error('Error sending appointment email', {
                appointmentId,
                error: error.message
            });
            throw error;
        }
    }
}

const appointmentEmailService = new AppointmentEmailService();
module.exports = appointmentEmailService;
