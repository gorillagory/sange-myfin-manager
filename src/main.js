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
if (import.meta.env.PROD && 'serviceWorker' in navigator) { window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => Store.notify('Offline app setup could not complete. Keep this page open during testing.', 'warning'))); }
