// Opt-in contract for an extension that owns a real character reply's revisions.
// Judge, memory and translation calls must keep using their original fetch.
export function createReplySessions({ enabled, recovery, transport, consume = () => {}, captureQuiet, onError = () => {} }) {
    return Object.freeze({
        apiVersion: 1,
        beginReview(index, message, signal) {
            if (!enabled() || !captureQuiet) return null;
            let sequence;
            try { sequence = recovery.beginReview(index, message, signal); }
            catch (error) { onError(error); return null; }
            if (!sequence) return null;
            return Object.freeze({
                async capture(prompt, action) {
                    if (sequence.closed) throw new Error('이미 끝난 답장 검수입니다.');
                    const previousId = sequence.latestId;
                    const text = await captureQuiet(sequence, prompt, action);
                    try { recovery.acceptReview(sequence, text, previousId); }
                    catch (error) { onError(error); }
                    return text;
                },
                completeMessage(message) {
                    try { recovery.completeReview(sequence, message); }
                    catch (error) { onError(error); }
                },
                cancel() {
                    try { recovery.cancelSequence(sequence); }
                    catch (error) { onError(error); }
                },
            });
        },
        begin() {
            if (!enabled()) return null;
            let sequence;
            try { sequence = recovery.beginSequence(); }
            catch (error) { onError(error); return null; }
            if (!sequence) return null;
            consume();
            return Object.freeze({
                fetch(input, init, upstream) {
                    if (sequence.closed) return Promise.reject(new Error('이미 끝난 답장 연동입니다.'));
                    return transport.replyFetch(input, init, sequence, upstream);
                },
                complete(response) {
                    try { recovery.completeSequence(sequence, response?.headers?.get('x-silly-relay-job')); }
                    catch (error) { onError(error); }
                },
                cancel() {
                    try { recovery.cancelSequence(sequence); }
                    catch (error) { onError(error); }
                },
            });
        },
    });
}
