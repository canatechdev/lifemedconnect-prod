const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('../lib/dbconnection');
const logger = require('../lib/logger');
const ApiResponse = require('../lib/response');

const UPLOAD_DIR = path.join(__dirname, '../uploads/logs');
const CLEAR_VALUE = '__CLEAR__';
const REPORT_TYPES = new Set(['pathology', 'cardiology', 'radiology', 'mer', 'mtrf', 'other']);
const REQUIRED_HEADERS = ['test name', 'description', 'report type'];

class ImportValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function isClearValue(value) {
  return normalizeKey(value) === CLEAR_VALUE.toLowerCase();
}

function cellText(cell) {
  if (!cell || cell.value === null || cell.value === undefined) return '';
  return normalizeText(cell.text || cell.value);
}

function parseOptionalText(raw) {
  if (!raw) return undefined;
  return isClearValue(raw) ? null : normalizeText(raw);
}

function parseOptionalReportType(raw) {
  if (!raw) return undefined;
  if (isClearValue(raw)) return null;
  const reportType = normalizeKey(raw);
  if (!REPORT_TYPES.has(reportType)) {
    throw new Error(`Report Type must be one of: ${Array.from(REPORT_TYPES).join(', ')}`);
  }
  return reportType;
}

function generateTestCode(usedCodes) {
  const now = new Date();
  const year = String(now.getFullYear()).slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const expression = new RegExp(`^TST/${year}/${month}/(\\d+)$`, 'i');
  let lastNumber = 0;

  for (const code of usedCodes) {
    const match = String(code || '').match(expression);
    if (match) lastNumber = Math.max(lastNumber, Number(match[1]));
  }

  let candidate;
  do {
    lastNumber += 1;
    candidate = `TST/${year}/${month}/${String(lastNumber).padStart(4, '0')}`;
  } while (usedCodes.has(normalizeKey(candidate)));

  usedCodes.add(normalizeKey(candidate));
  return candidate;
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null);
}

class TestMasterBulkService {
  async downloadTemplate(req, res) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Test Master Upload');
    const lists = workbook.addWorksheet('Lists');
    const instructions = workbook.addWorksheet('Instructions');
    lists.state = 'hidden';

    sheet.columns = [{ width: 38 }, { width: 55 }, { width: 20 }];
    sheet.getRow(1).values = ['Test Name', 'Description', 'Report Type'];
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6E6FA' } };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    lists.getColumn(1).values = ['Report Types', ...Array.from(REPORT_TYPES)];
    sheet.dataValidations.add('C2:C5000', {
      type: 'list',
      allowBlank: true,
      formulae: [`Lists!$A$2:$A$${REPORT_TYPES.size + 1}`]
    });

    instructions.columns = [{ width: 90 }];
    instructions.getCell('A1').value = 'Test Name is required. Existing non-deleted Test Names update their Description and Report Type; a new name creates a new Test Master record.';
    instructions.getCell('A2').value = 'Leave Description or Report Type blank to preserve an existing value. Use __CLEAR__ to clear Description or Report Type. New Test Codes are generated automatically.';
    instructions.getCell('A3').value = 'Allowed Report Types: pathology, cardiology, radiology, mer, mtrf, other.';
    instructions.getColumn(1).alignment = { wrapText: true, vertical: 'top' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=test-master-upload-template.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  }

  async uploadTestMaster(req, res) {
    const createdBy = req.user?.id;
    let connection;
    let savedFilePath;
    let originalFilename;
    let parsedRows = [];

    if (!createdBy) return ApiResponse.unauthorized(res, 'User not authenticated');
    if (!req.file?.buffer) return ApiResponse.error(res, 'Upload an Excel file using the excelFile field', 400);

    try {
      originalFilename = req.file.originalname || 'test-master-upload.xlsx';
      savedFilePath = this.saveUploadedFile(req.file);
      parsedRows = await this.readRows(req.file.buffer);

      if (!parsedRows.length) {
        await this.createFailureLog({
          createdBy,
          originalFilename,
          savedFilePath,
          totalRows: 0,
          errors: [{ row: null, error: 'No data rows found in the uploaded file' }]
        });
        return ApiResponse.validationError(res, { errors: [{ row: null, error: 'No data rows found in the uploaded file' }] });
      }

      connection = await db.pool.getConnection();
      await connection.beginTransaction();

      const existingTests = await this.getExistingTests(connection);
      const plan = await this.buildImportPlan(connection, parsedRows, existingTests);

      if (plan.errors.length) {
        await connection.rollback();
        connection.release();
        connection = null;

        const logId = await this.createFailureLog({
          createdBy,
          originalFilename,
          savedFilePath,
          totalRows: parsedRows.length,
          errors: plan.errors
        });

        return ApiResponse.validationError(res, {
          summary: { total_rows: parsedRows.length, created: 0, updated: 0 },
          errors: plan.errors,
          log_id: logId
        }, 'Test Master import rejected. No changes were made.');
      }

      const result = await this.applyPlan(connection, plan.rows, createdBy);
      const summary = {
        total_rows: parsedRows.length,
        created: result.created.length,
        updated: result.updated.length,
        unchanged: result.unchanged.length
      };

      const [logResult] = await connection.query(
        `INSERT INTO bulk_upload_logs
          (upload_type, original_filename, file_path, summary, errors, created_by, created_at, status, processed_rows)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), 'success', ?)`,
        ['test_master', originalFilename, savedFilePath, JSON.stringify(summary), JSON.stringify([]), createdBy, parsedRows.length]
      );

      await connection.commit();
      connection.release();
      connection = null;

      logger.info('Test Master bulk import completed', {
        userId: createdBy,
        totalRows: parsedRows.length,
        created: result.created.length,
        updated: result.updated.length,
        unchanged: result.unchanged.length,
        logId: logResult.insertId
      });

      return ApiResponse.success(res, {
        summary,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        log_id: logResult.insertId
      }, 'Test Master import completed successfully');
    } catch (error) {
      if (connection) {
        try { await connection.rollback(); } catch (_) { /* original error is more useful */ }
        connection.release();
      }

      logger.error('Test Master bulk import failed', {
        userId: createdBy,
        error: error.message,
        stack: error.stack
      });

      try {
        if (savedFilePath) {
          await this.createFailureLog({
            createdBy,
            originalFilename,
            savedFilePath,
            totalRows: parsedRows.length,
            errors: [{ row: null, error: error.message }]
          });
        }
      } catch (logError) {
        logger.error('Unable to save Test Master import failure log', { error: logError.message });
      }

      if (error instanceof ImportValidationError) {
        return ApiResponse.validationError(res, {
          summary: { total_rows: parsedRows.length, created: 0, updated: 0 },
          errors: [{ row: null, error: error.message }]
        }, 'Test Master import rejected. No changes were made.');
      }

      return ApiResponse.error(res, 'Test Master import failed', 500, error.message);
    }
  }

  saveUploadedFile(file) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safeName = (file.originalname || 'test-master-upload.xlsx').replace(/[^\w.-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, `${Date.now()}-${Math.round(Math.random() * 1e9)}_${safeName}`);
    fs.writeFileSync(filePath, file.buffer);
    return filePath;
  }

  async readRows(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('The workbook does not contain a worksheet');

    const headers = new Map();
    sheet.getRow(1).eachCell((cell, columnNumber) => {
      const header = normalizeKey(cellText(cell));
      if (header) headers.set(header, columnNumber);
    });

    const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.has(header));
    if (missingHeaders.length) {
      throw new ImportValidationError(`Missing required column(s): ${missingHeaders.join(', ')}`);
    }

    const rows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const cells = REQUIRED_HEADERS.map((header) => cellText(row.getCell(headers.get(header))));
      if (!cells.some(Boolean)) return;

      rows.push({
        rowNumber,
        testName: cells[0],
        description: cells[1],
        reportType: cells[2]
      });
    });

    return rows;
  }

  async getExistingTests(connection) {
    const [rows] = await connection.query(
      `SELECT id, test_code, test_name, description, report_type, category_id, is_active
       FROM tests
       WHERE is_deleted = 0
       FOR UPDATE`
    );
    return rows;
  }

  async buildImportPlan(connection, sourceRows, existingTests) {
    const errors = [];
    const existingByName = new Map();
    existingTests.forEach((test) => {
      const key = normalizeKey(test.test_name);
      if (!existingByName.has(key)) existingByName.set(key, []);
      existingByName.get(key).push(test);
    });
    const usedCodes = new Set(existingTests.map((test) => normalizeKey(test.test_code)).filter(Boolean));
    const preparedRows = [];

    for (const source of sourceRows) {
      try {
        const name = parseOptionalText(source.testName);
        const description = parseOptionalText(source.description);
        const reportType = parseOptionalReportType(source.reportType);
        if (!name) throw new Error('Test Name is required');
        if (name.length > 255) throw new Error('Test Name cannot exceed 255 characters');
        const matchingTests = existingByName.get(normalizeKey(name)) || [];
        if (matchingTests.length > 1) {
          throw new Error(`Test Name matches multiple existing Test Master records (${matchingTests.map((test) => test.id).join(', ')})`);
        }
        const existing = matchingTests[0] || null;

        const finalRow = {
          rowNumber: source.rowNumber,
          id: existing?.id || null,
          test_code: existing?.test_code ?? null,
          test_name: name,
          description: description === undefined ? (existing?.description ?? null) : description,
          report_type: reportType === undefined ? (existing?.report_type ?? null) : reportType,
          existing
        };

        if (!finalRow.test_code) finalRow.test_code = generateTestCode(usedCodes);
        preparedRows.push(finalRow);
      } catch (error) {
        errors.push({ row: source.rowNumber, error: error.message });
      }
    }

    this.collectDuplicateErrors(preparedRows, errors);

    return { rows: preparedRows, errors };
  }

  collectDuplicateErrors(rows, errors) {
    const byName = new Map();

    for (const row of rows) {
      const nameKey = normalizeKey(row.test_name);
      const duplicateNameRow = byName.get(nameKey);

      if (duplicateNameRow) {
        errors.push({ row: row.rowNumber, error: `Duplicate Test Name in file; it is also used on row ${duplicateNameRow}` });
      } else {
        byName.set(nameKey, row.rowNumber);
      }
    }
  }

  async applyPlan(connection, rows, userId) {
    const created = [];
    const updated = [];
    const unchanged = [];

    for (const row of rows) {
      if (!row.id) {
        const [result] = await connection.query(
          `INSERT INTO tests
            (test_code, test_name, description, report_type, is_active, created_by, created_at)
           VALUES (?, ?, ?, ?, 1, ?, NOW())`,
          [row.test_code, row.test_name, row.description, row.report_type, userId]
        );
        created.push({ row: row.rowNumber, id: result.insertId, test_code: row.test_code, test_name: row.test_name });
        continue;
      }

      const changed = !sameValue(row.test_code, row.existing.test_code)
        || !sameValue(row.description, row.existing.description)
        || !sameValue(row.report_type, row.existing.report_type);

      if (!changed) {
        unchanged.push({ row: row.rowNumber, id: row.id, test_code: row.test_code, test_name: row.test_name });
        continue;
      }

      await connection.query(
        `UPDATE tests
         SET description = ?, report_type = ?, updated_by = ?, updated_at = NOW()
         WHERE id = ? AND is_deleted = 0`,
        [row.description, row.report_type, userId, row.id]
      );
      updated.push({ row: row.rowNumber, id: row.id, test_code: row.test_code, test_name: row.test_name });
    }

    return { created, updated, unchanged };
  }

  async createFailureLog({ createdBy, originalFilename, savedFilePath, totalRows, errors }) {
    const summary = { total_rows: totalRows, created: 0, updated: 0, unchanged: 0 };
    const [result] = await db.pool.query(
      `INSERT INTO bulk_upload_logs
        (upload_type, original_filename, file_path, summary, errors, created_by, created_at, status, processed_rows)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), 'failed', ?)`,
      ['test_master', originalFilename, savedFilePath, JSON.stringify(summary), JSON.stringify(errors), createdBy, totalRows]
    );
    return result.insertId;
  }
}

const service = new TestMasterBulkService();

module.exports = {
  downloadTemplate: service.downloadTemplate.bind(service),
  uploadTestMaster: service.uploadTestMaster.bind(service),
  _private: {
    normalizeText,
    normalizeKey,
    parseOptionalReportType,
    generateTestCode
  }
};
