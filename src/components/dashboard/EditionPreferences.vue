<script setup>
import { computed, ref } from 'vue';
import { Store } from '../../store';
import Icon from '../ui/EditionIcon.vue';
import { localSettings } from '../../services/localSettings';
import { DEFAULT_THEME_COLOR, THEME_PRESETS, normalizeThemeColor, themeVariables } from '../../domain/theme';

const tab = ref('Appearance'), busy = ref(false);
const initialPreferences = {
  density: 'comfortable',
  reduceMotion: false,
  paperWidth: '80',
  receiptFooter: 'Thank you for shopping with us.',
  staffDiscountLimit: 0,
  primaryColor: DEFAULT_THEME_COLOR,
  ...Store.state.selectedCompany?.preferences,
};
initialPreferences.primaryColor = normalizeThemeColor(initialPreferences.primaryColor);
const prefs = ref(initialPreferences);
const themePreview = computed(() => themeVariables(prefs.value.primaryColor));

async function save() {
  busy.value = true;
  try {
    const device = {
      density: prefs.value.density,
      reduceMotion: !!prefs.value.reduceMotion,
      paperWidth: prefs.value.paperWidth,
    };
    localSettings.setItem('myfin-device-preferences-' + Store.state.selectedCompany?.id, JSON.stringify(device));
    Object.assign(Store.state.preferences, device);
    if (Store.can('companyWrite')) {
      if (Store.permissions().owner && (!Number.isFinite(Number(prefs.value.staffDiscountLimit)) || Number(prefs.value.staffDiscountLimit) < 0 || Number(prefs.value.staffDiscountLimit) > 100))
        throw new Error('Operator discount limit must be between 0 and 100%.');
      prefs.value.primaryColor = normalizeThemeColor(prefs.value.primaryColor);
      await Store.updatePreferences({ ...prefs.value, theme: 'light' });
    }
    Store.notify(Store.can('companyWrite') ? 'Company and device preferences saved.' : 'Device and printing preferences saved.');
  } catch (error) {
    Store.notify(error.message, 'error');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="ed-page">
    <header class="ed-page-head">
      <div><div class="ed-eyebrow">DEVICE / PRINTING</div><h1>Make this counter your own.</h1><p>Operators can change settings stored on this device. Company policy remains password-protected.</p></div>
      <button class="ed-btn primary" :disabled="busy" @click="save"><Icon name="check" />{{ busy ? 'Saving…' : 'Save changes' }}</button>
    </header>
    <div class="ed-settings">
      <nav class="ed-settings-nav" aria-label="Preference sections">
        <button v-for="section in ['Appearance','Receipts','Checkout']" :key="section" :class="{active:tab===section}" @click="tab=section">{{ section }}</button>
        <router-link v-if="Store.can('companyWrite')" to="/companies" class="ed-link" style="padding:12px">Company profile<Icon name="arrow" /></router-link>
        <router-link v-if="Store.can('templatesWrite')" to="/templates" class="ed-link" style="padding:12px">Document templates<Icon name="arrow" /></router-link>
      </nav>
      <section>
        <template v-if="tab==='Appearance'">
          <h2>Workspace appearance</h2>
          <div class="ed-theme-preview" :style="themePreview" aria-label="Theme color preview">
            <span class="ed-theme-preview-mark" aria-hidden="true"></span>
            <div><strong>{{ Store.state.selectedCompany?.name || 'Your company' }}</strong><small>Buttons, navigation and highlights use this company color.</small></div>
            <span class="ed-theme-preview-action">Preview</span>
          </div>
          <div v-if="Store.can('companyWrite')" class="ed-editor-section">
            <h3>Company color</h3>
            <p class="ed-muted">Choose a brand color for everyone in this company. Bright colors are deepened automatically where text needs more contrast.</p>
            <div class="ed-theme-color-row">
              <label class="ed-field"><span>Custom color</span><input v-model="prefs.primaryColor" type="color" aria-label="Company theme color"></label>
              <output :style="{color:themePreview['--ed-accent']}">{{ normalizeThemeColor(prefs.primaryColor).toUpperCase() }}</output>
            </div>
            <div class="ed-theme-swatches" role="group" aria-label="Theme color presets">
              <button v-for="preset in THEME_PRESETS" :key="preset.value" type="button" :class="{active:normalizeThemeColor(prefs.primaryColor)===preset.value}" :aria-label="`Use ${preset.name} theme`" :aria-pressed="normalizeThemeColor(prefs.primaryColor)===preset.value" @click="prefs.primaryColor=preset.value">
                <i :style="{background:preset.value}" aria-hidden="true"></i><span>{{ preset.name }}</span>
              </button>
            </div>
          </div>
          <p v-else class="ed-notice">The company color is shared across the workspace. Ask a manager or owner to change it.</p>
          <div class="ed-section">
            <h2>Display on this device</h2>
            <div class="ed-actions" style="margin-top:20px"><label><input v-model="prefs.density" type="radio" value="comfortable"> Comfortable</label><label><input v-model="prefs.density" type="radio" value="compact"> Compact</label></div>
            <label class="ed-switch"><span><strong>Reduce motion</strong><small>Keep transitions quiet and immediate.</small></span><input v-model="prefs.reduceMotion" type="checkbox"></label>
          </div>
        </template>
        <template v-else-if="tab==='Receipts'">
          <h2>Printing on this device</h2>
          <div class="ed-form-grid"><label class="ed-field"><span>Paper width</span><select v-model="prefs.paperWidth"><option value="80">80 mm thermal</option><option value="58">58 mm thermal</option></select></label><label v-if="Store.can('companyWrite')" class="ed-field wide"><span>Company receipt footer</span><textarea v-model="prefs.receiptFooter" maxlength="500"></textarea></label></div>
          <div class="ed-notice"><Icon name="printer" /><div>Choose the matching paper size in the printer dialog. Reprinting never creates another sale.</div></div>
        </template>
        <template v-else>
          <h2>At the counter</h2>
          <label v-if="Store.permissions().owner" class="ed-field ed-editor-section"><span>Operator discount limit (%)</span><input v-model.number="prefs.staffDiscountLimit" type="number" min="0" max="100" step="0.01"></label>
          <p v-else class="ed-notice">Discount policy is owner-controlled. Current limit: {{ Store.state.selectedCompany?.preferences?.staffDiscountLimit || 0 }}%.</p>
          <div class="ed-row"><div><strong>Durable orders</strong><small>Cart and held orders stay on this signed-in device after refresh.</small></div><span class="ed-pill">Enabled</span></div>
          <div class="ed-row"><div><strong>Offline receipt queue</strong><small>Pending receipts remain on this device until confirmed.</small></div><span class="ed-pill">Enabled</span></div>
        </template>
      </section>
    </div>
  </div>
</template>
