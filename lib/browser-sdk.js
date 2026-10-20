// Rebuild official TOS ESM with locked dependency fixes, and serve locally.
let cached;
function browserSdk() {
  if (!cached) {
    cached = require('esbuild')
      .build({
        entryPoints: [require('node:path').join(__dirname, 'tos-browser-entry.mjs')],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'TOS',
        target: 'es2020',
        alias: {
          'axios/lib/core/createError': require('node:path').join(__dirname, 'tos-axios-compat.mjs')
        },
        minify: true,
        write: false,
        legalComments: 'eof',
        define: {
          'process.env.NODE_ENV': '"production"',
          'process.env.TARGET_ENVIRONMENT': '"browser"'
        }
      })
      .then((result) => result.outputFiles[0].text)
      .catch((error) => {
        cached = undefined;
        throw error;
      });
  }
  return cached;
}
module.exports = { browserSdk };
