const db = require('./dbconnection');
const logger = require('./logger');

/**
 * Complete permission catalog for the CRM system
 * Format: { name: 'module.action', description: 'Human-readable description' }
 */
const permissionCatalog = [
    { name: 'dashboard.view', description: 'View dashboard' },

    { name: 'users.view', description: 'View user list/details' },
    { name: 'users.create', description: 'Create users' },
    { name: 'users.update', description: 'Update users' },
    { name: 'users.delete', description: 'Delete users' },
    { name: 'users.manage_roles', description: 'Assign roles/permissions to users' },

    { name: 'roles.view', description: 'View roles' },
    { name: 'roles.create', description: 'Create roles' },
    { name: 'roles.update', description: 'Update roles' },
    { name: 'roles.delete', description: 'Delete roles' },

    { name: 'permissions.manage', description: 'Manage permission catalog and mappings' },

    { name: 'clients.view', description: 'View clients' },
    { name: 'clients.create', description: 'Create clients' },
    { name: 'clients.update', description: 'Update clients' },
    { name: 'clients.delete', description: 'Delete clients' },

    { name: 'insurers.view', description: 'View insurers' },
    { name: 'insurers.create', description: 'Create insurers' },
    { name: 'insurers.update', description: 'Update insurers' },
    { name: 'insurers.delete', description: 'Delete insurers' },

    { name: 'centers.view', description: 'View diagnostic centers' },
    { name: 'centers.create', description: 'Create diagnostic centers' },
    { name: 'centers.update', description: 'Update diagnostic centers' },
    { name: 'centers.delete', description: 'Delete diagnostic centers' },

    { name: 'technicians.view', description: 'View technicians' },
    { name: 'technicians.create', description: 'Create technicians' },
    { name: 'technicians.update', description: 'Update technicians' },
    { name: 'technicians.delete', description: 'Delete technicians' },

    { name: 'doctors.view', description: 'View doctors' },
    { name: 'doctors.create', description: 'Create doctors' },
    { name: 'doctors.update', description: 'Update doctors' },
    { name: 'doctors.delete', description: 'Delete doctors' },

    { name: 'tests.view', description: 'View tests' },
    { name: 'tests.create', description: 'Create tests' },
    { name: 'tests.update', description: 'Update tests' },
    { name: 'tests.delete', description: 'Delete tests' },

    { name: 'test_rates.view', description: 'View test rates' },
    { name: 'test_rates.create', description: 'Create test rates' },
    { name: 'test_rates.update', description: 'Update test rates' },
    { name: 'test_rates.delete', description: 'Delete test rates' },

    { name: 'categories.view', description: 'View categories' },
    { name: 'categories.create', description: 'Create categories' },
    { name: 'categories.update', description: 'Update categories' },
    { name: 'categories.delete', description: 'Delete categories' },

    { name: 'appointments.view', description: 'View appointments' },
    { name: 'appointments.create', description: 'Create appointments' },
    { name: 'appointments.update', description: 'Update appointments' },
    { name: 'appointments.delete', description: 'Delete/restore appointments' },
    { name: 'appointments.assign_center', description: 'Assign diagnostic center or technician' },
    { name: 'appointments.upload_docs', description: 'Upload documents/images' },
    { name: 'appointments.qc', description: 'Perform QC actions' },
    { name: 'appointments.qc_details', description: 'To see test category deatils in report upload' },
    { name: 'appointments.reports', description: 'Upload/download reports' },
    { name: 'appointments.import', description: 'Import appointments from Excel file' },
    { name: 'appointments.export', description: 'Export appointments list to Excel' },
    { name: 'appointments.pushback', description: 'Push back appointments to Admin/Reports stage' },
    { name: 'appointments.restore', description: 'Restore pushed-back appointments to active state' },
    { name: 'appointments.reschedule', description: 'Reschedule appointment date and time' },
    { name: 'appointments.medical_update', description: 'Update medical workflow status (Mark Arrived, Start Medical, Partial Complete)' },
    { name: 'appointments.complete', description: 'Mark appointment as completed (final confirmation)' },
    { name: 'appointments.proforma', description: 'Download proforma invoice PDF' },
    { name: 'appointments.test_assignments', description: 'Update test assignments for appointments' },
    { name: 'appointments.qc_history', description: 'View QC audit trail and history' },
    { name: 'appointments.assign_tests', description: 'Assign or split tests to different centers/technicians' },
    { name: 'appointments.submit_qc', description: 'Submit reports for QC verification' },
    { name: 'appointments.qc_verify', description: 'Verify and approve QC reports' },
    { name: 'appointments.qc_pushback', description: 'Push back reports from QC to center for corrections' },
    { name: 'appointments.view_history', description: 'View appointment audit trail and status history' },
    { name: 'appointments.bulk_operations', description: 'Perform bulk updates on multiple appointments' },
    { name: 'appointments.lifecycle', description: 'View appointment lifecycle tracker' },

    { name: 'approvals.view', description: 'View approvals' },
    { name: 'approvals.process', description: 'Process approvals' },

    // TPA Management permissions
    { name: 'tpa_management.view', description: 'View TPA Management configurations' },
    { name: 'tpa_management.create', description: 'Create new TPA Management configurations' },
    { name: 'tpa_management.update', description: 'Update existing TPA Management configurations' },
    { name: 'tpa_management.delete', description: 'Delete TPA Management configurations (soft delete)' },
    { name: 'tpa_management.toggle_status', description: 'Toggle TPA Management active status' },
    { name: 'tpa_management.regenerate_key', description: 'Regenerate TPA Management API keys' },
];

const catalogMap = new Map(permissionCatalog.map((entry) => [entry.name, entry]));

/**
 * Resolve permission entries from names
 * @param {string[]} names - Array of permission names
 * @returns {Array} Array of permission objects
 */
function resolveEntries(names) {
    if (!Array.isArray(names) || names.length === 0) {
        return permissionCatalog;
    }

    return names.map((name) => {
        return (
            catalogMap.get(name) || {
                name,
                description: 'Auto-generated permission',
            }
        );
    });
}

/**
 * Ensure permission catalog is synchronized with the database
 * Inserts missing permissions from the catalog
 * @param {string[]} names - Optional array of specific permission names to sync
 */
async function ensurePermissionCatalog(names) {
    const entries = resolveEntries(names);

    if (!entries.length) {
        return;
    }

    const placeholders = entries.map(() => '?').join(', ');
    const existingRows = await db.query(
        `SELECT name FROM permissions WHERE name IN (${placeholders})`,
        entries.map((entry) => entry.name),
    );
    const existing = new Set(existingRows.map((row) => row.name));
    const missing = entries.filter((entry) => !existing.has(entry.name));

    if (!missing.length) {
        logger.info('Permission catalog is up to date', { total: entries.length });
        return;
    }

    const values = missing.map(() => '(?, ?)').join(', ');
    const params = missing.flatMap((entry) => [entry.name, entry.description]);

    try {
        await db.query(
            `INSERT INTO permissions (name, description) VALUES ${values}`,
            params,
        );
        logger.info('Permission catalog synchronized', {
            added: missing.length,
            total: entries.length
        });
    } catch (error) {
        logger.error('Failed to seed permissions catalog', {
            error: error.message,
        });
        throw error;
    }
}

module.exports = {
    permissionCatalog,
    ensurePermissionCatalog,
};
