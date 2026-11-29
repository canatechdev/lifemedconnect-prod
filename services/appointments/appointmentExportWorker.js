require('dotenv').config();

const logger = require('../../lib/logger');
const { runWorkerOnce } = require('./AppointmentExportJob');

let running = false;
let stopping = false;

async function tick() {
    if (running || stopping) return;
    running = true;
    try {
        await runWorkerOnce();
    } catch (error) {
        logger.error('Appointment export worker tick failed', { error: error.message });
    } finally {
        running = false;
    }
}

const timer = setInterval(tick, 5000);
tick();

async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    logger.info('Appointment export worker stopped');
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
