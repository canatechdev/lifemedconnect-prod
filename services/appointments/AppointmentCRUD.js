/**
 * Appointment CRUD Operations
 * Handles Create, Read, Update, Delete operations for appointments
 */

const db = require('../../lib/dbconnection');
const { generateCustomCode } = require('../../lib/generateCode');
const logger = require('../../lib/logger');

/**
 * Helper function to build date filter conditions
 * Supports multiple date fields and range types
 * @param {string} dateField - 'created_at', 'appointment_date', or 'confirmed_date'
 * @param {string} rangeType - 'today', 'tomorrow', 'upcoming', 'custom', 'monthly', 'yearly'
 * @param {object} dateParams - { fromDate, toDate, month, year }
 * @returns {object} { conditions: [], params: [] }
 */
function buildDateFilter(dateField = 'created_at', rangeType = '', dateParams = {}, tableAlias = 'appointments') {
    const conditions = [];
    const params = [];
    
    if (!rangeType || rangeType === '') {
        return { conditions, params };
    }

    // Use local timezone for date calculations, not UTC
    const today = new Date();
    const localToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const localTomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    
    // Format dates as YYYY-MM-DD strings in local timezone
    const todayString = localToday.getFullYear() + '-' + 
        String(localToday.getMonth() + 1).padStart(2, '0') + '-' + 
        String(localToday.getDate()).padStart(2, '0');
    const tomorrowString = localTomorrow.getFullYear() + '-' + 
        String(localTomorrow.getMonth() + 1).padStart(2, '0') + '-' + 
        String(localTomorrow.getDate()).padStart(2, '0');

    let dateColumn = `${tableAlias}.created_at`;
    
    if (dateField === 'appointment_date') {
        dateColumn = `${tableAlias}.appointment_date`;
    } else if (dateField === 'confirmed_date') {
        // For confirmed_date, check both confirmed_date and center/home confirmed timestamps
        // This will be handled specially below
    }

    switch (rangeType) {
        case 'today':
            if (dateField === 'confirmed_date') {
                conditions.push(`(DATE(${tableAlias}.confirmed_date) = DATE(?) OR DATE(${tableAlias}.center_confirmed_at) = DATE(?) OR DATE(${tableAlias}.home_confirmed_at) = DATE(?))`);
                params.push(todayString, todayString, todayString);
            } else {
                // Use UTC date functions for appointment_date to avoid timezone issues
                if (dateField === 'appointment_date') {
                    conditions.push(`DATE(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = DATE(?)`);
                } else {
                    conditions.push(`DATE(${dateColumn}) = DATE(?)`);
                }
                params.push(todayString);
            }
            break;

        case 'tomorrow':
            if (dateField === 'confirmed_date') {
                conditions.push(`(DATE(${tableAlias}.confirmed_date) = DATE(?) OR DATE(${tableAlias}.center_confirmed_at) = DATE(?) OR DATE(${tableAlias}.home_confirmed_at) = DATE(?))`);
                params.push(tomorrowString, tomorrowString, tomorrowString);
            } else {
                if (dateField === 'appointment_date') {
                    conditions.push(`DATE(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = DATE(?)`);
                } else {
                    conditions.push(`DATE(${dateColumn}) = DATE(?)`);
                }
                params.push(tomorrowString);
            }
            break;

        case 'upcoming':
            if (dateField === 'confirmed_date') {
                conditions.push(`(DATE(${tableAlias}.confirmed_date) > DATE(?) OR DATE(${tableAlias}.center_confirmed_at) > DATE(?) OR DATE(${tableAlias}.home_confirmed_at) > DATE(?))`);
                params.push(todayString, todayString, todayString);
            } else {
                if (dateField === 'appointment_date') {
                    conditions.push(`DATE(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) > DATE(?)`);
                } else {
                    conditions.push(`DATE(${dateColumn}) > DATE(?)`);
                }
                params.push(todayString);
            }
            break;

        case 'custom':
            if (dateParams.fromDate && dateParams.toDate) {
                if (dateField === 'confirmed_date') {
                    conditions.push(`(DATE(${tableAlias}.confirmed_date) BETWEEN DATE(?) AND DATE(?) OR DATE(${tableAlias}.center_confirmed_at) BETWEEN DATE(?) AND DATE(?) OR DATE(${tableAlias}.home_confirmed_at) BETWEEN DATE(?) AND DATE(?))`);
                    params.push(dateParams.fromDate, dateParams.toDate, dateParams.fromDate, dateParams.toDate, dateParams.fromDate, dateParams.toDate);
                } else {
                    if (dateField === 'appointment_date') {
                        conditions.push(`DATE(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) BETWEEN DATE(?) AND DATE(?)`);
                    } else {
                        conditions.push(`DATE(${dateColumn}) BETWEEN DATE(?) AND DATE(?)`);
                    }
                    params.push(dateParams.fromDate, dateParams.toDate);
                }
            }
            break;

        case 'monthly':
            if (dateParams.month) {
                if (dateField === 'confirmed_date') {
                    if (dateParams.year) {
                        conditions.push(`(MONTH(${tableAlias}.confirmed_date) = ? AND YEAR(${tableAlias}.confirmed_date) = ?) OR (MONTH(${tableAlias}.center_confirmed_at) = ? AND YEAR(${tableAlias}.center_confirmed_at) = ?) OR (MONTH(${tableAlias}.home_confirmed_at) = ? AND YEAR(${tableAlias}.home_confirmed_at) = ?)`);
                        params.push(parseInt(dateParams.month), parseInt(dateParams.year), parseInt(dateParams.month), parseInt(dateParams.year), parseInt(dateParams.month), parseInt(dateParams.year));
                    } else {
                        conditions.push(`(MONTH(${tableAlias}.confirmed_date) = ?) OR (MONTH(${tableAlias}.center_confirmed_at) = ?) OR (MONTH(${tableAlias}.home_confirmed_at) = ?)`);
                        params.push(parseInt(dateParams.month), parseInt(dateParams.month), parseInt(dateParams.month));
                    }
                } else {
                    if (dateField === 'appointment_date') {
                        if (dateParams.year) {
                            conditions.push(`(MONTH(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = ? AND YEAR(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = ?)`);
                            params.push(parseInt(dateParams.month), parseInt(dateParams.year));
                        } else {
                            conditions.push(`MONTH(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = ?`);
                            params.push(parseInt(dateParams.month));
                        }
                    } else {
                        if (dateParams.year) {
                            conditions.push(`(MONTH(${dateColumn}) = ? AND YEAR(${dateColumn}) = ?)`);
                            params.push(parseInt(dateParams.month), parseInt(dateParams.year));
                        } else {
                            conditions.push(`MONTH(${dateColumn}) = ?`);
                            params.push(parseInt(dateParams.month));
                        }
                    }
                }
            }
            break;

        case 'yearly':
            if (dateParams.year) {
                if (dateField === 'confirmed_date') {
                    conditions.push(`(YEAR(${tableAlias}.confirmed_date) = ? OR YEAR(${tableAlias}.center_confirmed_at) = ? OR YEAR(${tableAlias}.home_confirmed_at) = ?)`);
                    params.push(parseInt(dateParams.year), parseInt(dateParams.year), parseInt(dateParams.year));
                } else {
                    if (dateField === 'appointment_date') {
                        conditions.push(`YEAR(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = ?`);
                    } else {
                        conditions.push(`YEAR(${dateColumn}) = ?`);
                    }
                    params.push(parseInt(dateParams.year));
                }
            }
            break;
    }

    return { conditions, params };
}

/**
 * Safe value handler - returns null for undefined/null/empty values
 */
const safe = (value) => {
    return value === undefined || value === null || value === '' ? null : value;
};

/**
 * Update appointment status based on test completion
 */
async function updateAppointmentStatus(appointmentId) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();
        
        // Get current status before update
        const [current] = await connection.query(
            'SELECT status, medical_status FROM appointments WHERE id = ?',
            [appointmentId]
        );
        
        const [stats] = await connection.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as completed
            FROM appointment_tests 
            WHERE appointment_id = ?
        `, [appointmentId]);

        const { total, completed } = stats;
        let newStatus = 'pending';

        if (completed === total && total > 0) {
            newStatus = 'completed';
        } else if (completed > 0) {
            newStatus = 'partially_completed';
        }

        await connection.query(
            'UPDATE appointments SET status = ?, updated_at = NOW() WHERE id = ?',
            [newStatus, appointmentId]
        );
        
        // Log status history
        const { logStatusHistory } = require('./AppointmentFlow');
        await logStatusHistory(appointmentId, {
            old_status: current[0]?.status || null,
            new_status: newStatus,
            old_medical_status: current[0]?.medical_status || null,
            new_medical_status: current[0]?.medical_status || null,
            changed_by: 1, // System update
            change_type: 'auto_status_update',
            remarks: `Status automatically updated based on test completion: ${completed}/${total} tests completed`,
            metadata: { total_tests: total, completed_tests: completed }
        }, connection);
        
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Create new appointment with tests
 */
async function createAppointment(row, connection = null) {
    const useOwnConnection = !connection;
    const conn = connection || await db.pool.getConnection();

    try {
        if (useOwnConnection) {
            await conn.beginTransaction();
        }

        // check duplicate app no
        if (row.application_number) {
            const [existing] = await conn.query(
                `SELECT id FROM appointments 
             WHERE application_number = ? AND is_deleted = 0 
             LIMIT 1`,
                [row.application_number]
            );

            if (existing && existing.length > 0) {
                throw new Error('An active appointment already exists with this application number.');
            }
        }

        // Generate case number if not provided
        if (!row.case_number) {
            row.case_number = await generateCustomCode({
                prefix: 'CASE',
                table: 'appointments',
                column: 'case_number'
            });
        }

        // Enforce amount = 0 when cost type is Credit
        if (row.cost_type && String(row.cost_type).toLowerCase() === 'credit') {
            row.amount = 0;
        }

        const appointmentSql = `
            INSERT INTO appointments (
                case_number, application_number, client_id, center_id, other_center_id, insurer_id,
                customer_first_name, customer_last_name, gender, customer_mobile, customer_alt_mobile, customer_service_no,
                customer_email, customer_address, state, city, pincode, country,
                customer_gps_latitude, customer_gps_longitude, customer_landmark,
                visit_type, customer_category, appointment_date, appointment_time, confirmed_time,
                status, assigned_technician_id, assigned_at, assigned_by,
                customer_arrived_at, medical_started_at, medical_completed_at,
                remarks, cancellation_reason, created_by,
                cost_type, amount, amount_upload, case_severity,
                created_at, updated_at, is_active, split_type
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1, 'none'
            )
        `;

        // Normalize initial main status to a small, lowercase set: pending | in_process | completed
        let initialStatus = (row.status || '').toString().toLowerCase();
        if (!['pending', 'in_process', 'completed'].includes(initialStatus)) {
            initialStatus = 'pending';
        }

        const appointmentParams = [
            safe(row.case_number), safe(row.application_number), safe(row.client_id),
            safe(row.center_id), safe(row.other_center_id), safe(row.insurer_id),
            safe(row.customer_first_name), safe(row.customer_last_name), safe(row.gender),
            safe(row.customer_mobile), safe(row.customer_alt_mobile), safe(row.customer_service_no), safe(row.customer_email),
            safe(row.customer_address), safe(row.state), safe(row.city), safe(row.pincode),
            safe(row.country), safe(row.customer_gps_latitude), safe(row.customer_gps_longitude),
            safe(row.customer_landmark), safe(row.visit_type), safe(row.customer_category),
            safe(row.appointment_date), safe(row.appointment_time), safe(row.confirmed_time),
            safe(initialStatus), safe(row.assigned_technician_id),
            safe(row.assigned_at), safe(row.assigned_by), safe(row.customer_arrived_at),
            safe(row.medical_started_at), safe(row.medical_completed_at), safe(row.remarks),
            safe(row.cancellation_reason), safe(row.created_by), safe(row.cost_type),
            safe(row.amount), safe(row.amount_upload), safe(row.case_severity ?? 0)
        ];

        const [appointmentResult] = await conn.query(appointmentSql, appointmentParams);
        const appointmentId = appointmentResult.insertId;

        if (!appointmentId || typeof appointmentId !== 'number') {
            throw new Error('Failed to retrieve valid appointment ID');
        }

        // Insert tests
        if (row.selected_items && Array.isArray(row.selected_items)) {
            const testSql = `
                INSERT INTO appointment_tests (
                    appointment_id, test_id, category_id, rate_type, item_name, rate,
                    assigned_center_id, assigned_technician_id, visit_subtype, status,
                    is_completed, created_at, updated_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NOW(), ?)
            `;

            for (const item of row.selected_items) {
                let assignedCenterId = null;

                if (item.assigned_center_id) {
                    assignedCenterId = item.assigned_center_id;
                } else if (item.assigned_to === 'center2' && row.other_center_id) {
                    assignedCenterId = row.other_center_id;
                } else {
                    assignedCenterId = row.center_id;
                }

                const visitSubtype = normalizeVisitSubtypeForAppointment(
                    row.visit_type,
                    item.assigned_technician_id ? 'home' : item.visit_subtype
                );
                const assignedTechnicianId = visitSubtype === 'center' ? null : (item.assigned_technician_id || null);

                const testParams = [
                    appointmentId,
                    item.type === 'test' ? item.id : null,
                    item.type === 'category' ? item.id : null,
                    item.type,
                    item.name,
                    item.rate,
                    assignedCenterId,
                    assignedTechnicianId,
                    visitSubtype,
                    row.created_by
                ];
                await conn.query(testSql, testParams);
            }
        }

        // Update split_type if needed
        if (row.visit_type === 'Both' && row.other_center_id) {
            await conn.query(
                `UPDATE appointments SET split_type = 'split' WHERE id = ?`,
                [appointmentId]
            );
        }

        if (useOwnConnection) {
            await conn.commit();
        }
        return appointmentId;
    } catch (error) {
        if (useOwnConnection) {
            await conn.rollback();
        }
        logger.error('createAppointment error:', error);
        throw error;
    } finally {
        if (useOwnConnection) {
            conn.release();
        }
    }
}

/**
 * Clone an appointment into a fresh pending case.
 * Copies appointment details and test assignments, but not workflow history,
 * reports, documents, images, or completion state.
 */
async function cloneAppointment(sourceAppointmentId, userId = null) {
    const connection = await db.pool.getConnection();

    try {
        await connection.beginTransaction();

        const [sourceRows] = await connection.query(
            `SELECT * FROM appointments WHERE id = ? AND is_deleted = 0 LIMIT 1`,
            [sourceAppointmentId]
        );

        if (!sourceRows || sourceRows.length === 0) {
            throw new Error('Appointment not found');
        }

        const source = sourceRows[0];
        const newCaseNumber = await generateCustomCode({
            prefix: 'CASE',
            table: 'appointments',
            column: 'case_number'
        });

        const createdBy = userId || source.created_by || null;
        const assignedAt = source.assigned_technician_id ? new Date() : null;
        const assignedBy = source.assigned_technician_id ? createdBy : null;
        const splitType = source.visit_type === 'Both' && source.other_center_id ? 'split' : 'none';

        const insertAppointmentSql = `
            INSERT INTO appointments (
                case_number, application_number, client_id, center_id, other_center_id, insurer_id,
                customer_first_name, customer_last_name, gender, customer_mobile, customer_alt_mobile, customer_service_no,
                customer_email, customer_address, state, city, pincode, country,
                customer_gps_latitude, customer_gps_longitude, customer_landmark,
                visit_type, customer_category, appointment_date, confirmed_date, appointment_time, confirmed_time,
                status, assigned_technician_id, assigned_at, assigned_by,
                customer_arrived_at, medical_started_at, medical_completed_at,
                remarks, cancellation_reason, created_by, created_at, updated_at, is_deleted,
                has_pending_approval, test_name, cost_type, amount, amount_upload, case_severity,
                updated_by, is_active, split_type, medical_status, qc_status, medical_remarks,
                pending_report_types, aadhaar_number, pan_number, arrival_time, medical_start_time, medical_end_time,
                pushed_back, pushback_remarks, pushed_back_by, pushed_back_at,
                center_confirmed_at, home_confirmed_at, center_arrived_at, home_arrived_at,
                center_medical_status, home_medical_status, center_completed_at, home_completed_at,
                center_pushed_back, home_pushed_back, center_pushback_remarks, home_pushback_remarks,
                center_reschedule_remark, home_reschedule_remark, reschedule_remark,
                last_call_attempt_at, total_call_attempts
            )
            VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL,
                'pending', ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, NOW(), NOW(), 0,
                0, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL,
                0, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL,
                0, 0, NULL, NULL,
                NULL, NULL, NULL,
                NULL, 0
            )
        `;

        const [appointmentResult] = await connection.query(insertAppointmentSql, [
            newCaseNumber,
            safe(source.application_number),
            safe(source.client_id),
            safe(source.center_id),
            safe(source.other_center_id),
            safe(source.insurer_id),
            safe(source.customer_first_name),
            safe(source.customer_last_name),
            safe(source.gender),
            safe(source.customer_mobile),
            safe(source.customer_alt_mobile),
            safe(source.customer_service_no),
            safe(source.customer_email),
            safe(source.customer_address),
            safe(source.state),
            safe(source.city),
            safe(source.pincode),
            safe(source.country),
            safe(source.customer_gps_latitude),
            safe(source.customer_gps_longitude),
            safe(source.customer_landmark),
            safe(source.visit_type),
            safe(source.customer_category),
            safe(source.appointment_date),
            safe(source.appointment_time),
            safe(source.assigned_technician_id),
            assignedAt,
            assignedBy,
            safe(source.remarks),
            createdBy,
            safe(source.cost_type),
            safe(source.amount),
            safe(source.amount_upload),
            safe(source.case_severity ?? 0),
            userId || null,
            safe(source.is_active ?? 1),
            splitType
        ]);

        const newAppointmentId = appointmentResult.insertId;
        if (!newAppointmentId || typeof newAppointmentId !== 'number') {
            throw new Error('Failed to create cloned appointment');
        }

        const [testsResult] = await connection.query(
            `INSERT INTO appointment_tests (
                appointment_id, test_id, category_id, rate, assigned_center_id,
                assigned_technician_id, visit_subtype, status, invoice_upload, updated_by,
                is_completed, completion_remarks, created_at, rate_type, item_name, updated_at
            )
            SELECT
                ?, test_id, category_id, rate, assigned_center_id,
                assigned_technician_id, visit_subtype, 'pending', NULL, ?,
                0, NULL, NOW(), rate_type, item_name, NOW()
            FROM appointment_tests
            WHERE appointment_id = ?`,
            [newAppointmentId, userId || null, sourceAppointmentId]
        );

        await connection.commit();

        return {
            id: newAppointmentId,
            case_number: newCaseNumber,
            application_number: source.application_number,
            cloned_from_id: sourceAppointmentId,
            tests_cloned: testsResult.affectedRows || 0
        };
    } catch (error) {
        await connection.rollback();
        logger.error('cloneAppointment error:', {
            sourceAppointmentId,
            userId,
            error: error.message
        });
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * List appointments with pagination and search
 */
async function listAppointments({ page = 1, limit = 0, search = '', sortBy = 'id', sortOrder = 'DESC', customerCategory = '', month = '', year = '', visitType = '', status = '', medicalStatus = '', qcStatus = '', userId = null, userRole = null, dateField = 'created_at', rangeType = '', fromDate = '', toDate = '', centerIds = [], listType = 'all' }) {
    const searchColumns = ['case_number', 'application_number', 'customer_first_name', 'customer_last_name', 'customer_mobile', 'customer_email', 'home_center.center_name', 'other_center.center_name', 'clients.client_name', 'insurers.insurer_name'];
    const searchParams = [];
    const conditions = [];

    if (listType && listType !== 'all') {
        const { getAppointmentListDefinition } = require('./AppointmentFilterHelper');
        const listDefinition = getAppointmentListDefinition(listType, 'appointments');
        conditions.push(...listDefinition.conditions);
        searchParams.push(...listDefinition.params);
    }

    if (search && search.trim() !== '') {
        const searchConditions = [
            'appointments.case_number LIKE ?',
            'appointments.application_number LIKE ?',
            'appointments.customer_first_name LIKE ?',
            'appointments.customer_last_name LIKE ?',
            'appointments.customer_mobile LIKE ?',
            'appointments.customer_email LIKE ?',
            'home_center.center_name LIKE ?',
            'other_center.center_name LIKE ?',
            'clients.client_name LIKE ?',
            'insurers.insurer_name LIKE ?'
        ].join(' OR ');
        conditions.push(`(${searchConditions})`);
        // Add search parameters for each condition
        for (let i = 0; i < 10; i++) {
            searchParams.push(`%${search}%`);
        }
    }

    if (customerCategory && customerCategory !== '') {
        conditions.push('appointments.customer_category = ?');
        searchParams.push(customerCategory);
    }

    // Clean Date Filtering: Only use dateField + rangeType (no legacy filters)
    if (rangeType && rangeType !== '') {
        const dateFilterParams = {
            month: month || '',
            year: year || '',
            fromDate: fromDate || '',
            toDate: toDate || ''
        };
        const dateFilter = buildDateFilter(dateField, rangeType, dateFilterParams);
        conditions.push(...dateFilter.conditions);
        searchParams.push(...dateFilter.params);
    }
    // Note: Legacy month/year filtering completely removed to avoid conflicts

    // Additional filters
    if (visitType && visitType !== '') {
        conditions.push('appointments.visit_type = ?');
        searchParams.push(visitType);
    }

    if (status && status !== '') {
        conditions.push('appointments.status = ?');
        searchParams.push(status);
    }

    if (medicalStatus && medicalStatus !== '') {
        // Protected: if listType is 'report-upload', ignore the medicalStatus parameter
        if (listType !== 'report-upload') {
            // Handle comma-separated medical status values
            const medicalStatuses = medicalStatus.split(',').map(s => s.trim()).filter(s => s);
            if (medicalStatuses.length > 0) {
                const placeholders = medicalStatuses.map(() => '?').join(',');
                conditions.push(`(appointments.medical_status IN (${placeholders}) OR appointments.center_medical_status IN (${placeholders}) OR appointments.home_medical_status IN (${placeholders}))`);
                searchParams.push(...medicalStatuses, ...medicalStatuses, ...medicalStatuses);
            }
        }
    }

    if (qcStatus && qcStatus !== '') {
        conditions.push('appointments.qc_status = ?');
        searchParams.push(qcStatus);
    }

    // Diagnostic Center Filtering: Filter by center_id OR other_center_id (multiple centers support)
    if (centerIds && centerIds.length > 0) {
        const centerIdsInt = centerIds.map(id => parseInt(id)).filter(id => !isNaN(id));
        if (centerIdsInt.length > 0) {
            // Create placeholders for IN clause
            const placeholders = centerIdsInt.map(() => '?').join(',');
            conditions.push(`(appointments.center_id IN (${placeholders}) OR appointments.other_center_id IN (${placeholders}))`);
            searchParams.push(...centerIdsInt, ...centerIdsInt);
        }
    }

    // TPA User Filtering: If user is TPA role, show only their assigned TPA's appointments
    // Check both string role name and role_id for flexibility
    const isTpaRole = userRole === 2 || (typeof userRole === 'string' && userRole.toLowerCase().includes('tpa'));
    
    if (userId && isTpaRole) {
        conditions.push(`appointments.client_id IN (
            SELECT c.id FROM clients c WHERE c.user_id = ?
        )`);
        searchParams.push(userId);
        
        logger.info('TPA user filtering applied', {
            userId,
            userRole,
            filterType: 'TPA assignment'
        });
    }

    // Always filter out deleted and pending approval appointments
    conditions.push('appointments.is_deleted = 0');
    conditions.push('appointments.has_pending_approval = 0');

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const allowedSortColumns = [
        'id', 'case_number', 'application_number', 'customer_first_name',
        'customer_last_name', 'customer_mobile', 'appointment_date',
        'visit_type', 'status', 'created_at'
    ];
    const validSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'id';
    const validSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const countSql = `SELECT COUNT(DISTINCT appointments.id) as total FROM appointments 
                    LEFT JOIN diagnostic_centers home_center ON appointments.center_id = home_center.id 
                    LEFT JOIN diagnostic_centers other_center ON appointments.other_center_id = other_center.id
                    LEFT JOIN clients ON appointments.client_id = clients.id
                    LEFT JOIN insurers ON appointments.insurer_id = insurers.id
                    LEFT JOIN appointment_tests at ON appointments.id = at.appointment_id
                    LEFT JOIN tests t ON at.test_id = t.id
                    LEFT JOIN test_categories tc ON t.category_id = tc.id
                    LEFT JOIN technicians center_tech ON appointments.center_id = center_tech.center_id AND at.assigned_technician_id = center_tech.id AND at.visit_subtype = 'center'
                    LEFT JOIN technicians home_tech ON appointments.other_center_id = home_tech.center_id AND at.assigned_technician_id = home_tech.id AND at.visit_subtype = 'home'
                    LEFT JOIN technicians tech ON at.assigned_technician_id = tech.id
                    LEFT JOIN users center_tech_user ON center_tech.user_id = center_tech_user.id
                    LEFT JOIN users home_tech_user ON home_tech.user_id = home_tech_user.id
                    LEFT JOIN users tech_user ON tech.user_id = tech_user.id${whereClause}`;
    const [countRows] = await db.pool.query(countSql, searchParams);
    const total = countRows[0].total;

    const numericLimit = Number(limit);
    const numericPage = Number(page);
    
    let sql = `SELECT 
                appointments.*,
                home_center.center_name as home_center_name,
                other_center.center_name as other_center_name,
                clients.client_name as client_name,
                insurers.insurer_name as insurer_name,
                GROUP_CONCAT(DISTINCT t.test_name) as test_names,
                GROUP_CONCAT(DISTINCT tc.category_name) as category_names,
                GROUP_CONCAT(DISTINCT CASE 
                    WHEN at.visit_subtype = 'center' AND center_tech_user.full_name IS NOT NULL 
                    THEN CONCAT(center_tech_user.full_name, ' (', home_center.center_name, ')')
                    WHEN at.assigned_technician_id IS NOT NULL AND tech.full_name IS NOT NULL
                    THEN CONCAT(tech.full_name, ' (', home_center.center_name, ')')
                    ELSE NULL 
                END) as center_technicians,
                GROUP_CONCAT(DISTINCT CASE 
                    WHEN at.visit_subtype = 'home' AND home_tech_user.full_name IS NOT NULL 
                    THEN CONCAT(home_tech_user.full_name, ' (', other_center.center_name, ')')
                    WHEN at.visit_subtype = 'home' AND tech.full_name IS NOT NULL
                    THEN CONCAT(tech.full_name, ' (', COALESCE(other_center.center_name, home_center.center_name), ')')
                    ELSE NULL 
                END) as home_technicians,
                GROUP_CONCAT(DISTINCT CASE 
                    WHEN center_tech_user.full_name IS NOT NULL 
                    THEN center_tech_user.full_name
                    WHEN home_tech_user.full_name IS NOT NULL 
                    THEN home_tech_user.full_name
                    WHEN tech.full_name IS NOT NULL
                    THEN tech.full_name
                    ELSE NULL 
                END) as all_technicians
                FROM appointments 
                LEFT JOIN diagnostic_centers home_center ON appointments.center_id = home_center.id
                LEFT JOIN diagnostic_centers other_center ON appointments.other_center_id = other_center.id
                LEFT JOIN clients ON appointments.client_id = clients.id
                LEFT JOIN insurers ON appointments.insurer_id = insurers.id
                LEFT JOIN appointment_tests at ON appointments.id = at.appointment_id
                LEFT JOIN tests t ON at.test_id = t.id
                LEFT JOIN test_categories tc ON (t.category_id = tc.id OR at.category_id = tc.id)
                LEFT JOIN technicians center_tech ON appointments.center_id = center_tech.center_id AND at.assigned_technician_id = center_tech.id AND at.visit_subtype = 'center'
                LEFT JOIN technicians home_tech ON appointments.other_center_id = home_tech.center_id AND at.assigned_technician_id = home_tech.id AND at.visit_subtype = 'home'
                LEFT JOIN technicians tech ON at.assigned_technician_id = tech.id
                LEFT JOIN users center_tech_user ON center_tech.user_id = center_tech_user.id
                LEFT JOIN users home_tech_user ON home_tech.user_id = home_tech_user.id
                ${whereClause} 
                GROUP BY appointments.id
                ORDER BY ${validSortBy} ${validSortOrder}`;
    let dataParams = [...searchParams];
    
    if (!isNaN(numericLimit) && numericLimit > 0) {
        const offset = (numericPage - 1) * numericLimit;
        sql += ` LIMIT ? OFFSET ?`;
        dataParams.push(numericLimit, offset);
    }

    const [rows] = await db.pool.query(sql, dataParams);

    return {
        data: rows,
        pagination: {
            total,
            page: numericPage,
            limit: numericLimit,
            pages: numericLimit > 0 ? Math.ceil(total / numericLimit) : 1,
        },
    };
}

/**
 * Get single appointment by ID
 */
async function getAppointment(id) {
    const r = await db.query('SELECT * FROM appointments WHERE id = ?', [id]);
    return r[0];
}

/**
 * Get multiple appointments by IDs
 */
async function getAppointmentsByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const sql = `SELECT * FROM appointments WHERE id IN (${placeholders})`;
    const rows = await db.query(sql, ids);
    return rows;
}

const {
    verifyTestRates,
    updateAppointmentBasicFields,
    processTestAssignments,
    normalizeVisitSubtypeForAppointment
} = require('./AppointmentUpdateHelpers');

/**
 * Update appointment
 */
async function updateAppointment(id, row) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        // Update basic appointment fields
        await updateAppointmentBasicFields(connection, id, row);

        if (row.visit_type === 'Home_Visit') {
            await connection.execute(
                `UPDATE appointment_tests at
                 JOIN appointments a ON a.id = at.appointment_id
                 SET at.visit_subtype = 'home',
                     at.assigned_center_id = COALESCE(at.assigned_center_id, a.center_id),
                     at.updated_at = NOW()
                 WHERE at.appointment_id = ?`,
                [id]
            );
        } else if (row.visit_type === 'Center_Visit') {
            await connection.execute(
                `UPDATE appointment_tests at
                 JOIN appointments a ON a.id = at.appointment_id
                 SET at.visit_subtype = 'center',
                     at.assigned_center_id = COALESCE(at.assigned_center_id, a.center_id),
                     at.assigned_technician_id = NULL,
                     at.updated_at = NOW()
                 WHERE at.appointment_id = ?`,
                [id]
            );
        }

        // Handle selected_items (test assignments)
        if (Object.prototype.hasOwnProperty.call(row, 'selected_items')) {
            const selectedItems = row.selected_items;

            if (Array.isArray(selectedItems)) {
                // Get appointment details
                const [appointmentRows] = await connection.execute(
                    'SELECT center_id, other_center_id, client_id, insurer_id, visit_type FROM appointments WHERE id = ?',
                    [id]
                );

                if (appointmentRows.length === 0) {
                    throw new Error('Appointment not found');
                }

                const appointment = appointmentRows[0];

                // Verify test rates to prevent tampering
                if (selectedItems.length > 0 && appointment.client_id && appointment.insurer_id) {
                    await verifyTestRates(selectedItems, appointment.client_id, appointment.insurer_id, connection);
                }

                // Process test assignments (update/insert/delete)
                await processTestAssignments(
                    connection,
                    id,
                    selectedItems,
                    appointment,
                    row.updated_by || null
                );
            }
        }

        await connection.commit();
        return true;
    } catch (error) {
        await connection.rollback();
        logger.error('updateAppointment error:', error);
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Soft delete appointments
 */
async function softDeleteAppointments(ids, updatedBy) {
    if (!ids.length) return 0;

    const placeholders = ids.map(() => '?').join(', ');
    const sql = `UPDATE appointments SET is_deleted = 1, updated_by = ?, updated_at = NOW() WHERE id IN (${placeholders})`;
    const result = await db.query(sql, [updatedBy, ...ids]);
    return result.affectedRows;
}

/**
 * Hard delete appointment
 */
async function deleteAppointment(id) {
    const result = await db.query('DELETE FROM appointments WHERE id = ?', [id]);
    return result.affectedRows;
}

/**
 * Bulk update appointments (technician/center assignments)
 */
async function bulkUpdateAppointments(ids, updates) {
    const connection = await db.pool.getConnection();
    const fields = [];
    const values = [];

    // Enforce amount = 0 when cost type is Credit
    if (updates && Object.prototype.hasOwnProperty.call(updates, 'cost_type')) {
        const ct = updates.cost_type;
        if (ct && String(ct).toLowerCase() === 'credit') {
            updates.amount = 0;
        }
    }

    if (updates.assigned_technician_id !== undefined) {
        fields.push('assigned_technician_id = ?');
        values.push(updates.assigned_technician_id);
    }
    if (updates.center_id !== undefined) {
        fields.push('center_id = ?');
        values.push(updates.center_id);
    }
    if (updates.cost_type !== undefined) {
        fields.push('cost_type = ?');
        values.push(updates.cost_type);
    }
    if (updates.amount !== undefined) {
        fields.push('amount = ?');
        values.push(updates.amount);
    }
    if (updates.status !== undefined) {
        fields.push('status = ?');
        values.push(updates.status);
    }

    if (fields.length === 0) {
        throw new Error('No fields to update');
    }

    fields.push('updated_at = NOW()');

    if (updates.updated_by) {
        fields.push('updated_by = ?');
        values.push(updates.updated_by);
    }

    const placeholders = ids.map(() => '?').join(', ');
    const sql = `UPDATE appointments SET ${fields.join(', ')} WHERE id IN (${placeholders})`;

    try {
        await connection.beginTransaction();

        const [result] = await connection.query(sql, [...values, ...ids]);

        if (updates.assigned_technician_id !== undefined) {
            const [[technician]] = await connection.query(
                `SELECT id, center_id FROM technicians WHERE id = ? AND is_deleted = 0`,
                [updates.assigned_technician_id]
            );

            if (!technician) {
                throw new Error('Selected technician not found');
            }

            const [appointmentRows] = await connection.query(
                `SELECT id, visit_type FROM appointments WHERE id IN (${placeholders})`,
                ids
            );
            const homeVisitIds = appointmentRows
                .filter((appointment) => appointment.visit_type === 'Home_Visit')
                .map((appointment) => appointment.id);
            const splitOrLegacyIds = appointmentRows
                .filter((appointment) => appointment.visit_type !== 'Home_Visit' && appointment.visit_type !== 'Center_Visit')
                .map((appointment) => appointment.id);

            if (homeVisitIds.length > 0) {
                const homePlaceholders = homeVisitIds.map(() => '?').join(', ');
                await connection.query(
                    `UPDATE appointment_tests
                     SET assigned_technician_id = ?,
                         visit_subtype = 'home',
                         updated_at = NOW()
                     WHERE appointment_id IN (${homePlaceholders})`,
                    [updates.assigned_technician_id, ...homeVisitIds]
                );
            }

            if (splitOrLegacyIds.length > 0) {
                const splitPlaceholders = splitOrLegacyIds.map(() => '?').join(', ');
                await connection.query(
                    `UPDATE appointment_tests
                     SET assigned_technician_id = ?,
                         updated_at = NOW()
                     WHERE appointment_id IN (${splitPlaceholders})
                       AND visit_subtype = 'home'`,
                    [updates.assigned_technician_id, ...splitOrLegacyIds]
                );
            }
        }

        await connection.commit();
        return result.affectedRows;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    createAppointment,
    cloneAppointment,
    listAppointments,
    getAppointment,
    getAppointmentsByIds,
    updateAppointment,
    softDeleteAppointments,
    deleteAppointment,
    bulkUpdateAppointments,
    buildDateFilter,
    updateAppointmentStatus
};
