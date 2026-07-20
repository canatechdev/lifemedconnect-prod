/**
 * Helper functions for appointment update operations
 * Extracted from AppointmentCRUD.js for better maintainability
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { emptyToNull } = require('../../lib/normalizers');

// Safe value handler - returns null for undefined/null/empty values
const safe = (value) => emptyToNull(value);

function normalizeVisitSubtypeForAppointment(visitType, requestedSubtype) {
    if (visitType === 'Home_Visit') return 'home';
    if (visitType === 'Center_Visit') return 'center';
    return requestedSubtype || 'center';
}

/**
 * Verify test rates against database to prevent tampering
 */
async function verifyTestRates(selectedItems, clientId, insurerId, connection) {
    if (!selectedItems || selectedItems.length === 0) return;

    const testIds = selectedItems
        .filter(item => item.type === 'test')
        .map(item => item.id);
    
    const categoryIds = selectedItems
        .filter(item => item.type === 'category')
        .map(item => item.id);

    // Verify test rates
    if (testIds.length > 0) {
        const placeholders = testIds.map(() => '?').join(',');
        const [dbRates] = await connection.execute(
            `SELECT test_id as id, rate FROM bulk_test_rates 
             WHERE client_id = ? AND insurer_id = ? AND test_id IN (${placeholders})`,
            [clientId, insurerId, ...testIds]
        );

        for (const item of selectedItems.filter(i => i.type === 'test')) {
            const dbRate = dbRates.find(r => r.id === item.id);
            if (dbRate) {
                const clientRate = parseFloat(item.rate);
                const serverRate = parseFloat(dbRate.rate);
                if (Math.abs(clientRate - serverRate) > 0.01) {
                    // Auto-correct to server rate instead of blocking the update
                    item.rate = serverRate;
                }
            }
        }
    }

    // Verify category rates
    if (categoryIds.length > 0) {
        const placeholders = categoryIds.map(() => '?').join(',');
        const [dbRates] = await connection.execute(
            `SELECT category_id as id, rate FROM bulk_test_rates 
             WHERE client_id = ? AND insurer_id = ? AND item_type = 'category' AND category_id IN (${placeholders})`,
            [clientId, insurerId, ...categoryIds]
        );

        for (const item of selectedItems.filter(i => i.type === 'category')) {
            const dbRate = dbRates.find(r => r.id === item.id);
            if (dbRate) {
                const clientRate = parseFloat(item.rate);
                const serverRate = parseFloat(dbRate.rate);
                if (Math.abs(clientRate - serverRate) > 0.01) {
                    // Auto-correct to server rate instead of blocking the update
                    item.rate = serverRate;
                }
            }
        }
    }
}

/**
 * Update basic appointment fields
 */
async function updateAppointmentBasicFields(connection, id, row) {
    // Enforce amount = 0 when cost type is Credit
    if (row && Object.prototype.hasOwnProperty.call(row, 'cost_type')) {
        const ct = row.cost_type;
        if (ct && String(ct).toLowerCase() === 'credit') {
            row.amount = 0;
        }
    }

    const updateFields = [];
    const updateValues = [];

    const allowedFields = [
        'case_number', 'application_number', 'client_id', 'center_id', 'other_center_id', 'insurer_id',
        'customer_first_name', 'customer_last_name', 'gender', 'customer_mobile', 'customer_alt_mobile', 'customer_service_no',
        'customer_email', 'customer_address', 'state', 'city', 'pincode', 'country',
        'customer_gps_latitude', 'customer_gps_longitude', 'customer_landmark',
        'visit_type', 'customer_category', 'appointment_date', 'appointment_time', 'confirmed_time',
        'status', 'assigned_technician_id', 'assigned_at', 'assigned_by',
        'customer_arrived_at', 'medical_started_at', 'medical_completed_at',
        'remarks', 'cancellation_reason', 'updated_by', 'cost_type', 'amount', 'amount_upload', 'case_severity'
    ];

    for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(row, field)) {
            updateFields.push(`${field} = ?`);
            updateValues.push(emptyToNull(row[field]));
        }
    }

    if (updateFields.length > 0) {
        updateFields.push('updated_at = NOW()');
        updateValues.push(id);
        const updateSql = `UPDATE appointments SET ${updateFields.join(', ')} WHERE id = ?`;
        await connection.execute(updateSql, updateValues);
    }
}

/**
 * Find matching existing test for update
 */
function findMatchingTest(existingTests, item, assignedCenterId, visitSubtype, processedTestIds) {
    const itemKeyMatches = (t) =>
        t.rate_type === item.type &&
        (item.type === 'test' ? t.test_id === item.id : t.category_id === item.id);

    // Try exact center + exact side match first
    let match = existingTests.find(t =>
        !processedTestIds.has(t.id) &&
        itemKeyMatches(t) &&
        t.assigned_center_id === assignedCenterId &&
        (t.visit_subtype || 'center') === (visitSubtype || 'center')
    );

    // If no exact match, try same item + same side even if the center changed
    if (!match) {
        match = existingTests.find(t =>
            !processedTestIds.has(t.id) &&
            itemKeyMatches(t) &&
            (t.visit_subtype || 'center') === (visitSubtype || 'center')
        );
    }

    // If still no match, try orphaned/unassigned row of the same item
    if (!match) {
        match = existingTests.find(t =>
            !processedTestIds.has(t.id) &&
            itemKeyMatches(t) &&
            t.assigned_center_id === null
        );
    }

    // Final fallback: same item anywhere, so center edits reuse the row instead of duplicating it
    if (!match) {
        match = existingTests.find(t =>
            !processedTestIds.has(t.id) &&
            itemKeyMatches(t)
        );
    }

    return match;
}

/**
 * Update existing test record
 */
async function updateExistingTest(connection, match, item, assignedCenterId, assignedTechnicianId, visitSubtype, rate, updatedBy) {
    await connection.execute(`
        UPDATE appointment_tests
        SET
            assigned_center_id = ?,
            assigned_technician_id = ?,
            visit_subtype = ?,
            rate = ?,
            item_name = ?,
            updated_by = ?,
            updated_at = NOW()
        WHERE id = ?
    `, [
        assignedCenterId,
        assignedTechnicianId,
        visitSubtype,
        rate,
        item.name || item.item_name,
        updatedBy,
        match.id
    ]);
}

/**
 * Insert new test record
 */
async function insertNewTest(connection, appointmentId, item, assignedCenterId, assignedTechnicianId, visitSubtype, rate, updatedBy) {
    const testId = item.type === 'test' ? item.id : null;
    const categoryId = item.type === 'category' ? item.id : null;

    await connection.execute(`
        INSERT INTO appointment_tests (
            appointment_id, test_id, category_id, rate_type, item_name, rate,
            assigned_center_id, assigned_technician_id, visit_subtype, status,
            is_completed, created_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NOW(), ?)
    `, [
        appointmentId,
        testId,
        categoryId,
        item.type,
        item.name || item.item_name,
        rate,
        assignedCenterId,
        assignedTechnicianId,
        visitSubtype,
        updatedBy
    ]);
}

/**
 * Delete removed tests (selective deletion by center)
 */
async function deleteRemovedTests(connection, appointmentId, existingTests, processedTestIds, centersBeingUpdated) {
    const testsToDelete = existingTests.filter(t => !processedTestIds.has(t.id));

    if (testsToDelete.length > 0) {
        const idsToDelete = testsToDelete.map(t => t.id);
        const placeholders = idsToDelete.map(() => '?').join(',');
        await connection.execute(
            `DELETE FROM appointment_tests WHERE id IN (${placeholders})`,
            idsToDelete
        );
    }

    return testsToDelete.length;
}

/**
 * Process test assignments for appointment update
 */
async function processTestAssignments(connection, appointmentId, selectedItems, appointment, updatedBy) {
    // Fetch existing tests
    const [existingTests] = await connection.execute(
        'SELECT * FROM appointment_tests WHERE appointment_id = ?',
        [appointmentId]
    );

    const processedTestIds = new Set();
    const centersBeingUpdated = new Set();
    const seenIncomingKeys = new Set();

    // Process incoming items (Update or Insert)
    for (const item of selectedItems) {
        // Determine assigned center
        let assignedCenterId = null;
        if (item.assigned_center_id) {
            assignedCenterId = item.assigned_center_id;
        } else if (item.assigned_to === 'center2' && appointment.other_center_id) {
            assignedCenterId = appointment.other_center_id;
        } else {
            assignedCenterId = appointment.center_id;
        }

        if (assignedCenterId) {
            centersBeingUpdated.add(assignedCenterId);
        }

        const visitSubtype = normalizeVisitSubtypeForAppointment(
            appointment.visit_type,
            item.assigned_technician_id ? 'home' : item.visit_subtype
        );
        const assignedTechnicianId = visitSubtype === 'center' ? null : (item.assigned_technician_id || null);
        const rate = parseFloat(item.rate);
        const incomingKey = [
            item.type,
            item.id,
            assignedCenterId || 'null',
            visitSubtype || 'center',
            assignedTechnicianId || 'null'
        ].join(':');

        if (seenIncomingKeys.has(incomingKey)) {
            continue;
        }
        seenIncomingKeys.add(incomingKey);

        // Find matching existing test
        const match = findMatchingTest(existingTests, item, assignedCenterId, visitSubtype, processedTestIds);

        if (match) {
            // Update existing test
            await updateExistingTest(
                connection,
                match,
                item,
                assignedCenterId,
                assignedTechnicianId,
                visitSubtype,
                rate,
                updatedBy
            );
            processedTestIds.add(match.id);
        } else {
            // Insert new test
            await insertNewTest(
                connection,
                appointmentId,
                item,
                assignedCenterId,
                assignedTechnicianId,
                visitSubtype,
                rate,
                updatedBy
            );
        }
    }

    // Delete removed tests (selective by center)
    const deletedCount = await deleteRemovedTests(
        connection,
        appointmentId,
        existingTests,
        processedTestIds,
        centersBeingUpdated
    );

    return { processedCount: processedTestIds.size, deletedCount };
}

module.exports = {
    verifyTestRates,
    updateAppointmentBasicFields,
    processTestAssignments,
    normalizeVisitSubtypeForAppointment,
    findMatchingTest,
    updateExistingTest,
    insertNewTest,
    deleteRemovedTests
};
