/**
 * Returning false here tells electron-builder to skip the node_modules
 * collector/install step, which avoids workspace dependency graph explosions
 * and keeps packaging deterministic across environments.
 *
 * Hermes-Lite ships NO renderer bundle: the dashboard is served live from the
 * locally-spawned backend over HTTP (see electron/main.cjs), and the Hermes
 * Agent Python payload is fetched at first launch via install.ps1's stage
 * protocol (see electron/bootstrap-runner.cjs). So there is nothing for the
 * collector to do.
 */
module.exports = async function beforeBuild() {
  return false
}
