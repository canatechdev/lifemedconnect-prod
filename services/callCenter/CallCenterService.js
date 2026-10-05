const axios = require('axios');
const { getDistance } = require('geolib');
const db = require('../../lib/dbconnection');
const logger = require('../../lib/logger');
const pincodeService = require('./CallCenterPincodeService');

// One customer origin x 50 nearby centers gives planners a useful comparison
// while keeping each Google matrix request bounded and predictable.
const MAX_ROUTE_CANDIDATES = 50;
const AVAILABILITY_LOOKAHEAD_DAYS = 14;
const GOOGLE_TIMEOUT_MS = Math.max(Number(process.env.GOOGLE_MAPS_TIMEOUT_MS) || 10000, 2000);
const GOOGLE_ROUTES_TIMEOUT_MS = Math.max(Number(process.env.GOOGLE_ROUTES_TIMEOUT_MS) || 12000, 2000);
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROUTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const geocodeCache = new Map();
const routeMatrixCache = new Map();

function operationalError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.isOperational = true;
    return error;
}

function getGoogleMapsKey() {
    const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
    if (!key) {
        throw operationalError('Location services are not configured. Please contact an administrator.', 503);
    }
    return key;
}

function getGoogleRoutesKey() {
    const key = String(process.env.GOOGLE_ROUTES_API_KEY || '').trim();
    if (!key) {
        throw operationalError('Google road-distance service is not configured. Please contact an administrator.', 503);
    }
    return key;
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 2) {
    const factor = 10 ** decimals;
    return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
}

function normalizeDate(value) {
    if (!value) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function getIndiaDate() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const lookup = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function addDays(dateString, days) {
    const date = new Date(`${dateString}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function buildDateRange(startDate, days) {
    return Array.from({ length: days }, (_, index) => addDays(startDate, index));
}

function normalizeGender(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'male' || normalized === 'female') return normalized;
    return 'other';
}

function normalizePincode(value) {
    const pincode = String(value || '').replace(/\D/g, '');
    return /^\d{6}$/.test(pincode) ? pincode : null;
}

function buildLocationQuery({ address, landmark, pincode }) {
    const parts = [address, landmark, pincode, 'India']
        .map((part) => String(part || '').trim())
        .filter(Boolean);
    return Array.from(new Set(parts)).join(', ');
}

function getCachedLocation(key) {
    const cached = geocodeCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) {
        geocodeCache.delete(key);
        return undefined;
    }
    return cached.value;
}

function cacheLocation(key, value) {
    geocodeCache.set(key, { value, expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS });
    return value;
}

function postalCodeFromResult(candidate) {
    const postalComponent = (candidate?.address_components || []).find((component) => (
        Array.isArray(component.types) && component.types.includes('postal_code')
    ));
    return normalizePincode(postalComponent?.long_name);
}

function cityFromResult(candidate) {
    const components = candidate?.address_components || [];
    const preferredTypes = [
        'locality',
        'postal_town',
        'administrative_area_level_3',
        'administrative_area_level_2',
    ];
    for (const type of preferredTypes) {
        const component = components.find((item) => Array.isArray(item.types) && item.types.includes(type));
        if (component?.long_name) return component.long_name;
    }
    return null;
}

async function reverseGeocodePincode(latitude, longitude) {
    const cacheKey = `reverse:${Number(latitude).toFixed(5)},${Number(longitude).toFixed(5)}`;
    const cached = getCachedLocation(cacheKey);
    if (cached !== undefined) return cached;

    let pincode = null;
    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
            params: {
                latlng: `${latitude},${longitude}`,
                result_type: 'postal_code',
                key: getGoogleMapsKey(),
                region: 'in',
            },
            timeout: GOOGLE_TIMEOUT_MS,
        });
        pincode = response.data?.status === 'OK'
            ? (response.data.results || []).map(postalCodeFromResult).find(Boolean) || null
            : null;
    } catch (error) {
        logger.warn('Call Center reverse-geocode pincode lookup failed', {
            message: error.response?.data?.status || error.message,
        });
    }
    return cacheLocation(cacheKey, pincode);
}

async function geocodeLocation(input) {
    if (input.latitude !== undefined && input.longitude !== undefined) {
        const latitude = toNumber(input.latitude, NaN);
        const longitude = toNumber(input.longitude, NaN);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            const pincode = normalizePincode(input.pincode)
                || await reverseGeocodePincode(latitude, longitude);
            return {
                formatted_address: buildLocationQuery(input),
                latitude,
                longitude,
                pincode,
                city: null,
                approximate: false,
            };
        }
    }

    const query = buildLocationQuery(input);
    if (!query || query === 'India') {
        throw operationalError('Address, landmark, or pincode is required.', 400);
    }

    const cacheKey = `address:${query.toLowerCase()}`;
    const cached = getCachedLocation(cacheKey);
    if (cached !== undefined) return cached;

    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: { address: query, key: getGoogleMapsKey(), region: 'in' },
        timeout: GOOGLE_TIMEOUT_MS,
    });

    if (response.data?.status !== 'OK' || !response.data?.results?.length) {
        throw operationalError(
            response.data?.status === 'ZERO_RESULTS'
                ? 'No location was found for the supplied address.'
                : `Unable to resolve location (${response.data?.status || 'unknown response'}).`,
            response.data?.status === 'ZERO_RESULTS' ? 404 : 502,
        );
    }

    // Google can return a useful coordinate in the first result while placing
    // the postal code in another result from the same request.
    const result = response.data.results.find((candidate) => postalCodeFromResult(candidate))
        || response.data.results[0];
    const locationType = result.geometry?.location_type || 'UNKNOWN';
    const pincodeOnly = !String(input.address || '').trim() && !String(input.landmark || '').trim();

    const resolvedPincode = normalizePincode(input.pincode)
        || postalCodeFromResult(result)
        || response.data.results.map(postalCodeFromResult).find(Boolean)
        // Only ambiguous area searches need this second request. It uses the
        // coordinate already obtained above and is cached for 24 hours.
        || await reverseGeocodePincode(result.geometry.location.lat, result.geometry.location.lng);
    return cacheLocation(cacheKey, {
        formatted_address: result.formatted_address,
        latitude: result.geometry.location.lat,
        longitude: result.geometry.location.lng,
        pincode: resolvedPincode,
        city: cityFromResult(result),
        approximate: pincodeOnly || result.partial_match || locationType === 'APPROXIMATE',
    });
}

async function getEligibleCenters(centerIds = null) {
    const ids = Array.isArray(centerIds) ? centerIds.map(Number).filter(Number.isInteger) : [];
    const conditions = ['is_deleted = 0'];
    const params = [];
    if (ids.length) {
        conditions.push(`id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
    }
    if (Array.isArray(centerIds) && !ids.length) return [];
    return db.query(`
        SELECT id, center_name, address, city, state, pincode,
               gps_latitude, gps_longitude, service_radius_km, extra_charge_per_km
        FROM diagnostic_centers
        WHERE ${conditions.join(' AND ')}
        ORDER BY center_name ASC
    `, params);
}

async function getTechniciansForPincode(pincode) {
    const normalizedPincode = normalizePincode(pincode);
    if (!normalizedPincode) return [];
    const technicians = await db.query(`
        SELECT t.id, t.full_name, t.technician_type, t.call_center_priority, t.male_daily_capacity,
               t.female_daily_capacity, t.other_daily_capacity, t.service_pincodes,
               dc.center_name AS home_center_name, dc.pincode AS home_center_pincode
        FROM technicians t
        INNER JOIN diagnostic_centers dc ON dc.id = t.center_id
        WHERE t.is_deleted = 0 AND t.is_active = 1
          AND dc.is_deleted = 0
        ORDER BY t.call_center_priority ASC, t.full_name ASC
    `);

    return technicians.filter((technician) => {
        const configuredPincodes = String(technician.service_pincodes || '')
            .split(/[\s,;|]+/)
            .map(normalizePincode)
            .filter(Boolean);
        if (configuredPincodes.length) return configuredPincodes.includes(normalizedPincode);
        return normalizePincode(technician.home_center_pincode) === normalizedPincode;
    });
}

async function getUnavailability(technicianIds, startDate, endDate, dates) {
    if (!technicianIds.length) return new Map();
    const placeholders = technicianIds.map(() => '?').join(',');
    const rows = await db.query(`
        SELECT tu.id, tu.technician_id,
               DATE_FORMAT(tu.unavailable_from, '%Y-%m-%d') AS unavailable_from,
               DATE_FORMAT(tu.unavailable_to, '%Y-%m-%d') AS unavailable_to,
               tu.reason
        FROM technician_unavailability tu
        WHERE tu.is_deleted = 0
          AND tu.technician_id IN (${placeholders})
          AND tu.unavailable_from <= ?
          AND tu.unavailable_to >= ?
        ORDER BY tu.unavailable_from ASC
    `, [...technicianIds, endDate, startDate]);

    const result = new Map();
    rows.forEach((row) => {
        const technicianId = Number(row.technician_id);
        if (!result.has(technicianId)) result.set(technicianId, new Map());
        dates.forEach((date) => {
            if (date >= row.unavailable_from && date <= row.unavailable_to && !result.get(technicianId).has(date)) {
                result.get(technicianId).set(date, row);
            }
        });
    });
    return result;
}

async function getDailyAssignments(technicianIds, startDate, endDate) {
    if (!technicianIds.length) return new Map();
    const placeholders = technicianIds.map(() => '?').join(',');

    const itemAssignments = await db.query(`
        SELECT DISTINCT at.assigned_technician_id AS technician_id, a.id AS appointment_id,
               a.case_number, a.application_number, a.customer_first_name,
               a.customer_last_name, a.gender, a.appointment_time, a.visit_type,
               DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS planning_date
        FROM appointment_tests at
        INNER JOIN appointments a ON a.id = at.appointment_id
        WHERE at.assigned_technician_id IN (${placeholders})
          AND LOWER(COALESCE(at.visit_subtype, '')) = 'home'
          AND a.is_deleted = 0 AND a.is_active = 1
          AND DATE(a.appointment_date) BETWEEN ? AND ?
          AND a.visit_type IN ('Home_Visit', 'Both')
    `, [...technicianIds, startDate, endDate]);

    const legacyAssignments = await db.query(`
        SELECT a.assigned_technician_id AS technician_id, a.id AS appointment_id,
               a.case_number, a.application_number, a.customer_first_name,
               a.customer_last_name, a.gender, a.appointment_time, a.visit_type,
               DATE_FORMAT(a.appointment_date, '%Y-%m-%d') AS planning_date
        FROM appointments a
        WHERE a.assigned_technician_id IN (${placeholders})
          AND a.is_deleted = 0 AND a.is_active = 1
          AND DATE(a.appointment_date) BETWEEN ? AND ?
          AND a.visit_type IN ('Home_Visit', 'Both')
          AND NOT EXISTS (
              SELECT 1 FROM appointment_tests existing_assignment
              WHERE existing_assignment.appointment_id = a.id
                AND existing_assignment.assigned_technician_id IS NOT NULL
                AND LOWER(COALESCE(existing_assignment.visit_subtype, '')) = 'home'
          )
    `, [...technicianIds, startDate, endDate]);

    const assignments = new Map();
    [...itemAssignments, ...legacyAssignments].forEach((row) => {
        const technicianId = Number(row.technician_id);
        const planningDate = normalizeDate(row.planning_date);
        if (!planningDate) return;
        if (!assignments.has(technicianId)) assignments.set(technicianId, new Map());
        if (!assignments.get(technicianId).has(planningDate)) assignments.get(technicianId).set(planningDate, new Map());
        assignments.get(technicianId).get(planningDate).set(Number(row.appointment_id), {
            appointment_id: Number(row.appointment_id),
            case_number: row.case_number,
            gender: row.gender || null,
            appointment_time: row.appointment_time,
        });
    });

    const normalized = new Map();
    assignments.forEach((dates, technicianId) => {
        const dateRows = new Map();
        dates.forEach((rows, date) => dateRows.set(date, Array.from(rows.values())));
        normalized.set(technicianId, dateRows);
    });
    return normalized;
}

function decorateTechnician(technician, assignments, unavailability, appointmentDate, dates, gender) {
    const technicianAssignmentsByDate = assignments.get(Number(technician.id)) || new Map();
    const technicianUnavailabilityByDate = unavailability.get(Number(technician.id)) || new Map();
    const capacityValue = (value) => (value === null || value === undefined || value === ''
        ? null
        : toNumber(value));
    const capacities = {
        male: capacityValue(technician.male_daily_capacity),
        female: capacityValue(technician.female_daily_capacity),
        other: capacityValue(technician.other_daily_capacity),
    };
    const selectedGender = gender ? normalizeGender(gender) : null;
    const availabilityByDate = dates.map((date) => {
        const technicianAssignments = technicianAssignmentsByDate.get(date) || [];
        const counts = { male: 0, female: 0, other: 0 };
        technicianAssignments.forEach((appointment) => {
            counts[normalizeGender(appointment.gender)] += 1;
        });
        const remaining = {
            male: capacities.male === null ? null : Math.max(0, capacities.male - counts.male),
            female: capacities.female === null ? null : Math.max(0, capacities.female - counts.female),
            other: capacities.other === null ? null : Math.max(0, capacities.other - counts.other),
        };
        const unavailablePeriod = technicianUnavailabilityByDate.get(date) || null;
        const hasCapacity = selectedGender
            ? remaining[selectedGender] === null || remaining[selectedGender] > 0
            : Object.values(remaining).some((value) => value === null || value > 0);

        return {
            date,
            remaining_capacity: remaining,
            total_appointments: technicianAssignments.length,
            appointments: technicianAssignments,
            unavailable: Boolean(unavailablePeriod),
            unavailability: unavailablePeriod,
            available: !unavailablePeriod && hasCapacity,
        };
    });
    const selectedAvailability = availabilityByDate.find((item) => item.date === appointmentDate) || availabilityByDate[0];
    const technicianAssignments = selectedAvailability.appointments;

    return {
        id: Number(technician.id),
        full_name: technician.full_name,
        technician_type: technician.technician_type,
        home_center_name: technician.home_center_name,
        priority: toNumber(technician.call_center_priority, 100),
        daily_capacity: capacities,
        remaining_capacity: selectedAvailability.remaining_capacity,
        total_appointments: selectedAvailability.total_appointments,
        appointments: technicianAssignments,
        unavailable: selectedAvailability.unavailable,
        unavailability: selectedAvailability.unavailability ? {
            from: selectedAvailability.unavailability.unavailable_from,
            to: selectedAvailability.unavailability.unavailable_to,
            reason: selectedAvailability.unavailability.reason,
        } : null,
        available: selectedAvailability.available,
        availability_calendar: availabilityByDate.map((item) => ({
            date: item.date,
            available: item.available,
            unavailable: item.unavailable,
            unavailable_until: item.unavailability?.unavailable_to || null,
            unavailability_reason: item.unavailability?.reason || null,
            remaining_capacity: item.remaining_capacity,
            total_appointments: item.total_appointments,
        })),
    };
}

function calculateCenterCost(center, distanceKm) {
    if (!Number.isFinite(distanceKm)) {
        return {
            service_radius_km: round(Math.max(0, toNumber(center.service_radius_km)), 2),
            extra_charge_per_km: round(Math.max(0, toNumber(center.extra_charge_per_km)), 2),
            extra_distance_km: null,
            charge_distance_km: null,
            estimated_extra_charge: null,
            within_radius: false,
        };
    }
    const radius = Math.max(0, toNumber(center.service_radius_km));
    const rate = Math.max(0, toNumber(center.extra_charge_per_km));
    const extraDistance = Math.max(0, distanceKm - radius);
    const chargeDistance = extraDistance > 0 ? distanceKm * 2 : 0;
    return {
        service_radius_km: round(radius, 2),
        extra_charge_per_km: round(rate, 2),
        extra_distance_km: round(extraDistance, 2),
        charge_distance_km: round(chargeDistance, 2),
        estimated_extra_charge: round(chargeDistance * rate, 2),
        within_radius: extraDistance === 0,
    };
}

function routeCacheKey(origin, centers) {
    const originKey = `${toNumber(origin.latitude).toFixed(5)},${toNumber(origin.longitude).toFixed(5)}`;
    const centerKey = centers.map((center) => (
        `${center.id}:${toNumber(center.gps_latitude).toFixed(5)},${toNumber(center.gps_longitude).toFixed(5)}`
    )).join('|');
    return `${originKey}->${centerKey}`;
}

async function getGoogleRoadDistances(origin, centers) {
    if (!centers.length) return new Map();
    const cacheKey = routeCacheKey(origin, centers);
    const cached = routeMatrixCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) routeMatrixCache.delete(cacheKey);

    let response;
    try {
        response = await axios.post('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
            origins: [{
                waypoint: {
                    location: {
                        latLng: {
                            latitude: toNumber(origin.latitude),
                            longitude: toNumber(origin.longitude),
                        },
                    },
                },
            }],
            destinations: centers.map((center) => ({
                waypoint: {
                    location: {
                        latLng: {
                            latitude: toNumber(center.gps_latitude),
                            longitude: toNumber(center.gps_longitude),
                        },
                    },
                },
            })),
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_UNAWARE',
            languageCode: 'en-IN',
            units: 'METRIC',
        }, {
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': getGoogleRoutesKey(),
                'X-Goog-FieldMask': 'originIndex,destinationIndex,status,condition,distanceMeters,duration',
            },
            timeout: GOOGLE_ROUTES_TIMEOUT_MS,
        });
    } catch (error) {
        logger.error('Google Routes matrix request failed', {
            status: error.response?.status,
            message: error.response?.data?.error?.message || error.message,
        });
        throw operationalError(
            error.response?.data?.error?.message || 'Google road distance is temporarily unavailable.',
            error.response?.status === 403 ? 503 : 502,
        );
    }

    const routes = new Map();
    (Array.isArray(response.data) ? response.data : []).forEach((element) => {
        const destinationIndex = Number(element.destinationIndex);
        const center = centers[destinationIndex];
        const meters = Number(element.distanceMeters);
        const statusCode = Number(element.status?.code || 0);
        if (!center || statusCode !== 0 || element.condition !== 'ROUTE_EXISTS' || !Number.isFinite(meters)) return;
        const durationSeconds = Number.parseFloat(String(element.duration || '').replace(/s$/, ''));
        routes.set(Number(center.id), {
            distance_km: round(meters / 1000, 2),
            duration_minutes: Number.isFinite(durationSeconds) ? Math.round(durationSeconds / 60) : null,
        });
    });

    routeMatrixCache.set(cacheKey, {
        value: routes,
        expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
    });
    return routes;
}

async function getDecoratedTechnicians(pincode, appointmentDate, availabilityEndDate, availabilityDates, gender) {
    const technicians = await getTechniciansForPincode(pincode);
    const technicianIds = technicians.map((technician) => Number(technician.id));
    const [unavailability, assignments] = await Promise.all([
        getUnavailability(technicianIds, appointmentDate, availabilityEndDate, availabilityDates),
        getDailyAssignments(technicianIds, appointmentDate, availabilityEndDate),
    ]);
    return technicians.map((technician) => (
        decorateTechnician(
            technician,
            assignments,
            unavailability,
            appointmentDate,
            availabilityDates,
            gender,
        )
    ));
}

function rankCenters(centers) {
    return centers
        .sort((a, b) => (
            Number(b.available_technicians > 0) - Number(a.available_technicians > 0)
            || Number(b.within_radius) - Number(a.within_radius)
            || (a.estimated_extra_charge ?? Number.POSITIVE_INFINITY) - (b.estimated_extra_charge ?? Number.POSITIVE_INFINITY)
            || (a.distance_km ?? Number.POSITIVE_INFINITY) - (b.distance_km ?? Number.POSITIVE_INFINITY)
            || a.center_name.localeCompare(b.center_name)
        ))
        .map((center, index) => ({ ...center, rank: index + 1, recommended: index === 0 }));
}

async function searchConfiguredPincode(input, pricing) {
    const today = getIndiaDate();
    const appointmentDate = normalizeDate(input.appointment_date) || today;
    if (appointmentDate < today) throw operationalError('Availability can only be planned from today onwards.', 400);
    const availabilityDates = buildDateRange(appointmentDate, AVAILABILITY_LOOKAHEAD_DAYS);
    const availabilityEndDate = availabilityDates[availabilityDates.length - 1];
    const [mappedCenters, decoratedTechnicians] = await Promise.all([
        getEligibleCenters(pricing.center_ids),
        getDecoratedTechnicians(pricing.pincode, appointmentDate, availabilityEndDate, availabilityDates, input.gender),
    ]);
    const pricingByCenter = new Map(
        (pricing.center_pricing || []).map((item) => [Number(item.center_id), item]),
    );
    const mappedCoordinates = mappedCenters
        .filter((center) => center.gps_latitude !== null && center.gps_longitude !== null)
        .map((center) => ({ latitude: toNumber(center.gps_latitude), longitude: toNumber(center.gps_longitude) }))
        .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
    const fallbackLatitude = mappedCoordinates.length
        ? mappedCoordinates.reduce((sum, point) => sum + point.latitude, 0) / mappedCoordinates.length
        : null;
    const fallbackLongitude = mappedCoordinates.length
        ? mappedCoordinates.reduce((sum, point) => sum + point.longitude, 0) / mappedCoordinates.length
        : null;
    const availableTechnicians = decoratedTechnicians.filter((technician) => technician.available).length;
    const centers = rankCenters(mappedCenters.map((center) => {
        const centerPricing = pricingByCenter.get(Number(center.id)) || pricing;
        const oneWayDistance = centerPricing.average_one_way_distance_km;
        const roundTripDistance = oneWayDistance === null ? null : Number((oneWayDistance * 2).toFixed(2));
        const isFree = centerPricing.charge_type === 'free';
        const perKmRate = round(Math.max(0, toNumber(center.extra_charge_per_km)), 2);
        return {
        id: Number(center.id),
        center_name: center.center_name,
        address: center.address,
        city: center.city,
        state: center.state,
        pincode: center.pincode,
        latitude: center.gps_latitude === null ? null : toNumber(center.gps_latitude),
        longitude: center.gps_longitude === null ? null : toNumber(center.gps_longitude),
        distance_km: oneWayDistance,
        distance_source: 'configured_pincode',
        duration_minutes: null,
        service_radius_km: round(Math.max(0, toNumber(center.service_radius_km)), 2),
        extra_distance_km: null,
        charge_distance_km: roundTripDistance,
        estimated_extra_charge: isFree || roundTripDistance === null ? 0 : round(roundTripDistance * perKmRate, 2),
        within_radius: isFree,
        charge_type: centerPricing.charge_type,
        extra_charge_per_km: perKmRate,
        pricing_source: 'configured_pincode',
        available_technicians: availableTechnicians,
        total_technicians: decoratedTechnicians.length,
        technicians: decoratedTechnicians,
        };
    }));

    return {
        location: {
            input: pricing.pincode,
            formatted_address: pricing.formatted_address || `${pricing.city}, ${pricing.pincode}, India`,
            // A manually configured pincode may not have its own geocoded point.
            // Use the mapped DC centroid only to frame the free Leaflet preview;
            // the stored pincode distance remains the customer-facing value.
            latitude: pricing.latitude ?? fallbackLatitude,
            longitude: pricing.longitude ?? fallbackLongitude,
            pincode: pricing.pincode,
            city: pricing.city,
            approximate: pricing.latitude === null || pricing.longitude === null,
        },
        search: { availability_end_date: availabilityEndDate, mode: 'saved_pincode' },
        summary: {
            centers_evaluated: centers.length,
            available_technicians: new Set(centers.flatMap((center) => center.technicians.filter((technician) => technician.available).map((technician) => technician.id))).size,
            centers_within_radius: pricing.charge_type === 'free' ? centers.length : 0,
            unmapped_centers: 0,
        },
        pincode_pricing: pricing,
        pincode_configured: true,
        can_save_pincode: false,
        warning: centers.length
            ? null
            : 'This pincode is configured, but no linked diagnostic center is currently available.',
        centers,
    };
}

async function searchLivePlanner(input) {
    const today = getIndiaDate();
    const appointmentDate = normalizeDate(input.appointment_date) || today;
    if (appointmentDate < today) {
        throw operationalError('Availability can only be planned from today onwards.', 400);
    }
    const availabilityDates = buildDateRange(appointmentDate, AVAILABILITY_LOOKAHEAD_DAYS);
    const availabilityEndDate = availabilityDates[availabilityDates.length - 1];
    const location = await geocodeLocation(input);
    if (!location.pincode) {
        throw operationalError(
            'A six-digit pincode is required to find related diagnostic centers and technicians. Enter the pincode manually if it could not be resolved from the address or landmark.',
            400,
        );
    }
    const allCenters = await getEligibleCenters();
    const mappedCenters = allCenters
        .filter((center) => center.gps_latitude !== null && center.gps_longitude !== null)
        // Local straight-line distance only limits billable Google route elements.
        // It is never returned, displayed, or used for pricing.
        .map((center) => ({
            ...center,
            routing_candidate_distance: getDistance(
                { latitude: location.latitude, longitude: location.longitude },
                { latitude: toNumber(center.gps_latitude), longitude: toNumber(center.gps_longitude) },
            ),
        }))
        .sort((a, b) => a.routing_candidate_distance - b.routing_candidate_distance)
        .slice(0, MAX_ROUTE_CANDIDATES);

    const roadDistances = await getGoogleRoadDistances(location, mappedCenters);
    const routableCenters = mappedCenters.filter((center) => roadDistances.has(Number(center.id)));
    const routeWarning = routableCenters.length < mappedCenters.length
        ? `${mappedCenters.length - routableCenters.length} center(s) were omitted because Google Routes returned no drivable route.`
        : null;

    const decoratedTechnicians = await getDecoratedTechnicians(
        location.pincode,
        appointmentDate,
        availabilityEndDate,
        availabilityDates,
        input.gender,
    );

    const centers = routableCenters.map((center) => {
        const route = roadDistances.get(Number(center.id));
        const distanceKm = route?.distance_km ?? null;
        const centerTechnicians = decoratedTechnicians
            .slice()
            .sort((a, b) => Number(b.available) - Number(a.available) || a.priority - b.priority || a.full_name.localeCompare(b.full_name));
        const availableTechnicians = centerTechnicians.filter((technician) => technician.available).length;

        return {
            id: Number(center.id),
            center_name: center.center_name,
            address: center.address,
            city: center.city,
            state: center.state,
            pincode: center.pincode,
            latitude: toNumber(center.gps_latitude),
            longitude: toNumber(center.gps_longitude),
            distance_km: distanceKm,
            distance_source: 'google_routes',
            duration_minutes: route?.duration_minutes ?? null,
            ...calculateCenterCost(center, distanceKm),
            charge_type: null,
            pricing_source: 'live_route',
            available_technicians: availableTechnicians,
            total_technicians: centerTechnicians.length,
            technicians: centerTechnicians,
        };
    });
    const rankedCenters = rankCenters(centers);
    const savedPincode = await pincodeService.getActiveByPincode(location.pincode);

    return {
        location,
        search: {
            availability_end_date: availabilityEndDate,
            mode: 'live_location',
        },
        summary: {
            centers_evaluated: rankedCenters.length,
            available_technicians: new Set(rankedCenters.flatMap((center) => (
                center.technicians
                    .filter((technician) => technician.available)
                    .map((technician) => technician.id)
            ))).size,
            centers_within_radius: rankedCenters.filter((center) => center.within_radius).length,
            unmapped_centers: allCenters.length - allCenters.filter((center) => center.gps_latitude !== null && center.gps_longitude !== null).length,
        },
        pincode_pricing: savedPincode,
        pincode_configured: Boolean(savedPincode),
        can_save_pincode: !savedPincode,
        warning: routeWarning,
        centers: rankedCenters,
    };
}

async function searchPlanner(input) {
    const hasAddressSearch = Boolean(String(input.address || '').trim() || String(input.landmark || '').trim());
    const liveSearch = input.search_mode === 'live_location' || hasAddressSearch
        || (input.latitude !== undefined && input.longitude !== undefined);
    const pincode = normalizePincode(input.pincode);

    if (!liveSearch) {
        if (!pincode) throw operationalError('Enter a valid six-digit pincode to search saved Call Center mappings.', 400);
        const pricing = await pincodeService.getActiveByPincode(pincode);
        if (!pricing) {
            return {
                location: { input: pincode, formatted_address: null, latitude: null, longitude: null, pincode, city: null, approximate: true },
                search: { availability_end_date: null, mode: 'saved_pincode' },
                summary: { centers_evaluated: 0, available_technicians: 0, centers_within_radius: 0, unmapped_centers: 0 },
                pincode_pricing: null,
                pincode_configured: false,
                can_save_pincode: false,
                warning: 'This pincode is not configured. Use Live Location Search to find and save it.',
                centers: [],
            };
        }
        return searchConfiguredPincode(input, pricing);
    }
    return searchLivePlanner(input);
}

async function getSummary(appointmentDate) {
    const date = normalizeDate(appointmentDate) || getIndiaDate();
    const [centerRows, technicianRows] = await Promise.all([
        db.query(`SELECT COUNT(*) AS total,
                         SUM(gps_latitude IS NOT NULL AND gps_longitude IS NOT NULL) AS mapped
                  FROM diagnostic_centers WHERE is_deleted = 0`),
        db.query('SELECT COUNT(*) AS total FROM technicians WHERE is_deleted = 0 AND is_active = 1'),
    ]);
    return {
        active_centers: Number(centerRows[0]?.total || 0),
        mapped_centers: Number(centerRows[0]?.mapped || 0),
        active_technicians: Number(technicianRows[0]?.total || 0),
        date,
    };
}

module.exports = {
    searchPlanner,
    getSummary,
};
