// Expo config plugin: patch the generated ios/Podfile so the `fmt` pod
// builds under Xcode 16+ / Xcode 26.x.
//
// Why this exists
// ---------------
// React Native 0.79 pins fmt 11.0.2. fmt 11.0.2 uses `consteval` format
// strings that Clang in Xcode 16+ rejects with errors like:
//
//   call to consteval function 'fmt::basic_format_string<...>'
//   is not a constant expression
//
// The accepted upstream workaround is to define FMT_USE_CONSTEVAL=0 for
// the fmt target, which falls back to constexpr functions — same
// runtime behavior, just satisfies the stricter constant-expression
// checker.
//
// Because `expo prebuild --clean` regenerates ios/Podfile from scratch
// every time, the fix has to live in a config plugin (this file) rather
// than as a direct edit to the generated Podfile. The plugin appends a
// snippet to the existing post_install hook.
//
// Remove this plugin once React Native ships a version that depends on
// fmt 11.1+ (which has the consteval issue fixed upstream), or once we
// upgrade to RN 0.81+ which bundles the fix.

const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const HOOK_MARKER = '# expo-config-plugin: fmt FMT_USE_CONSTEVAL=0';

const FMT_PATCH = `
    ${HOOK_MARKER}
    installer.pods_project.targets.each do |target|
      if target.name == 'fmt'
        target.build_configurations.each do |config|
          existing = config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] || ['$(inherited)']
          existing = [existing] unless existing.is_a?(Array)
          unless existing.include?('FMT_USE_CONSTEVAL=0')
            config.build_settings['GCC_PREPROCESSOR_DEFINITIONS'] = existing + ['FMT_USE_CONSTEVAL=0']
          end
        end
      end
    end`;

module.exports = function withFmtConstevalFix(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfilePath, 'utf8');

      // Idempotent: bail if the marker is already present (e.g. running
      // the plugin twice in the same prebuild cycle).
      if (contents.includes(HOOK_MARKER)) return cfg;

      // Find the existing `post_install do |installer|` block that
      // Expo's RN template emits and inject the fmt fix at the END of
      // it (right before the closing `end`). If for some reason the
      // template ever moves away from that pattern, fall back to a
      // standalone post_install block at the end of the Podfile.
      const postInstallEnd = contents.lastIndexOf('  end\nend\n');
      if (postInstallEnd !== -1) {
        contents =
          contents.slice(0, postInstallEnd) +
          FMT_PATCH +
          '\n' +
          contents.slice(postInstallEnd);
      } else {
        contents += `\n\npost_install do |installer|\n${FMT_PATCH}\nend\n`;
      }

      fs.writeFileSync(podfilePath, contents);
      return cfg;
    },
  ]);
};
