// Bind transport to the native generation's final request events. A generation
// being active, a URL, or payload.type alone does not identify a character reply.
// Keep object references only for the current generation; never add wire fields.
const replyTypes = new Set([undefined, 'normal', 'regenerate', 'swipe', 'continue']);
const serialize = data => JSON.stringify(data, (key, value) =>
    ['silly_pop', 'silly_pop_ios', 'silly_pop_and', '__ttotto_main_request'].includes(key) ? undefined : value);

export function createReplyFilter() {
    const frames = [];
    let capture = null;
    const current = () => frames.at(-1);
    function generationStarted(type, options = {}, dryRun = false) {
        if (frames.length >= 32) frames.length = 0;
        const scoped = !dryRun && !options?.quietToLoud && type === 'quiet' && capture && !capture.used
            && options?.quiet_prompt === capture.prompt ? capture : null;
        if (scoped) scoped.used = true;
        frames.push({ eligible: !dryRun && !options?.quietToLoud && (replyTypes.has(type) || !!scoped),
            sequence: scoped?.sequence, data: null, request: null });
    }
    function dataReady(data, dryRun = false) {
        const frame = current();
        if (!frame?.eligible || dryRun || !data || typeof data !== 'object') return;
        frame.data = data;
        // Chat Completion constructs its final payload in SETTINGS_READY later.
        frame.request = Array.isArray(data.prompt) ? null : data;
    }
    function settingsReady(data) {
        const frame = current();
        if (!frame?.eligible || !(replyTypes.has(data?.type) || frame.sequence && data?.type === 'quiet')) return false;
        const prompt = frame.data?.prompt;
        if (!Array.isArray(prompt) || !Array.isArray(data?.messages)) return false;
        const messages = prompt.filter(message => message && typeof message === 'object');
        // ST filters the array but preserves message objects. Helpers using the
        // same endpoint (even while the reply is being prepared) use other data.
        if (!messages.length || messages.length !== data.messages.length
            || !messages.every((message, i) => message === data.messages[i])) return false;
        frame.request = data;
        return true;
    }
    function take({ path, payload }) {
        const frame = current();
        if (!frame?.request || !(replyTypes.has(payload?.type) || frame.sequence && payload?.type === 'quiet')) return false;
        const chat = Array.isArray(frame.data?.prompt);
        if (chat !== (path === '/api/backends/chat-completions/generate')) return false;
        if (serialize(frame.request) !== serialize(payload)) return false;
        frame.data = null;
        frame.request = null;
        return frame.sequence ? { sequence: frame.sequence } : true;
    }
    async function captureQuiet(sequence, prompt, action) {
        if (capture) throw new Error('이미 답장 재작성을 연결 중입니다.');
        const pending = { sequence, prompt, used: false };
        capture = pending;
        try { return await action(); }
        finally {
            if (capture === pending) capture = null;
            // A stopped/failed generation may omit ENDED. It must not leave
            // permission for a later unrelated quiet request.
            for (const frame of frames) if (frame.sequence === sequence) {
                frame.request = null; frame.data = null;
            }
        }
    }
    function generationEnded() { frames.pop(); }
    function consume() { const frame = current(); if (frame) { frame.request = null; frame.data = null; } }
    function clear() { frames.length = 0; capture = null; }
    return { generationStarted, dataReady, settingsReady, take, consume, captureQuiet, generationEnded, clear };
}

export function createWarningGate(now = Date.now, interval = 30000) {
    const seen = new Map();
    return key => {
        const time = now();
        if (seen.has(key) && time - seen.get(key) < interval) return false;
        if (seen.size >= 32) seen.delete(seen.keys().next().value);
        seen.set(key, time);
        return true;
    };
}
