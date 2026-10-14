/* Techno POS - local database (IndexedDB). Everything is stored on the device. */
const DB = (() => {
	let db;
	const r3 = x => Math.round(x * 1000) / 1000;

	const rq = r => new Promise((res, rej) => {
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});

	// Resolves when a transaction commits. The catch() only marks the rejection as handled;
	// awaiting the returned promise still throws on failure.
	const fin = t => {
		const p = new Promise((res, rej) => {
			t.oncomplete = () => res();
			t.onerror = () => rej(t.error);
			t.onabort = () => rej(t.error || new Error('Transaction aborted'));
		});
		p.catch(() => {});
		return p;
	};

	function open() {
		return new Promise((res, rej) => {
			const r = indexedDB.open('technopos', 1);
			r.onupgradeneeded = () => {
				const d = r.result;
				d.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
				const b = d.createObjectStore('bills', { keyPath: 'no' });
				b.createIndex('ts', 'ts');
				d.createObjectStore('meta', { keyPath: 'k' });
			};
			r.onsuccess = () => { db = r.result; res(); };
			r.onerror = () => rej(r.error);
		});
	}

	const all = s => rq(db.transaction(s).objectStore(s).getAll());
	const get = (s, k) => rq(db.transaction(s).objectStore(s).get(k));
	const count = s => rq(db.transaction(s).objectStore(s).count());
	const billsBetween = (a, b) => rq(db.transaction('bills').objectStore('bills').index('ts').getAll(IDBKeyRange.bound(a, b)));

	async function put(s, o) {
		const t = db.transaction(s, 'readwrite');
		const d = fin(t);
		const k = await rq(t.objectStore(s).put(o));
		await d;
		return k;
	}

	async function del(s, k) {
		const t = db.transaction(s, 'readwrite');
		const d = fin(t);
		t.objectStore(s).delete(k);
		await d;
	}

	async function putMany(s, arr) {
		const t = db.transaction(s, 'readwrite');
		const d = fin(t);
		const st = t.objectStore(s);
		arr.forEach(o => st.put(o));
		await d;
	}

	/* Save a bill, take stock off and advance the bill counter in ONE transaction,
	   so a bill is never half-saved. */
	async function saveSale(bill) {
		const t = db.transaction(['bills', 'products', 'meta'], 'readwrite');
		const d = fin(t);
		try {
			const meta = t.objectStore('meta'), prod = t.objectStore('products'), bills = t.objectStore('bills');
			const c = await rq(meta.get('counter'));
			const no = (c ? c.v : 1000) + 1;
			for (const it of bill.items) {
				if (it.pid != null && it.track) {
					const p = await rq(prod.get(it.pid));
					if (p && p.track) {
						if (p.stock < it.qty) throw new Error('Not enough stock for ' + p.name + ' (only ' + p.stock + ' left)');
						p.stock = r3(p.stock - it.qty);
						await rq(prod.put(p));
					}
				}
			}
			bill.no = no;
			bill.label = (bill.prefix || '') + no;
			await rq(bills.put(bill));
			await rq(meta.put({ k: 'counter', v: no }));
		} catch (e) {
			try { t.abort(); } catch (_) { /* already finished */ }
			throw e;
		}
		await d;
		return bill;
	}

	/* Full refund: mark the bill refunded and put the items back into stock. */
	async function refundBill(no, reason) {
		const t = db.transaction(['bills', 'products'], 'readwrite');
		const d = fin(t);
		try {
			const B = t.objectStore('bills'), P = t.objectStore('products');
			const b = await rq(B.get(no));
			if (!b) throw new Error('Bill not found');
			if (b.status !== 'completed') throw new Error('This bill is already refunded');
			for (const it of b.items) {
				if (it.pid != null && it.track) {
					const p = await rq(P.get(it.pid));
					if (p && p.track) {
						p.stock = r3(p.stock + it.qty);
						await rq(P.put(p));
					}
				}
			}
			b.status = 'refunded';
			b.refundedAt = Date.now();
			b.refundReason = reason || '';
			await rq(B.put(b));
		} catch (e) {
			try { t.abort(); } catch (_) { /* already finished */ }
			throw e;
		}
		await d;
	}

	async function exportAll() {
		const [products, bills, settings, counter, held] = await Promise.all([
			all('products'), all('bills'), get('meta', 'settings'), get('meta', 'counter'), get('meta', 'held')
		]);
		return {
			app: 'technopos', version: 1, exported: new Date().toISOString(),
			settings: settings ? settings.v : null,
			counter: counter ? counter.v : 1000,
			held: held ? held.v : [],
			products, bills
		};
	}

	async function importAll(data) {
		const t = db.transaction(['products', 'bills', 'meta'], 'readwrite');
		const d = fin(t);
		const P = t.objectStore('products'), B = t.objectStore('bills'), M = t.objectStore('meta');
		P.clear(); B.clear(); M.clear();
		(data.products || []).forEach(x => P.put(x));
		(data.bills || []).forEach(x => B.put(x));
		if (data.settings) { M.put({ k: 'settings', v: data.settings }); }
		const maxNo = (data.bills || []).reduce((m, b) => Math.max(m, b.no || 0), 1000);
		M.put({ k: 'counter', v: Math.max(maxNo, data.counter || 0) });
		if (data.held) { M.put({ k: 'held', v: data.held }); }
		await d;
	}

	async function clearAll() {
		const t = db.transaction(['products', 'bills', 'meta'], 'readwrite');
		const d = fin(t);
		['products', 'bills', 'meta'].forEach(s => t.objectStore(s).clear());
		await d;
	}

	return { open, all, get, count, put, del, putMany, billsBetween, saveSale, refundBill, exportAll, importAll, clearAll };
})();
