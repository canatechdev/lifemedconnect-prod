/**
 * TPA Appointment PDF Service
 * Generates a TPA PDF with specific sequence:
 * MTRF > Customer Photos (with letterhead) > MER > Pathology Report (with letterhead) > Cardiology > Radiology > Other Reports
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs').promises;
const { PDFDocument } = require('pdf-lib');
const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const { getLetterheadDataUrl, generatePdfBuffer, getStandardMargins } = require('../../lib/pdfUtils');
const { sanitizeFolderName } = require('../../lib/fileUpload');

class AppointmentTPAPDFService {
    /**
     * Generate TPA PDF for completed appointment
     */
    async generateTPAPDF(appointmentId) {
        try {
            const appointmentData = await this.fetchAppointmentData(appointmentId);
            if (!appointmentData) {
                throw new Error('Appointment not found');
            }

            // Create final PDF by merging sections in order
            const finalPdfBuffer = await this.buildTPAPDF(appointmentData);
            
            const savedPath = await this.savePDF(finalPdfBuffer, appointmentData.case_number);
            const baseUrl = process.env.BASE_URL || 'http://localhost:5050';
            const pdfUrl = `${baseUrl}/${savedPath}`;

            return {
                success: true,
                pdfPath: savedPath,
                pdfUrl,
                message: 'TPA PDF generated successfully'
            };
        } catch (error) {
            console.error('Error generating TPA PDF:', error);
            throw error;
        }
    }

    /**
     * Fetch all appointment related data
     */
    async fetchAppointmentData(appointmentId) {
        const appointments = await db.query(
            `SELECT a.*, 
                    c.client_name, c.client_code,
                    i.insurer_name, i.insurer_code,
                    dc.center_name, dc.address as center_address, 
                    dc.city as center_city, dc.state as center_state,
                    dc.letterhead_path as center_logo, dc.footer_path as center_footer, dc.contact_number as center_contact,
                    t.full_name as technician_name, t.technician_code, t.mobile as technician_mobile
             FROM appointments a
             LEFT JOIN clients c ON a.client_id = c.id
             LEFT JOIN insurers i ON a.insurer_id = i.id
             LEFT JOIN diagnostic_centers dc ON a.center_id = dc.id
             LEFT JOIN technicians t ON a.assigned_technician_id = t.id
             WHERE a.id = ?`,
            [appointmentId]
        );

        if (!appointments || appointments.length === 0) {
            return null;
        }

        const appointment = appointments[0];

        // Fetch customer images
        const customerImages = await db.query(
            `SELECT * FROM appointment_customer_images WHERE appointment_id = ? AND is_deleted = 0 ORDER BY uploaded_at`,
            [appointmentId]
        );

        // Fetch customer documents
        const customerDocuments = await db.query(
            `SELECT * FROM appointment_documents WHERE appointment_id = ? AND is_deleted = 0 ORDER BY doc_type, uploaded_at`,
            [appointmentId]
        );

        // Fetch categorized reports
        const reports = await db.query(
            `SELECT * FROM appointment_categorized_reports WHERE appointment_id = ? AND is_deleted = 0 ORDER BY report_type, uploaded_at`,
            [appointmentId]
        );

        // Fetch pathology data
        const pathologyRecords = await db.query(
            `SELECT * FROM appointment_pathology_data WHERE appointment_id = ? ORDER BY created_at DESC LIMIT 1`,
            [appointmentId]
        );

        let pathologyData = null;
        if (pathologyRecords.length > 0) {
            const record = pathologyRecords[0];
            pathologyData = {
                ...record,
                data: record.data_json ? JSON.parse(record.data_json) : null
            };
        }

        return {
            ...appointment,
            customerImages,
            customerDocuments,
            reports,
            pathologyData
        };
    }

    /**
     * Build TPA PDF by merging sections in specific order
     */
    async buildTPAPDF(data) {
        const baseDir = path.resolve(__dirname, '../../');
        const headerDataUrl = data.center_logo ? await getLetterheadDataUrl(data.center_logo, baseDir) : null;
        const footerDataUrl = data.center_footer ? await getLetterheadDataUrl(data.center_footer, baseDir) : null;

        const finalPdf = await PDFDocument.create();

        // 1. MTRF Report
        await this.appendReportsByType(finalPdf, data.reports, 'mtrf', baseDir, null, null);

        // 2.1. Customer Documents (with letterhead) - Comment out if not needed
        await this.appendCustomerDocuments(finalPdf, data.customerDocuments, baseDir, headerDataUrl, footerDataUrl);

        // 2. Customer Photos (with letterhead)
        await this.appendCustomerPhotos(finalPdf, data.customerImages, baseDir, headerDataUrl, footerDataUrl);

        // 3. MER Report
        await this.appendReportsByType(finalPdf, data.reports, 'mer', baseDir, null, null);

        // 4. Pathology Report (with letterhead)
        // OPTIONS: Uncomment the desired option(s)
        
        // Option 1: API-generated pathology report only
        await this.appendPathologyReport(finalPdf, data.pathologyData, data, headerDataUrl, footerDataUrl);
        
        // Option 2: User-uploaded pathology PDFs only
        await this.appendReportsByType(finalPdf, data.reports, 'pathology', baseDir, headerDataUrl, footerDataUrl);
        
        // 5. Cardiology Report
        await this.appendReportsByType(finalPdf, data.reports, 'cardiology', baseDir, null, null);

        // 6. Radiology Report
        await this.appendReportsByType(finalPdf, data.reports, 'radiology', baseDir, null, null);

        // 7. Other Reports
        await this.appendReportsByType(finalPdf, data.reports, 'other', baseDir, null, null);

        return await finalPdf.save();
    }

    /**
     * Append customer photos with letterhead
     */
    async appendCustomerPhotos(finalPdf, customerImages, baseDir, headerDataUrl, footerDataUrl) {
        if (!customerImages || customerImages.length === 0) return;

        for (const image of customerImages) {
            try {
                const imagePath = path.isAbsolute(image.file_path) ? image.file_path : path.join(baseDir, image.file_path);
                const imageBytes = await fs.readFile(imagePath);
                const ext = path.extname(imagePath).toLowerCase();
                
                let embedded;
                if (ext === '.pdf') {
                    // Merge PDF directly
                    const pdfBytes = await fs.readFile(imagePath);
                    const imagePdf = await PDFDocument.load(pdfBytes);
                    const pages = await finalPdf.copyPages(imagePdf, imagePdf.getPageIndices());
                    pages.forEach(page => finalPdf.addPage(page));
                    continue; // Skip the rest for PDFs as they're already merged
                } else if (ext === '.png') {
                    embedded = await finalPdf.embedPng(imageBytes);
                } else {
                    embedded = await finalPdf.embedJpg(imageBytes);
                }

                // Create page with letterhead
                const page = finalPdf.addPage([595.28, 841.89]); // A4
                
                // Add letterhead header if available
                if (headerDataUrl) {
                    const headerImg = await this.embedDataUrl(finalPdf, headerDataUrl);
                    const headerHeight = 100;
                    const headerWidth = page.getWidth();
                    page.drawImage(headerImg, {
                        x: 0,
                        y: page.getHeight() - headerHeight,
                        width: headerWidth,
                        height: headerHeight
                    });
                }

                // Add letterhead footer if available
                if (footerDataUrl) {
                    const footerImg = await this.embedDataUrl(finalPdf, footerDataUrl);
                    const footerHeight = 60;
                    const footerWidth = page.getWidth();
                    page.drawImage(footerImg, {
                        x: 0,
                        y: 0,
                        width: footerWidth,
                        height: footerHeight
                    });
                }

                // Calculate available space for image
                const topMargin = headerDataUrl ? 110 : 36;
                const bottomMargin = footerDataUrl ? 70 : 36;
                const sideMargin = 36;
                
                const maxWidth = page.getWidth() - (sideMargin * 2);
                const maxHeight = page.getHeight() - topMargin - bottomMargin;
                
                const { width, height } = embedded.scale(1);
                const scale = Math.min(maxWidth / width, maxHeight / height, 1);
                const scaledWidth = width * scale;
                const scaledHeight = height * scale;
                
                const x = (page.getWidth() - scaledWidth) / 2;
                const y = bottomMargin + (maxHeight - scaledHeight) / 2;
                
                page.drawImage(embedded, {
                    x,
                    y,
                    width: scaledWidth,
                    height: scaledHeight
                });
            } catch (error) {
                logger.error('Error adding customer image to PDF:', {
                    imagePath: image.file_path,
                    error: error.message
                });
            }
        }
    }

    /**
     * Append customer documents with letterhead
     */
    async appendCustomerDocuments(finalPdf, customerDocuments, baseDir, headerDataUrl, footerDataUrl) {
        if (!customerDocuments || customerDocuments.length === 0) return;

        for (const document of customerDocuments) {
            try {
                const documentPath = path.isAbsolute(document.file_path) ? document.file_path : path.join(baseDir, document.file_path);
                const documentBytes = await fs.readFile(documentPath);
                const ext = path.extname(documentPath).toLowerCase();
                
                let embedded;
                if (ext === '.pdf') {
                    // Merge PDF directly
                    const pdfBytes = await fs.readFile(documentPath);
                    const documentPdf = await PDFDocument.load(pdfBytes);
                    const pages = await finalPdf.copyPages(documentPdf, documentPdf.getPageIndices());
                    pages.forEach(page => finalPdf.addPage(page));
                    continue; // Skip the rest for PDFs as they're already merged
                } else if (ext === '.png') {
                    embedded = await finalPdf.embedPng(documentBytes);
                } else if (ext === '.jpg' || ext === '.jpeg') {
                    embedded = await finalPdf.embedJpg(documentBytes);
                } else {
                    // Skip unsupported document formats
                    logger.warn('Skipping unsupported document format in customer documents section:', {
                        documentPath: document.file_path,
                        docType: document.doc_type,
                        extension: ext
                    });
                    continue;
                }

                // Create page with letterhead
                const page = finalPdf.addPage([595.28, 841.89]); // A4
                
                // Add letterhead header if available
                if (headerDataUrl) {
                    const headerImg = await this.embedDataUrl(finalPdf, headerDataUrl);
                    const headerHeight = 100;
                    const headerWidth = page.getWidth();
                    page.drawImage(headerImg, {
                        x: 0,
                        y: page.getHeight() - headerHeight,
                        width: headerWidth,
                        height: headerHeight
                    });
                }

                // Add letterhead footer if available
                if (footerDataUrl) {
                    const footerImg = await this.embedDataUrl(finalPdf, footerDataUrl);
                    const footerHeight = 60;
                    const footerWidth = page.getWidth();
                    page.drawImage(footerImg, {
                        x: 0,
                        y: 0,
                        width: footerWidth,
                        height: footerHeight
                    });
                }

                // Calculate available space for document
                const topMargin = headerDataUrl ? 110 : 36;
                const bottomMargin = footerDataUrl ? 70 : 36;
                const sideMargin = 36;
                
                const maxWidth = page.getWidth() - (sideMargin * 2);
                const maxHeight = page.getHeight() - topMargin - bottomMargin;
                
                const { width, height } = embedded.scale(1);
                const scale = Math.min(maxWidth / width, maxHeight / height, 1);
                const scaledWidth = width * scale;
                const scaledHeight = height * scale;
                
                const x = (page.getWidth() - scaledWidth) / 2;
                const y = bottomMargin + (maxHeight - scaledHeight) / 2;
                
                page.drawImage(embedded, {
                    x,
                    y,
                    width: scaledWidth,
                    height: scaledHeight
                });
            } catch (error) {
                logger.error('Error adding customer document to PDF:', {
                    documentPath: document.file_path,
                    docType: document.doc_type,
                    error: error.message
                });
            }
        }
    }

    /**
     * Append pathology report with letterhead
     */
    async appendPathologyReport(finalPdf, pathologyData, appointmentData, headerDataUrl, footerDataUrl) {
        // Prefer the already-generated pathology PDF for consistent design
        if (!pathologyData || !pathologyData.pdf_path) {
            return;
        }

        const baseDir = path.resolve(__dirname, '../../');
        const absolutePdfPath = path.join(baseDir, pathologyData.pdf_path);
        try {
            const pdfBuffer = await fs.readFile(absolutePdfPath);
            const pathologyPdf = await PDFDocument.load(pdfBuffer);
            const pages = await finalPdf.copyPages(pathologyPdf, pathologyPdf.getPageIndices());
            pages.forEach(page => finalPdf.addPage(page));
        } catch (err) {
            logger.error('Failed to append pathology PDF to TPA PDF', { err, pathologyPdfPath: absolutePdfPath, appointmentId: appointmentData.id });
        }
    }

    /**
     * Append reports by type
     */
    async appendReportsByType(finalPdf, reports, reportType, baseDir, headerDataUrl, footerDataUrl) {
        const filteredReports = reports.filter(r => r.report_type === reportType);
        
        for (const report of filteredReports) {
            try {
                const reportPath = path.isAbsolute(report.file_path) ? report.file_path : path.join(baseDir, report.file_path);
                const ext = path.extname(reportPath).toLowerCase();

                if (ext === '.pdf') {
                    // Merge PDF directly
                    const pdfBytes = await fs.readFile(reportPath);
                    const reportPdf = await PDFDocument.load(pdfBytes);
                    const pages = await finalPdf.copyPages(reportPdf, reportPdf.getPageIndices());
                    pages.forEach(page => finalPdf.addPage(page));
                } else if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                    // Add image as page
                    const imageBytes = await fs.readFile(reportPath);
                    let embedded;
                    if (ext === '.png') {
                        embedded = await finalPdf.embedPng(imageBytes);
                    } else {
                        embedded = await finalPdf.embedJpg(imageBytes);
                    }

                    const page = finalPdf.addPage([595.28, 841.89]);
                    const { width, height } = embedded.scale(1);
                    const margin = 36;
                    const maxWidth = page.getWidth() - margin * 2;
                    const maxHeight = page.getHeight() - margin * 2;
                    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
                    const scaledWidth = width * scale;
                    const scaledHeight = height * scale;
                    const x = (page.getWidth() - scaledWidth) / 2;
                    const y = (page.getHeight() - scaledHeight) / 2;
                    page.drawImage(embedded, { x, y, width: scaledWidth, height: scaledHeight });
                }
            } catch (err) {
                console.error(`Failed to append ${reportType} report:`, report.file_path, err.message);
                continue;
            }
        }
    }

    /**
    /**
     * Check if result is abnormal
     */
    isAbnormal(result, normalRange) {
        if (!result || !normalRange) return false;
        const numResult = parseFloat(result);
        if (isNaN(numResult)) return false;
        
        const rangeMatch = normalRange.match(/(\d+\.?\d*)\s*-\s*(\d+\.?\d*)/);
        if (rangeMatch) {
            const min = parseFloat(rangeMatch[1]);
            const max = parseFloat(rangeMatch[2]);
            return numResult < min || numResult > max;
        }
        return false;
    }

    /**
     * Embed data URL as image in PDF
     */
    async embedDataUrl(pdfDoc, dataUrl) {
        const base64Data = dataUrl.split(',')[1];
        const imageBytes = Buffer.from(base64Data, 'base64');
        
        if (dataUrl.startsWith('data:image/png')) {
            return await pdfDoc.embedPng(imageBytes);
        } else {
            return await pdfDoc.embedJpg(imageBytes);
        }
    }

    /**
     * Save PDF to file system
     */
    async savePDF(pdfBuffer, caseNumber) {
        // Organize by case_number subfolder
        const safeCaseFolder = sanitizeFolderName(caseNumber);
        const uploadsDir = safeCaseFolder
            ? path.join(__dirname, '../../uploads/appointment_tpa_pdfs', safeCaseFolder)
            : path.join(__dirname, '../../uploads/appointment_tpa_pdfs');
        await fs.mkdir(uploadsDir, { recursive: true });
        const timestamp = Date.now();
        const sanitizedCaseNumber = (caseNumber || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `TPA_${sanitizedCaseNumber}_${timestamp}.pdf`;
        const filepath = path.join(uploadsDir, filename);
        await fs.writeFile(filepath, pdfBuffer);
        return safeCaseFolder
            ? `uploads/appointment_tpa_pdfs/${safeCaseFolder}/${filename}`
            : `uploads/appointment_tpa_pdfs/${filename}`;
    }
}

const appointmentTPAPDFService = new AppointmentTPAPDFService();
appointmentTPAPDFService.generateTPAPDF = appointmentTPAPDFService.generateTPAPDF.bind(appointmentTPAPDFService);
appointmentTPAPDFService.fetchAppointmentData = appointmentTPAPDFService.fetchAppointmentData.bind(appointmentTPAPDFService);
appointmentTPAPDFService.savePDF = appointmentTPAPDFService.savePDF.bind(appointmentTPAPDFService);

module.exports = appointmentTPAPDFService;
