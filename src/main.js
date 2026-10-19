import LegacyIcon from './components/ui/LegacyIcon.vue'
import { createApp } from 'vue'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import './style.css'
import './edition.css'
import './professional.css'
import App from './App.vue'
import router from './router'
import { isCustomerSurfacePath, isStorefrontHostname } from './domain/customerOrdering'
import { Store } from './store'

const app = createApp(App)
app.component('LegacyIcon', LegacyIcon);
app.use(router)
app.mount('#app')

const APPLY_APP_UPDATE_EVENT = 'myfin:apply-app-update';
const APP_UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const APP_UPDATE_ACTIVATION_TIMEOUT_MS = 20 * 1000;
const BUILD_RELEASE = document.querySelector('meta[name="myfin-release"]')?.content || '';

if (import.meta.env.PROD && !isCustomerSurfacePath(location.pathname) && !isStorefrontHostname(location.hostname)) {
    Store.state.offlineStatus = 'Preparing offline app…';
    if (!('serviceWorker' in navigator)) Store.state.offlineStatus = 'Offline app unavailable in this browser';
    else {
        const workers = navigator.serviceWorker;
        let controllingWorker = workers.controller;
        let pendingWorker = null;
        let activatedUpdate = false;
        let updateRequested = false;
        let activationAcknowledged = false;
        let activationSentTo = null;
        let activationTimer = null;
        const reportClientRelease = () => {
            if (BUILD_RELEASE && workers.controller) {
                workers.controller.postMessage({ type: 'CLIENT_RELEASE', release: BUILD_RELEASE });
            }
        };

        const startActivationTimeout = () => {
            window.clearTimeout(activationTimer);
            activationTimer = window.setTimeout(() => {
                if (!updateRequested) return;
                updateRequested = false;
                activationSentTo = null;
                Store.state.appUpdateAvailable = true;
                Store.state.appUpdateApplying = false;
                Store.state.offlineStatus = 'App update needs all open tabs to close';
                Store.state.appUpdateMessage = activationAcknowledged
                    ? 'The update is taking longer than expected. Close every MyFin tab, then reopen MyFin to finish safely.'
                    : 'Close every MyFin tab, then reopen MyFin to finish this update safely.';
            }, APP_UPDATE_ACTIVATION_TIMEOUT_MS);
        };

        workers.addEventListener('message', event => {
            if (event.data?.type === 'REQUEST_CLIENT_RELEASE') {
                reportClientRelease();
                return;
            }
            if (event.data?.type !== 'APP_UPDATE_ACCEPTED') return;
            activationAcknowledged = true;
            Store.state.offlineStatus = 'Applying app update…';
        });

        workers.addEventListener('controllerchange', () => {
            window.clearTimeout(activationTimer);
            if (!controllingWorker && !updateRequested) {
                controllingWorker = workers.controller;
                reportClientRelease();
                return;
            }
            controllingWorker = workers.controller;
            reportClientRelease();
            activatedUpdate = true;
            pendingWorker = null;
            Store.state.appUpdateAvailable = true;
            Store.state.appUpdateApplying = false;
            Store.state.offlineStatus = 'App update ready';
            Store.state.appUpdateMessage = 'The update is active. Update this tab when it is convenient.';
            if (updateRequested) location.reload();
        });

        const workerUrl = BUILD_RELEASE
            ? `/offline-worker?release=${encodeURIComponent(BUILD_RELEASE)}`
            : '/offline-worker';
        workers.register(workerUrl, { scope: '/', updateViaCache: 'none' })
            .then(registration => {
                let releaseMismatch = false;
                let updateCheck = null;
                const beginActivation = worker => {
                    if (!worker || worker.state !== 'installed' || activationSentTo === worker) return;
                    activationSentTo = worker;
                    Store.state.appUpdateApplying = true;
                    Store.state.offlineStatus = 'Applying app update…';
                    Store.state.appUpdateMessage = 'MyFin will reload this tab when the update is ready.';
                    startActivationTimeout();
                    try {
                        worker.postMessage({ type: 'SKIP_WAITING' });
                    } catch {
                        updateRequested = false;
                        activationSentTo = null;
                        window.clearTimeout(activationTimer);
                        Store.state.appUpdateApplying = false;
                        Store.state.offlineStatus = 'App update could not start. Try again.';
                    }
                };
                const showUpdate = worker => {
                    if (worker) pendingWorker = worker;
                    Store.state.appUpdateAvailable = true;
                    if (!updateRequested) {
                        Store.state.appUpdateApplying = false;
                        Store.state.offlineStatus = 'App update ready';
                        Store.state.appUpdateMessage = 'Finish your current task, then update when it is convenient.';
                    }
                    if (updateRequested && worker?.state === 'installed') beginActivation(worker);
                };
                const observe = worker => {
                    if (!worker) return;
                    if (worker.state === 'installed') {
                        if (workers.controller || registration.active) showUpdate(worker);
                        return;
                    }
                    worker.addEventListener('statechange', () => {
                        if (worker.state === 'installed' && (workers.controller || registration.active)) showUpdate(worker);
                    });
                };
                const checkRelease = async () => {
                    try {
                        const response = await fetch(`/release.json?from=${encodeURIComponent(BUILD_RELEASE || 'unknown')}`, {
                            cache: 'no-store',
                            credentials: 'same-origin',
                            headers: { Accept: 'application/json' },
                        });
                        if (!response.ok) return;
                        const release = (await response.json())?.release;
                        if (BUILD_RELEASE && /^[a-f0-9]{12}$/.test(release) && release !== BUILD_RELEASE) {
                            releaseMismatch = true;
                            showUpdate(registration.waiting);
                        }
                    } catch {
                        // The worker's normal update check still runs when the release probe is unavailable.
                    }
                };
                const checkForUpdate = () => {
                    if (updateCheck) return updateCheck;
                    reportClientRelease();
                    updateCheck = Promise.allSettled([registration.update(), checkRelease()])
                        .finally(() => { updateCheck = null; });
                    return updateCheck;
                };

                if (registration.waiting) showUpdate(registration.waiting);
                observe(registration.installing);
                registration.addEventListener('updatefound', () => observe(registration.installing));
                window.addEventListener('online', checkForUpdate);
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') checkForUpdate();
                });
                window.setInterval(checkForUpdate, APP_UPDATE_CHECK_INTERVAL_MS);
                window.addEventListener(APPLY_APP_UPDATE_EVENT, () => {
                    updateRequested = true;
                    activationAcknowledged = false;
                    Store.state.appUpdateApplying = true;
                    Store.state.appUpdateMessage = 'Preparing the update. This tab will reload when it is ready.';
                    if (activatedUpdate) {
                        location.reload();
                        return;
                    }
                    const worker = registration.waiting || pendingWorker;
                    if (worker?.state === 'installed') beginActivation(worker);
                    else {
                        Store.state.offlineStatus = releaseMismatch ? 'Preparing app update…' : 'Checking for app update…';
                        startActivationTimeout();
                        checkForUpdate();
                    }
                });
                checkForUpdate();
                return workers.ready;
            })
            .then(() => {
                reportClientRelease();
                if (!Store.state.appUpdateAvailable) Store.state.offlineStatus = 'Offline app ready on this device';
            })
            .catch(() => {
                if (!Store.state.appUpdateAvailable) Store.state.offlineStatus = 'Offline app setup failed. Reload online to retry.';
            });
    }
}
