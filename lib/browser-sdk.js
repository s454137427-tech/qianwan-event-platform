// Rebuild from the official source so pinned XML fixes reach the browser as well.
// The package's prebuilt distribution embeds its old XML dependency.
let cached;
function browserSdk() {
  if (!cached) {
    cached = require('esbuild')
      .build({
        entryPoints: [require.resolve('cos-js-sdk-v5/src/cos.js')],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        globalName: 'COS',
        target: 'es2020',
        minify: true,
        write: false,
        legalComments: 'eof',
        define: { 'process.env.NODE_ENV': '"production"' }
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
