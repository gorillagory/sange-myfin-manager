<script setup>
import { ref } from 'vue';
import { useStorage } from '../../composables/useStorage';
const props = defineProps({ modelValue: { type: Object, required: true }, disabled: Boolean });
const emit = defineEmits(['busy']);
const { optimizeImage, extractQRCode } = useStorage();
const error = ref(''), processing = ref('');
async function upload(event, field) {
  const file = event.target.files?.[0]; if (!file) return;
  error.value = '';
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    error.value = 'Choose a PNG, JPEG or WebP image under 10 MB.'; event.target.value = ''; return;
  }
  processing.value = field; emit('busy', true);
  try {
    let value;
    if (field === 'qrCode') { const qr = await extractQRCode(file); value = qr.success ? qr.url : await optimizeImage(file); }
    else value = await optimizeImage(file, true);
    if (!value || value.length > 800000) throw Error('image_too_large');
    props.modelValue[field] = value;
  } catch { error.value = 'This image could not be processed. Try a smaller image.'; }
  finally { processing.value = ''; emit('busy', false); event.target.value = ''; }
}
</script>
<template>
  <fieldset class="ed-management-fields" :disabled="disabled || !!processing">
    <div class="ed-form-grid">
      <label class="ed-field wide"><span>Company name <span aria-hidden="true">*</span></span><input v-model="modelValue.name" required maxlength="120" autocomplete="organization"></label>
      <label class="ed-field"><span>Registration number</span><input v-model="modelValue.registration" maxlength="500"></label>
      <label class="ed-field"><span>Phone</span><input v-model="modelValue.phone" type="tel" maxlength="500" autocomplete="tel"></label>
      <label class="ed-field wide"><span>Company email</span><input v-model="modelValue.email" type="email" maxlength="254" autocomplete="email"></label>
      <label class="ed-field wide"><span>Business address</span><textarea v-model="modelValue.address" maxlength="500" rows="3" autocomplete="street-address"></textarea></label>
      <label class="ed-field"><span>Currency symbol <span aria-hidden="true">*</span></span><input v-model="modelValue.preferences.currency" required maxlength="8" placeholder="RM"></label>
      <label class="ed-field"><span>Default tax (%)</span><input v-model.number="modelValue.preferences.taxRate" type="number" required min="0" max="100" step="0.01"></label>
    </div>
    <div class="ed-editor-section">
      <h3>Branding & payment</h3><p class="ed-muted">Optional images used on your company profile and receipts.</p>
      <div class="ed-form-grid">
        <div v-for="field in ['logo','qrCode']" :key="field" class="ed-management-image">
          <img v-if="modelValue[field]" :src="modelValue[field]" :alt="field === 'logo' ? 'Company logo preview' : 'Payment QR preview'">
          <label class="ed-field"><span>{{ field === 'logo' ? 'Company logo' : 'DuitNow QR image' }}</span><input type="file" accept="image/png,image/jpeg,image/webp" @change="upload($event,field)"></label>
          <button v-if="modelValue[field]" type="button" class="ed-link" @click="modelValue[field]=null">Remove {{ field === 'logo' ? 'logo' : 'QR image' }}</button>
        </div>
      </div>
      <p v-if="processing" role="status">Preparing image…</p><p v-if="error" class="ed-alert" role="alert">{{ error }}</p>
    </div>
  </fieldset>
</template>
