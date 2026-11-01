'use strict';
// LLM providers offered on the phone's AI page. Every one speaks the OpenAI chat completions
// protocol; they differ in how deep thinking is switched off and which optional fields they
// accept, which `dialect` tells lib/llm.js. Model lists are suggestions shown before the
// provider's own /models list has been fetched; any model id can be typed in.
//
// Sources (checked 2026-10): api-docs.deepseek.com, help.aliyun.com/zh/model-studio,
// platform.kimi.com/docs, open.bigmodel.cn, ark.volcengine.com/docs, developers.openai.com.

const PROVIDERS = [
    {
        id: 'deepseek',
        label: 'DeepSeek',
        base_url: 'https://api.deepseek.com',
        dialect: 'deepseek',
        models: ['deepseek-v4-pro', 'deepseek-flash'],
        key_site: 'platform.deepseek.com'
    },
    {
        id: 'qwen',
        label: 'Qwen',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        dialect: 'qwen',
        models: ['qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max'],
        key_site: 'bailian.console.aliyun.com'
    },
    {
        id: 'kimi',
        label: 'Kimi',
        base_url: 'https://api.moonshot.cn/v1',
        dialect: 'thinking',
        models: ['kimi-k2.6', 'kimi-k3'],
        key_site: 'platform.kimi.com'
    },
    {
        id: 'glm',
        label: 'GLM',
        base_url: 'https://open.bigmodel.cn/api/paas/v4',
        dialect: 'thinking',
        models: ['glm-5.2', 'glm-5.3-flash'],
        key_site: 'open.bigmodel.cn'
    },
    {
        id: 'doubao',
        label: 'Doubao',
        base_url: 'https://ark.cn-beijing.volces.com/api/v3',
        dialect: 'thinking',
        models: ['doubao-seed-2-1-lite-260915', 'doubao-seed-character-260628', 'doubao-seed-2-1-pro-260915'],
        key_site: 'console.volcengine.com/ark'
    },
    {
        id: 'openai',
        label: 'OpenAI',
        base_url: 'https://api.openai.com/v1',
        dialect: 'openai',
        models: ['gpt-5.4-mini', 'gpt-5.5'],
        key_site: 'platform.openai.com'
    },
    {
        id: 'custom',
        label: 'Custom',
        base_url: '',
        dialect: 'plain',
        models: [],
        key_site: '',
        custom: true
    }
];

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,127}$/;

function get(id) {
    return BY_ID.get(String(id || '')) || null;
}

function isModelId(v) {
    return typeof v === 'string' && MODEL_RE.test(v);
}

// An http(s) URL without credentials, query or fragment. Local servers (Ollama, LM Studio)
// may use plain http; anything else must use https so the key is never sent in the clear.
function checkBaseUrl(v) {
    let u;
    try { u = new URL(String(v || '').trim()); } catch (e) { return { ok: false, reason: 'not a URL' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'must start with https://' };
    if (u.username || u.password) return { ok: false, reason: 'must not contain a user name or password' };
    if (u.search || u.hash) return { ok: false, reason: 'must not contain ? or #' };
    const local = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
    if (u.protocol === 'http:' && !local) return { ok: false, reason: 'must use https:// (http:// only for this PC)' };
    const clean = (u.origin + u.pathname).replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return { ok: true, url: clean };
}

// Shape published to the phone: no internals, only what the AI page shows.
function publicList() {
    return PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        models: p.models.slice(),
        key_site: p.key_site,
        custom: !!p.custom,
        base_url: p.base_url
    }));
}

module.exports = { PROVIDERS, get, isModelId, checkBaseUrl, publicList };
