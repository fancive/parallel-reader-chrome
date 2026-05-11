// Test-time chrome.i18n shim. The runtime t() implementation reads its own
// bundled STRINGS table now, so the only behavior tests rely on is
// chrome.i18n.getUILanguage() returning a deterministic value. We pin it to
// 'en' so substitution assertions don't depend on the host's locale.

if (!globalThis.chrome) {
  globalThis.chrome = {};
}
if (!globalThis.chrome.i18n) {
  globalThis.chrome.i18n = {
    getUILanguage() {
      return 'en';
    },
    getMessage(key) {
      // Manifest keys only — runtime strings now come from the bundled
      // STRINGS table. Returning the key is a fine placeholder for tests
      // that do not exercise the manifest path.
      return key;
    },
  };
}
