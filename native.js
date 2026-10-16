/* native.js — bridge between the web app and Android when running inside Capacitor.
 * In a normal browser (GitHub Pages PWA) window.NativeApp.isNative is false and nothing changes. */
(function () {
  var cap = window.Capacitor;
  var isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  var Plugins = (cap && cap.Plugins) || {};

  // Convert a slice of a Blob to base64 (without the data: prefix).
  function sliceToBase64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  // Write a large Blob to the app cache in chunks (chunk size is a multiple of 3 so base64 joins cleanly),
  // then open Android's share sheet so the user can save it to Files / Drive / OneDrive or send by Outlook / Teams.
  function saveAndShare(blob, name) {
    var FS = Plugins.Filesystem, Share = Plugins.Share;
    var CHUNK = 3 * 1024 * 1024; // 3 MB
    var path = 'exports/' + name;
    var chain = Promise.resolve(), offset = 0, first = true;
    function writeNext() {
      if (offset >= blob.size) return Promise.resolve();
      var part = blob.slice(offset, offset + CHUNK);
      var isFirst = first; first = false; offset += CHUNK;
      return sliceToBase64(part).then(function (b64) {
        var opts = { path: path, data: b64, directory: 'CACHE', recursive: true };
        return isFirst ? FS.writeFile(opts) : FS.appendFile(opts);
      }).then(writeNext);
    }
    chain = blob.size ? writeNext() : FS.writeFile({ path: path, data: '', directory: 'CACHE', recursive: true });
    return chain
      .then(function () { return FS.getUri({ path: path, directory: 'CACHE' }); })
      .then(function (r) { return Share.share({ title: name, files: [r.uri], dialogTitle: 'Save or send ' + name }); })
      .catch(function (e) {
        // The user closing the share sheet is not an error.
        if (e && /cancel/i.test(String(e.message || e))) return;
        throw e;
      });
  }

  window.NativeApp = { isNative: isNative, saveAndShare: saveAndShare };
})();
