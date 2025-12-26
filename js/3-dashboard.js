// js/3-dashboard.js
const DashboardManager = {
    template: '#dashboard-template',
    data() {
        return {
            currentTab: 'overview', 
            
            // Forms & State
            clientModal: false,
            clientForm: {},
            financeView: 'list',
            financeFilter: 'all', 
            txForm: { items: [], history: [] },
            
            // Validation State
            validationErrors: {}, 

            // Settings State
            tempPrefs: { theme: 'light', docTemplate: 'clean' },

            // Chart Instance Storage
            chartInstances: {}
        };
    },
    computed: {
        activeCompany() { return Store.state.selectedCompany || {}; },
        clients() { if (!this.activeCompany.id) return []; return Store.state.clients.filter(c => c.company_id === this.activeCompany.id); },
        
        rawTransactions() { 
            if (!this.activeCompany.id) return []; 
            return Store.state.transactions.filter(t => t.company_id === this.activeCompany.id); 
        },

        transactions() {
            return [...this.rawTransactions].sort((a, b) => new Date(b.date) - new Date(a.date));
        },
        
        filteredList() {
            if (this.financeFilter === 'all') return this.transactions;
            if (this.financeFilter === 'expense') {
                return this.transactions.filter(t => t.type === 'Payment Voucher');
            }
            if (this.financeFilter === 'income') {
                return this.transactions.filter(t => t.type === 'Invoice' || t.type === 'Quote');
            }
            return this.transactions;
        },
        
        currentPrefs() { return Store.state.preferences; },

        financials() {
            const cleared = this.rawTransactions
                .filter(t => t.type === 'Invoice' && t.status === 'Cleared')
                .reduce((sum, t) => sum + t.total, 0);

            const pending = this.rawTransactions
                .filter(t => t.type === 'Invoice' && t.status !== 'Cleared')
                .reduce((sum, t) => sum + t.total, 0);

            const forecast = this.rawTransactions
                .filter(t => t.type === 'Quote' && t.status !== 'Rejected')
                .reduce((sum, t) => sum + t.total, 0);
            
            const expenses = this.rawTransactions
                .filter(t => t.type === 'Payment Voucher')
                .reduce((sum, t) => sum + t.total, 0);
            
            return { cleared, pending, forecast, expenses };
        },

        subtotal() { if(!this.txForm.items) return 0; return this.txForm.items.reduce((sum, item) => sum + (item.qty * item.price), 0); },
        taxAmount() { return this.subtotal * ((this.txForm.taxRate || 0) / 100); },
        grandTotal() { return this.subtotal + this.taxAmount; },
        documentTitle() { return this.txForm.type === 'Payment Voucher' ? 'PAYMENT VOUCHER' : this.txForm.type; },
        partyLabel() { return this.txForm.type === 'Payment Voucher' ? 'Pay To (Supplier):' : 'Bill To (Client):'; },

        canConvert() { return this.txForm.id && this.txForm.type === 'Quote' && this.txForm.status !== 'Converted'; }
    },
    created() {
        this.resetTransactionForm();
        this.tempPrefs = { ...Store.state.preferences }; 
        this.applyTheme(this.tempPrefs.theme);
    },
    methods: {
        logout() { Store.logout(); },
        
        switchTab(tab) {
            this.currentTab = tab;
            if (tab === 'overview') {
                setTimeout(this.renderCharts, 100); 
            }
        },

        renderCharts() {
            if (this.chartInstances.income) this.chartInstances.income.destroy();
            if (this.chartInstances.expense) this.chartInstances.expense.destroy();

            const invCleared = this.rawTransactions.filter(t => t.type === 'Invoice' && t.status === 'Cleared').length;
            const invPending = this.rawTransactions.filter(t => t.type === 'Invoice' && t.status !== 'Cleared').length;
            const quotes = this.rawTransactions.filter(t => t.type === 'Quote').length;

            const incomeCtx = document.getElementById('incomeChart');
            if (incomeCtx) {
                this.chartInstances.income = new Chart(incomeCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Cleared (Cash)', 'Pending (Due)', 'Forecast (Quotes)'],
                        datasets: [{
                            data: [invCleared, invPending, quotes],
                            backgroundColor: ['#10b981', '#fbbf24', '#3b82f6']
                        }]
                    }
                });
            }

            const expPaid = this.rawTransactions.filter(t => t.type === 'Payment Voucher' && t.status === 'Paid').length;
            const expPending = this.rawTransactions.filter(t => t.type === 'Payment Voucher' && t.status === 'Pending').length;

            const expenseCtx = document.getElementById('expenseChart');
            if (expenseCtx) {
                this.chartInstances.expense = new Chart(expenseCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Paid', 'Pending'],
                        datasets: [{
                            data: [expPaid, expPending],
                            backgroundColor: ['#ef4444', '#f87171']
                        }]
                    }
                });
            }
        },

        saveSettings() { Store.updatePreferences(this.tempPrefs); this.applyTheme(this.tempPrefs.theme); Store.notify("Settings Saved!"); },
        applyTheme(theme) {
            const html = document.documentElement;
            const isDark = theme === 'dark' || (theme === 'auto' && new Date().getHours() >= 19) || (theme === 'auto' && new Date().getHours() < 7);
            if (isDark) html.classList.add('dark'); else html.classList.remove('dark');
        },

        newClient() { 
            this.clientForm = { id: null, company_id: this.activeCompany.id, name: '', phone: '', type: 'Client' }; 
            this.clientModal = true; 
        },
        saveClient() { 
            if(!this.clientForm.name) return Store.notify("Name is required", 'error'); 
            
            if(!this.clientForm.id) { 
                this.clientForm.id = Date.now(); 
                Store.state.clients.push(this.clientForm); 
            } 
            Store.save(); 
            this.clientModal = false; 
            Store.notify("Contact Saved");
        },

        resetTransactionForm() { 
            const coId = this.activeCompany.id || 'TEMP'; 
            this.txForm = { 
                id: null, 
                company_id: coId, 
                client_id: '', 
                category: 'Income', 
                type: 'Quote', 
                number: 'QT-' + Date.now().toString().slice(-6), 
                date: new Date().toISOString().split('T')[0], 
                status: 'Pending', 
                items: [{ desc: 'Service / Item', unit: 'Unit', qty: 1, price: 0 }], 
                taxRate: 0, 
                notes: 'Valid for 14 days.',
                history: [] 
            }; 
            this.validationErrors = {}; 
        },
        
        openEditor(tx = null) { 
            if (tx) { this.txForm = JSON.parse(JSON.stringify(tx)); } 
            else { this.resetTransactionForm(); } 
            
            if (!this.txForm.history) this.txForm.history = [];
            this.validationErrors = {}; 
            this.financeView = 'editor'; 
        },

        setDocType(type) { 
            this.txForm.type = type; 
            if (type === 'Payment Voucher') { 
                this.txForm.category = 'Expense'; 
                this.txForm.number = 'PV-' + Date.now().toString().slice(-6); 
                this.txForm.notes = 'Payment for services/goods.'; 
                this.txForm.status = 'Pending'; 
            } else if (type === 'Quote') { 
                this.txForm.category = 'Income'; 
                this.txForm.number = 'QT-' + Date.now().toString().slice(-6); 
                this.txForm.notes = 'Quote valid for 30 days.'; 
                this.txForm.status = 'Pending';
            } else if (type === 'Purchase Order') {
                this.txForm.category = 'Internal';
                this.txForm.number = 'PO-' + Date.now().toString().slice(-6);
                this.txForm.notes = 'Internal Delivery Order';
                this.txForm.status = 'Not Delivered';
            } else { 
                this.txForm.category = 'Income'; 
                this.txForm.number = 'INV-' + Date.now().toString().slice(-6); 
                this.txForm.notes = 'Thank you for your business.'; 
                this.txForm.status = 'Pending';
            } 
        },

        addItem() { this.txForm.items.push({ desc: '', unit: 'Unit', qty: 1, price: 0 }); },
        removeItem(index) { this.txForm.items.splice(index, 1); },
        
        // --- FIXED SAVE LOGIC ---
        saveTx(arg = null) { 
            // FIX: Differentiate between a DOM Event (from button click) and a Transaction Object (from list status change)
            // If the argument has an '.id' property, it is a transaction object from the list.
            // Otherwise (if it's null or a MouseEvent), we use the Editor's form data.
            let isListUpdate = arg && arg.id; 
            let target = isListUpdate ? arg : this.txForm;
            
            let isNew = !target.id;
            
            // 1. Validation Logic
            this.validationErrors = {}; // Reset errors
            
            // Validate Client (Mandatory)
            if (!target.client_id) {
                // Only mark UI error if we are using the editor form
                if (target === this.txForm) {
                    this.validationErrors.client_id = true;
                }
                Store.notify("Please select a Party/Contact", 'error');
                return; // Stop execution
            }

            // 2. Logic & History (Only runs if valid)
            let oldStatus = null;
            if (!isListUpdate) target.total = this.grandTotal;

            if (!isNew) {
                const existing = Store.state.transactions.find(t => t.id === target.id);
                if (existing) oldStatus = existing.status;
            }

            if (!target.history) target.history = [];
            
            if (isNew) {
                target.history.push({ date: Date.now(), status: target.status, note: 'Document Created' });
            } else if (oldStatus !== target.status) {
                target.history.push({ date: Date.now(), status: target.status, note: `Status changed from ${oldStatus}` });
            }

            // 3. Save
            if (isNew) Store.addTransaction(target);
            else Store.updateTransaction(target);

            Store.notify("Document Saved Successfully");
            
            // If we were in the editor, go back to list
            if (!isListUpdate) this.financeView = 'list';
        },
        
        deleteTx(id) { 
            if(confirm("Delete this record?")) {
                Store.deleteTransaction(id); 
                Store.notify("Record Deleted");
            }
        },
        printTx() { window.print(); },
        getClientName(id) { const c = this.clients.find(x => x.id === id); return c ? c.name : 'Unknown Party'; },

        convertQuote() {
            if(!confirm("Accept Quote? This will generate an Invoice and PO.")) return;
            
            if(!this.txForm.history) this.txForm.history = [];
            this.txForm.history.push({ date: Date.now(), status: 'Converted', note: 'Quote Accepted & Converted' });
            this.txForm.status = 'Converted';
            Store.updateTransaction(this.txForm);

            const newInvoice = JSON.parse(JSON.stringify(this.txForm));
            newInvoice.id = Date.now();
            newInvoice.type = 'Invoice';
            newInvoice.number = 'INV-' + Date.now().toString().slice(-5);
            newInvoice.status = 'Pending'; 
            newInvoice.history = [{ date: Date.now(), status: 'Pending', note: 'Generated from Quote ' + this.txForm.number }];
            newInvoice.date = new Date().toISOString().split('T')[0];
            Store.addTransaction(newInvoice);

            const newPO = JSON.parse(JSON.stringify(this.txForm));
            newPO.id = Date.now() + 1; 
            newPO.type = 'Purchase Order';
            newPO.number = 'PO-' + Date.now().toString().slice(-5);
            newPO.status = 'Not Delivered';
            newPO.history = [{ date: Date.now(), status: 'Not Delivered', note: 'Generated from Quote ' + this.txForm.number }];
            newPO.notes = 'Internal Delivery / Work Order';
            Store.addTransaction(newPO);

            Store.notify("Success! Invoice & PO Created");
            this.financeView = 'list';
        },

        getAgingStatus(t) {
            if (t.type !== 'Invoice' || t.status === 'Cleared') return { color: 'bg-gray-200 dark:bg-slate-700', text: 'Normal', width: '0%' };
            const today = new Date();
            const txDate = new Date(t.date);
            const diffTime = Math.abs(today - txDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays > 30) return { color: 'bg-red-500', text: 'DUE (>30 Days)', width: '100%' };
            else if (diffDays > 14) return { color: 'bg-yellow-500', text: 'Pending (>14 Days)', width: '50%' };
            else return { color: 'bg-emerald-500', text: 'Standard', width: '25%' };
        },

        downloadRowPDF(t) {
            this.openEditor(t);
            this.$nextTick(() => {
                const element = document.getElementById('invoice-print-area');
                const opt = {
                    margin: 0, filename: `${t.number}.pdf`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true },
                    jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
                };
                html2pdf().set(opt).from(element).save();
            });
        }
    }
};