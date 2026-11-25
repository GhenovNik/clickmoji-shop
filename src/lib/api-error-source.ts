// Marks an error response whose JSON `error` text was written by this app in the request language.
// A gateway, proxy or framework page can send its own JSON body with a non-OK status; only a
// response produced by our handler carries this header, so the client never shows a foreign text.
// The body shape is unchanged, so existing callers keep reading `error` as before.
export const LOCALIZED_API_ERROR_HEADER = 'x-clickmoji-localized-error';
export const LOCALIZED_API_ERROR_VALUE = '1';

export function markLocalizedApiError(response: Response): Response {
  if (response.status >= 400) {
    response.headers.set(LOCALIZED_API_ERROR_HEADER, LOCALIZED_API_ERROR_VALUE);
  }
  return response;
}
