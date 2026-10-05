const ExcelJS = require('exceljs');
const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

const CHARGE_TYPES = new Set(['free', 'paid']);

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePincode(value) {
    const pincode = String(value ?? '').replace(/\D/g, '');
    return /^\d{6}$/.test(pincode) ? pincode : null;
}

function normalizeChargeType(value) {
    const type = normalizeText(value).toLowerCase();
    return CHARGE_TYPES.has(type) ? type : null;
}

function toOptionalNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toOptionalCoordinate(value, min, max) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function parseCenterIds(values) {
    const list = Array.isArray(values) ? values : String(values ?? '').split(/[\s,;|]+/);
    return [...new Set(list.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function cellText(cell) {
    if (!cell || cell.value === null || cell.value === undefined) return '';
    return normalizeText(cell.text || cell.value);
}

async function getCentersByIds(connection, centerIds) {
    if (!centerIds.length) return [];
    const placeholders = centerIds.map(() => '?').join(',');
    const [rows] = await connection.query(
        `SELECT id, center_code, center_name
         FROM diagnostic_centers
         WHERE id IN (${placeholders}) AND is_deleted = 0`,
        centerIds,
    );
    return rows;
}

async function insertPincodeRows(connection, input, userId) {
    if (!input.centerIds.length) return;
    const values = input.centerIds.map((centerId) => [
        input.pincode, centerId, input.city, input.chargeType,
        input.averageOneWayDistanceKm, input.averageAdditionalCost,
        input.formattedAddress, input.latitude, input.longitude,
        userId || null, userId || null,
    ]);
    await connection.query(
        `INSERT INTO call_center_pincode_pricing
         (pincode, center_id, city, charge_type, average_one_way_distance_km,
          average_additional_cost, formatted_address, latitude, longitude,
          created_by, updated_by, created_at, updated_at, is_deleted)
         VALUES ?`,
        [values.map((value) => [...value, new Date(), new Date(), 0])],
    );
}

async function replacePincodeRows(connection, input, userId) {
    await connection.query(
        `UPDATE call_center_pincode_pricing
         SET is_deleted = 1, updated_by = ?, updated_at = NOW()
         WHERE pincode = ? AND is_deleted = 0`,
        [userId || null, input.pincode],
    );
    await insertPincodeRows(connection, input, userId);
}

class CallCenterPincodeService {
    async getActiveByPincode(pincode) {
        const normalizedPincode = normalizePincode(pincode);
        if (!normalizedPincode) return null;
        const rows = await db.query(
            `SELECT p.id, p.pincode, p.center_id, p.city, p.charge_type,
                    p.average_one_way_distance_km, p.average_additional_cost,
                    p.formatted_address, p.latitude, p.longitude,
                    p.created_at, p.updated_at
             FROM call_center_pincode_pricing p
             WHERE p.pincode = ? AND p.is_deleted = 0
             ORDER BY p.center_id ASC, p.id ASC`,
            [normalizedPincode],
        );
        if (!rows.length) return null;
        const pricingRows = rows.map((row) => this.formatPricing(row));
        const sharedCoordinates = pricingRows.find((row) => row.latitude !== null && row.longitude !== null);
        const sharedAddress = pricingRows.find((row) => row.formatted_address);
        return {
            ...pricingRows[0],
            // Coordinates belong to the pincode, not to an individual DC.
            // Use any valid saved coordinate when older rows are incomplete.
            latitude: sharedCoordinates?.latitude ?? null,
            longitude: sharedCoordinates?.longitude ?? null,
            formatted_address: sharedAddress?.formatted_address || null,
            center_ids: pricingRows.map((row) => row.center_id).filter(Boolean),
            center_pricing: pricingRows,
        };
    }

    formatPricing(row) {
        const oneWay = toOptionalNumber(row.average_one_way_distance_km);
        return {
            id: Number(row.id),
            center_id: row.center_id === null || row.center_id === undefined ? null : Number(row.center_id),
            pincode: row.pincode,
            city: row.city || null,
            charge_type: normalizeChargeType(row.charge_type) || 'free',
            average_one_way_distance_km: oneWay,
            average_round_trip_distance_km: oneWay === null ? null : Number((oneWay * 2).toFixed(2)),
            average_additional_cost: toOptionalNumber(row.average_additional_cost) || 0,
            formatted_address: row.formatted_address || null,
            latitude: toOptionalCoordinate(row.latitude, -90, 90),
            longitude: toOptionalCoordinate(row.longitude, -180, 180),
            center_ids: parseCenterIds(row.center_ids),
            created_at: row.created_at || null,
            updated_at: row.updated_at || null,
        };
    }

    validatePayload(payload, { requireCenters = true } = {}) {
        const pincode = normalizePincode(payload.pincode);
        const city = normalizeText(payload.city);
        const chargeType = normalizeChargeType(payload.charge_type);
        const averageOneWayDistanceKm = toOptionalNumber(payload.average_one_way_distance_km);
        const averageAdditionalCost = toOptionalNumber(payload.average_additional_cost);
        const centerIds = parseCenterIds(payload.center_ids);

        if (!pincode) throw Object.assign(new Error('A valid six-digit pincode is required'), { statusCode: 400 });
        if (!city) throw Object.assign(new Error('City is required'), { statusCode: 400 });
        if (!chargeType) throw Object.assign(new Error('Charge Type must be Free or Paid'), { statusCode: 400 });
        if (requireCenters && !centerIds.length) throw Object.assign(new Error('Select at least one diagnostic center'), { statusCode: 400 });
        return {
            pincode,
            city,
            chargeType,
            averageOneWayDistanceKm,
            averageAdditionalCost: chargeType === 'free' ? 0 : averageAdditionalCost,
            formattedAddress: normalizeText(payload.formatted_address) || null,
            latitude: toOptionalCoordinate(payload.latitude, -90, 90),
            longitude: toOptionalCoordinate(payload.longitude, -180, 180),
            centerIds,
        };
    }

    async list({ page = 1, limit = 20, q = '', chargeType = '', centerId = '' } = {}) {
        const safePage = Math.max(1, Number(page) || 1);
        const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
        const conditions = ['p.is_deleted = 0'];
        const params = [];
        if (normalizeText(q)) {
            conditions.push('(p.pincode LIKE ? OR p.city LIKE ?)');
            const query = `%${normalizeText(q)}%`;
            params.push(query, query);
        }
        if (normalizeChargeType(chargeType)) {
            conditions.push('LOWER(p.charge_type) = ?');
            params.push(normalizeChargeType(chargeType));
        }
        const normalizedCenterId = Number(centerId);
        if (Number.isInteger(normalizedCenterId) && normalizedCenterId > 0) {
            conditions.push('p.center_id = ?');
            params.push(normalizedCenterId);
        }
        const where = conditions.join(' AND ');
        const [countRows] = await db.pool.query(`SELECT COUNT(*) AS total FROM call_center_pincode_pricing p WHERE ${where}`, params);
        const [rows] = await db.pool.query(
            `SELECT p.*, dc.center_code, dc.center_name, dc.address AS center_address,
                    dc.extra_charge_per_km,
                    mapping.center_ids
             FROM call_center_pincode_pricing p
             LEFT JOIN diagnostic_centers dc ON dc.id = p.center_id AND dc.is_deleted = 0
             LEFT JOIN (
                SELECT pincode, GROUP_CONCAT(DISTINCT center_id ORDER BY center_id) AS center_ids
                FROM call_center_pincode_pricing
                WHERE is_deleted = 0
                GROUP BY pincode
             ) mapping ON mapping.pincode = p.pincode
             WHERE ${where}
             ORDER BY p.updated_at DESC, p.id DESC
             LIMIT ? OFFSET ?`,
            [...params, safeLimit, (safePage - 1) * safeLimit],
        );
        return {
            data: rows.map((row) => ({
                ...this.formatPricing(row),
                center_id: Number(row.center_id),
                center_code: row.center_code || '',
                center_name: row.center_name || '',
                center_address: row.center_address || '',
                extra_charge_per_km: toOptionalNumber(row.extra_charge_per_km) || 0,
            })),
            pagination: {
                total: Number(countRows[0]?.total || 0),
                page: safePage,
                limit: safeLimit,
                pages: Math.ceil(Number(countRows[0]?.total || 0) / safeLimit) || 1,
            },
        };
    }

    async getCenters() {
        return db.query(
            `SELECT id, center_code, center_name, city, pincode, address, extra_charge_per_km
             FROM diagnostic_centers
             WHERE is_deleted = 0
             ORDER BY center_name ASC`,
        );
    }

    async create(payload, userId) {
        const input = this.validatePayload(payload);
        const connection = await db.pool.getConnection();
        try {
            await connection.beginTransaction();
            const [existing] = await connection.query(
                `SELECT id FROM call_center_pincode_pricing
                 WHERE pincode = ? AND is_deleted = 0
                 LIMIT 1 FOR UPDATE`,
                [input.pincode],
            );
            if (existing.length) throw Object.assign(new Error('This pincode is already configured. Edit the existing mapping instead.'), { statusCode: 409 });
            const centers = await getCentersByIds(connection, input.centerIds);
            if (centers.length !== input.centerIds.length) throw Object.assign(new Error('One or more selected diagnostic centers are not available'), { statusCode: 400 });
            await insertPincodeRows(connection, input, userId);
            await connection.commit();
            return this.getActiveByPincode(input.pincode);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async update(id, payload, userId) {
        const pricingId = Number(id);
        if (!Number.isInteger(pricingId) || pricingId <= 0) throw Object.assign(new Error('Invalid pincode mapping'), { statusCode: 400 });
        const input = this.validatePayload(payload);
        const connection = await db.pool.getConnection();
        try {
            await connection.beginTransaction();
            const [current] = await connection.query('SELECT pincode FROM call_center_pincode_pricing WHERE id = ? AND is_deleted = 0 LIMIT 1 FOR UPDATE', [pricingId]);
            if (!current.length) throw Object.assign(new Error('Pincode mapping was not found'), { statusCode: 404 });
            const currentPincode = current[0].pincode;
            const [duplicate] = await connection.query(
                `SELECT id FROM call_center_pincode_pricing
                 WHERE pincode = ? AND pincode <> ? AND is_deleted = 0 LIMIT 1 FOR UPDATE`,
                [input.pincode, currentPincode],
            );
            if (duplicate.length) throw Object.assign(new Error('This pincode is already configured.'), { statusCode: 409 });
            const centers = await getCentersByIds(connection, input.centerIds);
            if (centers.length !== input.centerIds.length) throw Object.assign(new Error('One or more selected diagnostic centers are not available'), { statusCode: 400 });
            await connection.query(
                `UPDATE call_center_pincode_pricing
                 SET is_deleted = 1, updated_by = ?, updated_at = NOW()
                 WHERE pincode = ? AND is_deleted = 0`,
                [userId || null, currentPincode],
            );
            await insertPincodeRows(connection, input, userId);
            await connection.commit();
            return this.getActiveByPincode(input.pincode);
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async remove(id, userId) {
        const pricingId = Number(id);
        if (!Number.isInteger(pricingId) || pricingId <= 0) throw Object.assign(new Error('Invalid pincode mapping'), { statusCode: 400 });
        const connection = await db.pool.getConnection();
        try {
            await connection.beginTransaction();
            const [current] = await connection.query(
                `SELECT pincode FROM call_center_pincode_pricing
                 WHERE id = ? AND is_deleted = 0 LIMIT 1 FOR UPDATE`,
                [pricingId],
            );
            if (!current.length) throw Object.assign(new Error('Pincode mapping was not found'), { statusCode: 404 });
            const [result] = await connection.query(
                `UPDATE call_center_pincode_pricing
                 SET is_deleted = 1, updated_by = ?, updated_at = NOW()
                 WHERE pincode = ? AND is_deleted = 0`,
                [userId || null, current[0].pincode],
            );
            if (!result.affectedRows) throw Object.assign(new Error('Pincode mapping was not found'), { statusCode: 404 });
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async downloadTemplate(req, res) {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Pincode Mapping');
        sheet.columns = [
            { header: 'City', width: 24 }, { header: 'Pincode', width: 15 },
            { header: 'Center Name', width: 36 }, { header: 'Center Address', width: 52 },
            { header: 'Pricing Type', width: 16 }, { header: 'DC Per KM Rate', width: 18 },
            { header: 'Approx One Way KM', width: 22 },
        ];
        sheet.getRow(1).font = { bold: true };
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        // The dropdown must contain every non-deleted center, not only centers
        // already present in an existing pincode mapping.
        const centers = await this.getCenters();
        const mappings = await db.query(
            `SELECT p.city, p.pincode, dc.center_name, dc.address AS center_address,
                    dc.extra_charge_per_km, p.charge_type, p.average_one_way_distance_km,
                    p.average_additional_cost
             FROM call_center_pincode_pricing p
             LEFT JOIN diagnostic_centers dc ON dc.id = p.center_id AND dc.is_deleted = 0
             WHERE p.is_deleted = 0
             ORDER BY p.city ASC, p.pincode ASC, dc.center_name ASC`,
        );
        if (mappings.length) {
            mappings.forEach((mapping) => sheet.addRow([
                mapping.city || '', mapping.pincode || '', mapping.center_name || '', mapping.center_address || '',
                mapping.charge_type || 'free', mapping.extra_charge_per_km ?? 0,
                mapping.average_one_way_distance_km ?? '',
            ]));
        } else {
            const firstCenter = centers[0]?.center_name || 'Select a diagnostic center';
            const firstAddress = centers[0]?.address || '';
            const secondCenter = centers[1]?.center_name || firstCenter;
            const secondAddress = centers[1]?.address || firstAddress;
            sheet.addRow(['Pune', '411028', firstCenter, firstAddress, 'free', '0', '5.50']);
            sheet.addRow(['Pune', '411001', firstCenter, firstAddress, 'paid', '25', '12.00']);
            sheet.addRow(['Pune', '411001', secondCenter, secondAddress, 'paid', '25', '12.00']);
        }
        const centersSheet = workbook.addWorksheet('Centers');
        centersSheet.getColumn(1).values = ['Center Name', ...centers.map((center) => center.center_name)];
        centersSheet.state = 'hidden';
        const lastCenterRow = Math.max(2, centers.length + 1);
        // Apply validation to an empty working area as well as the sample rows,
        // so newly added rows keep the same center-name dropdown.
        for (let rowNumber = 2; rowNumber <= Math.max(501, mappings.length + 1); rowNumber += 1) {
            sheet.getCell(rowNumber, 3).dataValidation = {
                type: 'list',
                allowBlank: true,
                formulae: [`=Centers!$A$2:$A$${lastCenterRow}`],
            };
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=call-center-pincode-template.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    }

    async importExcel(req, res) {
        if (!req.file?.buffer) throw Object.assign(new Error('Upload an Excel file using the excelFile field'), { statusCode: 400 });
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const sheet = workbook.worksheets[0];
        if (!sheet) throw Object.assign(new Error('The workbook does not contain a worksheet'), { statusCode: 400 });
        const headers = new Map();
        sheet.getRow(1).eachCell((cell, number) => headers.set(normalizeText(cellText(cell)).toLowerCase(), number));
        const required = ['pincode', 'city', 'center name', 'pricing type'];
        const missing = required.filter((header) => !headers.has(header));
        if (missing.length) throw Object.assign(new Error(`Missing required columns: ${missing.join(', ')}`), { statusCode: 400 });

        const centerRows = await this.getCenters();
        const centersByName = new Map();
        centerRows.forEach((center) => {
            const name = normalizeText(center.center_name).toLowerCase();
            if (centersByName.has(name)) centersByName.set(name, null);
            else centersByName.set(name, Number(center.id));
        });
        const mappings = new Map();
        const errors = [];
        sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            const read = (header) => cellText(row.getCell(headers.get(header)));
            if (!['pincode', 'city', 'center name', 'pricing type'].some((header) => read(header))) return;
            try {
                const pincode = normalizePincode(read('pincode'));
                if (!pincode) throw new Error('A valid six-digit Pincode is required');
                const centerName = normalizeText(read('center name')).toLowerCase();
                const centerId = centersByName.get(centerName);
                if (!centerId) throw new Error('Select a valid diagnostic center name from the template list');
                if (!mappings.has(pincode)) {
                    mappings.set(pincode, {
                        rowNumber,
                        payload: {
                            pincode, city: read('city'), charge_type: read('pricing type'),
                            average_one_way_distance_km: headers.has('approx one way km') ? read('approx one way km') : null,
                            average_additional_cost: headers.has('final additional cost') ? read('final additional cost') : null,
                            center_ids: [],
                        },
                    });
                }
                const mapping = mappings.get(pincode);
                const samePincodeDetails =
                    normalizeText(mapping.payload.city) === normalizeText(read('city'))
                    && normalizeText(mapping.payload.charge_type).toLowerCase() === normalizeText(read('pricing type')).toLowerCase()
                    && normalizeText(mapping.payload.average_one_way_distance_km) === normalizeText(headers.has('approx one way km') ? read('approx one way km') : '');
                if (!samePincodeDetails) throw new Error('All rows for the same pincode must use the same city, pricing type, and distance');
                if (mapping.payload.center_ids.includes(centerId)) throw new Error('Duplicate pincode and diagnostic center row');
                mapping.payload.center_ids.push(centerId);
            } catch (error) {
                errors.push({ row: rowNumber, error: error.message });
            }
        });
        const rows = [...mappings.values()];
        if (!rows.length && !errors.length) throw Object.assign(new Error('No data rows found in the uploaded file'), { statusCode: 400 });
        if (errors.length) return res.status(400).json({ status: 'error', message: 'Pincode import rejected. No changes were made.', errors });

        const connection = await db.pool.getConnection();
        try {
            await connection.beginTransaction();
            const summary = { total_rows: rows.length, created: 0, updated: 0 };
            for (const row of rows) {
                const input = this.validatePayload(row.payload);
                const [existing] = await connection.query(
                    `SELECT id, city, charge_type, average_one_way_distance_km,
                            average_additional_cost, center_id, latitude, longitude
                     FROM call_center_pincode_pricing
                     WHERE pincode = ? AND is_deleted = 0
                     ORDER BY id ASC FOR UPDATE`,
                    [input.pincode],
                );
                if (existing.length) {
                    const currentCenterIds = existing.map((item) => Number(item.center_id)).sort((a, b) => a - b);
                    const incomingCenterIds = [...input.centerIds].sort((a, b) => a - b);
                    const sameMapping = existing.length === incomingCenterIds.length
                        && currentCenterIds.every((centerId, index) => centerId === incomingCenterIds[index])
                        && normalizeText(existing[0].city) === normalizeText(input.city)
                        && normalizeChargeType(existing[0].charge_type) === normalizeChargeType(input.charge_type)
                        && Number(existing[0].average_one_way_distance_km ?? 0) === Number(input.averageOneWayDistanceKm ?? 0);
                    if (sameMapping) continue;

                    // The spreadsheet does not carry coordinates, so retain a
                    // previously saved live-location pin during a real update.
                    input.latitude = input.latitude ?? toOptionalCoordinate(existing[0].latitude, -90, 90);
                    input.longitude = input.longitude ?? toOptionalCoordinate(existing[0].longitude, -180, 180);
                    await replacePincodeRows(connection, input, req.user?.id);
                    summary.updated += 1;
                } else {
                    await insertPincodeRows(connection, input, req.user?.id);
                    summary.created += 1;
                }
            }
            await connection.commit();
            logger.info('Call Center pincode mappings imported', { userId: req.user?.id, ...summary });
            return res.json({ status: 'success', message: 'Pincode mappings imported successfully', data: { summary } });
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }
}

module.exports = new CallCenterPincodeService();
