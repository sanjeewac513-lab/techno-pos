/* Techno POS - offline point of sale. All data lives on this device (IndexedDB). */
(() => {
'use strict';

/* =========================================================================
   Helpers
   ========================================================================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fromYmd = (s, end) => { const [y, m, d] = s.split('-').map(Number); return end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d); };
const endOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const fmtDT = ts => { const d = new Date(ts); return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const trimNum = n => String(Math.round(n * 100) / 100);

const DEF = {
	name: 'My Shop', address: '', phone: '', footer: 'Thank you! Please come again.',
	currency: 'Rs.', decimals: 2, width: '80', maxDisc: 100, lowStock: 5, prefix: '',
	cashier: 'Cashier', taxName: 'Tax', taxRate: 0, autoPrint: true, pin: '', lastBackup: 0
};

const S = {
	settings: { ...DEF }, products: [], held: [],
	cart: [], tab: 'sell', q: '', cat: '', dtype: 'percent', dval: '', pay: 'Cash', recv: '',
	cust: { name: '', phone: '', address: '' }, unlockedUntil: 0, cartOpen: false,
	lowOnly: false, pq: '', rp: 'today'
};

const dec = () => (S.settings.decimals === 0 || S.settings.decimals === '0') ? 0 : 2;
const rnd = n => { const f = Math.pow(10, dec()); return Math.round((n + Number.EPSILON) * f) / f; };
const money = n => (S.settings.currency ? S.settings.currency + ' ' : '') + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: dec(), maximumFractionDigits: dec() });

const ICON = {
	sell: '<svg viewBox="0 0 24 24"><path d="M3 3h2l2.6 12h10.8L21 7H6"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/></svg>',
	bills: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
	products: '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/></svg>',
	reports: '<svg viewBox="0 0 24 24"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
	settings: '<svg viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
	lock: '<svg viewBox="0 0 24 24"><path d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3"/></svg>'
};

let toastT;
function toast(msg, kind) {
	const t = $('#toast');
	t.textContent = msg;
	t.className = 'show ' + (kind || '');
	clearTimeout(toastT);
	toastT = setTimeout(() => { t.className = ''; }, 2800);
}

/* ---------- modals ---------- */
function modal(html, opts = {}) {
	const el = document.createElement('div');
	el.className = 'modal';
	el.innerHTML = '<div class="sheet' + (opts.wide ? ' wide' : '') + '">' + html + '</div>';
	document.body.appendChild(el);
	const api = {
		el,
		close(v) {
			if (!el.isConnected) { return; }
			el.remove();
			if (opts.onClose) { opts.onClose(v); }
		}
	};
	el.addEventListener('mousedown', e => { if (e.target === el) { api.close(null); } });
	el.addEventListener('x-close', () => api.close(null));
	return api;
}

function confirmBox(msg, ok, danger) {
	return new Promise(res => {
		const m = modal('<p class="msg">' + esc(msg) + '</p><div class="row end"><button class="btn" data-x="0">Cancel</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-x="1">' + esc(ok || 'OK') + '</button></div>', { onClose: v => res(v === true) });
		m.el.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) { m.close(x.dataset.x === '1'); } });
	});
}

function inputBox(title, label, o = {}) {
	return new Promise(res => {
		const m = modal('<h3>' + esc(title) + '</h3><label class="f">' + esc(label) +
			'<input id="ib" type="' + (o.type || 'text') + '" value="' + esc(o.value || '') + '" placeholder="' + esc(o.placeholder || '') + '"' + (o.type === 'password' ? ' inputmode="numeric" autocomplete="off"' : '') + '></label>' +
			'<div class="row end"><button class="btn" data-x="0">Cancel</button><button class="btn primary" data-x="1">' + esc(o.ok || 'OK') + '</button></div>', { onClose: v => res(v) });
		const inp = $('#ib', m.el);
		inp.focus();
		const go = () => m.close(inp.value);
		m.el.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) { x.dataset.x === '1' ? go() : m.close(null); } });
		inp.addEventListener('keydown', e => { if (e.key === 'Enter') { go(); } });
	});
}

/* ---------- owner PIN (stops casual access only; it is not strong security) ---------- */
const hashPin = p => { let h = 5381; const s = 'tp:' + p; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; } return h.toString(36); };
const unlocked = () => !S.settings.pin || Date.now() < S.unlockedUntil;

async function requirePin() {
	if (unlocked()) { S.unlockedUntil = Date.now() + 600000; return true; }
	for (let i = 0; i < 3; i++) {
		const v = await inputBox('Owner PIN', 'Enter the PIN to continue', { type: 'password', ok: 'Unlock' });
		if (v == null) { return false; }
		if (hashPin(v) === S.settings.pin) { S.unlockedUntil = Date.now() + 600000; renderNav(); return true; }
		toast('Wrong PIN', 'err');
	}
	return false;
}

/* ---------- files / printing (works in the browser and inside the Android app) ---------- */
function printHtml(html) {
	if (window.Android && window.Android.print) { window.Android.print(html); return; }
	const f = document.createElement('iframe');
	f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
	document.body.appendChild(f);
	const d = f.contentDocument;
	d.open(); d.write(html); d.close();
	setTimeout(() => {
		f.contentWindow.focus();
		f.contentWindow.print();
		setTimeout(() => f.remove(), 2000);
	}, 300);
}

function saveFile(name, mime, text) {
	if (window.Android && window.Android.saveFile) { toast(window.Android.saveFile(name, mime, text), 'ok'); return; }
	const a = document.createElement('a');
	a.href = URL.createObjectURL(new Blob([text], { type: mime }));
	a.download = name;
	document.body.appendChild(a);
	a.click();
	setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
	toast('File saved: ' + name, 'ok');
}

function pickFile(accept) {
	return new Promise(res => {
		const i = document.createElement('input');
		i.type = 'file';
		i.accept = accept;
		i.style.display = 'none';
		document.body.appendChild(i);
		i.addEventListener('change', () => {
			const f = i.files[0];
			i.remove();
			if (!f) { res(null); return; }
			const r = new FileReader();
			r.onload = () => res({ name: f.name, text: r.result });
			r.onerror = () => res(null);
			r.readAsText(f);
		});
		i.click();
	});
}

const csvCell = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
const toCSV = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
function parseCSV(text) {
	const rows = [];
	let row = [], cur = '', q = false;
	text = text.replace(/^﻿/, '');
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (q) {
			if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { q = false; } } else { cur += c; }
		} else if (c === '"') { q = true; }
		else if (c === ',') { row.push(cur); cur = ''; }
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') { i++; }
			row.push(cur); cur = '';
			if (row.some(x => x !== '')) { rows.push(row); }
			row = [];
		} else { cur += c; }
	}
	row.push(cur);
	if (row.some(x => x !== '')) { rows.push(row); }
	return rows;
}

/* =========================================================================
   Data / calculations
   ========================================================================= */
async function loadAll() {
	const m = await DB.get('meta', 'settings');
	S.settings = { ...DEF, ...(m ? m.v : {}) };
	S.products = await DB.all('products');
	const h = await DB.get('meta', 'held');
	S.held = h ? h.v : [];
}
const saveSettings = () => DB.put('meta', { k: 'settings', v: S.settings });
const saveHeld = () => DB.put('meta', { k: 'held', v: S.held });
const refreshProducts = async () => { S.products = await DB.all('products'); };

function calc(cart, dtype, dval) {
	const sub = rnd(cart.reduce((s, i) => s + i.price * i.qty, 0));
	const v = Math.max(num(dval), 0);
	const disc = dtype === 'percent' ? rnd(sub * Math.min(v, 100) / 100) : Math.min(rnd(v), sub);
	const taxable = rnd(sub - disc);
	const rate = num(S.settings.taxRate);
	const tax = rnd(taxable * rate / 100);
	const total = rnd(taxable + tax);
	return { sub, disc, tax, total, pct: sub > 0 ? disc / sub * 100 : 0 };
}

/* =========================================================================
   Receipts
   ========================================================================= */
function receiptHtml(b, o = {}) {
	const s = S.settings, narrow = s.width === '58';
	const C = b.customer || {};
	const refunded = b.status === 'refunded';
	const discLabel = b.discType === 'percent' ? 'Discount (' + trimNum(b.discVal) + '%)' : 'Discount';
	const rows = b.items.map(i =>
		'<tr><td colspan="2">' + esc(i.name) + '</td></tr><tr><td>' + trimNum(i.qty) + ' x ' + money(i.price) + '</td><td class="r">' + money(rnd(i.price * i.qty)) + '</td></tr>').join('');
	return '<!doctype html><html><head><meta charset="utf-8"><title>Bill ' + esc(b.label) + '</title><style>' +
		'@page{margin:0}body{font-family:monospace;font-size:' + (narrow ? '11px' : '12px') + ';width:' + (narrow ? '48mm' : '72mm') + ';margin:0 auto;padding:4mm}' +
		'h2,p{text-align:center;margin:2px 0}table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}' +
		'.r{text-align:right}hr{border:0;border-top:1px dashed #000;margin:6px 0}.b td{font-weight:bold;font-size:14px}.cu{line-height:1.4}' +
		'</style></head><body>' +
		'<h2>' + esc(s.name) + '</h2>' +
		(s.address ? '<p>' + esc(s.address).replace(/\n/g, '<br>') + '</p>' : '') +
		(s.phone ? '<p>Tel: ' + esc(s.phone) + '</p>' : '') +
		(o.copy ? '<p><b>*** DUPLICATE COPY ***</b></p>' : '') +
		(refunded ? '<p><b>*** REFUNDED ***</b></p>' : '') +
		'<hr><p>Bill #' + esc(b.label) + '</p><p>' + esc(fmtDT(b.ts)) + '</p>' +
		(b.cashier ? '<p>Cashier: ' + esc(b.cashier) + '</p>' : '') +
		(C.name || C.phone || C.address ? '<hr><div class="cu"><b>Customer</b><br>' + (C.name ? esc(C.name) + '<br>' : '') + (C.phone ? 'Tel: ' + esc(C.phone) + '<br>' : '') + (C.address ? esc(C.address).replace(/\n/g, '<br>') : '') + '</div>' : '') +
		'<hr><table>' + rows + '</table><hr><table>' +
		'<tr><td>Subtotal</td><td class="r">' + money(b.subtotal) + '</td></tr>' +
		(b.discount > 0 ? '<tr><td>' + discLabel + '</td><td class="r">-' + money(b.discount) + '</td></tr>' : '') +
		(b.tax > 0 ? '<tr><td>' + esc(b.taxName || 'Tax') + ' (' + trimNum(b.taxRate) + '%)</td><td class="r">' + money(b.tax) + '</td></tr>' : '') +
		'<tr class="b"><td>TOTAL</td><td class="r">' + money(b.total) + '</td></tr>' +
		'<tr><td>Paid (' + esc(b.pay) + ')</td><td class="r">' + money(b.received) + '</td></tr>' +
		(b.change > 0 ? '<tr><td>Change</td><td class="r">' + money(b.change) + '</td></tr>' : '') +
		'</table><hr><p>' + esc(s.footer) + '</p></body></html>';
}

/* =========================================================================
   Navigation
   ========================================================================= */
const PROTECTED = new Set(['products', 'reports', 'settings']);
const VIEWS = {};

function renderNav() {
	const items = [['sell', 'Sell'], ['bills', 'Bills'], ['products', 'Products'], ['reports', 'Reports'], ['settings', 'Settings']];
	$('#nav').innerHTML = '<div class="brand"><span>T</span><b>Techno POS</b></div>' +
		items.map(([k, l]) => '<button data-tab="' + k + '" class="' + (S.tab === k ? 'on' : '') + '">' + ICON[k] + '<span>' + l + '</span></button>').join('') +
		(S.settings.pin ? '<button data-lock class="lock">' + ICON.lock + '<span>' + (unlocked() ? 'Lock' : 'Locked') + '</span></button>' : '');
}

async function go(tab) {
	if (PROTECTED.has(tab) && !(await requirePin())) { return; }
	S.tab = tab;
	S.cartOpen = false;
	renderNav();
	await VIEWS[tab]();
}

/* =========================================================================
   SELL
   ========================================================================= */
function visibleProducts() {
	const q = S.q.trim().toLowerCase();
	return S.products
		.filter(p => (!S.cat || p.category === S.cat) && (!q || (p.name || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function stockLabel(p) {
	if (!p.track) { return ''; }
	if (p.stock <= 0) { return '<span class="low">Out of stock</span>'; }
	return '<span class="' + (p.stock <= num(S.settings.lowStock) ? 'low' : '') + '">' + trimNum(p.stock) + ' in stock</span>';
}

function renderChips() {
	const el = $('#chips');
	if (!el) { return; }
	const cats = [...new Set(S.products.map(p => p.category).filter(Boolean))].sort();
	el.classList.toggle('hide', !cats.length);
	el.innerHTML = ['', ...cats].map(c => '<button data-cat="' + esc(c) + '" class="' + (S.cat === c ? 'on' : '') + '">' + (c ? esc(c) : 'All') + '</button>').join('');
}

function renderGrid() {
	const g = $('#grid');
	if (!g) { return; }
	const list = visibleProducts().slice(0, 300);
	if (!S.products.length) {
		g.innerHTML = '<p class="empty" style="grid-column:1/-1">No products yet. Go to <b>Products</b> to add items, or use <b>+ Custom item</b> to sell something not in the list.</p>';
		return;
	}
	g.innerHTML = list.length ? list.map(p =>
		'<button class="card ' + (p.track && p.stock <= 0 ? 'out' : '') + '" data-id="' + p.id + '"><span class="n">' + esc(p.name) + '</span><span><span class="p">' + money(p.price) + '</span><br><span class="s">' + (esc(p.sku || '') + ' ' + stockLabel(p)).trim() + '</span></span></button>').join('')
		: '<p class="empty" style="grid-column:1/-1">No products match your search.</p>';
}

function maxQty(i) {
	if (!i.track) { return Infinity; }
	const p = S.products.find(x => x.id === i.pid);
	return p ? p.stock : Infinity;
}

function addProduct(p, qty) {
	qty = qty || 1;
	if (p.track && p.stock <= 0) { toast('Out of stock: ' + p.name, 'err'); return; }
	const ex = S.cart.find(i => i.pid === p.id);
	const nq = (ex ? ex.qty : 0) + qty;
	if (p.track && nq > p.stock) { toast('Only ' + trimNum(p.stock) + ' in stock', 'err'); return; }
	if (ex) { ex.qty = nq; } else { S.cart.push({ pid: p.id, name: p.name, sku: p.sku || '', price: p.price, cost: p.cost, qty, track: !!p.track }); }
	renderCart();
}

function renderCart() {
	const el = $('#lines');
	if (!el) { return; }
	el.innerHTML = S.cart.length ? S.cart.map((i, n) =>
		'<div class="line"><div class="nm">' + esc(i.name) + '<small>' + money(i.price) + '</small></div>' +
		'<div class="qty"><button data-a="dec" data-i="' + n + '" aria-label="Less">&minus;</button>' +
		'<input data-a="set" data-i="' + n + '" type="number" step="any" min="0" inputmode="decimal" value="' + i.qty + '">' +
		'<button data-a="inc" data-i="' + n + '" aria-label="More">+</button></div>' +
		'<div class="lt">' + money(rnd(i.price * i.qty)) + '</div>' +
		'<button class="x" data-a="del" data-i="' + n + '" aria-label="Remove">&times;</button></div>').join('')
		: '<p class="empty">No items yet. Tap a product to add it.</p>';
	renderTotals();
}

function renderTotals() {
	if (!$('#tSub')) { return; }
	const c = calc(S.cart, S.dtype, S.dval);
	const rate = num(S.settings.taxRate);
	$('#tSub').textContent = money(c.sub);
	$('#tDisc').textContent = '-' + money(c.disc);
	$('#rDisc').classList.toggle('hide', c.disc <= 0);
	$('#rTax').classList.toggle('hide', rate <= 0);
	$('#tTaxN').textContent = (S.settings.taxName || 'Tax') + ' (' + trimNum(rate) + '%)';
	$('#tTax').textContent = money(c.tax);
	$('#tTotal').textContent = money(c.total);
	const cash = S.pay === 'Cash';
	$('#rRecv').classList.toggle('hide', !cash);
	$('#rChg').classList.toggle('hide', !cash);
	const recv = num(S.recv);
	$('#tChg').textContent = money(recv > c.total ? rnd(recv - c.total) : 0);
	const count = S.cart.reduce((s, i) => s + i.qty, 0);
	$('#cartBar').textContent = S.cart.length ? 'View bill  ·  ' + trimNum(count) + ' item(s)  ·  ' + money(c.total) : 'View bill (empty)';
	$('#held').textContent = 'Held (' + S.held.length + ')';
	const max = num(S.settings.maxDisc);
	if (max < 100 && c.pct > max + 0.0001) { toast('Discount is above the allowed maximum of ' + trimNum(max) + '%', 'err'); }
}

function resetSale() {
	S.cart = []; S.dtype = 'percent'; S.dval = ''; S.pay = 'Cash'; S.recv = '';
	S.cust = { name: '', phone: '', address: '' };
	S.cartOpen = false;
}

VIEWS.sell = function () {
	$('#view').innerHTML =
		'<section class="sell ' + (S.cartOpen ? 'cart-open' : '') + '" id="sell">' +
		'<div class="catalog"><div class="searchbar"><input id="q" type="search" placeholder="Search or scan barcode" autocomplete="off"><button class="btn" id="custom">+ Custom</button></div>' +
		'<div id="chips" class="chips"></div><div id="grid" class="grid"></div></div>' +
		'<aside class="cart"><div class="cart-h"><h2>Current bill</h2><button class="btn ghost only-narrow" id="closeCart">Close</button></div>' +
		'<details class="cust"' + (S.cust.name || S.cust.phone || S.cust.address ? ' open' : '') + '><summary>Customer details (optional)</summary>' +
		'<input id="cname" placeholder="Customer name"><input id="cphone" placeholder="Customer phone" inputmode="tel"><textarea id="caddr" rows="2" placeholder="Customer address"></textarea></details>' +
		'<div id="lines" class="lines"></div>' +
		'<div class="tot"><div class="r"><span>Subtotal</span><b id="tSub"></b></div>' +
		'<div class="r"><span>Discount</span><span class="disc"><select id="dtype"><option value="percent">%</option><option value="fixed">Amount</option></select><input id="dval" type="number" min="0" step="any" inputmode="decimal" placeholder="0"></span></div>' +
		'<div class="r sub" id="rDisc"><span>Discount given</span><b id="tDisc"></b></div>' +
		'<div class="r sub" id="rTax"><span id="tTaxN"></span><b id="tTax"></b></div>' +
		'<div class="r big"><span>TOTAL</span><b id="tTotal"></b></div>' +
		'<div class="r"><span>Payment</span><select id="pay"><option>Cash</option><option>Card</option><option>Bank Transfer</option></select></div>' +
		'<div class="r" id="rRecv"><span>Received</span><span class="disc"><button class="btn sm" id="exact">Exact</button><input id="recv" type="number" min="0" step="any" inputmode="decimal"></span></div>' +
		'<div class="r" id="rChg"><span>Change</span><b id="tChg"></b></div></div>' +
		'<div class="btns"><button class="btn" id="clear">Clear</button><button class="btn" id="hold">Hold</button><button class="btn" id="held">Held (0)</button></div>' +
		'<button class="btn primary xl" id="payBtn">Pay &amp; Save Bill</button></aside>' +
		'<button class="cartbar only-narrow" id="cartBar"></button></section>';

	$('#q').value = S.q;
	$('#cname').value = S.cust.name; $('#cphone').value = S.cust.phone; $('#caddr').value = S.cust.address;
	$('#dtype').value = S.dtype; $('#dval').value = S.dval; $('#pay').value = S.pay; $('#recv').value = S.recv;
	renderChips(); renderGrid(); renderCart();

	const sell = $('#sell');
	$('#q').addEventListener('input', e => { S.q = e.target.value; renderGrid(); });
	$('#q').addEventListener('keydown', e => {
		if (e.key !== 'Enter') { return; }
		e.preventDefault();
		const q = S.q.trim().toLowerCase();
		if (!q) { return; }
		let p = S.products.find(x => x.sku && x.sku.toLowerCase() === q);
		if (!p) { const v = visibleProducts(); if (v.length === 1) { p = v[0]; } }
		if (p) { addProduct(p); S.q = ''; e.target.value = ''; renderGrid(); } else { toast('No matching product', 'err'); }
	});
	$('#chips').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (b) { S.cat = b.dataset.cat; renderChips(); renderGrid(); } });
	$('#grid').addEventListener('click', e => { const c = e.target.closest('[data-id]'); if (c) { const p = S.products.find(x => x.id === Number(c.dataset.id)); if (p) { addProduct(p); } } });
	$('#lines').addEventListener('click', e => {
		const b = e.target.closest('button[data-a]');
		if (!b) { return; }
		const n = Number(b.dataset.i), it = S.cart[n];
		if (b.dataset.a === 'inc') { if (it.qty + 1 > maxQty(it)) { toast('Not enough stock', 'err'); return; } it.qty = Math.round((it.qty + 1) * 1000) / 1000; }
		if (b.dataset.a === 'dec') { it.qty = Math.round((it.qty - 1) * 1000) / 1000; if (it.qty <= 0) { S.cart.splice(n, 1); } }
		if (b.dataset.a === 'del') { S.cart.splice(n, 1); }
		renderCart();
	});
	$('#lines').addEventListener('change', e => {
		if (e.target.dataset.a !== 'set') { return; }
		const n = Number(e.target.dataset.i), it = S.cart[n];
		let q = num(e.target.value);
		if (q <= 0) { S.cart.splice(n, 1); renderCart(); return; }
		if (q > maxQty(it)) { toast('Only ' + trimNum(maxQty(it)) + ' in stock', 'err'); q = maxQty(it); }
		it.qty = q;
		renderCart();
	});
	[['cname', 'name'], ['cphone', 'phone'], ['caddr', 'address']].forEach(([id, key]) => $('#' + id).addEventListener('input', e => { S.cust[key] = e.target.value; }));
	$('#dtype').addEventListener('change', e => { S.dtype = e.target.value; renderTotals(); });
	$('#dval').addEventListener('input', e => { S.dval = e.target.value; renderTotals(); });
	$('#pay').addEventListener('change', e => { S.pay = e.target.value; renderTotals(); });
	$('#recv').addEventListener('input', e => { S.recv = e.target.value; renderTotals(); });
	$('#exact').addEventListener('click', () => { S.recv = String(calc(S.cart, S.dtype, S.dval).total); $('#recv').value = S.recv; renderTotals(); });
	$('#clear').addEventListener('click', async () => { if (S.cart.length && !(await confirmBox('Clear the current bill?', 'Clear', true))) { return; } resetSale(); VIEWS.sell(); });
	$('#hold').addEventListener('click', holdBill);
	$('#held').addEventListener('click', showHeld);
	$('#payBtn').addEventListener('click', checkout);
	$('#custom').addEventListener('click', customItem);
	$('#cartBar').addEventListener('click', () => { S.cartOpen = true; sell.classList.add('cart-open'); });
	$('#closeCart').addEventListener('click', () => { S.cartOpen = false; sell.classList.remove('cart-open'); });
	if (window.innerWidth > 820) { $('#q').focus(); }
};

function customItem() {
	const m = modal('<h3>Custom item</h3><label class="f">Item name<input id="ciN" placeholder="e.g. Delivery, Repair"></label>' +
		'<div class="formgrid"><label class="f">Price<input id="ciP" type="number" min="0" step="any" inputmode="decimal"></label><label class="f">Quantity<input id="ciQ" type="number" min="0" step="any" value="1" inputmode="decimal"></label></div>' +
		'<div class="row end"><button class="btn" data-x="0">Cancel</button><button class="btn primary" data-x="1">Add to bill</button></div>');
	$('#ciN', m.el).focus();
	m.el.addEventListener('click', e => {
		const x = e.target.closest('[data-x]');
		if (!x) { return; }
		if (x.dataset.x === '0') { m.close(); return; }
		const name = $('#ciN', m.el).value.trim(), price = num($('#ciP', m.el).value), qty = num($('#ciQ', m.el).value);
		if (!name || price < 0 || qty <= 0) { toast('Enter a name, price and quantity', 'err'); return; }
		S.cart.push({ pid: null, name, sku: '', price, cost: 0, qty, track: false });
		m.close();
		renderCart();
	});
}

async function holdBill() {
	if (!S.cart.length) { toast('Nothing to hold', 'err'); return; }
	S.held.push({ id: Date.now(), time: fmtDT(Date.now()), cart: S.cart, dtype: S.dtype, dval: S.dval, cust: S.cust });
	await saveHeld();
	resetSale();
	VIEWS.sell();
	toast('Bill put on hold', 'ok');
}

function showHeld() {
	const body = S.held.length ? S.held.map(b => {
		const n = b.cart.reduce((s, c) => s + c.qty, 0), t = calc(b.cart, b.dtype, b.dval).total;
		return '<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line)"><div style="flex:1">' + esc(b.time) + (b.cust && b.cust.name ? ' - ' + esc(b.cust.name) : '') + '<br><small>' + trimNum(n) + ' item(s), ' + money(t) + '</small></div>' +
			'<button class="btn sm" data-resume="' + b.id + '">Resume</button><button class="btn sm danger" data-drop="' + b.id + '">Delete</button></div>';
	}).join('') : '<p class="empty">No held bills.</p>';
	const m = modal('<h3>Held bills</h3>' + body + '<div class="row end"><button class="btn" data-x="0">Close</button></div>');
	m.el.addEventListener('click', async e => {
		const t = e.target;
		if (t.dataset.x) { m.close(); }
		if (t.dataset.resume) {
			const b = S.held.find(x => x.id === Number(t.dataset.resume));
			if (!b) { return; }
			if (S.cart.length && !(await confirmBox('Replace the current bill with the held bill?', 'Replace'))) { return; }
			S.cart = b.cart; S.dtype = b.dtype; S.dval = b.dval; S.cust = b.cust || { name: '', phone: '', address: '' };
			S.held = S.held.filter(x => x.id !== b.id);
			await saveHeld();
			m.close();
			VIEWS.sell();
		}
		if (t.dataset.drop) {
			S.held = S.held.filter(x => x.id !== Number(t.dataset.drop));
			await saveHeld();
			m.close();
			showHeld();
			renderTotals();
		}
	});
}

async function checkout() {
	if (!S.cart.length) { toast('The bill is empty', 'err'); return; }
	const s = S.settings;
	const c = calc(S.cart, S.dtype, S.dval);
	const max = num(s.maxDisc);
	if (max < 100 && c.pct > max + 0.0001) { toast('Discount cannot be more than ' + trimNum(max) + '% of the bill', 'err'); return; }
	const cash = S.pay === 'Cash';
	let recv = S.recv === '' ? c.total : num(S.recv);
	if (cash && recv < c.total) { toast('Amount received is less than the total', 'err'); return; }
	if (!cash) { recv = c.total; }

	const bill = {
		ts: Date.now(), prefix: s.prefix || '',
		items: S.cart.map(i => ({ pid: i.pid, name: i.name, sku: i.sku, price: i.price, cost: i.cost || 0, qty: i.qty, track: !!i.track })),
		subtotal: c.sub, discType: S.dtype, discVal: num(S.dval), discount: c.disc,
		taxName: s.taxName, taxRate: num(s.taxRate), tax: c.tax, total: c.total,
		pay: S.pay, received: recv, change: cash ? rnd(recv - c.total) : 0,
		customer: { name: S.cust.name.trim(), phone: S.cust.phone.trim(), address: S.cust.address.trim() },
		cashier: s.cashier, status: 'completed'
	};
	const btn = $('#payBtn');
	btn.disabled = true;
	try {
		await DB.saveSale(bill);
	} catch (e) {
		btn.disabled = false;
		toast(e.message || 'Could not save the bill', 'err');
		await refreshProducts();
		renderGrid();
		return;
	}
	resetSale();
	await refreshProducts();
	if (s.autoPrint) { printHtml(receiptHtml(bill)); }
	VIEWS.sell();
	const m = modal('<h3>Bill #' + esc(bill.label) + ' saved</h3><div class="done"><div>Total<b>' + money(bill.total) + '</b></div>' +
		(bill.change > 0 ? '<div class="chg">Change to give<b>' + money(bill.change) + '</b></div>' : '') + '</div>' +
		'<div class="row end"><button class="btn" data-x="print">Print bill</button><button class="btn primary" data-x="done">New sale</button></div>');
	m.el.addEventListener('click', e => {
		const x = e.target.closest('[data-x]');
		if (!x) { return; }
		if (x.dataset.x === 'print') { printHtml(receiptHtml(bill)); } else { m.close(); }
	});
}

/* =========================================================================
   BILLS (history, reprint, refund)
   ========================================================================= */
VIEWS.bills = function () {
	const today = ymd(new Date());
	$('#view').innerHTML = '<section class="page"><h1>Bills</h1><div class="filters">' +
		'<label>From<input type="date" id="bf" value="' + today + '"></label><label>To<input type="date" id="bt" value="' + today + '"></label>' +
		'<input type="search" id="bq" placeholder="Bill no / customer / phone"><button class="btn" id="btoday">Today</button></div>' +
		'<div id="bsum" class="stats"></div><div class="panel tw" style="padding:0"><table class="t"><thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th>Payment</th><th class="n">Total</th><th>Status</th></tr></thead><tbody id="blist"></tbody></table></div><p class="note" id="bnote"></p></section>';

	async function load() {
		const f = $('#bf').value, t = $('#bt').value;
		const a = f ? fromYmd(f).getTime() : 0, b = t ? fromYmd(t, true).getTime() : Date.now() + 864e5;
		let list = await DB.billsBetween(a, b);
		const q = $('#bq').value.trim().toLowerCase();
		if (q) { list = list.filter(x => (x.label + ' ' + ((x.customer && x.customer.name) || '') + ' ' + ((x.customer && x.customer.phone) || '')).toLowerCase().includes(q)); }
		list.sort((x, y) => y.ts - x.ts);
		const r = buildReport(list);
		$('#bsum').innerHTML = '<div class="stat"><small>Bills</small><b>' + r.count + '</b></div><div class="stat"><small>Refunds</small><b>' + money(r.refunds) + '</b></div><div class="stat main"><small>Net sales</small><b>' + money(r.net) + '</b></div>';
		$('#blist').innerHTML = list.length ? list.slice(0, 200).map(x =>
			'<tr class="click" data-no="' + x.no + '"><td><b>#' + esc(x.label) + '</b></td><td>' + esc(fmtDT(x.ts)) + '</td><td>' + esc((x.customer && x.customer.name) || '') + '</td><td>' + esc(x.pay) + '</td><td class="n">' + money(x.total) + '</td><td>' +
			(x.status === 'refunded' ? '<span class="tag red">Refunded</span>' : '<span class="tag">Paid</span>') + '</td></tr>').join('')
			: '<tr><td colspan="6" class="empty">No bills found.</td></tr>';
		$('#bnote').textContent = list.length > 200 ? 'Showing the latest 200 of ' + list.length + ' bills. Narrow the dates to see others.' : '';
	}
	$('#bf').addEventListener('change', load);
	$('#bt').addEventListener('change', load);
	$('#bq').addEventListener('input', load);
	$('#btoday').addEventListener('click', () => { $('#bf').value = today; $('#bt').value = today; $('#bq').value = ''; load(); });
	$('#blist').addEventListener('click', e => { const r = e.target.closest('[data-no]'); if (r) { openBill(Number(r.dataset.no), load); } });
	load();
};

async function openBill(no, reload) {
	const b = await DB.get('bills', no);
	if (!b) { return; }
	const m = modal('<iframe class="frame" id="rf"></iframe><div class="row end wrap"><button class="btn" data-x="print">Print copy</button>' +
		(b.status === 'completed' ? '<button class="btn danger" data-x="refund">Refund bill</button>' : '') + '<button class="btn" data-x="close">Close</button></div>', { wide: true });
	$('#rf', m.el).srcdoc = receiptHtml(b, { copy: true });
	m.el.addEventListener('click', async e => {
		const x = e.target.closest('[data-x]');
		if (!x) { return; }
		if (x.dataset.x === 'close') { m.close(); }
		if (x.dataset.x === 'print') { printHtml(receiptHtml(b, { copy: true })); }
		if (x.dataset.x === 'refund') {
			if (!(await requirePin())) { return; }
			if (!(await confirmBox('Refund bill #' + b.label + ' (' + money(b.total) + ')? The items will go back into stock.', 'Refund', true))) { return; }
			const reason = await inputBox('Refund reason', 'Reason (optional)', { ok: 'Refund' });
			if (reason == null) { return; }
			try {
				await DB.refundBill(b.no, reason);
				await refreshProducts();
				m.close();
				toast('Bill refunded', 'ok');
				if (reload) { reload(); }
			} catch (err) { toast(err.message || 'Refund failed', 'err'); }
		}
	});
}

/* =========================================================================
   PRODUCTS
   ========================================================================= */
VIEWS.products = function () {
	const low = n => S.products.filter(p => p.track && p.stock <= num(S.settings.lowStock)).length;
	$('#view').innerHTML = '<section class="page"><h1>Products</h1><div class="filters"><input type="search" id="pq" placeholder="Search products"><button class="btn" id="lowBtn">Low stock (' + low() + ')</button>' +
		'<button class="btn primary" id="addP">+ Add product</button><button class="btn" id="impP">Import CSV</button><button class="btn" id="expP">Export CSV</button></div>' +
		'<div class="panel tw" style="padding:0"><table class="t"><thead><tr><th>Name</th><th>SKU / Barcode</th><th>Category</th><th class="n">Price</th><th class="n">Cost</th><th class="n">Stock</th></tr></thead><tbody id="plist"></tbody></table></div>' +
		'<p class="note">Stock is only counted for products where &ldquo;Track stock&rdquo; is on. CSV columns: name, sku, price, cost, stock, category.</p></section>';
	$('#pq').value = S.pq;
	const draw = () => {
		const q = S.pq.trim().toLowerCase();
		let list = S.products.filter(p => (!q || (p.name || '').toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)));
		if (S.lowOnly) { list = list.filter(p => p.track && p.stock <= num(S.settings.lowStock)); }
		list.sort((a, b) => a.name.localeCompare(b.name));
		$('#lowBtn').classList.toggle('primary', S.lowOnly);
		$('#plist').innerHTML = list.length ? list.map(p =>
			'<tr class="click" data-id="' + p.id + '"><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.sku || '') + '</td><td>' + esc(p.category || '') + '</td><td class="n">' + money(p.price) + '</td><td class="n">' + (p.cost ? money(p.cost) : '-') + '</td><td class="n">' +
			(p.track ? '<span class="' + (p.stock <= num(S.settings.lowStock) ? 'low' : '') + '">' + trimNum(p.stock) + '</span>' : '-') + '</td></tr>').join('')
			: '<tr><td colspan="6" class="empty">' + (S.products.length ? 'No products match.' : 'No products yet. Tap &ldquo;+ Add product&rdquo; or import a CSV.<br><br><button class="btn" id="sample">Add sample items</button>') + '</td></tr>';
	};
	draw();
	$('#pq').addEventListener('input', e => { S.pq = e.target.value; draw(); });
	$('#lowBtn').addEventListener('click', () => { S.lowOnly = !S.lowOnly; draw(); });
	$('#addP').addEventListener('click', () => editProduct(null, draw));
	$('#plist').addEventListener('click', async e => {
		const r = e.target.closest('[data-id]');
		if (r) { editProduct(Number(r.dataset.id), draw); }
		if (e.target.id === 'sample') {
			await DB.putMany('products', [
				['Tea 100g', 'TEA100', 'Grocery', 250, 190, 40], ['Sugar 1kg', 'SUG1K', 'Grocery', 260, 235, 30], ['Rice 1kg', 'RICE1', 'Grocery', 230, 205, 60],
				['Milk Powder 400g', 'MILK400', 'Grocery', 980, 880, 12], ['Soap', 'SOAP1', 'Household', 120, 95, 50], ['Notebook', 'NB80', 'Stationery', 180, 120, 25],
				['Pen (Blue)', 'PENB', 'Stationery', 40, 22, 100], ['Phone Charger', 'CHG1', 'Electronics', 1500, 950, 8]
			].map(a => ({ name: a[0], sku: a[1], category: a[2], price: a[3], cost: a[4], track: true, stock: a[5] })));
			await refreshProducts();
			VIEWS.products();
		}
	});
	$('#expP').addEventListener('click', () => {
		const rows = [['name', 'sku', 'price', 'cost', 'stock', 'category']].concat(S.products.map(p => [p.name, p.sku || '', p.price, p.cost || '', p.track ? p.stock : '', p.category || '']));
		saveFile('techno-pos-products-' + ymd(new Date()) + '.csv', 'text/csv', toCSV(rows));
	});
	$('#impP').addEventListener('click', importProducts);
};

function editProduct(id, done) {
	const p = id == null ? { name: '', sku: '', category: '', price: '', cost: '', track: true, stock: 0 } : S.products.find(x => x.id === id);
	if (!p) { return; }
	const cats = [...new Set(S.products.map(x => x.category).filter(Boolean))];
	const m = modal('<h3>' + (id == null ? 'Add product' : 'Edit product') + '</h3><div class="formgrid">' +
		'<label class="f full">Name *<input id="pN" value="' + esc(p.name) + '"></label>' +
		'<label class="f">SKU / Barcode<input id="pS" value="' + esc(p.sku || '') + '"></label>' +
		'<label class="f">Category<input id="pC" list="cats" value="' + esc(p.category || '') + '"><datalist id="cats">' + cats.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist></label>' +
		'<label class="f">Selling price *<input id="pP" type="number" min="0" step="any" inputmode="decimal" value="' + esc(p.price) + '"></label>' +
		'<label class="f">Cost price<input id="pK" type="number" min="0" step="any" inputmode="decimal" value="' + esc(p.cost || '') + '"></label>' +
		'<label class="chk full"><input type="checkbox" id="pT"' + (p.track ? ' checked' : '') + '> Track stock for this product</label>' +
		'<label class="f full" id="pQw">Stock quantity<input id="pQ" type="number" step="any" inputmode="decimal" value="' + esc(p.stock || 0) + '"></label></div>' +
		'<div class="row end wrap">' + (id != null ? '<button class="btn danger" data-x="del" style="margin-right:auto">Delete</button>' : '') + '<button class="btn" data-x="0">Cancel</button><button class="btn primary" data-x="1">Save</button></div>');
	const sync = () => $('#pQw', m.el).classList.toggle('hide', !$('#pT', m.el).checked);
	$('#pT', m.el).addEventListener('change', sync);
	sync();
	$('#pN', m.el).focus();
	m.el.addEventListener('click', async e => {
		const x = e.target.closest('[data-x]');
		if (!x) { return; }
		if (x.dataset.x === '0') { m.close(); return; }
		if (x.dataset.x === 'del') {
			if (!(await confirmBox('Delete "' + p.name + '"? Old bills are not affected.', 'Delete', true))) { return; }
			await DB.del('products', p.id);
			await refreshProducts();
			m.close();
			VIEWS.products();
			return;
		}
		const name = $('#pN', m.el).value.trim(), sku = $('#pS', m.el).value.trim();
		const price = $('#pP', m.el).value, track = $('#pT', m.el).checked;
		if (!name) { toast('Enter a product name', 'err'); return; }
		if (price === '' || num(price) < 0) { toast('Enter a selling price', 'err'); return; }
		if (sku && S.products.some(o => o.id !== p.id && (o.sku || '').toLowerCase() === sku.toLowerCase())) { toast('Another product already uses that SKU', 'err'); return; }
		const rec = { name, sku, category: $('#pC', m.el).value.trim(), price: num(price), cost: num($('#pK', m.el).value), track, stock: track ? num($('#pQ', m.el).value) : 0 };
		if (id != null) { rec.id = id; }
		await DB.put('products', rec);
		await refreshProducts();
		m.close();
		toast('Product saved', 'ok');
		VIEWS.products();
	});
}

async function importProducts() {
	const f = await pickFile('.csv,text/csv');
	if (!f) { return; }
	const rows = parseCSV(f.text);
	if (rows.length < 2) { toast('That file has no rows', 'err'); return; }
	const head = rows[0].map(h => h.trim().toLowerCase());
	const col = (...names) => head.findIndex(h => names.includes(h));
	const iN = col('name', 'product', 'item'), iS = col('sku', 'barcode', 'code'), iP = col('price', 'selling price'), iK = col('cost', 'cost price'), iQ = col('stock', 'qty', 'quantity'), iC = col('category');
	if (iN < 0 || iP < 0) { toast('The CSV needs "name" and "price" columns', 'err'); return; }
	let added = 0, updated = 0;
	const out = [];
	rows.slice(1).forEach(r => {
		const name = (r[iN] || '').trim();
		if (!name) { return; }
		const sku = iS >= 0 ? (r[iS] || '').trim() : '';
		const ex = sku ? S.products.find(p => (p.sku || '').toLowerCase() === sku.toLowerCase()) : null;
		const stockTxt = iQ >= 0 ? (r[iQ] || '').trim() : '';
		const rec = { ...(ex || {}), name, sku, price: num(r[iP]), cost: iK >= 0 ? num(r[iK]) : (ex ? ex.cost : 0), category: iC >= 0 ? (r[iC] || '').trim() : (ex ? ex.category : ''), track: stockTxt !== '' ? true : (ex ? ex.track : false), stock: stockTxt !== '' ? num(stockTxt) : (ex ? ex.stock : 0) };
		out.push(rec);
		ex ? updated++ : added++;
	});
	await DB.putMany('products', out);
	await refreshProducts();
	VIEWS.products();
	toast('Imported: ' + added + ' new, ' + updated + ' updated', 'ok');
}

/* =========================================================================
   REPORTS
   ========================================================================= */
function buildReport(bills) {
	const r = { count: 0, refundedCount: 0, gross: 0, refunds: 0, discounts: 0, tax: 0, cost: 0, items: {}, pay: {}, days: {} };
	bills.forEach(b => {
		r.count++;
		r.gross += b.total;
		const day = ymd(new Date(b.ts));
		const d = r.days[day] || (r.days[day] = { count: 0, gross: 0, refunds: 0 });
		d.count++; d.gross += b.total;
		if (b.status === 'refunded') { r.refundedCount++; r.refunds += b.total; d.refunds += b.total; return; }
		r.discounts += b.discount || 0;
		r.tax += b.tax || 0;
		r.pay[b.pay] = (r.pay[b.pay] || 0) + b.total;
		b.items.forEach(it => {
			r.cost += (it.cost || 0) * it.qty;
			const x = r.items[it.name] || (r.items[it.name] = { name: it.name, qty: 0, amount: 0 });
			x.qty += it.qty; x.amount += it.price * it.qty;
		});
	});
	r.net = r.gross - r.refunds;
	r.profit = r.net - r.tax - r.cost;
	return r;
}

function rangeFor(p) {
	const n = new Date(), d0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
	if (p === 'yesterday') { const y = new Date(d0); y.setDate(y.getDate() - 1); return [y, endOf(y)]; }
	if (p === 'week') { const s = new Date(d0); s.setDate(s.getDate() - 6); return [s, endOf(d0)]; }
	if (p === 'month') { return [new Date(n.getFullYear(), n.getMonth(), 1), endOf(d0)]; }
	return [d0, endOf(d0)];
}

VIEWS.reports = function () {
	const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'Last 7 days'], ['month', 'This month'], ['custom', 'Custom']];
	const td = ymd(new Date());
	$('#view').innerHTML = '<section class="page"><h1>Reports</h1><div class="seg" id="seg">' + presets.map(([k, l]) => '<button data-p="' + k + '" class="' + (S.rp === k ? 'on' : '') + '">' + l + '</button>').join('') + '</div>' +
		'<div class="filters ' + (S.rp === 'custom' ? '' : 'hide') + '" id="cust"><label>From<input type="date" id="rf" value="' + (S.rfrom || td) + '"></label><label>To<input type="date" id="rt" value="' + (S.rto || td) + '"></label></div><div id="rout"></div></section>';

	let current = null;
	async function load() {
		let a, b;
		if (S.rp === 'custom') { S.rfrom = $('#rf').value; S.rto = $('#rt').value; a = fromYmd(S.rfrom || td); b = fromYmd(S.rto || td, true); } else { [a, b] = rangeFor(S.rp); }
		const bills = (await DB.billsBetween(a.getTime(), b.getTime())).sort((x, y) => x.ts - y.ts);
		const r = buildReport(bills);
		current = { r, bills, a, b };
		const top = Object.values(r.items).sort((x, y) => y.amount - x.amount).slice(0, 10);
		const days = Object.keys(r.days).sort();
		const lowList = S.products.filter(p => p.track && p.stock <= num(S.settings.lowStock)).sort((x, y) => x.stock - y.stock);
		$('#rout').innerHTML =
			'<div class="stats"><div class="stat"><small>Bills</small><b>' + r.count + '</b></div><div class="stat"><small>Gross sales</small><b>' + money(r.gross) + '</b></div>' +
			'<div class="stat"><small>Refunds (' + r.refundedCount + ')</small><b>' + money(r.refunds) + '</b></div><div class="stat"><small>Discounts given</small><b>' + money(r.discounts) + '</b></div>' +
			'<div class="stat main"><small>Net sales</small><b>' + money(r.net) + '</b></div><div class="stat"><small>Estimated profit</small><b>' + money(r.profit) + '</b></div></div>' +
			'<div class="row wrap" style="margin-bottom:14px"><button class="btn primary" id="prSum">Print summary</button><button class="btn" id="exBills">Export bills (CSV)</button></div>' +
			'<div class="twocol"><div class="panel"><h2>Net sales by payment type</h2>' + (Object.keys(r.pay).length ? '<table class="t"><tbody>' + Object.keys(r.pay).map(k => '<tr><td>' + esc(k) + '</td><td class="n"><b>' + money(r.pay[k]) + '</b></td></tr>').join('') + '</tbody></table>' : '<p class="note">No sales in this period.</p>') + '</div>' +
			'<div class="panel"><h2>Top items</h2>' + (top.length ? '<div class="tw"><table class="t"><thead><tr><th>Item</th><th class="n">Qty</th><th class="n">Sales</th></tr></thead><tbody>' + top.map(i => '<tr><td>' + esc(i.name) + '</td><td class="n">' + trimNum(i.qty) + '</td><td class="n">' + money(i.amount) + '</td></tr>').join('') + '</tbody></table></div>' : '<p class="note">No items sold.</p>') + '</div></div>' +
			(days.length > 1 ? '<div class="panel"><h2>Daily totals</h2><div class="tw"><table class="t"><thead><tr><th>Date</th><th class="n">Bills</th><th class="n">Gross</th><th class="n">Refunds</th><th class="n">Net</th></tr></thead><tbody>' + days.map(k => '<tr><td>' + k + '</td><td class="n">' + r.days[k].count + '</td><td class="n">' + money(r.days[k].gross) + '</td><td class="n">' + money(r.days[k].refunds) + '</td><td class="n"><b>' + money(r.days[k].gross - r.days[k].refunds) + '</b></td></tr>').join('') + '</tbody></table></div></div>' : '') +
			(lowList.length ? '<div class="panel"><h2>Low stock (' + lowList.length + ')</h2><div class="tw"><table class="t"><tbody>' + lowList.slice(0, 30).map(p => '<tr><td>' + esc(p.name) + '</td><td class="n low">' + trimNum(p.stock) + ' left</td></tr>').join('') + '</tbody></table></div></div>' : '') +
			'<p class="note">Estimated profit = net sales (without tax) minus the cost price of items sold. Items with no cost price count as zero cost. Refunds are counted on the date of the original bill.</p>';
		$('#prSum').addEventListener('click', () => printHtml(summaryHtml(current)));
		$('#exBills').addEventListener('click', () => {
			const rows = [['bill', 'date', 'customer', 'phone', 'payment', 'status', 'items', 'subtotal', 'discount', 'tax', 'total']].concat(current.bills.map(x => [x.label, fmtDT(x.ts), (x.customer && x.customer.name) || '', (x.customer && x.customer.phone) || '', x.pay, x.status, x.items.reduce((s, i) => s + i.qty, 0), x.subtotal, x.discount, x.tax || 0, x.total]));
			saveFile('techno-pos-bills-' + ymd(a) + '_to_' + ymd(b) + '.csv', 'text/csv', toCSV(rows));
		});
	}
	$('#seg').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) { S.rp = b.dataset.p; VIEWS.reports(); } });
	$('#rf').addEventListener('change', load);
	$('#rt').addEventListener('change', load);
	load();
};

function summaryHtml(cur) {
	const s = S.settings, r = cur.r, narrow = s.width === '58';
	const line = (a, b, bold) => '<tr' + (bold ? ' class="b"' : '') + '><td>' + esc(a) + '</td><td class="r">' + b + '</td></tr>';
	const top = Object.values(r.items).sort((x, y) => y.amount - x.amount).slice(0, 10);
	return '<!doctype html><html><head><meta charset="utf-8"><title>Sales summary</title><style>@page{margin:0}body{font-family:monospace;font-size:' + (narrow ? '11px' : '12px') + ';width:' + (narrow ? '48mm' : '72mm') + ';margin:0 auto;padding:4mm}' +
		'h2,p{text-align:center;margin:2px 0}table{width:100%;border-collapse:collapse}td{padding:1px 0;vertical-align:top}.r{text-align:right}hr{border:0;border-top:1px dashed #000;margin:6px 0}.b td{font-weight:bold}</style></head><body>' +
		'<h2>' + esc(s.name) + '</h2><p>SALES SUMMARY</p><p>' + ymd(cur.a) + (ymd(cur.a) !== ymd(cur.b) ? ' to ' + ymd(cur.b) : '') + '</p><p>Printed ' + esc(fmtDT(Date.now())) + '</p><hr><table>' +
		line('Bills', r.count) + line('Gross sales', money(r.gross)) + line('Refunds (' + r.refundedCount + ')', '-' + money(r.refunds)) + line('Discounts given', money(r.discounts)) + line('NET SALES', money(r.net), true) + '</table><hr><p>By payment</p><table>' +
		Object.keys(r.pay).map(k => line(k, money(r.pay[k]))).join('') + '</table>' +
		(top.length ? '<hr><p>Top items</p><table>' + top.map(i => line(i.name + ' x' + trimNum(i.qty), money(i.amount))).join('') + '</table>' : '') + '<hr></body></html>';
}

/* =========================================================================
   SETTINGS + BACKUP
   ========================================================================= */
VIEWS.settings = async function () {
	const s = S.settings;
	const nb = await DB.count('bills');
	const lb = s.lastBackup ? fmtDT(s.lastBackup) : 'never';
	$('#view').innerHTML = '<section class="page"><h1>Settings</h1>' +
		'<div class="panel"><h2>Business details (printed on every bill)</h2><div class="formgrid">' +
		'<label class="f full">Business name<input id="sName" value="' + esc(s.name) + '"></label>' +
		'<label class="f full">Business address<textarea id="sAddr" rows="2">' + esc(s.address) + '</textarea></label>' +
		'<label class="f">Business phone<input id="sPhone" value="' + esc(s.phone) + '"></label>' +
		'<label class="f">Cashier name on bills<input id="sCash" value="' + esc(s.cashier) + '"></label>' +
		'<label class="f full">Bill footer message<input id="sFoot" value="' + esc(s.footer) + '"></label></div></div>' +
		'<div class="panel"><h2>Sales &amp; printing</h2><div class="formgrid">' +
		'<label class="f">Currency symbol<input id="sCur" value="' + esc(s.currency) + '"></label>' +
		'<label class="f">Decimal places<select id="sDec"><option value="2">2 (1,250.00)</option><option value="0">0 (1,250)</option></select></label>' +
		'<label class="f">Tax / VAT name<input id="sTaxN" value="' + esc(s.taxName) + '"></label>' +
		'<label class="f">Tax / VAT rate (%) - 0 for none<input id="sTax" type="number" min="0" step="any" value="' + esc(s.taxRate) + '"></label>' +
		'<label class="f">Maximum discount per bill (%)<input id="sMax" type="number" min="0" max="100" step="any" value="' + esc(s.maxDisc) + '"></label>' +
		'<label class="f">Low stock alert at<input id="sLow" type="number" min="0" step="any" value="' + esc(s.lowStock) + '"></label>' +
		'<label class="f">Bill number prefix (optional)<input id="sPre" value="' + esc(s.prefix) + '" placeholder="e.g. TP-"></label>' +
		'<label class="f">Receipt paper width<select id="sWid"><option value="80">80 mm</option><option value="58">58 mm</option></select></label>' +
		'<label class="chk full"><input type="checkbox" id="sAuto"' + (s.autoPrint ? ' checked' : '') + '> Open the print dialog automatically after each sale</label></div></div>' +
		'<div class="panel"><h2>Owner PIN</h2><p class="note">With a PIN set, Products, Reports, Settings and refunds need the PIN. Cashiers can still sell and reprint bills. This stops casual access only; it is not strong security.</p>' +
		'<div class="row wrap"><input id="sPin" type="password" inputmode="numeric" placeholder="' + (s.pin ? 'New PIN (leave empty to keep)' : 'Choose a PIN (4+ digits)') + '" autocomplete="off">' + (s.pin ? '<button class="btn danger" id="rmPin">Remove PIN</button>' : '') + '</div></div>' +
		'<div class="row" style="margin-bottom:14px"><button class="btn primary" id="saveS">Save settings</button></div>' +
		'<div class="panel"><h2>Backup &amp; restore</h2><p class="note">All products and bills are stored only on this device. If the device is lost, reset or the app is uninstalled, the data is gone, so back up regularly and keep the file somewhere safe (email it, or copy it to a computer).</p>' +
		'<p>' + nb + ' bill(s) saved. Last backup: <b>' + lb + '</b></p><div class="row wrap"><button class="btn primary" id="bkp">Back up now</button><button class="btn" id="rst">Restore from backup</button></div></div>' +
		'<div class="panel"><h2>Danger zone</h2><button class="btn danger" id="wipe">Delete ALL data on this device</button></div></section>';
	$('#sDec').value = String(dec()); $('#sWid').value = s.width;

	$('#saveS').addEventListener('click', async () => {
		const n = S.settings;
		n.name = $('#sName').value.trim() || 'My Shop'; n.address = $('#sAddr').value.trim(); n.phone = $('#sPhone').value.trim();
		n.cashier = $('#sCash').value.trim() || 'Cashier'; n.footer = $('#sFoot').value.trim();
		n.currency = $('#sCur').value.trim(); n.decimals = Number($('#sDec').value);
		n.taxName = $('#sTaxN').value.trim() || 'Tax'; n.taxRate = Math.max(0, num($('#sTax').value));
		n.maxDisc = Math.min(100, Math.max(0, num($('#sMax').value))); n.lowStock = Math.max(0, num($('#sLow').value));
		n.prefix = $('#sPre').value.trim(); n.width = $('#sWid').value; n.autoPrint = $('#sAuto').checked;
		const pin = $('#sPin').value.trim();
		if (pin) {
			if (pin.length < 4) { toast('PIN must be at least 4 characters', 'err'); return; }
			n.pin = hashPin(pin); S.unlockedUntil = Date.now() + 600000;
		}
		await saveSettings();
		renderNav();
		toast('Settings saved', 'ok');
		if (pin) { VIEWS.settings(); }
	});
	const rm = $('#rmPin');
	if (rm) { rm.addEventListener('click', async () => { if (await confirmBox('Remove the owner PIN?', 'Remove', true)) { S.settings.pin = ''; await saveSettings(); renderNav(); VIEWS.settings(); toast('PIN removed', 'ok'); } }); }

	$('#bkp').addEventListener('click', async () => {
		S.settings.lastBackup = Date.now();
		await saveSettings();
		const d = new Date();
		saveFile('technopos-backup-' + ymd(d) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json', 'application/json', JSON.stringify(await DB.exportAll()));
		VIEWS.settings();
	});
	$('#rst').addEventListener('click', async () => {
		const f = await pickFile('.json,application/json');
		if (!f) { return; }
		let data;
		try { data = JSON.parse(f.text); } catch (e) { data = null; }
		if (!data || data.app !== 'technopos') { toast('That is not a Techno POS backup file', 'err'); return; }
		if (!(await confirmBox('Restore this backup? It will REPLACE everything on this device (' + (data.bills || []).length + ' bills, ' + (data.products || []).length + ' products).', 'Restore', true))) { return; }
		await DB.importAll(data);
		await loadAll();
		resetSale();
		renderNav();
		toast('Backup restored', 'ok');
		go('sell');
	});
	$('#wipe').addEventListener('click', async () => {
		const v = await inputBox('Delete all data', 'This removes every product, bill and setting on this device. Type DELETE to confirm.', { ok: 'Delete everything' });
		if (v !== 'DELETE') { if (v != null) { toast('Not deleted - you must type DELETE', 'err'); } return; }
		await DB.clearAll();
		await loadAll();
		resetSale();
		renderNav();
		toast('All data deleted', 'ok');
		go('sell');
	});
};

/* =========================================================================
   Boot
   ========================================================================= */
$('#nav').addEventListener('click', e => {
	const t = e.target.closest('button');
	if (!t) { return; }
	if (t.hasAttribute('data-lock')) {
		if (unlocked()) { S.unlockedUntil = 0; renderNav(); if (PROTECTED.has(S.tab)) { go('sell'); } toast('Locked', 'ok'); } else { requirePin(); }
		return;
	}
	if (t.dataset.tab) { go(t.dataset.tab); }
});

// Android back button (called from the native wrapper).
window.onAndroidBack = () => {
	const ms = document.querySelectorAll('.modal');
	if (ms.length) { ms[ms.length - 1].dispatchEvent(new Event('x-close')); return true; }
	if (S.cartOpen) { S.cartOpen = false; const el = $('#sell'); if (el) { el.classList.remove('cart-open'); } return true; }
	if (S.tab !== 'sell') { go('sell'); return true; }
	return false;
};

document.addEventListener('keydown', e => {
	if (S.tab !== 'sell' || document.querySelector('.modal')) { return; }
	if (e.key === 'F2') { e.preventDefault(); const q = $('#q'); if (q) { q.focus(); q.select(); } }
	if (e.key === 'F9') { e.preventDefault(); checkout(); }
});

(async function boot() {
	try {
		await DB.open();
		await loadAll();
	} catch (e) {
		$('#view').innerHTML = '<section class="page"><h1>Storage problem</h1><p>This browser could not open its local database, so Techno POS cannot save data. Try a normal (non-private) window, or free up storage space.</p></section>';
		return;
	}
	if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }
	renderNav();
	await go('sell');
	if (!window.Android && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
		navigator.serviceWorker.register('sw.js').catch(() => {});
	}
	const nb = await DB.count('bills');
	if (nb > 0 && Date.now() - (S.settings.lastBackup || 0) > 7 * 864e5) { toast('Reminder: back up your data (Settings > Backup)', 'err'); }
})();

})();
