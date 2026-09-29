import { permissionsFor, can, stripConfidential } from "../domain/permissions";
import { hydrationCollections } from "../domain/viewAccess";
import { safePaidSale, safeCompany, needsReceiptReview } from "../domain/offlinePolicy";
import { localSettings } from "../services/localSettings";
import { reactive } from "vue";
import { api, listAll, onSessionExpired } from "../services/api";
import { state } from "./state";
import { financeModule } from "./finance";
import { inventoryModule } from "./inventory";
import { stockModule } from "./stock";
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
  syncing = false,
  dataRefreshTask = null,
  workspaceRefreshTask = null,
  lastDataRefreshAt = 0;
export const DATA_REFRESH_STALE_MS = 2 * 60 * 1000;
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
  stockModule,
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
    lastDataRefreshAt = 0;
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
      if (fresh.role !== "super_admin" && state.selectedCompany?.id !== fresh.company_id) {
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
    if (!p.stockHistoryRead) { state.stock_movements = []; state.stock_ledger = []; }
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
  async posLogin(code) {
    try {
      await api("/pos-auth/sign-in",{method:"POST",body:{code:String(code).trim()}});
      await this.loadSession();return true;
    } catch (error) {
      this.notify(error.message==="pos_login_locked"?"Too many attempts. Wait 15 minutes before trying again.":"That access code is not valid for this company.","error");return false;
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
      if(state.currentUser?.authLevel==="pos_code")await api("/pos-auth/sign-out",{method:"POST"});
      else {await api("/session-handoffs/sign-out",{method:"POST"}).catch(()=>{});await api("/auth/sign-out", { method: "POST" });}
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
    lastDataRefreshAt = 0;
    for (const key of [
      "products",
      "transactions",
      "expenses",
      "clients",
      "activities",
      "stock_movements",
      "stock_items",
      "stock_ledger",
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
      await this.refreshWorkspace({ directory: true, sync: true, silent: false, verifyActor: false });
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
      const hadSession = Boolean(state.currentUser || localSettings.getItem("myfin-last-operator"));
      localSettings.removeItem("myfin-last-operator");
      this.clearSession();
      if (hadSession)
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
        state.stock_movements = []; state.stock_items = []; state.stock_ledger = []; state.clients = state.clients.filter(c => c.type !== "Supplier");
        state.companies = state.companies.map(safeCompany);
        if (state.selectedCompany) state.selectedCompany = safeCompany(state.selectedCompany);
      }
      if (state.online) {
        if (state.currentUser) {
          this.refreshWorkspace({ directory: true, sync: true, silent: true })
            .catch((e) => this.notify(e.message, "warning"));
        } else this.loadSession();
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      this.refreshIfStale().catch((e) => { state.dataError = e.message; });
    };
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    state.online = navigator.onLine;
    api("/tenant-context").then(async context=>{
      state.tenantContext=context;state.tenantInvalid=false;
      if(context.redirectTo){const target=new URL(context.redirectTo);target.pathname=location.pathname;target.search=location.search;location.replace(target.href);return;}
      if(location.pathname==="/session-handoff"){
        const token=new URLSearchParams(location.hash.slice(1)).get("token");if(!token)throw new Error("handoff_expired");
        await api("/session-handoffs/consume",{method:"POST",body:{token}});history.replaceState({},"","/overview");
      }
      return this.loadSession();
    }).catch(()=>{state.tenantInvalid=true;state.isLoading=false;});
  },
  async refreshIfStale(now = Date.now()) {
    if (!state.online || !state.currentUser)
      return { status: "unavailable", refreshed: false };
    if (lastDataRefreshAt && now - lastDataRefreshAt < DATA_REFRESH_STALE_MS)
      return { status: "fresh", refreshed: false };
    return this.refreshWorkspace({ directory: true, sync: true, silent: true });
  },
  async refreshWorkspace({ directory = false, sync = true, silent = true, verifyActor = true } = {}) {
    if (!state.online || !state.currentUser)
      return { status: "unavailable", refreshed: false };
    const key = [session, state.currentUser.uid, state.selectedCompany?.id || ""].join(":");
    if (workspaceRefreshTask?.key === key) return workspaceRefreshTask.promise;
    const task = { key };
    task.promise = (async () => {
      if (directory)
        await this.startListeners({ hydrate: false, verifyActor, silent });
      const companyId = state.selectedCompany?.id;
      if (!companyId) return { status: "no_company", refreshed: false };
      return this.startCompanyDataListeners(companyId, {
        sync,
        silent,
        verifyActor: directory ? false : verifyActor,
      });
    })().finally(() => {
      if (workspaceRefreshTask === task) workspaceRefreshTask = null;
    });
    workspaceRefreshTask = task;
    return task.promise;
  },
  async startListeners({ hydrate = true, verifyActor = true, silent = false } = {}) {
    const generation = session, request = ++directoryEpoch;
    if (!state.currentUser || !state.online) return;
    const user = verifyActor ? await this.refreshActor() : state.currentUser;
    if (!user || generation !== session || request !== directoryEpoch) return;
    const p = permissionsFor(user);
    const [companies, users] = await Promise.all([
      api("/companies"), p.usersManage ? api("/users") : Promise.resolve([]),
    ]);
    if (generation !== session || request !== directoryEpoch || state.currentUser?.role !== user.role) return;
    state.companies = p.costsRead ? companies : stripConfidential(companies);
    state.users = users;
    const chosen = state.tenantContext?.company?.id || state.selectedCompany?.id || localSettings.getItem("myfin-store-" + user.uid);
    const co = state.companies.find(c => c.id === chosen) || (user.role !== "super_admin" ? state.companies[0] : null);
    const hydration = this.selectCompany(co || null, { hydrate, verifyActor: false, silent });
    await localPos.putProfile(user.uid, { user, companies: state.companies, verifiedAt:new Date().toISOString() })
      .catch(() => this.notify("Offline profile could not be saved on this device.", "warning"));
    await hydration;
  },
  selectCompany(company, { hydrate = true, verifyActor = true, silent = false } = {}) {
    if (company && !state.companies.some((c) => c.id === company.id)) return;
    const changed = company?.id !== state.selectedCompany?.id;
    if (changed) this.clearCompany();
    state.selectedCompany = company;
    let device={};try{device=JSON.parse(localSettings.getItem("myfin-device-preferences-"+company?.id)||"{}");}catch{}
    state.preferences = { theme: "light", ...(company?.preferences || {}), ...device };
    if (company)
      localSettings.setItem("myfin-store-" + state.currentUser.uid, company.id);
    else if (state.currentUser)
      localSettings.removeItem("myfin-store-" + state.currentUser.uid);
    if (changed && company && hydrate)
      return this.startCompanyDataListeners(company.id, { verifyActor, silent });
  },
  async switchCompany(company){
    if(!company)return this.selectCompany(null);
    const current=location.hostname.toLowerCase();
    if(company.hostname&&company.hostname.toLowerCase()!==current){
      try{const result=await api("/session-handoffs",{method:"POST",body:{targetHostname:company.hostname.toLowerCase()}});location.assign(result.url);return;}
      catch(error){this.notify(error.message,"error");return;}
    }
    return this.selectCompany(company);
  },
  async startCompanyDataListeners(companyId, { sync = true, silent = false, verifyActor = true } = {}) {
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
    let syncResult = { status: "skipped", attempted: 0, synced: 0, pending: state.pendingSales.length };
    let dataResult = { status: "offline", refreshed: false };
    if (state.online) {
      if (sync)
        syncResult = await this.syncSales({ refresh: false, feedback: false, verifyActor });
      dataResult = await this.refreshData({ silent });
    }
    return { status: dataResult.status, refreshed: dataResult.refreshed, sync: syncResult };
  },
  async refreshData({ silent = false } = {}) {
    const uid = state.currentUser?.uid,
      co = state.selectedCompany?.id,
      generation = companyEpoch,
      actorRole = state.currentUser?.role;
    if (!uid || !co || !state.online)
      return { status: "unavailable", refreshed: false };
    const key = [session, generation, uid, co, actorRole].join(":");
    if (dataRefreshTask?.key === key && silent) {
      return dataRefreshTask.promise;
    }
    const request = ++refreshEpoch, task = { key, blocking: !silent };
    if (task.blocking) state.dataLoading = true;
    task.promise = (async () => {
      try {
        const names = hydrationCollections(state.currentUser);
        for (const key of ["expenses","activities","stock_movements","stock_items","stock_ledger"]) if (!names.includes(key)) state[key] = [];
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
          return { status: "stale", refreshed: false };
        const permissions = permissionsFor(state.currentUser);
        names.forEach((name, i) => {
          let rows = name === "products" ? values[i].map(normalizeProduct) : values[i];
          if (!permissions.costsRead) rows = stripConfidential(rows);
          if (name === "clients" && !permissions.suppliersRead) rows = rows.filter(c => c.type !== "Supplier");
          state[name] = rows;
        });
        await this.refreshReceiptReviews();
        if (generation !== companyEpoch || request !== refreshEpoch || state.currentUser?.uid !== uid || state.currentUser?.role !== actorRole)
          return { status: "stale", refreshed: false };
        state.fromCache = false;
        state.dataError = "";
        lastDataRefreshAt = Date.now();
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
        return { status: "refreshed", refreshed: true };
      } catch (e) {
        if (e.status === 403 && state.currentUser) await this.refreshActor().catch(() => {});
        if (generation === companyEpoch && request === refreshEpoch) {
          state.fromCache = true;
          state.dataError = e.message;
        }
        return { status: "failed", refreshed: false, error: e.message };
      }
    })().finally(() => {
      if (dataRefreshTask === task) {
        if (task.blocking) state.dataLoading = false;
        dataRefreshTask = null;
      }
    });
    dataRefreshTask = task;
    return task.promise;
  },
  async refreshPostedSales(receipts = []) {
    const uid = state.currentUser?.uid,
      co = state.selectedCompany?.id,
      role = state.currentUser?.role,
      generation = companyEpoch;
    if (!uid || !co || !state.online)
      return { status: "unavailable", refreshed: false };
    const posted = receipts.filter(receipt => receipt?.id && receipt.company_id === co);
    if (!posted.length) return { status: "empty", refreshed: false };
    const current = () => generation === companyEpoch && state.currentUser?.uid === uid &&
      state.currentUser?.role === role && state.selectedCompany?.id === co;
    const visible = permissionsFor(state.currentUser).costsRead ? posted : stripConfidential(posted);
    const seen = new Map(state.transactions.map(receipt => [receipt.id, receipt]));
    for (const receipt of visible) seen.set(receipt.id, { ...receipt, documentState: receipt.documentState || "issued" });
    state.transactions = [...seen.values()];
    if (state.fromCache) return this.refreshData({ silent: true });
    // The checkout response supplies the authoritative receipt. Only product stock
    // (and a customer changed by checkout) needs a fresh catalog read here.
    const request = ++refreshEpoch;
    try {
      const [products, clients] = await Promise.all([
        listAll("/companies/" + encodeURIComponent(co) + "/products"),
        posted.some(receipt => receipt.customerEmail)
          ? listAll("/companies/" + encodeURIComponent(co) + "/clients")
          : Promise.resolve(null),
      ]);
      if (!current() || request !== refreshEpoch) return { status: "stale", refreshed: false };
      const permissions = permissionsFor(state.currentUser);
      const normalized = products.map(normalizeProduct);
      state.products = permissions.costsRead ? normalized : stripConfidential(normalized);
      if (clients) state.clients = permissions.suppliersRead ? clients : clients.filter(client => client.type !== "Supplier");
      state.fromCache = false;
      state.dataError = "";
      await localPos.putCatalog(uid, co, { products: state.products, clients: state.clients })
        .catch(() => this.notify("Offline catalog could not be saved. Keep this device online.", "warning"));
      return { status: "refreshed", refreshed: true };
    } catch (error) {
      if (current() && request === refreshEpoch) {
        state.fromCache = true;
        state.dataError = error.message;
      }
      return { status: "failed", refreshed: false, error: error.message };
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
    if(result.status==="posted"||result.status==="dismissed"){
      await localPos.removeSale(sale.id);
      await this.refreshPending();
      if(result.status==="posted")await this.refreshPostedSales([result.receipt || result.sale || sale]);
    }
    await this.refreshReceiptReviews();
    return result;
  },
  async requestReceiptDismissal(sale) {
    if (!state.online || !this.can("checkout") || sale.cashierId !== state.currentUser?.uid || sale.company_id !== state.selectedCompany?.id)
      throw new Error("Reconnect as the original cashier in this workspace to request payment dismissal.");
    const result = await api("/companies/" + encodeURIComponent(sale.company_id) + "/receipt-dismissal-requests", {
      method:"POST", body:{sale:checkoutPayload(sale)},
    });
    if(result.status === "posted" || result.status === "dismissed") {
      await localPos.removeSale(sale.id);
      await this.refreshPending();
      if(result.status === "posted")await this.refreshPostedSales([result.receipt || result.sale || sale]);
    }
    await this.refreshReceiptReviews();
    return result;
  },
  async preserveUnconfirmedSale(sale, error) {
    await localPos.putSale({...sale, syncError:error.message});
    if(error.status===409&&error.message==="receipt_dismissed"){
      try{
        const review=await this.requestReceiptDismissal(sale);
        if(review.status==="dismissed"){
          await localPos.removeSale(sale.id);
          return {resolved:true,status:"dismissed"};
        }
      }catch{/* Keep the original paid receipt until the server confirms its terminal state. */}
      return {resolved:false,status:"review_required",reviewRequested:false};
    }
    if (error.status === 409 && needsReceiptReview(error)) {
      // The queue remains the recovery authority until checkout confirms this ID.
      // Review submission may itself fail after committing; retry is idempotent.
      try {
        const review = await this.requestReceiptReview(sale);
        if (review.status === "posted" || review.status === "dismissed") {
          await localPos.removeSale(sale.id);
          return { resolved: true, status: review.status, receipt: review.receipt };
        }
        return { resolved: false, status: "review_required", reviewRequested: true };
      } catch {
        return { resolved: false, status: "review_required", reviewRequested: false };
      }
    }
    return { resolved: false, status: error.network ? "network_error" : "failed" };
  },
  async approveReceiptReview(id, reason) {
    if (!state.online || !this.can("receiptReviewsResolve")) throw new Error("An online manager or owner must approve this payment.");
    if (reason.trim().length < 3) throw new Error("Explain why the original recorded payment is approved (at least 3 characters).");
    const co = state.selectedCompany?.id;
    if (!co) throw new Error("Choose a workspace first.");
    const result = await api("/companies/" + encodeURIComponent(co) + "/receipt-reviews/" + encodeURIComponent(id) + "/approve", {
      method:"POST", body:{reason:reason.trim()},
    });
    await this.refreshReceiptReviews();
    await this.refreshPostedSales([result.receipt]);
    return result;
  },
  async dismissReceiptReview(id, reason) {
    if (!state.online || !this.can("receiptReviewsResolve")) throw new Error("An online manager or owner must review this payment.");
    if(reason.trim().length<3)throw new Error("Explain why this recorded payment should not be posted (at least 3 characters).");
    const co=state.selectedCompany?.id;
    if(!co)throw new Error("Choose a workspace first.");
    const result=await api("/companies/"+encodeURIComponent(co)+"/receipt-reviews/"+encodeURIComponent(id)+"/dismiss",{method:"POST",body:{reason:reason.trim()}});
    await this.refreshReceiptReviews();
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
  async syncSales({ refresh = true, feedback = true, verifyActor = true } = {}) {
    const unavailable = reason => ({
      status: reason,
      attempted: 0,
      synced: 0,
      dismissed: 0,
      failed: 0,
      reviewRequired: 0,
      pending: state.pendingSales.length,
      failures: [],
    });
    if (syncing) return unavailable("busy");
    if (!state.online) return unavailable("offline");
    if (!state.currentUser || !state.selectedCompany) return unavailable("unavailable");
    syncing = true;
    state.syncing = true;
    const summary = {
      status: "empty",
      attempted: 0,
      synced: 0,
      dismissed: 0,
      failed: 0,
      reviewRequired: 0,
      pending: state.pendingSales.length,
      failures: [],
    };
    const postedReceipts = [];
    try {
      const actor = verifyActor ? await this.refreshActor() : state.currentUser;
      if (!actor || !state.selectedCompany || !this.can("checkout")) {
        summary.status = "unavailable";
        return summary;
      }
      const uid = actor.uid, companyId = state.selectedCompany.id;
      for (const sale of await localPos.sales(uid, companyId)) {
        if (
          state.currentUser?.uid !== uid ||
          state.selectedCompany?.id !== companyId
        )
          break;
        summary.attempted++;
        try {
          const saved = await confirmSale(sale);
          await localPos.removeSale(sale.id);
          postedReceipts.push(saved);
          summary.synced++;
        } catch (error) {
          const result = await this.preserveUnconfirmedSale(sale, error);
          if (result.resolved) {
            if(result.status==="posted")summary.synced++;
            if(result.status==="dismissed")summary.dismissed++;
          }
          else {
            summary.failed++;
            if (result.status === "review_required") summary.reviewRequired++;
            summary.failures.push({ id: sale.id, status: result.status });
          }
        }
      }
      await this.refreshPending();
      summary.pending = state.pendingSales.length;
      summary.status = !summary.attempted ? "empty" : !summary.pending ? summary.dismissed&& !summary.synced ? "dismissed" : "synced" : summary.reviewRequired ? "review_required" : "pending";
      if (refresh && postedReceipts.length) await this.refreshPostedSales(postedReceipts);
      if (feedback) {
        if (summary.status === "empty") this.notify("No receipts are waiting to sync.");
        else if (summary.status === "synced") this.notify(`${summary.synced} ${summary.synced === 1 ? "receipt" : "receipts"} synced successfully.`);
        else if (summary.status === "dismissed") this.notify(`${summary.dismissed} reviewed ${summary.dismissed===1?"payment was":"payments were"} confirmed as not recorded. The original device queue is now clear.`,"warning");
        else if (summary.reviewRequired)
          this.notify(`${summary.reviewRequired} recorded ${summary.reviewRequired === 1 ? "payment needs" : "payments need"} manager review. ${summary.pending} ${summary.pending === 1 ? "receipt remains" : "receipts remain"} safely saved on this device.`, "warning");
        else
          this.notify(`Sync could not be confirmed. ${summary.pending} paid ${summary.pending === 1 ? "receipt remains" : "receipts remain"} safely saved on this device.`, "warning");
      }
      return summary;
    } catch (error) {
      summary.status = "failed";
      summary.pending = state.pendingSales.length;
      summary.failures.push({ status: error.network ? "network_error" : "failed" });
      if (feedback)
        this.notify(`Sync could not be confirmed. ${summary.pending} paid ${summary.pending === 1 ? "receipt remains" : "receipts remain"} safely saved on this device.`, "warning");
      return summary;
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
        await this.refreshPostedSales([saved]);
        return { ...saved, syncStatus: "synced" };
      } catch (error) {
        const resolution = await this.preserveUnconfirmedSale(sale, error);
        await this.refreshPending();
        if (resolution.resolved) {
          return { ...(resolution.receipt || sale), syncStatus: resolution.status === "dismissed" ? "dismissed" : "synced" };
        }
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
  importExpenses(rows) {
    return financeModule.importExpenses(this, rows);
  },
  deleteExpense(id, approval = {}) {
    return financeModule.deleteExpense(this, id, approval);
  },
  addStockItem(item) { return stockModule.addItem(this,item); },
  updateStockItem(item) { return stockModule.updateItem(this,item); },
  archiveStockItem(id) { return stockModule.archiveItem(this,id); },
  recordStockMovement(itemId,movement) { return stockModule.move(this,itemId,movement); },
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
    return ["super_admin", "workspace_owner", "manager"].includes(state.currentUser?.role);
  },
  updatePreferences(prefs) {
    return companiesModule.updatePreferences(this, prefs);
  },
  saveCompanyStyle(style) {
    return this.updatePreferences(style);
  },
});
