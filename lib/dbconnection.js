const mysql = require('mysql2/promise');
const logger = require('./logger');

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'crm',
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};

// Create connection pool
const pool = mysql.createPool(dbConfig);

/**
 * Execute a SQL query
 * @param {string} sql - SQL query string
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Query results
 */
async function query(sql, params = []) {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows;
    } catch (error) {
        logger.error('Database query error:', {
            message: error.message,
            sql: sql.substring(0, 100), // Log first 100 chars of query
            code: error.code
        });
        throw error;
    }
}

/**
 * Test database connection
 * @returns {Promise<boolean>}
 */
async function testConnection() {
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.ping();
        logger.info('Database connection successful');
        return true;
    } catch (error) {
        logger.error('Database connection failed:', error.message);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}


async function execute(sql, params = []) {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows;
    } catch (error) {
        logger.error('Database execute error:', {
            message: error.message,
            sql: sql.substring(0, 100),
            code: error.code
        });
        throw error;
    }
}

/**
 * Get a connection from the pool (for transactions)
 * @returns {Promise<Connection>}
 */
async function getConnection() {
    try {
        return await pool.getConnection();
    } catch (error) {
        logger.error('Error getting database connection:', error.message);
        throw error;
    }
}

/**
 * Close all connections in the pool
 */
async function closePool() {
    try {
        await pool.end();
        logger.info('Database connection pool closed');
    } catch (error) {
        logger.error('Error closing database pool:', error.message);
        throw error;
    }
}

// Handle pool errors
pool.on('error', (err) => {
    logger.error('Unexpected database pool error:', err);
});

module.exports = {
    execute,
    query,
    pool,
    getConnection,
    testConnection,
    closePool
};
