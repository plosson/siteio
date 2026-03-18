// JavaScript shim that overrides window.localStorage with a remote-backed proxy.
// Injected into HTML pages of sites with persistentStorage enabled.
export const STORAGE_SHIM_JS = `(function() {
  var cache = {};
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/__storage/', false);
    xhr.send();
    if (xhr.status === 200) cache = JSON.parse(xhr.responseText);
  } catch(e) {}

  var syncTimer = null;
  function save() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function() {
      var x = new XMLHttpRequest();
      x.open('PUT', '/__storage/', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify(cache));
    }, 300);
  }

  var storage = {
    getItem: function(k) { return cache.hasOwnProperty(String(k)) ? cache[String(k)] : null; },
    setItem: function(k, v) { cache[String(k)] = String(v); save(); },
    removeItem: function(k) { delete cache[String(k)]; save(); },
    clear: function() { cache = {}; save(); },
    key: function(n) { return Object.keys(cache)[n] || null; },
    get length() { return Object.keys(cache).length; }
  };

  Object.defineProperty(window, 'localStorage', {
    value: storage, configurable: true, writable: true
  });
})();`
