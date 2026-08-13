/**
 * Android package-visibility declaration for the native Outlook deep link.
 *
 * WHY: from Android 11 (API 30) an app can only see other packages it
 * declares in <queries>. Without this, `Linking.canOpenURL('ms-outlook://…')`
 * returns false on every modern device EVEN WHEN OUTLOOK IS INSTALLED, so the
 * maintenance screen's probe fails and every tap falls back to the browser —
 * exactly the bug the native transport exists to fix. There is no ExpoConfig
 * key for <queries> (checked against @expo/config-types 57), which is why
 * this is a config plugin rather than a line in app.config.ts.
 *
 * Both forms are declared on purpose: the intent/scheme form is what
 * canOpenURL actually resolves against, and the explicit package name covers
 * the same app when a device's resolver is asked about it directly. Neither
 * grants any new capability — the app still cannot read anything from
 * Outlook, only ask the OS whether the scheme has a handler.
 *
 * NATIVE CONFIG: it lands in AndroidManifest.xml at prebuild/build time, so
 * it ships in a NEW BINARY only. `pnpm release:ota` cannot deliver it.
 *
 * Written against the STRUCTURED manifest JSON (@expo/config-plugins parses
 * the XML for us) and idempotent — never string-matching generated files, the
 * hazard that got the old Podfile plugin deleted.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const OUTLOOK_PACKAGE = 'com.microsoft.office.outlook';
const OUTLOOK_SCHEME = 'ms-outlook';
const VIEW_ACTION = 'android.intent.action.VIEW';

module.exports = function withAndroidOutlookQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!Array.isArray(manifest.queries)) manifest.queries = [];
    if (manifest.queries.length === 0) manifest.queries.push({});
    const queries = manifest.queries[0];

    if (!Array.isArray(queries.package)) queries.package = [];
    const hasPackage = queries.package.some((p) => p?.$?.['android:name'] === OUTLOOK_PACKAGE);
    if (!hasPackage) queries.package.push({ $: { 'android:name': OUTLOOK_PACKAGE } });

    if (!Array.isArray(queries.intent)) queries.intent = [];
    const hasIntent = queries.intent.some((i) =>
      (i?.data ?? []).some((d) => d?.$?.['android:scheme'] === OUTLOOK_SCHEME),
    );
    if (!hasIntent) {
      queries.intent.push({
        action: [{ $: { 'android:name': VIEW_ACTION } }],
        data: [{ $: { 'android:scheme': OUTLOOK_SCHEME } }],
      });
    }

    return cfg;
  });
};
