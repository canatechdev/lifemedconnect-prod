/**
 * Appointment Documents and Customer Images Management
 * Handles customer documents (Aadhaar, PAN, DL, etc.) and customer images
 */

const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');

function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

async function documentExists(appointmentId, docType, docNumber, fileName) {
    const rows = await db.query(
        `SELECT id
         FROM appointment_documents
         WHERE appointment_id = ?
           AND is_deleted = 0
           AND LOWER(TRIM(doc_type)) = ?
           AND LOWER(TRIM(COALESCE(doc_number, ''))) = ?
           AND LOWER(TRIM(file_name)) = ?
         LIMIT 1`,
        [appointmentId, normalizeText(docType), normalizeText(docNumber), normalizeText(fileName)]
    );
    return rows[0] || null;
}

async function customerImageExists(appointmentId, imageLabel, fileName) {
    const rows = await db.query(
        `SELECT id
         FROM appointment_customer_images
         WHERE appointment_id = ?
           AND is_deleted = 0
           AND LOWER(TRIM(image_label)) = ?
           AND LOWER(TRIM(file_name)) = ?
         LIMIT 1`,
        [appointmentId, normalizeText(imageLabel), normalizeText(fileName)]
    );
    return rows[0] || null;
}

/**
 * Add a customer document
 * @param {number} appointmentId 
 * @param {string} docType - aadhaar, pan, driving_license, voter_id, passport
 * @param {string} docNumber 
 * @param {string} filePath 
 * @param {string} fileName 
 * @param {number} userId 
 */
async function addDocument(appointmentId, docType, docNumber, filePath, fileName, userId) {
    // const validTypes = ['aadhaar', 'pan', 'driving_license', 'voter_id', 'passport'];
    // if (!validTypes.includes(docType)) {
    //     throw new Error(`Invalid document type: ${docType}`);
    // }

    const existing = await documentExists(appointmentId, docType, docNumber, fileName);
    if (existing) {
        logger.info('Duplicate document skipped', { appointmentId, docType, userId, existingDocumentId: existing.id });
        return {
            success: true,
            message: 'Document already exists',
            documentId: existing.id,
            skipped: true
        };
    }

    const sql = `
        INSERT INTO appointment_documents 
        (appointment_id, doc_type, doc_number, file_path, file_name, uploaded_by, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
    `;

    const result = await db.query(sql, [
        appointmentId,
        docType,
        docNumber,
        filePath,
        fileName,
        userId
    ]);

    logger.info('Document added', { appointmentId, docType, userId });
    return { 
        success: true, 
        message: 'Document added successfully',
        documentId: result.insertId
    };
}

/**
 * Delete a document (soft delete)
 * @param {number} documentId 
 * @param {number} userId 
 */
async function deleteDocument(documentId, userId) {
    const sql = `
        UPDATE appointment_documents 
        SET is_deleted = 1 
        WHERE id = ?
    `;

    const result = await db.query(sql, [documentId]);
    
    if (result.affectedRows > 0) {
        logger.info('Document deleted', { documentId, userId });
        return { success: true, message: 'Document deleted successfully' };
    } else {
        throw new Error('Document not found');
    }
}

/**
 * Get all documents for an appointment
 * @param {number} appointmentId 
 */
async function getDocuments(appointmentId) {
    const sql = `
        SELECT 
            id,
            appointment_id,
            doc_type,
            doc_number,
            file_path,
            file_name,
            uploaded_by,
            uploaded_at
        FROM appointment_documents
        WHERE appointment_id = ? AND is_deleted = 0
        ORDER BY uploaded_at DESC
    `;

    const rows = await db.query(sql, [appointmentId]);
    return rows;
}

/**
 * Add a customer image
 * @param {number} appointmentId 
 * @param {string} imageLabel 
 * @param {string} filePath 
 * @param {string} fileName 
 * @param {number} userId 
 */
async function addCustomerImage(appointmentId, imageLabel, filePath, fileName, userId) {
    const safeImageLabel = String(imageLabel || '').trim();

    const existing = await customerImageExists(appointmentId, safeImageLabel, fileName);
    if (existing) {
        logger.info('Duplicate customer image skipped', { appointmentId, imageLabel: safeImageLabel, userId, existingImageId: existing.id });
        return {
            success: true,
            message: 'Customer image already exists',
            imageId: existing.id,
            skipped: true
        };
    }

    const sql = `
        INSERT INTO appointment_customer_images 
        (appointment_id, image_label, file_path, file_name, uploaded_by, uploaded_at)
        VALUES (?, ?, ?, ?, ?, NOW())
    `;

    const result = await db.query(sql, [
        appointmentId,
        safeImageLabel,
        filePath,
        fileName,
        userId
    ]);

    logger.info('Customer image added', { appointmentId, imageLabel: safeImageLabel, userId });
    return { 
        success: true, 
        message: 'Customer image added successfully',
        imageId: result.insertId
    };
}

/**
 * Delete a customer image (soft delete)
 * @param {number} imageId 
 * @param {number} userId 
 */
async function deleteCustomerImage(imageId, userId) {
    const sql = `
        UPDATE appointment_customer_images 
        SET is_deleted = 1 
        WHERE id = ?
    `;

    const result = await db.query(sql, [imageId]);
    
    if (result.affectedRows > 0) {
        logger.info('Customer image deleted', { imageId, userId });
        return { success: true, message: 'Customer image deleted successfully' };
    } else {
        throw new Error('Image not found');
    }
}

/**
 * Get all customer images for an appointment
 * @param {number} appointmentId 
 */
async function getCustomerImages(appointmentId) {
    const sql = `
        SELECT 
            id,
            appointment_id,
            image_label,
            file_path,
            file_name,
            uploaded_by,
            uploaded_at
        FROM appointment_customer_images
        WHERE appointment_id = ? AND is_deleted = 0
        ORDER BY uploaded_at ASC
    `;

    const rows = await db.query(sql, [appointmentId]);
    return rows;
}

/**
 * Update customer image label
 * @param {number} imageId 
 * @param {string} newLabel 
 * @param {number} userId 
 */
async function updateImageLabel(imageId, newLabel, userId) {
    if (!newLabel || newLabel.trim() === '') {
        throw new Error('Image label is required');
    }

    const sql = `
        UPDATE appointment_customer_images 
        SET image_label = ? 
        WHERE id = ? AND is_deleted = 0
    `;

    const result = await db.query(sql, [newLabel.trim(), imageId]);
    
    if (result.affectedRows > 0) {
        logger.info('Image label updated', { imageId, newLabel, userId });
        return { success: true, message: 'Image label updated successfully' };
    } else {
        throw new Error('Image not found');
    }
}

/**
 * Batch add documents and images during arrival
 * @param {number} appointmentId 
 * @param {Array} documents - Array of { docType, docNumber, filePath, fileName }
 * @param {Array} images - Array of { imageLabel, filePath, fileName }
 * @param {number} userId 
 */
async function batchAddDocumentsAndImages(appointmentId, documents, images, userId) {
    const connection = await db.pool.getConnection();
    try {
        await connection.beginTransaction();

        const results = {
            documents: [],
            images: []
        };

        // Add documents
        if (documents && documents.length > 0) {
            const docSql = `
                INSERT INTO appointment_documents 
                (appointment_id, doc_type, doc_number, file_path, file_name, uploaded_by, uploaded_at)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
            `;

            for (const doc of documents) {
                const result = await connection.query(docSql, [
                    appointmentId,
                    doc.docType,
                    doc.docNumber,
                    doc.filePath,
                    doc.fileName,
                    userId
                ]);
                results.documents.push({ id: result.insertId, ...doc });
            }
        }

        // Add images
        if (images && images.length > 0) {
            const imgSql = `
                INSERT INTO appointment_customer_images 
                (appointment_id, image_label, file_path, file_name, uploaded_by, uploaded_at)
                VALUES (?, ?, ?, ?, ?, NOW())
            `;

            for (const img of images) {
                if (img.filePath) {
                    const imageLabel = String(img.imageLabel || '').trim();
                    const result = await connection.query(imgSql, [
                        appointmentId,
                        imageLabel,
                        img.filePath,
                        img.fileName,
                        userId
                    ]);
                    results.images.push({ id: result.insertId, ...img, imageLabel });
                }
            }
        }

        await connection.commit();
        logger.info('Batch documents and images added', { 
            appointmentId, 
            documentsCount: results.documents.length,
            imagesCount: results.images.length,
            userId 
        });

        return { 
            success: true, 
            message: 'Documents and images added successfully',
            results
        };
    } catch (error) {
        await connection.rollback();
        logger.error('Error batch adding documents and images:', error);
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    addDocument,
    documentExists,
    deleteDocument,
    getDocuments,
    addCustomerImage,
    customerImageExists,
    deleteCustomerImage,
    getCustomerImages,
    updateImageLabel,
    batchAddDocumentsAndImages
};
