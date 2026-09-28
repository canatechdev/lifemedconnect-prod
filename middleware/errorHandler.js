const logger = require('../lib/logger');

/**
 * Global error handling middleware
 */
const errorHandler = (err, req, res, next) => {
    // Log error
    logger.error('Error occurred:', {
        message: err.message,
        stack: err.stack,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip
    });

    // Multer file upload errors
    if (err.name === 'MulterError') {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                status: 'error',
                message: 'File size exceeds the maximum limit'
            });
        }
        return res.status(400).json({
            status: 'error',
            message: err.message
        });
    }

    // JWT errors
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            status: 'error',
            message: 'Invalid token'
        });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            status: 'error',
            message: 'Token expired'
        });
    }

    // Database errors
    if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
            status: 'error',
            message: 'Duplicate entry. Resource already exists.'
        });
    }

    if (err.code === 'ER_NO_REFERENCED_ROW_2') {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid reference. Related resource does not exist.'
        });
    }

    // Validation errors
    if (err.isJoi || err.name === 'ValidationError') {
        return res.status(400).json({
            status: 'error',
            message: 'Validation failed',
            errors: err.details || err.message
        });
    }

    // Default error response
    const statusCode = err.statusCode || err.status || 500;
    const message = err.message || 'Internal server error';

    res.status(statusCode).json({
        status: 'error',
        message: process.env.NODE_ENV === 'development' || err.isOperational
            ? message
            : 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};

/**
 * 404 Not Found handler
 */
const notFoundHandler = (req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Route not found',
        path: req.originalUrl
    });
};

/**
 * Async handler wrapper to catch errors in async route handlers
 */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
    errorHandler,
    notFoundHandler,
    asyncHandler
};
