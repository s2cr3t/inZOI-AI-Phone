'use strict';
// Draws the AI app tile of the phone (teal rounded square, two white sparkles) and writes a
// Windows .ico with 16, 24, 32, 48, 64, 128 and 256 px images (PNG-compressed entries).
//   node tools/make-icon.js <out.ico>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const TOP = [0x3d, 0xdb, 0xc9];
const BOTTOM = [0x0a, 0x84, 0x78];
const SAMPLES = 4;
// The phone glyph (24 x 24 view box), see appGlyph('ai') in ui/phone/app.js.
const STARS = [
    [[10.4, 3.4], [12.3, 8.7], [17.6, 10.6], [12.3, 12.5], [10.4, 17.8], [8.5, 12.5], [3.2, 10.6], [8.5, 8.7]],
    [[17.6, 13.6], [18.5, 16.0], [20.9, 16.9], [18.5, 17.8], [17.6, 20.2], [16.7, 17.8], [14.3, 16.9], [16.7, 16.0]]
];

function inPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0];
        const yi = poly[i][1];
        const xj = poly[j][0];
        const yj = poly[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function inRoundedSquare(x, y, size, r) {
    if (x < 0 || y < 0 || x > size || y > size) return false;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= r * r;
}

function render(size) {
    const px = Buffer.alloc(size * size * 4);
    const radius = size * 0.225;
    const pad = size * 0.14;
    const scale = (size - 2 * pad) / 24;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let tile = 0;
            let star = 0;
            for (let sy = 0; sy < SAMPLES; sy++) {
                for (let sx = 0; sx < SAMPLES; sx++) {
                    const fx = x + (sx + 0.5) / SAMPLES;
                    const fy = y + (sy + 0.5) / SAMPLES;
                    if (!inRoundedSquare(fx, fy, size, radius)) continue;
                    tile += 1;
                    const gx = (fx - pad) / scale;
                    const gy = (fy - pad) / scale;
                    if (STARS.some((s) => inPolygon(gx, gy, s))) star += 1;
                }
            }
            const n = SAMPLES * SAMPLES;
            const t = y / Math.max(1, size - 1);
            const base = TOP.map((c, i) => c + (BOTTOM[i] - c) * t);
            const a = star / Math.max(1, tile);
            const o = (y * size + x) * 4;
            for (let i = 0; i < 3; i++) px[o + i] = Math.round(base[i] * (1 - a) + 255 * a);
            px[o + 3] = Math.round(255 * tile / n);
        }
    }
    return px;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0;
        rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

function ico(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    const entries = [];
    let offset = 6 + 16 * images.length;
    for (const img of images) {
        const e = Buffer.alloc(16);
        e[0] = img.size >= 256 ? 0 : img.size;
        e[1] = img.size >= 256 ? 0 : img.size;
        e.writeUInt16LE(1, 4);
        e.writeUInt16LE(32, 6);
        e.writeUInt32LE(img.data.length, 8);
        e.writeUInt32LE(offset, 12);
        offset += img.data.length;
        entries.push(e);
    }
    return Buffer.concat([header].concat(entries, images.map((i) => i.data)));
}

function main() {
    const out = process.argv[2];
    if (!out) {
        process.stderr.write('usage: node tools/make-icon.js <out.ico>\n');
        process.exit(64);
    }
    const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    const tmp = path.resolve(out) + '.tmp';
    fs.writeFileSync(tmp, ico(images));
    fs.renameSync(tmp, path.resolve(out));
    const preview = path.resolve(out).replace(/\.ico$/i, '-256.png');
    fs.writeFileSync(preview, images[images.length - 1].data);
    process.stdout.write('icon written: ' + path.resolve(out) + ' (' + SIZES.join(', ') + ' px)\n');
}

main();
