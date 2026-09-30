async function publicApi(path, { method = 'GET', body, headers = {}, signal } = {}) {
  let response;
  try {
    response = await fetch(`/api/public${path}`, {
      method,
      cache: 'no-store',
      credentials: 'include',
      signal,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    error.network = true;
    throw error;
  }
  const result = await response.json().catch(() => ({ error: 'Invalid server response' }));
  if (!response.ok) {
    const error = new Error(result.error || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return result;
}

export function loadStorefront(locationToken = '', options = {}) {
  const query = locationToken ? `?locationToken=${encodeURIComponent(locationToken)}` : '';
  return publicApi(`/storefront${query}`, options);
}

export function quoteCustomerOrder(body, options = {}) {
  return publicApi('/order-requests/quote', { ...options, method: 'POST', body });
}

export function submitCustomerOrder(body, requestId, options = {}) {
  return publicApi('/order-requests', {
    ...options,
    method: 'POST',
    body,
    headers: { ...options.headers, 'Idempotency-Key': requestId },
  });
}

export function loadCustomerOrderStatus(code, options = {}) {
  return publicApi(`/order-requests/${encodeURIComponent(code)}/status`, {
    ...options,
  });
}

export function loadCustomerAccount(options = {}) {
  return publicApi('/customer/me', options);
}

export function registerCustomerAccount(body, options = {}) {
  return publicApi('/customer/register', { ...options, method: 'POST', body });
}

export function signInCustomerAccount(body, options = {}) {
  return publicApi('/customer/sign-in', { ...options, method: 'POST', body });
}

export function signOutCustomerAccount(options = {}) {
  return publicApi('/customer/sign-out', { ...options, method: 'POST' });
}

export function updateCustomerProfile(body, options = {}) {
  return publicApi('/customer/profile', { ...options, method: 'PUT', body });
}

export function updateCustomerMarketingConsent(channel, granted, options = {}) {
  return publicApi('/customer/marketing-consent', {
    ...options,
    method: 'POST',
    body: { channel, granted },
  });
}

export function loadCustomerOrders(limit = 20, options = {}) {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  return publicApi(`/customer/orders?limit=${safeLimit}`, options);
}
