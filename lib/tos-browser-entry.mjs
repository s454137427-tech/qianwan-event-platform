// Build the official ESM source with the audited dependency versions in our lockfile.
// The SDK's standalone UMD distribution embeds its own dependency versions.
import { TosClient } from '@volcengine/tos-sdk/browser/tos.esm.js';
import axios from 'axios';
export { TosClient };
export function createUploadClient(options, signal) {
  return new TosClient({
    ...options,
    requestAdapter: (request) => axios.defaults.adapter({ ...request, signal })
  });
}
