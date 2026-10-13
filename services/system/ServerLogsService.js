const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const CHUNK_SIZE = 64 * 1024;

function safeLogPath(fileName) {
    if (typeof fileName !== 'string' || !fileName || path.basename(fileName) !== fileName) {
        throw new Error('Invalid log file name');
    }
    const resolved = path.resolve(LOGS_DIR, fileName);
    if (path.dirname(resolved) !== LOGS_DIR) throw new Error('Invalid log file path');
    return resolved;
}

function normalizePageSize(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_PAGE_SIZE;
    return Math.min(Math.max(parsed, 1), MAX_PAGE_SIZE);
}

async function listLogFiles() {
    const entries = await fs.promises.readdir(LOGS_DIR, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const files = [];
    for (const entry of entries) {
        if (!entry.isFile() || !/^(combined|error|exceptions|rejections)-.+\.log$/.test(entry.name)) continue;
        const filePath = safeLogPath(entry.name);
        const stat = await fs.promises.stat(filePath);
        files.push({ name: entry.name, size: stat.size, modified_at: stat.mtime.toISOString() });
    }
    return files.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
}

async function readLogPage(fileName, before, pageSize) {
    const filePath = safeLogPath(fileName);
    const size = normalizePageSize(pageSize);
    const handle = await fs.promises.open(filePath, 'r');
    try {
        const stat = await handle.stat();
        let position = Math.min(Number.isFinite(Number(before)) ? Number(before) : stat.size, stat.size);
        let text = '';
        let lines = [];
        while (position > 0 && lines.length <= size) {
            const start = Math.max(0, position - CHUNK_SIZE);
            const buffer = Buffer.alloc(position - start);
            await handle.read(buffer, 0, buffer.length, start);
            text = buffer.toString('utf8') + text;
            lines = text.split(/\r?\n/);
            position = start;
        }
        if (lines.at(-1) === '') lines.pop();
        const selected = lines.slice(-size).reverse();
        const remaining = lines.length > selected.length;
        return { file: fileName, lines: selected, next_before: remaining ? position : null, has_more: remaining };
    } finally {
        await handle.close();
    }
}

async function readLogFile(fileName) {
    const filePath = safeLogPath(fileName);
    return fs.promises.readFile(filePath, 'utf8');
}

module.exports = { listLogFiles, readLogPage, readLogFile, safeLogPath };
