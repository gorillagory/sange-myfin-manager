// js/2-company.js
const CompanyManager = {
    template: '#company-template', // Links to HTML
    data() {
        return {
            showModal: false,
            isEditing: false,
            form: this.getEmptyForm()
        };
    },
    computed: {
        companies() { return Store.state.companies; }
    },
    methods: {
        getEmptyForm() {
            return {
                id: null,
                systemId: 'CMP-' + Math.floor(Math.random() * 10000),
                name: '', regNo: '', phone: '',
                address1: '', postcode: '', state: 'Selangor', country: 'Malaysia',
                bankName: 'Maybank', accNo: '', logo: null
            };
        },
        openModal(company = null) {
            this.isEditing = !!company;
            this.form = company ? JSON.parse(JSON.stringify(company)) : this.getEmptyForm();
            this.showModal = true;
        },
        save() {
            if (!this.form.name) return alert("Company Name Required");
            
            if (this.isEditing) Store.updateCompany(this.form);
            else Store.addCompany(this.form);
            
            this.showModal = false;
        },
        remove(id) {
            if (confirm("Delete this company and all its data?")) Store.deleteCompany(id);
        },
        select(company) {
            Store.selectCompany(company);
        },
        handleLogo(e) {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (res) => { this.form.logo = res.target.result; };
                reader.readAsDataURL(file);
            }
        }
    }
};