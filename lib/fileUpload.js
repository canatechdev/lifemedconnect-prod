/**
 * Unified file upload utility with compression and disk saving
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Sanitize entity folder name (remove unsafe characters for filesystem)
 * @param {string} name - Raw entity identifier
 * @returns {string} Safe folder name
 */
const sanitizeFolderName = (name) => {
    if (!name) return '';
    return String(name)
        .replace(/[<>:"|\/\?\*]/g, '_')  // Remove filesystem-unsafe chars
        .replace(/\s+/g, '_')              // Replace spaces with underscores
        .replace(/_+/g, '_')               // Collapse multiple underscores
        .replace(/^_|_$/g, '')             // Trim leading/trailing underscores
        .substring(0, 100);                // Limit length
};

/**
 * Save buffer to disk with compression for images
 * @param {Buffer} buffer - File buffer
 * @param {string} mimetype - File mimetype
 * @param {string} originalname - Original filename
 * @param {string} subfolder - Subfolder within uploads (e.g. 'appointment_reports')
 * @param {string} entityFolder - Entity identifier subfolder (e.g. case_number, client_code) (optional)
 * @param {boolean} skipCompression - Skip image compression to preserve original quality (optional)
 * @returns {Promise<string>} Saved file path
 */
// const saveFile = async (buffer, mimetype, originalname, subfolder = '', entityFolder = '') => {
const saveFile = async (buffer, mimetype, originalname, subfolder = '', entityFolder = '', skipCompression = false) => {
    try {
        // Build upload directory path: uploads/{subfolder}/{entityFolder}/
        const safeFolderName = sanitizeFolderName(entityFolder);
        const uploadDir = safeFolderName
            ? path.join(__dirname, '../uploads', subfolder, safeFolderName)
            : path.join(__dirname, '../uploads', subfolder);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        let filename;
        let filePath;
        let finalBuffer = buffer;

        // Check if it's an image that needs compression
        if (mimetype.startsWith('image/')) {
            const originalSize = buffer.length;
// new block
            // Skip compression if requested (preserve original quality)
            if (skipCompression) {
                logger.info(`Skipping compression for ${originalname} (original quality preserved)`);
                const ext = path.extname(originalname) || '.jpg';
                filename = `${uniqueSuffix}${ext}`;
                finalBuffer = buffer;
            } else {
// new block end  and below is } "needed"
            try {
                let sharpInstance = sharp(buffer);
                const metadata = await sharpInstance.metadata();

                logger.debug(`Processing image: ${originalname}`, {
                    size: `${(originalSize/1024).toFixed(2)}KB`,
                    dimensions: `${metadata.width}x${metadata.height}`
                });

                // Resize if too large
                const maxWidth = 1920;
                if (metadata.width > maxWidth) {
                    sharpInstance = sharpInstance.resize(maxWidth, null, {
                        fit: 'inside',
                        withoutEnlargement: true
                    });
                }

                // Compress based on format
                if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') {
                    finalBuffer = await sharpInstance
                        .jpeg({ 
                            quality: 75,
                            mozjpeg: true
                        })
                        .toBuffer();
                    filename = `${uniqueSuffix}.jpg`;
                } else if (mimetype === 'image/png') {
                    finalBuffer = await sharpInstance
                        .png({ 
                            compressionLevel: 9,
                            quality: 75
                        })
                        .toBuffer();
                    filename = `${uniqueSuffix}.png`;
                } else if (mimetype === 'image/webp') {
                    finalBuffer = await sharpInstance
                        .webp({ quality: 75 })
                        .toBuffer();
                    filename = `${uniqueSuffix}.webp`;
                } else {
                    // Convert other formats to JPEG
                    finalBuffer = await sharpInstance
                        .jpeg({ quality: 75, mozjpeg: true })
                        .toBuffer();
                    filename = `${uniqueSuffix}.jpg`;
                }

                const compressedSize = finalBuffer.length;
                const reduction = ((originalSize - compressedSize) / originalSize * 100);
                
                logger.info(`Image compressed: ${originalname}`, {
                    originalSize: `${(originalSize/1024).toFixed(2)}KB`,
                    compressedSize: `${(compressedSize/1024).toFixed(2)}KB`,
                    reduction: `${reduction.toFixed(1)}%`
                });
            } catch (compressionError) {
                logger.warn(`Image compression failed for ${originalname}, saving original:`, compressionError.message);
                const ext = path.extname(originalname) || '.jpg';
                filename = `${uniqueSuffix}${ext}`;
                finalBuffer = buffer;
            }
            }  // needed
        } else {
            // Non-image files - save as-is
            const ext = path.extname(originalname) || '.pdf';
            filename = `${uniqueSuffix}${ext}`;
            finalBuffer = buffer;
        }

        filePath = path.join(uploadDir, filename);
        
        // Write file to disk
        fs.writeFileSync(filePath, finalBuffer);
        
        logger.debug(`File saved: ${filePath}`);
        
        // Return relative path from project root
        const relativeParts = ['uploads', subfolder];
        if (safeFolderName) relativeParts.push(safeFolderName);
        relativeParts.push(filename);
        return path.join(...relativeParts).replace(/\\/g, '/');
    } catch (error) {
        logger.error('Error saving file:', error);
        throw new Error(`Failed to save file: ${error.message}`);
    }
};

/**
 * Process single uploaded file
 * @param {Object} file - Multer file object
 * @param {string} subfolder - Subfolder within uploads
 * @param {string} entityFolder - Entity identifier subfolder (optional)
 * @param {boolean} skipCompression - Skip image compression to preserve original quality (optional)
 * @returns {Promise<string>} File path
 */
// const processSingleFile = async (file, subfolder = '', entityFolder = '') => {
const processSingleFile = async (file, subfolder = '', entityFolder = '', skipCompression = false) => {
    if (!file) return null;
    
    if (file.buffer) {
        // Memory storage - save to disk
        // return await saveFile(file.buffer, file.mimetype, file.originalname, subfolder, entityFolder);
        return await saveFile(file.buffer, file.mimetype, file.originalname, subfolder, entityFolder, skipCompression);
    } else if (file.path) {
        // Already saved to disk
        return file.path;
    }
    
    return null;
};

/**
 * Process multiple uploaded files
 * @param {Array} files - Array of multer file objects
 * @param {string} subfolder - Subfolder within uploads
 * @param {string} entityFolder - Entity identifier subfolder (optional)
 * @returns {Promise<Array<string>>} Array of file paths
 */
const processMultipleFiles = async (files, subfolder = '', entityFolder = '') => {
    if (!files || !Array.isArray(files) || files.length === 0) {
        return [];
    }
    
    const filePaths = [];
    
    for (const file of files) {
        try {
            const filePath = await processSingleFile(file, subfolder, entityFolder);
            if (filePath) {
                filePaths.push(filePath);
            }
        } catch (error) {
            logger.error(`Failed to process file ${file.originalname}:`, error);
            // Continue processing other files
        }
    }
    
    return filePaths;
};

/**
 * Process multer fields object
 * @param {Object} files - req.files from multer
 * @param {string} subfolder - Subfolder within uploads
 * @param {string} entityFolder - Entity identifier subfolder (optional)
 * @returns {Promise<Object>} Object with processed file paths
 */
const processUploadFields = async (files, subfolder = '', entityFolder = '') => {
    if (!files) return {};
    
    const result = {};
    
    for (const [fieldName, fileArray] of Object.entries(files)) {
        if (Array.isArray(fileArray)) {
            if (fileArray.length === 1) {
                // Single file field
                result[fieldName] = await processSingleFile(fileArray[0], subfolder, entityFolder);
            } else {
                // Multiple files field
                result[fieldName] = await processMultipleFiles(fileArray, subfolder, entityFolder);
            }
        }
    }
    
    return result;
};

/**
 * Handle file upload from req.files.any() - finds specific field
 * @param {Array} filesArray - req.files from multer.any()
 * @param {string} fieldName - Field name to find
 * @param {string} subfolder - Subfolder within uploads
 * @param {string} entityFolder - Entity identifier subfolder (optional)
 * @returns {Promise<string|null>} File path or null
 */
const handleSingleFileFromAny = async (filesArray, fieldName, subfolder = '', entityFolder = '') => {
    if (!filesArray || !Array.isArray(filesArray) || filesArray.length === 0) {
        return null;
    }
    
    const file = filesArray.find(f => f.fieldname === fieldName);
    if (!file) return null;
    
    return await processSingleFile(file, subfolder, entityFolder);
};

/**
 * Handle Excel file upload (no compression, just save)
 * @param {Object} file - Multer file object
 * @param {string} subfolder - Subfolder within uploads
 * @returns {Promise<string|null>} File path or null
 */
const handleExcelFile = async (file, subfolder = 'excel') => {
    if (!file) return null;
    
    try {
        // Create upload directory
        const uploadDir = path.join(__dirname, '../uploads', subfolder);
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname) || '.xlsx';
        const filename = `${uniqueSuffix}${ext}`;
        const filePath = path.join(uploadDir, filename);
        
        // If file has buffer (memory storage), write it
        if (file.buffer) {
            fs.writeFileSync(filePath, file.buffer);
        } else if (file.path) {
            // If already on disk, return existing path
            return file.path;
        }
        
        logger.debug(`Excel file saved: ${filePath}`);
        
        // Return relative path from project root
        return path.join('uploads', subfolder, filename).replace(/\\/g, '/');
    } catch (error) {
        logger.error('Error saving Excel file:', error);
        throw new Error(`Failed to save Excel file: ${error.message}`);
    }
};

/**
 * Standardized file field processor for routes
 * Handles single files, multiple files, and removal markers
 * @param {Object} files - req.files from multer
 * @param {Object} body - req.body
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} Processed file paths
 */
const processFileFields = async (files, body, config, entityFolder = '') => {
    const result = {};
    
    for (const [fieldName, fieldConfig] of Object.entries(config)) {
        const { type, subfolder = '', existingKey = null } = fieldConfig;
        
        // Check for removal marker
        const removalMarker = `${fieldName}_remove`;
        if (body[removalMarker] === 'true') {
            result[fieldName] = null;
            continue;
        }
        
        // Check for empty string (also means removal)
        if (body[fieldName] === '') {
            result[fieldName] = null;
            continue;
        }
        
        // Process based on type
        if (type === 'single') {
            if (files && files[fieldName] && files[fieldName][0]) {
                result[fieldName] = await processSingleFile(files[fieldName][0], subfolder, entityFolder);
            }
        } else if (type === 'multiple') {
            if (files && files[fieldName]) {
                const newFiles = await processMultipleFiles(files[fieldName], subfolder, entityFolder);
                
                // Handle existing files
                let existing = [];
                if (existingKey && body[existingKey]) {
                    try {
                        existing = JSON.parse(body[existingKey]);
                        if (!Array.isArray(existing)) existing = [];
                        existing = existing.map(p => p.replace(/\\/g, '/'));
                    } catch (e) { /* ignore */ }
                }
                
                const allFiles = [...existing, ...newFiles];
                result[fieldName] = allFiles.length > 0 ? JSON.stringify(allFiles) : null;
            } else if (existingKey && body[existingKey]) {
                // No new files, keep existing
                result[fieldName] = body[existingKey];
            }
        }
    }
    
    return result;
};

module.exports = {
    saveFile,
    sanitizeFolderName,
    processSingleFile,
    processMultipleFiles,
    processUploadFields,
    handleSingleFileFromAny,
    handleExcelFile,
    processFileFields
};
