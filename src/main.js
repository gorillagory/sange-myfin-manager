import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { Store } from './store' // Ensure Store is imported if needed globally, usually not needed here but good practice

Store.init();

createApp(App).mount('#app')
