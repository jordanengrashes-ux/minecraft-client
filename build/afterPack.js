// electron-builder afterPack hook — runs on the unpacked app bundle before
// it gets wrapped into a dmg/zip. There's no Apple Developer certificate
// configured, so electron-builder skips signing entirely by default,
// producing a fully unsigned .app. Ad-hoc signing it here (no certificate
// needed, completely free) is still correct practice and a real prerequisite
// for anyone who later adds a Developer ID + notarization — it does not by
// itself bypass Gatekeeper's block on unnotarized quarantined downloads,
// but it's zero-cost and strictly better than leaving the bundle unsigned.
const { execSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${context.appOutDir}/${appName}.app`;
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
};
