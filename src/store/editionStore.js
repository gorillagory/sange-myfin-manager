import { permissionsFor, can, stripConfidential } from "../domain/permissions";
import { hydrationCollections } from "../domain/viewAccess";
import { safePaidSale, safeCompany, needsReceiptReview } from "../domain/offlinePolicy";
import { localSettings } from "../services/localSettings";
import { reactive } from "vue";
import { api, listAll, onSessionExpired } from "../services/api";
import { state } from "./state";
import { financeModule } from "./finance";
import { inventoryModule } from "./inventory";
import { companiesModule } from "./companies";
import { authModule } from "./auth";
import { normalizeProduct } from "../domain/pos";
import { localPos } from "../services/posLocal";
import { postSale } from "../services/checkout";
import { checkoutPayload } from "../services/postSale";

let initialized = false,
  session = 0,
  companyEpoch = 0,
  refreshEpoch = 0,
  directoryEpoch = 0,
  actorEpoch = 0,
  reviewEpoch = 0,
  notifyTimer,
  syncing = false;
async function confirmSale(sale) {
  let timeout;
  try {
    return await Promise.race([
      postSale(sale),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Cloud confirmation is taking longer than expected. Retry sync; do not take payment again.",
              ),
            ),
          12000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export const Store = reactive({
  state,
  financeModule,
  inventoryModule,
  companiesModule,
  authModule,
  clearSession() {
    session++;
    directoryEpoch++;
    actorEpoch++;
    state.sessionVerified = false;
    this.clearCompany();
    state.currentUser = null;
    state.selectedCompany = null;
    state.companies = [];
    state.users = [];
    state.isLoading = false;
  },
  permissions() { return permissionsFor(state.currentUser); },
  can(action) { return can(state.currentUser, action); },
  async refreshActor() {
    if (!state.online || !state.currentUser) return state.currentUser;
    const generation = session, request = ++actorEpoch, previous = state.currentUser;
    const fresh = await api("/me");
    if (generation !== session || request !== actorEpoch) return null;
    if ((fresh.uid || fresh.id) !== (previous.uid || previous.id)) {
      this.clearSession();
      this.notify("The signed-in account changed. Reload before continuing.", "warning");
      return null;
    }
    const changed = fresh.role !== previous.role || fresh.company_id !== previous.company_id;
    if (changed) {
      this.clearCompany();
      state.users = [];
      if (fresh.role !== "super" && state.selectedCompany?.id !== fresh.company_id) {
        state.selectedCompany = null; state.companies = [];
      }
      this.notify("Your access changed. The workspace has been refreshed; paid receipts remain on this device.", "warning");
    }
    state.currentUser = fresh;
    state.sessionVerified = true;
    const p = permissionsFor(fresh);
    if (!p.costsRead) {
      state.products = stripConfidential(state.products);
      state.transactions = stripConfidential(state.transactions);
      state.companies = stripConfidential(state.companies);
      if (state.selectedCompany) state.selectedCompany = stripConfidential(state.selectedCompany);
    }
    if (!p.expensesRead) state.expenses = [];
    if (!p.activityRead) state.activities = [];
    if (!p.stockHistoryRead) state.stock_movements = [];
    if (!p.usersManage) state.users = [];
    if (!p.suppliersRead) state.clients = state.clients.filter(c => c.type !== "Supplier");
    return fresh;
  },
  async login(email, password) {
    try {
      if (localSettings.getItem("myfin-logout-pending")) {
        await api("/auth/sign-out", { method: "POST" });
        localSettings.removeItem("myfin-logout-pending");
      }
      await api("/auth/sign-in/email", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      await this.loadSession();
      return true;
    } catch {
      this.notify("Sign-in failed. Check your email and password.", "error");
      return false;
    }
  },
  async logout() {
    if (state.pendingSales.length)
      this.notify(
        "Paid receipts remain safely queued on this device. Sign in as the same operator to sync them.",
        "warning",
      );
    localSettings.setItem("myfin-logout-pending", "1");
    try {
      await api("/auth/sign-out", { method: "POST" });
      localSettings.removeItem("myfin-logout-pending");
    } catch {
      this.notify(
        "Server sign-out could not be confirmed. Reconnect to revoke the session.",
        "warning",
      );
    }
    localSettings.removeItem("myfin-last-operator");
    this.clearSession();
  },
  clearCompany() {
    companyEpoch++;
    refreshEpoch++;
    reviewEpoch++;
    for (const key of [
      "products",
      "transactions",
      "expenses",
      "clients",
      "activities",
      "stock_movements",
      "pendingSales",
      "receiptReviews",
    ])
      state[key] = [];
    state.dataError = "";
    state.dataLoading = false;
    state.fromCache = true;
  },
  async loadSession() {
    const generation = ++session;
    directoryEpoch++; actorEpoch++;
    state.sessionVerified = false;
    this.clearCompany();
    state.currentUser = null;
    state.selectedCompany = null;
    state.companies = [];
    state.users = [];
    try {
      if (localSettings.getItem("myfin-logout-pending")) {
        await api("/auth/sign-out", { method: "POST" });
        localSettings.removeItem("myfin-logout-pending");
        return;
      }
      await localPos.ready().catch(() => this.notify("Device storage needs an update. Close other MyFin tabs and reload before checkout.", "warning"));
      const user = await api("/me");
      if (generation !== session) return;
      state.currentUser = user;
      state.sessionVerified = true;
      localSettings.setItem("myfin-last-operator", user.uid);
      await this.startListeners();
      if (generation === session)
        await localPos
          .putProfile(user.uid, { user, companies: state.companies, verifiedAt: new Date().toISOString() })
          .catch(() =>
            this.notify(
              "Offline profile could not be saved on this device.",
              "warning",
            ),
          );
    } catch (e) {
      if (generation !== session) return;
      if (e.network && !localSettings.getItem("myfin-logout-pending")) {
        const uid = localSettings.getItem("myfin-last-operator");
        const saved = uid && (await localPos.getProfile(uid));
        if (generation !== session) return;
        if (saved) {
          state.currentUser = saved.user;
          state.sessionVerified = false;
          state.companies = saved.companies;
          this.notify(
            "Offline checkout uses your last verified access. Access changes cannot reach a disconnected device; reconnect before syncing.",
            "warning",
          );
          const co =
            saved.companies.find(
              (c) => c.id === localSettings.getItem("myfin-store-" + uid),
            ) || saved.companies[0];
          if (co) this.selectCompany(co);
        }
      } else
        this.notify(
          "Please sign in again. Pending receipts remain on this device.",
          "warning",
        );
    } finally {
      if (generation === session) state.isLoading = false;
    }
  },
  init() {
    if (initialized) return;
    initialized = true;
    onSessionExpired(() => {
      localSettings.removeItem("myfin-last-operator");
      this.clearSession();
      this.notify(
        "Session expired. Sign in again to sync pending receipts.",
        "warning",
      );
    });
    const network = () => {
      state.online = navigator.onLine;
      if (!state.online) {
        state.sessionVerified = false;
        state.products = stripConfidential(state.products);
        state.transactions = stripConfidential(state.transactions);
        state.expenses = []; state.activities = []; state.users = []; state.receiptReviews = [];
        state.stock_movements = []; state.clients = state.clients.filter(c => c.type !== "Supplier");
        state.companies = state.companies.map(safeCompany);
        if (state.selectedCompany) state.selectedCompany = safeCompany(state.selectedCompany);
      }
      if (state.online) {
        if (state.currentUser) {
          this.startListeners()
            .then(() => this.refreshData())
            .then(() => this.syncSales())
            .catch((e) => this.notify(e.message, "warning"));
        } else this.loadSession();
      }
    };
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    state.online = navigator.onLine;
    this.loadSession();
    setInterval(() => {
      if (state.online && state.currentUser)
        this.startListeners()
          .then(() => this.refreshData())
          .catch((e) => {
            state.dataError = e.message;
          });
    }, 30000);
  },
  async startListeners() {
    const generation = session, request = ++directoryEpoch;
    if (!state.currentUser || !state.online) return;
    const user = await this.refreshActor();
    if (!user || generation !== session || request !== directoryEpoch) return;
    const p = permissionsFor(user);
    const [companies, users] = await Promise.all([
      api("/companies"), p.usersManage ? api("/users") : Promise.resolve([]),
    ]);
    if (generation !== session || request !== directoryEpoch || state.currentUser?.role !== user.role) return;
    state.companies = p.costsRead ? companies : stripConfidential(companies);
    state.users = users;
    const chosen = state.selectedCompany?.id || localSettings.getItem("myfin-store-" + user.uid);
    const co = state.companies.find(c => c.id === chosen) || (user.role !== "super" ? state.companies[0] : null);
    this.selectCompany(co || null);
    await localPos.putProfile(user.uid, { user, companies: state.companies, verifiedAt:new Date().toISOString() })
      .catch(() => this.notify("Offline profile could not be saved on this device.", "warning"));
  },
  selectCompany(company) {
    if (company && !state.companies.some((c) => c.id === company.id)) return;
    const changed = company?.id !== state.selectedCompany?.id;
    if (changed) this.clearCompany();
    state.selectedCompany = company;
    state.preferences = { theme: "light", ...(company?.preferences || {}) };
    if (company)
      localSettings.setItem("myfin-store-" + state.currentUser.uid, company.id);
    else if (state.currentUser)
      localSettings.removeItem("myfin-store-" + state.currentUser.uid);
    if (changed && company) this.startCompanyDataListeners(company.id);
  },
  async startCompanyDataListeners(companyId) {
    const uid = state.currentUser?.uid,
      generation = companyEpoch;
    const cached = await localPos.getCatalog(uid, companyId).catch(() => null);
    if (generation !== companyEpoch) return;
    if (cached && state.fromCache) {
      state.products = stripConfidential(cached.products || []);
      state.clients = (cached.clients || []).filter(c => c.type !== "Supplier");
      state.fromCache = true;
    }
    await this.refreshPending();
    if (state.online) {
      await this.refreshData();
      await this.syncSales();
    }
  },
  async refreshData() {
    const uid = state.currentUser?.uid,
      co = state.selectedCompany?.id,
      generation = companyEpoch,
      request = ++refreshEpoch,
      actorRole = state.currentUser?.role;
    if (!uid || !co || !state.online) return;
    state.dataLoading = true;
    try {
      const names = hydrationCollections(state.currentUser);
      for (const key of ["expenses","activities","stock_movements"]) if (!names.includes(key)) state[key] = [];
      const values = await Promise.all(
        names.map((n) =>
          listAll("/companies/" + encodeURIComponent(co) + "/" + n),
        ),
      );
      if (
        generation !== companyEpoch ||
        request !== refreshEpoch ||
        state.currentUser?.uid !== uid || state.currentUser?.role !== actorRole
      )
        return;
      const permissions = permissionsFor(state.currentUser);
      names.forEach((name, i) => {
        let rows = name === "products" ? values[i].map(normalizeProduct) : values[i];
        if (!permissions.costsRead) rows = stripConfidential(rows);
        if (name === "clients" && !permissions.suppliersRead) rows = rows.filter(c => c.type !== "Supplier");
        state[name] = rows;
      });
      await this.refreshReceiptReviews();
      if (generation !== companyEpoch || request !== refreshEpoch || state.currentUser?.uid !== uid || state.currentUser?.role !== actorRole) return;
      state.fromCache = false;
      state.dataError = "";
      await localPos
        .putCatalog(uid, co, {
          products: state.products,
          clients: state.clients,
        })
        .catch(() =>
          this.notify(
            "Offline catalog could not be saved. Keep this device online.",
            "warning",
          ),
        );
    } catch (e) {
      if (e.status === 403 && state.currentUser) await this.refreshActor().catch(() => {});
      if (generation === companyEpoch && request === refreshEpoch) {
        state.fromCache = true;
        state.dataError = e.message;
      }
    } finally {
      if (generation === companyEpoch && request === refreshEpoch)
        state.dataLoading = false;
    }
  },
  async refreshReceiptReviews() {
    const uid = state.currentUser?.uid, role = state.currentUser?.role,
      co = state.selectedCompany?.id, generation = companyEpoch, request = ++reviewEpoch;
    if (!uid || !co || !state.online || !this.can("checkout")) return;
    const rows = await api("/companies/" + encodeURIComponent(co) + "/receipt-reviews");
    if (generation !== companyEpoch || request !== reviewEpoch || state.currentUser?.uid !== uid || state.currentUser?.role !== role) return;
    state.receiptReviews = rows;
  },
  async requestReceiptReview(sale) {
    if (!state.online || !this.can("checkout") || sale.cashierId !== state.currentUser?.uid || sale.company_id !== state.selectedCompany?.id)
      throw new Error("Reconnect as the original cashier in this workspace to request payment review.");
    const result = await api("/companies/" + encodeURIComponent(sale.company_id) + "/receipt-reviews", {
      method:"POST", body:{sale:checkoutPayload(sale)},
    });
    await this.refreshReceiptReviews();
    return result;
  },
  async preserveUnconfirmedSale(sale, error) {
    await localPos.putSale({...sale, syncError:error.message});
    if (error.status === 409 && needsReceiptReview(error)) {
      // The queue remains the recovery authority until checkout confirms this ID.
      // Review submission may itself fail after committing; retry is idempotent.
      await this.requestReceiptReview(sale).catch(() => {});
    }
  },
  async approveReceiptReview(id, reason) {
    if (!state.online || !this.can("documentsIssue")) throw new Error("An online manager or owner must approve this payment.");
    if (reason.trim().length < 3) throw new Error("Explain why the original recorded payment is approved (at least 3 characters).");
    const co = state.selectedCompany?.id;
    if (!co) throw new Error("Choose a workspace first.");
    const result = await api("/companies/" + encodeURIComponent(co) + "/receipt-reviews/" + encodeURIComponent(id) + "/approve", {
      method:"POST", body:{reason:reason.trim()},
    });
    await this.refreshReceiptReviews();
    await this.refreshData();
    return result;
  },
  async refreshPending() {
    const uid = state.currentUser?.uid,
      companyId = state.selectedCompany?.id;
    if (!uid || !companyId) return;
    try {
      const sales = await localPos.sales(uid, companyId);
      if (
        state.currentUser?.uid === uid &&
        state.selectedCompany?.id === companyId
      )
        state.pendingSales = sales;
    } catch {
      this.notify(
        "Device storage is unavailable. Checkout needs local storage enabled.",
        "error",
      );
    }
  },
  async syncSales() {
    if (
      syncing ||
      !state.online ||
      !state.currentUser ||
      !state.selectedCompany
    )
      return;
    syncing = true;
    state.syncing = true;
    try {
      const actor = await this.refreshActor();
      if (!actor || !state.selectedCompany || !this.can("checkout")) return;
      const uid = actor.uid, companyId = state.selectedCompany.id;
      for (const sale of await localPos.sales(uid, companyId)) {
        if (
          state.currentUser?.uid !== uid ||
          state.selectedCompany?.id !== companyId
        )
          break;
        try {
          await confirmSale(sale);
          await localPos.removeSale(sale.id);
        } catch (error) {
          await this.preserveUnconfirmedSale(sale, error);
        }
      }
      await this.refreshPending();
      await this.refreshData();
    } finally {
      syncing = false;
      state.syncing = false;
    }
  },
  async completeSale(sale, draftKey, nextDraft) {
    if (!this.can("checkout") || sale.cashierId !== state.currentUser?.uid || sale.company_id !== state.selectedCompany?.id)
      throw new Error("Sign in to the correct workspace before taking payment.");
    sale = safePaidSale(sale);
    await localPos.acceptSale(sale, draftKey, nextDraft);
    if (state.online && !state.fromCache) {
      try {
        const saved = await confirmSale(sale);
        await localPos.removeSale(sale.id);
        await this.refreshPending();
        await this.refreshData();
        return { ...saved, syncStatus: "synced" };
      } catch (error) {
        await this.preserveUnconfirmedSale(sale, error);
        await this.refreshPending();
        return { ...sale, syncStatus: "pending", syncError: error.message };
      }
    }
    await this.refreshPending();
    return { ...sale, syncStatus: "pending" };
  },
  addTransaction(t) {
    return financeModule.addTransaction(this, t);
  },
  updateTransaction(t) {
    return financeModule.updateTransaction(this, t);
  },
  deleteTransaction(id) {
    return financeModule.deleteTransaction(this, id);
  },
  assignProject(data) {
    return financeModule.assignProject(this, data);
  },
  addProduct(p) {
    return inventoryModule.addProduct(this, p);
  },
  updateProduct(p) {
    return inventoryModule.updateProduct(this, p);
  },
  deleteProduct(id) {
    return inventoryModule.deleteProduct(this, id);
  },
  addExpense(e) {
    return financeModule.addExpense(this, e);
  },
  deleteExpense(id) {
    return financeModule.deleteExpense(this, id);
  },
  addClient(c) {
    return financeModule.addClient(this, c);
  },
  deleteClient(id) {
    return financeModule.deleteClient(this, id);
  },
  addCompany(c) {
    return companiesModule.addCompany(this, c);
  },
  updateCompany(c) {
    return companiesModule.updateCompany(this, c);
  },
  deleteCompany(id) {
    return companiesModule.deleteCompany(this, id);
  },
  addUser(u) {
    return authModule.addUser(this, u);
  },
  updateUser(u) {
    return authModule.updateUser(this, u);
  },
  deleteUser(id) {
    return authModule.deleteUser(this, id);
  },
  updateSelf(data) {
    return authModule.updateSelf(this, data);
  },
  notify(message, type = "success") {
    clearTimeout(notifyTimer);
    state.notification = { show: true, message, type };
    notifyTimer = setTimeout(() => (state.notification.show = false), 6000);
  },
  logActivity() {
    /* Mutations and their audit records are committed by the server. */
  },
  canDelete() {
    return ["super", "company_admin"].includes(state.currentUser?.role);
  },
  updatePreferences(prefs) {
    return companiesModule.updatePreferences(this, prefs);
  },
  saveCompanyStyle(style) {
    return this.updatePreferences(style);
  },
});
