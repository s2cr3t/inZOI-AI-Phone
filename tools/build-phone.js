'use strict';
// The phone's app.js is built from the pieces in src/phone, one per app or shared part, joined in
// file-name order. The game still loads the one app.js (index.html's script tags, the CurseForge
// package and the installer are unchanged): the pieces are the parts of one function, sharing its
// variables, and are not loaded or checked on their own.
//
//   node tools/build-phone.js           write mods/HouseholdBoard_I6IXIO/ui/phone/app.js
//   node tools/build-phone.js --check   exit 1 when app.js is not what the pieces make
//   node tools/build-phone.js --deploy  write it, then copy it into the installed mod
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'phone');
const OUT = path.join(ROOT, 'mods', 'HouseholdBoard_I6IXIO', 'ui', 'phone', 'app.js');

function pieces() {
    return fs.readdirSync(SRC).filter((f) => /^\d+-[\w-]+\.js$/.test(f)).sort();
}

function build() {
    return pieces().map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('');
}

function main(argv) {
    const text = build();
    if (argv.includes('--check')) {
        const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
        if (now !== text) {
            console.error('app.js is out of date with src/phone: run node tools/build-phone.js');
            return 1;
        }
        console.log('app.js is up to date (' + pieces().length + ' pieces)');
        return 0;
    }
    fs.writeFileSync(OUT, text);
    console.log('wrote ' + path.relative(ROOT, OUT) + ' from ' + pieces().length + ' pieces');
    if (argv.includes('--deploy')) {
        const dir = require('../lib/paths').modCopies('HouseholdBoard_I6IXIO').dir;
        if (!dir) {
            console.error('the phone mod is not installed');
            return 1;
        }
        fs.copyFileSync(OUT, path.join(dir, 'ui', 'phone', 'app.js'));
        console.log('copied into ' + dir);
    }
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { build, pieces, SRC, OUT };
