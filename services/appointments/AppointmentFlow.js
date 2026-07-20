/**
 * Appointment Flow & Status Management
 * Handles status transitions, scheduling, and workflow operations
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { 
    logOperationStart, 
    logOperationEnd, 
    logDBState, 
    logActorContext, 
    logCompletionStatus, 
    logReportTypeTracking, 
    logBothAppointmentSplit,
    logFieldMapping,
    logTestUpdates
} = require('../../lib/appointmentLogger');
const {
    computeOverallStatus,
    parsePendingReportTypes,
    serializePendingReportTypes
} = require('./AppointmentStatusHelpers');

/**
 * Status flow configuration
 */
const STATUS_FLOW = {
    pending: ['scheduled', 'cancelled'],
    scheduled: ['arrived', 'cancelled', 'rescheduled'],
    rescheduled: ['arrived', 'cancelled'],
    arrived: ['in_process'],
    in_process: ['completed', 'partially_completed']
};

/**
 * Validate status transition
 */
function isValidStatusTransition(currentStatus, newStatus) {
    if (!currentStatus) return true;
    const allowedNextStatuses = STATUS_FLOW[currentStatus] || [];
    return allowedNextStatuses.includes(newStatus) || currentStatus === newStatus;
}

/**
 * Log status changes to history table
 */
async function logStatusHistory(appointmentId, changeData, connection = null) {
    const conn = connection || db;
    try {
        const sql = `
            INSERT INTO appointment_status_history 
            (appointment_id, old_status, new_status, old_medical_status, new_medical_status, 
             changed_by, change_type, remarks, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        const metadata = changeData.metadata ? JSON.stringify(changeData.metadata) : null;

        const params = [
            appointmentId,
            changeData.old_status || null,
            changeData.new_status || null,
            changeData.old_medical_status || null,
            changeData.new_medical_status || null,
            changeData.changed_by,
            changeData.change_type || 'status_change',
            changeData.remarks || null,
            metadata
        ];

        if (connection) {
            await connection.query(sql, params);
        } else {
            await db.query(sql, params);
        }
    } catch (error) {
        logger.error('Error logging status history:', error);
        // Don't throw - logging failure shouldn't break the main operation
    }
}

/**
 * Center confirm schedule
 */
async function confirmSchedule(appointmentId, confirmedDate, confirmedTime, userId, actorContext = null) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        logOperationStart('CONFIRM_SCHEDULE', appointmentId, {
            confirmedDate,
            confirmedTime,
            userId,
            actorContext
        });

        const [current] = await connection.query(
            'SELECT visit_type, medical_status, center_confirmed_at, home_confirmed_at, center_medical_status, home_medical_status, center_id, other_center_id FROM appointments WHERE id = ?',
            [appointmentId]
        );

        if (current && current[0]) {
            logDBState('BEFORE_CONFIRM_SCHEDULE', appointmentId, current[0]);
        }

        const currentRow = current[0];
        const visitType = currentRow.visit_type;

        // For Both appointments with actorContext, update per-side fields
        if (visitType === 'Both' && actorContext) {
            // Determine which side to update based on actor's center affiliation
            let side = 'center'; // default to center side
            
            // SAFETY CHECK: Verify user's actual center affiliation and override incorrect context
            let actualCenterId = null;
            if (actorContext.centerId) {
                actualCenterId = actorContext.centerId;
            } else if (actorContext.technicianId) {
                // Look up technician's assigned center
                try {
                    const [techRows] = await connection.query(
                        'SELECT center_id FROM technicians WHERE id = ?',
                        [actorContext.technicianId]
                    );
                    if (techRows && techRows[0]) {
                        actualCenterId = techRows[0].center_id;
                    }
                } catch (e) {
                    // If lookup fails, default to home side for safety
                    side = 'home';
                }
            }
            
            // Additional safety: Check if user actually belongs to the center they claim
            if (actualCenterId && userId) {
                try {
                    const [userRows] = await connection.query(
                        'SELECT center_id, diagnostic_center_id FROM users WHERE id = ?',
                        [userId]
                    );
                    if (userRows && userRows[0]) {
                        const userCenterId = userRows[0].center_id || userRows[0].diagnostic_center_id;
                        // Override if frontend sent wrong centerId
                        if (userCenterId && userCenterId !== actualCenterId) {
                            logger.warn('Frontend sent incorrect centerId, overriding with user actual center', {
                                appointmentId,
                                frontendCenterId: actualCenterId,
                                userActualCenterId: userCenterId,
                                userId
                            });
                            actualCenterId = userCenterId;
                        }
                    }
                } catch (e) {
                    // If lookup fails, continue with provided context
                }
            }
            
            if (actualCenterId) {
                // If actor has centerId, check if it matches appointment's center or other_center
                if (actualCenterId === currentRow.center_id) {
                    side = 'center';
                } else if (actualCenterId === currentRow.other_center_id) {
                    side = 'home';
                }
            }
            
            const updateFields = [];
            const updateValues = [];
            
            logger.info('confirmSchedule for Both appointment', {
                appointmentId,
                side,
                actorContext,
                appointmentCenterId: currentRow.center_id,
                appointmentOtherCenterId: currentRow.other_center_id
            });

            if (side === 'center') {
                updateFields.push('center_confirmed_at = ?');
                updateValues.push(new Date(`${confirmedDate} ${confirmedTime}`));
                updateFields.push('center_medical_status = ?');
                updateValues.push('scheduled');
            } else {
                updateFields.push('home_confirmed_at = ?');
                updateValues.push(new Date(`${confirmedDate} ${confirmedTime}`));
                updateFields.push('home_medical_status = ?');
                updateValues.push('scheduled');
            }

            // Check if both sides have now confirmed
            const centerConfirmed = side === 'center' ? true : !!currentRow.center_confirmed_at;
            const homeConfirmed = side === 'home' ? true : !!currentRow.home_confirmed_at;

            if (centerConfirmed && homeConfirmed) {
                updateFields.push('status = ?');
                updateValues.push('pending');
                updateFields.push('medical_status = ?');
                updateValues.push('scheduled');
            }

            updateFields.push('updated_at = NOW()');
            updateFields.push('updated_by = ?');
            updateValues.push(userId);
            updateValues.push(appointmentId);

            await connection.query(
                `UPDATE appointments SET ${updateFields.join(', ')} WHERE id = ?`,
                updateValues
            );
        } else {
            // Single center/home flow - use existing fields
            await connection.query(`
                UPDATE appointments 
                SET 
                    confirmed_date = ?,
                    confirmed_time = ?,
                    status = 'pending',
                    medical_status = 'scheduled',
                    updated_at = NOW(),
                    updated_by = ?
                WHERE id = ?
            `, [confirmedDate, confirmedTime, userId, appointmentId]);
        }

        await logStatusHistory(appointmentId, {
            old_status: currentRow?.status || null,
            new_status: visitType === 'Both' && actorContext ? currentRow?.status || null : 'pending',
            old_medical_status: currentRow?.medical_status || null,
            new_medical_status: 'scheduled',
            changed_by: userId,
            change_type: 'schedule_confirm',
            remarks: visitType === 'Both' && actorContext 
                ? `${actorContext.type === 'center' ? 'Center' : 'Home'} side confirmed`
                : 'Appointment schedule confirmed',
            metadata: { 
                confirmed_date: confirmedDate, 
                confirmed_time: confirmedTime,
                side: actorContext?.type || null
            }
        }, connection);

        await connection.commit();

        const [finalState] = await connection.query('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
        if (finalState && finalState[0]) {
            logDBState('AFTER_CONFIRM_SCHEDULE', appointmentId, finalState[0]);
        }
        logOperationEnd('CONFIRM_SCHEDULE', appointmentId, { success: true });
        return { success: true, message: 'Schedule confirmed successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error in confirmSchedule:', error);
        logOperationEnd('CONFIRM_SCHEDULE', appointmentId, { success: false, error: error.message });
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Center reschedule appointment
 */
async function rescheduleAppointment(appointmentId, newConfirmedDate, newConfirmedTime, remarks, userId, actorContext = null) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        logOperationStart('RESCHEDULE_APPOINTMENT', appointmentId, {
            newConfirmedDate,
            newConfirmedTime,
            remarks,
            userId,
            actorContext
        });

        const [current] = await connection.query(
            'SELECT visit_type, confirmed_date, confirmed_time, medical_status, center_confirmed_at, home_confirmed_at, center_medical_status, home_medical_status, center_id, other_center_id FROM appointments WHERE id = ? FOR UPDATE',
            [appointmentId]
        );

        if (!current || current.length === 0) {
            throw new Error('Appointment not found');
        }

        const currentRow = current[0];
        const visitType = currentRow.visit_type;
        logDBState('BEFORE_RESCHEDULE', appointmentId, currentRow);

        // For Both appointments with actorContext, update per-side fields
        if (visitType === 'Both' && actorContext) {
            // Determine which side to update based on actor's center affiliation
            let side = 'center'; // default to center side
            
            if (actorContext.centerId) {
                // If actor has centerId, check if it matches appointment's center or other_center
                if (actorContext.centerId === currentRow.center_id) {
                    side = 'center';
                } else if (actorContext.centerId === currentRow.other_center_id) {
                    side = 'home';
                }
            } else if (actorContext.technicianId) {
                // Look up technician's assigned center
                try {
                    const [techRows] = await connection.query(
                        'SELECT center_id FROM technicians WHERE id = ?',
                        [actorContext.technicianId]
                    );
                    if (techRows && techRows[0]) {
                        const techCenterId = techRows[0].center_id;
                        if (techCenterId === currentRow.center_id) {
                            side = 'center';
                        } else if (techCenterId === currentRow.other_center_id) {
                            side = 'home';
                        }
                    }
                } catch (e) {
                    // If lookup fails, default to home side for safety
                    side = 'home';
                }
            }
            
            const updateFields = [];
            const updateValues = [];
            
            const newDateTime = new Date(`${newConfirmedDate} ${newConfirmedTime}`);

            logger.info('rescheduleAppointment for Both appointment', {
                appointmentId,
                side,
                actorContext,
                appointmentCenterId: currentRow.center_id,
                appointmentOtherCenterId: currentRow.other_center_id
            });

            if (side === 'center') {
                updateFields.push('center_confirmed_at = ?');
                updateValues.push(newDateTime);
                updateFields.push('center_medical_status = ?');
                updateValues.push('rescheduled');
                updateFields.push('center_reschedule_remark = ?');
                updateValues.push(remarks || null);
            } else {
                updateFields.push('home_confirmed_at = ?');
                updateValues.push(newDateTime);
                updateFields.push('home_medical_status = ?');
                updateValues.push('rescheduled');
                updateFields.push('home_reschedule_remark = ?');
                updateValues.push(remarks || null);
            }

            updateFields.push('updated_at = NOW()');
            updateFields.push('updated_by = ?');
            updateValues.push(userId);
            updateValues.push(appointmentId);

            await connection.query(
                `UPDATE appointments SET ${updateFields.join(', ')} WHERE id = ?`,
                updateValues
            );

            await logStatusHistory(appointmentId, {
                old_status: currentRow.status || null,
                new_status: currentRow.status || null,
                old_medical_status: side === 'center' ? currentRow.center_medical_status : currentRow.home_medical_status,
                new_medical_status: 'rescheduled',
                changed_by: userId,
                change_type: 'schedule_reschedule',
                remarks: `${side === 'center' ? 'Center' : 'Home'} visit rescheduled: ${remarks || ''}`,
                metadata: {
                    side: side,
                    new_confirmed_datetime: newDateTime
                }
            }, connection);
        } else {
            // Single center/home flow - use visit-type specific fields
            const oldDateValue = currentRow.confirmed_date;
            const oldTimeValue = currentRow.confirmed_time;

            let oldDate = null;
            if (oldDateValue instanceof Date) {
                const year = oldDateValue.getFullYear();
                const month = String(oldDateValue.getMonth() + 1).padStart(2, '0');
                const day = String(oldDateValue.getDate()).padStart(2, '0');
                oldDate = `${year}-${month}-${day}`;
            } else if (typeof oldDateValue === 'string') {
                oldDate = oldDateValue.split('T')[0];
            }

            let oldTime = null;
            if (oldTimeValue) {
                oldTime = oldTimeValue.split(' ')[0] || oldTimeValue;
            }

            if (oldDate && oldTime && oldDate === newConfirmedDate && oldTime === newConfirmedTime) {
                throw new Error('Reschedule must be different from existing schedule date and time');
            }

            // Use visit-type specific remark field
            let remarkField = 'reschedule_remark';
            if (visitType === 'Home_Visit') {
                remarkField = 'home_reschedule_remark';
            } else if (visitType === 'Center') {
                remarkField = 'center_reschedule_remark';
            }

            await connection.query(
                `UPDATE appointments 
                 SET 
                     confirmed_date = ?,
                     confirmed_time = ?,
                     medical_status = 'rescheduled',
                     ${remarkField} = ?,
                     updated_at = NOW(),
                     updated_by = ?
                 WHERE id = ?`,
                [newConfirmedDate, newConfirmedTime, remarks || null, userId, appointmentId]
            );

            await logStatusHistory(appointmentId, {
                old_status: currentRow.status || null,
                new_status: currentRow.status || null,
                old_medical_status: currentRow.medical_status,
                new_medical_status: 'rescheduled',
                changed_by: userId,
                change_type: 'schedule_reschedule',
                remarks: remarks || 'Appointment rescheduled',
                metadata: {
                    previous_confirmed_date: currentRow.confirmed_date,
                    previous_confirmed_time: currentRow.confirmed_time,
                    new_confirmed_date: newConfirmedDate,
                    new_confirmed_time: newConfirmedTime
                }
            }, connection);
        }

        await connection.commit();

        const [finalState] = await connection.query('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
        if (finalState && finalState[0]) {
            logDBState('AFTER_RESCHEDULE', appointmentId, finalState[0]);
        }
        logOperationEnd('RESCHEDULE_APPOINTMENT', appointmentId, { success: true });

        return { success: true, message: 'Appointment rescheduled successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error in rescheduleAppointment:', error);
        logOperationEnd('RESCHEDULE_APPOINTMENT', appointmentId, { success: false, error: error.message });
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Push back appointment (supports per-side for Both)
 */
async function pushBackAppointment(appointmentId, remarks, userId, actorContext = null) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        logOperationStart('PUSHBACK_APPOINTMENT', appointmentId, {
            remarks,
            userId,
            actorContext
        });

        const [current] = await connection.query('SELECT id, status, pushed_back, visit_type, center_pushed_back, home_pushed_back, medical_status FROM appointments WHERE id = ?', [appointmentId]);

        if (!current || current.length === 0) {
            throw new Error('Appointment not found');
        }

        logDBState('BEFORE_PUSHBACK', appointmentId, current[0]);
        const visitType = current[0].visit_type;

        if (visitType === 'Both') {
            if (!actorContext) {
                throw new Error('Both appointments require actorContext to push back per side');
            }

            const side = actorContext.type === 'center' ? 'center' : 'home';
            const centerPushed = side === 'center' ? 1 : (current[0].center_pushed_back || 0);
            const homePushed = side === 'home' ? 1 : (current[0].home_pushed_back || 0);

            const updates = [];
            const values = [];

            if (side === 'center') {
                updates.push('center_pushed_back = 1');
                updates.push('center_pushback_remarks = ?');
                values.push(remarks || null);
            } else {
                updates.push('home_pushed_back = 1');
                updates.push('home_pushback_remarks = ?');
                values.push(remarks || null);
            }

            // Overall pushed_back flag if either side pushed
            const overallPushed = centerPushed || homePushed;
            updates.push('pushed_back = ?');
            values.push(overallPushed ? 1 : 0);

            // Set status to pushed_back when any side pushes
            updates.push('status = ?');
            values.push(overallPushed ? 'pushed_back' : 'pending');

            updates.push('pushback_remarks = ?');
            values.push(remarks || null);

            updates.push('pushed_back_by = ?');
            values.push(userId);
            updates.push('pushed_back_at = NOW()');
            updates.push('updated_at = NOW()');
            updates.push('updated_by = ?');
            values.push(userId);

            values.push(appointmentId);

            await connection.query(`UPDATE appointments SET ${updates.join(', ')} WHERE id = ?`, values);
        } else {
            // Simple flow
            await connection.query(`UPDATE appointments SET pushed_back = 1, status = 'pushed_back', pushback_remarks = ?, pushed_back_by = ?, pushed_back_at = NOW(), updated_at = NOW(), updated_by = ? WHERE id = ?`, [remarks, userId, userId, appointmentId]);
        }

        await connection.query(`INSERT INTO appointment_pushback_history (appointment_id, pushed_back_by, remarks) VALUES (?, ?, ?)`, [appointmentId, userId, remarks]);

        await logStatusHistory(appointmentId, {
            old_status: current[0].status || null,
            new_status: 'pushed_back',
            old_medical_status: current[0].medical_status,
            new_medical_status: 'pushed_back',
            changed_by: userId,
            change_type: 'push_back',
            remarks: remarks,
            metadata: { pushed_back_at: new Date() }
        }, connection);

        await connection.commit();

        const [finalState] = await connection.query('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
        if (finalState && finalState[0]) {
            logDBState('AFTER_PUSHBACK', appointmentId, finalState[0]);
        }
        logOperationEnd('PUSHBACK_APPOINTMENT', appointmentId, { success: true });

        return { success: true, message: 'Appointment pushed back successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error in pushBackAppointment:', error);
        logOperationEnd('PUSHBACK_APPOINTMENT', appointmentId, { success: false, error: error.message });
        throw new Error(`Failed to push back appointment: ${error.message}`);
    } finally {
        connection.release();
    }
}

/**
 * Admin restore pushed back appointment
 */
async function restoreAppointment(appointmentId, userId) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        logOperationStart('RESTORE_APPOINTMENT', appointmentId, {
            userId
        });

        const [appointment] = await connection.query('SELECT status, medical_status FROM appointments WHERE id = ? FOR UPDATE', [appointmentId]);

        if (!appointment || appointment.length === 0) {
            throw new Error('Appointment not found');
        }

        if (appointment[0].status !== 'pushed_back') {
            throw new Error('Only pushed back appointments can be restored');
        }

        logDBState('BEFORE_RESTORE', appointmentId, appointment[0]);

        // Get the original status before push back from status history
        const [statusHistory] = await connection.query(`
            SELECT old_status 
            FROM appointment_status_history 
            WHERE appointment_id = ? AND change_type = 'push_back' 
            ORDER BY created_at DESC 
            LIMIT 1
        `, [appointmentId]);

        // Debug logging
        logger.info('Restore Status History Query:', {
            appointmentId,
            historyFound: statusHistory.length,
            historyData: statusHistory
        });

        let originalStatus = 'pending'; // Default fallback
        
        if (statusHistory.length > 0 && statusHistory[0].old_status) {
            originalStatus = statusHistory[0].old_status;
        } else {
            // Try to find any status history record for this appointment
            const [anyHistory] = await connection.query(`
                SELECT old_status 
                FROM appointment_status_history 
                WHERE appointment_id = ? AND old_status IS NOT NULL AND old_status != 'pushed_back'
                ORDER BY created_at DESC 
                LIMIT 1
            `, [appointmentId]);
            
            if (anyHistory.length > 0 && anyHistory[0].old_status) {
                originalStatus = anyHistory[0].old_status;
                logger.info('Using fallback status from any history record:', originalStatus);
            } else {
                logger.warn('No status history found, using default pending status');
            }
        }

        await connection.query(`
            UPDATE appointments 
            SET 
                status = ?,
                pushed_back = 0,
                pushback_remarks = NULL,
                pushed_back_by = NULL,
                pushed_back_at = NULL,
                updated_at = NOW(),
                updated_by = ?
            WHERE id = ?
        `, [originalStatus, userId, appointmentId]);

        await logStatusHistory(appointmentId, {
            old_status: 'pushed_back',
            new_status: originalStatus,
            old_medical_status: appointment[0].medical_status,
            new_medical_status: appointment[0].medical_status, // Keep current medical status
            changed_by: userId,
            change_type: 'restore_appointment',
            metadata: { remarks: 'Appointment restored from pushed_back to original status' }
        }, connection);

        await connection.commit();

        const [finalState] = await connection.query('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
        if (finalState && finalState[0]) {
            logDBState('AFTER_RESTORE', appointmentId, finalState[0]);
        }
        logOperationEnd('RESTORE_APPOINTMENT', appointmentId, { success: true });

        return { success: true, message: 'Appointment restored successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error in restoreAppointment:', error);
        logOperationEnd('RESTORE_APPOINTMENT', appointmentId, { success: false, error: error.message });
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Update medical status
 * @param {number} appointmentId
 * @param {string} newStatus - arrived, in_process, partially_completed, completed
 * @param {object} additionalData - aadhaar, pan, remarks, pending_report_types
 * @param {number} userId
 * @param {object} actorContext - { centerId, technicianId, type: 'center'|'technician' }
 */
async function updateMedicalStatus(appointmentId, newStatus, additionalData, userId, actorContext = null) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        logOperationStart('UPDATE_MEDICAL_STATUS', appointmentId, {
            newStatus,
            actorContext,
            additionalData: {
                hasAadhaar: !!additionalData?.aadhaar_number,
                hasPan: !!additionalData?.pan_number,
                hasRemarks: !!additionalData?.medical_remarks,
                pendingReportTypes: additionalData?.pending_report_types
            },
            userId
        });

        const [current] = await connection.query(
            'SELECT status, medical_status, aadhaar_number, pan_number, medical_remarks, visit_type, center_id, other_center_id, pending_report_types, center_medical_status, home_medical_status, center_confirmed_at, home_confirmed_at FROM appointments WHERE id = ?',
            [appointmentId]
        );

        if (!current || current.length === 0) {
            throw new Error('Appointment not found');
        }

        const currentRow = Array.isArray(current) ? current[0] : current;

        logDBState('BEFORE_UPDATE', appointmentId, currentRow);

        if (actorContext) {
            logActorContext(appointmentId, { ...actorContext, userId });
        }

        const currentSideStatus = currentRow.visit_type === 'Both' && actorContext
            ? (
                actorContext.side === 'center'
                    ? currentRow.center_medical_status
                    : actorContext.side === 'home'
                        ? currentRow.home_medical_status
                        : actorContext.type === 'technician'
                            ? currentRow.home_medical_status
                            : currentRow.medical_status
            )
            : currentRow.medical_status;
        const hasAdditionalWrite = Boolean(
            additionalData &&
            (
                additionalData.aadhaar_number !== undefined ||
                additionalData.pan_number !== undefined ||
                additionalData.medical_remarks !== undefined ||
                additionalData.pending_report_types !== undefined
            )
        );

        if (
            String(currentSideStatus || '').toLowerCase() === String(newStatus || '').toLowerCase() &&
            !hasAdditionalWrite
        ) {
            await connection.rollback();
            return { success: true, message: 'No medical status change detected', noChange: true };
        }

        logFieldMapping(appointmentId, currentRow.visit_type, {
            visit_type: currentRow.visit_type,
            activeFields: currentRow.visit_type === 'Both' 
                ? ['center_confirmed_at', 'home_confirmed_at', 'center_arrived_at', 'home_arrived_at', 'pending_report_types (per-side)']
                : ['confirmed_at', 'arrived_at', 'pending_report_types (simple)'],
            legacyFieldsIgnored: currentRow.visit_type === 'Both'
                ? ['confirmed_at', 'arrived_at']
                : ['center_confirmed_at', 'home_confirmed_at', 'center_arrived_at', 'home_arrived_at']
        });

        // Normalize requested pending types (array or comma string)
        let requestPendingTypes = [];
        if (additionalData && additionalData.pending_report_types !== undefined) {
            const val = additionalData.pending_report_types;
            if (Array.isArray(val)) {
                requestPendingTypes = val;
            } else if (typeof val === 'string') {
                requestPendingTypes = val.split(',').map((s) => s.trim()).filter(Boolean);
            }
        }

        // Compute main status and pending report types
        let finalMedicalStatus = newStatus;
        let finalMainStatus = currentRow.status || null;
        let finalPendingString = null;
        let perSideUpdates = {}; // For Both appointments

        if (currentRow.visit_type === 'Both') {
            // Both appointment: MUST have actorContext to know which side to update
            if (!actorContext) {
                throw new Error('Both appointments require actorContext (center or technician) to update medical status. Cannot determine which side to update.');
            }

            // Resolve the side safely. Center logins use the appointment-side derived in the app scope helper.
            let side = actorContext.side;
            if (!side && actorContext.type === 'technician') {
                side = 'home';
            }
            if (!side && actorContext.centerId) {
                const [centerCheck] = await connection.query(
                    'SELECT center_id, other_center_id FROM appointments WHERE id = ?',
                    [appointmentId]
                );
                if (centerCheck.length > 0) {
                    const { center_id, other_center_id } = centerCheck[0];
                    if (actorContext.centerId === center_id) side = 'center';
                    if (actorContext.centerId === other_center_id) side = 'home';
                }
            }

            if (!side) {
                throw new Error('Unable to resolve appointment side for update');
            }

            // Update per-side status
            const statusField = side === 'center' ? 'center_medical_status' : 'home_medical_status';
            
            perSideUpdates[statusField] = newStatus;
            
            // Add per-side timestamps
            if (newStatus === 'arrived') {
                const arrivalField = side === 'center' ? 'center_arrived_at' : 'home_arrived_at';
                perSideUpdates[arrivalField] = 'NOW()';
            } else if (newStatus === 'completed') {
                const completedField = side === 'center' ? 'center_completed_at' : 'home_completed_at';
                perSideUpdates[completedField] = 'NOW()';
            }
            
            // Update per-side pending_report_types
            const currentPending = parsePendingReportTypes(currentRow.pending_report_types || '');
            if (newStatus === 'partially_completed') {
                currentPending[side] = requestPendingTypes;
            } else if (newStatus === 'completed') {
                currentPending[side] = [];
            }
            finalPendingString = serializePendingReportTypes(currentPending);
            
            // Compute overall status from both sides
            const centerStatus = side === 'center' ? newStatus : (currentRow.center_medical_status || null);
            const homeStatus = side === 'technician' ? newStatus : (currentRow.home_medical_status || null);
            
            finalMainStatus = computeOverallStatus(centerStatus, homeStatus);
            finalMedicalStatus = newStatus; // Keep individual side status for logging
            
        } else {
            // Simple flow: center/home only
            
            // Validate center ownership for simple flow appointments
            if (actorContext && actorContext.centerId) {
                const [centerCheck] = await connection.query(
                    'SELECT center_id, other_center_id, visit_type FROM appointments WHERE id = ?',
                    [appointmentId]
                );
                
                if (centerCheck.length > 0) {
                    const { center_id, other_center_id, visit_type } = centerCheck[0];
                    const ownsAppointmentCenter = actorContext.centerId === center_id || actorContext.centerId === other_center_id;
                    
                    // Allow either center slot to own the appointment so older or mixed data does not hard fail
                    if ((visit_type === 'Center_Visit' || visit_type === 'Home_Visit') && !ownsAppointmentCenter) {
                        throw new Error('Center can only update appointments assigned to their center');
                    }
                }
            }
            
            if (newStatus === 'arrived') {
                finalMainStatus = 'checked_in';
                finalMedicalStatus = 'arrived';
            } else if (newStatus === 'in_process') {
                finalMainStatus = 'medical_in_process';
                finalMedicalStatus = 'in_process';
            } else if (newStatus === 'partially_completed') {
                finalPendingString = requestPendingTypes.length > 0 ? requestPendingTypes.join(',') : null;
                finalMainStatus = 'medical_partially_completed';
                finalMedicalStatus = 'partially_completed';
            } else if (newStatus === 'completed') {
                finalPendingString = null;
                finalMainStatus = 'medical_completed';
                finalMedicalStatus = 'completed';
            }
        }

        // Build update fields in deterministic order to avoid misaligned values
        const updateFields = [];
        const updateValues = [];

        // For Both appointments, update per-side fields AND sync main medical_status to combined status
        if (currentRow.visit_type === 'Both' && actorContext) {
            for (const [field, value] of Object.entries(perSideUpdates)) {
                if (value === 'NOW()') {
                    updateFields.push(`${field} = NOW()`);
                } else {
                    updateFields.push(`${field} = ?`);
                    updateValues.push(value);
                }
            }

            // Sync main medical_status to computed overall status for reporting/completion
            if (finalMainStatus) {
                updateFields.push('medical_status = ?');
                updateValues.push(finalMainStatus);
            }
        } else {
            // Simple flow: update main medical_status
            updateFields.push('medical_status = ?');
            updateValues.push(finalMedicalStatus);
        }

        updateFields.push('status = ?');
        updateValues.push(finalMainStatus);

        updateFields.push('pending_report_types = ?');
        updateValues.push(finalPendingString);

        if (additionalData) {
            if (additionalData.aadhaar_number !== undefined) {
                updateFields.push('aadhaar_number = ?');
                updateValues.push(additionalData.aadhaar_number);
            }
            if (additionalData.pan_number !== undefined) {
                updateFields.push('pan_number = ?');
                updateValues.push(additionalData.pan_number);
            }
            if (additionalData.medical_remarks !== undefined) {
                updateFields.push('medical_remarks = ?');
                updateValues.push(additionalData.medical_remarks);
            }
        }

        updateFields.push('updated_at = NOW()');
        updateFields.push('updated_by = ?');
        updateValues.push(userId);

        updateValues.push(appointmentId);

        const finalQuery = `UPDATE appointments SET ${updateFields.join(', ')} WHERE id = ?`;
        logOperationEnd('PREPARE_UPDATE_QUERY', appointmentId, {
            query: finalQuery,
            fields: updateFields,
            values: updateValues
        });

        await connection.query(finalQuery, updateValues);

        // Update appointment_tests based on visit type and context
        if (['arrived', 'in_process', 'completed', 'partially_completed'].includes(newStatus)) {
            let testStatus = 'In Progress';
            let isCompleted = 0;

            if (newStatus === 'arrived') {
                testStatus = 'Ready';
            } else if (newStatus === 'in_process') {
                testStatus = 'In Progress';
            } else if (newStatus === 'completed') {
                testStatus = 'Completed';
                isCompleted = 1;
            } else if (newStatus === 'partially_completed') {
                const hasPending = Array.isArray(requestPendingTypes) && requestPendingTypes.length > 0;
                testStatus = hasPending ? 'Pending' : 'Completed';
                isCompleted = hasPending ? 0 : 1;
            }

            let visitSubtype;
            if (currentRow.visit_type === 'Both' && actorContext) {
                // Both appointment: update only the side that's being updated
                visitSubtype = side;
            } else {
                // Simple Center/Home visit always maps to its single side
                visitSubtype = currentRow.visit_type === 'Home_Visit' ? 'home' : 'center';
            }

            if (visitSubtype) {
                // For partial completion, set per-test status: Pending only for report types explicitly passed
                if (newStatus === 'partially_completed') {
                    // Load tests with report_type info
                    const [tests] = await connection.query(
                        `SELECT at.id, at.visit_subtype,
                                t.report_type AS test_report_type,
                                tc.report_type AS category_report_type
                         FROM appointment_tests at
                         LEFT JOIN tests t ON at.test_id = t.id
                         LEFT JOIN test_categories tc ON at.category_id = tc.id
                         WHERE at.appointment_id = ? AND at.visit_subtype = ?`,
                        [appointmentId, visitSubtype]
                    );

                    const pendingSet = new Set((requestPendingTypes || []).map((r) => String(r).toLowerCase()));

                    for (const row of Array.isArray(tests) ? tests : []) {
                        let reportType = row.test_report_type || row.category_report_type || '';
                        // Normalize to string before checking startsWith
                        if (Array.isArray(reportType)) {
                            reportType = reportType[0] || '';
                        }
                        if (reportType && typeof reportType === 'string' && reportType.startsWith('[')) {
                            try {
                                const arr = JSON.parse(reportType);
                                reportType = Array.isArray(arr) && arr.length > 0 ? arr[0] : '';
                            } catch (e) {
                                reportType = '';
                            }
                        }
                        const normalized = String(reportType || '').toLowerCase();
                        const keepPending = normalized && pendingSet.has(normalized);
                        const rowStatus = keepPending ? 'Pending' : 'Completed';
                        const rowCompleted = keepPending ? 0 : 1;

                        await connection.query(
                            `UPDATE appointment_tests
                             SET status = ?,
                                 is_completed = ?,
                                 updated_at = NOW(),
                                 updated_by = ?
                             WHERE id = ?`,
                            [rowStatus, rowCompleted, userId, row.id]
                        );
                    }

                    logTestUpdates(appointmentId, currentRow.visit_type, {
                        side: visitSubtype,
                        newStatus: testStatus,
                        isCompleted,
                        affectedRows: Array.isArray(tests) ? tests.length : 0
                    });
                } else {
                    const [testUpdateResult] = await connection.query(
                        `UPDATE appointment_tests
                         SET status = ?,
                             is_completed = ?,
                             updated_at = NOW(),
                             updated_by = ?
                         WHERE appointment_id = ?
                         AND visit_subtype = ?`,
                        [testStatus, isCompleted, userId, appointmentId, visitSubtype]
                    );

                    logTestUpdates(appointmentId, currentRow.visit_type, {
                        side: visitSubtype,
                        newStatus: testStatus,
                        isCompleted,
                        affectedRows: testUpdateResult?.affectedRows || 0
                    });
                }
            }
        }

        await logStatusHistory(appointmentId, {
            old_status: currentRow.status || null,
            new_status: finalMainStatus || currentRow.status || null,
            old_medical_status: currentRow.medical_status,
            new_medical_status: finalMedicalStatus,
            changed_by: userId,
            change_type: 'medical_status_update',
            remarks: additionalData?.medical_remarks || null,
            metadata: {
                ...(additionalData || {}),
                pending_report_types: finalPendingString
            }
        }, connection);

        await connection.commit();

        const [finalState] = await connection.query('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
        if (finalState && finalState[0]) {
            logDBState('AFTER_COMMIT', appointmentId, finalState[0]);
        }

        logOperationEnd('UPDATE_MEDICAL_STATUS', appointmentId, {
            success: true,
            finalMedicalStatus: newStatus,
            finalMainStatus: currentRow.status || null,
            finalPendingString: null
        });

        return { success: true, message: 'Medical status updated successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error in updateMedicalStatus:', error);
        const { appointmentLogger } = require('../../lib/appointmentLogger');
        appointmentLogger.error('UPDATE_MEDICAL_STATUS FAILED', {
            appointmentId,
            error: error.message,
            stack: error.stack
        });
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Mark test as completed
 */
async function markTestCompleted(testId, updatedBy, remarks = '') {
    const sql = `
        UPDATE appointment_tests 
        SET is_completed = 1, 
            completed_at = NOW(), 
            completed_by = ?,
            completion_remarks = ?,
            updated_at = NOW()
        WHERE id = ?
    `;

    const result = await db.query(sql, [updatedBy, remarks, testId]);

    if (result.affectedRows > 0) {
        const [test] = await db.query('SELECT appointment_id FROM appointment_tests WHERE id = ?', [testId]);
        if (test && test[0]) {
            const { updateAppointmentStatus } = require('./AppointmentCRUD');
            await updateAppointmentStatus(test[0].appointment_id);
        }
    }

    return result.affectedRows;
}

/**
 * Bulk mark tests as completed
 */
async function bulkMarkTestsCompleted(appointmentId, testIds, updatedBy, remarks = '') {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        if (!testIds || testIds.length === 0) {
            throw new Error('No test IDs provided');
        }

        const placeholders = testIds.map(() => '?').join(',');
        const updateSql = `
            UPDATE appointment_tests 
            SET is_completed = 1, 
                completed_at = NOW(), 
                completed_by = ?,
                completion_remarks = ?,
                status = 'Completed',
                updated_at = NOW()
            WHERE appointment_id = ? AND id IN (${placeholders})
        `;

        await connection.execute(updateSql, [updatedBy, remarks, appointmentId, ...testIds]);

        const [allTests] = await connection.execute(
            'SELECT COUNT(*) as total, SUM(is_completed) as completed FROM appointment_tests WHERE appointment_id = ?',
            [appointmentId]
        );

        if (allTests[0] && allTests[0].total === allTests[0].completed) {
            // Get current status before update
            const [current] = await connection.execute(
                'SELECT status, medical_status FROM appointments WHERE id = ?',
                [appointmentId]
            );
            
            await connection.execute(
                `UPDATE appointments 
                 SET status = 'Completed', 
                     medical_completed_at = NOW(),
                     updated_at = NOW()
                 WHERE id = ?`,
                [appointmentId]
            );
            
            // Log status history
            await logStatusHistory(appointmentId, {
                old_status: current[0]?.status || null,
                new_status: 'Completed',
                old_medical_status: current[0]?.medical_status || null,
                new_medical_status: 'Completed',
                changed_by: updatedBy,
                change_type: 'bulk_complete',
                remarks: `All ${testIds.length} tests marked as completed`,
                metadata: { test_ids: testIds }
            }, connection);
        }

        await connection.commit();
        return { success: true, updatedCount: testIds.length };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Mark appointment as completed (final confirmation from reports)
 */
async function completeAppointment(appointmentId, userId) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        logOperationStart('COMPLETE_APPOINTMENT_FINAL', appointmentId, { userId });

        const [appointment] = await connection.query('SELECT status, medical_status FROM appointments WHERE id = ? FOR UPDATE', [appointmentId]);

        if (!appointment || appointment.length === 0) {
            throw new Error('Appointment not found');
        }

        if (appointment[0].status === 'pushed_back') {
            throw new Error('Appointment is already pushed back');
        }

        logDBState('BEFORE_COMPLETE_APPOINTMENT', appointmentId, appointment[0]);

        await connection.query(
            `UPDATE appointments 
             SET status = 'completed', updated_at = NOW(), updated_by = ?
             WHERE id = ?`,
            [userId, appointmentId]
        );

        await logStatusHistory(appointmentId, {
            old_status: appointment[0].status,
            new_status: 'completed',
            old_medical_status: appointment[0].medical_status,
            new_medical_status: 'completed',
            changed_by: userId,
            change_type: 'appointment_complete',
            remarks: 'Appointment marked as fully completed from reports'
        }, connection);

        await connection.commit();

        const [finalState] = await connection.query('SELECT * FROM appointments WHERE id = ?', [appointmentId]);
        if (finalState && finalState[0]) {
            logDBState('AFTER_COMPLETE_APPOINTMENT', appointmentId, finalState[0]);
        }
        logOperationEnd('COMPLETE_APPOINTMENT_FINAL', appointmentId, { success: true });

        return { success: true, message: 'Appointment marked as completed' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error in completeAppointment:', error);
        logOperationEnd('COMPLETE_APPOINTMENT_FINAL', appointmentId, { success: false, error: error.message });
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Update test assignments
 */
async function updateAppointmentTestAssignments(appointmentId, testUpdates, updatedBy) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        for (const update of testUpdates) {
            const fields = [];
            const values = [];

            // Handle center assignment
            if (update.assigned_center_id !== undefined) {
                fields.push('assigned_center_id = ?');
                values.push(update.assigned_center_id);
            }

            // Handle technician assignment with business logic
            if (update.visit_subtype === 'center') {
                // Always clear technician for center visits
                fields.push('assigned_technician_id = ?');
                values.push(null);
            } else if (update.assigned_technician_id !== undefined) {
                // Only set technician for non-center visits
                fields.push('assigned_technician_id = ?');
                values.push(update.assigned_technician_id);
            }

            // Handle visit subtype
            if (update.visit_subtype !== undefined) {
                fields.push('visit_subtype = ?');
                values.push(update.visit_subtype);
            }

            if (fields.length > 0) {
                fields.push('updated_at = NOW()');
                // Use testId (now correctly pointing to appointment_test_id)
                const testId = update.testId || update.test_id;
                values.push(testId, appointmentId);

                const sql = `UPDATE appointment_tests 
                             SET ${fields.join(', ')} 
                             WHERE id = ? AND appointment_id = ?`;
                
                await connection.query(sql, values);
            }
        }

        await connection.commit();
        return { success: true, message: 'Test assignments updated successfully' };
    } catch (error) {
        await connection.rollback();
        logger.error('Error updating test assignments:', error);
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    confirmSchedule,
    rescheduleAppointment,
    pushBackAppointment,
    restoreAppointment,
    updateMedicalStatus,
    markTestCompleted,
    bulkMarkTestsCompleted,
    updateAppointmentTestAssignments,
    completeAppointment,
    logStatusHistory
};
