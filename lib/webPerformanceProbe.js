const logger = require('./logger');

// Temporary WEB_PERF_PROBE diagnostics. Remove imports/call sites with this file after testing.
function startProbe(stage, context = {}, thresholdMs = 1000) {
    const started = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    return (extra = {}) => {
        const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
        if (durationMs < thresholdMs && !extra.failed) return;
        // Diagnostics must never fail the operation being measured.
        try {
            const used = process.cpuUsage(cpu);
            const memory = process.memoryUsage();
            logger.info('WEB_PERF_PROBE', {
                stage, ...context, ...extra, durationMs, pid: process.pid,
                cpuMs: Math.round((used.user + used.system) / 1000),
                rssMB: Math.round(memory.rss / 1048576),
                heapMB: Math.round(memory.heapUsed / 1048576),
            });
        } catch (_) { /* Logging must not change request behavior. */ }
    };
}

module.exports = { startProbe };
