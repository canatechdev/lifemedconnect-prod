const Joi = require('joi');
const fs = require('fs');
const ExcelJS = require('exceljs');
const pool = require('../lib/dbconnection');
const path = require('path');
const { parsePaginationParams, calculatePagination } = require('../lib/helpers');
const logger = require('../lib/logger');
const ApiResponse = require('../lib/response');
const BaseService = require('../lib/baseService');

const UPLOAD_DIR = path.join(__dirname, '../uploads/logs');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Service layer for test bulk operations
 * Extends BaseService for standard CRUD operations
 */
class TestBulkService extends BaseService {
  constructor() {
    super('bulk_test_rates');
  }

  /**
   * Upsert master record (test or category)
   * @param {Object} conn - Database connection
   * @param {string} type - 'test' or 'category'
   * @param {string} name - Name of the item
   * @param {string} code - Code (for tests only)
   * @param {string} description - Description
   * @returns {Promise<number>} ID of the created/existing record
   */
  async upsertMaster(conn, type, name, code, description) {
    const table = type === 'test' ? 'tests' : 'test_categories';
    const nameCol = type === 'test' ? 'test_name' : 'category_name';
    const codeCol = type === 'test' ? 'test_code' : null;

    const normalized = name.trim().toLowerCase();

    // 1. Look for existing (case-insensitive)
    const [[existing]] = await conn.query(
      `SELECT id FROM ${table} WHERE LOWER(${nameCol}) = ? AND is_active = 1 AND is_deleted = 0`,
      [normalized]
    );

    if (existing) return existing.id;

    // 2. Insert new master
    const insertFields = [name];
    const insertPlaceholders = ['?'];
    if (codeCol) {
      insertFields.push(code);
      insertPlaceholders.push('?');
    }
    if (description) {
      insertFields.push(description);
      insertPlaceholders.push('?');
    } else {
      insertFields.push(null);
      insertPlaceholders.push('NULL');
    }

    const sql = `INSERT INTO ${table} (${nameCol}${codeCol ? ', ' + codeCol : ''}, created_by, created_at) VALUES (${insertPlaceholders.join(', ')}, ?, NOW())`;
    insertFields.push(1); // created_by

    const [result] = await conn.query(sql, insertFields);
    return result.insertId;
  }

  /**
   * Get rate for specific client/insurer/test combination
   * @param {Object} params - Query parameters
   * @returns {Promise<number|null>} Rate or null
   */
  async getRate({ client_id, insurer_id, test_id, category_id }) {
    const item_type = test_id ? 'test' : 'category';
    const master_id = test_id || category_id;

    const [rows] = await pool.pool.query(
      `SELECT rate FROM bulk_test_rates 
     WHERE client_id = ? AND insurer_id = ? AND ${item_type}_id = ? AND is_active = 1
     LIMIT 1`,
      [client_id, insurer_id, master_id]
    );
    return rows[0]?.rate || null;
  }

  /**
   * Extract data from query result
   * @param {Array} result - Query result
   * @param {string} field - Field name to extract
   * @returns {Array} Extracted values
   */
  extractDataFromResult(result, field) {
    const rows = result?.[0] || [];
    return rows.map(row => String(row[field] || '')).filter(Boolean);
  }

  // ===================================
  // DOWNLOAD RATES TEMPLATE
  // ===================================

  async downloadRatesTemplate(req, res) {
    try {
      logger.info("Generating rates template download");

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet("Rates Upload Template");
      const lists = workbook.addWorksheet("Lists");
      lists.state = "hidden";

      // Fetch lists
      const [clientsRes, insurersRes, testsRes] = await Promise.all([
        pool.pool.query(
          "SELECT short_code FROM clients WHERE is_deleted = 0 AND has_pending_approval=0 ORDER BY short_code"
        ),
        pool.pool.query(
          "SELECT short_code FROM insurers WHERE is_deleted = 0 AND has_pending_approval=0 ORDER BY short_code"
        ),
        pool.pool.query(
          "SELECT test_name FROM tests WHERE is_deleted = 0 AND has_pending_approval=0 ORDER BY test_name"
        ),
      ]);

      const clients = this.extractDataFromResult(clientsRes, "short_code");
      const insurers = this.extractDataFromResult(insurersRes, "short_code");
      const tests = this.extractDataFromResult(testsRes, "test_name");

      // Add lists in hidden sheet
      lists.getColumn(1).values = ["Clients", ...clients];
      lists.getColumn(2).values = ["Insurers", ...insurers];
      lists.getColumn(3).values = ["Tests", ...tests];

      // ---- Worksheet Header ----
      ws.getRow(1).values = [
        "Client Short Code",
        "Insurer Short Code",
        "Type",
        "Test Name",
        "Description",
        "Rate",
      ];

      ws.getRow(1).font = { bold: true };
      ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
      ws.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE6E6FA" },
      };

      // ---- Set Column Widths ----
      ws.columns = [
        { width: 20 }, // Client
        { width: 20 }, // Insurer
        { width: 10 }, // Type
        { width: 35 }, // Test Name
        { width: 40 }, // Description
        { width: 12 }, // Rate
      ];

      // ---- Data validations ----
      const maxRows = 5000;

      // Client dropdown
      ws.dataValidations.add(`A2:A${maxRows}`, {
        type: "list",
        allowBlank: true,
        formulae: [`Lists!$A$2:$A$${clients.length + 1}`],
      });

      // Insurer dropdown
      ws.dataValidations.add(`B2:B${maxRows}`, {
        type: "list",
        allowBlank: true,
        formulae: [`Lists!$B$2:$B$${insurers.length + 1}`],
      });

      // Type fixed = test
      for (let i = 2; i <= maxRows; i++) {
        ws.getCell(`C${i}`).value = "test";
      }

      // ---- Test Name dropdown ----
      ws.dataValidations.add(`D2:D${maxRows}`, {
        type: "list",
        allowBlank: true,
        formulae: [`Lists!$C$2:$C$${tests.length + 1}`],
      });

      // ---- Send File ----
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=rates-upload-template.xlsx"
      );

      await workbook.xlsx.write(res);
      res.end();

      logger.info("Rates template downloaded successfully");
    } catch (error) {
      logger.error("Failed to generate rates template", {
        error: error.message,
        stack: error.stack,
      });
      return ApiResponse.error(res, "Failed to generate template", 500, error.message);
    }
  }



  // ===================================
  // DOWNLOAD COLORED LOG
  // ===================================

  async downloadColoredLog(req, res) {
    const { logId } = req.params;
    const { created_by } = req.query;

    try {
      logger.info('Downloading colored log file', { logId, created_by });

      const [[log]] = await pool.pool.query(
        'SELECT * FROM bulk_upload_logs WHERE id = ? AND (created_by = ? OR ? IS NULL)',
        [logId, created_by || null, created_by]
      );

      if (!log) {
        logger.warn('Log file not found', { logId, created_by });
        return ApiResponse.error(res, 'Log not found', 404);
      }

      const { file_path, summary, errors, original_filename } = log;
      if (!fs.existsSync(file_path)) {
        logger.warn('Physical file not found', { file_path });
        return ApiResponse.error(res, 'File not found', 404);
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(file_path);
      const ws = workbook.worksheets[0];

      // Parse summary and errors
      let summaryData = {};
      let errorData = [];
      try {
        summaryData = JSON.parse(summary || '{}');
        errorData = JSON.parse(errors || '[]');
      } catch (e) {
        logger.warn('Failed to parse log data', { error: e.message });
      }

      // Color cells based on errors
      errorData.forEach(err => {
        if (err.row && ws.getRow(err.row)) {
          const row = ws.getRow(err.row);
          row.eachCell((cell, colNumber) => {
            if (cell.value) {
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFF0000' } // Red background
              };
              cell.font = { color: { argb: 'FFFFFFFF' } }; // White text
            }
          });
        }
      });

      // Create response
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=colored-${original_filename || 'log.xlsx'}`);
      await workbook.xlsx.write(res);
      res.end();

      logger.info('Colored log downloaded successfully', { logId });

    } catch (error) {
      logger.error('Failed to process log file', {
        error: error.message,
        stack: error.stack,
        logId
      });
      return ApiResponse.error(res, 'Failed to process log file', 500, error.message);
    }
  }

  // ===================================
  // DOWNLOAD MY RATES
  // ===================================

  async downloadMyRates(req, res) {
    const { short_code_client, short_code_insurer } = req.query;

    try {
      logger.info('Generating my rates download', { short_code_client, short_code_insurer });

      let sql = `
        SELECT 
          c.short_code AS short_code_client,
          i.short_code AS short_code_insurer,
          btr.item_type,
          btr.item_name,
          btr.item_code,
          btr.description,
          btr.rate
        FROM bulk_test_rates btr
        JOIN clients c ON btr.client_id = c.id
        JOIN insurers i ON btr.insurer_id = i.id
        WHERE btr.is_active = 1
      `;
      const params = [];

      if (short_code_client) {
        sql += ' AND c.short_code = ?';
        params.push(short_code_client);
      }

      if (short_code_insurer) {
        sql += ' AND i.short_code = ?';
        params.push(short_code_insurer);
      }

      sql += ' ORDER BY c.short_code, i.short_code, btr.item_type, btr.item_name';

      const [rows] = await pool.pool.query(sql, params);

      if (rows.length === 0) {
        return ApiResponse.error(res, 'No rates found for the specified criteria', 404);
      }

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('My Rates');

      // Headers
      ws.getRow(1).values = ['Client', 'Insurer', 'Type', 'Test/Category', 'Code', 'Description', 'Rate'];
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };

      // Data
      rows.forEach(row => {
        ws.addRow([
          row.short_code_client,
          row.short_code_insurer,
          row.item_type,
          row.item_name,
          row.item_code || '',
          row.description || '',
          row.rate
        ]);
      });

      // Column widths
      ws.columns = [
        { width: 15 }, // Client
        { width: 15 }, // Insurer
        { width: 10 }, // Type
        { width: 30 }, // Test/Category
        { width: 15 }, // Code
        { width: 40 }, // Description
        { width: 12 }  // Rate
      ];

      // Response headers
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=my-rates.xlsx');
      await workbook.xlsx.write(res);
      res.end();

      logger.info('My rates downloaded successfully', { count: rows.length });

    } catch (error) {
      logger.error('Failed to generate rates file', {
        error: error.message,
        stack: error.stack,
        query: req.query
      });
      return ApiResponse.error(res, 'Failed to generate rates file', 500, error.message);
    }
  }

  // ===================================
  // UPLOAD RATES
  // ===================================

  async uploadRates(req, res) {
    const created_by = req.user.id;
    const { needsApproval } = require('../lib/approvalHelper');
    const approvalService = require('./approvals');
    let conn;

    try {
      logger.info('Starting bulk rates upload', { created_by });

      if (!created_by) {
        return ApiResponse.error(res, 'User not authenticated', 400);
      }

      if (!req.file) {
        return ApiResponse.error(res, 'No file uploaded', 400);
      }

      const workbook = new ExcelJS.Workbook();

      // Persist uploaded Excel to disk (multer uses memoryStorage, so req.file.buffer is set)
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const safeOriginalName = (req.file.originalname || 'rates-upload.xlsx').replace(/[^\w.-]/g, '_');
      const savedFilename = `${uniqueSuffix}_${safeOriginalName}`;
      const savedFilePath = path.join(UPLOAD_DIR, savedFilename);

      if (req.file.buffer) {
        fs.writeFileSync(savedFilePath, req.file.buffer);
      } else if (req.file.path) {
        // Backward-compatibility in case disk storage is ever used again
        if (fs.existsSync(req.file.path)) {
          fs.copyFileSync(req.file.path, savedFilePath);
        }
      }

      // Load workbook either from memory buffer or from the saved file
      if (req.file.buffer) {
        await workbook.xlsx.load(req.file.buffer);
      } else {
        const fileData = fs.readFileSync(savedFilePath);
        await workbook.xlsx.load(fileData);
      }

      const sheet = workbook.worksheets[0];
      const dataRows = [];
      let totalRows = 0;

      // Read all rows (skip header)
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // header
        totalRows++;
        const values = row.values;
        const hasData = values && values.slice(1).some(cell => cell != null && String(cell).trim() !== '');
        if (hasData) dataRows.push({ values, rowNumber });
      });

      if (dataRows.length === 0) {
        return ApiResponse.error(res, 'No data found in the uploaded file', 400);
      }

      const requiresApproval = needsApproval(req.user.role_id, req.user.permissions);
      conn = await pool.pool.getConnection();
      await conn.beginTransaction();

      const newRecords = [];
      const updatedRecords = [];
      const newApprovalRecords = [];
      const updatedOldRecords = [];
      const updatedNewRecords = [];
      const errors = []; // Collect errors during processing
      

      for (const { values, rowNumber } of dataRows) {
        const [
          , // index 0 = undefined
          clientShortCode,
          insurerShortCode,
          type,
          itemNameRaw,
          description,
          rateStr
        ] = values || [];

        // Normalize inputs
        const clientCode = String(clientShortCode || '').trim();
        const insurerCode = String(insurerShortCode || '').trim();
        const itemType = String(type || '').trim().toLowerCase();
        const itemName = String(itemNameRaw || '').trim();
        const desc = String(description || '').trim();
        // Preserve numeric zero; it is a valid rate and must not be treated as blank.
        const rateInput = rateStr === null || rateStr === undefined
          ? ''
          : String(rateStr).trim();

        try {
          // Required fields validation
          if (!clientCode || !insurerCode || !itemType || !itemName || !rateInput)
            throw new Error('Missing required fields');

          if (!['test', 'category'].includes(itemType))
            throw new Error('Type must be "test" or "category"');

          const rate = parseFloat(rateInput);
          if (isNaN(rate) || rate < 0)
            throw new Error('Rate must be a valid positive number');

          // Get client and insurer IDs
          const [[client]] = await conn.query(
            'SELECT id FROM clients WHERE short_code = ? AND is_deleted = 0 AND has_pending_approval=0',
            [clientCode]
          );
          if (!client) throw new Error(`Client "${clientCode}" not found`);

          const [[insurer]] = await conn.query(
            'SELECT id FROM insurers WHERE short_code = ? AND is_deleted = 0 AND has_pending_approval=0',
            [insurerCode]
          );
          if (!insurer) throw new Error(`Insurer "${insurerCode}" not found`);

          // Upsert master record
          const masterId = await this.upsertMaster(conn, itemType, itemName, null, desc);

          // Check if rate already exists (fetch full row for approval logging)
          const [[existingRate]] = await conn.query(
            `SELECT * FROM bulk_test_rates 
             WHERE client_id = ? AND insurer_id = ? AND ${itemType}_id = ? AND is_active = 1`,
            [client.id, insurer.id, masterId]
          );

          if (existingRate) {
            // Capture old and new data for approval display
            const oldRecord = { ...existingRate };
            const newRecord = { ...existingRate, rate, updated_by: created_by };

            await conn.query(
              `UPDATE bulk_test_rates 
               SET rate = ?, updated_by = ?, updated_at = NOW() 
               WHERE id = ?`,
              [rate, created_by, existingRate.id]
            );

            updatedRecords.push({ row: rowNumber, item: itemName, action: 'updated' });
            if (requiresApproval) {
              updatedOldRecords.push(oldRecord);
              updatedNewRecords.push(newRecord);
            }
          } else {
            // Insert new rate and capture its ID
            const isActive = requiresApproval ? 0 : 1;
            const pendingFlag = requiresApproval ? 1 : 0;

            const [insertResult] = await conn.query(
              `INSERT INTO bulk_test_rates 
               (client_id, insurer_id, ${itemType}_id, item_type, item_name, item_code, description, rate, 
                created_by, created_at, is_active, has_pending_approval) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
              [
                client.id,
                insurer.id,
                masterId,
                itemType,
                itemName,
                null, // item_code
                desc,
                rate,
                created_by,
                isActive,
                pendingFlag
              ]
            );

            const insertedId = insertResult.insertId;
            newRecords.push({ id: insertedId, row: rowNumber, item: itemName, action: 'created' });

            if (requiresApproval) {
              newApprovalRecords.push({
                id: insertedId,
                item_type: itemType,
                item_name: itemName,
                description: desc,
                rate,
                client_id: client.id,
                insurer_id: insurer.id
              });
            }
          }

        } catch (rowError) {
          // Log error for this row but continue processing
          logger.warn('Error processing row', {
            row: rowNumber,
            item: itemName,
            error: rowError.message
          });
          // Continue to next row
          errors.push({ row: rowNumber, error: rowError.message });
        }
      }

      // Create upload log
      const summary = {
        total_rows: totalRows,
        processed_rows: dataRows.length,
        new_records: newRecords.length,
        updated_records: updatedRecords.length,
        // Only effectively requires approval if there are new records to approve
        requires_approval: requiresApproval && newRecords.length > 0
      };

      // errors array already declared above

      // Determine status based on errors and approval requirements
      let status = 'success';
      if (errors.length > 0) {
        status = 'failed';
      } else if (requiresApproval && newRecords.length > 0) {
        status = 'partial'; // Records created but pending approval
      }

      const [logResult] = await conn.query(
        `INSERT INTO bulk_upload_logs 
         (upload_type, original_filename, file_path, summary, errors, created_by, created_at, status, processed_rows) 
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [
          'rates',
          req.file.originalname,
          savedFilePath,
          JSON.stringify(summary),
          JSON.stringify(errors),
          created_by,
          status,
          dataRows.length
        ]
      );

      // Submit for approval if required
      let approvalId = null;
      if (requiresApproval) {
        // New records: bulk_create as test_rate_import for nicer display
        if (newApprovalRecords.length > 0) {
          approvalId = await approvalService.createApprovalRequest({
            entity_type: 'test_rate_import',
            entity_id: newApprovalRecords[0].id,
            action_type: 'bulk_create',
            old_data: null,
            new_data: newApprovalRecords,
            changes_summary: `Bulk upload of ${newApprovalRecords.length} new test rates`,
            requested_by: created_by,
            notes: `Bulk upload of ${newApprovalRecords.length} new test rates`,
            priority: 'medium'
          }, conn);
        }

        // Updated records: bulk_update as test_rate so edits appear in approvals
        if (updatedOldRecords.length > 0 && updatedNewRecords.length === updatedOldRecords.length) {
          await approvalService.createApprovalRequest({
            entity_type: 'test_rate',
            entity_id: updatedOldRecords[0].id,
            action_type: 'bulk_update',
            old_data: updatedOldRecords,
            new_data: updatedNewRecords,
            changes_summary: `Bulk update of ${updatedNewRecords.length} test rates`,
            requested_by: created_by,
            notes: `Bulk upload edited ${updatedNewRecords.length} existing test rates`,
            priority: 'medium'
          }, conn);

          const updatedIds = updatedOldRecords.map(r => r.id).filter(Boolean);
          if (updatedIds.length > 0) {
            const placeholders = updatedIds.map(() => '?').join(',');
            await conn.query(
              `UPDATE bulk_test_rates SET has_pending_approval = 1 WHERE id IN (${placeholders})`,
              updatedIds
            );
          }
        }
      }

      await conn.commit();

      const message = status === 'partial'
        ? 'Upload completed successfully. Records have been submitted for Super Admin approval.'
        : status === 'success'
          ? 'Upload completed successfully'
          : 'Upload completed with errors';

      res.json({
        message,
        summary: summary,
        errors: errors,
        log_id: logResult.insertId,
        approval_id: approvalId,
        status: status
      });

    } catch (error) {
      if (conn) await conn.rollback();
      logger.error('Bulk rates upload failed', {
        error: error.message,
        stack: error.stack,
        created_by,
        filename: req.file?.originalname
      });
      return ApiResponse.error(res, 'Transaction failed', 500, error.message);
    } finally {
      if (conn) conn.release();
    }
  }

  // ===================================
  // GET TEST RATES UPLOAD LOGS
  // ===================================

  async getTestRatesUploadLogs(req, res) {
    try {
      logger.info('Getting test rates upload logs', { query: req.query });

      const { numericPage, numericLimit, search, sortBy, sortOrder } = parsePaginationParams(req.query);
      const { status, start_date, end_date } = req.query;

      let sql = `
        SELECT 
          bul.*,
          u.full_name as created_by_name,
          u.username as created_by_username
        FROM bulk_upload_logs bul
        LEFT JOIN users u ON bul.created_by = u.id
        WHERE bul.upload_type = 'rates'
      `;
      const params = [];

      // Add filters
      if (status) {
        sql += ' AND bul.status = ?';
        params.push(status);
      }

      if (start_date) {
        sql += ' AND DATE(bul.created_at) >= ?';
        params.push(start_date);
      }

      if (end_date) {
        sql += ' AND DATE(bul.created_at) <= ?';
        params.push(end_date);
      }

      if (search) {
        sql += ' AND (bul.original_filename LIKE ? OR u.full_name LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
      }

      // Count total
      const countSql = sql.replace(/SELECT.*?FROM/, 'SELECT COUNT(*) as total FROM');
      const [countResult] = await pool.pool.query(countSql, params);
      const total = countResult[0].total;

      // Add sorting and pagination
      const allowedSortColumns = ['id', 'original_filename', 'status', 'created_at', 'created_by_name'];
      const validSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'id';
      const validSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

      sql += ` ORDER BY ${validSortBy} ${validSortOrder}`;

      if (numericLimit > 0) {
        const offset = (numericPage - 1) * numericLimit;
        sql += ` LIMIT ${numericLimit} OFFSET ${offset}`;
      }

      const [logs] = await pool.pool.query(sql, params);

      // Parse summary for each log
      // const processedLogs = logs.map(log => ({
      //   ...log,
      //   summary: log.summary ? JSON.parse(log.summary) : {},
      //   errors: log.errors ? JSON.parse(log.errors) : []
      // }));
      const processedLogs = logs.map(log => {
        let summary = {};
        let errors = [];

        try {
          summary =
            typeof log.summary === "string"
              ? JSON.parse(log.summary)
              : log.summary || {};
        } catch { }

        try {
          errors =
            typeof log.errors === "string"
              ? JSON.parse(log.errors)
              : log.errors || [];
        } catch { }

        return { ...log, summary, errors };
      });

      const pagination = {
        ...calculatePagination(total, numericPage, numericLimit),
        total_records: total
      };

      return ApiResponse.paginated(res, processedLogs, pagination);

    } catch (error) {
      logger.error('Failed to fetch upload logs', {
        error: error.message,
        stack: error.stack,
        query: req.query
      });
      return ApiResponse.error(res, 'Failed to fetch upload logs', 500, error.message);
    }
  }
}

// Create and export instance
const testBulkService = new TestBulkService();

// Export bound methods for backward compatibility
module.exports = {
  downloadRatesTemplate: testBulkService.downloadRatesTemplate.bind(testBulkService),
  downloadColoredLog: testBulkService.downloadColoredLog.bind(testBulkService),
  downloadMyRates: testBulkService.downloadMyRates.bind(testBulkService),
  uploadRates: testBulkService.uploadRates.bind(testBulkService),
  upsertMaster: testBulkService.upsertMaster.bind(testBulkService),
  getRate: testBulkService.getRate.bind(testBulkService),
  extractDataFromResult: testBulkService.extractDataFromResult.bind(testBulkService),
  getTestRatesUploadLogs: testBulkService.getTestRatesUploadLogs.bind(testBulkService)
};
