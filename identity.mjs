// A home-screen app survives a new browsing session, while ordinary browser
// tabs deliberately keep separate recovery identities.
const VALID = /^[a-f0-9]{32}$/;
export function recoveryIdentity({ local, session, standalone, newId }) {
    let tab;
    try { tab = session.getItem('silly-relay-tab'); } catch { /* PWA can use durable storage. */ }
    if (standalone) {
        let app = local.getItem('silly-relay-app-id-v1');
        if (!VALID.test(app || '')) {
            app = VALID.test(tab || '') ? tab : newId();
            local.setItem('silly-relay-app-id-v1', app);
            if (local.getItem('silly-relay-app-id-v1') !== app) throw new Error('웹앱 복구 식별자를 저장하지 못했습니다.');
        }
        try { session.setItem('silly-relay-tab', app); } catch { /* Durable PWA identity is sufficient. */ }
        return app;
    }
    if (!VALID.test(tab || '')) {
        tab = newId();
        session.setItem('silly-relay-tab', tab);
        if (session.getItem('silly-relay-tab') !== tab) throw new Error('탭 복구 식별자를 저장하지 못했습니다.');
    }
    return tab;
}
