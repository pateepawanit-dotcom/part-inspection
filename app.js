/* Part Inspection — offline PWA. Records, photos and settings live in IndexedDB on the phone. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var P = window.PartParse;

  // ---------- IndexedDB ----------
  var dbp = new Promise(function (res, rej) {
    var r = indexedDB.open('part-inspect', 2);
    r.onupgradeneeded = function () {
      var db = r.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
  function tx(store, mode, fn) {
    return dbp.then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), s = t.objectStore(store), out;
        var q = fn(s, function (v) { out = v; });
        if (q && 'onsuccess' in q) q.onsuccess = function () { out = q.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('Storage aborted')); };
      });
    });
  }
  var DB = {
    all: function () { return tx('records', 'readonly', function (s) { return s.getAll(); }); },
    put: function (r) { return tx('records', 'readwrite', function (s) { return s.put(r); }); },
    del: function (id) { return tx('records', 'readwrite', function (s) { return s.delete(id); }); },
    clear: function () { return tx('records', 'readwrite', function (s) { return s.clear(); }); },
    getMeta: function (k, dflt) { return tx('meta', 'readonly', function (s) { return s.get(k); }).then(function (v) { return v ? v.v : dflt; }); },
    setMeta: function (k, v) { return tx('meta', 'readwrite', function (s) { return s.put({ k: k, v: v }); }); },
    // Atomic increment of the daily running number; numbers are never reused
    nextSeq: function (day) {
      return tx('meta', 'readwrite', function (s, set) {
        var g = s.get('seq-' + day);
        g.onsuccess = function () { var n = (g.result ? g.result.v : 0) + 1; s.put({ k: 'seq-' + day, v: n }); set(n); };
      });
    }
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  // ---------- state ----------
  var records = [];
  var cur = null;          // { id, ref, createdAt, parts: [photo], docs: [photo] }  photo = {blob, url}
  var thumbUrls = [];
  var devCode = 'A';
  var lastScan = null;     // ImageBitmap of the latest nameplate photo for this record
  var scanTarget = 'pn';

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }
  function nowParts() {
    var d = new Date();
    return { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), time: pad(d.getHours()) + ':' + pad(d.getMinutes()) };
  }
  function dayKey(d) { d = d || new Date(); return String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function makeRef(n, d) { return devCode + '-' + dayKey(d) + '-' + pad(n, 3); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  // ---------- UI helpers ----------
  var toastT;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function ask(msg, yesLabel) {
    return new Promise(function (res) {
      $('sheetMsg').textContent = msg;
      $('sheetYes').textContent = yesLabel || 'Confirm';
      $('sheet').hidden = false;
      function done(v) { $('sheet').hidden = true; $('sheetYes').onclick = $('sheetNo').onclick = null; res(v); }
      $('sheetYes').onclick = function () { done(true); };
      $('sheetNo').onclick = function () { done(false); };
    });
  }
  function showErr(msg) { var e = $('formErr'); e.textContent = msg || ''; e.hidden = !msg; }
  function flash(id) { var el = $(id); el.classList.add('flash'); setTimeout(function () { el.classList.remove('flash'); }, 1600); }

  // ---------- images ----------
  function loadBitmap(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(blob); });
    }
    return new Promise(function (res, rej) {
      var img = new Image(); img.onload = function () { res(img); }; img.onerror = rej; img.src = URL.createObjectURL(blob);
    });
  }
  function drawScaled(bmp, maxSide) {
    var w = bmp.width, h = bmp.height, k = Math.min(1, maxSide / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  function compress(file, maxSide, q) {
    return loadBitmap(file).then(function (bmp) {
      var c = drawScaled(bmp, maxSide || 2400);
      return new Promise(function (res) { c.toBlob(function (b) { res(b || file); }, 'image/jpeg', q || 0.88); });
    }).catch(function () { return file; });
  }
  function addPhoto(kind, blob) {
    cur[kind].push({ blob: blob, url: URL.createObjectURL(blob) });
    renderGrid(kind);
  }
  function handleFiles(kind, files) {
    var arr = Array.prototype.slice.call(files || []);
    var max = kind === 'docs' ? 3000 : 2400, q = kind === 'docs' ? 0.9 : 0.88;
    return arr.reduce(function (p, f) { return p.then(function () { return compress(f, max, q).then(function (b) { addPhoto(kind, b); }); }); }, Promise.resolve());
  }
  function renderGrid(kind) {
    var g = $(kind === 'parts' ? 'partGrid' : 'docGrid'), tag = kind === 'parts' ? 'P' : 'D';
    g.innerHTML = '';
    cur[kind].forEach(function (ph, i) {
      var d = document.createElement('div'); d.className = 'ph';
      var img = document.createElement('img'); img.src = ph.url; img.alt = (kind === 'parts' ? 'Part photo ' : 'Document ') + (i + 1);
      img.onclick = function () { $('viewerImg').src = ph.url; $('viewer').hidden = false; };
      var n = document.createElement('span'); n.className = 'n'; n.textContent = tag + pad(i + 1);
      var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + img.alt);
      x.onclick = function () { URL.revokeObjectURL(ph.url); cur[kind].splice(i, 1); renderGrid(kind); };
      d.append(img, n, x); g.appendChild(d);
    });
    $(kind === 'parts' ? 'partCount' : 'docCount').textContent = cur[kind].length;
  }

  // ---------- form ----------
  function clearScan() { lastScan = null; $('scanMsg').hidden = true; $('scanMsg').innerHTML = ''; }
  function newForm() {
    if (cur) cur.parts.concat(cur.docs).forEach(function (p) { URL.revokeObjectURL(p.url); });
    cur = { id: null, ref: null, parts: [], docs: [] };
    var n = nowParts();
    $('pn').value = ''; $('sn').value = ''; $('remark').value = '';
    $('date').value = n.date; $('time').value = n.time; $('pfr').checked = false;
    $('formTitle').textContent = 'New record';
    $('formRef').textContent = 'ID assigned on save'; $('formRef').classList.remove('has');
    $('cancelEdit').hidden = true;
    $('formPanel').classList.remove('editing');
    $('dupWarn').hidden = true; showErr(''); clearScan();
    renderGrid('parts'); renderGrid('docs');
  }
  function editRecord(r) {
    newForm();
    cur.id = r.id; cur.ref = r.ref; cur.createdAt = r.createdAt;
    $('pn').value = r.pn; $('sn').value = r.sn; $('remark').value = r.remark || '';
    $('date').value = r.date; $('time').value = r.time; $('pfr').checked = !!r.pfr;
    r.parts.forEach(function (b) { addPhoto('parts', b); });
    r.docs.forEach(function (b) { addPhoto('docs', b); });
    $('formTitle').textContent = 'Edit record';
    $('formRef').textContent = r.ref; $('formRef').classList.add('has');
    $('cancelEdit').hidden = false;
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
    if (d) w.textContent = 'This P/N + S/N is already recorded as ' + d.ref + ' (' + d.date + ' ' + d.time + ').';
  }

  function save() {
    showErr('');
    var pn = P.clean($('pn').value), sn = P.clean($('sn').value);
    if (!pn || !sn) { showErr('Enter both P/N and S/N before saving.'); (pn ? $('sn') : $('pn')).focus(); return; }
    var chain = Promise.resolve(true);
    var dup = findDup(pn, sn);
    if (dup) chain = chain.then(function (ok) { return ok && ask('P/N ' + pn + ' S/N ' + sn + ' is already recorded as ' + dup.ref + '. Save another record anyway?', 'Save anyway'); });
    if (!cur.parts.length) chain = chain.then(function (ok) { return ok && ask('No part photos yet. Save without photos?', 'Save'); });
    if ($('pfr').checked && !cur.docs.length) chain = chain.then(function (ok) { return ok && ask('PFR is ticked but no document photo is attached. Save anyway?', 'Save'); });
    chain.then(function (ok) {
      if (!ok) return;
      var wasEdit = !!cur.id;
      var refP = cur.ref ? Promise.resolve(cur.ref) : DB.nextSeq(dayKey()).then(function (n) { return makeRef(n); });
      return refP.then(function (ref) {
        var rec = {
          id: cur.id || uid(), ref: ref, createdAt: cur.createdAt || Date.now(), updatedAt: Date.now(),
          pn: pn, sn: sn, date: $('date').value, time: $('time').value,
          pfr: $('pfr').checked, remark: $('remark').value.trim(),
          parts: cur.parts.map(function (p) { return p.blob; }),
          docs: cur.docs.map(function (p) { return p.blob; }),
          exported: false
        };
        return DB.put(rec).then(function () {
          toast((wasEdit ? 'Updated ' : 'Saved ') + ref);
          newForm(); return loadList();
        }).then(function () { if (!wasEdit) $('pn').focus(); });
      });
    }).catch(function (e) { showErr('Could not save: ' + (e && e.message || e) + '. The phone may be out of space; export and delete old records.'); });
  }

  // ---------- list ----------
  function normalize(r) {           // records from version 1 had a single photos array and no ID
    if (!r.parts) { r.parts = r.photos || []; delete r.photos; }
    if (!r.docs) r.docs = [];
    return r;
  }
  function loadList() {
    return DB.all().then(function (rs) {
      records = (rs || []).map(normalize).sort(function (a, b) { return a.createdAt - b.createdAt; });
      var missing = records.filter(function (r) { return !r.ref; });
      return missing.reduce(function (p, r) {
        return p.then(function () {
          var d = new Date(r.createdAt);
          return DB.nextSeq(dayKey(d)).then(function (n) { r.ref = makeRef(n, d); return DB.put(r); });
        });
      }, Promise.resolve()).then(function () {
        records.reverse();
        renderList();
      });
    });
  }
  function renderList() {
    thumbUrls.forEach(URL.revokeObjectURL); thumbUrls = [];
    var ul = $('list'); ul.innerHTML = '';
    records.forEach(function (r) {
      var li = document.createElement('li'); li.className = 'item';
      var th = document.createElement('img'); th.className = 'thumb'; th.alt = '';
      var first = r.parts[0] || r.docs[0];
      if (first) { var u = URL.createObjectURL(first); thumbUrls.push(u); th.src = u; }
      var m = document.createElement('div'); m.className = 'meta';
      var rid = document.createElement('div'); rid.className = 'rid'; rid.textContent = r.ref;
      var pnl = document.createElement('div'); pnl.className = 'pnsn'; pnl.innerHTML = '<span>P/N</span>'; pnl.append(r.pn);
      var snl = document.createElement('div'); snl.className = 'pnsn'; snl.innerHTML = '<span>S/N</span>'; snl.append(r.sn);
      var sub = document.createElement('div'); sub.className = 'sub';
      sub.append(r.date + ' ' + r.time + ' · ' + r.parts.length + ' P · ' + r.docs.length + ' D ');
      var pill = document.createElement('span'); pill.className = 'pill ' + (r.pfr ? 'yes' : 'no'); pill.textContent = r.pfr ? 'PFR ✓' : 'No PFR';
      sub.appendChild(pill);
      if (r.exported) { var ex = document.createElement('span'); ex.textContent = 'Exported'; sub.appendChild(ex); }
      m.append(rid, pnl, snl, sub);
      var a = document.createElement('div'); a.className = 'acts';
      var eb = document.createElement('button'); eb.type = 'button'; eb.textContent = 'Edit'; eb.onclick = function () { editRecord(r); };
      var db = document.createElement('button'); db.type = 'button'; db.className = 'del'; db.textContent = 'Delete';
      db.onclick = function () {
        ask('Delete ' + r.ref + ' (P/N ' + r.pn + ', S/N ' + r.sn + ') and its ' + plural(r.parts.length + r.docs.length, 'photo') + '? This cannot be undone.', 'Delete').then(function (ok) {
          if (ok) DB.del(r.id).then(loadList).then(function () { toast('Deleted ' + r.ref); if (cur.id === r.id) newForm(); });
        });
      };
      a.append(eb, db);
      li.append(th, m, a); ul.appendChild(li);
    });
    $('emptyState').hidden = records.length > 0;
    $('dangerZone').hidden = records.length === 0;
    var nPhotos = records.reduce(function (s, r) { return s + r.parts.length + r.docs.length; }, 0);
    $('countLabel').textContent = plural(records.length, 'record') + ' · ' + plural(nPhotos, 'photo');
    $('exportBtn').disabled = records.length === 0;
  }

  // ---------- scanning ----------
  var ocrWorker = null;
  function getWorker(onProgress) {
    window.__ocrProgress = onProgress;
    if (ocrWorker) return ocrWorker;
    var abs = function (p) { return new URL(p, location.href).href; };
    ocrWorker = Tesseract.createWorker('eng', 1, {
      workerPath: abs('vendor/worker.min.js'),
      corePath: abs('vendor/core/'),
      langPath: abs('vendor/lang'),
      workerBlobURL: false,
      logger: function (m) { if (window.__ocrProgress) window.__ocrProgress(m); }
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

  // Crop + upscale + grayscale with a white margin; this is what Tesseract reads best
  function prepRegion(bmp, r) {
    var k = Math.max(1, Math.min(3, 1400 / r.w)), m = 24;
    var c = document.createElement('canvas');
    c.width = Math.round(r.w * k) + m * 2; c.height = Math.round(r.h * k) + m * 2;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, r.x, r.y, r.w, r.h, m, m, c.width - m * 2, c.height - m * 2);
    var d = ctx.getImageData(0, 0, c.width, c.height), px = d.data;
    for (var i = 0; i < px.length; i += 4) {
      var g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      g = Math.max(0, Math.min(255, (g - 128) * 1.4 + 128));
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  function label(t) { return t === 'pn' ? 'P/N' : 'S/N'; }
  function setField(t, v) { $(t).value = v; flash(t); checkDup(); }

  function scanMsg(html, cands, target) {
    var box = $('scanMsg'); box.hidden = false; box.innerHTML = '';
    var p = document.createElement('div'); p.innerHTML = html; box.appendChild(p);
    if (cands && cands.length) {
      var list = document.createElement('div'); list.className = 'cands';
      cands.forEach(function (line) {
        var v = P.stripLabel(line); if (!v) return;
        var row = document.createElement('div'); row.className = 'cand';
        var code = document.createElement('code'); code.textContent = line;
        var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Use as ' + label(target);
        b.onclick = function () { setField(target, v); toast(label(target) + ' = ' + v); };
        row.append(code, b); list.appendChild(row);
      });
      box.appendChild(list);
    }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function startScan(target) {
    scanTarget = target;
    if (lastScan) openCropper();
    else $('scanInput').click();
  }

  function onScanPhoto(file) {
    compress(file).then(function (b) { addPhoto('parts', b); });
    scanMsg('Reading photo…');
    loadBitmap(file).then(function (bmp) {
      lastScan = bmp;
      return detectBarcode(bmp).then(function (codes) {
        if (codes) {
          var text = codes.join('\n'), f = P.parseSpec2000(text);
          if (f.pn) setField('pn', f.pn);
          if (f.sn) setField('sn', f.sn);
          if (f.pn || f.sn) {
            scanMsg('2D barcode read' + (f.pn ? ' · P/N <b>' + esc(f.pn) + '</b>' : '') + (f.sn ? ' · S/N <b>' + esc(f.sn) + '</b>' : '') + '. Check against the plate.');
            return;
          }
        }
        $('scanMsg').hidden = true;
        openCropper();
      });
    }).catch(function (e) { scanMsg('Could not open the photo: ' + esc(e && e.message || e)); });
  }

  // ----- region picker -----
  var crop = { sel: null, drag: null, scale: 1 };
  function openCropper() {
    $('cropTitle').textContent = 'Drag a box around the ' + label(scanTarget);
    $('cropper').hidden = false;
    crop.sel = null; $('cropRead').disabled = true;
    requestAnimationFrame(layoutCrop);
  }
  function closeCropper() { $('cropper').hidden = true; }
  function layoutCrop() {
    if (!lastScan) return;
    var stage = $('cropStage'), c = $('cropCanvas');
    var sw = stage.clientWidth, sh = stage.clientHeight;
    var k = Math.min(sw / lastScan.width, sh / lastScan.height);
    c.width = Math.round(lastScan.width * k); c.height = Math.round(lastScan.height * k);
    crop.scale = k;
    drawCrop();
  }
  function drawCrop() {
    var c = $('cropCanvas'), ctx = c.getContext('2d'), k = crop.scale;
    ctx.drawImage(lastScan, 0, 0, c.width, c.height);
    var s = crop.sel;
    if (s) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.rect(0, 0, c.width, c.height); ctx.rect(s.x * k, s.y * k, s.w * k, s.h * k); ctx.fill('evenodd');
      ctx.strokeStyle = '#f0b43c'; ctx.lineWidth = 3; ctx.strokeRect(s.x * k, s.y * k, s.w * k, s.h * k);
    }
  }
  function toImg(e) {
    var c = $('cropCanvas'), rc = c.getBoundingClientRect();
    var x = (e.clientX - rc.left) * (c.width / rc.width) / crop.scale;
    var y = (e.clientY - rc.top) * (c.height / rc.height) / crop.scale;
    return { x: Math.max(0, Math.min(lastScan.width, x)), y: Math.max(0, Math.min(lastScan.height, y)) };
  }
  (function wireCrop() {
    var c = $('cropCanvas');
    c.addEventListener('pointerdown', function (e) { e.preventDefault(); c.setPointerCapture(e.pointerId); crop.drag = toImg(e); });
    c.addEventListener('pointermove', function (e) {
      if (!crop.drag) return;
      var p = toImg(e), a = crop.drag;
      crop.sel = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
      drawCrop();
    });
    function end() {
      crop.drag = null;
      var ok = crop.sel && crop.sel.w > 12 && crop.sel.h > 8;
      if (!ok) { crop.sel = null; drawCrop(); }
      $('cropRead').disabled = !ok;
    }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    window.addEventListener('resize', function () { if (!$('cropper').hidden) layoutCrop(); });
  })();

  function runOcr(region, psm) {
    var target = scanTarget;
    closeCropper();
    scanMsg('Reading ' + label(target) + '… (first run loads the OCR engine)');
    var canvas = prepRegion(lastScan, region);
    getWorker(function (m) {
      if (m.status === 'recognizing text') scanMsg('Reading ' + label(target) + '… ' + Math.round(m.progress * 100) + '%');
    }).then(function (w) {
      return w.setParameters({ tessedit_pageseg_mode: psm }).then(function () { return w.recognize(canvas); });
    }).then(function (r) {
      var text = (r && r.data && r.data.text) || '';
      var lines = P.candidateLines(text);
      var v = P.parseLabels(text)[target] || (lines.length === 1 ? P.stripLabel(lines[0]) : '');
      if (v) {
        setField(target, v);
        scanMsg('Read ' + label(target) + ' <b>' + esc(v) + '</b>. Check every character against the plate.' + (lines.length > 1 ? ' Other lines found:' : ''), lines.length > 1 ? lines : null, target);
      } else if (lines.length) {
        scanMsg('Pick the line that is the ' + label(target) + ', or tap Scan again and draw a tighter box.', lines, target);
      } else {
        scanMsg('No text found. Tap Scan again and draw a box closer around the ' + label(target) + ', or type it in.');
      }
    }).catch(function (e) { scanMsg('OCR failed: ' + esc(e && e.message || e) + '. Type the ' + label(target) + ' in.'); });
  }

  $('cropRead').onclick = function () { if (crop.sel) runOcr(crop.sel, '6'); };
  $('cropWhole').onclick = function () { runOcr({ x: 0, y: 0, w: lastScan.width, h: lastScan.height }, '3'); };
  $('cropCancel').onclick = closeCropper;
  $('cropRetake').onclick = function () { closeCropper(); $('scanInput').click(); };

  // ---------- export ----------
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()); }

  function exportAll() {
    if (!records.length) return;
    var btn = $('exportBtn'); btn.disabled = true; btn.textContent = 'Building file…';
    var zip = new JSZip(), st = stamp(), base = 'Inspection_' + st;
    var root = zip.folder(base);
    var ordered = records.slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
    var rows = [['Record ID', 'Date', 'Time', 'P/N', 'S/N', 'PFR', 'Part photos', 'Doc photos', 'Folder', 'Remark']];
    ordered.forEach(function (r) {
      var stem = r.ref + '_' + P.safeName(r.pn) + '_' + P.safeName(r.sn);
      var f = root.folder(stem);
      r.parts.forEach(function (b, j) { f.file(stem + '_P' + pad(j + 1) + '.jpg', b); });
      if (r.docs.length) {
        var dfo = f.folder('documents');
        r.docs.forEach(function (b, j) { dfo.file(stem + '_DOC' + pad(j + 1) + '.jpg', b); });
      }
      rows.push([r.ref, r.date, r.time, r.pn, r.sn, r.pfr ? 'Yes' : 'No', r.parts.length, r.docs.length, stem, r.remark || '']);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 15 }, { wch: 11 }, { wch: 7 }, { wch: 22 }, { wch: 18 }, { wch: 6 }, { wch: 11 }, { wch: 10 }, { wch: 44 }, { wch: 30 }];
    for (var R = 2; R <= rows.length; R++) { // keep IDs, P/N and S/N as text so Excel never strips leading zeros
      ['A', 'D', 'E'].forEach(function (col) { var c = ws[col + R]; if (c) { c.t = 's'; c.z = '@'; } });
    }
    ws['!autofilter'] = { ref: 'A1:J' + rows.length };
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Inspection');
    root.file(base + '.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));

    zip.generateAsync({ type: 'blob', compression: 'STORE' }).then(function (blob) {
      var name = base + '.zip';
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
      return Promise.all(records.map(function (r) { r.exported = true; return DB.put(r); })).then(function () {
        var msg = $('exportMsg'); msg.hidden = false; msg.innerHTML = '';
        var t = document.createElement('div');
        t.textContent = 'Saved ' + name + ' to Downloads (' + (blob.size / 1048576).toFixed(1) + ' MB, ' + plural(ordered.length, 'record') + ').';
        var clr = document.createElement('button'); clr.type = 'button'; clr.className = 'link danger'; clr.textContent = 'Delete exported records from this phone';
        clr.onclick = function () {
          var ex = records.filter(function (r) { return r.exported; });
          ask('Have you opened the ZIP and copied it somewhere safe? ' + plural(ex.length, 'record') + ' will be deleted from this phone.', 'Delete').then(function (ok) {
            if (!ok) return;
            Promise.all(ex.map(function (r) { return DB.del(r.id); }))
              .then(loadList).then(function () { msg.hidden = true; toast('Exported records deleted'); });
          });
        };
        msg.append(t, clr);
        return loadList();
      });
    }).catch(function (e) {
      toast('Export failed: ' + (e && e.message || e));
    }).then(function () { btn.disabled = records.length === 0; btn.textContent = 'Export ZIP + Excel'; });
  }

  // ---------- settings ----------
  function updateSample() { $('idSample').textContent = (P.clean($('devCode').value).replace(/[^A-Z0-9]/g, '') || 'A') + '-' + dayKey() + '-001'; }
  $('settingsBtn').onclick = function () { $('devCode').value = devCode; updateSample(); $('settings').hidden = false; };
  $('devCode').addEventListener('input', updateSample);
  $('setCancel').onclick = function () { $('settings').hidden = true; };
  $('setSave').onclick = function () {
    var v = P.clean($('devCode').value).replace(/[^A-Z0-9]/g, '');
    if (!v) { $('devCode').focus(); return; }
    devCode = v;
    DB.setMeta('device', v).then(function () { $('settings').hidden = true; toast('Device code set to ' + v); });
  };

  // ---------- wiring ----------
  function onFile(input, fn) { input.addEventListener('change', function () { var f = input.files; if (f && f.length) fn(f); input.value = ''; }); }
  onFile($('partCam'), function (f) { handleFiles('parts', f); });
  onFile($('partGal'), function (f) { handleFiles('parts', f); });
  onFile($('docCam'), function (f) { handleFiles('docs', f); });
  onFile($('docGal'), function (f) { handleFiles('docs', f); });
  onFile($('scanInput'), function (f) { onScanPhoto(f[0]); });
  Array.prototype.forEach.call(document.querySelectorAll('.scan-btn'), function (b) {
    b.addEventListener('click', function () { startScan(b.getAttribute('data-target')); });
  });
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
    ask('Delete all ' + plural(records.length, 'record') + (notExp ? ' (' + notExp + ' not yet exported)' : '') + '? This cannot be undone. Record numbers are not reused.', 'Delete all')
      .then(function (ok) { if (ok) DB.clear().then(loadList).then(function () { newForm(); toast('All records deleted'); }); });
  };

  function netLabel() {
    var ready = navigator.serviceWorker && navigator.serviceWorker.controller;
    $('netState').textContent = ready ? 'Offline ready' : (navigator.onLine ? 'Preparing offline' : 'Offline');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function () { return navigator.serviceWorker.ready; }).then(netLabel).catch(netLabel);
    navigator.serviceWorker.addEventListener('controllerchange', netLabel);
  }
  window.addEventListener('online', netLabel); window.addEventListener('offline', netLabel);
  netLabel();

  newForm();
  DB.getMeta('device', 'A').then(function (v) { devCode = v; }).then(loadList)
    .catch(function (e) { showErr('Could not open storage on this phone: ' + (e && e.message || e)); });
})();
