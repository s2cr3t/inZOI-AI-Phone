#!/usr/bin/env node
'use strict';
// Builds the package handed to testers:
//   build\dist\inZOI-AI-Phone-TestKit-<version>\
//     inZOI-AI-Phone-Setup-<version>.exe     (from tools/build-installer.js)
//     Mods\InGame\HouseholdBoard_I6IXIO\     the phone UI mod, program files only
//     Mods\InGame\HouseholdJournal_N4CZ4Z\   the Lua mod, program files only
//     README.txt, 已知问题.txt (from docs/known-issues.zh-CN.txt), SHA256SUMS.txt
//   build\dist\inZOI-AI-Phone-TestKit-<version>.zip (+ .sha256)
//
//   node tools/build-test-kit.js                 mods found under Documents\inZOI\Mods
//   node tools/build-test-kit.js --mods <dir>    mods taken from <dir>\<modId>
//
// The setup installs and updates the mods by itself since 2.49.0; the kit's Mods folder is for
// copying by hand when that is wanted. Mod file lists and privacy checks: tools/modfiles.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const modfiles = require('./modfiles');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'build', 'dist');
const KNOWN_ISSUES = path.join(ROOT, 'docs', 'known-issues.zh-CN.txt');
const { MODS, walk, copy, isFile } = modfiles;

function out(line) { process.stdout.write(line + '\n'); }

function fail(message) {
    process.stderr.write('test kit failed: ' + message + '\n');
    process.exit(1);
}

function version() {
    const text = fs.readFileSync(path.join(ROOT, 'lib', 'daemon.js'), 'utf8');
    const m = /const VERSION = '(\d+\.\d+\.\d+)';/.exec(text);
    if (!m) fail('VERSION not found in lib/daemon.js');
    return m[1];
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function args() {
    const a = process.argv.slice(2);
    const o = { mods: '' };
    for (let i = 0; i < a.length; i++) {
        if (a[i] === '--mods' && a[i + 1]) o.mods = path.resolve(a[++i]);
        else fail('unknown argument ' + a[i] + ' (use --mods <dir>)');
    }
    return o;
}

function readme(ver, setupName) {
    return [
        'inZOI AI 手机 ' + ver + ' 测试包',
        '========================================',
        '',
        '让游戏里的手机接上大模型：小人之间会用短信聊天、发朋友圈，内容由 AI 根据游戏里正在发生的事生成。',
        '',
        '一、需要准备',
        '  1. Windows 10 或 Windows 11（64 位）。',
        '  2. inZOI 0.11.0（2026 年 10 月 15 日更新）或更新的版本。',
        '  3. 一个大模型 API 密钥，自己注册，按用量付费。支持：DeepSeek、通义千问、Kimi、智谱 GLM、',
        '     豆包、OpenAI，以及任何 OpenAI 兼容的服务。没有密钥也能先装好，进游戏再填。',
        '     请不要使用别人的密钥，也不要把自己的密钥发给别人。',
        '',
        '二、安装和更新（新装、从旧版本升级都一样）',
        '  1. 完全退出 inZOI。',
        '  2. 双击 ' + setupName + '，一路"下一步"。',
        '     如果出现"Windows 已保护你的电脑"：点"更多信息"，再点"仍要运行"。',
        '     （测试版没有购买代码签名证书，所以 Windows 会提示。）',
        '     安装程序会自动把手机 mod 和配套 Lua mod 装进（或替换掉）文档\\inZOI\\Mods 里的旧版本：',
        '       文档\\inZOI\\Mods\\InGame\\HouseholdBoard_I6IXIO',
        '       文档\\inZOI\\Mods\\InGame\\HouseholdJournal_N4CZ4Z',
        '     （mod 已经放在 Mods 下别的文件夹里的，就更新那一份，不会装出第二份。',
        '       同一个 mod 已经有好几份的，每一份都会更新，安装完会列出来，请只保留一份。）',
        '     聊天记录、朋友圈和手机设置都会保留。不用再手动拖 Mods 文件夹；',
        '     本测试包里的 Mods 文件夹只是备用，想手动安装时才用得上。',
        '     安装不需要管理员权限，装好后会在后台常驻，开机自动运行，平时几乎不占资源。',
        '  3. 启动 inZOI。在 选项 → 模组 里确认"启用模组"是打开的（默认打开）。',
        '',
        '三、在游戏里开启 AI',
        '  1. 进入游戏，打开手机，点 AI 图标。',
        '  2. PROVIDER：选你的服务商。',
        '  3. API KEY：在浏览器里复制你的密钥，回到游戏点 Paste key（从剪贴板读取）；',
        '     也可以在输入框里直接粘贴后点 Save。密钥会先向服务商验证，验证通过才保存，',
        '     加密存在你自己的电脑上，之后不会再显示。',
        '  4. MODEL：一般用默认值即可，也可以点 Fetch list 选别的模型。',
        '  5. 点 Save，再点 Test connection。顶部显示 Running 就可以开始玩了。',
        '  6. 想暂停 AI（比如省钱），把 AI PHONE SERVICE 切到 Off；切回 On 约 15 秒恢复。',
        '',
        '四、常见情况',
        '  · AI 页面显示 Not running：后台服务没有运行。在开始菜单打开"inZOI AI 手机"即可。',
        '  · 显示 Needs an API key：还没有填写当前服务商的密钥，按第三步填写。',
        '  · 显示 Cannot reach the game：服务暂时连不上游戏，通常进入游戏存档后几秒内自动恢复。',
        '  · 显示 Running, last reply failed，或提示密钥错误、余额不足：去服务商网站检查密钥和余额，',
        '    再重新 Paste key。',
        '  · 打工（Freelance）显示 The order service is not running：配套 Lua mod 没在运行。',
        '    在 inZOI 的 选项 → 模组 里确认 HouseholdJournal 已启用，然后重启游戏。',
        '',
        '五、反馈问题',
        '  先看一下同目录的"已知问题.txt"，里面列出的情况我们已经知道。',
        '  其他问题请在出现后尽快：打开手机 → AI → 最下面 SUPPORT → 点 Export diagnostics。',
        '  几秒后会显示保存位置：文档\\inZOI\\AI Phone Diagnostics\\inZOI-AI-Phone-Diagnostics-日期-时间.zip。',
        '  把这个 zip 发给我们，并写清楚你做了什么、期望什么、实际看到什么、大概几点发生的，有截图更好。',
        '  诊断包会自动去掉 API 密钥、Windows 用户名和电脑名，不含角色的长期记忆和日记；',
        '  但包含游戏里的短信和朋友圈文字，排查问题需要用到。',
        '  手机打不开 AI 页面时，打开 %LOCALAPPDATA%\\inZOI AI Phone\\logs（复制到资源管理器地址栏回车），',
        '  把里面最近的 .log 文件发给我们。',
        '  AI 页面的 USAGE 卡片显示最近 60 分钟和今天的调用次数与估算费用。',
        '',
        '六、卸载',
        '  设置 → 应用 → 已安装的应用 → inZOI AI 手机 → 卸载。',
        '  卸载时会询问是否删除密钥、聊天记录等数据。mod 文件夹请在 文档\\inZOI\\Mods\\InGame 里手动删除。',
        ''
    ].join('\r\n');
}

function le16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff);
    return b;
}

function le32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
}

function dosDateTime(d) {
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
}

// Windows tar.exe writes Zip names in CP437 and turns any other character into "?".
// The known-issues file is named in Chinese, so the archive is written here with the
// UTF-8 name flag set, and a file is stored uncompressed when deflate does not shrink it.
function zip(kitName, zipFile) {
    const root = path.join(DIST, kitName);
    const rels = walk(root, '', []).sort();
    if (rels.length > 0xffff) fail('too many files to store in one zip');
    const stamp = dosDateTime(new Date());
    const locals = [];
    const central = [];
    let offset = 0;
    for (const rel of rels) {
        const body = fs.readFileSync(path.join(root, rel));
        const name = Buffer.from(kitName + '/' + rel, 'utf8');
        if (name.length > 0xffff) fail('path too long for a zip entry: ' + rel);
        const crc = zlib.crc32(body) >>> 0;
        let method = 0;
        let data = body;
        if (body.length > 0) {
            const packed = zlib.deflateRawSync(body, { level: 6 });
            if (packed.length < body.length) {
                method = 8;
                data = packed;
            }
        }
        const local = Buffer.concat([
            le32(0x04034b50), le16(20), le16(0x0800), le16(method),
            le16(stamp.time), le16(stamp.date), le32(crc), le32(data.length), le32(body.length),
            le16(name.length), le16(0), name, data
        ]);
        locals.push(local);
        central.push(Buffer.concat([
            le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(method),
            le16(stamp.time), le16(stamp.date), le32(crc), le32(data.length), le32(body.length),
            le16(name.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(offset), name
        ]));
        offset += local.length;
        if (offset > 0xffffffff) fail('zip is larger than 4 GB');
    }
    const centralDir = Buffer.concat(central);
    const end = Buffer.concat([
        le32(0x06054b50), le16(0), le16(0), le16(rels.length), le16(rels.length),
        le32(centralDir.length), le32(offset), le16(0)
    ]);
    try { fs.unlinkSync(zipFile); } catch (e) { /* not there yet */ }
    fs.writeFileSync(zipFile, Buffer.concat(locals.concat([centralDir, end])));
    if (!isFile(zipFile)) fail('zip was not written: ' + zipFile);
}

function main() {
    if (process.platform !== 'win32') fail('the test kit can only be built on Windows');
    const o = args();
    const ver = version();
    const setupName = 'inZOI-AI-Phone-Setup-' + ver + '.exe';
    const setup = path.join(DIST, setupName);
    if (!isFile(setup)) fail(setupName + ' not found; run node tools/build-installer.js first');
    const recorded = isFile(setup + '.sha256') ? fs.readFileSync(setup + '.sha256', 'utf8').split(/\s+/)[0] : '';
    const setupSha = sha256(setup);
    if (recorded !== setupSha) fail(setupName + ' does not match its .sha256; run node tools/build-installer.js again');

    const kitName = 'inZOI-AI-Phone-TestKit-' + ver;
    const kit = path.join(DIST, kitName);
    fs.rmSync(kit, { recursive: true, force: true });
    fs.mkdirSync(kit, { recursive: true });
    copy(setup, path.join(kit, setupName));

    for (const mod of MODS) {
        const src = modfiles.modSource(mod.id, o.mods, fail);
        const dest = path.join(kit, 'Mods', 'InGame', mod.id);
        const copied = modfiles.stageMod(mod, src, dest, dest, fail);
        modfiles.checkComplete(mod, dest, copied, fail);
        out(mod.id + ': ' + copied.size + ' files from ' + src);
    }
    fs.writeFileSync(path.join(kit, 'README.txt'), '\uFEFF' + readme(ver, setupName), 'utf8');
    if (!isFile(KNOWN_ISSUES)) fail('docs\\known-issues.zh-CN.txt is missing');
    const issues = fs.readFileSync(KNOWN_ISSUES, 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
    if (issues.indexOf(ver) < 0) fail('docs\\known-issues.zh-CN.txt does not mention version ' + ver + '; review it for this release');
    fs.writeFileSync(path.join(kit, '已知问题.txt'), '\uFEFF' + issues, 'utf8');
    modfiles.checkPrivate(kit, modfiles.underPrefix('Mods/InGame/'), fail);

    const sums = walk(kit, '', []).filter((r) => r !== 'SHA256SUMS.txt').sort()
        .map((r) => sha256(path.join(kit, r)) + '  ' + r.split('/').join('\\'));
    fs.writeFileSync(path.join(kit, 'SHA256SUMS.txt'), sums.join('\r\n') + '\r\n', 'utf8');

    const zipFile = path.join(DIST, kitName + '.zip');
    zip(kitName, zipFile);
    const zipSha = sha256(zipFile);
    fs.writeFileSync(zipFile + '.sha256', zipSha + '  ' + path.basename(zipFile) + '\n', 'utf8');
    out('test kit: ' + zipFile + ' (' + Math.round(fs.statSync(zipFile).size / 1048576) + ' MB, ' + sums.length + ' files)');
    out('sha256: ' + zipSha);
}

main();
