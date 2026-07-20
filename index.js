require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const { Server: SocketIOServer } = require('socket.io');

// Import utilities and middleware
const { validateEnv, getConfig } = require('./lib/config');
const logger = require('./lib/logger');
const requestLogger = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { testConnection, closePool } = require('./lib/dbconnection');

//  NEW: Import security middleware
const {
    helmetConfig,
    cookieParser,
    csrfProtection,
    conditionalCsrfProtection,
    getCsrfToken,
    csrfErrorHandler,
    sanitizeInput,
    apiLimiter
} = require('./middleware/security');

// Validate environment variables
try {
    validateEnv();
    logger.info('Environment variables validated successfully');
} catch (error) {
    logger.error('Environment validation failed:', error.message);
    process.exit(1);
}

// Test database connection and sync permission catalog
testConnection()
    .then(async () => {
        logger.info('Database connected successfully');
        // NEW: Sync permission catalog on startup
        const { ensurePermissionCatalog } = require('./lib/permissionCatalog');
        try {
            await ensurePermissionCatalog();
            logger.info('Permission catalog synchronized successfully');
        } catch (error) {
            logger.error('Failed to sync permission catalog:', error.message);
            // Don't exit - allow app to continue even if permission sync fails
        }
    })
    .catch((error) => {
        logger.error('Failed to connect to database. Exiting...');
        process.exit(1);
    });

const config = getConfig();
const app = express();

// Trust proxy for Nginx/Apache reverse proxy
app.set('trust proxy', 1);

const server = http.createServer(app);

// Initialize Socket.IO for real-time communication
const io = new SocketIOServer(server, {
    cors: {
        origin: config.corsOrigin,
        methods: ['GET', 'POST'],
        credentials: true
    },
    path: '/socket.io'
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    logger.debug('Client connected to Socket.IO', { socketId: socket.id });

    // Join call-specific rooms
    socket.on('join_call', (callId) => {
        socket.join(`call_${callId}`);
        logger.debug('Client joined call room', { socketId: socket.id, callId });
    });

    // Leave call room
    socket.on('leave_call', (callId) => {
        socket.leave(`call_${callId}`);
        logger.debug('Client left call room', { socketId: socket.id, callId });
    });

    // Subscribe to customer number for incoming call alerts
    socket.on('subscribe_customer', (customerNumber) => {
        socket.join(`customer_${customerNumber}`);
        logger.debug('Client subscribed to customer', { socketId: socket.id, customerNumber });
    });

    socket.on('disconnect', () => {
        logger.debug('Client disconnected from Socket.IO', { socketId: socket.id });
    });
});

// Make io accessible to routes
app.set('io', io);

//  SECURITY MIDDLEWARE - ORDER MATTERS!
// 1. Helmet (must be first) - Secure HTTP headers
app.use(helmetConfig);

// 2. Compression
app.use(compression());

// 3. CORS - Allow frontend access
app.use(cors({
    origin: config.corsOrigin,
    credentials: true, // Required for CSRF cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
}));

// 4. Cookie parser (required for CSRF)
app.use(cookieParser);

// 5. Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 6.  NEW: Input sanitization (after body parsing, before routes)
app.use(sanitizeInput);

// 7. Request logging
app.use(requestLogger);

// 8.  NEW: Rate limiting for all API routes
// app.use('/api/', apiLimiter);

// Static files
// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders: (res, path, stat) => {
    // Allow your frontend to load images cross-origin
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  }
}));

// Serve frontend static files (production)
// Frontend build should be placed in 'public' folder
const publicPath = path.join(__dirname, 'public');
const fs = require('fs');

if (fs.existsSync(publicPath)) {
  // Serve static assets (JS, CSS, images, etc.)
  app.use(express.static(publicPath, {
    maxAge: '1y', // Cache static assets for 1 year
    etag: true,
    lastModified: true
  }));
  
  logger.info('Frontend static files enabled from public folder');
} else {
  logger.warn('Public folder not found. Frontend static files will not be served.');
  logger.warn('To enable frontend serving: Create "public" folder and place frontend build files there.');
}

// Import routes
const userRoutes = require('./routes/r_user');
const clientRoutes = require('./routes/r_clients');
const centerRoutes = require('./routes/r_centers');
const insurerRoutes = require('./routes/r_insurers');
const testCategoryRoutes = require('./routes/r_test_categories');
const testRoutes = require('./routes/r_tests');
const technicianRoutes = require('./routes/r_technicians');
const appointmentRoutes = require('./routes/r_appointments');
const testRateRoutes = require('./routes/r_test_rates');
const roleRoutes = require('./routes/r_roles');
const rolePermissionRoutes = require('./routes/r_role_permissions');
const doctorRoutes = require('./routes/r_doctor');
const bulkTestRoutes = require('./routes/r_test_bulk');
const approvalRoutes = require('./routes/r_approvals');
const dashboard = require('./routes/r_dashboard')
const appAuthRoutes = require('./routes/app/auth');
const appAppointmentRoutes = require('./routes/app/r_app_appointments');
const appDashboardRoutes = require('./routes/app/r_app_dashboard');
const rbacRoutes = require('./routes/r_rbac');
const telephonyRoutes = require('./routes/r_telephony');
const smartReportRoutes = require('./routes/r_smart_reports');
const appointmentLifecycleRoutes = require('./routes/r_appointment_lifecycle');
const tpaRoutes = require('./routes/r_tpa');
const tpaManagementRoutes = require('./routes/r_tpa_management');

// Health check route
app.get('/', (req, res) => {
    res.json({
        status: 'success',
        message: 'Healthcare CRM Backend API is running',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

//  CSRF token endpoint (must use csrfProtection so req.csrfToken is available on GET)
app.get('/api/csrf-token', csrfProtection, getCsrfToken);

//   Detailed health check with DB status
app.get('/api/health', async (req, res) => {
    try {
        await testConnection();
        res.json({
            status: 'success',
            message: 'System healthy',
            database: 'connected',
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            environment: config.nodeEnv
        });
    } catch (error) {
        res.status(503).json({
            status: 'error',
            message: 'System unhealthy',
            database: 'disconnected',
            timestamp: new Date().toISOString()
        });
    }
});

// Register TPA routes BEFORE CSRF protection (TPA uses API key auth)
app.use('/api/tpa', tpaRoutes);

// App (mobile) routes (no CSRF) - register BEFORE CSRF protection
app.use('/api/app', appAuthRoutes);
app.use('/api/app', appAppointmentRoutes);
app.use('/api/app', appDashboardRoutes);

//  Apply CSRF protection to state-changing routes
// Note: GET requests don't need CSRF, only POST/PUT/DELETE/PATCH
app.use('/api/', conditionalCsrfProtection);

// Register API routes
app.use('/api', userRoutes);
app.use('/api', clientRoutes);
app.use('/api', centerRoutes);
app.use('/api', insurerRoutes);
app.use('/api', testCategoryRoutes);
app.use('/api', testRoutes);
app.use('/api', technicianRoutes);
app.use('/api', appointmentRoutes);
app.use('/api', testRateRoutes);
app.use('/api', roleRoutes);
app.use('/api', rolePermissionRoutes);
app.use('/api', doctorRoutes);
app.use('/api', bulkTestRoutes);
app.use('/api', approvalRoutes);
app.use('/api',dashboard)
app.use('/api', rbacRoutes);
app.use('/api/telephony', telephonyRoutes);
app.use('/api/smart-reports', smartReportRoutes);
app.use('/api/appointment-lifecycle', appointmentLifecycleRoutes);
app.use('/api/tpa', tpaRoutes);
app.use('/api/tpa-management', tpaManagementRoutes);

// SPA Fallback: Serve index.html for all non-API routes (production only)
// This allows React Router to handle client-side routing
if (fs.existsSync(publicPath)) {
  app.get('*', (req, res, next) => {
    // Skip API routes and uploads
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
      return next();
    }
    
    // Serve index.html for all other routes (SPA routing)
    const indexPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      next();
    }
  });
}

// 404 handler (for API routes and if SPA fallback fails)
app.use(notFoundHandler);

// CSRF error handler (before global error handler)
app.use(csrfErrorHandler);

// Global error handler (must be last)
app.use(errorHandler);


// Graceful shutdown
const gracefulShutdown = async () => {
    logger.info('Received shutdown signal, closing server gracefully...');

    server.close(async () => {
        logger.info('HTTP server closed');

        try {
            // Close SparkTG WebSocket connection
            const sparkTGSocketService = require('./services/telephony/SparkTGSocketService');
            sparkTGSocketService.disconnect();
            
            // Close Socket.IO server
            if (io) {
                io.close();
                logger.info('Socket.IO server closed');
            }
            
            await closePool();
            logger.info('Database connections closed');
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = config.port;
server.listen(PORT, async () => {
    // Detect base URL
    const baseUrl = config.baseUrl || `http://localhost:${PORT}`;
    
    logger.info(` Server running on port ${PORT}`);
    logger.info(` Base URL: ${baseUrl}`);
    logger.info(` Environment: ${config.nodeEnv}`);
    logger.info(` CORS Origin: ${config.corsOrigin}`);
    logger.info(` Database: ${config.database.host}:${config.database.port}/${config.database.name}`);
    
    // Store base URL globally for use in services
    global.BASE_URL = baseUrl;

    // Initialize SparkTG Socket Service for real-time call events
    try {
        const sparkTGSocketService = require('./services/telephony/SparkTGSocketService');
        sparkTGSocketService.initialize(io);
        logger.info(' SparkTG Socket Service initialized');
    } catch (error) {
        logger.warn('SparkTG Socket Service initialization failed:', error.message);
    }
});



