const db = require('../lib/dbconnection');
const logger = require('../lib/logger');
const { getStatusConditions, getAppointmentListDefinition } = require('./appointments/AppointmentFilterHelper');
const { hasPermission } = require('../lib/permissions');

class DashboardService {
  /**
   * Get sidebar counts for dashboard
   * @param {Object} user - User object from token
   * @returns {Promise<Object>} Object containing pushback and approval counts
   */
  async getSidebarCounts(user) {
    try {
      logger.info('Fetching sidebar counts', { 
        userId: user.id, 
        roleId: user.role_id, 
        centerId: user.diagnostic_center_id 
      });

      const counts = {
        pushback_appointments: 0,
        pending_approvals: 0
      };

      const { hasPermission } = require('../lib/permissions');
      const permissions = user.permissions || [];

      // Get pushback counts based on permissions
      if (hasPermission(permissions, 'appointments.view')) {
        if (user.diagnostic_center_id) {
          // Center user - only their center's pushbacks
          counts.pushback_appointments = await this.getCenterPushbackAppointmentsCount(user.diagnostic_center_id);
        } else {
          // Admin/TPA - all pushbacks
          counts.pushback_appointments = await this.getAllPushbackAppointmentsCount();
        }
      }

      // Get pending approval counts for users with approval permissions
      // Any user with approvals.view permission should see pending approvals
      if (hasPermission(permissions, 'approvals.view')) {
        counts.pending_approvals = await this.getPendingApprovalsCount();
      }

      logger.info('Sidebar counts fetched successfully', {
        userId: user.id,
        counts
      });

      return counts;
    } catch (error) {
      logger.error('Error fetching sidebar counts', {
        userId: user.id,
        error: error.message,
        stack: error.stack
      });
      throw new Error(`Failed to fetch sidebar counts: ${error.message}`);
    }
  }

  /**
   * Get count of all pushback appointments for admin
   * @returns {Promise<number>} Count of pushback appointments
   */
  async getAllPushbackAppointmentsCount() {
    try {
      const sql = `
        SELECT COUNT(*) as count 
        FROM appointments 
        WHERE pushed_back = 1 
        AND is_deleted = 0
      `;
           
      
      const [result] = await db.query(sql);

      return result.count || 0;
    } catch (error) {
      logger.error('Error getting all pushback appointments count', { error: error.message });
      throw error;
    }
  }

  /**
   * Get count of pushback appointments for specific center
   * @param {number} centerId - Diagnostic center ID
   * @returns {Promise<number>} Count of center pushback appointments
   */
  async getCenterPushbackAppointmentsCount(centerId) {
    try {
      const sql = `
        SELECT COUNT(*) as count 
        FROM appointments 
        WHERE pushed_back = 1 
        AND is_deleted = 0
        AND (center_id = ? OR other_center_id = ?)
      `;
 
      
      const [result] = await db.query(sql, [centerId, centerId]);

      return result.count || 0;
    } catch (error) {
      logger.error('Error getting center pushback appointments count', { 
        centerId, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Get count of pending approvals for super admin
   * @returns {Promise<number>} Count of pending approvals
   */
  async getPendingApprovalsCount() {
    try {
      // Count only the latest pending row per entity to avoid duplicates
      const sql = `
        SELECT COUNT(*) AS count FROM (
          SELECT 
            entity_type,
            COALESCE(entity_id, -1) AS entity_id_key,
            MAX(requested_at) AS max_requested_at
          FROM approval_queue
          WHERE status = 'pending'
          GROUP BY entity_type, COALESCE(entity_id, -1)
        ) latest_pending
      `;

      const [result] = await db.query(sql);

      return result.count || 0;
    } catch (error) {
      logger.error('Error getting pending approvals count', { error: error.message });
      throw error;
    }
  }

  /**
   * Build dynamic WHERE clause fragments and params based on user role/context
   */
  buildRoleFilter(user) {
    const where = ['is_deleted = 0', 'has_pending_approval = 0'];
    const params = [];

    // Center user filtering - consistent with appointments list logic
    if (user?.diagnostic_center_id) {
      where.push('(center_id = ? OR other_center_id = ?)');
      params.push(user.diagnostic_center_id, user.diagnostic_center_id);
    }
    if (user?.insurer_id) {
      where.push('insurer_id = ?');
      params.push(user.insurer_id);
    }
    if (user?.client_id) {
      where.push('client_id = ?');
      params.push(user.client_id);
    }
    if (user?.technician_id || user?.assigned_technician_id) {
      const techId = user.technician_id || user.assigned_technician_id;
      where.push('assigned_technician_id = ?');
      params.push(techId);
    }

    return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  /**
   * Get dashboard stats with month-over-month comparison
   */
  async getDashboardStats(user) {
    const { whereSql, params } = this.buildRoleFilter(user);

    const baseWhere = whereSql ? `${whereSql}` : 'WHERE is_deleted = 0 AND has_pending_approval = 0';
    const hasQcAccess = hasPermission(user?.permissions || [], 'appointments.qc');
    const confirmedScheduledDefinition = user?.diagnostic_center_id
      ? getAppointmentListDefinition('confirmed-scheduled', 'appointments')
      : { conditions: getStatusConditions('confirmed', 'appointments'), params: [] };
    const qcPendingDefinition = hasQcAccess
      ? { conditions: getStatusConditions('qc_pending', 'appointments'), params: [] }
      : getAppointmentListDefinition('report-upload', 'appointments');

    const monthFilters = {
      current: 'YEAR(appointment_date) = YEAR(CURDATE()) AND MONTH(appointment_date) = MONTH(CURDATE())',
      previous: 'YEAR(appointment_date) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(appointment_date) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))'
    };

    const buckets = [
      { key: 'totalAppointments', condition: '1=1', dateExpr: 'appointment_date' },
      {
        key: 'confirmedScheduled',
        condition: confirmedScheduledDefinition.conditions.join(' AND '),
        params: confirmedScheduledDefinition.params,
        dateExpr: 'COALESCE(home_confirmed_at, center_confirmed_at, confirmed_date, appointment_date)'
      },
      {
        key: 'qcPending',
        condition: qcPendingDefinition.conditions.join(' AND '),
        params: qcPendingDefinition.params,
        dateExpr: 'appointment_date'
      },
      {
        key: 'completed',
        condition: "status = 'completed'",
        dateExpr: 'appointment_date'
      },
      {
        key: 'today',
        condition: '1=1',
        dateExpr: 'appointment_date'
      },
      {
        key: 'todayMedicalDone',
        condition: `(
          medical_status IN ('completed', 'complete')
          OR center_medical_status IN ('completed', 'complete')
          OR home_medical_status IN ('completed', 'complete')
        )`,
        dateExpr: 'appointment_date'
      },
      {
        key: 'tomorrow',
        condition: '1=1',
        dateExpr: 'appointment_date'
      },
      {
        key: 'upcoming',
        condition: '1=1',
        dateExpr: 'appointment_date'
      },
    ];

    const results = {};

    for (const bucket of buckets) {
      const dateExpr = bucket.dateExpr || 'appointment_date';
      let sql, total, currentMonth, previousMonth;
      
      // Special handling for date-based buckets - use same logic as appointments list
      if (['today', 'todayMedicalDone', 'tomorrow', 'upcoming'].includes(bucket.key)) {
        switch (bucket.key) {
          case 'today':
          case 'todayMedicalDone':
            // For appointment_date, use timezone-aware logic like appointments list
            if (dateExpr === 'appointment_date') {
              sql = `
                SELECT
                  COUNT(*) AS totalCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(CURDATE()) AND MONTH(${dateExpr}) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS currentMonthCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(${dateExpr}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN 1 ELSE 0 END) AS prevMonthCount
                FROM appointments
                ${baseWhere} AND ${bucket.condition} AND DATE(CONVERT_TZ(${dateExpr}, '+00:00', @@global.time_zone)) = DATE(CURDATE())
              `;
            } else {
              sql = `
                SELECT
                  COUNT(*) AS totalCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(CURDATE()) AND MONTH(${dateExpr}) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS currentMonthCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(${dateExpr}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN 1 ELSE 0 END) AS prevMonthCount
                FROM appointments
                ${baseWhere} AND ${bucket.condition} AND DATE(${dateExpr}) = CURDATE()
              `;
            }
            break;
          case 'tomorrow':
            if (dateExpr === 'appointment_date') {
              sql = `
                SELECT
                  COUNT(*) AS totalCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(CURDATE()) AND MONTH(${dateExpr}) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS currentMonthCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(${dateExpr}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN 1 ELSE 0 END) AS prevMonthCount
                FROM appointments
                ${baseWhere} AND ${bucket.condition} AND DATE(CONVERT_TZ(${dateExpr}, '+00:00', @@global.time_zone)) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
              `;
            } else {
              sql = `
                SELECT
                  COUNT(*) AS totalCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(CURDATE()) AND MONTH(${dateExpr}) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS currentMonthCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(${dateExpr}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN 1 ELSE 0 END) AS prevMonthCount
                FROM appointments
                ${baseWhere} AND ${bucket.condition} AND DATE(${dateExpr}) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
              `;
            }
            break;
          case 'upcoming':
            if (dateExpr === 'appointment_date') {
              sql = `
                SELECT
                  COUNT(*) AS totalCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(CURDATE()) AND MONTH(${dateExpr}) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS currentMonthCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(${dateExpr}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN 1 ELSE 0 END) AS prevMonthCount
                FROM appointments
                ${baseWhere} AND ${bucket.condition} AND DATE(CONVERT_TZ(${dateExpr}, '+00:00', @@global.time_zone)) > DATE(CURDATE())
              `;
            } else {
              sql = `
                SELECT
                  COUNT(*) AS totalCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(CURDATE()) AND MONTH(${dateExpr}) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS currentMonthCount,
                  SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(${dateExpr}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN 1 ELSE 0 END) AS prevMonthCount
                FROM appointments
                ${baseWhere} AND ${bucket.condition} AND DATE(${dateExpr}) > CURDATE()
              `;
            }
            break;
        }
      } else {
        // Standard query for other buckets
        sql = `
          SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(CURDATE()) AND MONTH(${dateExpr}) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS currentMonthCount,
            SUM(CASE WHEN YEAR(${dateExpr}) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(${dateExpr}) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN 1 ELSE 0 END) AS prevMonthCount
          FROM appointments
          ${baseWhere} AND ${bucket.condition}
        `;
      }

      const [row] = await db.query(sql, [...params, ...(bucket.params || [])]);
      total = Number(row.totalCount) || 0;
      currentMonth = Number(row.currentMonthCount) || 0;
      previousMonth = Number(row.prevMonthCount) || 0;
      const growth = previousMonth === 0
        ? (currentMonth > 0 ? 100 : null)
        : ((currentMonth - previousMonth) / previousMonth) * 100;

      results[bucket.key] = {
        total,
        currentMonth,
        previousMonth,
        growth,
      };
    }

    logger.info('Dashboard stats fetched', { userId: user?.id, results });
    return results;
  }

  /**
   * Get dashboard analytics with center/TPA (client) breakdowns and optional month filter
   */
  async getDashboardAnalytics(user, month = null) {
    try {
      const { whereSql, params } = this.buildRoleFilter(user);
      const aliasReplace = (clause) => clause
        .replace(/\bis_deleted\b/g, 'a.is_deleted')
        .replace(/\bhas_pending_approval\b/g, 'a.has_pending_approval')
        .replace(/\bcenter_id\b/g, 'a.center_id')
        .replace(/\bother_center_id\b/g, 'a.other_center_id')
        .replace(/\binsurer_id\b/g, 'a.insurer_id')
        .replace(/\bclient_id\b/g, 'a.client_id')
        .replace(/\bassigned_technician_id\b/g, 'a.assigned_technician_id');

      const appointmentsFilter = whereSql ? aliasReplace(whereSql).replace('WHERE', 'AND') : 'AND a.is_deleted = 0';

      let monthFilter = '';
      const monthParams = [];
      if (month) {
        const [year, monthNum] = month.split('-');
        monthFilter = ` AND YEAR(a.appointment_date) = ? AND MONTH(a.appointment_date) = ?`;
        monthParams.push(parseInt(year, 10), parseInt(monthNum, 10));
      }

      const queryParams = [...params, ...monthParams];

      // Center-wise breakdown
      const centerSql = `
        SELECT 
          dc.id AS center_id,
          dc.center_name,
          dc.center_code,
          COUNT(DISTINCT a.id) AS total_appointments,
          SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed_appointments,
          SUM(CASE WHEN a.customer_category = 'HNI' THEN 1 ELSE 0 END) AS hni_appointments,
          SUM(CASE WHEN a.customer_category = 'SUPER_HNI' THEN 1 ELSE 0 END) AS super_hni_appointments
        FROM diagnostic_centers dc
        LEFT JOIN appointments a ON (a.center_id = dc.id OR a.other_center_id = dc.id)
          ${appointmentsFilter} ${monthFilter}
        WHERE dc.is_deleted = 0
        GROUP BY dc.id, dc.center_name, dc.center_code
        ORDER BY total_appointments DESC
      `;

      const centerResults = await db.query(centerSql, queryParams);

      // Client-wise (TPA) breakdown
      const tpaSql = `
        SELECT 
          c.id AS client_id,
          c.client_name,
          COUNT(DISTINCT a.id) AS total_appointments,
          SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) AS completed_appointments,
          SUM(CASE WHEN a.customer_category = 'HNI' THEN 1 ELSE 0 END) AS hni_appointments,
          SUM(CASE WHEN a.customer_category = 'SUPER_HNI' THEN 1 ELSE 0 END) AS super_hni_appointments
        FROM clients c
        LEFT JOIN appointments a ON a.client_id = c.id
          ${appointmentsFilter} ${monthFilter}
        WHERE c.is_deleted = 0
        GROUP BY c.id, c.client_name
        ORDER BY total_appointments DESC
      `;

      const tpaResults = await db.query(tpaSql, queryParams);

      const analytics = {
        centers: centerResults.map(row => ({
          center_id: row.center_id,
          center_name: row.center_name,
          center_code: row.center_code,
          total_appointments: Number(row.total_appointments) || 0,
          completed_appointments: Number(row.completed_appointments) || 0,
          hni_appointments: Number(row.hni_appointments) || 0,
          super_hni_appointments: Number(row.super_hni_appointments) || 0,
        })),
        tpas: tpaResults.map(row => ({
          client_id: row.client_id,
          client_name: row.client_name,
          total_appointments: Number(row.total_appointments) || 0,
          completed_appointments: Number(row.completed_appointments) || 0,
          hni_appointments: Number(row.hni_appointments) || 0,
          super_hni_appointments: Number(row.super_hni_appointments) || 0,
        })),
      };

      logger.info('Dashboard analytics fetched', { userId: user?.id, analytics });
      return analytics;
    } catch (error) {
      logger.error('Error fetching dashboard analytics', { 
        userId: user?.id, 
        error: error.message, 
        stack: error.stack 
      });
      throw new Error(`Failed to fetch dashboard analytics: ${error.message}`);
    }
  }
}

// Initialize service instance
const dashboardService = new DashboardService();

module.exports = {
  DashboardService,
  getSidebarCounts: dashboardService.getSidebarCounts.bind(dashboardService),
  getDashboardStats: dashboardService.getDashboardStats.bind(dashboardService),
  getDashboardAnalytics: dashboardService.getDashboardAnalytics.bind(dashboardService)
};
