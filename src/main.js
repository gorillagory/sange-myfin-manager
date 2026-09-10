import LegacyIcon from './components/ui/LegacyIcon.vue'
import { createApp } from 'vue'
import './style.css'
import './edition.css'
import App from './App.vue'
import router from './router'
import { Store } from './store' 

Store.init();
const app = createApp(App)
app.component('LegacyIcon', LegacyIcon);
app.use(router)
app.mount('#app')
if (import.meta.env.PROD) {
    Store.state.offlineStatus = 'Preparing offline app…';
    if (!('serviceWorker' in navigator)) Store.state.offlineStatus = 'Offline app unavailable in this browser';
    else navigator.serviceWorker.register('/sw.js')
        .then(() => navigator.serviceWorker.ready)
        .then(() => { Store.state.offlineStatus = 'Offline app ready on this device'; })
        .catch(() => { Store.state.offlineStatus = 'Offline app setup failed. Reload online to retry.'; });
}
