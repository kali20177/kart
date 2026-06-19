import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/tokens.css'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'

createApp(App).use(createPinia()).mount('#app')
