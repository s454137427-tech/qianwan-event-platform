import axios from 'axios';
// TOS's mini-program adapter imports the pre-0.27 createError helper.
// Keep its signature while using the patched AxiosError implementation.
export default function createError(message, config, code, request, response) {
  return new axios.AxiosError(message, code, config, request, response);
}
