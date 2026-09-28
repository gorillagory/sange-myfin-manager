import { reactive } from 'vue';
import { auth, db } from '../firebase';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail } from 'firebase/auth';
import { collection, doc, onSnapshot, query, where, addDoc } from 'firebase/firestore';
import { state } from './state';
import { financeModule } from './finance';
import { inventoryModule } from './inventory';
import { companiesModule } from './companies';
import { authModule } from './auth';
import { normalizeProduct } from '../domain/pos';
import { localPos } from '../services/posLocal';
import { postSale } from '../services/checkout';

let initialized = false, session = 0, companyEpoch = 0, profileStop, notifyTimer, syncing = false;
const globalStops = [], companyStops = [];
const stop = list => list.splice(0).forEach(fn => fn());
const records = snap => snap.docs.map(d => ({ ...d.data(), id: d.id }));
async function confirmSale(sale) {
  let timeout;
  try { return await Promise.race([postSale(sale), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cloud confirmation is taking longer than expected. Retry sync; do not take payment again.')), 12000); })]); }
  finally { clearTimeout(timeout); }
}

export const Store = reactive({
  state, financeModule, inventoryModule, companiesModule, authModule,
  async login(email, password) {
    try { await signInWithEmailAndPassword(auth, email.trim(), password); return true; }
    catch { this.notify('Sign-in failed. Check your email and password, then try again.', 'error'); return false; }
  },
  async logout() { await signOut(auth); },
  clearCompany() {
    companyEpoch++; stop(companyStops);
    for (const key of ['products', 'transactions', 'expenses', 'clients', 'activities', 'pendingSales']) state[key] = [];
    state.dataError = ''; state.dataLoading = false;
  },
  init() {
    if (initialized) return; initialized = true;
    const setOnline = () => { state.online = navigator.onLine; if (state.online) this.syncSales(); };
    window.addEventListener('online', setOnline); window.addEventListener('offline', setOnline); setOnline();
    onAuthStateChanged(auth, user => {
      const generation = ++session;
      profileStop?.(); stop(globalStops); this.clearCompany();
      state.currentUser = null; state.selectedCompany = null; state.companies = []; state.users = [];
      if (!user) { state.isLoading = false; return; }
      state.isLoading = true;
      profileStop = onSnapshot(doc(db, 'users', user.uid), snapshot => {
        if (generation !== session) return;
        if (!snapshot.exists()) {
          state.currentUser = null; this.clearCompany(); stop(globalStops); state.selectedCompany = null;
          state.isLoading = false; this.notify('Your account has no store access. Contact your administrator.', 'error'); return;
        }
        const next = { ...snapshot.data(), id: snapshot.id, uid: user.uid };
        const changed = !state.currentUser || state.currentUser.role !== next.role || state.currentUser.company_id !== next.company_id;
        state.currentUser = next;
        if (changed) { stop(globalStops); this.clearCompany(); state.selectedCompany = null; this.startListeners(); }
        state.isLoading = false;
      }, error => { if (generation === session) { state.isLoading = false; this.notify(`Unable to load your profile: ${error.message}`, 'error'); } });
    });
  },
  startListeners() {
    stop(globalStops);
    const user = state.currentUser, generation = session;
    if (!user) return;
    const fail = e => { if (generation === session) { state.dataError = e.message; this.notify(`Unable to load store data: ${e.message}`, 'error'); } };
    if (user.role === 'super') {
      globalStops.push(onSnapshot(collection(db, 'companies'), snap => {
        if (generation !== session) return;
        state.companies = records(snap);
        if (!state.selectedCompany) {
          try { const last = state.companies.find(c => c.id === localStorage.getItem(`myfin-store-${user.uid}`)); if (last) this.selectCompany(last); } catch { /* Company selection still works without localStorage. */ }
        }
        if (state.selectedCompany) {
          const co = state.companies.find(c => c.id === state.selectedCompany.id);
          if (co) { state.selectedCompany = co; state.preferences = { ...co.preferences }; }
          else this.selectCompany(null);
        }
      }, fail));
    } else if (user.company_id) {
      globalStops.push(onSnapshot(doc(db, 'companies', user.company_id), snap => {
        if (generation !== session) return;
        if (!snap.exists()) { state.companies = []; this.selectCompany(null); return; }
        const co = { ...snap.data(), id: snap.id }; state.companies = [co]; this.selectCompany(co);
      }, fail));
    }
    const usersQuery = user.role === 'super' ? collection(db, 'users') : query(collection(db, 'users'), where('company_id', '==', user.company_id || 'unassigned'));
    globalStops.push(onSnapshot(usersQuery, snap => { if (generation === session) state.users = records(snap); }, fail));
  },
  selectCompany(company) {
    if (company && state.currentUser?.role !== 'super' && company.id !== state.currentUser?.company_id) return;
    const changed = company?.id !== state.selectedCompany?.id;
    state.selectedCompany = company;
    try { if (company) localStorage.setItem(`myfin-store-${state.currentUser.uid}`, company.id); else localStorage.removeItem(`myfin-store-${state.currentUser?.uid}`); } catch { /* IndexedDB still protects checkout. */ }
    state.preferences = { theme: 'light', ...(company?.preferences || {}) };
    if (changed) { this.clearCompany(); if (company) this.startCompanyDataListeners(company.id); }
  },
  startCompanyDataListeners(companyId) {
    const generation = companyEpoch;
    state.dataLoading = true;
    const waiting = new Set(['products', 'transactions', 'expenses', 'clients', 'activities']);
    for (const name of waiting) {
      companyStops.push(onSnapshot(query(collection(db, name), where('company_id', '==', companyId)), { includeMetadataChanges: true }, snap => {
        if (generation !== companyEpoch || state.selectedCompany?.id !== companyId) return;
        state[name] = records(snap).map(row => name === 'products' ? normalizeProduct(row) : row);
        state.fromCache = snap.metadata.fromCache;
        waiting.delete(name); state.dataLoading = waiting.size > 0;
        if (name === 'transactions' && !snap.metadata.fromCache && state.pendingSales.length) this.syncSales();
      }, error => {
        if (generation !== companyEpoch) return;
        waiting.delete(name); state.dataLoading = waiting.size > 0; state.dataError = `${name}: ${error.message}`;
      }));
    }
    this.refreshPending().then(() => this.syncSales());
  },
  async refreshPending() {
    const uid = state.currentUser?.uid, companyId = state.selectedCompany?.id;
    if (!uid || !companyId) return;
    try { const sales = await localPos.sales(uid, companyId); if (state.currentUser?.uid === uid && state.selectedCompany?.id === companyId) state.pendingSales = sales; }
    catch { this.notify('Device storage is unavailable. Checkout needs local storage enabled.', 'error'); }
  },
  async syncSales() {
    if (syncing || !state.online || !state.currentUser || !state.selectedCompany) return;
    syncing = true; state.syncing = true;
    const uid = state.currentUser.uid, companyId = state.selectedCompany.id;
    try {
      for (const sale of await localPos.sales(uid, companyId)) {
        if (state.currentUser?.uid !== uid || state.selectedCompany?.id !== companyId) break;
        try { await confirmSale(sale); await localPos.removeSale(sale.id); }
        catch (error) { await localPos.putSale({ ...sale, syncError: error.message }); }
      }
      await this.refreshPending();
    } finally { syncing = false; state.syncing = false; }
  },
  async completeSale(sale, draftKey, nextDraft) {
    await localPos.acceptSale(sale, draftKey, nextDraft);
    if (state.online && !state.fromCache) {
      try { const saved = await confirmSale(sale); await localPos.removeSale(sale.id); await this.refreshPending(); return { ...saved, syncStatus: 'synced' }; }
      catch (error) {
        await localPos.putSale({ ...sale, syncError: error.message }); await this.refreshPending();
        return { ...sale, syncStatus: 'pending', syncError: error.message };
      }
    }
    await this.refreshPending(); return { ...sale, syncStatus: 'pending' };
  },
  addTransaction(t) { return financeModule.addTransaction(this, t); },
  updateTransaction(t) { return financeModule.updateTransaction(this, t); },
  deleteTransaction(id) { return financeModule.deleteTransaction(this, id); },
  assignProject(data) { return financeModule.assignProject(this, data); },
  addProduct(p) { return inventoryModule.addProduct(this, p); },
  updateProduct(p) { return inventoryModule.updateProduct(this, p); },
  deleteProduct(id) { return inventoryModule.deleteProduct(this, id); },
  addExpense(e) { return financeModule.addExpense(this, e); },
  deleteExpense(id) { return financeModule.deleteExpense(this, id); },
  addClient(c) { return financeModule.addClient(this, c); },
  deleteClient(id) { return financeModule.deleteClient(this, id); },
  addCompany(c) { return companiesModule.addCompany(this, c); },
  updateCompany(c) { return companiesModule.updateCompany(this, c); },
  deleteCompany(id) { return companiesModule.deleteCompany(this, id); },
  addUser(u) { return authModule.addUser(this, u); },
  updateUser(u) { return authModule.updateUser(this, u); },
  deleteUser(id) { return authModule.deleteUser(this, id); },
  updateSelf(data) { return authModule.updateSelf(this, data); },
  async resetUserPassword(email) { try { await sendPasswordResetEmail(auth, email); this.notify('Password reset email sent.'); } catch (e) { this.notify(e.message, 'error'); } },
  notify(message, type = 'success') { clearTimeout(notifyTimer); state.notification = { show: true, message, type }; notifyTimer = setTimeout(() => state.notification.show = false, 6000); },
  logActivity(action, details) {
    if (!state.selectedCompany || !state.currentUser) return;
    return addDoc(collection(db, 'activities'), { company_id: state.selectedCompany.id, company: state.selectedCompany.name, user: state.currentUser.username || state.currentUser.email, actorId: state.currentUser.uid, action, details, date: new Date().toISOString() }).catch(() => this.notify('Changes saved, but the activity log could not be written.', 'warning'));
  },
  canDelete() { return ['super', 'company_admin'].includes(state.currentUser?.role); },
  updatePreferences(prefs) { return companiesModule.updatePreferences(this, prefs); },
  saveCompanyStyle(style) { return this.updatePreferences(style); }
});
