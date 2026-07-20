const lifecycleService = require('../appointments/AppointmentLifecycleService');
const coreAppointments = require('../appointments');
const logger = require('../../lib/logger');

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function buildFileUrl(baseUrl, filePath) {
    const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
    const cleanPath = normalizePath(filePath);
    if (!cleanPath) return null;
    return cleanBase ? `${cleanBase}/${cleanPath}` : `/${cleanPath}`;
}

function buildApiUrl(baseUrl, path) {
    const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
    const cleanPath = String(path || '').replace(/^\/+/, '');
    if (!cleanPath) return null;
    return cleanBase ? `${cleanBase}/${cleanPath}` : `/${cleanPath}`;
}

function titleCaseStatus(value, fallback = 'created') {
    const raw = String(value || fallback || '').trim();
    if (!raw) return null;
    return raw
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeTransitionValue(value, fallback = 'created') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return raw;
}

function statusTransition(oldValue, newValue, options = {}) {
    let from = normalizeTransitionValue(oldValue, 'created');
    const to = normalizeTransitionValue(newValue, from);

    if (options.changeType === 'schedule_confirm' && from === 'pending') {
        from = 'created';
    }

    return {
        from,
        to,
        from_label: titleCaseStatus(from),
        to_label: titleCaseStatus(to)
    };
}

function ageLabel(timestamp) {
    if (!timestamp) return null;
    const time = new Date(timestamp).getTime();
    if (Number.isNaN(time)) return null;

    const diffMs = Date.now() - time;
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diffMs < minute) return 'just now';
    if (diffMs < hour) return `${Math.floor(diffMs / minute)} min ago`;
    if (diffMs < day) return `${Math.floor(diffMs / hour)} hours ago`;
    return `${Math.floor(diffMs / day)} days ago`;
}

function formatDateDisplay(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

function formatTimeDisplay(value) {
    if (!value) return null;

    const directMatch = String(value).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (directMatch) {
        const hours = Number(directMatch[1]);
        const minutes = directMatch[2];
        const suffix = hours >= 12 ? 'PM' : 'AM';
        const hour12 = hours % 12 || 12;
        return `${hour12}:${minutes} ${suffix}`;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });
}

function formatCurrencyDisplay(amount, costType) {
    const numericAmount = Number(amount);
    const safeAmount = Number.isFinite(numericAmount) ? numericAmount.toFixed(2) : '0.00';
    const typeLabel = costType ? titleCaseStatus(costType, '') : null;
    return typeLabel ? `₹${safeAmount} (${typeLabel})` : `₹${safeAmount}`;
}

function formatCustomerCategory(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const normalized = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    const labels = {
        'non hni': 'Non HNI',
        'hni': 'HNI',
        'super hni': 'Super HNI'
    };

    return labels[normalized] || titleCaseStatus(normalized);
}

function formatDocuments(documents, baseUrl) {
    return documents.map((doc) => ({
        id: doc.id,
        type: doc.doc_type,
        number: doc.doc_number,
        file_name: doc.file_name,
        file_path: normalizePath(doc.file_path),
        file_url: buildFileUrl(baseUrl, doc.file_path),
        uploaded_at: doc.uploaded_at
    }));
}

function formatImages(images, baseUrl) {
    return images.map((image) => ({
        id: image.id,
        label: image.image_label,
        file_name: image.file_name,
        file_path: normalizePath(image.file_path),
        file_url: buildFileUrl(baseUrl, image.file_path),
        uploaded_at: image.uploaded_at
    }));
}

function formatCategorizedReports(reports, baseUrl) {
    const formatted = {};

    Object.entries(reports || {}).forEach(([key, value]) => {
        if (key === 'remarks') {
            formatted.remarks = value || null;
            return;
        }

        formatted[key] = Array.isArray(value)
            ? value.map((report) => ({
                id: report.id,
                report_type: report.report_type,
                file_name: report.file_name,
                file_path: normalizePath(report.file_path),
                file_url: buildFileUrl(baseUrl, report.file_path),
                uploaded_at: report.uploaded_at,
                uploaded_by_name: report.uploaded_by_name || null
            }))
            : [];
    });

    return formatted;
}

function normalizeEventType(event) {
    if (event.type === 'creation') return 'created';
    if (event.type === 'qc_action') return 'qc';
    return 'updated';
}

function derivePrimaryChange(event) {
    if (event.type === 'creation') {
        return { code: 'created', label: 'Created' };
    }

    const rawChangeType = String(event.change_type || event.action || '').trim();

    if (rawChangeType === 'medical_status_update') {
        const medicalCode = normalizeTransitionValue(event.new_medical_status, 'updated');
        return {
            code: medicalCode,
            label: titleCaseStatus(medicalCode)
        };
    }

    const labels = {
        schedule_confirm: 'Confirmed',
        schedule_reschedule: 'Rescheduled',
        push_back: 'Pushed Back',
        restore_appointment: 'Restored',
        qc_submit: 'Submitted for QC',
        qc_partial_save: 'QC Saved',
        qc_complete: 'QC Completed',
        qc_push_back: 'QC Pushed Back',
        submitted_for_qc: 'Submitted for QC',
        partial_save: 'QC Saved',
        completed: 'Completed',
        pushed_back: 'Pushed Back'
    };

    const code = rawChangeType || normalizeEventType(event);
    return {
        code,
        label: labels[code] || titleCaseStatus(code)
    };
}

function formatTimeline(timeline) {
    return (timeline || []).map((event) => {
        const primaryChange = derivePrimaryChange(event);
        return {
            type: normalizeEventType(event),
            type_label: titleCaseStatus(normalizeEventType(event)),
            type_code: event.type,
            change_type: primaryChange.code,
            change_type_label: primaryChange.label,
            change_type_code: event.change_type || event.action || null,
            timestamp: event.timestamp,
            date_label: formatDateDisplay(event.timestamp),
            time_label: formatTimeDisplay(event.timestamp),
            age_label: ageLabel(event.timestamp),
            title: event.title,
            description: event.description,
            icon: event.icon,
            user: event.user || null,
            remarks: event.remarks || null,
            status_transition: event.type === 'creation'
                ? null
                : statusTransition(event.old_status, event.new_status, { changeType: event.change_type }),
            medical_transition: event.type === 'creation'
                ? null
                : statusTransition(event.old_medical_status, event.new_medical_status, { changeType: event.change_type }),
            metadata: event.metadata || {}
        };
    });
}

function formatTestAssignments(assignments) {
    return (assignments || []).map((item) => ({
        id: item.id,
        type: item.rate_type || (item.test_id ? 'test' : 'category'),
        name: item.test_name || item.category_name || item.item_name,
        visit_subtype: item.visit_subtype,
        status: item.status,
        is_completed: Number(item.is_completed || 0),
        technician_name: item.technician_full_name || null,
        report_type: item.test_report_type || item.category_report_type || null
    }));
}

function formatPdfDownloads(pdfDownloads, appointmentId, baseUrl) {
    const invoice = pdfDownloads?.invoice_pdf || {};
    const tpa = pdfDownloads?.tpa_pdf || {};
    const publicPath = `/api/app/appointments/tracker/public/${appointmentId}`;

    return {
        invoice_pdf: {
            available: Boolean(invoice.available),
            download_url: invoice.available
                ? buildApiUrl(baseUrl, `${publicPath}/proforma-invoice`)
                : null,
            requires_auth: false
        },
        tpa_pdf: {
            available: Boolean(tpa.available),
            download_url: tpa.available
                ? buildApiUrl(baseUrl, `${publicPath}/tpa-pdf`)
                : null,
            email_sent: Boolean(tpa.email_sent),
            email_sent_at: tpa.email_sent_at || null,
            requires_auth: false
        }
    };
}

async function getCaseTracker({ user, searchTerm, baseUrl }) {
    const lifecycle = await lifecycleService.getAppointmentLifecycle(searchTerm, user.id);
    if (!lifecycle) return null;

    const appointment = lifecycle.appointment;

    const safeSection = async (name, fallback, fn) => {
        try {
            return await fn();
        } catch (error) {
            logger.warn('App case tracker optional section skipped', {
                section: name,
                appointmentId: appointment.id,
                error: error.message
            });
            return fallback;
        }
    };

    const [documents, images, categorizedReports] = await Promise.all([
        safeSection('documents', [], () => coreAppointments.getDocuments(appointment.id)),
        safeSection('customer_images', [], () => coreAppointments.getCustomerImages(appointment.id)),
        // Intentionally unscoped for the mobile case tracker:
        // any authenticated app user can search any case/application/appointment number here.
        safeSection('categorized_reports', {}, () => coreAppointments.getCategorizedReports(
            appointment.id,
            null,
            null,
            'Admin'
        ))
    ]);

    const customerName = [appointment.customer_first_name, appointment.customer_last_name]
        .filter(Boolean)
        .join(' ')
        .trim();

    const formattedDocuments = formatDocuments(documents, baseUrl);
    const formattedImages = formatImages(images, baseUrl);

    return {
        appointment: {
            id: appointment.id,
            case_number: appointment.case_number,
            application_number: appointment.application_number,
            visit_type: appointment.visit_type,
            visit_type_label: titleCaseStatus(appointment.visit_type),
            customer_category: appointment.customer_category,
            customer_category_label: formatCustomerCategory(appointment.customer_category),
            amount: appointment.amount,
            cost_type: appointment.cost_type,
            amount_label: formatCurrencyDisplay(appointment.amount, appointment.cost_type),
            status: appointment.status || 'created',
            status_label: titleCaseStatus(appointment.status, 'created'),
            medical_status: appointment.medical_status || 'created',
            medical_status_label: titleCaseStatus(appointment.medical_status, 'created'),
            qc_status: appointment.qc_status || null,
            qc_status_label: appointment.qc_status ? titleCaseStatus(appointment.qc_status) : null,
            age_days: lifecycle.metrics?.age_days ?? null
        },
        parties: {
            client_name: appointment.client_name,
            client_code: appointment.client_code,
            insurer_name: appointment.insurer_name,
            center_name: appointment.center_name,
            center_code: appointment.center_code,
            other_center_name: appointment.other_center_name,
            technician_name: appointment.technician_name || null
        },
        customer: {
            name: customerName || null,
            first_name: appointment.customer_first_name,
            last_name: appointment.customer_last_name,
            gender: appointment.gender,
            mobile: appointment.customer_mobile,
            email: appointment.customer_email,
            city: appointment.city,
            state: appointment.state,
            pincode: appointment.pincode,
            address: appointment.customer_address,
            landmark: appointment.customer_landmark
        },
        schedule: {
            appointment_date: appointment.appointment_date,
            appointment_date_label: formatDateDisplay(appointment.appointment_date),
            appointment_time: appointment.appointment_time,
            appointment_time_label: formatTimeDisplay(appointment.appointment_time),
            confirmed_date: appointment.confirmed_date,
            confirmed_date_label: formatDateDisplay(appointment.confirmed_date),
            confirmed_time: appointment.confirmed_time,
            confirmed_time_label: formatTimeDisplay(appointment.confirmed_time),
            reschedule_remark: appointment.reschedule_remark || appointment.center_reschedule_remark || appointment.home_reschedule_remark || null,
            technician_name: appointment.technician_name || null
        },
        timeline: formatTimeline(lifecycle.timeline),
        documents: {
            total: formattedDocuments.length + formattedImages.length,
            customer_documents: formattedDocuments,
            customer_images: formattedImages
        },
        reports: {
            pdf_downloads: formatPdfDownloads(appointment.pdf_downloads, appointment.id, baseUrl),
            categorized: formatCategorizedReports(categorizedReports, baseUrl)
        },
        tests: formatTestAssignments(lifecycle.testAssignments),
        metrics: {
            total_events: lifecycle.metrics?.total_events || 0,
            status_changes: lifecycle.metrics?.status_changes || 0,
            medical_status_changes: lifecycle.metrics?.medical_status_changes || 0,
            qc_submissions: lifecycle.metrics?.qc_submissions || 0,
            qc_pushbacks: lifecycle.metrics?.qc_pushbacks || 0,
            reschedules: lifecycle.metrics?.reschedules || 0
        }
    };
}

module.exports = {
    getCaseTracker
};
