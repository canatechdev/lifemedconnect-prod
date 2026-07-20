/**
 * Appointment Excel Operations
 * Handles Excel template generation and bulk import
 */

const ExcelJS = require('exceljs');
const xlsx = require('xlsx');
const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { appointmentCreateSchema } = require('../../validation/v_appointments');
const { getExportRemarksByAppointmentIds } = require('./AppointmentExportRemarks');

/**
 * Helper function to build date filter conditions
 * Supports multiple date fields and range types
 * @param {string} dateField - 'created_at', 'appointment_date', or 'confirmed_date'
 * @param {string} rangeType - 'today', 'tomorrow', 'upcoming', 'custom', 'monthly', 'yearly'
 * @param {object} dateParams - { fromDate, toDate, month, year }
 * @returns {object} { conditions: [], params: [] }
 */
function buildDateFilter(dateField = 'created_at', rangeType = '', dateParams = {}) {
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

    let dateColumn = 'a.created_at';
    
    if (dateField === 'appointment_date') {
        dateColumn = 'a.appointment_date';
    } else if (dateField === 'confirmed_date') {
        // For confirmed_date, check both confirmed_date and center/home confirmed timestamps
        // This will be handled specially below
    }

    switch (rangeType) {
        case 'today':
            if (dateField === 'confirmed_date') {
                conditions.push(`(DATE(a.confirmed_date) = DATE(?) OR DATE(a.center_confirmed_at) = DATE(?) OR DATE(a.home_confirmed_at) = DATE(?))`);
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
                conditions.push(`(DATE(a.confirmed_date) = DATE(?) OR DATE(a.center_confirmed_at) = DATE(?) OR DATE(a.home_confirmed_at) = DATE(?))`);
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
                conditions.push(`(DATE(a.confirmed_date) >= DATE(?) OR DATE(a.center_confirmed_at) >= DATE(?) OR DATE(a.home_confirmed_at) >= DATE(?))`);
                params.push(todayString, todayString, todayString);
            } else {
                if (dateField === 'appointment_date') {
                    conditions.push(`DATE(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) >= DATE(?)`);
                } else {
                    conditions.push(`DATE(${dateColumn}) >= DATE(?)`);
                }
                params.push(todayString);
            }
            break;

        case 'custom':
            if (dateParams.fromDate && dateParams.toDate) {
                if (dateField === 'confirmed_date') {
                    conditions.push(`(DATE(a.confirmed_date) BETWEEN DATE(?) AND DATE(?) OR DATE(a.center_confirmed_at) BETWEEN DATE(?) AND DATE(?) OR DATE(a.home_confirmed_at) BETWEEN DATE(?) AND DATE(?))`);
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
            if (dateParams.month && dateParams.year) {
                if (dateField === 'confirmed_date') {
                    conditions.push(`(MONTH(a.confirmed_date) = ? AND YEAR(a.confirmed_date) = ?) OR (MONTH(a.center_confirmed_at) = ? AND YEAR(a.center_confirmed_at) = ?) OR (MONTH(a.home_confirmed_at) = ? AND YEAR(a.home_confirmed_at) = ?)`);
                    params.push(parseInt(dateParams.month), parseInt(dateParams.year), parseInt(dateParams.month), parseInt(dateParams.year), parseInt(dateParams.month), parseInt(dateParams.year));
                } else {
                    if (dateField === 'appointment_date') {
                        conditions.push(`(MONTH(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = ? AND YEAR(CONVERT_TZ(${dateColumn}, '+00:00', @@global.time_zone)) = ?)`);
                    } else {
                        conditions.push(`(MONTH(${dateColumn}) = ? AND YEAR(${dateColumn}) = ?)`);
                    }
                    params.push(parseInt(dateParams.month), parseInt(dateParams.year));
                }
            }
            break;

        case 'yearly':
            if (dateParams.year) {
                if (dateField === 'confirmed_date') {
                    conditions.push(`(YEAR(a.confirmed_date) = ? OR YEAR(a.center_confirmed_at) = ? OR YEAR(a.home_confirmed_at) = ?)`);
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
const { createAppointment } = require('./AppointmentCRUD');

// Lazy getter to avoid circular require warnings
const getCreateWithApproval = () => {
    try {
        const approvalHelper = require('../../lib/approvalHelper');
        return approvalHelper?.createWithApproval;
    } catch (e) {
        logger.warn('createWithApproval not available (lazy load failed)', { error: e.message });
        return null;
    }
};

/**
 * Generate Excel template for appointment upload
 */
async function generateTemplate() {
    try {
        const workbook = new ExcelJS.Workbook();

        // Create main worksheet
        const worksheet = workbook.addWorksheet('Appointments Template');

        // Create Lists worksheet for dropdown options
        const listsWorksheet = workbook.addWorksheet('Lists');
        listsWorksheet.state = 'hidden';

        // Get data from database
        const clientsResult = await db.query('SELECT id, client_name FROM clients WHERE is_deleted=0');
        const insurersResult = await db.query('SELECT id, insurer_name FROM insurers WHERE is_deleted=0');

        // Extract rows
        const clients = Array.isArray(clientsResult) ? clientsResult : clientsResult?.rows || clientsResult?.[0] || [];
        const insurers = Array.isArray(insurersResult) ? insurersResult : insurersResult?.rows || insurersResult?.[0] || [];

        // Populate Lists sheet
        const listStartRow = 2;

        // Clients in column A
        listsWorksheet.getCell('A1').value = 'Clients';
        clients.forEach((c, index) => {
            listsWorksheet.getCell(`A${listStartRow + index}`).value = c.client_name;
        });

        // Store mapping for ID lookup during import
        listsWorksheet.getCell('Z1').value = 'Client Mapping';
        clients.forEach((c, index) => {
            listsWorksheet.getCell(`Z${listStartRow + index}`).value = c.id;
        });

        // Insurers in column B
        listsWorksheet.getCell('B1').value = 'Insurers';
        insurers.forEach((i, index) => {
            listsWorksheet.getCell(`B${listStartRow + index}`).value = i.insurer_name;
        });

        // Store mapping for ID lookup during import
        listsWorksheet.getCell('AA1').value = 'Insurer Mapping';
        insurers.forEach((i, index) => {
            listsWorksheet.getCell(`AA${listStartRow + index}`).value = i.id;
        });

        // Add title
        let currentRow = 1;
        worksheet.getRow(currentRow).values = ['APPOINTMENTS UPLOAD TEMPLATE'];
        worksheet.mergeCells(`A${currentRow}:N${currentRow}`);
        worksheet.getCell(`A${currentRow}`).font = { bold: true, size: 16 };
        worksheet.getCell(`A${currentRow}`).alignment = { horizontal: 'center' };
        currentRow++;

        // Add instructions
        const instructionsStart = currentRow;
        worksheet.getRow(currentRow).values = ['Instructions:'];
        currentRow++;
        worksheet.getRow(currentRow).values = ['- Fields marked with * are mandatory'];
        currentRow++;
        worksheet.getRow(currentRow).values = ['- Use dropdowns (small arrow in cell) to select from available options'];
        currentRow++;
        worksheet.getRow(currentRow).values = ['- Date format: YYYY-MM-DD (e.g., 2024-01-15)'];
        currentRow++;
        worksheet.getRow(currentRow).values = ['- Time format: HH:MM:SS (e.g., 14:30:00)'];
        currentRow++;
        worksheet.getRow(currentRow).values = ['- For dropdown fields, please select from the list only'];
        currentRow++;

        // Style instructions
        for (let i = instructionsStart; i < currentRow; i++) {
            worksheet.getRow(i).font = { italic: true, color: { argb: 'FF0000' } };
        }

        // Add empty row
        currentRow++;

        // Add header row
        const headerRow = currentRow;
        worksheet.getRow(headerRow).values = [
            'Application Number*', 'TPA', 'Insurer', 'Customer First Name', 'Customer Last Name',
            'Gender', 'Customer Mobile', 'Customer Alt No', 'Customer Service No', 'Customer Email', 'Customer Category',
            'Appointment Date* (YYYY-MM-DD)', 'Appointment Time (HH:MM:SS)', 'Visit Type',
            'Landmark', 'State', 'City', 'Pin Code', 'Country', 'Customer Address', 'Remarks'
        ];

        // Style the header row
        worksheet.getRow(headerRow).font = { bold: true, color: { argb: 'FFFFFF' } };
        worksheet.getRow(headerRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: '4472C4' }
        };

        // Set column widths
        const colWidths = [20, 25, 25, 20, 20, 15, 15, 15, 15, 25, 20, 20, 15, 20, 20, 20, 15, 10, 30, 20, 30];
        for (let c = 1; c <= colWidths.length; c++) {
            worksheet.getColumn(c).width = colWidths[c - 1];
        }

        // Predefined dropdown options
        const genderOptions = ['Male', 'Female', 'Other'];
        const visitTypeOptions = ['Home_Visit', 'Center_Visit', 'Both'];

        // Calculate first data row
        const firstDataRow = headerRow + 1;

        // Add data validation (dropdowns) for 100 rows
        for (let i = 0; i < 100; i++) {
            const row = firstDataRow + i;

            // Client dropdown (Column B)
            const clientFormula = `Lists!$A$${listStartRow}:$A$${listStartRow + clients.length - 1}`;
            worksheet.getCell(`B${row}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [clientFormula],
                showErrorMessage: true,
                errorTitle: 'Invalid Selection',
                error: 'Please select from the list of clients'
            };

            // Insurer dropdown (Column C)
            const insurerFormula = `Lists!$B$${listStartRow}:$B$${listStartRow + insurers.length - 1}`;
            worksheet.getCell(`C${row}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [insurerFormula],
                showErrorMessage: true,
                errorTitle: 'Invalid Selection',
                error: 'Please select from the list of insurers'
            };

            // Gender dropdown (Column F)
            worksheet.getCell(`F${row}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`"${genderOptions.join(',')}"`],
                showErrorMessage: true,
                errorTitle: 'Invalid Selection',
                error: 'Please select from: ' + genderOptions.join(', ')
            };

            // Customer Category dropdown (Column K)
            worksheet.getCell(`K${row}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: ['"Non_HNI,SUPER_HNI,HNI"'],
                showErrorMessage: true,
                errorTitle: 'Invalid Category',
                error: 'Please select from: Non_HNI, SUPER_HNI, HNI'
            };

            // Visit Type dropdown (Column N)
            worksheet.getCell(`N${row}`).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`"${visitTypeOptions.join(',')}"`],
                showErrorMessage: true,
                errorTitle: 'Invalid Selection',
                error: 'Please select from: ' + visitTypeOptions.join(', ')
            };

            
            // Remove date validation to allow users to edit dates freely
            // Users can enter dates in various formats and the backend will handle the parsing
        }

        // Add sample data row
        const sampleData = [
            'APP-001',
            clients.length > 0 ? clients[0].client_name : '',
            insurers.length > 0 ? insurers[0].insurer_name : '',
            'John', 'Doe', 'Male', '9876543210','','','john.doe@email.com', 'Non_HNI',
            '2024-01-15', '09:00:00', 'Home_Visit', 'Near Mall Road', 'Delhi', 'New Delhi',
            '110001', 'IN', '123 Main Street, XYZ Building', 'Initial appointment'
        ];

        worksheet.getRow(firstDataRow).values = sampleData;

        // Style the sample data row
        worksheet.getRow(firstDataRow).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'F0F0F0' }
        };

        return workbook;
    } catch (error) {
        logger.error('Error generating Excel template:', error);
        throw error;
    }
}

/**
 * Helper: Clean string values
 */
function cleanValue(value) {
    if (value === undefined || value === null || value === '') return null;
    return String(value).trim();
}

/**
 * Helper: Parse Excel date (handles both serial numbers and date strings)
 */
function parseExcelDate(value) {
    if (!value) return null;
    
    // If it's a number (Excel serial date)
    if (typeof value === 'number') {
        // Excel serial date starts from 1900-01-01
        const excelEpoch = new Date(1900, 0, 1);
        const date = new Date(excelEpoch.getTime() + (value - 2) * 86400000); // -2 for Excel bug
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // If it's already a string, try to parse it
    const cleaned = String(value).trim();
    
    // Check if it's already in YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
        return cleaned;
    }
    
    // Try to parse as date
    const date = new Date(cleaned);
    if (!isNaN(date.getTime())) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    return null;
}

/**
 * Helper: Parse Excel time (handles both serial numbers and time strings)
 */
function cleanTimeValue(value) {
    if (!value) return null;
    
    // If it's a number (Excel serial time - fraction of day)
    if (typeof value === 'number' && value < 1) {
        const totalSeconds = Math.round(value * 86400);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    
    const cleaned = String(value).trim();
    if (/^\d{2}:\d{2}:\d{2}$/.test(cleaned)) return cleaned;
    if (/^\d{2}:\d{2}$/.test(cleaned)) return cleaned + ':00';
    if (/^\d{1}:\d{2}:\d{2}$/.test(cleaned)) return '0' + cleaned;
    if (/^\d{1}:\d{2}$/.test(cleaned)) return '0' + cleaned + ':00';
    return null;
}

/**
 * Process uploaded Excel file and create appointments
 * @param {string} filePath - Path to uploaded Excel file
 * @param {Object} user - User object (id, role_id)
 * @returns {Promise<Object>} Result with insertedIds and failedRows
 */
async function processUploadedFile(filePath, user) {
    // Validate user object
    if (!user || !user.id || !user.role_id) {
        const error = new Error('User authentication required. Missing user.id or user.role_id');
        logger.error('Excel upload failed: Invalid user object', {
            hasUser: !!user,
            userId: user?.id,
            roleId: user?.role_id
        });
        throw error;
    }

    try {
        logger.info('Processing Excel file', { userId: user.id, roleId: user.role_id, filePath });

        const workbook = xlsx.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];

        // Convert sheet to JSON, starting from the header row (row 8)
        const rows = xlsx.utils.sheet_to_json(sheet, {
            header: [
                'application_number',
                'client_id',
                'insurer_id',
                'customer_first_name',
                'customer_last_name',
                'gender',
                'customer_mobile',
                'customer_alt_mobile',
                'customer_service_no',
                'customer_email',
                'customer_category',
                'appointment_date',
                'appointment_time',
                'visit_type',
                'customer_landmark',
                'state',
                'city',
                'pincode',
                'country',
                'customer_address',
                'remarks'
            ],
            range: 7, // Start from row 8 (0-based index: 7)
        });

        // Fetch valid IDs and names from database for validation
        const clientsResult = await db.query('SELECT id, client_name FROM clients WHERE is_deleted=0');
        const insurersResult = await db.query('SELECT id, insurer_name FROM insurers WHERE is_deleted=0');

        const clients = Array.isArray(clientsResult) ? clientsResult : clientsResult?.rows || clientsResult?.[0] || [];
        const insurers = Array.isArray(insurersResult) ? insurersResult : insurersResult?.rows || insurersResult?.[0] || [];

        // Create maps for name to ID lookup
        const clientNameToId = new Map(clients.map(c => [c.client_name.toLowerCase(), c.id]));
        const insurerNameToId = new Map(insurers.map(i => [i.insurer_name.toLowerCase(), i.id]));

        const validClientIds = new Set(clients.map(c => c.id));
        const validInsurerIds = new Set(insurers.map(i => i.id));

        const insertedIds = [];
        const failedRows = [];

        // SKIP THE HEADER ROW - start from index 1 instead of 0
        for (const [index, row] of rows.entries()) {
            // Skip the first row (header row)
            if (index === 0) continue;

            // Also skip empty rows
            if (!row.application_number && !row.client_id && !row.insurer_id) {
                continue;
            }

            try {
                // Parse ID from 'id - name' format or name-only
                const parseId = (value, fieldName, validIds, nameToIdMap) => {
                    if (!value) return null;
                    
                    // Check if it's in 'id - name' format (for backward compatibility)
                    const match = String(value).match(/^(\d+)\s*-\s*/);
                    if (match) {
                        const id = parseInt(match[1], 10);
                        if (!validIds.has(id)) {
                            throw new Error(`Invalid ${fieldName} ID: ${id} does not exist`);
                        }
                        return id;
                    }
                    
                    // If not in ID format, treat as name and lookup
                    const normalizedName = String(value).trim().toLowerCase();
                    const id = nameToIdMap.get(normalizedName);
                    
                    if (id === undefined) {
                        throw new Error(`Invalid ${fieldName} name: "${value}". Please select from the dropdown list.`);
                    }
                    
                    return id;
                };

                const cleanedRow = {
                    application_number: cleanValue(row.application_number),
                    client_id: parseId(row.client_id, 'client', validClientIds, clientNameToId),
                    insurer_id: parseId(row.insurer_id, 'insurer', validInsurerIds, insurerNameToId),
                    customer_first_name: cleanValue(row.customer_first_name),
                    customer_last_name: cleanValue(row.customer_last_name),
                    gender: cleanValue(row.gender),
                    customer_mobile: cleanValue(row.customer_mobile),
                    customer_alt_mobile: cleanValue(row.customer_alt_mobile),
                    customer_service_no: cleanValue(row.customer_service_no),
                    customer_email: cleanValue(row.customer_email),
                    customer_category: cleanValue(row.customer_category) || 'Non_HNI',
                    appointment_date: parseExcelDate(row.appointment_date),
                    appointment_time: cleanTimeValue(row.appointment_time),
                    visit_type: cleanValue(row.visit_type) || 'Home_Visit',
                    customer_landmark: cleanValue(row.customer_landmark),
                    state: cleanValue(row.state),
                    city: cleanValue(row.city),
                    pincode: cleanValue(row.pincode),
                    country: cleanValue(row.country) || 'IN',
                    customer_address: cleanValue(row.customer_address),
                    remarks: cleanValue(row.remarks),

                    // Optional/unavailable fields in template
                    // customer_alt_mobile: null,
                    customer_gps_latitude: null,
                    customer_gps_longitude: null,
                    test_name: null,
                    confirmed_time: null,
                    assigned_technician_id: null,
                    cost_type: null,
                    amount: null,
                    amount_upload: null,

                    created_by: user.id,
                    created_at: new Date(),
                };

                const { error, value } = appointmentCreateSchema.validate(cleanedRow, { stripUnknown: true });
                if (error) {
                    throw new Error(error.details[0].message);
                }

                // Business rule: if cost_type is Credit, amount should be null
                if (value.cost_type === 'Credit') {
                    value.amount = null;
                }

                // Check duplicate application_number BEFORE createWithApproval
                if (value.application_number) {
                    const [existing] = await db.query(
                        `SELECT id FROM appointments 
                            WHERE application_number = ? AND is_deleted = 0 
                            LIMIT 1`,
                        [value.application_number]
                    );

                    if (existing && existing.length > 0) {
                        throw new Error(
                            `Duplicate application_number: ${value.application_number}. An appointment already exists.`
                        );
                    }
                }


                if (typeof createWithApproval === 'function') {
                    const result = await createWithApproval({
                        entity_type: 'appointment_import',
                        createFunction: createAppointment,
                        data: value,
                        user
                    });
                    insertedIds.push(result.entity_id || result.id);
                } else {
                    // Fallback: create directly when approval helper is unavailable
                    logger.warn('createWithApproval not available, creating appointment directly (no approval)', {
                        userId: user.id,
                        roleId: user.role_id
                    });
                    const id = await createAppointment(value);
                    insertedIds.push(id);
                }

            } catch (error) {
                logger.error(`Error processing row ${index + 8}:`, error.message);
                failedRows.push({
                    rowNumber: index + 8,
                    row,
                    error: error.message
                });
            }
        }

        return {
            insertedIds,
            failedRows,
            message: `${insertedIds.length} appointments inserted`
        };

    } catch (error) {
        logger.error('Excel upload error:', error);
        throw error;
    }
}

/**
 * Get all appointments for export (no pagination)
 * Supports comprehensive filtering including month/year
 */
async function getAppointmentsForExport(filters = {}, user = null) {
    try {
        const {
            month,
            year,
            customerCategory,
            visitType,
            status,
            medicalStatus,
            qcStatus,
            search,
            dateField = 'created_at',
            rangeType = '',
            fromDate = '',
            toDate = '',
            centerIds = []
        } = filters;

        const conditions = ['a.is_deleted = 0'];  // get non deleted rows 
        const params = [];

        if (user?.diagnostic_center_id) {
            conditions.push('(a.center_id = ? OR a.other_center_id = ?)');
            params.push(user.diagnostic_center_id, user.diagnostic_center_id);
        }
        if (user?.insurer_id) {
            conditions.push('a.insurer_id = ?');
            params.push(user.insurer_id);
        }
        if (user?.client_id) {
            conditions.push('a.client_id = ?');
            params.push(user.client_id);
        }
        if (user?.technician_id || user?.assigned_technician_id) {
            const technicianId = user.technician_id || user.assigned_technician_id;
            conditions.push(`EXISTS (
                SELECT 1 FROM appointment_tests scope_at
                WHERE scope_at.appointment_id = a.id
                  AND scope_at.assigned_technician_id = ?
            )`);
            params.push(technicianId);
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
            params.push(...dateFilter.params);
        }
        // Note: Legacy month/year filtering completely removed to avoid conflicts

        // Other filters
        if (customerCategory) {
            conditions.push('a.customer_category = ?');
            params.push(customerCategory);
        }

        if (visitType) {
            conditions.push('a.visit_type = ?');
            params.push(visitType);
        }

        if (status) {
            conditions.push('a.status = ?');
            params.push(status);
        }

        if (medicalStatus && medicalStatus !== '') {
            conditions.push('(a.medical_status = ? OR a.center_medical_status = ? OR a.home_medical_status = ?)');
            params.push(medicalStatus, medicalStatus, medicalStatus);
        }

        if (qcStatus) {
            conditions.push('a.qc_status = ?');
            params.push(qcStatus);
        }

        // Diagnostic Center Filtering: Filter by center_id OR other_center_id (multiple centers support)
        if (centerIds && centerIds.length > 0) {
            const centerIdsInt = centerIds.map(id => parseInt(id)).filter(id => !isNaN(id));
            if (centerIdsInt.length > 0) {
                // Create placeholders for IN clause
                const placeholders = centerIdsInt.map(() => '?').join(',');
                conditions.push(`(a.center_id IN (${placeholders}) OR a.other_center_id IN (${placeholders}))`);
                params.push(...centerIdsInt, ...centerIdsInt);
            }
        }

        if (search) {
            conditions.push(`(
                a.case_number LIKE ? OR 
                a.application_number LIKE ? OR
                a.customer_first_name LIKE ? OR 
                a.customer_last_name LIKE ? OR
                a.customer_mobile LIKE ?
            )`);
            const like = `%${search}%`;
            params.push(like, like, like, like, like);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const sql = `
            SELECT 
                a.*,
                c.client_name,
                dc.center_name,
                odc.center_name as other_center_name,
                i.insurer_name,
                creator.full_name as created_by_name,
                updater.full_name as updated_by_name,
                -- Aggregate tests information
                (
                    SELECT GROUP_CONCAT(
                        DISTINCT CONCAT(
                            COALESCE(at.item_name, COALESCE(t.test_name, '')), 
                            CASE 
                                WHEN tc.category_name IS NOT NULL AND tc.category_name != '' THEN
                                    CONCAT(' (', tc.category_name, ')')
                                ELSE ''
                            END,
                            CASE 
                                WHEN at.assigned_technician_id IS NOT NULL THEN 
                                    CONCAT(' [Tech: ', COALESCE(tech.full_name, ''), ']')
                                ELSE ''
                            END
                        )
                        ORDER BY COALESCE(tc.category_name, ''), at.item_name
                        SEPARATOR ' | '
                    )
                    FROM appointment_tests at
                    LEFT JOIN tests t ON at.test_id = t.id AND t.is_deleted = 0
                    LEFT JOIN test_categories tc ON (at.category_id = tc.id OR t.category_id = tc.id) AND tc.is_deleted = 0
                    LEFT JOIN technicians tech ON at.assigned_technician_id = tech.id AND tech.is_deleted = 0
                    WHERE at.appointment_id = a.id
                ) as tests_info,
                -- Aggregate categories only
                (
                    SELECT GROUP_CONCAT(
                        DISTINCT COALESCE(tc.category_name, '')
                        ORDER BY tc.category_name
                        SEPARATOR ', '
                    )
                    FROM appointment_tests at
                    LEFT JOIN test_categories tc ON (at.category_id = tc.id) AND tc.is_deleted = 0
                    WHERE at.appointment_id = a.id AND tc.category_name IS NOT NULL
                ) as categories_info,
                -- Aggregate technicians only
                (
                    SELECT GROUP_CONCAT(
                        DISTINCT COALESCE(tech.full_name, '')
                        ORDER BY tech.full_name
                        SEPARATOR ', '
                    )
                    FROM appointment_tests at
                    LEFT JOIN technicians tech ON at.assigned_technician_id = tech.id AND tech.is_deleted = 0
                    WHERE at.appointment_id = a.id AND tech.full_name IS NOT NULL
                ) as technicians_info,
                -- Count of tests
                (
                    SELECT COUNT(*)
                    FROM appointment_tests at
                    WHERE at.appointment_id = a.id
                ) as test_count
            FROM appointments a
            LEFT JOIN clients c ON a.client_id = c.id
            LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
            LEFT JOIN diagnostic_centers odc ON a.other_center_id = odc.id
            LEFT JOIN insurers i ON a.insurer_id = i.id
            LEFT JOIN users creator ON a.created_by = creator.id
            LEFT JOIN users updater ON a.updated_by = updater.id
            ${whereClause}
            ORDER BY a.created_at DESC
        `;

        const appointments = await db.query(sql, params);
        return Array.isArray(appointments) ? appointments : [];

    } catch (error) {
        logger.error('Error fetching appointments for export:', error);
        throw error;
    }
}

/**
 * Generate comprehensive Excel export with all appointment fields
 */
async function generateExportExcel(appointments, filters = {}) {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Appointments Export');
        const exportRemarks = await getExportRemarksByAppointmentIds(appointments.map((apt) => apt.id));

        // Add filter info header
        let currentRow = 1;
        worksheet.getRow(currentRow).values = ['APPOINTMENTS EXPORT'];
        worksheet.mergeCells(`A${currentRow}:AL${currentRow}`);
        worksheet.getCell(`A${currentRow}`).font = { bold: true, size: 16 };
        worksheet.getCell(`A${currentRow}`).alignment = { horizontal: 'center' };
        currentRow++;

        // Add filter details
        if (filters.month || filters.year) {
            const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 
                              'July', 'August', 'September', 'October', 'November', 'December'];
            const filterText = filters.month 
                ? `Period: ${monthNames[parseInt(filters.month)]} ${filters.year}`
                : `Year: ${filters.year}`;
            worksheet.getRow(currentRow).values = [filterText];
            worksheet.getCell(`A${currentRow}`).font = { italic: true };
            currentRow++;
        }

        worksheet.getRow(currentRow).values = [`Export Date: ${new Date().toLocaleString('en-IN')}`];
        worksheet.getCell(`A${currentRow}`).font = { italic: true };
        currentRow++;
        worksheet.getRow(currentRow).values = [`Total Records: ${appointments.length}`];
        worksheet.getCell(`A${currentRow}`).font = { italic: true, bold: true };
        currentRow += 2;

        // Define only specified columns for export
        const headerRow = currentRow;
        const headers = [
            'Case Number', 'Application Number', 'Client', 'Center', 'Other Center', 'Insurer',
            'Customer First Name', 'Customer Last Name', 'Gender', 'Mobile', 'Alt Mobile', 'Service No',
            'Email', 'Address', 'State', 'City', 'Pincode', 'Country', 'Landmark',
            'Visit Type', 'Customer Category', 'Appointment Date', 'Confirmed Date', 'Appointment Time', 
            'Confirmed Time', 'Status', 'Medical Status', 'QC Status',
            'Cost Type', 'Amount',
            'Test Count', 'Categories', 'Tests', 'Assigned Technicians',
            'Remarks', 'Medical Remarks', 'All Remarks',
            'Created At'
        ];

        worksheet.getRow(headerRow).values = headers;

        // Style header
        const headerRowObj = worksheet.getRow(headerRow);
        headerRowObj.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRowObj.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF366092' }
        };
        headerRowObj.alignment = { horizontal: 'center', vertical: 'middle' };
        headerRowObj.height = 25;

        // Add data rows
        appointments.forEach((apt, index) => {
            const row = worksheet.getRow(headerRow + 1 + index);
            row.values = [
                apt.case_number,
                apt.application_number,
                apt.client_name || '',
                apt.center_name || '',
                apt.other_center_name || '',
                apt.insurer_name || '',
                apt.customer_first_name,
                apt.customer_last_name,
                apt.gender,
                apt.customer_mobile,
                apt.customer_alt_mobile,
                apt.customer_service_no,
                apt.customer_email,
                apt.customer_address,
                apt.state,
                apt.city,
                apt.pincode,
                apt.country,
                apt.customer_landmark,
                apt.visit_type,
                apt.customer_category,
                apt.appointment_date ? new Date(apt.appointment_date).toLocaleDateString('en-IN') : '',
                apt.confirmed_date ? new Date(apt.confirmed_date).toLocaleDateString('en-IN') : '',
                apt.appointment_time || '',
                apt.confirmed_time || '',
                apt.status,
                apt.medical_status,
                apt.qc_status,
                apt.cost_type,
                apt.amount,
                apt.test_count || 0,
                apt.categories_info || '',
                apt.tests_info || '',
                apt.technicians_info || '',
                apt.remarks,
                apt.medical_remarks,
                exportRemarks.get(Number(apt.id)) || '',
                apt.created_at ? new Date(apt.created_at).toLocaleString('en-IN') : ''
            ];
        });

        // Auto-fit columns with custom widths for test-related columns
        worksheet.columns.forEach((column, index) => {
            let maxLength = headers[index]?.length || 10;
            column.eachCell({ includeEmpty: false }, (cell) => {
                const cellLength = cell.value ? cell.value.toString().length : 0;
                if (cellLength > maxLength) {
                    maxLength = cellLength;
                }
            });
            
            // Set custom widths for test-related columns
            const columnName = headers[index];
            if (columnName === 'Categories') {
                column.width = Math.min(maxLength + 5, 40);
            } else if (columnName === 'Tests') {
                column.width = Math.min(maxLength + 10, 80); // Wider for detailed test info
            } else if (columnName === 'Assigned Technicians') {
                column.width = Math.min(maxLength + 5, 50);
            } else if (columnName === 'Test Count') {
                column.width = 15; // Fixed width for count
            } else if (columnName === 'All Remarks') {
                column.width = 60;
            } else {
                column.width = Math.min(maxLength + 2, 50);
            }
        });

        // Add borders to all cells
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber >= headerRow) {
                row.eachCell((cell) => {
                    cell.border = {
                        top: { style: 'thin' },
                        left: { style: 'thin' },
                        bottom: { style: 'thin' },
                        right: { style: 'thin' }
                    };
                });
            }
        });

        return workbook;

    } catch (error) {
        logger.error('Error generating export Excel:', error);
        throw error;
    }
}

module.exports = {
    generateTemplate,
    processUploadedFile,
    getAppointmentsForExport,
    generateExportExcel
};
