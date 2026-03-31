let fireDB = null;
let fbApp = null;
let fsAPI = null;

// Pseudo-Dexie Wrapper for easy Firebase compat utilizing dynamic Modular SDK
function makeFireDB(col) {
    return {
        toArray: async () => {
            const snap = await fsAPI.getDocs(fsAPI.collection(fireDB, col));
            return snap.docs.map(d => ({ id: d.id, ...d.data() }));
        },
        add: async (data) => {
            const ref = await fsAPI.addDoc(fsAPI.collection(fireDB, col), data);
            return ref.id;
        },
        bulkAdd: async (list) => {
            const batch = fsAPI.writeBatch(fireDB);
            for (let i of list) {
                batch.set(fsAPI.doc(fsAPI.collection(fireDB, col)), i);
            }
            await batch.commit();
        },
        update: async (id, data) => {
            if (!id) return;
            await fsAPI.updateDoc(fsAPI.doc(fireDB, col, id.toString()), data);
        },
        delete: async (id) => {
            if (!id) return;
            await fsAPI.deleteDoc(fsAPI.doc(fireDB, col, id.toString()));
        },
        get: async (id) => {
            if (!id) return null;
            const docSnap = await fsAPI.getDoc(fsAPI.doc(fireDB, col, id.toString()));
            return docSnap.exists() ? { id: docSnap.id, ...docSnap.data() } : null;
        }
    };
}

const dbWrapper = {
    services: makeFireDB('services'),
    inventory: makeFireDB('inventory'),
    moneybook: makeFireDB('moneybook'),
    orders: {
        ...makeFireDB('orders'), orderBy: (field) => ({
            reverse: () => ({
                toArray: async () => {
                    const q = fsAPI.query(fsAPI.collection(fireDB, 'orders'), fsAPI.orderBy(field, 'desc'));
                    const snap = await fsAPI.getDocs(q);
                    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
                }
            })
        })
    },
    photobooth: {
        ...makeFireDB('photobooth'), where: (field) => ({
            equals: (val) => ({
                toArray: async () => {
                    const q = fsAPI.query(fsAPI.collection(fireDB, 'photobooth'), fsAPI.where(field, '==', val));
                    const snap = await fsAPI.getDocs(q);
                    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
                }
            })
        })
    },
    events: {
        ...makeFireDB('events'),
        orderBy: (field) => ({
            toArray: async () => {
                const q = fsAPI.query(fsAPI.collection(fireDB, 'events'), fsAPI.orderBy(field, 'asc'));
                const snap = await fsAPI.getDocs(q);
                return snap.docs.map(d => ({ id: d.id, ...d.data() }));
            }
        }),
        where: (field) => ({
            aboveOrEqual: (val) => ({
                toArray: async () => {
                    const q = fsAPI.query(fsAPI.collection(fireDB, 'events'), fsAPI.where(field, '>=', val));
                    const snap = await fsAPI.getDocs(q);
                    let arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                    arr.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));
                    return arr;
                }
            })
        })
    },
    delete: async () => {
        const stores = ['services', 'orders', 'events', 'photobooth', 'inventory', 'moneybook'];
        for (let s of stores) {
            const snap = await fsAPI.getDocs(fsAPI.collection(fireDB, s));
            const batch = fsAPI.writeBatch(fireDB);
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }
};

const db = dbWrapper; // Single source of truth securely attached to Firebase API

// ====== GOOGLE SHEETS BACKUP CONFIG ======
// Paste your Google Apps Script Web App URL here inside the quotes
const GOOGLE_SHEET_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbzuOkGh2hYr0Rk7P7NQN6FnDCxcEI0J6U93DO1V--34rJRFRQsbz3LNcWteK1vWChAu/exec";

async function backupToGoogleSheets(orderData) {
    if (!GOOGLE_SHEET_WEB_APP_URL || GOOGLE_SHEET_WEB_APP_URL.trim() === "") return;

    let itemsStr = "";
    if (orderData.items && Array.isArray(orderData.items)) {
        itemsStr = orderData.items.map(i => {
            let name = i.name || i.size || 'Item';
            let qty = i.qty || i.prints || 1;
            return `${name}(x${qty})`;
        }).join(', ');
    }

    const d = new Date(orderData.date || orderData.timestamp || new Date());

    const params = new URLSearchParams({
        date: d.toLocaleDateString(),
        time: d.toLocaleTimeString(),
        billNo: orderData.billNo,
        type: (orderData.type || 'unknown').toUpperCase(),
        customer: orderData.customerName || orderData.phone || 'Walk-in',
        items: itemsStr,
        subtotal: orderData.subtotalAmount || orderData.totalAmount || orderData.total || 0,
        discount: orderData.discountAmount || 0,
        total: orderData.totalAmount || orderData.total || 0,
        paymentStatus: orderData.paymentStatus || 'Paid',
        advance: orderData.advanceAmount || 0,
        contact: orderData.customerPhone || orderData.phone || 'N/A'
    });

    try {
        await fetch(GOOGLE_SHEET_WEB_APP_URL, {
            method: 'POST',
            mode: 'no-cors',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString()
        });
        console.log("Backed up to Google Sheets.");
    } catch (e) {
        console.error("Failed to backup to Google Sheets", e);
    }
}

// App State
let currentShopCart = [];
let currentBoothCart = [];
let shopCurrentBillNo = '';
let boothCurrentBillNo = '';
let albumCurrentBillNo = '';
let dashboardChart = null;

let allShopItems = [];
let allBills = [];

let editInvId = null;
let editSvcId = null;
let currentUserRole = 'admin'; // 'admin' or 'reports'

// Initial Setup
window.onload = async () => {
    // Show login overlay initially
    document.getElementById('login-overlay').classList.remove('hide');

    try {
        fbApp = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js");
        fsAPI = await import("https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js");

        const firebaseConfig = {
            apiKey: "AIzaSyAHnA0mvGRqpE1fVX4jeiAbSPdx9cb5qWE",
            authDomain: "passionpixel-74235.firebaseapp.com",
            projectId: "passionpixel-74235",
            storageBucket: "passionpixel-74235.firebasestorage.app",
            messagingSenderId: "271207746051",
            appId: "1:271207746051:web:182433a3fe926bb9039c36"
        };
        const app = fbApp.initializeApp(firebaseConfig);
        fireDB = fsAPI.getFirestore(app);
    } catch (err) {
        console.error("Firebase module loading error:", err);
    }

    generateShopBillNo();
    generateBoothBillNo();
    generateAlbumBillNo();
    await loadServices();
    await loadDashboardStats();
    await loadUpcomingEvents();
    await loadCalendarEvents();
    await loadInventory();
    await loadBills();
    await checkMoneybookCleanup();
};

// ==========================================
// AUTO CLEANUP CYCLE -> MONEYBOOK
// ==========================================
async function checkMoneybookCleanup() {
    try {
        const today = new Date();
        const currentDay = today.getDate();
        
        // Month to explicitly notify about (e.g. if we are in April, we notify about January)
        const deleteMonthName = new Date(today.getFullYear(), today.getMonth() - 3, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

        // Cutoff: 1st day of the month, 2 months ago (to strictly grab all records from the targeted month and older).
        // If today is April (index 3), cutoff is Feb 1st (index 1). Thus, anything BEFORE Feb 1st (Jan and older) is deleted.
        const cutoffDate = new Date(today.getFullYear(), today.getMonth() - 2, 1);
        const cutoffTimestamp = cutoffDate.getTime();
        
        const mbRecords = await db.moneybook.toArray();
        if(!mbRecords || mbRecords.length === 0) return;
        
        const oldRecords = mbRecords.filter(r => {
            if (!r.date) return false;
            const rDate = new Date(r.date).getTime();
            return rDate < cutoffTimestamp;
        });

        if (oldRecords.length > 0) {
            if (currentDay === 1) {
                // Notice to download on 1st day
                setTimeout(() => {
                    Swal.fire({
                        title: 'Storage Cleanup Notice 🧹',
                        html: `<p class="text-gray-300">Your Moneybook records for <b>${deleteMonthName}</b> and older are marked for cleanup.</p><br><p class="text-sm text-brand font-bold bg-brand/10 p-3 rounded-lg border border-brand/20">Please Export & Download your Moneybook report today. Data for ${deleteMonthName} will be automatically deleted tomorrow to save database storage space!</p><br><p class="text-xs text-gray-500">*Note: Deleting these will not affect P&L or Inventory items.</p>`,
                        icon: 'warning',
                        confirmButtonText: 'Download Now',
                        showCancelButton: true,
                        cancelButtonText: 'Dismiss',
                        background: '#1e293b',
                        color: '#fff',
                        confirmButtonColor: '#10b981',
                        cancelButtonColor: '#334155'
                    }).then((result) => {
                        if(result.isConfirmed) {
                            switchTab('moneybook');
                            downloadMoneyBookReport();
                        }
                    });
                }, 1500); 
            } else if (currentDay >= 2) {
                // Auto Delete on 2nd day (or later if missed)
                console.log(`Auto-cleaning ${oldRecords.length} old moneybook records from ${deleteMonthName}...`);
                for(let record of oldRecords) {
                    await db.moneybook.delete(record.id);
                }
                console.log(`Successfully deleted ${oldRecords.length} old moneybook records.`);
                
                showToast(`Old Money Book records for ${deleteMonthName} cleaned!`, 'info');
                
                // If they happen to be on moneybook tab, refresh quietly
                const mbTab = document.getElementById('view-moneybook');
                if(mbTab && !mbTab.classList.contains('hide')) {
                    if (typeof loadMoneyBook === 'function') {
                        loadMoneyBook();
                    }
                }
            }
        }
    } catch(err) {
        console.error("Error during Moneybook cleanup check:", err);
    }
}

// ==========================================
// AUTHENTICATION
// ==========================================
function handleLogin() {
    const pwd = document.getElementById('login-password').value;
    if (pwd === 'admin@123') {
        currentUserRole = 'admin';
        document.getElementById('login-overlay').classList.add('hide');
        document.getElementById('user-role-text').innerText = 'Admin';

        // Show all nav items
        ['nav-dashboard', 'nav-shop', 'nav-photobooth', 'nav-calendar', 'nav-services', 'nav-album', 'nav-moneybook'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('hide');
        });

        switchTab('dashboard'); // default
        showToast('Login Successful!', 'success');
    } else if (pwd === 'reports@123') {
        currentUserRole = 'reports';
        document.getElementById('login-overlay').classList.add('hide');
        document.getElementById('user-role-text').innerText = 'Reports Admin';

        // Hide specific nav items (allow dashboard)
        ['nav-shop', 'nav-photobooth', 'nav-calendar', 'nav-services', 'nav-album', 'nav-moneybook'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.add('hide');
        });

        switchTab('dashboard'); // default for reports
        showToast('Logged in as Reports Admin!', 'success');
    } else {
        showToast('Invalid Password!', 'error');
    }
}

function logout() {
    currentUserRole = 'admin';
    document.getElementById('login-overlay').classList.remove('hide');
    document.getElementById('login-password').value = '';

    // Reset nav items to visible for next login
    ['nav-dashboard', 'nav-shop', 'nav-photobooth', 'nav-calendar', 'nav-services', 'nav-album', 'nav-moneybook'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('hide');
    });

    showToast('Logged out.', 'info');
}

async function requireAdminAuth(callback) {
    const { value: password } = await Swal.fire({
        title: 'Admin Password Required',
        input: 'password',
        inputPlaceholder: 'Enter admin password',
        inputAttributes: {
            autocapitalize: 'off',
            autocorrect: 'off'
        },
        showCancelButton: true,
        confirmButtonColor: '#f43f5e',
        cancelButtonColor: '#1e293b',
        background: '#1e293b',
        color: '#fff'
    });

    if (password === 'Passion@123344') {
        callback();
    } else if (password !== undefined) {
        showToast('Incorrect Admin Password!', 'error');
    }
}

// ==========================================
// NAVIGATION
// ==========================================
function toggleSidebar() {
    const sb = document.getElementById('sidebar-menu');
    if (sb) sb.classList.toggle('-translate-x-full');
}

function switchTab(tabId) {
    // Hide all views
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hide'));
    // Show selected view
    document.getElementById(`view-${tabId}`).classList.remove('hide');

    // Update active nav button styles
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('text-white', 'bg-gray-800');
        btn.classList.add('text-gray-400');
    });

    const activeBtn = document.getElementById(`nav-${tabId}`);
    if (activeBtn) {
        activeBtn.classList.add('text-white', 'bg-gray-800');
        activeBtn.classList.remove('text-gray-400');
    }

    if (tabId === 'dashboard') loadDashboardStats();
    if (tabId === 'inventory') loadInventory();
    if (tabId === 'reports') loadBills();
    if (tabId === 'moneybook') loadMoneyBook();

    // Auto-close sidebar on mobile
    if (window.innerWidth < 1024) {
        const sb = document.getElementById('sidebar-menu');
        if (sb && !sb.classList.contains('-translate-x-full')) {
            sb.classList.add('-translate-x-full');
        }
    }
}

// ==========================================
// UTILS
// ==========================================
function generateBillNo(prefix) {
    return prefix + '-' + Math.floor(100000 + Math.random() * 900000);
}

function formatCurrency(amount) {
    return 'Rs. ' + Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2 });
}

function showToast(title, icon = 'success') {
    if (typeof Swal !== 'undefined') {
        Swal.fire({
            toast: true,
            position: 'top-end',
            icon: icon,
            title: title,
            showConfirmButton: false,
            timer: 3000,
            timerProgressBar: true,
            background: '#1e293b',
            color: '#fff'
        });
    } else {
        alert(title);
    }
}

// ==========================================
// SERVICES MANAGEMENT
// ==========================================
async function loadServices() {
    const services = await db.services.toArray();
    const inventory = await db.inventory.toArray();

    const datalist = document.getElementById('shop-item-datalist');
    if (datalist) datalist.innerHTML = '';
    allShopItems = [];

    services.forEach(svc => {
        allShopItems.push({ id: `svc_${svc.id}`, name: svc.name, price: svc.price, type: 'service', dbId: svc.id });
        if (datalist) {
            const opt = document.createElement('option');
            opt.value = svc.name;
            datalist.appendChild(opt);
        }
    });

    inventory.forEach(inv => {
        const catLabel = inv.category ? `[${inv.category}] ` : '';
        const labelName = `${catLabel}${inv.name}`;
        const finalPrice = inv.sellPrice !== undefined ? inv.sellPrice : inv.unitCost;
        allShopItems.push({ id: `inv_${inv.id}`, name: labelName, price: finalPrice, type: 'inventory', dbId: inv.id, actualName: inv.name });
        if (datalist) {
            const opt = document.createElement('option');
            opt.value = labelName;
            datalist.appendChild(opt);
        }
    });

    const list = document.getElementById('services-list');
    list.innerHTML = '';
    services.forEach(svc => {
        const li = document.createElement('li');
        li.className = 'flex justify-between items-center p-3 bg-gray-800/50 border border-gray-700 rounded-lg text-sm';
        li.innerHTML = `
            <span class="text-gray-200">${svc.name}</span>
            <div class="flex items-center gap-4">
                <span class="text-brand font-medium">${formatCurrency(svc.price)}</span>
                <button onclick="editService('${svc.id}')" class="text-blue-400 hover:text-blue-500"><i class="ph ph-pencil-simple"></i></button>
                <button onclick="deleteService('${svc.id}')" class="text-red-400 hover:text-red-500"><i class="ph ph-trash"></i></button>
            </div>
        `;
        list.appendChild(li);
    });
}

async function addService() {
    const name = document.getElementById('svc-name').value.trim();
    const price = parseFloat(document.getElementById('svc-price').value);

    if (!name || isNaN(price) || price < 0) {
        showToast('Valid Name and Price required', 'error');
        return;
    }

    if (editSvcId) {
        await db.services.update(editSvcId, { name, price });
        editSvcId = null;
        document.getElementById('svc-submit-btn').innerText = 'Add Service';
        document.getElementById('svc-cancel-btn').classList.add('hide');
        showToast('Service Updated');
    } else {
        await db.services.add({ name, price });
        showToast('Service Added');
    }

    document.getElementById('svc-name').value = '';
    document.getElementById('svc-price').value = '';
    await loadServices();
}

async function editService(id) {
    const svc = await db.services.get(id);
    if (svc) {
        document.getElementById('svc-name').value = svc.name;
        document.getElementById('svc-price').value = svc.price;
        editSvcId = id;
        document.getElementById('svc-submit-btn').innerText = 'Update Service';
        document.getElementById('svc-cancel-btn').classList.remove('hide');
        document.getElementById('svc-name').focus();
    }
}

function cancelServiceEdit() {
    editSvcId = null;
    document.getElementById('svc-name').value = '';
    document.getElementById('svc-price').value = '';
    document.getElementById('svc-submit-btn').innerText = 'Add Service';
    document.getElementById('svc-cancel-btn').classList.add('hide');
}

async function deleteService(id) {
    if (confirm('Are you sure you want to delete this service?')) {
        await db.services.delete(id);
        showToast('Service Deleted', 'info');
        await loadServices();
    }
}

// ==========================================
// INVENTORY MANAGEMENT
// ==========================================
async function loadInventory() {
    const items = await db.inventory.toArray();
    
    // Populating Category Datalist
    const categories = [...new Set(items.map(i => i.category).filter(c => c))];
    const datalist = document.getElementById('inv-category-list');
    if (datalist) {
        datalist.innerHTML = categories.map(c => `<option value="${c}">`).join('');
    }
    
    renderInventoryTable(items);
}

function renderInventoryTable(items) {
    const tbody = document.getElementById('inventory-list-tbody');
    tbody.innerHTML = '';

    if (items.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-gray-500 italic">No items found.</td></tr>`;
        return;
    }

    const grouped = {};
    items.forEach(item => {
        const cat = item.category || 'Uncategorized';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(item);
    });

    Object.keys(grouped).forEach(cat => {
        const catId = cat.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        const catRows = grouped[cat];
        
        let catTotalValue = 0;
        catRows.forEach(item => {
            const buyPrice = item.buyPrice !== undefined ? item.buyPrice : (item.unitCost || 0);
            catTotalValue += item.qty * buyPrice;
        });

        const trCat = document.createElement('tr');
        trCat.className = 'border-b border-gray-700 bg-gray-800/80 cursor-pointer hover:bg-gray-700 transition-colors';
        trCat.onclick = () => window.toggleInventoryCategory(catId);
        trCat.innerHTML = `
            <td colspan="5" class="py-3 px-4 text-white font-bold">
                <div class="flex items-center gap-3">
                    <i class="ph ph-plus-square text-brand text-xl" id="icon-${catId}"></i>
                    ${cat} <span class="text-sm font-normal text-gray-400">(${catRows.length} items)</span>
                </div>
            </td>
            <td class="py-3 text-right text-gray-400 font-bold">${formatCurrency(catTotalValue)}</td>
            <td></td>
        `;
        tbody.appendChild(trCat);

        catRows.forEach(item => {
            const buyPrice = item.buyPrice !== undefined ? item.buyPrice : (item.unitCost || 0);
            const sellPrice = item.sellPrice || 0;
            const totalValue = item.qty * buyPrice;
            const tr = document.createElement('tr');
            tr.className = `border-b border-gray-800/50 text-gray-300 hide cat-row-${catId} bg-gray-900/40`;
            tr.innerHTML = `
                <td class="py-3 pl-12 text-gray-400 font-medium">${item.category || '-'}</td>
                <td class="py-3">${item.name}</td>
                <td class="py-3 text-center font-medium">${item.qty}</td>
                <td class="py-3 text-right">${formatCurrency(buyPrice)}</td>
                <td class="py-3 text-right text-brand">${formatCurrency(sellPrice)}</td>
                <td class="py-3 text-right text-gray-400">${formatCurrency(totalValue)}</td>
                <td class="py-3 text-right">
                    <button onclick="editInventoryItem('${item.id}'); event.stopPropagation();" class="text-blue-400 hover:text-blue-500 transition-colors p-2"><i class="ph ph-pencil-simple text-lg"></i></button>
                    <button onclick="promptDeleteInventory('${item.id}'); event.stopPropagation();" class="text-gray-500 hover:text-red-500 transition-colors p-2"><i class="ph ph-trash text-lg"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    });
}

window.toggleInventoryCategory = function(catId) {
    const rows = document.querySelectorAll('.cat-row-' + catId);
    const icon = document.getElementById('icon-' + catId);
    
    let isHidden = false;
    if(rows.length > 0) {
        isHidden = rows[0].classList.contains('hide');
    }
    
    if(isHidden) {
        rows.forEach(r => r.classList.remove('hide'));
        if(icon) {
            icon.classList.remove('ph-plus-square');
            icon.classList.add('ph-minus-square');
        }
    } else {
        rows.forEach(r => r.classList.add('hide'));
        if(icon) {
            icon.classList.remove('ph-minus-square');
            icon.classList.add('ph-plus-square');
        }
    }
}

async function filterInventory() {
    const term = document.getElementById('inv-search-input').value.toLowerCase();
    const items = await db.inventory.toArray();
    const filtered = items.filter(item => item.name.toLowerCase().includes(term) || (item.category && item.category.toLowerCase().includes(term)));
    renderInventoryTable(filtered);
    
    if (term) {
        const allIcons = document.querySelectorAll('i[id^="icon-"]');
        allIcons.forEach(icon => {
            icon.classList.remove('ph-plus-square');
            icon.classList.add('ph-minus-square');
        });
        const allRows = document.querySelectorAll('tr[class*="cat-row-"]');
        allRows.forEach(r => r.classList.remove('hide'));
    }
}

async function addInventoryItem() {
    const category = document.getElementById('inv-category').value.trim();
    const name = document.getElementById('inv-name').value.trim();
    const qty = parseInt(document.getElementById('inv-qty').value);
    const buyPrice = parseFloat(document.getElementById('inv-cost').value);
    const sellPrice = parseFloat(document.getElementById('inv-price').value);

    // Payment Section
    const paymentStatus = document.getElementById('inv-payment-status') ? document.getElementById('inv-payment-status').value : 'Paid';
    const advanceAmount = document.getElementById('inv-advance') ? parseFloat(document.getElementById('inv-advance').value) : 0;

    if (!name || isNaN(qty) || isNaN(buyPrice) || isNaN(sellPrice)) {
        showToast('Valid details required', 'error');
        return;
    }

    const totalCost = qty * buyPrice;

    if (editInvId) {
        // Just update item stats (money won't be modified again on edit to prevent double-logging)
        await db.inventory.update(editInvId, { category, name, qty, buyPrice, sellPrice, unitCost: buyPrice });
        editInvId = null;
        document.getElementById('inv-submit-btn').innerText = 'Add to Inventory';
        document.getElementById('inv-cancel-btn').classList.add('hide');
        showToast('Inventory Updated');
    } else {
        await db.inventory.add({ category, name, qty, buyPrice, sellPrice, unitCost: buyPrice });
        showToast('Item Added to Inventory');

        // Automatic Moneybook Expense
        if (paymentStatus === 'Credit') {
            await db.moneybook.add({
                date: new Date().toISOString().split('T')[0],
                type: 'Inventory',
                subType: 'Purchase',
                description: `Inventory Purchase (Credit): ${name} x${qty}`,
                amount: advanceAmount,
                naya: Math.max(0, totalCost - advanceAmount),
                timestamp: new Date().toISOString()
            });
            showToast(`Credit purchase recorded in Money Book`, 'info');
        } else {
            await db.moneybook.add({
                date: new Date().toISOString().split('T')[0],
                type: 'Inventory',
                subType: 'Purchase',
                description: `Inventory Purchase (Cash Paid): ${name} x${qty}`,
                amount: totalCost,
                naya: 0,
                timestamp: new Date().toISOString()
            });
            showToast(`Rs. ${totalCost} logged as expense to Money Book`, 'info');
        }
    }

    document.getElementById('inv-category').value = '';
    document.getElementById('inv-name').value = '';
    document.getElementById('inv-qty').value = '0';
    document.getElementById('inv-cost').value = '0';
    document.getElementById('inv-price').value = '0';
    
    // Reset payment sections
    if (document.getElementById('inv-payment-status')) document.getElementById('inv-payment-status').value = 'Paid';
    if (document.getElementById('inv-advance')) document.getElementById('inv-advance').value = '0';
    if (window.toggleInvAdvance) window.toggleInvAdvance();

    await loadInventory();
    if(typeof loadMoneyBook === 'function') await loadMoneyBook();
}

window.toggleInvAdvance = function() {
    const el = document.getElementById('inv-payment-status');
    const container = document.getElementById('inv-advance-container');
    if(el && container) {
        if(el.value === 'Credit') {
            container.classList.remove('hide');
        } else {
            container.classList.add('hide');
            document.getElementById('inv-advance').value = '0';
        }
    }
}

async function editInventoryItem(id) {
    const item = await db.inventory.get(id);
    if (item) {
        document.getElementById('inv-category').value = item.category || '';
        document.getElementById('inv-name').value = item.name;
        document.getElementById('inv-qty').value = item.qty;
        document.getElementById('inv-cost').value = item.buyPrice !== undefined ? item.buyPrice : (item.unitCost || 0);
        document.getElementById('inv-price').value = item.sellPrice || 0;
        editInvId = id;
        document.getElementById('inv-submit-btn').innerText = 'Update Item';
        document.getElementById('inv-cancel-btn').classList.remove('hide');
        document.getElementById('inv-name').focus();
    }
}

function cancelInventoryEdit() {
    editInvId = null;
    document.getElementById('inv-category').value = '';
    document.getElementById('inv-name').value = '';
    document.getElementById('inv-qty').value = '0';
    document.getElementById('inv-cost').value = '0';
    document.getElementById('inv-price').value = '0';
    document.getElementById('inv-submit-btn').innerText = 'Add to Inventory';
    document.getElementById('inv-cancel-btn').classList.add('hide');
}

function promptDeleteInventory(id) {
    requireAdminAuth(async () => {
        await db.inventory.delete(id);
        showToast('Item deleted!', 'success');
        await loadInventory();
    });
}

function downloadInventoryReport() {
    requireAdminAuth(async () => {
        const items = await db.inventory.toArray();
        if (items.length === 0) {
            showToast('No inventory items to export.', 'warning');
            return;
        }

        let totalInventoryValue = 0;
        const rows = items.map((item, index) => {
            const buyPrice = item.buyPrice !== undefined ? item.buyPrice : (item.unitCost || 0);
            const rowTotal = item.qty * buyPrice;
            totalInventoryValue += rowTotal;
            return `
                <tr style="border-bottom:1px solid #e5e7eb;font-size:12px;background:${index % 2 === 0 ? '#ffffff' : '#f9fafb'};">
                    <td style="padding:10px 14px;color:#6b7280;">${item.category || '-'}</td>
                    <td style="padding:10px 14px;color:#111827;font-weight:600;">${item.name}</td>
                    <td style="padding:10px 14px;text-align:center;color:#374151;">${item.qty}</td>
                    <td style="padding:10px 14px;text-align:right;color:#6b7280;">${formatCurrency(buyPrice)}</td>
                    <td style="padding:10px 14px;text-align:right;color:#6b7280;">${formatCurrency(item.sellPrice || 0)}</td>
                    <td style="padding:10px 14px;text-align:right;color:#111827;font-weight:700;">${formatCurrency(rowTotal)}</td>
                </tr>
            `;
        }).join('');

        const html = `
        <div style="background:#fff;padding:40px;font-family:Arial, sans-serif;color:#1f2937;width:750px;box-sizing:border-box;min-height:900px;">
            <div style="text-align:center;margin-bottom:30px;border-bottom:2px solid #f43f5e;padding-bottom:20px;">
                <h1 style="font-size:24px;font-weight:800;color:#111827;margin:0 0 5px 0;">PASSION PIXELS - Inventory Report</h1>
                <p style="font-size:13px;color:#6b7280;margin:0;">Generated on: ${new Date().toLocaleString()}</p>
            </div>

            <table style="width:100%;border-collapse:collapse;margin-bottom:30px;">
                <thead style="background:#1f2937;">
                    <tr>
                        <th style="padding:12px 14px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;">Category</th>
                        <th style="padding:12px 14px;text-align:left;color:#fff;font-size:11px;text-transform:uppercase;">Item Name</th>
                        <th style="padding:12px 14px;text-align:center;color:#fff;font-size:11px;text-transform:uppercase;">Stock Qty</th>
                        <th style="padding:12px 14px;text-align:right;color:#fff;font-size:11px;text-transform:uppercase;">Buying Price</th>
                        <th style="padding:12px 14px;text-align:right;color:#fff;font-size:11px;text-transform:uppercase;">Selling Price</th>
                        <th style="padding:12px 14px;text-align:right;color:#fff;font-size:11px;text-transform:uppercase;">Total Value</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>

            <div style="display:flex;justify-content:flex-end;">
                <div style="width:320px;background:#f9fafb;border-radius:8px;padding:20px;border:1px solid #e5e7eb;">
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:15px;">
                        <span style="font-weight:700;color:#374151;">Total Value</span>
                        <span style="font-weight:800;color:#f43f5e;font-size:18px;">${formatCurrency(totalInventoryValue)}</span>
                    </div>
                </div>
            </div>
            
            <div style="text-align:center;margin-top:50px;font-size:11px;color:#9ca3af;">
                System generated report. Passion Pixel POS.
            </div>
        </div>
        `;

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-9999;';
        wrapper.innerHTML = html;
        document.body.appendChild(wrapper);

        showToast('Generating Inventory Report...', 'info');

        setTimeout(() => {
            const opt = {
                margin: [0, 0, 0, 0],
                filename: `InventoryReport_${new Date().toISOString().split('T')[0]}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
            };
            html2pdf().set(opt).from(wrapper.firstElementChild).save().then(() => {
                document.body.removeChild(wrapper);
                showToast('Download Complete!', 'success');
            });
        }, 500);
    });
}

// ==========================================
// SHOP POS
// ==========================================
function generateShopBillNo() {
    shopCurrentBillNo = generateBillNo('PP-SH');
    document.getElementById('shop-bill-no').innerText = shopCurrentBillNo;
}

function handleShopItemInput() {
    const val = document.getElementById('shop-item-name').value;
    const matched = allShopItems.find(i => i.name === val || (i.actualName && i.actualName === val));
    if (matched) {
        document.getElementById('shop-price').value = matched.price;
        document.getElementById('shop-item-name').dataset.selectedItem = JSON.stringify(matched);
    } else {
        document.getElementById('shop-item-name').dataset.selectedItem = '';
    }
}

function addShopItem() {
    const nameInput = document.getElementById('shop-item-name').value.trim();
    const price = parseFloat(document.getElementById('shop-price').value);
    const qty = parseInt(document.getElementById('shop-qty').value);

    if (!nameInput || isNaN(qty) || qty < 1 || isNaN(price)) {
        showToast('Enter item name, valid price and quantity', 'warning');
        return;
    }

    const selectedDataStr = document.getElementById('shop-item-name').dataset.selectedItem;
    let matched = selectedDataStr ? JSON.parse(selectedDataStr) : null;

    const photoInput = document.getElementById('shop-photo-no');
    const photoNo = photoInput ? photoInput.value.trim() : '';

    const item = {
        id: Date.now(),
        serviceId: matched ? matched.id : 'manual',
        name: matched ? (matched.actualName || matched.name) : nameInput,
        photoNo: photoNo || '—',
        price: price,
        qty: qty,
        total: price * qty,
        itemType: matched ? matched.type : 'manual',
        dbId: matched ? matched.dbId : null
    };

    currentShopCart.push(item);
    renderShopCart();

    // Reset selection
    document.getElementById('shop-item-name').value = '';
    document.getElementById('shop-price').value = 0;
    document.getElementById('shop-qty').value = 1;
    document.getElementById('shop-item-name').dataset.selectedItem = '';
}

function removeShopItem(cartItemId) {
    currentShopCart = currentShopCart.filter(item => item.id !== cartItemId);
    renderShopCart();
}

function toggleShopAdvance() {
    const status = document.getElementById('shop-payment-status').value;
    const container = document.getElementById('shop-advance-container');
    if (status === 'Advance') {
        container.classList.remove('hide');
        calculateShopBalance();
    } else {
        container.classList.add('hide');
        document.getElementById('shop-advance-amount').value = 0;
    }
}

function calculateShopBalance() {
    const subtotal = currentShopCart.reduce((sum, i) => sum + i.total, 0);
    const discount = parseFloat(document.getElementById('shop-discount').value) || 0;
    const total = Math.max(0, subtotal - discount);
    const advance = parseFloat(document.getElementById('shop-advance-amount').value) || 0;
    const balance = Math.max(0, total - advance);
    document.getElementById('shop-balance-due').innerText = formatCurrency(balance);
}

function calculateShopDiscount() {
    const subtotal = currentShopCart.reduce((sum, i) => sum + i.total, 0);
    let discount = parseFloat(document.getElementById('shop-discount').value) || 0;
    if (discount > subtotal) {
        discount = subtotal;
        document.getElementById('shop-discount').value = discount;
    }
    const pct = subtotal > 0 ? ((discount / subtotal) * 100).toFixed(1) : 0;
    document.getElementById('shop-discount-pct').innerText = `${pct}%`;
    const total = Math.max(0, subtotal - discount);
    document.getElementById('shop-total').innerText = formatCurrency(total);
    calculateShopBalance();
}

function clearShopCart() {
    currentShopCart = [];
    document.getElementById('shop-customer-name').value = '';
    document.getElementById('shop-customer-phone').value = '';
    document.getElementById('shop-customer-address').value = '';
    document.getElementById('shop-payment-status').value = 'Paid';
    document.getElementById('shop-advance-amount').value = 0;
    if (document.getElementById('shop-advance-container')) {
        document.getElementById('shop-advance-container').classList.add('hide');
    }
    if (document.getElementById('shop-discount')) {
        document.getElementById('shop-discount').value = 0;
    }
    document.getElementById('shop-item-name').value = '';
    document.getElementById('shop-item-name').dataset.selectedItem = '';
    const dueDateInput = document.getElementById('shop-due-date');
    if (dueDateInput) dueDateInput.value = '';
    const photoInput = document.getElementById('shop-photo-no');
    if (photoInput) photoInput.value = '';
    renderShopCart();
}

function renderShopCart() {
    const tbody = document.getElementById('shop-cart-tbody');
    tbody.innerHTML = '';

    let subtotal = 0;

    currentShopCart.forEach(item => {
        subtotal += item.total;
        const tr = document.createElement('tr');
        tr.className = 'border-b border-gray-800 text-gray-300';
        tr.innerHTML = `
            <td class="py-3 font-mono text-xs text-brand font-bold">${item.photoNo || '—'}</td>
            <td class="py-3">${item.name}</td>
            <td class="py-3 text-center">${formatCurrency(item.price)}</td>
            <td class="py-3 text-center text-white font-medium">${item.qty}</td>
            <td class="py-3 text-right">${formatCurrency(item.total)}</td>
            <td class="py-3 text-right">
                <button onclick="removeShopItem(${item.id})" class="text-gray-500 hover:text-red-500 transition-colors"><i class="ph ph-x-circle text-lg"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (currentShopCart.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-gray-500 italic">Cart is empty</td></tr>`;
    }

    document.getElementById('shop-subtotal').innerText = formatCurrency(subtotal);
    calculateShopDiscount();
}

async function shopCheckout() {
    if (currentShopCart.length === 0) {
        showToast('Cart is empty', 'warning');
        return;
    }

    const phone = document.getElementById('shop-customer-phone').value || 'N/A';
    const cName = document.getElementById('shop-customer-name').value.trim() || 'Walk-in Customer';
    const address = document.getElementById('shop-customer-address').value.trim() || '';
    const status = document.getElementById('shop-payment-status').value;
    const dueDate = document.getElementById('shop-due-date').value;
    const subtotal = currentShopCart.reduce((sum, i) => sum + i.total, 0);
    const discount = parseFloat(document.getElementById('shop-discount').value) || 0;
    const total = Math.max(0, subtotal - discount);
    const advanceAmt = status === 'Advance' ? (parseFloat(document.getElementById('shop-advance-amount').value) || 0) : null;
    
    // Calculate total buying cost
    let totalBuyingCost = 0;
    for (let item of currentShopCart) {
        if (item.itemType === 'inventory' && item.dbId) {
            const dbItem = await db.inventory.get(item.dbId);
            if (dbItem) {
                const bPrice = dbItem.buyPrice !== undefined ? dbItem.buyPrice : (dbItem.unitCost || 0);
                totalBuyingCost += (bPrice * item.qty);
            }
        }
    }

    const order = {
        billNo: shopCurrentBillNo,
        customerName: cName,
        customerPhone: phone,
        customerAddress: address,
        subtotalAmount: subtotal,
        discountAmount: discount,
        totalAmount: total,
        date: new Date().toISOString(),
        dueDate: dueDate || null,
        type: 'shop',
        paymentStatus: status,
        advanceAmount: advanceAmt,
        totalBuyingCost: totalBuyingCost,
        items: JSON.parse(JSON.stringify(currentShopCart)) // deep copy
    };

    await db.orders.add(order);

    // Deduct Inventory Quantities
    for (let item of currentShopCart) {
        if (item.itemType === 'inventory' && item.dbId) {
            const dbItem = await db.inventory.get(item.dbId);
            if (dbItem) {
                // Determine remainder or 0 if it goes negative (though maybe throw warning?)
                const newQty = Math.max(0, dbItem.qty - item.qty);
                await db.inventory.update(item.dbId, { qty: newQty });
            }
        }
    }

    generateInvoicePDF(order);
    backupToGoogleSheets(order);
    showToast('Shop Checkout Complete');

    clearShopCart();
    generateShopBillNo();
    loadDashboardStats();
    loadBills();
    loadInventory(); // Refresh Inventory Table
}

function generateInvoicePDF(order) {
    const customerName = order.customerName || (order.customerPhone !== 'N/A' ? order.customerPhone : 'Walk-in Customer');
    const isPaid = order.paymentStatus === 'Paid';
    const statusBg = isPaid ? '#dcfce7' : '#fef9c3';
    const statusColor = isPaid ? '#16a34a' : '#b45309';
    const statusBorder = isPaid ? '#86efac' : '#fde68a';

    const itemRows = order.items.map((item, i) => `
        <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f9fafb'};border-bottom:1px solid #e5e7eb;">
            <td style="padding:11px 14px;font-size:12px;font-family:monospace;font-weight:700;color:#f43f5e;">${item.photoNo || '—'}</td>
            <td style="padding:11px 14px;font-size:13px;color:#1f2937;">${item.name}</td>
            <td style="padding:11px 14px;text-align:center;font-size:13px;color:#374151;">${item.qty}</td>
            <td style="padding:11px 14px;text-align:right;font-size:13px;color:#374151;">${formatCurrency(item.price)}</td>
            <td style="padding:11px 14px;text-align:right;font-size:13px;font-weight:700;color:#111827;">${formatCurrency(item.total)}</td>
        </tr>
    `).join('');

    // Use <table> for header layout — html2canvas handles tables more reliably than flexbox
    const invoiceHTML = `
    <div style="background:#ffffff;width:750px;padding:48px;font-family:Arial,Helvetica,sans-serif;color:#1f2937;border-top:8px solid #f43f5e;box-sizing:border-box;">

        <!-- HEADER via TABLE (avoids html2canvas flex rendering bugs) -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:28px;padding-bottom:24px;border-bottom:2px solid #f43f5e;">
            <tr>
                <td style="vertical-align:middle;padding:0;">
                    <table style="border-collapse:collapse;">
                        <tr>
                            <td style="vertical-align:middle;padding-right:18px;">
                                <!-- LOGO BOX -->
                                <table style="background-color:#000000;border-radius:10px;border:1px solid #4b5563;border-collapse:separate;">
                                    <tr>
                                        <td style="padding:12px 18px;text-align:center;">
                                            <div style="font-family:'Times New Roman',Times,serif;font-size:17px;color:#ffffff;letter-spacing:3px;font-weight:bold;white-space:nowrap;line-height:1.3;">PASSION PIXELS</div>
                                            <div style="font-size:7px;color:#9ca3af;letter-spacing:5px;margin-top:3px;line-height:1.3;">STUDIO &amp; COLOR LAB</div>
                                        </td>
                                    </tr>
                                </table>
                            </td>
                            <td style="vertical-align:middle;padding:0;">
                                <div style="font-size:20px;font-weight:800;color:#111827;margin-bottom:4px;">Authorized Invoice</div>
                                <div style="font-size:12px;color:#6b7280;">Passion Pixel POS System</div>
                            </td>
                        </tr>
                    </table>
                </td>
                <td style="vertical-align:middle;text-align:right;padding:0;">
                    <div style="font-size:34px;font-weight:900;color:#f43f5e;letter-spacing:3px;margin-bottom:10px;">INVOICE</div>
                    <div style="font-size:13px;color:#6b7280;margin-bottom:3px;">Bill No: <span style="font-weight:700;color:#111827;">${order.billNo}</span></div>
                    <div style="font-size:13px;color:#6b7280;">Date: <span style="font-weight:600;color:#374151;">${new Date(order.date).toLocaleString()}</span></div>
                    ${order.dueDate ? `<div style="font-size:13px;color:#dc2626;margin-top:3px;">Due Date: <span style="font-weight:600;">${order.dueDate}</span></div>` : ''}
                </td>
            </tr>
        </table>

        <!-- CUSTOMER BAND -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
            <tr>
                <td style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:18px 22px;vertical-align:middle;">
                    <div style="font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:2px;margin-bottom:5px;">Billed To</div>
                    <div style="font-size:19px;font-weight:700;color:#111827;">${customerName}</div>
                    ${order.customerPhone && order.customerPhone !== 'N/A' ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">${order.customerPhone}</div>` : ''}
                    ${order.customerAddress ? `<div style="font-size:13px;color:#6b7280;margin-top:4px;">${order.customerAddress}</div>` : ''}
                </td>
                <td style="width:20px;"></td>
                <td style="vertical-align:middle;text-align:right;width:160px;">
                    <div style="background:${statusBg};color:${statusColor};border:1.5px solid ${statusBorder};padding:9px 22px;border-radius:999px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;display:inline-block;">
                        ${order.paymentStatus}
                    </div>
                </td>
            </tr>
        </table>

        <!-- ITEMS TABLE -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:28px;">
            <thead>
                <tr style="background:#1f2937;">
                    <th style="padding:12px 14px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#ffffff;">Photo No.</th>
                    <th style="padding:12px 14px;text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#ffffff;">Description</th>
                    <th style="padding:12px 14px;text-align:center;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#ffffff;">Qty</th>
                    <th style="padding:12px 14px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#ffffff;">Unit Price</th>
                    <th style="padding:12px 14px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#ffffff;">Total</th>
                </tr>
            </thead>
            <tbody>${itemRows}</tbody>
        </table>

        <!-- TOTAL BOX -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:40px;">
            <tr>
                <td style="padding:0;"></td>
                <td style="width:300px;padding:0;vertical-align:top;">
                    <table style="width:100%;border-collapse:collapse;">
                        <tr style="border-top:1px solid #e5e7eb;">
                            <td style="padding:8px 0;font-size:14px;color:#6b7280;">Subtotal</td>
                            <td style="padding:8px 0;text-align:right;font-size:14px;color:#374151;font-weight:600;">${formatCurrency(order.subtotalAmount || order.totalAmount)}</td>
                        </tr>
                        ${order.discountAmount > 0 ? `
                        <tr style="border-top:1px solid #e5e7eb;">
                            <td style="padding:8px 0;font-size:14px;color:#6b7280;">Discount</td>
                            <td style="padding:8px 0;text-align:right;font-size:14px;color:#10b981;font-weight:600;">- ${formatCurrency(order.discountAmount)}</td>
                        </tr>` : ''}
                    </table>
                    <div style="background:#1f2937;border-radius:10px;padding:14px 18px;margin-top:6px;">
                        <table style="width:100%;border-collapse:collapse;">
                            <tr>
                                <td style="font-size:14px;color:#d1d5db;font-weight:600;">Grand Total</td>
                                <td style="text-align:right;font-size:24px;color:#f43f5e;font-weight:900;">${formatCurrency(order.totalAmount)}</td>
                            </tr>
                            ${(order.paymentStatus === 'Advance' || order.paymentStatus === 'Credit') ? `
                            <tr>
                                <td style="padding:10px 0 0;font-size:14px;color:#9ca3af;font-weight:600;">${order.paymentStatus === 'Advance' ? 'Advance Paid' : 'Amount Paid'}</td>
                                <td style="text-align:right;font-size:16px;color:#10b981;font-weight:700;padding:10px 0 0;">${formatCurrency(order.paymentStatus === 'Advance' ? order.advanceAmount : 0)}</td>
                            </tr>
                            <tr>
                                <td style="padding:6px 0 0;font-size:14px;color:#d1d5db;font-weight:600;">Balance Due</td>
                                <td style="text-align:right;font-size:20px;color:#ef4444;font-weight:900;padding:6px 0 0;">${formatCurrency(order.totalAmount - (order.paymentStatus === 'Advance' ? order.advanceAmount : 0))}</td>
                            </tr>` : ''}
                        </table>
                    </div>
                </td>
            </tr>
        </table>

        <!-- FOOTER -->
        <div style="text-align:center;border-top:1px solid #e5e7eb;padding-top:18px;">
            <div style="font-size:14px;color:#374151;margin-bottom:4px;">Thank you for choosing <span style="color:#f43f5e;font-weight:700;">Passion Pixel</span>!</div>
            <div style="font-size:11px;color:#9ca3af;">Contact: 070-3236363 &nbsp;|&nbsp; passionpixel@gmail.com</div>
        </div>
    </div>`;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-9999;';
    wrapper.innerHTML = invoiceHTML;
    document.body.appendChild(wrapper);

    setTimeout(() => {
        const opt = {
            margin: [0, 0, 0, 0],
            filename: `Invoice_${order.billNo}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
            jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
        };
        html2pdf().set(opt).from(wrapper.firstElementChild).save().then(() => {
            document.body.removeChild(wrapper);
            printThermalReceipt(order, order.type || 'shop');
        });
    }, 300);
}

// ==========================================
// PHOTOBOOTH EXPRESS
// ==========================================
function generateBoothBillNo() {
    boothCurrentBillNo = generateBillNo('PP-BT');
    document.getElementById('booth-bill-no').innerText = boothCurrentBillNo;
}

function toggleBoothFrame() {
    const isChecked = document.getElementById('booth-frame-toggle').checked;
    const container = document.getElementById('booth-frame-count-container');
    if (isChecked) {
        container.classList.remove('opacity-30', 'pointer-events-none');
    } else {
        container.classList.add('opacity-30', 'pointer-events-none');
    }
}

function toggleBoothAdvance() {
    const status = document.getElementById('booth-payment-status').value;
    const container = document.getElementById('booth-advance-container');
    if (status === 'Advance') {
        container.classList.remove('hide');
        calculateBoothBalance();
    } else {
        container.classList.add('hide');
        document.getElementById('booth-advance-amount').value = 0;
    }
}

function calculateBoothBalance() {
    const total = currentBoothCart.reduce((acc, item) => acc + item.total, 0);
    const advance = parseFloat(document.getElementById('booth-advance-amount').value) || 0;
    const balance = Math.max(0, total - advance);
    document.getElementById('booth-balance-due').innerText = 'Bal: ' + formatCurrency(balance);
}

function calculateBoothTotal() {
    const printPrice = parseFloat(document.getElementById('booth-print-price').value || 0);
    const prints = parseInt(document.getElementById('booth-prints').value || 1);

    let total = printPrice * prints;

    if (document.getElementById('booth-frame-toggle').checked) {
        const framePrice = parseFloat(document.getElementById('booth-frame-price').value || 0);
        const frameCount = parseInt(document.getElementById('booth-frames').value || 1);
        total += (frameCount * framePrice);
    }

    document.getElementById('booth-item-total').innerText = formatCurrency(total);
    return total;
}

function addBoothItem() {
    const photoNo = document.getElementById('booth-photo-no').value.trim();
    if (!photoNo) {
        showToast('Photo Number is required', 'error');
        document.getElementById('booth-photo-no').focus();
        return;
    }

    const size = document.getElementById('booth-size').value || 'Default';
    const printPrice = parseFloat(document.getElementById('booth-print-price').value || 0);
    const prints = parseInt(document.getElementById('booth-prints').value || 1);

    const hasFrame = document.getElementById('booth-frame-toggle').checked;
    const frameSize = hasFrame ? (document.getElementById('booth-frame-size').value || 'Standard') : '';
    const framePrice = hasFrame ? parseFloat(document.getElementById('booth-frame-price').value || 0) : 0;
    const frames = hasFrame ? parseInt(document.getElementById('booth-frames').value || 1) : 0;

    const total = calculateBoothTotal();

    const item = {
        id: Date.now(),
        photoNo,
        size,
        printPrice,
        prints,
        hasFrame,
        frameSize,
        framePrice,
        frames,
        total
    };

    currentBoothCart.push(item);
    renderBoothCart();

    // Reset current item inputs (keep phone number)
    document.getElementById('booth-photo-no').value = '';
    document.getElementById('booth-size').value = '';
    document.getElementById('booth-print-price').value = 0;
    document.getElementById('booth-prints').value = 1;
    document.getElementById('booth-frame-toggle').checked = false;
    document.getElementById('booth-frame-size').value = '';
    document.getElementById('booth-frame-price').value = 0;
    document.getElementById('booth-frames').value = 1;
    toggleBoothFrame();
    calculateBoothTotal();
}

function removeBoothItem(id) {
    currentBoothCart = currentBoothCart.filter(i => i.id !== id);
    renderBoothCart();
}

function renderBoothCart() {
    const tbody = document.getElementById('booth-cart-tbody');
    tbody.innerHTML = '';

    let grandTotal = 0;

    if (currentBoothCart.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-gray-500 italic">No photos added yet</td></tr>`;
        document.getElementById('booth-grand-total').innerText = 'Rs. 0';
        return;
    }

    currentBoothCart.forEach(item => {
        grandTotal += item.total;

        let printText = `${item.size} x ${item.prints} (${formatCurrency(item.printPrice)})`;
        let frameText = item.hasFrame ? `${item.frameSize} x ${item.frames} (${formatCurrency(item.framePrice)})` : '<span class="text-gray-600">None</span>';

        const tr = document.createElement('tr');
        tr.className = 'border-b border-gray-800 text-gray-300';
        tr.innerHTML = `
            <td class="py-3 font-medium text-white">${item.photoNo}</td>
            <td class="py-3 text-xs">${printText}</td>
            <td class="py-3 text-xs">${frameText}</td>
            <td class="py-3 text-right text-brand font-bold">${formatCurrency(item.total)}</td>
            <td class="py-3 text-right">
                <button onclick="removeBoothItem(${item.id})" class="text-gray-500 hover:text-red-500 transition-colors"><i class="ph ph-trash text-lg"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('booth-grand-total').innerText = formatCurrency(grandTotal);
}

async function boothCheckout() {
    if (currentBoothCart.length === 0) {
        showToast('Please add at least one photo to the list', 'warning');
        return;
    }

    const phone = document.getElementById('booth-phone').value.trim() || 'N/A';
    const eventName = document.getElementById('booth-event').value.trim() || 'General';
    const dueDate = document.getElementById('booth-due-date').value;
    const grandTotal = currentBoothCart.reduce((acc, item) => acc + item.total, 0);
    const timestamp = new Date().toISOString();
    const status = document.getElementById('booth-payment-status').value;
    const advanceAmt = status === 'Advance' ? (parseFloat(document.getElementById('booth-advance-amount').value) || 0) : null;

    const orderData = {
        billNo: boothCurrentBillNo,
        phone,
        event: eventName,
        total: grandTotal,
        items: JSON.parse(JSON.stringify(currentBoothCart)),
        timestamp: timestamp,
        dueDate: dueDate || null,
        paymentStatus: status,
        advanceAmount: advanceAmt
    };

    // Save Photobooth specific history
    await db.photobooth.add(orderData);

    // Prepare items for general orders table
    let orderItems = [];
    currentBoothCart.forEach(i => {
        orderItems.push({ name: `Booth Print - ${i.size} (${i.photoNo})`, qty: i.prints, price: i.printPrice, total: i.printPrice * i.prints });
        if (i.hasFrame) {
            orderItems.push({ name: `Booth Frame - ${i.frameSize} (${i.photoNo})`, qty: i.frames, price: i.framePrice, total: i.framePrice * i.frames });
        }
    });

    await db.orders.add({
        billNo: orderData.billNo,
        customerPhone: phone,
        totalAmount: grandTotal,
        date: timestamp,
        type: 'booth',
        paymentStatus: status,
        dueDate: dueDate || null,
        advanceAmount: advanceAmt,
        items: orderItems
    });

    generateBoothSlipPDF(orderData);
    backupToGoogleSheets(orderData);
    showToast('Photobooth Checked Out!', 'success');

    // Complete Reset
    currentBoothCart = [];
    renderBoothCart();
    document.getElementById('booth-phone').value = '';
    document.getElementById('booth-event').value = '';
    if (document.getElementById('booth-due-date')) {
        document.getElementById('booth-due-date').value = '';
    }
    document.getElementById('booth-payment-status').value = 'Paid';
    document.getElementById('booth-advance-amount').value = 0;
    if (document.getElementById('booth-advance-container')) {
        document.getElementById('booth-advance-container').classList.add('hide');
    }

    generateBoothBillNo();
    loadBills();
    loadDashboardStats();
}

function generateBoothSlipPDF(data) {
    // Build slip with 100% inline styles — no Tailwind dependency
    const itemRows = data.items.map(item => {
        let rows = `
        <tr style="border-bottom:1px dashed #e5e7eb;">
            <td style="padding:8px 4px;">
                <div style="font-weight:700;font-size:13px;color:#111827;">${item.photoNo}</div>
                <div style="font-size:10px;color:#6b7280;margin-top:2px;">Print: ${item.size} x${item.prints} @ ${formatCurrency(item.printPrice)}</div>
            </td>
            <td style="padding:8px 4px;text-align:right;font-size:13px;font-weight:600;color:#374151;">${formatCurrency(item.printPrice * item.prints)}</td>
        </tr>`;
        if (item.hasFrame) {
            rows += `
        <tr style="border-bottom:1px dashed #e5e7eb;background:#fafafa;">
            <td style="padding:6px 4px 6px 16px;">
                <div style="font-size:10px;color:#9ca3af;">↳ Frame: ${item.frameSize} x${item.frames} @ ${formatCurrency(item.framePrice)}</div>
            </td>
            <td style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;">${formatCurrency(item.framePrice * item.frames)}</td>
        </tr>`;
        }
        return rows;
    }).join('');

    const slipHTML = `
    <div style="background:#ffffff;width:280px;padding:20px;font-family:'Helvetica Neue',Arial,sans-serif;color:#1f2937;border-top:6px solid #f43f5e;box-sizing:border-box;">

        <!-- LOGO -->
        <div style="text-align:center;margin-bottom:12px;">
            <table align="center" style="background-color:#000000;border-radius:8px;border:1px solid #374151;border-collapse:separate;margin:0 auto;">
                <tr>
                    <td style="padding:8px 16px;text-align:center;">
                        <div style="font-family:'Times New Roman',Times,serif;font-size:13px;color:#ffffff;letter-spacing:0.15em;font-weight:bold;">PASSION PIXELS</div>
                        <div style="font-size:6px;color:#9ca3af;letter-spacing:0.2em;margin-top:2px;">STUDIO &amp; COLOR LAB</div>
                    </td>
                </tr>
            </table>
            <div style="font-size:10px;color:#9ca3af;margin-top:8px;padding-top:8px;border-bottom:1px solid #e5e7eb;padding-bottom:8px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Photobooth Express Ticket</div>
        </div>

        <!-- INFO -->
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="color:#6b7280;">Bill No</span>
                <span style="font-weight:700;color:#111827;">${data.billNo}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="color:#6b7280;">Phone</span>
                <span style="font-weight:600;color:#374151;">${data.phone}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="color:#6b7280;">Event</span>
                <span style="font-weight:600;color:#374151;">${data.event || 'General'}</span>
            </div>
            ${data.dueDate ? `
            <div style="display:flex;justify-content:space-between;">
                <span style="color:#dc2626;font-weight:600;">Due Date</span>
                <span style="font-weight:700;color:#dc2626;">${data.dueDate}</span>
            </div>` : ''}
        </div>

        <!-- ITEMS TABLE -->
        <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
            <thead>
                <tr style="border-bottom:2px dashed #9ca3af;">
                    <th style="padding:6px 4px;text-align:left;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Details</th>
                    <th style="padding:6px 4px;text-align:right;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Amount</th>
                </tr>
            </thead>
            <tbody>${itemRows}</tbody>
        </table>

        <!-- TOTAL -->
        <div style="background:#1f2937;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;justify-content:center;margin-bottom:14px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:13px;color:#d1d5db;font-weight:600;">Total</span>
                <span style="font-size:20px;color:#f43f5e;font-weight:900;">${formatCurrency(data.total)}</span>
            </div>
            ${data.paymentStatus === 'Advance' ? `
            <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #374151;margin-top:8px;padding-top:8px;">
                <span style="font-size:11px;color:#9ca3af;">Advance Received</span>
                <span style="font-size:12px;color:#10b981;font-weight:700;">${formatCurrency(data.advanceAmount)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                <span style="font-size:11px;color:#d1d5db;font-weight:600;">Balance Due</span>
                <span style="font-size:14px;color:#ef4444;font-weight:800;">${formatCurrency(data.total - data.advanceAmount)}</span>
            </div>` : ''}
        </div>

        <!-- FOOTER NOTE -->
        <div style="background:#fef2f2;border-radius:8px;padding:8px 10px;text-align:center;">
            <div style="font-size:10px;color:#9ca3af;">Please present this slip when collecting your photos.</div>
        </div>
    </div>`;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-9999;';
    wrapper.innerHTML = slipHTML;
    document.body.appendChild(wrapper);

    setTimeout(() => {
        const opt = {
            margin: [0, 0, 0, 0],
            filename: `Slip_${data.billNo}.pdf`,
            image: { type: 'jpeg', quality: 1 },
            html2canvas: { scale: 3, useCORS: true, logging: false, backgroundColor: '#ffffff' },
            jsPDF: { unit: 'mm', format: [80, 140], orientation: 'portrait' }
        };
        html2pdf().set(opt).from(wrapper.firstElementChild).save().then(() => {
            document.body.removeChild(wrapper);
            printThermalReceipt(data, 'booth');
        });
    }, 300);
}

// ==========================================
// REPORTS & BILLS MANAGEMENT
// ==========================================
async function loadBills() {
    allBills = await db.orders.orderBy('date').reverse().toArray();
    renderBillsTable(allBills);

    // Auto-prune extremely old bills (Reports & Bills only) to save Firebase Storage
    // Limits the local app to keeping the most recent 3000 bills, older ones are deleted.
    const MAX_BILLS_TO_KEEP = 3000;
    if (allBills.length > MAX_BILLS_TO_KEEP) {
        const oldestBills = allBills.slice(MAX_BILLS_TO_KEEP);
        for (let oldBill of oldestBills) {
            await db.orders.delete(oldBill.id);
        }
    }
}

function filterBills() {
    const term = document.getElementById('bill-search-input').value.toLowerCase();
    const filtered = allBills.filter(o => o.billNo.toLowerCase().includes(term));
    renderBillsTable(filtered);
}

function renderBillsTable(orders) {
    const tbody = document.getElementById('bills-list-tbody');
    tbody.innerHTML = '';

    if (orders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-gray-500 italic">No bills yet.</td></tr>`;
        return;
    }

    orders.forEach(order => {
        const dObj = new Date(order.date);
        const isAdvance = order.paymentStatus === 'Advance';
        const dueText = order.dueDate ? order.dueDate : '-';

        const tr = document.createElement('tr');
        tr.className = 'border-b border-gray-800 text-gray-300 hover:bg-gray-800/40 cursor-pointer transition-colors';
        tr.setAttribute('ondblclick', `showBillDetails('${order.id}')`);
        tr.innerHTML = `
            <td class="py-3">${dObj.toLocaleDateString()} ${dObj.toLocaleTimeString()}</td>
            <td class="py-3 font-mono text-white">${order.billNo}</td>
            <td class="py-3">
                <span class="px-2 py-1 rounded text-xs ${order.type === 'shop' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'}">
                    ${order.type.toUpperCase()}
                </span>
            </td>
            <td class="py-3">
                <span class="px-2 py-1 rounded text-xs ${order.paymentStatus === 'Paid' ? 'bg-green-500/10 text-green-400' : (order.paymentStatus === 'Credit' ? 'bg-red-500/10 text-red-500' : (order.paymentStatus === 'Reversed' ? 'bg-gray-500/10 text-gray-400 line-through' : 'bg-yellow-500/10 text-yellow-500'))}">
                    ${order.paymentStatus || 'Paid'}
                </span>
            </td>
            <td class="py-3 text-right text-brand font-medium ${order.paymentStatus === 'Reversed' ? 'line-through text-gray-500' : ''}">${formatCurrency(order.totalAmount)}</td>
            <td class="py-3 text-right text-gray-400 text-sm whitespace-nowrap">${dueText}</td>
            <td class="py-3 flex justify-end gap-2">
                <button onclick="reprintBillRecord('${order.id}')" title="Reprint Bill" class="text-gray-500 hover:text-indigo-500 transition-colors p-2"><i class="ph ph-printer text-lg"></i></button>
                <button onclick="downloadBillRecord('${order.id}')" title="Download Bill" class="text-gray-500 hover:text-blue-500 transition-colors p-2"><i class="ph ph-download-simple text-lg"></i></button>
                ${(isAdvance || order.paymentStatus === 'Credit') ? `<button onclick="markAsPaid('${order.id}')" title="Mark as Paid" class="text-gray-500 hover:text-green-500 transition-colors p-2"><i class="ph ph-check-circle text-lg"></i></button>` : ''}
                ${order.paymentStatus !== 'Reversed' ? `<button onclick="promptReverseBill('${order.id}')" title="Reverse Bill (Restore Inventory)" class="text-gray-500 hover:text-orange-500 transition-colors p-2"><i class="ph ph-arrow-counter-clockwise text-lg"></i></button>` : ''}
                <button onclick="promptDeleteBill('${order.id}')" title="Permanent Delete" class="text-gray-500 hover:text-red-500 transition-colors p-2"><i class="ph ph-trash text-lg"></i></button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function showBillDetails(id) {
    const order = await db.orders.get(id);
    if (!order) return;

    let itemsHtml = `<table style="width:100%; text-align:left; margin-top:10px; border-collapse: collapse; font-size:14px;">
        <tr style="border-bottom:1px solid #374151; color:#9ca3af;">
            <th style="padding:4px 0;">Item</th>
            <th style="text-align:center;">Qty</th>
            <th style="text-align:right;">Total</th>
        </tr>`;

    if (order.items && order.items.length > 0) {
        order.items.forEach(item => {
            const name = item.name || item.photoNo || 'Unknown Item';
            const qty = item.qty || item.prints || 1;
            const total = item.total || (item.price * qty) || 0;
            itemsHtml += `
            <tr style="border-bottom:1px solid #1f2937;">
                <td style="padding:6px 0; color:#e5e7eb;">${name}</td>
                <td style="text-align:center; color:#9ca3af;">${qty}</td>
                <td style="text-align:right; color:#e5e7eb;">${formatCurrency(total)}</td>
            </tr>`;
        });
    } else {
        itemsHtml += `<tr><td colspan="3" style="text-align:center; padding:10px; color:#6b7280; font-style:italic;">No items found</td></tr>`;
    }
    itemsHtml += `</table>`;

    const advanceRow = (order.paymentStatus === 'Advance' || order.paymentStatus === 'Credit') ?
        `<div style="display:flex; justify-content:space-between; margin-top:8px; font-size:13px; color:#10b981;">
            <span>Amount Paid:</span>
            <span>${formatCurrency(order.advanceAmount || 0)}</span>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:14px; color:#ef4444; font-weight:bold;">
            <span>Balance Due:</span>
            <span>${formatCurrency(order.totalAmount - (order.advanceAmount || 0))}</span>
        </div>` : '';

    Swal.fire({
        title: `Bill Details`,
        html: `
        <div style="text-align:left; color:#f3f4f6; font-size:15px; background: #1f2937; padding:16px; border-radius:12px; border: 1px solid #374151;">
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:#9ca3af;">Bill No:</span>
                <span style="font-weight:bold; color:#fff;">${order.billNo}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:#9ca3af;">Type:</span>
                <span style="text-transform:uppercase; font-weight:bold; color:#f43f5e;">${order.type}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:#9ca3af;">Date:</span>
                <span>${new Date(order.date).toLocaleString()}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:#9ca3af;">Customer:</span>
                <span>${order.customerName || 'Walk-in Customer'}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:#9ca3af;">Phone:</span>
                <span>${order.customerPhone || 'N/A'}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:#9ca3af;">Status:</span>
                <span style="font-weight:bold; color: ${order.paymentStatus === 'Paid' ? '#10b981' : (order.paymentStatus === 'Credit' ? '#ef4444' : '#f59e0b')};">${order.paymentStatus || 'Paid'}</span>
            </div>
            ${order.dueDate ? `
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                <span style="color:#ef4444; font-weight:bold;">Due Date:</span>
                <span style="color:#ef4444; font-weight:bold;">${order.dueDate}</span>
            </div>` : ''}
            
            <div style="margin-top:20px; margin-bottom:8px; font-weight:bold; border-bottom:1px solid #4b5563; padding-bottom:6px; color:#d1d5db;">Items Ordered</div>
            ${itemsHtml}
            
            ${order.discountAmount > 0 ? `
            <div style="margin-top:20px; padding-top:12px; border-top:2px dashed #4b5563;">
                <div style="display:flex; justify-content:space-between; color:#d1d5db; margin-bottom: 4px;">
                    <span>Subtotal:</span>
                    <span>${formatCurrency(order.subtotalAmount || order.totalAmount)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; color:#10b981; margin-bottom: 4px;">
                    <span>Discount:</span>
                    <span>- ${formatCurrency(order.discountAmount)}</span>
                </div>
            </div>` : ''}
            <div style="${order.discountAmount > 0 ? 'padding-top:12px; border-top:1px solid #374151;' : 'margin-top:20px; padding-top:12px; border-top:2px dashed #4b5563;'}">
                <div style="display:flex; justify-content:space-between; font-weight:900; font-size:18px;">
                    <span>Grand Total:</span>
                    <span style="color:#f43f5e;">${formatCurrency(order.totalAmount)}</span>
                </div>
                ${advanceRow}
            </div>
        </div>
        `,
        background: '#111827',
        color: '#f3f4f6',
        showCloseButton: true,
        showConfirmButton: false,
        width: '450px'
    });
}

async function downloadBillRecord(id) {
    const order = await db.orders.get(id);
    if (!order) return;
    if (order.type === 'booth') {
        const boothRecords = await db.photobooth.where('billNo').equals(order.billNo).toArray();
        if (boothRecords.length > 0) {
            generateBoothSlipPDF(boothRecords[0]);
        } else {
            showToast('Photobooth details not found', 'error');
        }
    } else {
        generateInvoicePDF(order);
    }
}

async function reprintBillRecord(id) {
    const order = await db.orders.get(id);
    if (!order) return;
    if (order.type === 'booth') {
        const boothRecords = await db.photobooth.where('billNo').equals(order.billNo).toArray();
        if (boothRecords.length > 0) {
            printThermalReceipt(boothRecords[0], 'booth');
        } else {
            showToast('Photobooth details not found', 'error');
        }
    } else {
        printThermalReceipt(order, order.type || 'shop');
    }
}

async function markAsPaid(id) {
    await db.orders.update(id, { paymentStatus: 'Paid' });
    showToast('Marked as Paid!', 'success');
    await loadBills();
    await loadDashboardStats();
}

function promptReverseBill(id) {
    requireAdminAuth(async () => {
        Swal.fire({
            title: 'Reverse Bill?',
            text: 'Are you sure you want to reverse this bill? Inventory quantities will be restored and the bill marked as Reversed.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#f97316',
            cancelButtonColor: '#374151',
            confirmButtonText: 'Yes, Reverse it!'
        }).then(async (result) => {
            if (result.isConfirmed) {
                const order = await db.orders.get(id);
                if (order && order.paymentStatus !== 'Reversed') {
                    if (order.items && order.items.length > 0) {
                        for (let item of order.items) {
                            if (item.itemType === 'inventory' && item.dbId) {
                                const dbItem = await db.inventory.get(item.dbId);
                                if (dbItem) {
                                    await db.inventory.update(item.dbId, { qty: dbItem.qty + item.qty });
                                }
                            }
                        }
                    }

                    await db.orders.update(id, { paymentStatus: 'Reversed' });
                    showToast('Bill reversed and inventory restored!', 'success');
                    await loadBills();
                    await loadDashboardStats();
                    if (typeof loadInventory === 'function') {
                        await loadInventory();
                    }
                }
            }
        });
    });
}

function promptDeleteBill(id) {
    requireAdminAuth(async () => {
        Swal.fire({
            title: 'Delete Bill Permanently?',
            text: 'Are you sure you want to completely delete this bill WITH NO inventory updates?',
            icon: 'error',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: 'Yes, Delete!'
        }).then(async (result) => {
            if (result.isConfirmed) {
                const order = await db.orders.get(id);
                if (order && order.type === 'booth') {
                    const boothRecords = await db.photobooth.where('billNo').equals(order.billNo).toArray();
                    for (let br of boothRecords) {
                        await db.photobooth.delete(br.id);
                    }
                }
                await db.orders.delete(id);
                showToast('Bill deleted permanently!', 'success');
                await loadBills();
                await loadDashboardStats();
            }
        });
    });
}

function resetSystem() {
    requireAdminAuth(async () => {
        Swal.fire({
            title: 'Are you absolutely sure?',
            text: 'This will wipe all data including orders, inventory, and events.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: 'Yes, delete it!'
        }).then(async (result) => {
            if (result.isConfirmed) {
                await db.delete();
                showToast('System Reset Complete. Reloading...', 'success');
                setTimeout(() => window.location.reload(), 1500);
            }
        });
    });
}

// ==========================================
// EVENTS CALENDAR
// ==========================================
function calculateEventBalance() {
    const priceEl = document.getElementById('evt-price');
    if (!priceEl) return;
    const total = parseFloat(priceEl.value) || 0;
    const status = document.getElementById('evt-payment-status').value;

    let advance = 0;
    if (status === 'Advance') {
        advance = parseFloat(document.getElementById('evt-advance-amount').value) || 0;
    } else if (status === 'Full') {
        advance = total;
    }

    const balance = Math.max(0, total - advance);
    document.getElementById('evt-balance-due').innerText = formatCurrency(balance);
}

function toggleEventAdvance() {
    const status = document.getElementById('evt-payment-status').value;
    const container = document.getElementById('evt-advance-container');
    if (!container) return;
    if (status === 'Advance') {
        container.classList.remove('hide');
    } else {
        container.classList.add('hide');
        document.getElementById('evt-advance-amount').value = 0;
    }
    calculateEventBalance();
}

async function addEvent() {
    const title = document.getElementById('evt-title').value.trim();
    const dateStr = document.getElementById('evt-date').value;
    const timeStr = document.getElementById('evt-time').value;
    const venue = document.getElementById('evt-venue').value.trim();
    const pkg = document.getElementById('evt-package').value;
    const reminder = document.getElementById('evt-reminder').checked;

    // Pricing
    const priceEl = document.getElementById('evt-price');
    const price = priceEl ? (parseFloat(priceEl.value) || 0) : 0;
    const paymentStatus = document.getElementById('evt-payment-status') ? document.getElementById('evt-payment-status').value : 'Pending';
    const advanceAmount = document.getElementById('evt-advance-amount') ? (parseFloat(document.getElementById('evt-advance-amount').value) || 0) : 0;

    if (!title || !dateStr) {
        showToast('Title and Date are required', 'warning');
        return;
    }

    if (paymentStatus === 'Advance' && price > 0) {
        if (advanceAmount < (price * 0.5)) {
            Swal.fire({
                icon: 'error',
                title: 'Insufficient Advance',
                text: `Advance payment must be at least 50% of the total event price (${formatCurrency(price * 0.5)}).`
            });
            return;
        }
    }

    await db.events.add({
        title,
        eventDate: dateStr,
        eventTime: timeStr,
        venue,
        packageType: pkg,
        price,
        paymentStatus,
        advanceAmount: paymentStatus === 'Advance' ? advanceAmount : (paymentStatus === 'Full' ? price : 0),
        reminder
    });

    showToast('Event Saved!');

    document.getElementById('evt-title').value = '';
    document.getElementById('evt-date').value = '';
    document.getElementById('evt-time').value = '';
    document.getElementById('evt-venue').value = '';

    if (priceEl) {
        priceEl.value = 0;
        document.getElementById('evt-payment-status').value = 'Pending';
        toggleEventAdvance();
    }

    await loadCalendarEvents();
    await loadUpcomingEvents();
}

async function loadCalendarEvents() {
    const events = await db.events.orderBy('eventDate').toArray();
    const list = document.getElementById('calendar-events-list');
    list.innerHTML = '';

    if (events.length === 0) {
        list.innerHTML = '<p class="text-gray-500 italic">No events scheduled.</p>';
        return;
    }

    events.forEach(evt => {
        const item = document.createElement('div');
        item.className = 'bg-gray-800/80 border border-gray-700 rounded-xl p-4 flex justify-between items-center';

        const dateObj = new Date(evt.eventDate);
        const formatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

        const priceValue = evt.price || 0;
        const advValue = evt.advanceAmount || 0;
        const balValue = Math.max(0, priceValue - advValue);

        let statusBadge = '';
        if (evt.paymentStatus === 'Full') {
            statusBadge = '<span class="bg-green-500/20 text-green-400 px-2 py-0.5 rounded text-xs ml-3 border border-green-500/30">Full Paid</span>';
        } else if (evt.paymentStatus === 'Advance') {
            statusBadge = `<span class="bg-yellow-500/20 text-yellow-500 px-2 py-0.5 rounded text-xs ml-3 border border-yellow-500/30">Advance Paid</span>`;
        } else {
            statusBadge = '<span class="bg-red-500/20 text-red-500 px-2 py-0.5 rounded text-xs ml-3 border border-red-500/30">Pending</span>';
        }

        item.innerHTML = `
            <div class="flex-1 pr-4">
                <div class="flex items-center flex-wrap gap-y-2">
                    <h4 class="text-white font-medium text-lg leading-tight tracking-wide">${evt.title}</h4>
                    ${priceValue > 0 ? statusBadge : ''}
                </div>
                <div class="text-sm text-gray-400 mt-1.5 flex flex-wrap items-center gap-y-2 gap-x-4">
                    <span><i class="ph ph-calendar text-gray-500"></i> ${dateObj.toLocaleDateString(undefined, formatOptions)} ${evt.eventTime ? `<span class="ml-2 bg-gray-700 font-mono px-2 py-0.5 rounded text-xs text-white"><i class="ph ph-clock"></i> ${evt.eventTime}</span>` : ''}</span>
                    <span><i class="ph ph-map-pin text-gray-500"></i> ${evt.venue || 'N/A'}</span>
                    <span class="text-brand font-semibold tracking-wider bg-brand/10 px-2 py-0.5 rounded text-xs">${evt.packageType}</span>
                </div>
                ${priceValue > 0 ? `
                <div class="mt-3 bg-[#1e293b]/50 rounded-xl p-3 border border-gray-700/50 flex flex-wrap gap-x-6 gap-y-2 text-xs backdrop-blur-sm">
                    <div class="flex flex-col"><span class="text-gray-500 font-medium uppercase tracking-widest text-[9px] mb-0.5">Total Price</span> <span class="text-white font-bold text-sm bg-gray-800 px-2 py-0.5 rounded-md inline-block w-max">${formatCurrency(priceValue)}</span></div>
                    <div class="flex flex-col"><span class="text-gray-500 font-medium uppercase tracking-widest text-[9px] mb-0.5">Paid</span> <span class="text-green-400 font-bold text-sm bg-green-500/10 px-2 py-0.5 rounded-md inline-block w-max">${formatCurrency(advValue)}</span></div>
                    <div class="flex flex-col"><span class="text-gray-500 font-medium uppercase tracking-widest text-[9px] mb-0.5">Balance Due</span> <span class="text-red-400 font-bold text-sm bg-red-500/10 px-2 py-0.5 rounded-md inline-block w-max">${formatCurrency(balValue)}</span></div>
                </div>
                ` : ''}
            </div>
            <button onclick="deleteEvent('${evt.id}')" class="text-gray-500 hover:text-red-500 bg-gray-900 border border-gray-700 hover:border-red-500 w-10 h-10 rounded-xl flex items-center justify-center transition-all shrink-0">
                <i class="ph ph-trash text-xl"></i>
            </button>
        `;
        list.appendChild(item);
    });
}

async function loadUpcomingEvents() {
    const today = new Date().toISOString().split('T')[0];
    const events = await db.events.where('eventDate').aboveOrEqual(today).toArray();

    events.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));

    const topEvents = events.slice(0, 4);
    const listEl = document.getElementById('upcoming-events-list');
    listEl.innerHTML = '';

    if (topEvents.length === 0) {
        listEl.innerHTML = '<p class="text-gray-500 text-sm italic">No upcoming events...</p>';
        return;
    }

    topEvents.forEach(evt => {
        const dateObj = new Date(evt.eventDate);
        const isToday = evt.eventDate === today;
        const color = isToday ? 'text-brand' : 'text-blue-400';
        const bg = isToday ? 'bg-brand/10' : 'bg-blue-400/10';

        const item = document.createElement('div');
        item.className = 'bg-gray-800 border border-gray-700 rounded-lg p-3 flex justify-between items-center';
        item.innerHTML = `
            <div class="flex-1">
                <h4 class="text-gray-200 text-sm font-medium ${isToday ? 'text-brand' : ''}">${evt.title}</h4>
                <p class="text-xs text-gray-500 mt-0.5">${evt.venue || 'N/A'}</p>
            </div>
            <div class="text-right">
                <div class="text-xs font-bold ${color} ${bg} px-2 py-1 rounded">
                    ${isToday ? 'TODAY' : dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </div>
            </div>
        `;
        listEl.appendChild(item);
    });
}

async function deleteEvent(id) {
    if (confirm('Are you sure you want to delete this event?')) {
        await db.events.delete(id);
        await loadCalendarEvents();
        await loadUpcomingEvents();
    }
}

// ==========================================
// DASHBOARD STATS
// ==========================================
async function loadDashboardStats() {
    const today = new Date().toISOString().split('T')[0];

    const allOrders = await db.orders.toArray();
    const todayOrders = allOrders.filter(o => o.date.startsWith(today) && o.paymentStatus !== 'Reversed');

    const sumAdvancePending = allOrders.reduce((sum, o) => {
        if (o.paymentStatus === 'Reversed') return sum;
        const totalAmt = parseFloat(o.totalAmount) || 0;
        const advAmt = parseFloat(o.advanceAmount) || 0;
        if (o.paymentStatus === 'Advance') return sum + Math.max(0, totalAmt - advAmt);
        if (o.paymentStatus === 'Credit') return sum + totalAmt;
        return sum;
    }, 0);

    const todayIncome = todayOrders.reduce((sum, o) => {
        const totalAmt = parseFloat(o.totalAmount) || 0;
        const advAmt = parseFloat(o.advanceAmount) || 0;
        if (o.paymentStatus === 'Paid') return sum + totalAmt;
        if (o.paymentStatus === 'Advance') return sum + advAmt;
        return sum;
    }, 0);
    document.getElementById('stat-today-income').innerText = formatCurrency(todayIncome);

    if (document.getElementById('stat-advance-income')) {
        document.getElementById('stat-advance-income').innerText = formatCurrency(sumAdvancePending);
    }
    if (document.getElementById('stat-total-payables')) {
        const moneybookRecords = await db.moneybook.toArray();
        let payables = 0;
        moneybookRecords.forEach(m => {
            if (m.type === 'Payable') payables += parseFloat(m.amount || 0);
            else if (m.type === 'Settle') payables -= parseFloat(m.amount || 0);

            if (m.type === 'Inventory' && m.subType === 'Purchase') payables += parseFloat(m.naya || 0);
            if (m.type === 'Inventory' && m.subType === 'Installment') payables -= parseFloat(m.amount || 0);
        });
        document.getElementById('stat-total-payables').innerText = formatCurrency(Math.max(0, payables));
    }

    let totalPrints = 0;
    let totalFrames = 0;
    let boothSessions = 0;

    const allBooth = await db.photobooth.toArray();
    const todayBooth = allBooth.filter(b => b.timestamp.startsWith(today));
    boothSessions = todayBooth.length;

    todayOrders.forEach(o => {
        o.items.forEach(item => {
            const nameLower = item.name.toLowerCase();
            if (nameLower.includes('print') || nameLower.includes('strip') || nameLower.includes('wallet')) {
                totalPrints += item.qty;
            }
            if (nameLower.includes('frame')) {
                totalFrames += item.qty;
            }
        });
    });

    document.getElementById('stat-total-prints').innerText = totalPrints;
    document.getElementById('stat-total-frames').innerText = totalFrames;
    document.getElementById('stat-total-booth').innerText = boothSessions;

    drawIncomeChart(allOrders);
}

function drawIncomeChart(allOrders) {
    const ctx = document.getElementById('incomeChart').getContext('2d');

    const last7Days = [];
    const _MS_PER_DAY = 1000 * 60 * 60 * 24;
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
        const d = new Date(now.getTime() - i * _MS_PER_DAY);
        last7Days.push(d.toISOString().split('T')[0]);
    }

    const incomeData = [0, 0, 0, 0, 0, 0, 0];

    allOrders.forEach(o => {
        if (o.paymentStatus === 'Reversed') return;
        const oDate = o.date.split('T')[0];
        const idx = last7Days.indexOf(oDate);
        if (idx !== -1) {
            const totalAmt = parseFloat(o.totalAmount) || 0;
            const advAmt = parseFloat(o.advanceAmount) || 0;
            if (o.paymentStatus === 'Paid') {
                incomeData[idx] += totalAmt;
            } else if (o.paymentStatus === 'Advance') {
                incomeData[idx] += advAmt;
            }
        }
    });

    const displayLabels = last7Days.map(d => {
        const dateObj = new Date(d);
        return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });

    if (dashboardChart) {
        dashboardChart.destroy();
    }

    dashboardChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: displayLabels,
            datasets: [{
                label: 'Income (Rs.)',
                data: incomeData,
                borderColor: '#f43f5e',
                backgroundColor: 'rgba(244, 63, 94, 0.1)',
                borderWidth: 3,
                tension: 0.4,
                fill: true,
                pointBackgroundColor: '#fff',
                pointBorderColor: '#f43f5e',
                pointBorderWidth: 3,
                pointRadius: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

// ==========================================
// EXPORT CUSTOM REPORT
// ==========================================
function downloadCustomReport() {
    const fromD = document.getElementById('rep-from-date').value;
    const fromT = document.getElementById('rep-from-time').value || '00:00';
    const toD = document.getElementById('rep-to-date').value;
    const toT = document.getElementById('rep-to-time').value || '23:59';

    if (!fromD || !toD) {
        showToast('Please select From and To dates', 'warning');
        return;
    }

    const fromDate = new Date(`${fromD}T${fromT}:00`).getTime();
    const toDate = new Date(`${toD}T${toT}:59`).getTime();

    const filtered = allBills.filter(o => {
        const t = new Date(o.date).getTime();
        return t >= fromDate && t <= toDate && o.paymentStatus !== 'Reversed';
    });

    if (filtered.length === 0) {
        showToast('No records found in this range', 'info');
        return;
    }

    generateReportPDF(filtered, `${fromD} ${fromT}`, `${toD} ${toT}`);
}

function generateReportPDF(records, fromStr, toStr) {
    let totalBilled = 0;
    let totalCollected = 0;
    let totalAdvances = 0;

    const rows = records.map(o => {
        totalBilled += o.totalAmount;
        if (o.paymentStatus === 'Paid') {
            totalCollected += o.totalAmount;
        } else if (o.paymentStatus === 'Advance') {
            totalCollected += (o.advanceAmount || 0);
            totalAdvances += (o.totalAmount - (o.advanceAmount || 0));
        }

        const dObj = new Date(o.date);

        let itemsHtml = '';
        if (o.items && o.items.length > 0) {
            itemsHtml = o.items.map(item => `
                <div style="display:flex; justify-content:space-between; margin-bottom: 3px;">
                    <span style="color:#4b5563;">&bull; ${item.name} <strong style="color:#111827;">(x${item.qty})</strong></span>
                    <span style="color:#4b5563;">${formatCurrency(item.total)}</span>
                </div>
            `).join('');
        }

        return `
            <tr style="font-size:12px;background:#f9fafb;">
                <td style="padding:10px 8px 4px 8px;color:#374151;">${dObj.toLocaleDateString()} ${dObj.toLocaleTimeString()}</td>
                <td style="padding:10px 8px 4px 8px;font-weight:600;color:#111827;">${o.billNo}</td>
                <td style="padding:10px 8px 4px 8px;color:#111827;">${o.customerName || 'N/A'}</td>
                <td style="padding:10px 8px 4px 8px;color:#374151;">${o.customerPhone || 'N/A'}</td>
                <td style="padding:10px 8px 4px 8px;color:#374151;">${o.type.toUpperCase()}</td>
                <td style="padding:10px 8px 4px 8px;color:${o.paymentStatus === 'Paid' ? '#10b981' : (o.paymentStatus === 'Advance' ? '#f59e0b' : '#ef4444')};font-weight:600;">${o.paymentStatus}</td>
                <td style="padding:10px 8px 4px 8px;text-align:right;color:#111827;font-weight:600;">${formatCurrency(o.totalAmount)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;font-size:11px;">
                <td colspan="7" style="padding:0 8px 10px 8px;">
                    <div style="background:#ffffff; border-left:3px solid #f43f5e; padding: 6px 10px; margin-top:4px;">
                        ${itemsHtml || '<span style="color:#9ca3af;font-style:italic;">No items recorded</span>'}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    const html = `
    <div style="background:#fff;padding:40px;font-family:Arial, sans-serif;color:#1f2937;width:750px;box-sizing:border-box;">
        <div style="text-align:center;margin-bottom:30px;border-bottom:2px solid #f43f5e;padding-bottom:20px;">
            <h1 style="font-size:24px;font-weight:800;color:#111827;margin:0 0 5px 0;">PASSION PIXELS - Sales Report</h1>
            <p style="font-size:13px;color:#6b7280;margin:0;">Period: ${fromStr} to ${toStr}</p>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:30px;">
            <thead style="background:#1f2937;">
                <tr>
                    <th style="padding:12px 10px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Date & Time</th>
                    <th style="padding:12px 10px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Bill No</th>
                    <th style="padding:12px 10px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Customer Name</th>
                    <th style="padding:12px 10px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Contact</th>
                    <th style="padding:12px 10px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Type</th>
                    <th style="padding:12px 10px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Status</th>
                    <th style="padding:12px 10px;text-align:right;color:#fff;font-size:12px;text-transform:uppercase;">Amount</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>

        <div style="display:flex;justify-content:flex-end;">
            <div style="width:320px;background:#f9fafb;border-radius:8px;padding:20px;border:1px solid #e5e7eb;">
                <h3 style="margin:0 0 15px 0;font-size:14px;color:#374151;text-transform:uppercase;border-bottom:1px solid #d1d5db;padding-bottom:10px;">Summary Breakdowns</h3>
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:13px;">
                    <span style="color:#6b7280;">Total Billed</span>
                    <span style="font-weight:600;color:#111827;">${formatCurrency(totalBilled)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:13px;">
                    <span style="color:#6b7280;">Total Pending (Advances)</span>
                    <span style="font-weight:600;color:#f59e0b;">${formatCurrency(totalAdvances)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;margin-top:16px;padding-top:16px;border-top:1px solid #d1d5db;font-size:16px;">
                    <span style="font-weight:700;color:#111827;">Total Collected</span>
                    <span style="font-weight:800;color:#10b981;">${formatCurrency(totalCollected)}</span>
                </div>
            </div>
        </div>
        <div style="text-align:center;margin-top:50px;font-size:11px;color:#9ca3af;">
            Generated on ${new Date().toLocaleString()} by Passion Pixel POS System
        </div>
    </div>
    `;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-9999;';
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper);

    showToast('Generating Report PDF...', 'info');

    setTimeout(() => {
        const opt = {
            margin: [0, 0, 0, 0],
            filename: `SalesReport_${fromStr.replace(/[\s:]/g, "")}_to_${toStr.replace(/[\s:]/g, "")}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff' },
            jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
        };
        html2pdf().set(opt).from(wrapper.firstElementChild).save().then(() => {
            document.body.removeChild(wrapper);
            showToast('Download Complete!', 'success');
        });
    }, 500);
}

// ==========================================
// PROFIT & LOSS REPORT
// ==========================================
async function downloadProfitLossReport() {
    const fromVal = document.getElementById('pl-from-date').value;
    const toVal = document.getElementById('pl-to-date').value;

    if (!fromVal || !toVal) {
        showToast('Please select From and To dates', 'warning');
        return;
    }

    const fromDateObj = new Date(fromVal);
    fromDateObj.setHours(0, 0, 0, 0);
    const toDateObj = new Date(toVal);
    toDateObj.setHours(23, 59, 59, 999);

    const orders = await db.orders.orderBy('date').reverse().toArray();
    
    // Filter orders
    const validOrders = orders.filter(o => {
        const d = new Date(o.date);
        return d >= fromDateObj && d <= toDateObj && o.paymentStatus !== 'Reversed';
    });

    if (validOrders.length === 0) {
        showToast('No orders found in this period', 'info');
        return;
    }
    let totalRevenue = 0;
    let totalBuyingCost = 0;
    let totalDiscounts = 0;

    validOrders.forEach(o => {
        totalRevenue += o.totalAmount;
        let tbc = o.totalBuyingCost || 0;
        totalBuyingCost += tbc; // Still calculated for info if needed, but not deducted
        let disc = o.discountAmount || 0;
        totalDiscounts += disc;
    });

    const netProfit = totalRevenue; // Cash basis: gross profit is full revenue

    // We can also fetch Money Book Expenses & Income for the period!
    const moneybookRecords = await db.moneybook.toArray();
    let mbIncome = 0;
    let mbExpense = 0;
    
    let invCashPaid = 0;
    let newBorrowing = 0;
    let debtSettled = 0;
    let totalPayables = 0;

    moneybookRecords.forEach(m => {
        // Calculate All-Time Debt/Payables
        if (m.type === 'Payable') totalPayables += parseFloat(m.amount || 0);
        else if (m.type === 'Settle') totalPayables -= parseFloat(m.amount || 0);
        
        if (m.type === 'Inventory' && m.subType === 'Purchase') totalPayables += parseFloat(m.naya || 0);
        if (m.type === 'Inventory' && m.subType === 'Installment') totalPayables -= parseFloat(m.amount || 0);

        const d = new Date(m.date);
        if (d >= fromDateObj && d <= toDateObj) {
            if (m.type === 'Income' || m.type === 'Income (Athata aawa)') {
                mbIncome += m.amount;
            } else if (m.type === 'Expense' || m.type === 'Expense (Viyadam)') {
                mbExpense += m.amount;
            } else if (m.type === 'Inventory' && m.subType === 'Purchase') {
                let cashPaid = parseFloat(m.amount || 0);
                invCashPaid += cashPaid;
                mbExpense += cashPaid; // Deduct advance from profit
                newBorrowing += parseFloat(m.naya || 0);
            } else if (m.type === 'Inventory' && m.subType === 'Installment') {
                let cashPaid = parseFloat(m.amount || 0);
                debtSettled += cashPaid;
                mbExpense += cashPaid; // Deduct installment from profit
            } else if (m.type === 'Payable') {
                newBorrowing += parseFloat(m.amount || 0);
            } else if (m.type === 'Settle') {
                let cashPaid = parseFloat(m.amount || 0);
                debtSettled += cashPaid;
                mbExpense += cashPaid; // Deduct settlement from profit
            }
        }
    });

    totalPayables = Math.max(0, totalPayables);
    const finalNetProfit = netProfit + mbIncome - mbExpense;

    const html = `
    <div style="background:#fff;padding:40px;font-family:Arial, sans-serif;color:#1f2937;width:750px;box-sizing:border-box;">
        <div style="text-align:center;margin-bottom:30px;border-bottom:2px solid #f43f5e;padding-bottom:20px;">
            <h1 style="font-size:24px;font-weight:800;color:#111827;margin:0 0 5px 0;">PASSION PIXELS - Profit & Loss Statement</h1>
            <p style="font-size:13px;color:#6b7280;margin:0;">Period: ${fromVal} to ${toVal}</p>
        </div>

        <h3 style="margin:0 0 10px 0;font-size:16px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:5px;">1. Sales Income & Cost of Goods Sold</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
            <tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:10px 5px;color:#374151;">Gross Sales Revenue (Before Discounts)</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#374151;">${formatCurrency(totalRevenue + totalDiscounts)}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:10px 5px;color:#374151;">Less: Total Discounts Given</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#ef4444;">- ${formatCurrency(totalDiscounts)}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:10px 5px;color:#374151;font-weight:600;">Net Sales Revenue (All Pos)</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#10b981;">${formatCurrency(totalRevenue)}</td>
            </tr>
            <tr style="background:#f9fafb;">
                <td style="padding:10px 5px;font-weight:700;color:#111827;">Gross Profit from Sales</td>
                <td style="padding:10px 5px;text-align:right;font-weight:800;color:#111827;">${formatCurrency(netProfit)}</td>
            </tr>
        </table>

        <h3 style="margin:0 0 10px 0;font-size:16px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:5px;">2. Money Book (Other Income & Expenses)</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
            <tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:10px 5px;color:#374151;">Add: Other Income (Money Book)</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#10b981;">+ ${formatCurrency(mbIncome)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:10px 5px;color:#374151;">Less: Other Expenses (Money Book)</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#ef4444;">- ${formatCurrency(mbExpense)}</td>
            </tr>
        </table>

        <div style="background:${finalNetProfit >= 0 ? '#ecfdf5' : '#fef2f2'}; border:1px solid ${finalNetProfit >= 0 ? '#10b981' : '#ef4444'}; border-radius:8px; padding:20px; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:18px;font-weight:800;color:${finalNetProfit >= 0 ? '#10b981' : '#ef4444'};">${finalNetProfit >= 0 ? 'Net Profit' : 'Net Loss'}</span>
            <span style="font-size:22px;font-weight:900;color:${finalNetProfit >= 0 ? '#10b981' : '#ef4444'};">${finalNetProfit >= 0 ? '' : '- '}${formatCurrency(Math.abs(finalNetProfit))}</span>
        </div>

        <h3 style="margin:25px 0 10px 0;font-size:16px;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:5px;">3. Inventory & Supplier Debt Activities (This Period)</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:30px;font-size:14px;">
            <tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:10px 5px;color:#374151;">Cash Paid for New Inventory (Advances/Full)</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#ef4444;">${formatCurrency(invCashPaid)}</td>
            </tr>
            <tr style="border-bottom:1px solid #f3f4f6;">
                <td style="padding:10px 5px;color:#374151;">Cash Paid to Settle Past Debts (Installments)</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#ef4444;">${formatCurrency(debtSettled)}</td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
                <td style="padding:10px 5px;color:#374151;">New Borrowings (Debt Taken for Purchases)</td>
                <td style="padding:10px 5px;text-align:right;font-weight:600;color:#f59e0b;">${formatCurrency(newBorrowing)}</td>
            </tr>
            <tr>
                 <td colspan="2" style="font-size:11px;color:#6b7280;padding:5px;font-style:italic;">* Note: Cash Paid for Inventory/Installments is already deducted from Net Profit. New Borrowings (Debts) do NOT reduce Net Profit until paid.</td>
            </tr>
        </table>

        <div style="margin-top:20px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:15px 20px; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <span style="display:block; font-size:15px; font-weight:700; color:#92400e;">Total Borrowings (Debt)</span>
                 <span style="display:block; font-size:12px; color:#b45309; margin-top:2px;">Total Outstanding Debt to Suppliers (All-Time)</span>
            </div>
            <span style="font-size:20px;font-weight:800;color:#92400e;">${formatCurrency(totalPayables)}</span>
        </div>

        <div style="text-align:center;margin-top:50px;font-size:11px;color:#9ca3af;">
            Generated on ${new Date().toLocaleString()} by Passion Pixel POS System
        </div>
    </div>
    `;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-9999;';
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper);
    showToast('Generating Profit/Loss PDF...', 'info');

    setTimeout(() => {
        const opt = {
            margin: [0, 0, 0, 0],
            filename: `Profit_Loss_${fromVal}_to_${toVal}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true, logging: false },
            jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
        };
        html2pdf().set(opt).from(wrapper.firstElementChild).save().then(() => {
            document.body.removeChild(wrapper);
            showToast('Download Complete!', 'success');
        });
    }, 500);
}

// ==========================================
// MONEY BOOK (INCOME & EXPENSES)
// ==========================================
async function loadMoneyBook() {
    const today = new Date();
    const currentMonth = today.toISOString().slice(0, 7);
    const filterEl = document.getElementById('mb-filter-month');
    if (!filterEl.value) {
        filterEl.value = currentMonth;
    }
    const d = new Date();
    document.getElementById('mb-date').value = d.toISOString().slice(0, 10);
    filterMoneyBook();
}

async function filterMoneyBook() {
    const month = document.getElementById('mb-filter-month').value; // YYYY-MM
    let mbRecords = await db.moneybook.toArray();
    mbRecords.sort((a,b) => new Date(b.date) - new Date(a.date));

    let filtered = mbRecords;
    if (month) {
        filtered = mbRecords.filter(m => m.date.startsWith(month));
    }

    renderMoneyBookTable(filtered, mbRecords);
}

function renderMoneyBookTable(records, allRecords) {
    const tbody = document.getElementById('mb-list-tbody');
    tbody.innerHTML = '';
    
    let totalIncome = 0;
    let totalExpense = 0;

    let totalPayablesAllTime = 0;
    
    if(allRecords) {
        allRecords.forEach(r => {
            if (r.type === 'Payable') totalPayablesAllTime += r.amount;
            else if (r.type === 'Settle') totalPayablesAllTime -= r.amount;

            if (r.type === 'Inventory' && r.subType === 'Purchase') totalPayablesAllTime += parseFloat(r.naya || 0);
            if (r.type === 'Inventory' && r.subType === 'Installment') totalPayablesAllTime -= parseFloat(r.amount || 0);
        });
    }

    if (records.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-gray-500 italic">No records found.</td></tr>`;
    } else {
        records.forEach(r => {
            let amountHtml = '';
            let typeLabel = '';
            let amountDisplay = formatCurrency(r.amount);
            
            if (r.type === 'Income' || r.type === 'Income (Athata aawa)') {
                totalIncome += r.amount;
                typeLabel = '<span class="text-green-400 bg-green-400/10 px-2 py-1 rounded text-xs">Income</span>';
                amountHtml = `<span class="text-green-400 font-medium">+ ${amountDisplay}</span>`;
            } else if (r.type === 'Payable') {
                typeLabel = '<span class="text-blue-400 bg-blue-400/10 px-2 py-1 rounded text-xs">Credit Purchase</span>';
                const bal = r.amount - (r.paidAmount || 0);
                amountHtml = `
                    <div class="text-[11px] text-right">
                        <div>Total: <span class="text-gray-300 font-medium">${formatCurrency(r.amount)}</span></div>
                        <div>Paid: <span class="text-green-400 font-medium">${formatCurrency(r.paidAmount || 0)}</span></div>
                        <div class="mt-1 border-t border-gray-700/50 pt-1">Due: <span class="text-red-400 font-bold">${formatCurrency(bal)}</span></div>
                    </div>
                `;
            } else if (r.type === 'Settle') {
                totalExpense += r.amount; // Settlement is cash out
                typeLabel = '<span class="text-yellow-400 bg-yellow-400/10 px-2 py-1 rounded text-xs">Credit Settle</span>';
                amountHtml = `<span class="text-red-400 font-medium">- ${amountDisplay}</span>`;
            } else if (r.type === 'Inventory') {
                totalExpense += r.amount;
                typeLabel = '<span class="text-teal-400 bg-teal-400/10 px-2 py-1 rounded text-xs">Inventory Purchase</span>';
                amountHtml = `<span class="text-red-400 font-medium">- ${amountDisplay}</span>`;
            } else {
                // Treats 'Expense' and any legacy values as generic Expense
                totalExpense += r.amount;
                typeLabel = '<span class="text-red-400 bg-red-400/10 px-2 py-1 rounded text-xs">Expense</span>';
                amountHtml = `<span class="text-red-400 font-medium">- ${amountDisplay}</span>`;
            }

            let actionButtons = `<button onclick="deleteMoneyBookEntry('${r.id}')" class="text-gray-500 hover:text-red-500 transition-colors p-2"><i class="ph ph-trash text-lg"></i></button>`;
            
            if (r.type === 'Payable' && (r.amount - (r.paidAmount || 0)) > 0) {
                const descEscaped = r.description ? r.description.replace(/'/g, "\\'") : '';
                actionButtons = `
                    <button onclick="promptUpdatePayable('${r.id}', '${descEscaped}', ${r.amount - (r.paidAmount || 0)})" class="text-blue-400 hover:text-blue-500 transition-colors p-2" title="Settle/Pay Balance"><i class="ph ph-hand-coins text-lg"></i></button>
                    ${actionButtons}
                `;
            }

            const tr = document.createElement('tr');
            tr.className = 'border-b border-gray-800 text-gray-300';
            tr.innerHTML = `
                <td class="py-3">${r.date}</td>
                <td class="py-3">
                    ${r.description}
                </td>
                <td class="py-3 text-center">${typeLabel}</td>
                <td class="py-3 text-right">${amountHtml}</td>
                <td class="py-3 text-right">
                    <div class="flex justify-end items-center gap-1">
                        ${actionButtons}
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    document.getElementById('mb-summary-income').innerText = formatCurrency(totalIncome);
    document.getElementById('mb-summary-expense').innerText = formatCurrency(totalExpense);
    
    const balance = totalIncome - totalExpense;
    const balanceEl = document.getElementById('mb-summary-balance');
    balanceEl.innerText = formatCurrency(balance);
    if(balance < 0) balanceEl.className = 'text-red-500 font-bold text-xl';
    else balanceEl.className = 'text-brand font-bold text-xl';

    const payableEl = document.getElementById('mb-summary-payable');
    if (payableEl) {
        payableEl.innerText = formatCurrency(Math.max(0, totalPayablesAllTime));
    }
}

window.toggleMbAdvance = function() {
    const type = document.getElementById('mb-type').value;
    const invOptions = document.getElementById('mb-inventory-options');
    const nayaContainer = document.getElementById('mb-inv-naya-container');
    const label = document.getElementById('mb-amount-label');

    if (type === 'Inventory') {
        if(invOptions) invOptions.classList.remove('hide');
        const action = document.getElementById('mb-inv-action').value;
        if (action === 'Purchase') {
            if(nayaContainer) nayaContainer.classList.remove('hide');
            if(label) label.innerText = 'Amount Paid Now (Rs.)';
        } else {
            if(nayaContainer) nayaContainer.classList.add('hide');
            if(label) label.innerText = 'Installment Amount Paid (Rs.)';
            const nayaInput = document.getElementById('mb-inv-naya');
            if(nayaInput) nayaInput.value = 0;
        }
    } else {
        if(invOptions) invOptions.classList.add('hide');
        if(nayaContainer) nayaContainer.classList.add('hide');
        if(label) label.innerText = 'Amount (Rs.)';
        const nayaInput = document.getElementById('mb-inv-naya');
        if(nayaInput) nayaInput.value = 0;
    }

    const oldAdvContainer = document.getElementById('mb-advance-container');
    if(oldAdvContainer) oldAdvContainer.classList.add('hide');
}

async function addMoneyBookEntry() {
    const date = document.getElementById('mb-date').value;
    const type = document.getElementById('mb-type').value;
    const desc = document.getElementById('mb-desc').value.trim();
    const amount = parseFloat(document.getElementById('mb-amount').value);

    const invAction = document.getElementById('mb-inv-action') ? document.getElementById('mb-inv-action').value : 'Purchase';
    const naya = parseFloat(document.getElementById('mb-inv-naya') ? document.getElementById('mb-inv-naya').value : 0) || 0;

    if(!date || !type || !desc || isNaN(amount) || (type !== 'Inventory' && amount <= 0)) {
        showToast('Please fill all valid details', 'warning');
        return;
    }

    if (type === 'Inventory') {
        await db.moneybook.add({
            date,
            type: 'Inventory',
            subType: invAction,
            description: desc,
            amount: amount,
            naya: (invAction === 'Purchase') ? naya : 0,
            timestamp: new Date().toISOString()
        });
    } else {
        await db.moneybook.add({ date, type, description: desc, amount, timestamp: new Date().toISOString() });
    }

    showToast('Entry Added successfully', 'success');

    document.getElementById('mb-desc').value = '';
    document.getElementById('mb-amount').value = '0';
    if(document.getElementById('mb-inv-naya')) {
        document.getElementById('mb-inv-naya').value = '0';
    }
    window.toggleMbAdvance();
    filterMoneyBook();
}

window.promptUpdatePayable = function(id, desc, balance) {
    Swal.fire({
        title: 'Settle Supplier Payment',
        html: `
            <div class="mb-4 text-sm text-gray-400 text-left bg-gray-800 p-3 rounded">Paying for: <b>${desc}</b><br>Current Due: <b class="text-brand">Rs. ${parseFloat(balance).toLocaleString()}</b></div>
            <input type="number" id="payable-settle-amount" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white focus:border-brand outline-none" placeholder="Payment Amount (Rs.)" min="1" max="${balance}">
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonColor: '#f43f5e',
        cancelButtonColor: '#374151',
        confirmButtonText: 'Pay Now',
        background: '#1f2937',
        color: '#fff',
        preConfirm: () => {
            const amt = parseFloat(document.getElementById('payable-settle-amount').value);
            if (!amt || amt <= 0 || amt > balance) {
                Swal.showValidationMessage('Enter a valid amount up to ' + balance);
                return null;
            }
            return amt;
        }
    }).then(async (res) => {
        if (res.isConfirmed) {
            const paymentAmt = res.value;
            const payable = await db.moneybook.get(id);
            if (payable) {
                payable.paidAmount = (payable.paidAmount || 0) + paymentAmt;
                payable.balanceDue = payable.amount - payable.paidAmount;
                await db.moneybook.update(id, payable);
                
                await db.moneybook.add({
                    date: new Date().toISOString().slice(0, 10),
                    type: 'Settle',
                    description: `Payment towards: ${payable.description}`,
                    amount: paymentAmt,
                    linkedPayableId: id
                });
                showToast('Payment Settled!', 'success');
                filterMoneyBook();
            }
        }
    });
}

function deleteMoneyBookEntry(id) {
    requireAdminAuth(async () => {
        const entry = await db.moneybook.get(id);
        if (entry) {
            if (entry.type === 'Settle' && entry.linkedPayableId) {
                const payable = await db.moneybook.get(entry.linkedPayableId);
                if (payable) {
                    payable.paidAmount = Math.max(0, (payable.paidAmount || 0) - entry.amount);
                    payable.balanceDue = payable.amount - payable.paidAmount;
                    await db.moneybook.update(payable.id, payable);
                }
            } else if (entry.type === 'Payable') {
                const all = await db.moneybook.toArray();
                const linked = all.filter(x => x.linkedPayableId === entry.id);
                for(let l of linked) {
                    await db.moneybook.delete(l.id);
                }
            }
        }
        await db.moneybook.delete(id);
        showToast('Entry deleted', 'info');
        filterMoneyBook();
    });
}

function downloadMoneyBookReport() {
    requireAdminAuth(async () => {
        const month = document.getElementById('mb-filter-month').value;
        const records = await db.moneybook.toArray();
        const filtered = month ? records.filter(m => m.date.startsWith(month)) : records;
        
        if (filtered.length === 0) {
             showToast('No records to print.', 'warning');
             return;
        }

        filtered.sort((a,b) => new Date(a.date) - new Date(b.date));

        let totInc = 0; let totExp = 0;
        const rows = filtered.map((r, index) => {
            let amountInc = '';
            let amountExp = '';
            
            if (r.type === 'Income' || r.type === 'Income (Athata aawa)') {
                totInc += r.amount;
                amountInc = formatCurrency(r.amount);
            } else if (r.type === 'Payable') {
                // Does not affect immediate cash
            } else {
                totExp += r.amount;
                amountExp = formatCurrency(r.amount);
            }

            return `
                <tr style="border-bottom:1px solid #e5e7eb;font-size:12px;background:${index % 2 === 0 ? '#ffffff' : '#f9fafb'};">
                    <td style="padding:10px 14px;color:#374151;">${r.date}</td>
                    <td style="padding:10px 14px;color:#111827;font-weight:600;">${r.description} <span style="color:#9ca3af;font-size:10px;font-weight:normal;">(${r.type})</span></td>
                    <td style="padding:10px 14px;text-align:right;color:#10b981;font-weight:600;">${amountInc}</td>
                    <td style="padding:10px 14px;text-align:right;color:#ef4444;font-weight:600;">${amountExp}</td>
                </tr>
            `;
        }).join('');

        const html = `
        <div style="background:#fff;padding:40px;font-family:Arial, sans-serif;color:#1f2937;width:750px;box-sizing:border-box;">
            <div style="text-align:center;margin-bottom:30px;border-bottom:2px solid #3b82f6;padding-bottom:20px;">
                <h1 style="font-size:24px;font-weight:800;color:#111827;margin:0 0 5px 0;">PASSION PIXELS - Money Book</h1>
                <p style="font-size:13px;color:#6b7280;margin:0;">Month: ${month || 'All Time'}</p>
            </div>

            <table style="width:100%;border-collapse:collapse;margin-bottom:30px;">
                <thead style="background:#1f2937;">
                    <tr>
                        <th style="padding:12px 14px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Date</th>
                        <th style="padding:12px 14px;text-align:left;color:#fff;font-size:12px;text-transform:uppercase;">Description</th>
                        <th style="padding:12px 14px;text-align:right;color:#fff;font-size:12px;text-transform:uppercase;">Income</th>
                        <th style="padding:12px 14px;text-align:right;color:#fff;font-size:12px;text-transform:uppercase;">Expense</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>

            <div style="display:flex;justify-content:flex-end;">
                <div style="width:320px;background:#f9fafb;border-radius:8px;padding:20px;border:1px solid #e5e7eb;">
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:14px;">
                        <span style="color:#6b7280;">Total Income</span>
                        <span style="font-weight:600;color:#10b981;">${formatCurrency(totInc)}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:10px;font-size:14px;">
                        <span style="color:#6b7280;">Total Expense</span>
                        <span style="font-weight:600;color:#ef4444;">${formatCurrency(totExp)}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;border-top:1px solid #d1d5db;padding-top:15px;margin-top:10px;font-size:18px;">
                        <span style="font-weight:700;color:#111827;">Net Balance</span>
                        <span style="font-weight:800;color:${totInc - totExp >= 0 ? '#2563eb' : '#ef4444'};">${formatCurrency(totInc - totExp)}</span>
                    </div>
                </div>
            </div>
            <div style="text-align:center;margin-top:50px;font-size:11px;color:#9ca3af;">
                Generated on ${new Date().toLocaleString()} by Passion Pixel POS System
            </div>
        </div>
        `;
        
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:fixed;left:-9999px;top:0;z-index:-9999;';
        wrapper.innerHTML = html;
        document.body.appendChild(wrapper);

        showToast('Generating Money Book PDF...', 'info');

        setTimeout(() => {
            const opt = {
                margin: [0, 0, 0, 0],
                filename: `MoneyBook_${month||'All'}.pdf`,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: { scale: 2, useCORS: true, logging: false },
                jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
            };
            html2pdf().set(opt).from(wrapper.firstElementChild).save().then(() => {
                document.body.removeChild(wrapper);
                showToast('Download Complete!', 'success');
            });
        }, 500);
    });
}

// ==========================================
// ALBUM SECTION logic
// ==========================================

function generateAlbumBillNo() {
    albumCurrentBillNo = generateBillNo('PP-AL');
    const el = document.getElementById('album-bill-no');
    if (el) el.innerText = albumCurrentBillNo;
}

function toggleAlbumOptions() {
    const isCover = document.getElementById('album-cover-toggle').checked;
    const isBox = document.getElementById('album-box-toggle').checked;
    const isCreation = document.getElementById('album-creation-toggle').checked;

    const coverContainer = document.getElementById('album-cover-container');
    const boxContainer = document.getElementById('album-box-container');
    const creationContainer = document.getElementById('album-creation-container');

    if (isCover) {
        coverContainer.classList.remove('opacity-30', 'pointer-events-none');
    } else {
        coverContainer.classList.add('opacity-30', 'pointer-events-none');
        document.getElementById('album-cover-price').value = 0;
    }

    if (isBox) {
        boxContainer.classList.remove('opacity-30', 'pointer-events-none');
    } else {
        boxContainer.classList.add('opacity-30', 'pointer-events-none');
        document.getElementById('album-box-price').value = 0;
    }

    if (isCreation) {
        creationContainer.classList.remove('opacity-30', 'pointer-events-none');
    } else {
        creationContainer.classList.add('opacity-30', 'pointer-events-none');
        document.getElementById('album-creation-pages').value = 0;
        document.getElementById('album-creation-price').value = 0;
    }
}

function calculateAlbumTotal() {
    const basePrice = Number(document.getElementById('album-page-price').value) || 0;

    const addSheetCount = Number(document.getElementById('album-add-sheet-count').value) || 0;
    const addSheetPrice = Number(document.getElementById('album-add-sheet-price').value) || 0;

    const coverPrice = document.getElementById('album-cover-toggle').checked ? (Number(document.getElementById('album-cover-price').value) || 0) : 0;
    const boxPrice = document.getElementById('album-box-toggle').checked ? (Number(document.getElementById('album-box-price').value) || 0) : 0;

    let creationTotal = 0;
    if (document.getElementById('album-creation-toggle').checked) {
        const cPages = Number(document.getElementById('album-creation-pages').value) || 0;
        const cPrice = Number(document.getElementById('album-creation-price').value) || 0;
        creationTotal = cPages * cPrice;
    }

    const subtotal = basePrice + (addSheetCount * addSheetPrice) + coverPrice + boxPrice + creationTotal;

    document.getElementById('album-subtotal').innerText = formatCurrency(subtotal);

    let discount = parseFloat(document.getElementById('album-discount').value) || 0;
    if (discount > subtotal) {
        discount = subtotal;
        document.getElementById('album-discount').value = discount;
    }
    const pct = subtotal > 0 ? ((discount / subtotal) * 100).toFixed(1) : 0;
    document.getElementById('album-discount-pct').innerText = `${pct}%`;

    const total = Math.max(0, subtotal - discount);

    document.getElementById('album-grand-total').innerText = formatCurrency(total);
    calculateAlbumBalance(total);
}

function toggleAlbumAdvance() {
    const status = document.getElementById('album-payment-status').value;
    const container = document.getElementById('album-advance-container');
    const input = document.getElementById('album-advance-amount');

    if (status === 'Advance') {
        container.classList.remove('hide');
        const str = document.getElementById('album-grand-total').innerText;
        const total = parseFloat(str.replace('Rs. ', '').replace(/,/g, '')) || 0;
        input.value = total * 0.5; // Auto-fill 50%
    } else {
        container.classList.add('hide');
        input.value = 0;
    }
    calculateAlbumTotal();
}

function calculateAlbumBalance(t = null) {
    let total = typeof t === 'number' ? t : null;
    if (total === null || isNaN(total)) {
        const str = document.getElementById('album-grand-total').innerText;
        total = parseFloat(str.replace('Rs. ', '').replace(/,/g, '')) || 0;
    }

    const status = document.getElementById('album-payment-status').value;

    let advance = 0;
    if (status === 'Advance') {
        advance = parseFloat(document.getElementById('album-advance-amount').value) || 0;
    } else if (status === 'Paid') {
        advance = total;
    } else if (status === 'Credit') {
        advance = 0;
    }

    const balance = Math.max(0, total - advance);
    document.getElementById('album-balance-due').innerText = formatCurrency(balance);
}

function clearAlbumForm() {
    document.getElementById('album-type').value = '';
    document.getElementById('album-size').value = '';
    document.getElementById('album-pages').value = 0;
    document.getElementById('album-page-price').value = 0;
    document.getElementById('album-add-sheet-count').value = 0;
    document.getElementById('album-add-sheet-price').value = 0;

    document.getElementById('album-cover-toggle').checked = false;
    document.getElementById('album-cover-price').value = 0;
    document.getElementById('album-cover-type').value = '';

    document.getElementById('album-box-toggle').checked = false;
    document.getElementById('album-box-price').value = 0;
    document.getElementById('album-box-type').value = '';

    document.getElementById('album-creation-toggle').checked = false;
    document.getElementById('album-creation-pages').value = 0;
    document.getElementById('album-creation-price').value = 0;

    if (document.getElementById('album-discount')) {
        document.getElementById('album-discount').value = 0;
    }

    toggleAlbumOptions();
    document.getElementById('album-customer-name').value = '';
    document.getElementById('album-customer-phone').value = '';
    document.getElementById('album-customer-address').value = '';
    document.getElementById('album-due-date').value = '';

    document.getElementById('album-payment-status').value = 'Paid';
    toggleAlbumAdvance();

    calculateAlbumTotal();
}

async function albumCheckout() {
    const totalStr = document.getElementById('album-grand-total').innerText;
    const total = parseFloat(totalStr.replace('Rs. ', '').replace(/,/g, '')) || 0;

    const subtotalStr = document.getElementById('album-subtotal').innerText;
    const subtotal = parseFloat(subtotalStr.replace('Rs. ', '').replace(/,/g, '')) || 0;
    const discount = parseFloat(document.getElementById('album-discount').value) || 0;

    if (total === 0 && subtotal === 0) {
        showToast('Total amount cannot be 0. Please add album details.', 'warning');
        return;
    }

    const status = document.getElementById('album-payment-status').value;
    const advanceAmt = status === 'Advance' ? (parseFloat(document.getElementById('album-advance-amount').value) || 0) : null;

    if (status === 'Advance') {
        const requiredAdvance = total * 0.5;
        if (advanceAmt < requiredAdvance) {
            Swal.fire({
                icon: 'error',
                title: 'Insufficient Advance',
                text: `Advance payment must be at least 50% of the total (${formatCurrency(requiredAdvance)}).`
            });
            return;
        }
    }

    const type = document.getElementById('album-type').value || 'Photobook';
    const size = document.getElementById('album-size').value || 'Standard';

    const pages = Number(document.getElementById('album-pages').value) || 0;
    const basePrice = Number(document.getElementById('album-page-price').value) || 0;

    const addSheetCount = Number(document.getElementById('album-add-sheet-count').value) || 0;
    const addSheetPrice = Number(document.getElementById('album-add-sheet-price').value) || 0;

    const coverPrice = document.getElementById('album-cover-toggle').checked ? (Number(document.getElementById('album-cover-price').value) || 0) : 0;
    const boxPrice = document.getElementById('album-box-toggle').checked ? (Number(document.getElementById('album-box-price').value) || 0) : 0;

    let items = [];
    if (basePrice > 0 || pages > 0) items.push({ photoNo: '-', name: `Base Package (${pages} Pages)`, qty: 1, price: basePrice, total: basePrice, itemType: 'album' });
    if (addSheetCount > 0) items.push({ photoNo: '-', name: `Additional Pages (${addSheetCount} @ Rs.${addSheetPrice})`, qty: addSheetCount, price: addSheetPrice, total: addSheetCount * addSheetPrice, itemType: 'album' });
    if (document.getElementById('album-cover-toggle').checked) {
        const coverType = document.getElementById('album-cover-type').value.trim() || 'Standard';
        items.push({ photoNo: '-', name: `${coverType} Cover`, qty: 1, price: coverPrice, total: coverPrice, itemType: 'album' });
    }
    if (document.getElementById('album-box-toggle').checked) {
        const boxType = document.getElementById('album-box-type').value.trim() || 'Standard';
        items.push({ photoNo: '-', name: `${boxType} Box`, qty: 1, price: boxPrice, total: boxPrice, itemType: 'album' });
    }
    if (document.getElementById('album-creation-toggle').checked) {
        const cPages = Number(document.getElementById('album-creation-pages').value) || 0;
        const cPrice = Number(document.getElementById('album-creation-price').value) || 0;
        if (cPages > 0 || cPrice > 0) {
            items.push({ photoNo: '-', name: `Creation Designing (${cPages} Pages @ Rs.${cPrice})`, qty: cPages, price: cPrice, total: cPages * cPrice, itemType: 'album' });
        }
    }

    if (items.length === 0) items.push({ photoNo: '-', name: `${type} Photobook (${size})`, qty: 1, price: total, total: total, itemType: 'album' });

    const phone = document.getElementById('album-customer-phone').value || 'N/A';
    const cName = document.getElementById('album-customer-name').value.trim() || 'Walk-in Customer';
    const address = document.getElementById('album-customer-address').value.trim() || '';
    const dueDate = document.getElementById('album-due-date').value;

    const order = {
        billNo: albumCurrentBillNo,
        customerName: cName,
        customerPhone: phone,
        customerAddress: address,
        subtotalAmount: subtotal,
        discountAmount: discount,
        totalAmount: total,
        date: new Date().toISOString(),
        dueDate: dueDate || null,
        type: 'album',
        albumDetails: { type, size },
        paymentStatus: status,
        advanceAmount: advanceAmt,
        items: items
    };

    await db.orders.add(order);

    generateInvoicePDF(order);
    backupToGoogleSheets(order);
    showToast('Album Order Complete!', 'success');

    clearAlbumForm();
    generateAlbumBillNo();
    loadDashboardStats();
    loadBills();
}

// ==========================================
// THERMAL PRINTER INTEGRATION
// ==========================================
function printThermalReceipt(data, type = 'shop') {
    const billNo = data.billNo || '';
    let dateStr = new Date().toLocaleString();
    if (data.date) {
        dateStr = new Date(data.date).toLocaleString();
    } else if (data.timestamp) {
        dateStr = new Date(data.timestamp).toLocaleString();
    }

    const customerName = type === 'booth' ? (data.event || 'General') : (data.customerName || 'Walk-in Customer');
    const customerPhone = type === 'booth' ? data.phone : (data.customerPhone !== 'N/A' ? data.customerPhone : '');
    
    let subtotal = data.subtotalAmount || data.totalAmount || data.total || 0;
    let discount = data.discountAmount || 0;
    let total = data.totalAmount || data.total || 0;
    let advance = data.advanceAmount || 0;
    let paymentStatus = data.paymentStatus || 'Paid';
    let balance = total - advance;

    let itemsHtml = '';
    
    if (type === 'booth') {
        if (data.items) {
            data.items.forEach(item => {
                itemsHtml += `
                <tr style="border-bottom: 1px dashed #ccc;">
                    <td style="padding: 4px 0; font-size: 12px;">${item.photoNo}<br><span style="font-size: 10px; color: #555;">${item.size} x${item.prints}</span></td>
                    <td style="padding: 4px 0; text-align: center; font-size: 12px;">${item.prints}</td>
                    <td style="padding: 4px 0; text-align: right; font-size: 12px;">${formatCurrency(item.printPrice * item.prints)}</td>
                </tr>`;
                if (item.hasFrame) {
                    itemsHtml += `
                    <tr style="border-bottom: 1px dashed #ccc;">
                        <td style="padding: 4px 0 4px 10px; font-size: 10px; color: #555;">└ Frame: ${item.frameSize}</td>
                        <td style="padding: 4px 0; text-align: center; font-size: 12px;">${item.frames}</td>
                        <td style="padding: 4px 0; text-align: right; font-size: 12px;">${formatCurrency(item.framePrice * item.frames)}</td>
                    </tr>`;
                }
            });
        }
    } else {
        if (data.items) {
            data.items.forEach(item => {
                const name = item.name || '';
                const qty = item.qty || item.prints || 1;
                const priceMatch = item.price || 0;
                const t = item.total || (priceMatch * qty);
                itemsHtml += `
                <tr style="border-bottom: 1px dashed #ccc;">
                    <td style="padding: 4px 0; font-size: 12px;">${name}</td>
                    <td style="padding: 4px 0; text-align: center; font-size: 12px;">${qty}</td>
                    <td style="padding: 4px 0; text-align: right; font-size: 12px;">${formatCurrency(t)}</td>
                </tr>`;
            });
        }
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Receipt_${billNo}</title>
        <style>
            @page { margin: 0; size: 80mm auto; }
            body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 0; padding: 10px; width: 80mm; box-sizing: border-box; color: #000; }
            .header { text-align: center; margin-bottom: 10px; }
            .logo { font-family: 'Times New Roman', serif; font-size: 18px; font-weight: bold; letter-spacing: 2px; border: 2px solid #000; padding: 5px; display: inline-block; margin-bottom: 5px; }
            .logo-sub { font-size: 8px; font-weight: bold; letter-spacing: 1px; }
            .info { font-size: 12px; margin-bottom: 10px; }
            .info div { display: flex; justify-content: space-between; margin-bottom: 2px; }
            .items-table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
            .items-table th { border-bottom: 1px dashed #000; text-align: left; padding: 4px 0; font-size: 12px; }
            .items-table th.center { text-align: center; }
            .items-table th.right { text-align: right; }
            .totals { font-size: 12px; margin-top: 10px; border-top: 1px dashed #000; padding-top: 5px; }
            .totals div { display: flex; justify-content: space-between; margin-bottom: 3px; }
            .totals .grand-total { font-weight: bold; font-size: 16px; margin-top: 5px; border-top: 1px dashed #000; padding-top: 5px; }
            .footer { text-align: center; font-size: 10px; margin-top: 15px; margin-bottom: 15px; border-top: 1px dashed #000; padding-top: 5px; }
        </style>
    </head>
    <body onload="window.print(); setTimeout(function() { window.close(); }, 500);">
        <div class="header">
            <div class="logo">PASSION PIXELS</div>
            <div class="logo-sub">STUDIO & COLOR LAB</div>
            <div style="font-size: 12px; margin-top: 5px; font-weight: bold;">${type === 'booth' ? 'Photobooth Ticket' : 'Payment Receipt'}</div>
        </div>
        
        <div class="info">
            <div><span>Bill No:</span> <strong>${billNo}</strong></div>
            <div><span>Date:</span> <span>${dateStr}</span></div>
            <div><span>${type === 'booth' ? 'Event' : 'Customer'}:</span> <span>${customerName}</span></div>
            ${customerPhone && customerPhone !== 'N/A' ? `<div><span>Phone:</span> <span>${customerPhone}</span></div>` : ''}
            <div><span>Status:</span> <strong>${paymentStatus}</strong></div>
            ${data.dueDate ? `<div><span>Due Date:</span> <strong>${data.dueDate}</strong></div>` : ''}
        </div>

        <table class="items-table">
            <thead>
                <tr>
                    <th>Item</th>
                    <th class="center">Qty</th>
                    <th class="right">Total</th>
                </tr>
            </thead>
            <tbody>
                ${itemsHtml}
            </tbody>
        </table>

        <div class="totals">
            ${discount > 0 ? `
            <div><span>Subtotal:</span> <span>${formatCurrency(subtotal)}</span></div>
            <div><span>Discount:</span> <span>- ${formatCurrency(discount)}</span></div>
            ` : ''}
            <div class="grand-total"><span>Grand Total:</span> <span>${formatCurrency(total)}</span></div>
            ${(paymentStatus === 'Advance' || paymentStatus === 'Credit') ? `
            <div style="margin-top:5px;"><span>Paid Amount:</span> <span>${formatCurrency(advance)}</span></div>
            <div style="font-weight:bold;"><span>Balance Due:</span> <span>${formatCurrency(balance)}</span></div>
            ` : ''}
        </div>

        <div class="footer">
            <div>Thank you for choosing Passion Pixel!</div>
            <div>Contact: 070-3236363</div>
            <div style="margin-top: 3px; font-style: italic;">* Please present this slip when collecting *</div>
        </div>
    </body>
    </html>
    `;

    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    document.body.appendChild(iframe);

    iframe.contentWindow.document.open();
    iframe.contentWindow.document.write(htmlContent);
    iframe.contentWindow.document.close();

    setTimeout(() => {
        document.body.removeChild(iframe);
    }, 2000);
}

