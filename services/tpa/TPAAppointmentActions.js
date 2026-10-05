/**
 * Transactional appointment actions initiated by an authenticated TPA.
 * These are deliberately isolated from CRM reschedule/pushback flows because
 * a TPA can only change a case before customer confirmation or medical work.
 */

const crypto = require('crypto');
const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { generateCustomCode } = require('../../lib/generateCode');

const ACTIONS = Object.freeze({
    RESCHEDULE: 'reschedule',
    PUSHBACK: 'pushback'
});

function actionError(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function safeJson(value) {
    return JSON.stringify(value === undefined ? null : value);
}

function parseStoredJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (_error) {
        return null;
    }
}

function normalizeIds(value, fieldName) {
    if (value === undefined || value === null || value === '') return [];
    const input = Array.isArray(value) ? value : [value];
    const normalized = input.map(Number).filter(Number.isInteger).filter((id) => id > 0);
    if (normalized.length !== input.length) {
        throw actionError(`${fieldName} must contain only positive numeric IDs`);
    }
    return [...new Set(normalized)].sort((a, b) => a - b);
}

function normalizeSelection(body) {
    const appointmentItemIds = normalizeIds(
        body.selected_item_ids ?? body.appointment_test_ids,
        'selected_item_ids'
    );
    const testIds = normalizeIds(body.test_ids, 'test_ids');
    const categoryIds = normalizeIds(body.category_ids, 'category_ids');

    if (body.selected_items !== undefined) {
        if (!Array.isArray(body.selected_items)) {
            throw actionError('selected_items must be an array');
        }
        body.selected_items.forEach((item) => {
            const type = String(item?.type || item?.item_type || '').toLowerCase();
            const id = Number(item?.id ?? item?.test_id ?? item?.category_id);
            if (!Number.isInteger(id) || id <= 0 || !['test', 'category'].includes(type)) {
                throw actionError('Each selected_items entry requires type test/category and a positive id');
            }
            (type === 'category' ? categoryIds : testIds).push(id);
        });
    }

    return {
        appointmentItemIds: [...new Set(appointmentItemIds)].sort((a, b) => a - b),
        testIds: [...new Set(testIds)].sort((a, b) => a - b),
        categoryIds: [...new Set(categoryIds)].sort((a, b) => a - b)
    };
}

function hasSelection(selection) {
    return selection.appointmentItemIds.length > 0
        || selection.testIds.length > 0
        || selection.categoryIds.length > 0;
}

function normalizeDate(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const [year, month, day] = text.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() === month - 1
        && parsed.getUTCDate() === day
        ? text
        : null;
}

function normalizeTime(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return null;
    const normalized = text.length === 5 ? `${text}:00` : text;
    const [hours, minutes, seconds] = normalized.split(':').map(Number);
    return hours <= 23 && minutes <= 59 && seconds <= 59 ? normalized : null;
}

function normalizeRequest(action, body = {}, requestIdHeader = null) {
    const appointmentId = Number(body.appointment_id || body.appointmentId);
    if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
        throw actionError('A valid appointment_id is required');
    }

    const selection = normalizeSelection(body);
    const reasonValue = body.reason ?? body.remarks;
    const reason = reasonValue === undefined || reasonValue === null
        ? null
        : String(reasonValue).trim() || null;
    const appointmentDate = normalizeDate(body.appointment_date ?? body.date);
    const appointmentTime = normalizeTime(body.appointment_time ?? body.time);

    if (action === ACTIONS.RESCHEDULE) {
        if (!appointmentDate) {
            throw actionError('appointment_date is required in YYYY-MM-DD format');
        }
        if (!appointmentTime) {
            throw actionError('appointment_time is required in HH:mm or HH:mm:ss format');
        }
    }

    const suppliedRequestId = requestIdHeader || body.request_id || body.idempotency_key;
    const normalizedRequestId = suppliedRequestId ? String(suppliedRequestId).trim() : '';
    if (normalizedRequestId.length > 128) {
        throw actionError('request_id cannot exceed 128 characters');
    }
    const requestId = normalizedRequestId || crypto.randomUUID();

    if (!requestId) throw actionError('request_id cannot be blank');

    return {
        appointmentId,
        appointmentDate,
        appointmentTime,
        selection,
        reason,
        requestId
    };
}

function payloadHash(action, request) {
    const canonical = {
        action,
        appointment_id: request.appointmentId,
        appointment_date: request.appointmentDate,
        appointment_time: request.appointmentTime,
        selection: request.selection,
        reason: request.reason
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function findIdempotentResult(connection, clientId, requestId, hash) {
    const [rows] = await connection.query(
        `SELECT id, payload_hash, status, response_payload
         FROM tpa_inbound_action_logs
         WHERE client_id = ? AND request_id = ?
         LIMIT 1 FOR UPDATE`,
        [clientId, requestId]
    );
    if (!rows.length) return null;

    const existing = rows[0];
    if (existing.payload_hash && existing.payload_hash !== hash) {
        throw actionError('This request_id was already used for a different request', 409);
    }
    if (existing.status === 'completed') {
        return parseStoredJson(existing.response_payload);
    }
    if (existing.status === 'processing') {
        throw actionError('This request is already being processed', 409);
    }

    await connection.query(
        `UPDATE tpa_inbound_action_logs
         SET status = 'processing', error_message = NULL, completed_at = NULL
         WHERE id = ?`,
        [existing.id]
    );
    return { auditId: existing.id };
}

async function createAudit(connection, context, action, request, hash) {
    const [result] = await connection.query(
        `INSERT IGNORE INTO tpa_inbound_action_logs (
            tpa_config_id, client_id, request_id, action, scope,
            source_appointment_id, selected_item_ids, reason, payload_hash,
            request_payload, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NOW())`,
        [
            context.id || null,
            context.client_id,
            request.requestId,
            action,
            hasSelection(request.selection) ? 'partial' : 'complete',
            request.appointmentId,
            safeJson(request.selection),
            request.reason,
            hash,
            safeJson({
                appointment_id: request.appointmentId,
                appointment_date: request.appointmentDate,
                appointment_time: request.appointmentTime,
                selection: request.selection,
                reason: request.reason
            })
        ]
    );
    return result.affectedRows ? result.insertId : null;
}

async function lockOwnedAppointment(connection, appointmentId, clientId) {
    const [rows] = await connection.query(
        `SELECT * FROM appointments
         WHERE id = ? AND client_id = ? AND is_deleted = 0
         LIMIT 1 FOR UPDATE`,
        [appointmentId, clientId]
    );
    if (!rows.length) {
        throw actionError('Appointment not found for this TPA client', 404);
    }
    return rows[0];
}

async function ensurePreConfirmationStage(connection, appointment) {
    const status = String(appointment.status || '').toLowerCase();
    const allowedStatuses = new Set(['', 'created', 'pending']);

    if (appointment.confirmed_date || appointment.confirmed_time || !allowedStatuses.has(status)) {
        throw actionError('TPA changes are allowed only before the appointment is confirmed', 409);
    }
    // medical_status may retain historical values such as "pushed_back" after
    // a case is restored. The active appointment status and actual work data
    // are the reliable gates for allowing another TPA action.
    if (appointment.customer_arrived_at
        || appointment.medical_started_at
        || appointment.medical_completed_at
        || appointment.arrival_time
        || appointment.medical_start_time
        || appointment.medical_end_time) {
        throw actionError('TPA changes are not allowed after medical work has started', 409);
    }

    const [workRows] = await connection.query(
        `SELECT
            EXISTS(
                SELECT 1 FROM appointment_tests
                WHERE appointment_id = ? AND COALESCE(is_completed, 0) = 1
            ) AS completed_tests,
            EXISTS(
                SELECT 1 FROM appointment_reports
                WHERE appointment_id = ? AND is_deleted = 0
            ) AS reports,
            EXISTS(
                SELECT 1 FROM appointment_categorized_reports
                WHERE appointment_id = ? AND COALESCE(is_deleted, 0) = 0
            ) AS categorized_reports,
            EXISTS(
                SELECT 1 FROM appointment_qc_history
                WHERE appointment_id = ?
            ) AS qc_activity`,
        [appointment.id, appointment.id, appointment.id, appointment.id]
    );
    const work = workRows[0] || {};
    if (work.completed_tests || work.reports || work.categorized_reports || work.qc_activity) {
        throw actionError('TPA changes are not allowed after tests, reports, or QC work has started', 409);
    }
}

async function lockTestItems(connection, appointmentId) {
    const [rows] = await connection.query(
        `SELECT * FROM appointment_tests
         WHERE appointment_id = ?
         ORDER BY id FOR UPDATE`,
        [appointmentId]
    );
    return rows;
}

function resolveScope(request, allItems) {
    const { appointmentItemIds, testIds, categoryIds } = request.selection;
    if (!hasSelection(request.selection)) return { scope: 'complete', selectedItems: [] };

    const byId = new Map(allItems.map((item) => [Number(item.id), item]));
    const selectedById = appointmentItemIds.map((id) => byId.get(id)).filter(Boolean);
    if (selectedById.length !== appointmentItemIds.length) {
        throw actionError('One or more selected_item_ids do not belong to this appointment', 400);
    }
    const availableTestIds = new Set(allItems.map((item) => Number(item.test_id)).filter(Boolean));
    const availableCategoryIds = new Set(allItems.map((item) => Number(item.category_id)).filter(Boolean));
    if (testIds.some((id) => !availableTestIds.has(id))) {
        throw actionError('One or more test_ids do not belong to this appointment', 400);
    }
    if (categoryIds.some((id) => !availableCategoryIds.has(id))) {
        throw actionError('One or more category_ids do not belong to this appointment', 400);
    }

    const selectedRowIds = new Set(selectedById.map((item) => Number(item.id)));
    allItems.forEach((item) => {
        if (testIds.includes(Number(item.test_id)) || categoryIds.includes(Number(item.category_id))) {
            selectedRowIds.add(Number(item.id));
        }
    });
    const selectedItems = allItems.filter((item) => selectedRowIds.has(Number(item.id)));
    if (selectedItems.length === allItems.length) {
        return { scope: 'complete', selectedItems: [] };
    }
    if (!selectedItems.length) {
        throw actionError('At least one valid selected_item_id is required for a partial action', 400);
    }
    return { scope: 'partial', selectedItems };
}

async function rescheduleAppointment(connection, appointment, request) {
    await connection.query(
        `UPDATE appointments
         SET appointment_date = ?, appointment_time = ?,
             reschedule_remark = COALESCE(?, reschedule_remark),
             status = 'pending', updated_at = NOW()
         WHERE id = ?`,
        [request.appointmentDate, request.appointmentTime, request.reason, appointment.id]
    );
}

async function pushBackAppointment(connection, appointmentId, reason) {
    await connection.query(
        `UPDATE appointments
         SET status = 'pushed_back', medical_status = 'pushed_back',
             pushed_back = 1, pushback_remarks = ?, pushed_back_by = NULL,
             pushed_back_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [reason, appointmentId]
    );
}

function childPlacement(source, selectedItems) {
    const subtypes = new Set(selectedItems.map((item) => String(item.visit_subtype || '').toLowerCase()));
    const assignedCenters = [...new Set(selectedItems.map((item) => Number(item.assigned_center_id)).filter(Boolean))];

    if (subtypes.size === 1 && subtypes.has('home')) {
        return {
            visitType: 'Home_Visit',
            centerId: assignedCenters[0] || source.other_center_id || source.center_id || null,
            otherCenterId: null,
            splitType: 'none'
        };
    }
    if (subtypes.size === 1 && subtypes.has('center')) {
        return {
            visitType: 'Center_Visit',
            centerId: assignedCenters[0] || source.center_id || null,
            otherCenterId: null,
            splitType: 'none'
        };
    }
    return {
        visitType: source.visit_type,
        centerId: source.center_id || null,
        otherCenterId: source.other_center_id || null,
        splitType: source.visit_type === 'Both' ? 'split' : (source.split_type || 'none')
    };
}

function exactActionName(action, scope) {
    if (scope === 'partial') {
        return action === ACTIONS.RESCHEDULE
            ? 'tpa_tests_split_for_reschedule'
            : 'tpa_tests_split_for_pushback';
    }
    return action === ACTIONS.RESCHEDULE ? 'tpa_rescheduled' : 'tpa_pushed_back';
}

async function normalizeSourcePlacement(connection, source, remainingItems) {
    if (source.visit_type !== 'Both' || !remainingItems.length) return;

    const placement = childPlacement(source, remainingItems);
    if (placement.visitType === 'Both') return;

    await connection.query(
        `UPDATE appointments
         SET visit_type = ?, center_id = ?, other_center_id = NULL,
             split_type = 'none', updated_at = NOW()
         WHERE id = ?`,
        [placement.visitType, placement.centerId, source.id]
    );
}

async function createSplitChild(connection, source, selectedItems, action, request) {
    const placement = childPlacement(source, selectedItems);
    const caseNumber = await generateCustomCode({
        prefix: 'CASE',
        table: 'appointments',
        column: 'case_number'
    });
    const childDate = action === ACTIONS.RESCHEDULE ? request.appointmentDate : source.appointment_date;
    const childTime = action === ACTIONS.RESCHEDULE ? request.appointmentTime : source.appointment_time;

    const [result] = await connection.query(
        `INSERT INTO appointments (
            case_number, application_number, client_id, center_id, other_center_id, insurer_id,
            customer_first_name, customer_last_name, gender, customer_mobile, customer_alt_mobile,
            customer_service_no, customer_email, customer_address, state, city, pincode, country,
            customer_gps_latitude, customer_gps_longitude, customer_landmark,
            visit_type, customer_category, appointment_date, appointment_time,
            status, remarks, cancellation_reason, created_by, created_at, updated_at,
            is_deleted, has_pending_approval, test_name, cost_type, amount, utr_number, amount_upload,
            case_severity, updated_by, is_active, split_type, medical_status, qc_status,
            pushed_back, center_pushed_back, home_pushed_back, total_call_attempts,
            reschedule_remark, pushback_remarks
         ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'pending', ?, NULL, NULL, NOW(), NOW(), 0, 0, ?, ?, ?, ?, ?, ?, NULL, ?, ?,
            NULL, NULL, 0, 0, 0, 0, ?, NULL
         )`,
        [
            caseNumber,
            source.application_number,
            source.client_id,
            placement.centerId,
            placement.otherCenterId,
            source.insurer_id,
            source.customer_first_name,
            source.customer_last_name,
            source.gender,
            source.customer_mobile,
            source.customer_alt_mobile,
            source.customer_service_no,
            source.customer_email,
            source.customer_address,
            source.state,
            source.city,
            source.pincode,
            source.country,
            source.customer_gps_latitude,
            source.customer_gps_longitude,
            source.customer_landmark,
            placement.visitType,
            source.customer_category,
            childDate,
            childTime,
            source.remarks,
            source.test_name,
            source.cost_type,
            source.amount,
            source.utr_number,
            source.amount_upload,
            source.case_severity || 0,
            source.is_active === undefined ? 1 : source.is_active,
            placement.splitType,
            action === ACTIONS.RESCHEDULE ? request.reason : null
        ]
    );

    const childId = result.insertId;
    if (!childId) throw new Error('Failed to create split appointment');

    const selectedIds = selectedItems.map((item) => Number(item.id));
    const placeholders = selectedIds.map(() => '?').join(',');
    const [copiedItems] = await connection.query(
        `INSERT INTO appointment_tests (
            appointment_id, test_id, category_id, rate, assigned_center_id,
            assigned_technician_id, visit_subtype, status, invoice_upload,
            updated_by, is_completed, completion_remarks, created_at, rate_type,
            item_name, updated_at
         )
         SELECT ?, test_id, category_id, rate, assigned_center_id,
                NULL, visit_subtype, 'pending', NULL,
                NULL, 0, NULL, NOW(), rate_type, item_name, NOW()
         FROM appointment_tests
         WHERE appointment_id = ? AND id IN (${placeholders})`,
        [childId, source.id, ...selectedIds]
    );
    if (copiedItems.affectedRows !== selectedIds.length) {
        throw new Error('Not all selected tests could be copied to the split appointment');
    }

    const [removedItems] = await connection.query(
        `DELETE FROM appointment_tests
         WHERE appointment_id = ? AND id IN (${placeholders})`,
        [source.id, ...selectedIds]
    );
    if (removedItems.affectedRows !== selectedIds.length) {
        throw new Error('Not all selected tests could be moved from the source appointment');
    }

    const selectedIdSet = new Set(selectedIds);
    const remainingItems = selectedItems.length
        ? (await lockTestItems(connection, source.id)).filter((item) => !selectedIdSet.has(Number(item.id)))
        : [];
    await normalizeSourcePlacement(connection, source, remainingItems);
    await connection.query('UPDATE appointments SET updated_at = NOW() WHERE id = ?', [source.id]);

    return { id: childId, caseNumber, placement };
}

async function saveCompletedAudit(connection, auditId, actionName, scope, childId, response) {
    await connection.query(
        `UPDATE tpa_inbound_action_logs
         SET action = ?, scope = ?, child_appointment_id = ?, response_payload = ?,
             status = 'completed', error_message = NULL, completed_at = NOW()
         WHERE id = ?`,
        [actionName, scope, childId || null, safeJson(response), auditId]
    );
}

async function saveFailedAudit(context, action, request, hash, error) {
    try {
        await db.query(
            `INSERT INTO tpa_inbound_action_logs (
                tpa_config_id, client_id, request_id, action, scope,
                source_appointment_id, selected_item_ids, reason, payload_hash,
                request_payload, status, error_message, created_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                status = IF(status = 'completed', status, 'failed'),
                error_message = IF(status = 'completed', error_message, VALUES(error_message)),
                completed_at = IF(status = 'completed', completed_at, NOW())`,
            [
                context.id || null,
                context.client_id,
                request.requestId,
                action,
                hasSelection(request.selection) ? 'partial' : 'complete',
                request.appointmentId,
                safeJson(request.selection),
                request.reason,
                hash,
                safeJson(request),
                error.message
            ]
        );
    } catch (auditError) {
        logger.error('Failed to record TPA inbound action failure', {
            requestId: request.requestId,
            error: auditError.message
        });
    }
}

async function execute(action, body, context, requestIdHeader = null) {
    if (!Object.values(ACTIONS).includes(action)) {
        throw actionError('Unsupported TPA appointment action');
    }
    if (!context || !Number.isInteger(Number(context.client_id))) {
        throw actionError('Authenticated TPA client context is required', 401);
    }
    const request = normalizeRequest(action, body || {}, requestIdHeader);
    const hash = payloadHash(action, request);
    const connection = await db.getConnection();
    let auditId = null;

    try {
        await connection.beginTransaction();

        const existing = await findIdempotentResult(connection, context.client_id, request.requestId, hash);
        if (existing && !existing.auditId) {
            await connection.commit();
            return { ...existing, idempotent_replay: true };
        }
        auditId = existing?.auditId || await createAudit(connection, context, action, request, hash);
        if (!auditId) {
            const concurrent = await findIdempotentResult(
                connection,
                context.client_id,
                request.requestId,
                hash
            );
            if (concurrent && !concurrent.auditId) {
                await connection.commit();
                return { ...concurrent, idempotent_replay: true };
            }
            auditId = concurrent?.auditId;
        }
        if (!auditId) throw new Error('Failed to initialize the TPA action audit record');

        const source = await lockOwnedAppointment(connection, request.appointmentId, context.client_id);
        await ensurePreConfirmationStage(connection, source);
        const allItems = await lockTestItems(connection, source.id);
        const { scope, selectedItems } = resolveScope(request, allItems);

        let target = source;
        let child = null;
        if (scope === 'partial') {
            child = await createSplitChild(connection, source, selectedItems, action, request);
            target = { id: child.id, case_number: child.caseNumber };
        }

        if (action === ACTIONS.RESCHEDULE) {
            await rescheduleAppointment(connection, target, request);
        } else {
            await pushBackAppointment(connection, target.id, request.reason);
        }

        const actionName = exactActionName(action, scope);
        const response = {
            request_id: request.requestId,
            action,
            event: actionName,
            scope,
            source_appointment: {
                id: source.id,
                case_number: source.case_number,
                application_number: source.application_number
            },
            child_appointment: child ? {
                id: child.id,
                case_number: child.caseNumber,
                application_number: source.application_number,
                visit_type: child.placement.visitType
            } : null,
            moved_test_item_ids: scope === 'partial' ? selectedItems.map((item) => Number(item.id)) : [],
            moved_items: scope === 'partial' ? selectedItems.map((item) => ({
                appointment_test_id: Number(item.id),
                type: item.rate_type || (item.category_id ? 'category' : 'test'),
                test_id: item.test_id ? Number(item.test_id) : null,
                category_id: item.category_id ? Number(item.category_id) : null,
                item_name: item.item_name || null
            })) : [],
            appointment_date: action === ACTIONS.RESCHEDULE ? request.appointmentDate : source.appointment_date,
            appointment_time: action === ACTIONS.RESCHEDULE ? request.appointmentTime : source.appointment_time,
            status: action === ACTIONS.PUSHBACK ? 'pushed_back' : 'pending'
        };

        await saveCompletedAudit(connection, auditId, actionName, scope, child?.id, response);
        await connection.commit();

        logger.info('TPA appointment action completed', {
            requestId: request.requestId,
            clientId: context.client_id,
            appointmentId: source.id,
            childAppointmentId: child?.id || null,
            action,
            scope
        });
        return response;
    } catch (error) {
        await connection.rollback();
        await saveFailedAudit(context, action, request, hash, error);
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    ACTIONS,
    execute
};
