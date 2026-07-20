/**
 * Appointments Module - Main Export
 * Provides backward-compatible exports for the refactored appointment system
 * 
 * This file maintains the same API as the old s_appointments.js
 * All existing code importing from s_appointments.js will work without changes
 */

const AppointmentCRUD = require('./AppointmentCRUD');
const AppointmentFlow = require('./AppointmentFlow');
const AppointmentQueries = require('./AppointmentQueries');
const AppointmentExcel = require('./AppointmentExcel');
const AppointmentReports = require('./AppointmentReports');
const AppointmentQC = require('./AppointmentQC');
const AppointmentDocuments = require('./AppointmentDocuments');
const AppointmentInvoice = require('./AppointmentInvoice');
const AppointmentPathology = require('./AppointmentPathology');
const AppointmentMasterPDF = require('./AppointmentMasterPDF');
const AppointmentTPAPDF = require('./AppointmentComprehensivePDF');
const AppointmentSummaryPDF = require('./AppointmentSummaryPDF');
const AppointmentEmail = require('./AppointmentEmail');

// Export all CRUD operations
const {
    createAppointment,
    cloneAppointment,
    listAppointments,
    getAppointment,
    getAppointmentsByIds,
    updateAppointment,
    softDeleteAppointments,
    deleteAppointment,
    bulkUpdateAppointments,
    updateAppointmentStatus
} = AppointmentCRUD;

// Export all flow/status operations
const {
    STATUS_FLOW,
    isValidStatusTransition,
    logStatusHistory,
    confirmSchedule,
    rescheduleAppointment,
    pushBackAppointment,
    restoreAppointment,
    updateMedicalStatus,
    markTestCompleted,
    bulkMarkTestsCompleted,
    updateAppointmentTestAssignments,
    completeAppointment
} = AppointmentFlow;

// Export all query operations
const {
    listAppointmentsByCenter,
    listAppointmentsByTechnician,
    listCenterPendingAppointments,
    listPendingAppointments,
    listAllConfirmedAppointments,
    getTestsByClientAndInsurer,
    getTestsAndCategoriesByClientAndInsurer,
    getAppointmentWithTests,
    getAppointmentWithTestsByCenter,
    listAppointmentReports,
    saveAppointmentReports,
    saveAppointmentMedicalFiles,
    getAppointmentTest,
    getAppointmentCompletionStatus
} = AppointmentQueries;

// Export Excel operations
const {
    generateTemplate,
    processUploadedFile,
    getAppointmentsForExport,
    generateExportExcel
} = AppointmentExcel;

// Export Reports operations
const {
    uploadCategorizedReports,
    deleteCategorizedReport,
    getCategorizedReports,
    submitReportsForQC,
    getReportCounts
} = AppointmentReports;

// Export QC operations
const {
    listQCPendingAppointments,
    getQCAppointmentDetails,
    pushBackToReports,
    saveQCVerification,
    getQCHistory,
    getAllQcHistory
} = AppointmentQC;

// Export Documents operations
const {
    addDocument,
    deleteDocument,
    getDocuments,
    addCustomerImage,
    deleteCustomerImage,
    getCustomerImages,
    updateImageLabel,
    batchAddDocumentsAndImages
} = AppointmentDocuments;

// Export Invoice operations
const {
    generateProformaInvoicePdf,
    getProformaInvoiceData
} = AppointmentInvoice;

// Backward-compatible function names (aliases)
const listAppointmentsbyDiagnosticCenters = listAppointmentsByCenter;
const listAppointmentsbyTechnician = listAppointmentsByTechnician;
const UpdateAppointmentsTechnicianDiagnosticCenters = bulkUpdateAppointments;

// Export everything (backward compatible with old s_appointments.js)
module.exports = {
    // CRUD Operations
    createAppointment,
    cloneAppointment,
    listAppointments,
    getAppointment,
    getAppointmentsByIds,
    updateAppointment,
    softDeleteAppointments,
    deleteAppointment,
    bulkUpdateAppointments,
    updateAppointmentStatus,

    // Flow & Status Operations
    STATUS_FLOW,
    isValidStatusTransition,
    logStatusHistory,
    confirmSchedule,
    rescheduleAppointment,
    pushBackAppointment,
    restoreAppointment,
    updateMedicalStatus,
    markTestCompleted,
    bulkMarkTestsCompleted,
    updateAppointmentTestAssignments,
    completeAppointment,

    // Query Operations
    listAppointmentsByCenter,
    listAppointmentsByTechnician,
    listCenterPendingAppointments,
    listPendingAppointments,
    listAllConfirmedAppointments,
    getTestsByClientAndInsurer,
    getTestsAndCategoriesByClientAndInsurer,
    getAppointmentWithTests,
    getAppointmentWithTestsByCenter,
    listAppointmentReports,
    saveAppointmentReports,
    saveAppointmentMedicalFiles,
    getAppointmentTest,
    getAppointmentCompletionStatus,

    // Backward-compatible aliases
    listAppointmentsbyDiagnosticCenters,
    listAppointmentsbyTechnician,
    UpdateAppointmentsTechnicianDiagnosticCenters,

    // Excel Operations
    generateTemplate,
    processUploadedFile,
    getAppointmentsForExport,
    generateExportExcel,

    // Categorized Reports Operations
    uploadCategorizedReports,
    deleteCategorizedReport,
    getCategorizedReports,
    submitReportsForQC,
    getReportCounts,

    // QC Operations
    listQCPendingAppointments,
    listQcPendingAppointments: listQCPendingAppointments,  // Alias for consistency
    getQCAppointmentDetails,
    getQcDetails: getQCAppointmentDetails,  // Alias for consistency
    pushBackToReports,
    saveQCVerification,
    getQCHistory,
    getAllQcHistory,

    // Documents & Images Operations
    addDocument,
    deleteDocument,
    getDocuments,
    addCustomerImage,
    deleteCustomerImage,
    getCustomerImages,
    updateImageLabel,
    batchAddDocumentsAndImages,

    // Invoice Operations
    generateProformaInvoicePdf,
    getProformaInvoiceData,

    // Pathology Operations
    fetchAndSavePathologyData: AppointmentPathology.fetchAndSavePathologyData,
    getPathologyData: AppointmentPathology.getPathologyData,
    hasPathologyData: AppointmentPathology.hasPathologyData,

    // PDF Operations
    generateMasterPDF: AppointmentMasterPDF.generateMasterPDF,
    generateTPAPDF: AppointmentTPAPDF.generateTPAPDF,
    generateAppointmentSummaryPDF: AppointmentSummaryPDF.generateAppointmentSummaryPDF,

    // Email Operations
    sendAppointmentEmailToClient: AppointmentEmail.sendAppointmentEmailToClient
};
