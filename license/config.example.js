// Copy to license/config.js and adjust. config.js is tracked with safe defaults.
// For production: set enforce: true and your validate URL.

self.LGP_LICENSE = {
  /** When false, license UI and API checks are disabled entirely. */
  enabled: false,
  /** When true (and enabled), trading requires a valid license key (popup). */
  enforce: false,
  /** POST JSON { key, product, extensionId } → { ok, exp } */
  apiUrl: '',
  product: 'ratchetstop',
  /** Re-validate after this many hours when cached. */
  recheckHours: 6,
  /** Allow offline use this many hours after last successful check. */
  graceHours: 72,
};
