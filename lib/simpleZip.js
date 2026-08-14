const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let j = 0; j < 8; j += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function updateCrc32(crc, buffer) {
    let c = crc ^ -1;
    for (let i = 0; i < buffer.length; i += 1) {
        c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

function normalizeZipName(name) {
    return String(name || 'file')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map(part => part.replace(/[<>:"|?*\x00-\x1F]/g, '_'))
        .join('/');
}

async function getFileCrc(filePath) {
    return new Promise((resolve, reject) => {
        let crc = 0;
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => {
            crc = updateCrc32(crc, chunk);
        });
        stream.on('end', () => resolve(crc >>> 0));
        stream.on('error', reject);
    });
}

function writeBuffer(stream, buffer) {
    return new Promise((resolve, reject) => {
        const done = error => (error ? reject(error) : resolve());
        if (!stream.write(buffer)) {
            stream.once('drain', () => resolve());
            stream.once('error', reject);
        } else {
            done();
        }
    });
}

function pipeFileToStream(filePath, output) {
    return new Promise((resolve, reject) => {
        const input = fs.createReadStream(filePath);
        input.on('error', reject);
        output.on('error', reject);
        input.on('end', resolve);
        input.pipe(output, { end: false });
    });
}

function buildLocalHeader({ nameBuffer, crc, size, dosTime, dosDate }) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    return Buffer.concat([header, nameBuffer]);
}

function buildCentralHeader(entry) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(entry.dosTime, 12);
    header.writeUInt16LE(entry.dosDate, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    return Buffer.concat([header, entry.nameBuffer]);
}

async function createZipFile(outputPath, files, onProgress = null) {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

    const output = fs.createWriteStream(outputPath);
    const centralEntries = [];
    let offset = 0;
    let processedFiles = 0;
    let processedBytes = 0;
    const totalFiles = files.length;

    try {
        for (const file of files) {
            const stat = await fs.promises.stat(file.absolutePath);
            if (!stat.isFile()) continue;
            if (stat.size > 0xffffffff) {
                throw new Error(`File too large for simple ZIP: ${file.name}`);
            }

            const name = normalizeZipName(file.name);
            const nameBuffer = Buffer.from(name, 'utf8');
            const crc = await getFileCrc(file.absolutePath);
            const { dosTime, dosDate } = dosDateTime(stat.mtime);
            const localHeader = buildLocalHeader({ nameBuffer, crc, size: stat.size, dosTime, dosDate });

            await writeBuffer(output, localHeader);
            await pipeFileToStream(file.absolutePath, output);

            centralEntries.push({
                nameBuffer,
                crc,
                size: stat.size,
                dosTime,
                dosDate,
                offset,
            });
            offset += localHeader.length + stat.size;
            processedFiles += 1;
            processedBytes += stat.size;
            if (typeof onProgress === 'function') {
                await onProgress({
                    processedFiles,
                    totalFiles,
                    processedBytes,
                    currentFile: name,
                });
            }
        }

        const centralStart = offset;
        for (const entry of centralEntries) {
            const centralHeader = buildCentralHeader(entry);
            await writeBuffer(output, centralHeader);
            offset += centralHeader.length;
        }
        const centralSize = offset - centralStart;

        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(0, 4);
        end.writeUInt16LE(0, 6);
        end.writeUInt16LE(centralEntries.length, 8);
        end.writeUInt16LE(centralEntries.length, 10);
        end.writeUInt32LE(centralSize, 12);
        end.writeUInt32LE(centralStart, 16);
        end.writeUInt16LE(0, 20);
        await writeBuffer(output, end);
    } finally {
        await new Promise((resolve, reject) => {
            output.once('finish', resolve);
            output.once('error', reject);
            output.end();
        });
    }
}

module.exports = {
    createZipFile,
    normalizeZipName,
};
