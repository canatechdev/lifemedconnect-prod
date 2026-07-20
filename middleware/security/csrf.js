const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const logger = require('../../lib/logger');

/**
 * CSRF Protection Middleware
 * Prevents Cross-Site Request Forgery attacks
 * 
 * How it works:
 * 1. Frontend fetches CSRF token from /api/csrf-token
 * 2. Frontend includes token in X-CSRF-Token header for POST/PUT/DELETE
 * 3. Backend validates token before processing request
 */

// Cookie parser middleware (required for CSRF)
const cookieParserMiddleware = cookieParser();

// CSRF protection configuration
const csrfProtection = csrf({ 
    cookie: {
        httpOnly: true, // Prevent JavaScript access
        secure: process.env.NODE_ENV === 'production', // HTTPS only in production
        sameSite: 'strict', // Prevent CSRF attacks
        maxAge: 3600000 // 1 hour
    }
});

/**
 * CSRF token endpoint
 * Frontend calls this to get a fresh token
 * GET /api/csrf-token
 */
const getCsrfToken = (req, res) => {
    try {
        res.json({ 
            status: 'success',
            csrfToken: req.csrfToken(),
            message: 'CSRF token generated successfully'
        });
    } catch (error) {
        logger.error('Error generating CSRF token', { 
            error: error.message,
            ip: req.ip 
        });
        res.status(500).json({
            status: 'error',
            message: 'Failed to generate CSRF token'
        });
    }
};

/**
 * CSRF error handler
 * Provides user-friendly error messages
 */
const csrfErrorHandler = (err, req, res, next) => {
    if (err.code !== 'EBADCSRFTOKEN') return next(err);
    
    logger.warn('CSRF token validation failed', { 
        ip: req.ip,
        url: req.originalUrl,
        method: req.method
    });
    
    res.status(403).json({
        status: 'error',
        message: 'Invalid or missing CSRF token. Please refresh and try again.',
        code: 'CSRF_VALIDATION_FAILED'
    });
};

/**
 * Conditional CSRF protection
 * Only applies to state-changing methods (POST, PUT, DELETE, PATCH)
 * GET requests don't need CSRF protection
 * 
 * Environment control via CSRF_ENABLED:
 * - true (default): Enable CSRF for web APIs only (skip /api/app/*)
 * - false: Disable CSRF completely for all APIs
 */
const conditionalCsrfProtection = (req, res, next) => {
    const method = req.method.toUpperCase();
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];

    // Skip CSRF for safe methods
    if (safeMethods.includes(method)) {
        return next();
    }

    // Global CSRF toggle via environment variable
    const csrfEnabled = (process.env.CSRF_ENABLED ?? 'true').toString().toLowerCase();
    if (csrfEnabled === 'false') {
        return next();
    }

    // Skip CSRF for app APIs (native apps) under /api/app/* and telephony webhooks
    // Also skip for reset password and verify OTP APIs
    const url = req.originalUrl || '';
    if (
        url.startsWith('/api/app/') ||
        url.startsWith('/api/telephony/webhook') ||
        url.startsWith('/api/smart-reports/request') ||
        url.startsWith('/api/smart-reports/webhook/callback') ||
        url.includes('/reset-password') ||
        url.includes('/verify-otp')
    ) {
        return next();
    }

    // Apply CSRF protection for state-changing methods
    csrfProtection(req, res, next);
};

module.exports = {
    cookieParser: cookieParserMiddleware,
    csrfProtection,
    conditionalCsrfProtection,
    getCsrfToken,
    csrfErrorHandler
};
