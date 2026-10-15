/* Part Inspection — offline PWA. Records + photos live in IndexedDB on the phone. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var P = window.PartParse;

  // ---------- IndexedDB ----------
  var dbp = new Promise(function (res, rej) {
    var r = indexedDB.open('part-inspect', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('records', { keyPath: 'id' }); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
  function tx(mode, fn) {
    return dbp.then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction('records', mode), s = t.objectStore('records'), out;
        var q = fn(s);
        if (q) q.onsuccess = function () { out = q.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('Storage aborted')); };
      });
    });
  }
  var DB = {
    all: function () { return tx('readonly', function (s) { return s.getAll(); }); },
    put: function (r) { return tx('readwrite', function (s) { return s.put(r); }); },
    del: function (id) { return tx('readwrite', function (s) { return s.delete(id); }); },
    clear: function () { return tx('readwrite', function (s) { return s.clear(); }); }
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  // ---------- state ----------
  var records = [];
  var cur = null;          // { id, photos: [{key, blob, url}] , createdAt }
  var thumbUrls = [];

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function nowParts() {
    var d = new Date();
    return { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), time: pad(d.getHours()) + ':' + pad(d.getMinutes()) };
  }

  // ---------- UI helpers ----------
  var toastT;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function ask(msg, yesLabel) {
    return new Promise(function (res) {
      $('sheetMsg').textContent = msg;
      $('sheetYes').textContent = yesLabel || 'ยืนยัน';
      $('sheet').hidden = false;
      function done(v) { $('sheet').hidden = true; $('sheetYes').onclick = $('sheetNo').onclick = null; res(v); }
      $('sheetYes').onclick = function () { done(true); };
      $('sheetNo').onclick = function () { done(false); };
    });
  }
  function showErr(msg) { var e = $('formErr'); e.textContent = msg || ''; e.hidden = !msg; }

  // ---------- image handling ----------
  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(file); });
    }
    return new Promise(function (res, rej) {
      var img = new Image(); img.onload = function () { res(img); }; img.onerror = rej; img.src = URL.createObjectURL(file);
    });
  }
  function drawScaled(bmp, maxSide) {
    var w = bmp.width, h = bmp.height, k = Math.min(1, maxSide / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  function compress(file) {
    return loadBitmap(file).then(function (bmp) {
      var c = drawScaled(bmp, 2400);
      return new Promise(function (res) { c.toBlob(function (b) { res(b || file); }, 'image/jpeg', 0.88); });
    }).catch(function () { return file; });
  }
  function addPhotoBlob(blob) {
    cur.photos.push({ key: uid(), blob: blob, url: URL.createObjectURL(blob) });
    renderPhotos();
  }
  function handlePhotoFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    return arr.reduce(function (p, f) { return p.then(function () { return compress(f).then(addPhotoBlob); }); }, Promise.resolve());
  }
  function renderPhotos() {
    var g = $('photoGrid'); g.innerHTML = '';
    cur.photos.forEach(function (ph, i) {
      var d = document.createElement('div'); d.className = 'ph';
      var img = document.createElement('img'); img.src = ph.url; img.alt = 'รูปที่ ' + (i + 1);
      img.onclick = function () { $('viewerImg').src = ph.url; $('viewer').hidden = false; };
      var n = document.createElement('span'); n.className = 'n'; n.textContent = pad(i + 1);
      var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'ลบรูปที่ ' + (i + 1));
      x.onclick = function () { URL.revokeObjectURL(ph.url); cur.photos.splice(i, 1); renderPhotos(); };
      d.append(img, n, x); g.appendChild(d);
    });
    $('photoCount').textContent = cur.photos.length;
  }

  // ---------- form ----------
  function newForm() {
    if (cur) cur.photos.forEach(function (p) { URL.revokeObjectURL(p.url); });
    cur = { id: null, photos: [] };
    var n = nowParts();
    $('pn').value = ''; $('sn').value = ''; $('remark').value = '';
    $('date').value = n.date; $('time').value = n.time; $('pfr').checked = false;
    $('formTitle').textContent = 'ชิ้นใหม่'; $('cancelEdit').hidden = true;
    $('formPanel').classList.remove('editing');
    $('ocrBox').hidden = true; $('dupWarn').hidden = true; showErr('');
    renderPhotos();
  }
  function editRecord(r) {
    newForm();
    cur.id = r.id; cur.createdAt = r.createdAt;
    $('pn').value = r.pn; $('sn').value = r.sn; $('remark').value = r.remark || '';
    $('date').value = r.date; $('time').value = r.time; $('pfr').checked = !!r.pfr;
    r.photos.forEach(function (b) { addPhotoBlob(b); });
    $('formTitle').textContent = 'แก้ไข ' + r.pn + ' / ' + r.sn; $('cancelEdit').hidden = false;
    $('formPanel').classList.add('editing');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function findDup(pn, sn) {
    return records.find(function (r) { return r.pn === pn && r.sn === sn && r.id !== cur.id; });
  }
  function checkDup() {
    var pn = P.clean($('pn').value), sn = P.clean($('sn').value), w = $('dupWarn');
    var d = pn && sn && findDup(pn, sn);
    w.hidden = !d;
    if (d) w.textContent = 'P/N + S/N นี้บันทึกไว้แล้วเมื่อ ' + d.date + ' ' + d.time;
  }

  function save() {
    showErr('');
    var pn = P.clean($('pn').value), sn = P.clean($('sn').value);
    if (!pn || !sn) { showErr('กรอก P/N และ S/N ให้ครบก่อนบันทึก'); (pn ? $('sn') : $('pn')).focus(); return; }
    var chain = Promise.resolve(true);
    var dup = findDup(pn, sn);
    if (dup) chain = chain.then(function (ok) { return ok && ask('P/N ' + pn + ' S/N ' + sn + ' มีอยู่แล้ว (' + dup.date + ' ' + dup.time + ') บันทึกซ้ำอีกรายการ?', 'บันทึกซ้ำ'); });
    if (!cur.photos.length) chain = chain.then(function (ok) { return ok && ask('ยังไม่มีรูปถ่าย บันทึกต่อเลยไหม?', 'บันทึก'); });
    chain.then(function (ok) {
      if (!ok) return;
      var rec = {
        id: cur.id || uid(), createdAt: cur.createdAt || Date.now(), updatedAt: Date.now(),
        pn: pn, sn: sn, date: $('date').value, time: $('time').value,
        pfr: $('pfr').checked, remark: $('remark').value.trim(),
        photos: cur.photos.map(function (p) { return p.blob; }), exported: false
      };
      var wasEdit = !!cur.id;
      return DB.put(rec).then(function () {
        toast((wasEdit ? 'แก้ไขแล้ว ' : 'บันทึกแล้ว ') + pn + ' / ' + sn);
        newForm(); return loadList();
      }).then(function () { if (!wasEdit) $('pn').focus(); });
    }).catch(function (e) { showErr('บันทึกไม่สำเร็จ: ' + (e && e.message || e) + ' (พื้นที่ในเครื่องอาจเต็ม ลอง Export แล้วลบรายการเก่า)'); });
  }

  // ---------- list ----------
  function loadList() {
    return DB.all().then(function (rs) {
      records = (rs || []).sort(function (a, b) { return b.createdAt - a.createdAt; });
      renderList();
    });
  }
  function renderList() {
    thumbUrls.forEach(URL.revokeObjectURL); thumbUrls = [];
    var ul = $('list'); ul.innerHTML = '';
    records.forEach(function (r) {
      var li = document.createElement('li'); li.className = 'item';
      var th = document.createElement('img'); th.className = 'thumb'; th.alt = '';
      if (r.photos[0]) { var u = URL.createObjectURL(r.photos[0]); thumbUrls.push(u); th.src = u; }
      var m = document.createElement('div'); m.className = 'meta';
      m.innerHTML = '<div class="pnsn"><span>P/N</span></div><div class="pnsn"><span>S/N</span></div><div class="sub"></div>';
      m.children[0].append(r.pn); m.children[1].append(r.sn);
      var sub = m.children[2];
      sub.append(r.date + ' ' + r.time + ' · ' + r.photos.length + ' รูป ');
      var pill = document.createElement('span'); pill.className = 'pill ' + (r.pfr ? 'yes' : 'no'); pill.textContent = r.pfr ? 'PFR ✓' : 'ไม่มี PFR';
      sub.appendChild(pill);
      if (r.exported) { var ex = document.createElement('span'); ex.textContent = 'export แล้ว'; sub.appendChild(ex); }
      var a = document.createElement('div'); a.className = 'acts';
      var eb = document.createElement('button'); eb.type = 'button'; eb.textContent = 'แก้ไข'; eb.onclick = function () { editRecord(r); };
      var db = document.createElement('button'); db.type = 'button'; db.className = 'del'; db.textContent = 'ลบ';
      db.onclick = function () {
        ask('ลบ P/N ' + r.pn + ' S/N ' + r.sn + ' พร้อมรูป ' + r.photos.length + ' รูป? ลบแล้วกู้คืนไม่ได้', 'ลบ').then(function (ok) {
          if (ok) DB.del(r.id).then(loadList).then(function () { toast('ลบแล้ว'); if (cur.id === r.id) newForm(); });
        });
      };
      a.append(eb, db);
      li.append(th, m, a); ul.appendChild(li);
    });
    $('emptyState').hidden = records.length > 0;
    $('dangerZone').hidden = records.length === 0;
    $('countLabel').textContent = records.length + ' รายการ · ' + records.reduce(function (s, r) { return s + r.photos.length; }, 0) + ' รูป';
    $('exportBtn').disabled = records.length === 0;
  }

  // ---------- scan: 2D barcode first, OCR fallback ----------
  var ocrWorker = null;
  function getWorker(onProgress) {
    if (ocrWorker) return ocrWorker;
    var abs = function (p) { return new URL(p, location.href).href; };
    ocrWorker = Tesseract.createWorker('eng', 1, {
      workerPath: abs('vendor/worker.min.js'),
      corePath: abs('vendor/core/'),
      langPath: abs('vendor/lang'),
      workerBlobURL: false,
      logger: function (m) { if (onProgress) onProgress(m); }
    }).catch(function (e) { ocrWorker = null; throw e; });
    return ocrWorker;
  }

  function detectBarcode(bmp) {
    if (!('BarcodeDetector' in window)) return Promise.resolve(null);
    var fmts = ['data_matrix', 'qr_code', 'pdf417', 'code_128', 'code_39', 'aztec'];
    return BarcodeDetector.getSupportedFormats().then(function (sup) {
      var use = fmts.filter(function (f) { return sup.indexOf(f) >= 0; });
      if (!use.length) return null;
      return new BarcodeDetector({ formats: use }).detect(bmp).then(function (codes) {
        return codes && codes.length ? codes.map(function (c) { return c.rawValue; }) : null;
      });
    }).catch(function () { return null; });
  }

  function ocrCanvas(bmp) {
    var c = drawScaled(bmp, 1800), ctx = c.getContext('2d');
    var d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
    for (var i = 0; i < px.length; i += 4) {
      var g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      g = Math.max(0, Math.min(255, (g - 128) * 1.4 + 128));
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  function setStatus(html) { $('ocrStatus').innerHTML = html; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function applyFound(found, source) {
    var parts = [];
    if (found.pn) { if (!$('pn').value) $('pn').value = found.pn; parts.push('P/N <b>' + esc(found.pn) + '</b>'); }
    if (found.sn) { if (!$('sn').value) $('sn').value = found.sn; parts.push('S/N <b>' + esc(found.sn) + '</b>'); }
    checkDup();
    var note = (found.pn && $('pn').value !== found.pn) || (found.sn && $('sn').value !== found.sn) ? ' (ช่องที่กรอกไว้แล้วไม่ถูกเขียนทับ)' : '';
    setStatus(parts.length
      ? source + ' อ่านได้ ' + parts.join(' · ') + note + '<br>ตรวจทุกตัวอักษรกับป้ายจริงก่อนบันทึก'
      : source + ' หา P/N, S/N ไม่เจอ แตะบรรทัดด้านล่างเพื่อใส่เอง');
  }

  function renderLines(lines) {
    var box = $('ocrLines'); box.innerHTML = '';
    lines.forEach(function (line) {
      var row = document.createElement('div'); row.className = 'ocr-line';
      var code = document.createElement('code'); code.textContent = line;
      var v = P.stripLabel(line);
      var b1 = document.createElement('button'); b1.type = 'button'; b1.textContent = '→ P/N';
      b1.onclick = function () { $('pn').value = v; checkDup(); toast('P/N = ' + v); };
      var b2 = document.createElement('button'); b2.type = 'button'; b2.textContent = '→ S/N';
      b2.onclick = function () { $('sn').value = v; checkDup(); toast('S/N = ' + v); };
      row.append(code, b1, b2); box.appendChild(row);
    });
  }

  function scan(file) {
    $('ocrBox').hidden = false; $('ocrLines').innerHTML = '';
    setStatus('กำลังอ่านภาพ…');
    var keep = compress(file).then(function (b) { addPhotoBlob(b); return cur.photos.length; });
    loadBitmap(file).then(function (bmp) {
      return detectBarcode(bmp).then(function (codes) {
        if (codes) {
          var text = codes.join('\n');
          applyFound(P.parseSpec2000(text), '2D barcode');
          renderLines(P.candidateLines(text.replace(/\*/g, '\n')));
          return;
        }
        setStatus('ไม่พบ 2D barcode กำลัง OCR… (ครั้งแรกใช้เวลาโหลดสักครู่)');
        var c = ocrCanvas(bmp);
        return getWorker(function (m) {
          if (m.status === 'recognizing text') setStatus('กำลัง OCR ' + Math.round(m.progress * 100) + '%');
        }).then(function (w) { return w.recognize(c); }).then(function (r) {
          var text = (r && r.data && r.data.text) || '';
          applyFound(P.parseLabels(text), 'OCR');
          renderLines(P.candidateLines(text));
        });
      });
    }).catch(function (e) {
      setStatus('อ่านภาพไม่สำเร็จ: ' + esc(e && e.message || e) + ' กรอก P/N, S/N เองได้');
    });
    keep.then(function (n) { toast('เก็บรูปป้ายเป็นรูปที่ ' + n + ' แล้ว'); });
  }

  // ---------- export ----------
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()); }

  function exportAll() {
    if (!records.length) return;
    var btn = $('exportBtn'); btn.disabled = true; btn.textContent = 'กำลังสร้างไฟล์…';
    var zip = new JSZip(), st = stamp();
    var root = zip.folder('Inspection_' + st), photosDir = root.folder('photos');
    var ordered = records.slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
    var rows = [['No', 'Date', 'Time', 'P/N', 'S/N', 'PFR', 'Photos', 'Photo folder', 'Remark']];
    ordered.forEach(function (r, i) {
      var no = ('00' + (i + 1)).slice(-3);
      var folder = no + '_' + P.safeName(r.pn) + '_' + P.safeName(r.sn);
      var f = photosDir.folder(folder);
      r.photos.forEach(function (b, j) { f.file(P.safeName(r.pn) + '_' + P.safeName(r.sn) + '_' + pad(j + 1) + '.jpg', b); });
      rows.push([i + 1, r.date, r.time, r.pn, r.sn, r.pfr ? 'Yes' : 'No', r.photos.length, 'photos/' + folder, r.remark || '']);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 5 }, { wch: 11 }, { wch: 7 }, { wch: 22 }, { wch: 18 }, { wch: 6 }, { wch: 7 }, { wch: 40 }, { wch: 30 }];
    for (var R = 1; R < rows.length; R++) { // keep P/N and S/N as text so Excel never strips leading zeros
      ['D', 'E'].forEach(function (col) { var c = ws[col + (R + 1)]; if (c) { c.t = 's'; c.z = '@'; } });
    }
    ws['!autofilter'] = { ref: 'A1:I' + rows.length };
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Inspection');
    root.file('Inspection_' + st + '.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));

    zip.generateAsync({ type: 'blob', compression: 'STORE' }).then(function (blob) {
      var name = 'Inspection_' + st + '.zip';
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      return Promise.all(records.map(function (r) { r.exported = true; return DB.put(r); })).then(function () {
        var msg = $('exportMsg'); msg.hidden = false;
        msg.innerHTML = '';
        msg.append('สร้าง ' + name + ' แล้ว (' + (blob.size / 1048576).toFixed(1) + ' MB, ' + ordered.length + ' รายการ) ไฟล์อยู่ในโฟลเดอร์ Download ');
        var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'link danger'; clr.textContent = 'ลบรายการที่ export แล้วออกจากเครื่อง';
        clr.onclick = function () {
          ask('ตรวจแล้วว่าไฟล์ ZIP เปิดได้และคัดลอกไปเก็บแล้ว? ' + records.filter(function (r) { return r.exported; }).length + ' รายการจะถูกลบจากเครื่อง', 'ลบ').then(function (ok) {
            if (!ok) return;
            Promise.all(records.filter(function (r) { return r.exported; }).map(function (r) { return DB.del(r.id); }))
              .then(loadList).then(function () { msg.hidden = true; toast('ลบแล้ว'); });
          });
        };
        msg.appendChild(clr);
        return loadList();
      });
    }).catch(function (e) {
      toast('Export ไม่สำเร็จ: ' + (e && e.message || e));
    }).then(function () { btn.disabled = records.length === 0; btn.textContent = 'Export ZIP + Excel'; });
  }

  // ---------- wiring ----------
  function onFile(input, fn) { input.addEventListener('change', function () { var f = input.files; if (f && f.length) fn(f); input.value = ''; }); }
  onFile($('camInput'), handlePhotoFiles);
  onFile($('galInput'), handlePhotoFiles);
  onFile($('scanInput'), function (f) { scan(f[0]); });
  ['pn', 'sn'].forEach(function (id) {
    $(id).addEventListener('input', function () { showErr(''); checkDup(); });
    $(id).addEventListener('blur', function () { $(id).value = P.clean($(id).value); checkDup(); });
  });
  $('pn').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('sn').focus(); } });
  $('sn').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('sn').blur(); } });
  $('saveBtn').onclick = save;
  $('cancelEdit').onclick = newForm;
  $('exportBtn').onclick = exportAll;
  $('viewerClose').onclick = function () { $('viewer').hidden = true; };
  $('viewer').onclick = function (e) { if (e.target === $('viewer')) $('viewer').hidden = true; };
  $('clearAllBtn').onclick = function () {
    var notExp = records.filter(function (r) { return !r.exported; }).length;
    ask('ลบทั้งหมด ' + records.length + ' รายการ' + (notExp ? ' (ในนี้ ' + notExp + ' รายการยังไม่ได้ export)' : '') + ' กู้คืนไม่ได้', 'ลบทั้งหมด')
      .then(function (ok) { if (ok) DB.clear().then(loadList).then(function () { newForm(); toast('ลบทั้งหมดแล้ว'); }); });
  };

  function netLabel() {
    var ready = navigator.serviceWorker && navigator.serviceWorker.controller;
    $('netState').textContent = ready ? 'พร้อมใช้ offline' : (navigator.onLine ? 'กำลังเตรียม offline' : 'offline');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; }).then(netLabel).catch(netLabel);
    navigator.serviceWorker.addEventListener('controllerchange', netLabel);
  }
  window.addEventListener('online', netLabel); window.addEventListener('offline', netLabel);
  netLabel();

  newForm();
  loadList().catch(function (e) { showErr('เปิดฐานข้อมูลในเครื่องไม่ได้: ' + (e && e.message || e)); });
})();
