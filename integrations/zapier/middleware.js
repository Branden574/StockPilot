'use strict';

/** Attach the API key to every outbound request as a Bearer token. */
const addApiKey = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.api_key) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.api_key}`;
  }
  return request;
};

/** Turn StockPilot's JSON error envelope into a clear Zapier error. */
const handleErrors = (response, z) => {
  if (response.status === 401) {
    throw new z.errors.RefreshAuthError('Invalid or expired StockPilot API key.');
  }
  if (response.status >= 400) {
    const msg =
      (response.data && (response.data.error || response.data.message)) ||
      `Unexpected status ${response.status}`;
    throw new z.errors.Error(String(msg), 'StockPilotError', response.status);
  }
  return response;
};

module.exports = { addApiKey, handleErrors };
