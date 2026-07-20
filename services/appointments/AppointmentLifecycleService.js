const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

/**
 * Service for tracking complete appointment lifecycle
 * Aggregates data from appointments, appointment_history, qc_history, and related tables
 */
class AppointmentLifecycleService {
  /**
   * Search and retrieve complete lifecycle of an appointment
   * @param {string} searchTerm - Case number, application number, or appointment ID
   * @param {number} userId - User ID for access control (optional)
   * @returns {Promise<Object>} Complete lifecycle data
   */
  async getAppointmentLifecycle(searchTerm, userId = null) {
    try {
      logger.info('Fetching appointment lifecycle', { searchTerm, userId });

      // Check if user is linked to a client (TPA user)
      let linkedClientId = null;
      if (userId) {
        const clientLinkSql = `
          SELECT c.id, c.client_code, c.client_name
          FROM clients c
          WHERE c.user_id = ? AND c.is_deleted = 0 AND c.is_active = 1
          LIMIT 1
        `;
        const clientLinks = await db.query(clientLinkSql, [userId]);
        if (clientLinks.length > 0) {
          linkedClientId = clientLinks[0].id;
          logger.info('User linked to client', { userId, clientId: linkedClientId, clientCode: clientLinks[0].client_code });
        }
      }

      // First, find the appointment with client filtering
      const searchValue = String(searchTerm).trim();
      const normalizedSearch = searchValue.toLowerCase().replace(/[^a-z0-9]/g, '');
      const isPureNumericId = /^\d+$/.test(searchValue);

      const appointmentSql = `
        SELECT 
          a.*,
          c.client_name,
          c.client_code,
          dc.center_name as center_name,
          dc.center_code as center_code,
          odc.center_name as other_center_name,
          odc.center_code as other_center_code,
          ins.insurer_name,
          tech.full_name as technician_name,
          tech.technician_code,
          creator.username as created_by_name,
          updater.username as updated_by_name,
          (SELECT 
             CONCAT(t.full_name, ' (', t.technician_code, ')') 
           FROM appointment_tests at 
           LEFT JOIN technicians t ON at.assigned_technician_id = t.id 
           WHERE at.appointment_id = a.id 
             AND at.assigned_technician_id IS NOT NULL 
           LIMIT 1) as technician_name,
          (SELECT 
             t.technician_code 
           FROM appointment_tests at 
           LEFT JOIN technicians t ON at.assigned_technician_id = t.id 
           WHERE at.appointment_id = a.id 
             AND at.assigned_technician_id IS NOT NULL 
           LIMIT 1) as technician_code
        FROM appointments a
        LEFT JOIN clients c ON a.client_id = c.id
        LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
        LEFT JOIN diagnostic_centers odc ON a.other_center_id = odc.id
        LEFT JOIN insurers ins ON a.insurer_id = ins.id
        LEFT JOIN technicians tech ON a.assigned_technician_id = tech.id
        LEFT JOIN users creator ON a.created_by = creator.id
        LEFT JOIN users updater ON a.updated_by = updater.id
        WHERE a.is_deleted = 0
          AND (
            ${isPureNumericId ? 'a.id = ? OR' : ''}
            LOWER(a.case_number) = ? OR
            LOWER(a.application_number) = ? OR
            LOWER(REPLACE(REPLACE(REPLACE(a.case_number, '/', ''), '-', ''), ' ', '')) = ? OR
            LOWER(REPLACE(REPLACE(REPLACE(a.application_number, '/', ''), '-', ''), ' ', '')) = ? OR
            LOWER(a.case_number) LIKE ? OR
            LOWER(a.application_number) LIKE ? OR
            LOWER(REPLACE(REPLACE(REPLACE(a.case_number, '/', ''), '-', ''), ' ', '')) LIKE ? OR
            LOWER(REPLACE(REPLACE(REPLACE(a.application_number, '/', ''), '-', ''), ' ', '')) LIKE ?
          )
          ${linkedClientId ? 'AND a.client_id = ?' : ''}
        ORDER BY
          CASE
            WHEN LOWER(a.case_number) = ? THEN 1
            WHEN LOWER(a.application_number) = ? THEN 2
            WHEN LOWER(REPLACE(REPLACE(REPLACE(a.case_number, '/', ''), '-', ''), ' ', '')) = ? THEN 3
            WHEN LOWER(REPLACE(REPLACE(REPLACE(a.application_number, '/', ''), '-', ''), ' ', '')) = ? THEN 4
            WHEN LOWER(a.case_number) LIKE ? THEN 5
            WHEN LOWER(a.application_number) LIKE ? THEN 6
            WHEN LOWER(REPLACE(REPLACE(REPLACE(a.case_number, '/', ''), '-', ''), ' ', '')) LIKE ? THEN 7
            WHEN LOWER(REPLACE(REPLACE(REPLACE(a.application_number, '/', ''), '-', ''), ' ', '')) LIKE ? THEN 8
            ${isPureNumericId ? 'WHEN a.id = ? THEN 0' : ''}
            ELSE 99
          END
        LIMIT 1
      `;

      const lowerSearchValue = searchValue.toLowerCase();
      const searchParams = [];
      if (isPureNumericId) {
        searchParams.push(Number(searchValue));
      }
      searchParams.push(
        lowerSearchValue,
        lowerSearchValue,
        normalizedSearch,
        normalizedSearch,
        `%${lowerSearchValue}%`,
        `%${lowerSearchValue}%`,
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`
      );
      if (linkedClientId) {
        searchParams.push(linkedClientId);
      }
      searchParams.push(
        lowerSearchValue,
        lowerSearchValue,
        normalizedSearch,
        normalizedSearch,
        `%${lowerSearchValue}%`,
        `%${lowerSearchValue}%`,
        `%${normalizedSearch}%`,
        `%${normalizedSearch}%`
      );
      if (isPureNumericId) {
        searchParams.push(Number(searchValue));
      }

      const appointments = await db.query(appointmentSql, searchParams);

      if (!appointments || appointments.length === 0) {
        logger.warn('Appointment not found', { searchTerm, userId, linkedClientId });
        return null;
      }

      const appointment = appointments[0];
      const appointmentId = appointment.id;
      
      // Add assigned technician info from appointment_tests if available
      // The technician_name field is already set from the subquery
      
      // Clean up temporary field
      delete appointment.technician_code;

      // Fetch appointment status history with user details
      let history = [];
      try {
        const historySql = `
          SELECT 
            ah.*,
            u.username as changed_by_name,
            u.role_id as changed_by_role
          FROM appointment_status_history ah
          LEFT JOIN users u ON ah.changed_by = u.id
          WHERE ah.appointment_id = ?
          ORDER BY ah.created_at ASC
        `;
        history = await db.query(historySql, [appointmentId]);
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          logger.warn('appointment_status_history table not found, skipping history', { appointmentId });
        } else {
          throw err;
        }
      }

      // Fetch QC history with user details
      let qcHistory = [];
      try {
        const qcHistorySql = `
          SELECT 
            qh.*,
            u.username as qc_by_name,
            u.role_id as qc_by_role
          FROM appointment_qc_history qh
          LEFT JOIN users u ON qh.qc_by = u.id
          WHERE qh.appointment_id = ?
          ORDER BY qh.created_at ASC
        `;
        qcHistory = await db.query(qcHistorySql, [appointmentId]);
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          logger.warn('appointment_qc_history table not found, skipping QC history', { appointmentId });
        } else {
          throw err;
        }
      }

      // Fetch call logs if any
      const callLogsSql = `
        SELECT 
          cl.*
        FROM call_logs cl
        WHERE cl.appointment_id = ?
        ORDER BY cl.created_at DESC
        LIMIT 10
      `;
      const callLogs = await db.query(callLogsSql, [appointmentId]);

      // Fetch test assignments with technician details
      const testAssignmentsSql = `
        SELECT 
          at.id,
          at.test_id,
          at.category_id,
          at.assigned_technician_id,
          at.visit_subtype,
          at.status,
          at.is_completed,
          at.completion_remarks,
          at.rate_type,
          at.item_name,
          t.test_name,
          t.test_code,
          t.report_type as test_report_type,
          tc.category_name,
          tc.report_type as category_report_type,
          tech.full_name as technician_full_name,
          tech.technician_code as technician_code,
          tech.mobile as technician_mobile,
          tech.email as technician_email,
          tech.technician_type,
          tech.qualification,
          tech.experience_years
        FROM appointment_tests at
        LEFT JOIN tests t ON at.test_id = t.id
        LEFT JOIN test_categories tc ON at.category_id = tc.id
        LEFT JOIN technicians tech ON at.assigned_technician_id = tech.id
        WHERE at.appointment_id = ?
        ORDER BY at.created_at ASC
      `;
      const testAssignments = await db.query(testAssignmentsSql, [appointmentId]);

      // Fetch uploaded files/reports
      let reports = [];
      try {
        const reportsSql = `
          SELECT 
            id,
            appointment_id,
            file_path,
            file_name,
            file_size,
            uploaded_by,
            uploaded_at,
            is_deleted
          FROM appointment_reports
          WHERE appointment_id = ?
            AND is_deleted = 0
          ORDER BY uploaded_at DESC
        `;
        reports = await db.query(reportsSql, [appointmentId]);
      } catch (err) {
        if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE') {
          logger.warn('appointment_reports table not available or columns missing, skipping reports', { appointmentId });
        } else {
          throw err;
        }
      }

      // Build timeline events from history and QC logs
      const timeline = this._buildTimeline(history, qcHistory, appointment);

      // Calculate metrics
      const metrics = this._calculateMetrics(appointment, history, qcHistory, timeline);

      // Add PDF download options
      appointment.pdf_downloads = {
        invoice_pdf: {
          available: appointment.cost_type?.toLowerCase() !== 'credit' && appointment.cost_type !== null,
          download_url: appointment.cost_type?.toLowerCase() !== 'credit' && appointment.cost_type !== null ? `/api/appointments/${appointment.id}/proforma-invoice` : null
        },
        tpa_pdf: {
          available: false, // Will be updated below
          download_url: null,
          email_sent: false
        }
      };

      // Check TPA email status for TPA PDF availability
      if (appointment.client_id) {
        try {
          const emailLog = await db.query(
            `SELECT status, sent_at FROM tpa_email_log 
             WHERE appointment_id = ? AND client_id = ? AND status = 'sent' 
             AND is_deleted = 0 
             ORDER BY sent_at DESC 
             LIMIT 1`,
            [appointment.id, appointment.client_id]
          );
          
          if (emailLog.length > 0) {
            appointment.pdf_downloads.tpa_pdf = {
              available: true,
              download_url: `/api/appointments/${appointment.id}/tpa-pdf`,
              email_sent: true,
              email_sent_at: emailLog[0].sent_at
            };
          }
        } catch (error) {
          logger.error('Error checking TPA email status in lifecycle:', error);
          // Keep TPA PDF as unavailable if there's an error
        }
      }

      logger.info('Appointment lifecycle fetched successfully', { 
        appointmentId, 
        case_number: appointment.case_number,
        timelineEvents: timeline.length 
      });

      return {
        appointment,
        timeline,
        qcHistory,
        callLogs,
        reports,
        testAssignments,
        metrics
      };
    } catch (error) {
      logger.error('Error fetching appointment lifecycle', {
        searchTerm,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to fetch appointment lifecycle: ${error.message}`);
    }
  }

  /**
   * Build unified timeline from history and QC events
   * @private
   */
  _buildTimeline(history, qcHistory, appointment) {
    const events = [];
    const consumedQcIds = new Set();
    const qcActionForHistory = {
      qc_submit: 'submitted_for_qc',
      qc_partial_save: 'partial_save',
      qc_complete: 'completed',
      qc_push_back: 'pushed_back'
    };
    const toTime = (value) => new Date(value).getTime();
    const findMatchingQc = (historyRow) => {
      const action = qcActionForHistory[historyRow.change_type];
      if (!action) return null;
      const historyTime = toTime(historyRow.created_at);
      return qcHistory.find((qc) => (
        !consumedQcIds.has(qc.id) &&
        qc.action === action &&
        Math.abs(toTime(qc.created_at) - historyTime) <= 2000
      )) || null;
    };

    // Add creation event
    events.push({
      type: 'creation',
      timestamp: appointment.created_at,
      title: 'Appointment Created',
      description: `Case ${appointment.case_number} created`,
      icon: 'create',
      user: appointment.created_by_name || appointment.updated_by_name || null,
      metadata: {
        visit_type: appointment.visit_type,
        customer_category: appointment.customer_category
      }
    });

    // Add history events
    history.forEach(h => {
      const matchedQc = findMatchingQc(h);
      const parsedMetadata = this._parseMetadata(h.metadata);
      if (matchedQc) {
        consumedQcIds.add(matchedQc.id);
      }

      const event = {
        type: 'status_change',
        timestamp: h.created_at,
        change_type: h.change_type,
        title: this._getHistoryTitle(h),
        description: this._getHistoryDescription(h),
        icon: this._getHistoryIcon(h.change_type),
        user: h.changed_by_name,
        metadata: matchedQc ? {
          ...parsedMetadata,
          pathology_checked: matchedQc.pathology_checked,
          cardiology_checked: matchedQc.cardiology_checked,
          sonography_checked: matchedQc.sonography_checked,
          mer_checked: matchedQc.mer_checked,
          mtrf_checked: matchedQc.mtrf_checked,
          radiology_checked: matchedQc.radiology_checked,
          other_checked: matchedQc.other_checked
        } : parsedMetadata,
        old_status: h.old_status,
        new_status: h.new_status,
        old_medical_status: h.old_medical_status,
        new_medical_status: h.new_medical_status,
        remarks: h.remarks || matchedQc?.remarks || null
      };
      events.push(event);
    });

    // Add QC events
    qcHistory.forEach(qc => {
      if (consumedQcIds.has(qc.id)) return;
      const event = {
        type: 'qc_action',
        timestamp: qc.created_at,
        action: qc.action,
        title: this._getQCTitle(qc),
        description: this._getQCDescription(qc),
        icon: this._getQCIcon(qc.action),
        user: qc.qc_by_name,
        metadata: {
          pathology_checked: qc.pathology_checked,
          cardiology_checked: qc.cardiology_checked,
          sonography_checked: qc.sonography_checked,
          mer_checked: qc.mer_checked,
          mtrf_checked: qc.mtrf_checked,
          radiology_checked: qc.radiology_checked,
          other_checked: qc.other_checked
        },
        remarks: qc.remarks
      };
      events.push(event);
    });

    // Sort by timestamp
    events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return this._dedupeTimeline(events);
  }

  _dedupeTimeline(events) {
    const seen = new Set();
    return events.filter((event) => {
      if (event.type === 'creation') return true;
      const noRemarks = !event.remarks;
      const duplicateKey = [
        event.type,
        event.change_type || event.action || '',
        event.old_status || '',
        event.new_status || '',
        event.old_medical_status || '',
        event.new_medical_status || ''
      ].join('|');

      if (noRemarks && seen.has(duplicateKey)) {
        return false;
      }

      if (noRemarks) {
        seen.add(duplicateKey);
      }

      return true;
    });
  }

  _parseMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata !== 'string') return metadata;
    try {
      return JSON.parse(metadata);
    } catch (error) {
      logger.warn('Invalid appointment history metadata JSON', { error: error.message });
      return {};
    }
  }

  /**
   * Get human-readable title for history event
   * @private
   */
  _getHistoryTitle(history) {
    const titles = {
      'schedule_confirm': 'Schedule Confirmed',
      'schedule_reschedule': 'Appointment Rescheduled',
      'medical_status_update': 'Medical Status Updated',
      'qc_submit': 'Submitted for QC',
      'qc_partial_save': 'QC In Progress',
      'qc_complete': 'QC Completed',
      'qc_push_back': 'Pushed Back from QC',
      'assignment': 'Technician Assigned',
      'cancellation': 'Appointment Cancelled'
    };
    return titles[history.change_type] || 'Status Changed';
  }

  /**
   * Get description for history event
   * @private
   */
  _getHistoryDescription(history) {
    if (history.remarks) return history.remarks;
    
    if (history.new_medical_status && history.old_medical_status !== history.new_medical_status) {
      return `Medical status: ${history.old_medical_status || 'none'} → ${history.new_medical_status}`;
    }
    
    if (history.new_status && history.old_status !== history.new_status) {
      return `Status: ${history.old_status || 'none'} → ${history.new_status}`;
    }
    
    return 'Status updated';
  }

  /**
   * Get icon for history event type
   * @private
   */
  _getHistoryIcon(changeType) {
    const icons = {
      'schedule_confirm': 'calendar-check',
      'schedule_reschedule': 'calendar-edit',
      'medical_status_update': 'medical',
      'qc_submit': 'upload',
      'qc_partial_save': 'progress',
      'qc_complete': 'check-circle',
      'qc_push_back': 'arrow-left',
      'assignment': 'user-plus',
      'cancellation': 'x-circle'
    };
    return icons[changeType] || 'activity';
  }

  /**
   * Get title for QC event
   * @private
   */
  _getQCTitle(qc) {
    const titles = {
      'submitted_for_qc': 'Submitted for QC',
      'partial_save': 'QC Partial Save',
      'completed': 'QC Completed',
      'pushed_back': 'QC Pushed Back'
    };
    return titles[qc.action] || 'QC Action';
  }

  /**
   * Get description for QC event
   * @private
   */
  _getQCDescription(qc) {
    if (qc.remarks) return qc.remarks;

    const checkedReports = [];
    if (qc.pathology_checked) checkedReports.push('Pathology');
    if (qc.cardiology_checked) checkedReports.push('Cardiology');
    if (qc.sonography_checked) checkedReports.push('Sonography');
    if (qc.mer_checked) checkedReports.push('MER');
    if (qc.mtrf_checked) checkedReports.push('MTRF');
    if (qc.radiology_checked) checkedReports.push('Radiology');
    if (qc.other_checked) checkedReports.push('Other');

    if (checkedReports.length > 0) {
      return `Checked: ${checkedReports.join(', ')}`;
    }

    return 'QC action performed';
  }

  /**
   * Get icon for QC action
   * @private
   */
  _getQCIcon(action) {
    const icons = {
      'submitted_for_qc': 'upload',
      'partial_save': 'save',
      'completed': 'check-circle',
      'pushed_back': 'arrow-left'
    };
    return icons[action] || 'clipboard';
  }

  /**
   * Calculate metrics for the appointment
   * @private
   */
  _calculateMetrics(appointment, history, qcHistory, timeline = null) {
    const metrics = {
      total_events: Array.isArray(timeline) ? timeline.length : history.length + qcHistory.length,
      status_changes: history.filter(h => h.old_status !== h.new_status).length,
      medical_status_changes: history.filter(h => h.old_medical_status !== h.new_medical_status).length,
      qc_submissions: qcHistory.filter(q => q.action === 'submitted_for_qc').length,
      qc_pushbacks: qcHistory.filter(q => q.action === 'pushed_back').length,
      reschedules: history.filter(h => h.change_type === 'schedule_reschedule').length,
      current_status: appointment.status,
      current_medical_status: appointment.medical_status,
      current_qc_status: appointment.qc_status,
      visit_type: appointment.visit_type,
      split_type: appointment.split_type
    };

    // Calculate time metrics
    const createdAt = new Date(appointment.created_at);
    const now = new Date();
    metrics.age_days = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));

    if (appointment.medical_completed_at) {
      const completedAt = new Date(appointment.medical_completed_at);
      metrics.completion_days = Math.floor((completedAt - createdAt) / (1000 * 60 * 60 * 24));
    }

    return metrics;
  }
}

module.exports = new AppointmentLifecycleService();
