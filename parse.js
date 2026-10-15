/* Pure parsing helpers: ATA Spec 2000 2D-barcode text and OCR text from part nameplates. */
(function (root) {
  'use strict';

  var VALUE = '([A-Z0-9][A-Z0-9\\-\\/\\.]*[A-Z0-9]|[A-Z0-9])';

  function clean(v) {
    return (v || '').toUpperCase().replace(/[^A-Z0-9\-\/\.]/g, '').replace(/^[\-\/\.]+|[\-\/\.]+$/g, '');
  }

  // ATA Spec 2000 Ch.9 text element identifiers, e.g. "MFR 81205*PNR 3214552-3*SER A12345"
  function parseSpec2000(raw) {
    var t = (raw || '').toUpperCase().replace(/[\u001d\u001e\u0004]/g, '*');
    var out = { pn: '', sn: '', mfr: '' };
    var m;
    if ((m = t.match(new RegExp('(?:^|[\\s*])PNR[\\s:]+' + VALUE)))) out.pn = clean(m[1]);
    if ((m = t.match(new RegExp('(?:^|[\\s*])(?:SER|USN)[\\s:]+' + VALUE)))) out.sn = clean(m[1]);
    if ((m = t.match(new RegExp('(?:^|[\\s*])(?:MFR|CAG)[\\s:]+' + VALUE)))) out.mfr = clean(m[1]);
    // Fallback for simple labels inside barcodes: "PN:xxx SN:yyy"
    if (!out.pn || !out.sn) {
      var o = parseLabels(t);
      if (!out.pn) out.pn = o.pn;
      if (!out.sn) out.sn = o.sn;
    }
    return out;
  }

  // Label patterns as printed on nameplates, tolerant of common OCR confusions (/ read as I, 1, l)
  var PN_LABEL = '(?:P\\s?[\\/I1L|]\\s?N|PNR|PN|PART\\s*(?:NO|NUMBER|NBR|#|N[O0]\\.?)|MFR\\s*P\\/?N)';
  var SN_LABEL = '(?:S\\s?[\\/I1L|]\\s?N|SER(?:IAL)?\\s*(?:NO|NUMBER|NBR|#|N[O0]\\.?)?|SN)';

  function findAfter(lines, label) {
    var reSame = new RegExp('(?:^|[^A-Z])' + label + '\\.?\\s*[:.#\\-]?\\s*' + VALUE);
    var reOnly = new RegExp('(?:^|[^A-Z])' + label + '\\.?\\s*[:.#\\-]?\\s*$');
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      var m = L.match(reSame);
      if (m && m[1] && m[1].length >= 2) return clean(m[1]);
      if (reOnly.test(L) && lines[i + 1]) {
        var n = lines[i + 1].match(new RegExp('^\\s*' + VALUE));
        if (n) return clean(n[1]);
      }
    }
    return '';
  }

  function parseLabels(text) {
    var lines = (text || '').toUpperCase().split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    return { pn: findAfter(lines, PN_LABEL), sn: findAfter(lines, SN_LABEL) };
  }

  // Lines worth offering as tap-to-fill candidates
  function candidateLines(text) {
    var seen = {};
    return (text || '').split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 3 && /[A-Z0-9]/i.test(s); })
      .filter(function (s) { var k = s.toUpperCase(); if (seen[k]) return false; seen[k] = 1; return true; })
      .slice(0, 25);
  }

  // Value part of a line: drop a leading label such as "P/N:" or "SER NO."
  function stripLabel(line) {
    var u = (line || '').toUpperCase().trim();
    var re = new RegExp('^(?:' + PN_LABEL + '|' + SN_LABEL + '|MFR|MOD|DESC|CAGE)\\.?\\s*[:.#\\-]?\\s*');
    var rest = u.replace(re, '');
    var m = rest.match(new RegExp('^' + VALUE));
    return m ? clean(m[1]) : clean(rest.split(/\s+/)[0]);
  }

  function safeName(s) {
    return (s || 'NA').toUpperCase().replace(/[^A-Z0-9\-_.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'NA';
  }

  var api = { parseSpec2000: parseSpec2000, parseLabels: parseLabels, candidateLines: candidateLines, stripLabel: stripLabel, safeName: safeName, clean: clean };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PartParse = api;
})(this);
